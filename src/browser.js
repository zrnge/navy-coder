'use strict';

// Navy's zero-dependency browser controller.
//
// Drives a real Chrome/Edge/Chromium over the Chrome DevTools Protocol so the
// model can play through a website the way a human tester would — navigate,
// look, click, type, and read what the page reports. The transport is CDP over
// --remote-debugging-pipe: Chrome reads commands on inherited fd 3 and writes
// responses/events on fd 4, one UTF-8 JSON object per message, NUL-delimited.
// No WebSocket, no open debugging port, no npm package — which is the whole
// point: this feature exists BECAUSE Navy ships with no runtime dependencies,
// and a browser-automation library (Puppeteer/Playwright) would break that.
//
// Security posture: every launch runs Chrome in a throwaway --user-data-dir, so
// the test never touches the user's real cookies, sessions, or history; Chrome's
// own OS sandbox stays ON (we never pass --no-sandbox), so page code cannot reach
// the host; and only http(s) is navigable — file:// and other schemes are refused,
// so a page can't talk the browser into reading local files.
//
// The launch itself is gated once per browser session by navy.commandApproval —
// the run_command gate, not the file-edit one — because starting a browser is
// execution: it spawns a process and grants navigation plus arbitrary in-page
// JavaScript (browser_evaluate). See _ensureBrowser in extension.js. The
// individual interactions within a playthrough are deliberately NOT re-prompted;
// clicking through a site is the whole point of the feature.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Executable discovery ─────────────────────────────────────────────────────
// Ordered by preference: real Chrome, then Edge (Chromium under the hood on every
// current platform and near-universal on Windows), then a bare Chromium. A
// user-set navy.chromePath always wins over this list.
function chromeCandidates(platform = process.platform, env = process.env) {
  const p = (...parts) => parts.filter(Boolean).join(path.sep);
  if (platform === 'win32') {
    const pf = env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || (env['USERPROFILE'] ? p(env['USERPROFILE'], 'AppData', 'Local') : '');
    return [
      p(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      p(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && p(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      p(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      p(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      p(pf, 'Chromium', 'Application', 'chrome.exe'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      env['HOME'] ? p(env['HOME'], 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') : '',
    ].filter(Boolean);
  }
  // Linux / other unix
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

function firstExisting(paths, existsSync = fs.existsSync) {
  for (const p of paths) { try { if (p && existsSync(p)) return p; } catch {} }
  return null;
}

// The launch argument list. An isolated temp profile, the automation-hygiene
// flags Chromium's own tooling uses to silence first-run noise and background
// chatter, a fixed window size so screenshots are reproducible, and the pipe
// transport. Deliberately NOT here: --no-sandbox (keeping Chrome's sandbox is
// what protects the host) and any --disable-web-security style flag.
function launchArgs({ userDataDir, headed = true, windowSize = '1280,800' }) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (!headed) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
  // A blank start page rather than the new-tab page, which phones home to Google.
  args.push('about:blank');
  return args;
}

// ── NUL-delimited framing ────────────────────────────────────────────────────
// Split a running byte buffer into complete NUL-terminated frames, returning the
// parsed messages and whatever trailing bytes belong to the next (incomplete)
// frame. Pure, so the wire framing is unit-testable without a real Chrome.
function drainFrames(buf) {
  const frames = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      const slice = buf.slice(start, i);
      if (slice.length) {
        try { frames.push(JSON.parse(slice.toString('utf8'))); } catch {}
      }
      start = i + 1;
    }
  }
  return { frames, rest: buf.slice(start) };
}

// Roles the QA loop can act on. Everything else in a snapshot is context only.
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);

// The in-page snapshot script. Runs in the page's main world (via Runtime.evaluate,
// which is not subject to the page's CSP) and returns a compact list of the things
// a tester interacts with or reads: interactive controls, headings, and anything
// that looks like an error/alert. Each row carries a stable ref (its index into
// window.__navyRefs, which browser_click/browser_type resolve against) plus the
// element's centre point so a click lands where a real cursor would.
function snapshotScript(max) {
  return `(() => {
    const out = [];
    const refs = [];
    const seen = new Set();
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
      return r;
    };
    const label = (el) => {
      let t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))) || '';
      if (!t) t = (el.value && el.type !== 'password') ? el.value : '';
      if (!t) t = (el.innerText || el.textContent || '').trim();
      return t.replace(/\\s+/g, ' ').slice(0, 80);
    };
    const role = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') return (el.type || 'text') + '-input';
      if (tag === 'a') return 'link';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return el.getAttribute('role') || tag;
    };
    const interactive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (${JSON.stringify([...INTERACTIVE_TAGS])}.includes(tag)) return true;
      if (el.getAttribute && (el.getAttribute('role') || el.getAttribute('onclick') != null)) return true;
      if (el.tabIndex >= 0 && tag !== 'body') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const noteworthy = (el) => {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return true;
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      if (role === 'alert' || role === 'status') return true;
      const cls = (el.className && el.className.toString ? el.className.toString() : '') + ' ' + (el.id || '');
      if (/error|danger|invalid|warning|toast|alert/i.test(cls)) return true;
      return false;
    };
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (out.length >= ${max}) break;
      const act = interactive(el);
      if (!act && !noteworthy(el)) continue;
      const r = vis(el);
      if (!r) continue;
      const txt = label(el);
      if (!act && !txt) continue;
      const key = role(el) + '|' + txt + '|' + Math.round(r.left) + '|' + Math.round(r.top);
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = refs.length;
      refs.push(el);
      out.push({ ref, role: role(el), text: txt, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), act });
    }
    window.__navyRefs = refs;
    return { title: document.title, url: location.href, nodes: out };
  })()`;
}

// ── Accessibility checks ─────────────────────────────────────────────────────
// Colour contrast (WCAG 2.x). Real functions rather than strings: the in-page
// audit below embeds their source, and the test suite calls them directly, so
// the arithmetic behind every contrast finding is checked without a browser.

// 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)', '#abc', '#aabbcc' or 'transparent' ->
// [r, g, b, a] with a in 0..1; null for anything it cannot read, so an unknown
// colour is skipped rather than guessed at. Chrome's getComputedStyle always
// answers in rgb()/rgba(); the hex forms are for other callers.
function parseCssColor(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  return null;
}

// A translucent colour composited over an opaque one.
function blendOver(fg, bg) {
  const a = fg[3] === undefined ? 1 : fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function relativeLuminance(c) {
  const ch = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// The in-page accessibility audit. Returns what a screen-reader or keyboard user
// would trip over, each finding with where it is and why it matters:
//   img-alt       images with no text alternative
//   label         form fields with no label, or only a placeholder
//   name          buttons and links with no accessible name
//   keyboard      clickable things the keyboard cannot reach
//   tab-order     positive tabindex, which reorders focus
//   lang, title   a page with no language or no title
//   headings      a skipped heading level
//   duplicate-id  an id used more than once (labels reach only the first)
//   contrast      text below WCAG AA contrast
// Only visible elements are judged. Text over a background image is skipped for
// contrast: its real background cannot be read from styles, and a guess would
// produce findings that are not true.
function a11yAuditScript(max = 40) {
  return `(() => {
    ${parseCssColor.toString()}
    ${blendOver.toString()}
    ${relativeLuminance.toString()}
    ${contrastRatio.toString()}
    const MAX = ${Math.max(1, Number(max) || 40)};
    const issues = [];
    const textOf = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim();
    const describe = (el) => {
      if (!el || !el.tagName) return '';
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).map(c => '.' + c).join('');
      const txt = tag === 'html' || tag === 'body' ? '' : textOf(el).slice(0, 40);
      return tag + id + cls + (txt ? ' "' + txt + '"' : '');
    };
    const add = (kind, severity, el, text) => {
      if (issues.filter(i => i.kind === kind).length >= MAX) return;
      issues.push({ kind, severity, where: describe(el), text });
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    const byIds = (ids) => ids.split(/\\s+/).map(i => document.getElementById(i)).filter(Boolean).map(textOf).join(' ').trim();
    const accName = (el) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { const t = byIds(lb); if (t) return t; }
      const al = (el.getAttribute('aria-label') || '').trim();
      if (al) return al;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (el.id) {
          const l = Array.from(document.querySelectorAll('label')).find(x => x.htmlFor === el.id);
          if (l && textOf(l)) return textOf(l);
        }
        const wrap = el.closest('label');
        if (wrap && textOf(wrap)) return textOf(wrap);
        const type = (el.getAttribute('type') || '').toLowerCase();
        if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return el.value;
        if (type === 'image') return (el.getAttribute('alt') || '').trim();
        return (el.getAttribute('title') || '').trim();
      }
      if (tag === 'img') return (el.getAttribute('alt') || '').trim();
      const own = textOf(el);
      if (own) return own;
      const img = el.querySelector('img[alt]');
      if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
      const svgTitle = el.querySelector('svg title');
      if (svgTitle && textOf(svgTitle)) return textOf(svgTitle);
      return (el.getAttribute('title') || '').trim();
    };

    for (const img of document.querySelectorAll('img')) {
      if (!visible(img)) continue;
      const role = img.getAttribute('role');
      if (!img.hasAttribute('alt') && !img.getAttribute('aria-label') && !img.getAttribute('aria-labelledby')
          && role !== 'presentation' && role !== 'none') {
        add('img-alt', 'serious', img, 'Image has no alt text: a screen reader announces its file name or nothing. Use alt="" if it is purely decorative.');
      }
    }
    for (const el of document.querySelectorAll('[role="img"], input[type="image"]')) {
      if (visible(el) && !accName(el)) add('img-alt', 'serious', el, 'Image element has no text alternative, so it has no name.');
    }

    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || !visible(el)) continue;
      if (accName(el)) continue;
      const ph = (el.getAttribute('placeholder') || '').trim();
      add('label', 'serious', el, ph
        ? 'Field is labelled only by its placeholder ("' + ph.slice(0, 40) + '"), which disappears once someone starts typing.'
        : 'Form field has no label: a screen-reader user hears "edit text" with no idea what goes in it.');
    }

    for (const el of document.querySelectorAll('button, [role="button"], a[href], [role="link"]')) {
      if (!visible(el) || accName(el)) continue;
      const isLink = el.tagName.toLowerCase() === 'a' || el.getAttribute('role') === 'link';
      add('name', 'serious', el, isLink
        ? 'Link has no text, so it is announced only as "link".'
        : 'Button has no accessible name (icon-only?), so it is announced only as "button".');
    }

    const NATIVE = ['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'];
    for (const el of document.querySelectorAll('[onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"]')) {
      const tag = el.tagName.toLowerCase();
      if (NATIVE.includes(tag) && !(tag === 'a' && !el.hasAttribute('href'))) continue;
      if (!visible(el)) continue;
      if (el.tabIndex < 0) add('keyboard', 'serious', el, 'Clickable, but the keyboard cannot reach it: it is not a link or button and has no tabindex.');
    }

    for (const el of document.querySelectorAll('[tabindex]')) {
      const n = Number(el.getAttribute('tabindex'));
      if (n > 0 && visible(el)) add('tab-order', 'moderate', el, 'tabindex="' + n + '" pulls this ahead of the page order, so keyboard focus jumps around the page.');
    }

    if (!(document.documentElement.getAttribute('lang') || '').trim()) {
      add('lang', 'moderate', document.documentElement, 'The page declares no language (no lang attribute), so screen readers guess it and may mispronounce everything.');
    }
    if (!(document.title || '').trim()) {
      add('title', 'moderate', document.documentElement, 'The page has no title, so its tab and history entry say nothing.');
    }

    let lastLevel = 0;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!visible(h)) continue;
      const level = Number(h.tagName.charAt(1));
      if (lastLevel && level > lastLevel + 1) {
        add('headings', 'minor', h, 'Heading jumps from h' + lastLevel + ' to h' + level + ', skipping a level in the outline screen-reader users navigate by.');
      }
      lastLevel = level;
    }

    const idCount = {};
    for (const el of document.querySelectorAll('[id]')) idCount[el.id] = (idCount[el.id] || 0) + 1;
    for (const id of Object.keys(idCount)) {
      if (idCount[id] > 1) {
        add('duplicate-id', 'minor', document.getElementById(id), 'id="' + id + '" is used ' + idCount[id] + ' times; labels and aria references pointing at it only ever reach the first.');
      }
    }

    const effectiveBg = (el) => {
      const layers = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        const c = parseCssColor(cs.backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let bg = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) bg = blendOver(layers[i], bg);
      return bg;
    };
    let contrastChecked = 0;
    const seen = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && contrastChecked < 500; t = walker.nextNode()) {
      if (!t.nodeValue || !t.nodeValue.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (['script', 'style', 'noscript', 'template'].includes(el.tagName.toLowerCase()) || !visible(el)) continue;
      const cs = getComputedStyle(el);
      const fg = parseCssColor(cs.color);
      const bg = fg && effectiveBg(el);
      if (!fg || !bg) continue;
      contrastChecked++;
      const ratio = contrastRatio(blendOver(fg, bg), bg);
      const size = parseFloat(cs.fontSize) || 16;
      const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        add('contrast', ratio < need - 1.5 ? 'serious' : 'moderate', el,
          'Text contrast is ' + ratio.toFixed(2) + ':1, below the ' + need + ':1 WCAG AA minimum for ' + (large ? 'large' : 'normal')
          + ' text (' + cs.color + ' on rgb(' + bg.slice(0, 3).map(Math.round).join(', ') + ')).');
      }
    }

    const counts = {};
    for (const i of issues) counts[i.kind] = (counts[i.kind] || 0) + 1;
    return { url: location.href, title: document.title, issues, counts, contrastChecked };
  })()`;
}

// Describe whichever element has keyboard focus, for focusOrder. null when focus
// is on nothing in particular (the body) - where Tab lands after the last
// focusable element, before it wraps. Each element gets a stable key the first
// time it is seen, so the sequence can tell "moved on" from "stuck".
const FOCUS_DESCRIBE_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.value || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 40);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const ring = Boolean(cs.boxShadow) && cs.boxShadow !== 'none';
  if (!el.__navyFocusKey) el.__navyFocusKey = 'f' + (window.__navyFocusSeq = (window.__navyFocusSeq || 0) + 1);
  return {
    key: el.__navyFocusKey, tag: el.tagName.toLowerCase(), label,
    visible: r.width >= 1 && r.height >= 1 && cs.visibility !== 'hidden',
    indicator: outline || ring, x: Math.round(r.left), y: Math.round(r.top),
  };
})()`;

// Turn the raw Tab sequence into findings. Pure, so it is tested without a
// browser.
//   - a return to the first stop, or focus leaving the page's elements, ends
//     the cycle (complete);
//   - the same element twice in a row, when it is not the only stop, means Tab
//     did not move focus: a keyboard trap;
//   - focus on something with no size, or hidden, is focus nobody can see;
//   - a visible stop whose focused style shows no outline or ring probably has
//     no focus indicator (a site can mark focus other ways, hence "probably").
function analyzeFocusStops(stops) {
  const sequence = [];
  const traps = [];
  const invisible = [];
  const noIndicator = [];
  let complete = false;
  for (const s of stops) {
    if (!s) { complete = sequence.length > 0; break; }
    if (sequence.length && s.key === sequence[0].key) { complete = true; break; }
    const prev = sequence[sequence.length - 1];
    if (prev && s.key === prev.key) { traps.push(s); break; }
    sequence.push(s);
    if (!s.visible) invisible.push(s);
    else if (!s.indicator) noIndicator.push(s);
  }
  return { sequence, traps, invisible, noIndicator, complete };
}

class Browser {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath || null;
    this.headed = opts.headed !== false;
    this.windowSize = opts.windowSize || '1280,800';
    this.log = opts.log || (() => {});
    this._spawn = opts.spawn || spawn;
    this._existsSync = opts.existsSync || fs.existsSync;
    this._cmdTimeout = opts.commandTimeout || 30000;
    this._navTimeout = opts.navTimeout || 20000;

    this.proc = null;
    this.userDataDir = null;
    this.executablePath = null;
    this._nextId = 1;
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._recv = Buffer.alloc(0);
    this._sessionId = null;      // the attached page target's flat session
    this._targetId = null;
    this._events = [];           // captured console / exceptions / failed requests
    this._loadWaiters = [];      // resolvers fired by Page.loadEventFired
    this._closed = false;
    this._launched = false;
  }

  get running() { return this._launched && !this._closed; }

  resolveExecutable() {
    if (this.chromePath) {
      if (this._existsSync(this.chromePath)) return this.chromePath;
      throw new Error(`navy.chromePath points at "${this.chromePath}", which does not exist.`);
    }
    const found = firstExisting(chromeCandidates(), this._existsSync);
    if (!found) {
      throw new Error('No Chrome, Edge, or Chromium found. Install Google Chrome, or set navy.chromePath to your browser executable.');
    }
    return found;
  }

  async launch() {
    if (this._launched) return;
    const exe = this.resolveExecutable();
    this.executablePath = exe;
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-browser-'));
    const args = launchArgs({ userDataDir: this.userDataDir, headed: this.headed, windowSize: this.windowSize });
    this.log(`Launching ${path.basename(exe)} (${this.headed ? 'headed' : 'headless'}) for playthrough`);

    // fds 1/2 are 'ignore', not 'pipe': Chrome's protocol rides only on 3/4, and
    // its stdout/stderr are just logs. Piping them without a drain would let the
    // ~64KB OS pipe buffer fill on a chatty Chrome and block it mid-write.
    // windowsHide hides only a stray console window — Chrome's GUI window (when
    // headed) is unaffected.
    this.proc = this._spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._launched = true;

    const writePipe = this.proc.stdio[3];  // Chrome reads commands here (its fd 3)
    const readPipe = this.proc.stdio[4];    // Chrome writes responses here (its fd 4)
    if (!writePipe || !readPipe) {
      // Chrome is already spawned at this point — leaving it running would orphan
      // a browser (and its temp profile) that nothing holds a handle to.
      this._launched = false;
      this._closed = true;
      this._killProc();
      this._cleanupProfile();
      throw new Error('Chrome did not expose the remote-debugging pipe (fd 3/4). This build may not support --remote-debugging-pipe.');
    }
    this._writePipe = writePipe;
    readPipe.on('data', (d) => this._onData(d));
    readPipe.on('error', () => {});
    this.proc.on('exit', () => this._onExit());
    this.proc.on('error', () => this._onExit());

    // Attach to a fresh page target with the flat protocol so every later command
    // just rides its sessionId — no nested Target.sendMessageToTarget wrapping.
    await this._send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' });
    this._targetId = targetId;
    const { sessionId } = await this._send('Target.attachToTarget', { targetId, flatten: true });
    this._sessionId = sessionId;

    await this._send('Page.enable', {}, sessionId);
    await this._send('Runtime.enable', {}, sessionId);
    await this._send('Log.enable', {}, sessionId);
    await this._send('Network.enable', {}, sessionId);
    await this._send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }

  _onData(chunk) {
    this._recv = Buffer.concat([this._recv, chunk]);
    const { frames, rest } = drainFrames(this._recv);
    this._recv = rest;
    for (const msg of frames) this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (timer) clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) this._onEvent(msg.method, msg.params || {});
  }

  _onEvent(method, params) {
    switch (method) {
      case 'Page.loadEventFired': {
        const waiters = this._loadWaiters;
        this._loadWaiters = [];
        for (const w of waiters) w();
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = (params.args || []).map(a => a.value != null ? String(a.value) : (a.description || a.type || '')).join(' ');
        this._record(params.type === 'error' ? 'console.error' : `console.${params.type || 'log'}`, text);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        const msg = d.exception?.description || d.text || 'Uncaught exception';
        this._record('pageerror', msg);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        if (e.level === 'error' || e.level === 'warning') this._record(`log.${e.level}`, `${e.text || ''}${e.url ? ' (' + e.url + ')' : ''}`);
        break;
      }
      case 'Network.responseReceived': {
        const r = params.response || {};
        if (r.status >= 400) this._record('network', `HTTP ${r.status} ${r.url || ''}`);
        break;
      }
      case 'Network.loadingFailed': {
        if (!params.canceled) this._record('network', `Request failed: ${params.errorText || 'unknown'} (${params.type || ''})`);
        break;
      }
    }
  }

  _record(kind, text) {
    if (!text) return;
    this._events.push({ kind, text: String(text).slice(0, 500), at: Date.now() });
    if (this._events.length > 500) this._events.shift();
  }

  _send(method, params = {}, sessionId = null) {
    if (this._closed) return Promise.reject(new Error('Browser is closed.'));
    const id = this._nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method} did not respond in ${this._cmdTimeout}ms`));
        }
      }, this._cmdTimeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._writeFrame(payload);
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // Put one NUL-terminated JSON frame on the pipe. Split out of _send so a
  // fire-and-forget command (Browser.close, which Chrome answers by closing the
  // connection rather than replying) can be written without registering a
  // pending promise that would then sit until the command timeout.
  _writeFrame(payload) {
    this._writePipe.write(Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), Buffer.from([0])]));
  }

  _onExit() {
    if (this._closed) return;
    this._closed = true;
    for (const { reject, timer } of this._pending.values()) {
      if (timer) clearTimeout(timer);
      try { reject(new Error('Browser process exited.')); } catch {}
    }
    this._pending.clear();
    // Chrome died on its own (crash, user closed the window). Nothing else will
    // come back for the profile dir, so remove it here rather than leaking one
    // per playthrough.
    setTimeout(() => this._cleanupProfile(), 1500);
  }

  // Run an expression in the page and return the value by value. Throws on a
  // thrown JS exception so callers surface real page errors rather than undefined.
  async evaluate(expression, { awaitPromise = false } = {}) {
    const res = await this._send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, this._sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed');
    }
    return res.result?.value;
  }

  async navigate(url) {
    // Resolve on whichever comes first: the load event, or the timeout for a page
    // that never fires one (a stalled subresource, an SPA that never completes).
    // Both paths clean up after themselves — an uncleared timer would keep the
    // event loop busy for the full timeout, and a timed-out waiter left in
    // _loadWaiters would sit there for the life of the browser.
    const done = new Promise((resolve) => {
      let timer = null;
      const waiter = () => { if (timer) clearTimeout(timer); resolve(); };
      this._loadWaiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._loadWaiters.indexOf(waiter);
        if (i !== -1) this._loadWaiters.splice(i, 1);
        resolve();
      }, this._navTimeout);
    });
    const res = await this._send('Page.navigate', { url }, this._sessionId);
    if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
    await done;
    await new Promise(r => setTimeout(r, 400)); // brief settle for late scripts/SPAs
    return this.evaluate('({ title: document.title, url: location.href })');
  }

  // Reports whether it actually moved: at the first entry there is nothing to go
  // back to, and silently reporting success would have the model believe it
  // exercised a back-button it never pressed.
  async back() {
    const hist = await this._send('Page.getNavigationHistory', {}, this._sessionId);
    const idx = hist.currentIndex;
    let moved = false;
    if (idx > 0) {
      await this._send('Page.navigateToHistoryEntry', { entryId: hist.entries[idx - 1].id }, this._sessionId);
      await new Promise(r => setTimeout(r, 600));
      moved = true;
    }
    const info = await this.evaluate('({ title: document.title, url: location.href })');
    return { ...(info || {}), moved };
  }

  async screenshot() {
    const res = await this._send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, this._sessionId);
    return res.data; // base64 PNG
  }

  async snapshot(max = 150) {
    return this.evaluate(snapshotScript(max));
  }

  // Resolve a ref to its live element's centre, scroll it into view, and return
  // the point. Returns null when the ref is stale (the DOM changed since the last
  // snapshot) so callers can tell the model to snapshot again.
  async _refPoint(ref) {
    return this.evaluate(`(() => {
      const el = (window.__navyRefs || [])[${Number(ref)}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
    })()`);
  }

  async click(ref) {
    const pt = await this._refPoint(ref);
    if (!pt) throw new Error(`ref ${ref} is stale — call browser_snapshot again to get fresh refs.`);
    await new Promise(r => setTimeout(r, 60));
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this._send('Input.dispatchMouseEvent', {
        type, x: pt.x, y: pt.y, button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
      }, this._sessionId);
    }
    await new Promise(r => setTimeout(r, 300)); // let a click-driven nav/render begin
    return pt;
  }

  async type(ref, text, submit = false) {
    const pt = await this._refPoint(ref);
    if (!pt) throw new Error(`ref ${ref} is stale — call browser_snapshot again to get fresh refs.`);
    // Focus by clicking, clear any existing value, then insert as real input.
    await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 }, this._sessionId);
    await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 0 }, this._sessionId);
    await this.evaluate(`(() => { const el = (window.__navyRefs||[])[${Number(ref)}]; if (el && 'value' in el) el.value=''; })()`);
    await this._send('Input.insertText', { text: String(text) }, this._sessionId);
    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await this._send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, this._sessionId);
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return pt;
  }

  async scroll(amount = 600) {
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: Number(amount) || 600,
    }, this._sessionId);
    await new Promise(r => setTimeout(r, 250));
    return this.evaluate('({ scrollY: Math.round(window.scrollY), scrollHeight: document.body ? document.body.scrollHeight : 0 })');
  }

  // Return captured console/error/network entries, newest cleared by default so
  // each call reports only what happened since the last one.
  // ── Accessibility and visual regression ──────────────────────────────────
  async accessibilityAudit(max = 40) {
    return this.evaluate(a11yAuditScript(max));
  }

  // Press Tab through the page the way a keyboard user would, from the top, and
  // report what focus did. Real key events, not element.focus(): only real Tab
  // presses exercise the page's own tab order, its focus traps and its
  // :focus-visible styling. Stops as soon as the cycle completes or focus sticks.
  async focusOrder(max = 60) {
    await this.evaluate('(() => { const b = document.body || document.documentElement; const had = b.hasAttribute("tabindex");'
      + ' if (!had) b.setAttribute("tabindex", "-1"); b.focus({ preventScroll: true }); if (!had) b.removeAttribute("tabindex");'
      + ' window.scrollTo(0, 0); return true; })()');
    const stops = [];
    for (let i = 0; i < max; i++) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await this._send('Input.dispatchKeyEvent',
          { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, this._sessionId);
      }
      stops.push(await this.evaluate(FOCUS_DESCRIBE_SCRIPT));
      const sofar = analyzeFocusStops(stops);
      if (sofar.complete || sofar.traps.length) break;
    }
    return { ...analyzeFocusStops(stops), pressed: stops.length };
  }

  // A screenshot at a fixed size and pixel density, for visual regression.
  // Baselines have to be comparable across runs and machines: a headed window
  // can be resized between runs, and a HiDPI display doubles every screenshot's
  // pixels. The override applies to this capture only and is cleared straight
  // after, so ordinary screenshots still show exactly what the user sees.
  //
  // It also captures the page at rest rather than in whatever state the last
  // tool left it. Measured in real Chrome, the focus ring left on the page by
  // focusOrder's Tab walk changed 965 pixels and a 600px scroll changed 760,
  // so either one reported "CHANGED" for a screen nobody touched, and so did
  // the :hover style under the mouse where the last click left it (2,660). So:
  // the mouse off the page, nothing focused, scrolled to the top - with the
  // scroll put back afterwards so the playthrough carries on where it was.
  // Focus and the mouse are not put back: a scripted focus() draws a different
  // ring from the one Tab drew, and the next click or type moves both to where
  // it needs them anyway.
  async captureFixed({ width = 1280, height = 800 } = {}) {
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1 }, this._sessionId).catch(() => {});
    const was = await this.evaluate('(() => { const a = document.activeElement;'
      + ' if (a && a !== document.body && typeof a.blur === "function") a.blur();'
      + ' const s = { x: window.scrollX, y: window.scrollY }; window.scrollTo(0, 0); return s; })()').catch(() => null);
    await this._send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, this._sessionId);
    try {
      await this.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
        { awaitPromise: true }).catch(() => {});
      await new Promise(r => setTimeout(r, 350)); // the resize's layout and paint
      return await this.screenshot();
    } finally {
      await this._send('Emulation.clearDeviceMetricsOverride', {}, this._sessionId).catch(() => {});
      if (was && (was.x || was.y)) {
        await this.evaluate(`window.scrollTo(${Number(was.x) || 0}, ${Number(was.y) || 0})`).catch(() => {});
      }
    }
  }

  drainEvents(clear = true) {
    const out = this._events.slice();
    if (clear) this._events = [];
    return out;
  }

  async close() {
    if (this._closed) { this._killProc(); this._cleanupProfile(); return; }
    // Ask Chrome to exit gracefully FIRST, while the transport is still open —
    // setting _closed before this would make _send reject and the graceful path
    // would silently never happen, leaving every run to be force-killed (and the
    // profile still locked when cleanup tried to remove it). Fire-and-forget: a
    // closing Chrome drops the pipe instead of answering.
    try { this._writeFrame({ id: this._nextId++, method: 'Browser.close', params: {} }); } catch {}
    this._closed = true;
    // Give it a moment to go on its own, then make sure it is gone either way.
    await new Promise(r => setTimeout(r, 300));
    try { this._writePipe?.end(); } catch {}
    this._killProc();
    // Chrome needs a beat to release the profile lock before the dir can go.
    setTimeout(() => this._cleanupProfile(), 1500);
  }

  _killProc() {
    if (!this.proc || this.proc.killed) return;
    try {
      if (process.platform === 'win32' && this.proc.pid) {
        // The 'error' listener is not optional. spawn reports failure (taskkill
        // missing, denied, racing shutdown) by EMITTING 'error' asynchronously,
        // which the try/catch around this cannot catch - and an unhandled
        // 'error' event is an uncaught exception, which takes the whole
        // extension host down with it. src/background.js guards its identical
        // taskkill call the same way.
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => {});
      } else {
        this.proc.kill('SIGTERM');
      }
    } catch {}
  }

  _cleanupProfile() {
    if (!this.userDataDir) return;
    const dir = this.userDataDir;
    this.userDataDir = null;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}

module.exports = {
  Browser, chromeCandidates, firstExisting, launchArgs, drainFrames, snapshotScript, INTERACTIVE_TAGS,
  parseCssColor, blendOver, relativeLuminance, contrastRatio, a11yAuditScript, FOCUS_DESCRIBE_SCRIPT, analyzeFocusStops,
};
