// ── Outbound request safety (SSRF defence) + fetch_url ────────────────────────
// Every outbound request the AGENT initiates goes through here. The address
// is resolved once, checked against private/reserved ranges, and then pinned
// for the actual connection — so a hostname that resolves differently the
// second time (DNS rebinding) cannot reach something the check rejected.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class so the block could
// move verbatim; see mixinPrototype in extension.js for how it is applied.

const path = require('path');
const dns = require('dns');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

class NetSafetyMethods {
  // Parses inet_aton-style numeric IPv4 literals — decimal (2130706433), hex
  // (0x7f000001), octal (017700000001), or partial forms (a.b, a.b.c) — that
  // attackers use to smuggle a loopback/private address past a naive string
  // check. A normal "a.b.c.d" hostname also matches (four decimal parts) and
  // normalizes right back to itself, so this is safe to run on every hostname.
  // Returns a dotted-quad string, or null if `h` isn't a numeric form at all
  // (an ordinary hostname is left to DNS resolution instead).
  _parseNumericIPv4(h) {
    const NUM = '(?:0x[0-9a-f]+|0[0-7]+|[1-9][0-9]*|0)';
    if (!new RegExp(`^${NUM}(?:\\.${NUM}){0,3}$`, 'i').test(h)) return null;
    const nums = h.split('.').map((p) =>
      /^0x/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : parseInt(p, 10));
    const n = nums.length;
    const remainingBits = 32 - 8 * (n - 1); // inet_aton: the LAST part absorbs whatever bits remain
    if (nums.slice(0, n - 1).some((x) => x > 255) || nums[n - 1] >= Math.pow(2, remainingBits)) return null;
    let value = 0;
    for (let i = 0; i < n - 1; i++) value = value * 256 + nums[i];
    value = value * Math.pow(2, remainingBits) + nums[n - 1];
    return [
      Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256,
      Math.floor(value / 256) % 256, value % 256,
    ].join('.');
  }

  // IPv4 ranges fetch_url must never reach: loopback, RFC-1918 private space,
  // link-local, CGNAT, IETF/test/benchmark assignments, and
  // multicast/reserved/broadcast (224.0.0.0 and above).
  _isPrivateOrReservedIPv4(ip) {
    const b = ip.split('.').map(Number);
    if (b.length !== 4 || b.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; // malformed → refuse
    const [a, b1, c] = b;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b1 >= 64 && b1 <= 127)   // 100.64.0.0/10 CGNAT
      || (a === 169 && b1 === 254)              // 169.254.0.0/16 link-local
      || (a === 172 && b1 >= 16 && b1 <= 31)     // 172.16.0.0/12
      || (a === 192 && b1 === 168)               // 192.168.0.0/16
      || (a === 192 && b1 === 0 && (c === 0 || c === 2)) // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
      || (a === 198 && (b1 === 18 || b1 === 19)) // 198.18.0.0/15 benchmarking
      || (a === 198 && b1 === 51 && c === 100)   // 198.51.100.0/24 (TEST-NET-2)
      || (a === 203 && b1 === 0 && c === 113)    // 203.0.113.0/24 (TEST-NET-3)
      || a >= 224;                                // multicast (224-239) + reserved/broadcast (240-255)
  }

  // IPv6 ranges fetch_url must never reach: loopback, unspecified,
  // link-local (fe80::/10), unique-local (fc00::/7), multicast (ff00::/8),
  // and IPv4-mapped addresses (checked via the embedded IPv4 address).
  _isPrivateOrReservedIPv6(ip) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return true;
    const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return this._isPrivateOrReservedIPv4(mapped[1]);
    const firstSeg = (norm.startsWith('::') ? '0' + norm.slice(1) : norm).split(':')[0];
    const first = parseInt(firstSeg || '0', 16) || 0;
    return (first >= 0xfe80 && first <= 0xfebf)   // fe80::/10 link-local
        || (first >= 0xfc00 && first <= 0xfdff)   // fc00::/7 unique-local
        || (first >= 0xff00 && first <= 0xffff);  // ff00::/8 multicast
  }

  // Fast, string-only pre-filter: catches localhost/internal-looking hostnames
  // and numeric IP literals (in any base) without paying for a DNS round trip.
  // NOT sufficient on its own — see _hostnameResolvesToPrivateAddress below.
  _isBlockedHost(h) {
    if (h === 'localhost' || h === 'metadata.google.internal') return true;
    if (h.endsWith('.internal') || h.endsWith('.local')) return true;
    const v4 = this._parseNumericIPv4(h);
    if (v4) return this._isPrivateOrReservedIPv4(v4);
    if (h.includes(':')) return this._isPrivateOrReservedIPv6(h);
    return false;
  }

  // Authoritative check: resolves the hostname and inspects the ACTUAL
  // address(es) the request will connect to. A hostname-only string check
  // (_isBlockedHost above) is defeated by DNS rebinding — a public-looking or
  // attacker-controlled domain that resolves to 127.0.0.1 or an internal
  // address sails straight through a blocklist that never looks past the name.
  // Runs on every redirect hop too, since a hop can resolve differently than
  // the URL the user actually gave.
  //
  // Returns the ONE address the caller must then pin the connection to, and
  // that is the whole point: validating the name and then letting the HTTP
  // client resolve it again independently leaves a window where a low-TTL
  // record answers public for the check and private for the connect. Handing
  // _requestPinned this exact address makes the address that was validated
  // provably the address that gets dialled, which closes the race rather than
  // just narrowing it.
  //
  // EVERY resolved address must pass, not merely the one that gets used — a
  // name answering with a mix of public and private addresses has no
  // legitimate reason to be followed at all.
  async _resolveSafeAddress(hostname) {
    let addresses;
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
      // Can't resolve — the request would fail on its own with the same error;
      // there is nothing to block and nowhere it could connect to anyway.
      return { unresolvable: true };
    }
    if (!addresses.length) return { unresolvable: true };
    const blocked = addresses.some(({ address, family }) =>
      family === 6 ? this._isPrivateOrReservedIPv6(address) : this._isPrivateOrReservedIPv4(address));
    if (blocked) return { blocked: true };
    return { address: addresses[0].address, family: addresses[0].family };
  }

  // Performs ONE http/https GET with the TCP connection pinned to `pinned`
  // (from _resolveSafeAddress) through the `lookup` hook net.connect calls.
  // The hostname still travels in the Host header and in TLS SNI/certificate
  // validation, so pinning changes only WHICH address is dialled — never who
  // the server has to prove itself to be.
  //
  // This is why fetch() isn't used here: it exposes no way to control address
  // resolution, so its connect could always disagree with our check. Every
  // behaviour fetch() was providing is reproduced — manual redirect handling
  // (the caller's loop), a hard overall timeout, response decompression, and
  // a cap on how much body is retained.
  _requestPinned(parsed, pinned, timeoutMs, maxBytes) {
    const mod = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: (parsed.pathname || '/') + (parsed.search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'NavyCoder/1.0',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept': '*/*',
          Host: parsed.host,
        },
        // Both callback shapes: since Node 20, net.connect defaults to
        // autoSelectFamily (Happy Eyeballs), which calls lookup with
        // { all: true } and expects an ARRAY back. Answering only the older
        // (address, family) form there hands it `undefined` and every request
        // dies with "Invalid IP address: undefined".
        lookup: (_hostname, options, cb) => (options && options.all)
          ? cb(null, [{ address: pinned.address, family: pinned.family }])
          : cb(null, pinned.address, pinned.family),
      }, (res) => {
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let total = 0;
        stream.on('data', (c) => {
          // Keep draining once the cap is hit (so the socket closes cleanly)
          // but stop retaining — a hostile or merely enormous page must not be
          // able to grow this process's memory without bound.
          if (total >= maxBytes) return;
          total += c.length;
          chunks.push(c);
        });
        stream.on('end', () => {
          clearTimeout(hardTimer);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            location: res.headers.location || '',
            contentType: String(res.headers['content-type'] || ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        stream.on('error', (e) => { clearTimeout(hardTimer); reject(e); });
      });
      // Overall deadline, not just socket inactivity: a server dribbling one
      // byte a second would reset an idle timeout forever.
      const hardTimer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      req.on('error', (e) => { clearTimeout(hardTimer); reject(e); });
      req.end();
    });
  }

  async toolFetchUrl(url) {
    try {
      // Follow redirects MANUALLY so every hop is re-validated — otherwise a public
      // URL that 302s to 127.0.0.1 or a metadata endpoint bypasses the SSRF block.
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        let parsed;
        try { parsed = new URL(current); } catch { return 'Fetch error: invalid URL'; }
        if (!/^https?:$/i.test(parsed.protocol)) return 'Fetch error: only http/https URLs are allowed';
        const h = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (this._isBlockedHost(h)) return 'Fetch error: fetching private or local addresses is not allowed';
        const pinned = await this._resolveSafeAddress(h);
        if (pinned.blocked) {
          return 'Fetch error: this hostname resolves to a private or local address — fetching it is not allowed';
        }
        if (pinned.unresolvable) return `Fetch error: could not resolve ${h}`;
        // The connection goes to `pinned` and nowhere else — see _requestPinned.
        const res = await this._requestPinned(parsed, pinned, 15000, 2_000_000);
        if (res.status >= 300 && res.status < 400) {
          if (!res.location) return `HTTP ${res.status}: redirect with no Location header`;
          current = new URL(res.location, current).href; // re-validated at top of loop
          continue;
        }
        if (res.status < 200 || res.status >= 300) return `HTTP ${res.status}: ${res.statusText}`;
        const ct = res.contentType;
        let text = res.body;
        if (ct.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }
        return text.slice(0, 12000);
      }
      return 'Fetch error: too many redirects (max 5)';
    } catch (e) {
      return 'Fetch error: ' + e.message;
    }
  }
}

module.exports = {
  NET_SAFETY_METHODS: NetSafetyMethods.prototype,
};
