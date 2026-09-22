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
      // A drag source is usually a plain div, which nothing else here would
      // list - and an element nobody can name is an element nobody can drag.
      if (el.draggable === true) return true;
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

// What the caller asked for, and what to say when it is not there. A ref that
// no longer resolves means the page moved on; a selector that matches nothing
// is usually a wrong guess at the markup.
function describeTarget(target) {
  if (target && typeof target === 'object' && target.selector) return `"${target.selector}"`;
  if (typeof target === 'string') return `"${target}"`;
  const ref = target && typeof target === 'object' ? target.ref : target;
  return `ref ${ref}`;
}

function missingTarget(target) {
  const what = describeTarget(target);
  return what.startsWith('"')
    ? `${what} matches nothing on the page — check the markup with browser_evaluate, or use a ref from browser_snapshot.`
    : `${what} is stale — call browser_snapshot again to get fresh refs.`;
}

// The area of a content quad, so a zero-sized or collapsed box is not taken
// for a clickable one. Shoelace formula over the four corners.
function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 8; i += 2) {
    const x1 = q[i], y1 = q[i + 1], x2 = q[(i + 2) % 8], y2 = q[(i + 3) % 8];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// The keys a tester actually presses. `code2` is the Windows virtual key code,
// which Chrome wants on every key event; `text` is what a printable key inserts.
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', code2: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', code2: 9 },
  Escape: { key: 'Escape', code: 'Escape', code2: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', code2: 8 },
  Delete: { key: 'Delete', code: 'Delete', code2: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', code2: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', code2: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', code2: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', code2: 39 },
  Home: { key: 'Home', code: 'Home', code2: 36 },
  End: { key: 'End', code: 'End', code2: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', code2: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', code2: 34 },
  Space: { key: ' ', code: 'Space', code2: 32, text: ' ' },
};

// A named key, or any single character ("a", "/", "7").
function keySpec(name) {
  const n = String(name || '');
  const named = Object.keys(KEYS).find(k => k.toLowerCase() === n.toLowerCase());
  if (named) return KEYS[named];
  if ([...n].length !== 1) return null;
  const upper = n.toUpperCase();
  const code = /[a-z]/i.test(n) ? 'Key' + upper : (/[0-9]/.test(n) ? 'Digit' + n : '');
  return { key: n, code, code2: upper.charCodeAt(0), text: n };
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

    // Tabs. A site that opens a popup or a target=_blank link used to leave the
    // driver looking at the page it came from, with no way to reach the new one.
    // Every page target is attached as it appears and the newest becomes the
    // current one, which is what the tester would be looking at.
    this._tabs = [];             // [{ sessionId, targetId, opener }], in the order they opened
    this._ignoreTargets = new Set(); // tabs that were open before Navy's own, never part of the run
    // Frames. A same-origin iframe is another execution context in this target;
    // a cross-origin one is a target of its own. Both are walked by snapshot(),
    // so a control inside an iframe has a ref like any other.
    this._frameTargets = new Map();  // iframe sessionId -> { targetId, parentSessionId }
    this._contexts = new Map();      // sessionId -> Map(contextId -> { id, frameId, isDefault })
    this._refs = [];                 // snapshot ref -> { sessionId, contextId, index }
    this._domReady = new Set();      // sessions where DOM.enable/getDocument has run
    // How the next alert/confirm/prompt is answered. Nothing answering them at
    // all was worse than any default: the dialog blocks the renderer, and every
    // command after it times out until the browser is closed.
    this._dialog = { accept: true, promptText: '' };
    this._forcedHover = null;    // { sessionId, nodeId } - see hover()
    this._viewport = null;       // a viewport set by the caller, re-applied after captureFixed
    this._dragWaiters = [];      // callbacks fed by Input.dragIntercepted, see drag()
    this.downloadDir = null;
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

    this._tabs = [{ sessionId, targetId, opener: null }];
    await this._enableDomains(sessionId);

    // Chrome's own starting tab is not part of the test - the playthrough
    // happens in the target created above - so everything already open is
    // remembered and left out of the tab list.
    try {
      const { targetInfos } = await this._send('Target.getTargets');
      for (const t of targetInfos || []) {
        if (t.type === 'page' && t.targetId !== targetId) this._ignoreTargets.add(t.targetId);
      }
    } catch { /* an empty ignore set only means one extra row */ }

    // Anything this page opens - a popup, a cross-origin iframe - attaches as it
    // is created, so it can be snapshotted and driven rather than being a blank
    // the driver cannot see into. A cross-origin iframe is reported to the page
    // that holds it; a new tab is reported at the browser level, which is why
    // both are asked for.
    await this._send('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
    await this._send('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});

    // Downloads land in the throwaway profile and are reported like any other
    // page event, so "clicking Export downloads a file" is a checkable claim.
    this.downloadDir = path.join(this.userDataDir, 'downloads');
    try { fs.mkdirSync(this.downloadDir, { recursive: true }); } catch { /* reported as no download */ }
    await this._send('Browser.setDownloadBehavior',
      { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true }).catch(() => {});
  }

  // The domains every page-ish session needs: Page for loads and dialogs,
  // Runtime for console and execution contexts, Log and Network for the errors
  // a user never sees.
  async _enableDomains(sessionId, { network = true } = {}) {
    await this._send('Page.enable', {}, sessionId).catch(() => {});
    await this._send('Runtime.enable', {}, sessionId).catch(() => {});
    await this._send('Log.enable', {}, sessionId).catch(() => {});
    if (network) await this._send('Network.enable', {}, sessionId).catch(() => {});
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
    if (msg.method) this._onEvent(msg.method, msg.params || {}, msg.sessionId || null);
  }

  _onEvent(method, params, sessionId = null) {
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

      // A dialog stops the renderer until it is answered. Answer it the way the
      // caller asked (accept, by default, as a user clicking OK), and record it:
      // an alert or a confirm IS part of what the page did.
      case 'Page.javascriptDialogOpening': {
        const kind = params.type || 'dialog';
        const text = String(params.message || '').slice(0, 300);
        this._record('dialog', `${kind}: ${text}${this._dialog.accept ? ' [accepted]' : ' [dismissed]'}`);
        const answer = { accept: kind === 'beforeunload' ? true : this._dialog.accept };
        if (kind === 'prompt') answer.promptText = String(this._dialog.promptText || '');
        this._send('Page.handleJavaScriptDialog', answer, sessionId || this._sessionId).catch(() => {});
        break;
      }

      // A new tab, or an iframe that runs in its own process.
      case 'Target.attachedToTarget': {
        const info = params.targetInfo || {};
        if (info.type === 'page') this._adoptTab(params.sessionId, info, sessionId);
        else if (info.type === 'iframe') this._adoptFrameTarget(params.sessionId, info, sessionId);
        break;
      }
      // A tab that arrives only as a discovery event (an older Chrome, or a
      // target the auto-attach did not cover) is attached by hand.
      case 'Target.targetCreated': {
        const info = params.targetInfo || {};
        if (info.type === 'page' && !this._ignoreTargets.has(info.targetId)
          && !this._tabs.some(t => t.targetId === info.targetId) && info.targetId !== this._targetId) {
          this._send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
            .then(({ sessionId: sid }) => { if (sid) this._adoptTab(sid, info, null); })
            .catch(() => { /* it may have gone already */ });
        }
        break;
      }
      case 'Target.detachedFromTarget': {
        this._forgetSession(params.sessionId);
        break;
      }

      // Which execution contexts exist is what makes a same-origin iframe
      // reachable: each frame has its own, and snapshot() walks all of them.
      case 'Runtime.executionContextCreated': {
        const c = params.context || {};
        const key = sessionId || this._sessionId;
        if (!this._contexts.has(key)) this._contexts.set(key, new Map());
        this._contexts.get(key).set(c.id, { id: c.id, frameId: c.auxData?.frameId || '', isDefault: c.auxData?.isDefault !== false });
        break;
      }
      case 'Runtime.executionContextDestroyed': {
        this._contexts.get(sessionId || this._sessionId)?.delete(params.executionContextId);
        break;
      }
      case 'Runtime.executionContextsCleared': {
        this._contexts.get(sessionId || this._sessionId)?.clear();
        break;
      }

      case 'Input.dragIntercepted': {
        for (const w of this._dragWaiters) { try { w(params.data); } catch { /* the drag falls back to mouse events */ } }
        break;
      }
      case 'Browser.downloadWillBegin': {
        this._record('download', `started: ${params.suggestedFilename || params.url || 'file'}`);
        break;
      }
      case 'Browser.downloadProgress': {
        if (params.state === 'completed') this._record('download', `completed (${params.totalBytes || 0} bytes)`);
        else if (params.state === 'canceled') this._record('download', 'canceled');
        break;
      }
    }
  }

  // A new tab: enabled, remembered, and made the current one - a popup takes
  // the foreground for a person, so it does for the driver too.
  _adoptTab(sessionId, info, opener) {
    if (!sessionId || this._ignoreTargets.has(info.targetId)) return;
    if (this._tabs.some(t => t.sessionId === sessionId || t.targetId === info.targetId)) return;
    this._tabs.push({ sessionId, targetId: info.targetId, opener: opener || null });
    this._sessionId = sessionId;
    this._record('tab', `a new tab opened: ${info.url || 'about:blank'} (now the current tab)`);
    this._enableDomains(sessionId).catch(() => {});
    this._send('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  }

  _adoptFrameTarget(sessionId, info, parentSessionId) {
    if (!sessionId || this._frameTargets.has(sessionId)) return;
    this._frameTargets.set(sessionId, { targetId: info.targetId, parentSessionId: parentSessionId || this._sessionId });
    this._enableDomains(sessionId, { network: false }).catch(() => {});
  }

  // A tab or frame went away. If the current tab closed, fall back to the most
  // recent one still open rather than leaving every command pointed at nothing.
  _forgetSession(sessionId) {
    if (!sessionId) return;
    this._frameTargets.delete(sessionId);
    this._contexts.delete(sessionId);
    this._domReady.delete(sessionId);
    const i = this._tabs.findIndex(t => t.sessionId === sessionId);
    if (i === -1) return;
    this._tabs.splice(i, 1);
    if (this._sessionId === sessionId) {
      const next = this._tabs[this._tabs.length - 1];
      this._sessionId = next ? next.sessionId : null;
      if (next) this._record('tab', 'the current tab closed; back to the previous one');
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
    await this.clearHover();
    this._refs = [];
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

  // Every frame, not just the top one. A same-origin iframe is another
  // execution context in this target and a cross-origin one is a target of its
  // own; either way its controls had no row here, so no ref, so no way to click
  // them - which ruled out most embedded checkouts, sign-ins and players. Refs
  // are numbered across the whole page and remember which frame they came from.
  async snapshot(max = 150) {
    const worlds = await this._worlds();
    this._refs = [];
    const nodes = [];
    let top = null;
    for (const w of worlds) {
      if (nodes.length >= max) break;
      let res = null;
      try { res = await this._evaluateIn(w, snapshotScript(max - nodes.length)); } catch { continue; }
      if (!res || !Array.isArray(res.nodes)) continue;
      if (!top) top = res;
      for (const n of res.nodes) {
        const ref = this._refs.length;
        this._refs.push({ sessionId: w.sessionId, contextId: w.contextId, index: n.ref });
        nodes.push(w.frame ? { ...n, ref, frame: res.url || 'iframe' } : { ...n, ref });
      }
    }
    return { title: (top && top.title) || '', url: (top && top.url) || '', nodes };
  }

  // The execution contexts a snapshot walks: the current tab's frames, then any
  // cross-origin iframe attached under it. A session whose contexts we never saw
  // (an old mock, a page that loaded before Runtime.enable) still gets one world
  // with no contextId, which evaluates in its default world exactly as before.
  async _worlds() {
    const out = [];
    const sessions = [this._sessionId, ...this._frameSessionsUnder(this._sessionId)];
    for (const sessionId of sessions) {
      if (!sessionId) continue;
      const known = [...(this._contexts.get(sessionId) || new Map()).values()].filter(c => c.isDefault);
      if (!known.length) {
        out.push({ sessionId, contextId: null, frame: sessionId !== this._sessionId });
        continue;
      }
      let mainFrameId = '';
      try { mainFrameId = (await this._send('Page.getFrameTree', {}, sessionId)).frameTree?.frame?.id || ''; } catch { /* keep the order we have */ }
      known.sort((a, b) => Number(b.frameId === mainFrameId) - Number(a.frameId === mainFrameId));
      known.forEach((c, i) => {
        // Everything outside this tab's own top frame is "in a frame". Without a
        // frame tree to say which that is, the first context of the session is
        // the page itself - it is the one that existed before any iframe did.
        const inFrame = sessionId !== this._sessionId || (mainFrameId ? c.frameId !== mainFrameId : i > 0);
        out.push({ sessionId, contextId: c.id, frame: inFrame });
      });
    }
    return out;
  }

  // Cross-origin iframes attached under a tab, including nested ones.
  _frameSessionsUnder(sessionId) {
    const out = [];
    const want = new Set([sessionId]);
    for (let pass = 0; pass < 4; pass++) {
      for (const [sid, info] of this._frameTargets) {
        if (out.includes(sid) || !want.has(info.parentSessionId)) continue;
        out.push(sid);
        want.add(sid);
      }
    }
    return out;
  }

  async _evaluateIn(world, expression) {
    const params = { expression, returnByValue: true, userGesture: true };
    if (world.contextId) params.contextId = world.contextId;
    const res = await this._send('Runtime.evaluate', params, world.sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed');
    }
    return res.result?.value;
  }

  // A ref back to the live element it stands for. Refs from before the frame
  // walk (and from a caller that never snapshotted) resolve in the current
  // tab's default world, which is what they always meant.
  _refEntry(ref) {
    return this._refs[Number(ref)] || { sessionId: this._sessionId, contextId: null, index: Number(ref) };
  }

  // An element by ref, or by CSS selector for anything the outline does not
  // list - a drop zone, a plain-div menu trigger, a canvas. Selectors are tried
  // in every frame, so one inside an iframe resolves too.
  async _resolveTarget(target) {
    // A bare number or numeric string is a ref, as every caller used to pass;
    // a bare string is a selector; an object may name either.
    const t = target && typeof target === 'object' ? target
      : (typeof target === 'string' && !/^\d+$/.test(target.trim()) ? { selector: target } : { ref: target });
    if (t.selector && String(t.selector).trim()) return this._resolveSelector(String(t.selector).trim());
    if (t.ref == null || t.ref === '' || isNaN(Number(t.ref))) {
      throw new Error('give a ref from browser_snapshot, or a CSS selector.');
    }
    return this._resolveRef(t.ref);
  }

  async _resolveSelector(selector) {
    for (const w of await this._worlds()) {
      const params = { expression: `document.querySelector(${JSON.stringify(selector)})` };
      if (w.contextId) params.contextId = w.contextId;
      let res;
      try { res = await this._send('Runtime.evaluate', params, w.sessionId); } catch { continue; }
      if (res.exceptionDetails) throw new Error(`"${selector}" is not a valid CSS selector.`);
      if (res.result?.objectId && res.result?.subtype !== 'null') {
        return { sessionId: w.sessionId, contextId: w.contextId, objectId: res.result.objectId, selector };
      }
    }
    return null;
  }

  async _resolveRef(ref) {
    const r = this._refEntry(ref);
    if (!r.sessionId) return null;
    const params = { expression: `(window.__navyRefs || [])[${Number(r.index)}] || null` };
    if (r.contextId) params.contextId = r.contextId;
    const res = await this._send('Runtime.evaluate', params, r.sessionId);
    const objectId = res.result?.objectId;
    if (!objectId || res.result?.subtype === 'null') return null;
    return { ...r, objectId };
  }

  // DOM.getContentQuads, DOM.requestNode and DOM.setFileInputFiles all need the
  // DOM agent to hold a document first - without the getDocument they hang
  // rather than fail, which costs a command timeout each.
  async _ensureDom(sessionId) {
    if (!sessionId || this._domReady.has(sessionId)) return;
    await this._send('DOM.enable', {}, sessionId).catch(() => {});
    await this._send('DOM.getDocument', { depth: 1 }, sessionId).catch(() => {});
    this._domReady.add(sessionId);
  }

  // Where to click. Content quads come back in the coordinates of the session
  // that owns the node, which is also the session the input goes to - so a
  // control inside an iframe needs no arithmetic here. Falls back to the
  // element's own rect for a node the DOM agent will not measure.
  async _pointFor(node) {
    await this._ensureDom(node.sessionId);
    await this._send('DOM.scrollIntoViewIfNeeded', { objectId: node.objectId }, node.sessionId).catch(() => {});
    let quads = null;
    try { quads = (await this._send('DOM.getContentQuads', { objectId: node.objectId }, node.sessionId)).quads; } catch { /* fall through */ }
    const quad = (quads || []).find(q => Array.isArray(q) && q.length === 8 && quadArea(q) > 1);
    if (quad) {
      return { x: Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4), y: Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4) };
    }
    const rect = await this._callOn(node, 'function() { this.scrollIntoView({ block: "center", inline: "center" });'
      + ' const r = this.getBoundingClientRect();'
      + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }');
    return rect || null;
  }

  // Run a function with the element as `this`, in its own frame.
  async _callOn(node, functionDeclaration, args = []) {
    const res = await this._send('Runtime.callFunctionOn', {
      objectId: node.objectId, functionDeclaration,
      arguments: args.map(value => ({ value })), returnByValue: true, userGesture: true,
    }, node.sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'call failed');
    return res.result?.value;
  }

  async _nodeInfo(node) {
    return (await this._callOn(node, 'function() { return { tag: (this.tagName || "").toLowerCase(), type: (this.type || "") }; }')) || { tag: '', type: '' };
  }

  // `button` and `clicks` are what a context menu and a double-click need; both
  // used to be unreachable, so anything behind them went untested.
  async click(target, { button = 'left', clicks = 1 } = {}) {
    const node = await this._resolveTarget(target);
    if (!node) throw new Error(missingTarget(target));
    const pt = await this._pointFor(node);
    if (!pt) throw new Error(`${describeTarget(target)} has no clickable area on screen — snapshot again, or scroll it into view.`);
    await this.clearHover();
    await new Promise(r => setTimeout(r, 60));
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 }, node.sessionId);
    const held = button === 'right' ? 2 : (button === 'middle' ? 4 : 1);
    for (let n = 1; n <= Math.max(1, Math.min(3, Number(clicks) || 1)); n++) {
      await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button, clickCount: n, buttons: held }, node.sessionId);
      await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button, clickCount: n, buttons: 0 }, node.sessionId);
    }
    await new Promise(r => setTimeout(r, 300)); // let a click-driven nav/render begin
    return { ...pt, button, clicks: Math.max(1, Number(clicks) || 1) };
  }

  async type(target, text, submit = false) {
    const node = await this._resolveTarget(target);
    if (!node) throw new Error(missingTarget(target));
    // A native <select> cannot be typed into: clicking one opens a list the
    // page does not draw and CDP mouse events cannot walk. Choosing the option
    // is what the tester meant, so that is what typing into one does.
    const info = await this._nodeInfo(node).catch(() => ({ tag: '' }));
    if (info.tag === 'select') return this.selectOption(node, text);

    const pt = await this._pointFor(node);
    if (!pt) throw new Error(`${describeTarget(target)} has no clickable area on screen — snapshot again, or scroll it into view.`);
    // Focus by clicking, clear any existing value, then insert as real input.
    await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 }, node.sessionId);
    await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 0 }, node.sessionId);
    await this._callOn(node, 'function() { if ("value" in this) this.value = ""; else if (this.isContentEditable) this.textContent = ""; }').catch(() => {});
    await this._send('Input.insertText', { text: String(text) }, node.sessionId);
    if (submit) {
      await this.press('Enter', node.sessionId);
      await new Promise(r => setTimeout(r, 400));
    }
    return pt;
  }

  // Choose an option of a <select>: by value, then by exact label, then by a
  // contained label. Reports the options back when none of them matches, so the
  // caller can pick a real one instead of guessing again.
  async selectOption(nodeOrTarget, want) {
    const node = nodeOrTarget && typeof nodeOrTarget === 'object' && nodeOrTarget.objectId
      ? nodeOrTarget : await this._resolveTarget(nodeOrTarget);
    if (!node) throw new Error(missingTarget(nodeOrTarget));
    const out = await this._callOn(node, `function(want) {
      const w = String(want);
      const opts = Array.from(this.options || []);
      const text = (o) => (o.text || '').trim();
      const m = opts.find(o => o.value === w) || opts.find(o => text(o) === w)
        || opts.find(o => text(o).toLowerCase().includes(w.toLowerCase()));
      if (!m) return { ok: false, options: opts.map(text).slice(0, 25) };
      this.value = m.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, chosen: text(m), value: m.value };
    }`, [String(want)]);
    await new Promise(r => setTimeout(r, 200));
    return { select: true, ...(out || { ok: false, options: [] }) };
  }

  // Hovering is two different things at once. The mouse move is what a page's
  // own mouseover/mouseenter handlers listen for; the forced :hover is what
  // CSS-only menus need, and it is the only one that works in a headed window,
  // where the hover state follows the real cursor rather than a synthetic move.
  async hover(target) {
    const node = await this._resolveTarget(target);
    if (!node) throw new Error(missingTarget(target));
    const pt = await this._pointFor(node);
    if (!pt) throw new Error(`${describeTarget(target)} has no area on screen to hover — snapshot again, or scroll it into view.`);
    await this.clearHover();
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 }, node.sessionId);
    try {
      await this._ensureDom(node.sessionId);
      await this._send('CSS.enable', {}, node.sessionId).catch(() => {});
      const { nodeId } = await this._send('DOM.requestNode', { objectId: node.objectId }, node.sessionId);
      if (nodeId) {
        await this._send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] }, node.sessionId);
        this._forcedHover = { sessionId: node.sessionId, nodeId };
      }
    } catch { /* the move alone still fires the page's own handlers */ }
    await new Promise(r => setTimeout(r, 250));
    return pt;
  }

  // Let go of a forced :hover. Anything that moves on - a click, a navigation,
  // a capture for a baseline - clears it, so no screen is drawn hovered by
  // accident.
  async clearHover() {
    const held = this._forcedHover;
    if (!held) return;
    this._forcedHover = null;
    await this._send('CSS.forcePseudoState', { nodeId: held.nodeId, forcedPseudoClasses: [] }, held.sessionId).catch(() => {});
    // The pointer is still sitting on the element, and where the pointer sits
    // is the other half of :hover - so moving on means moving it off, the way
    // a person's hand does.
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1 }, held.sessionId).catch(() => {});
    await new Promise(r => setTimeout(r, 120));
  }

  // A key, optionally with modifiers ("Escape", "Tab", "Shift+Tab", "Control+a").
  // Enter was the only key that could be sent, through type(submit) - so
  // anything a keyboard user does, from dismissing a dialog to walking a
  // listbox with the arrows, could not be tested at all.
  async press(combo, sessionId = null) {
    const target = sessionId || this._sessionId;
    const parts = String(combo || '').split('+').map(s => s.trim()).filter(Boolean);
    const keyName = parts.pop() || '';
    let modifiers = 0;
    for (const m of parts) {
      const k = m.toLowerCase();
      if (k === 'alt') modifiers |= 1;
      else if (k === 'control' || k === 'ctrl') modifiers |= 2;
      else if (k === 'meta' || k === 'cmd' || k === 'command') modifiers |= 4;
      else if (k === 'shift') modifiers |= 8;
      else throw new Error(`unknown modifier "${m}" — use Alt, Control, Meta or Shift.`);
    }
    const spec = keySpec(keyName);
    if (!spec) throw new Error(`unknown key "${keyName}" — use a single character or one of: ${Object.keys(KEYS).join(', ')}.`);
    const base = { modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.code2, nativeVirtualKeyCode: spec.code2 };
    // A plain printable key also carries its text, which is what makes it type;
    // with Ctrl or Meta held it must not, or the shortcut inserts a character.
    const text = spec.text && !(modifiers & 2) && !(modifiers & 4) ? spec.text : undefined;
    await this._send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text } : {}) }, target);
    await this._send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, target);
    await new Promise(r => setTimeout(r, 200));
    return { pressed: combo };
  }

  // Put a real file into a file input. The browser's own picker is an OS window
  // nothing here can reach, so this is the only way an upload gets tested.
  async upload(target, files) {
    const node = await this._resolveTarget(target);
    if (!node) throw new Error(missingTarget(target));
    const info = await this._nodeInfo(node).catch(() => ({ tag: '', type: '' }));
    if (info.tag !== 'input' || info.type !== 'file') {
      throw new Error(`${describeTarget(target)} is a <${info.tag || '?'}>, not a file input — snapshot and pick the "file-input" row.`);
    }
    await this._ensureDom(node.sessionId);
    await this._send('DOM.setFileInputFiles', { files, objectId: node.objectId }, node.sessionId);
    await new Promise(r => setTimeout(r, 200));
    return await this._callOn(node, 'function() { return { count: this.files.length, names: Array.from(this.files).map(f => f.name) }; }');
  }

  // Wait for the page to catch up rather than guessing with a fixed pause: an
  // app that renders after a fetch was tested by sleeping and hoping.
  async waitFor({ text = '', selector = '', gone = false, timeout = 10000 } = {}) {
    const started = Date.now();
    const limit = Math.max(500, Math.min(60000, Number(timeout) || 10000));
    const expr = selector
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : `(document.body ? document.body.innerText : '').includes(${JSON.stringify(String(text))})`;
    const want = !gone;
    for (;;) {
      let seen = false;
      try { seen = Boolean(await this.evaluate(expr)); } catch { seen = false; }
      if (seen === want) return { found: true, waitedMs: Date.now() - started };
      if (Date.now() - started >= limit) return { found: false, waitedMs: Date.now() - started };
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // A viewport that stays put, so a page can be walked at phone width. Kept on
  // the instance because captureFixed overrides the metrics for its baseline
  // and has to put this back rather than clear it.
  async setViewport({ width = 1280, height = 800, mobile = false } = {}) {
    const w = Math.max(200, Math.min(4096, Math.round(Number(width) || 1280)));
    const h = Math.max(200, Math.min(4096, Math.round(Number(height) || 800)));
    this._viewport = { width: w, height: h, mobile: Boolean(mobile) };
    await this._send('Emulation.setDeviceMetricsOverride', { ...this._viewport, deviceScaleFactor: 1 }, this._sessionId);
    await this._send('Emulation.setTouchEmulationEnabled', { enabled: Boolean(mobile), maxTouchPoints: mobile ? 5 : 0 }, this._sessionId).catch(() => {});
    await new Promise(r => setTimeout(r, 250)); // the resize's layout
    return { ...this._viewport };
  }

  async clearViewport() {
    this._viewport = null;
    await this._send('Emulation.clearDeviceMetricsOverride', {}, this._sessionId).catch(() => {});
    await this._send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 }, this._sessionId).catch(() => {});
    return { reset: true };
  }

  // The open tabs, newest last, with the current one marked.
  async listTabs() {
    const out = [];
    for (let i = 0; i < this._tabs.length; i++) {
      const t = this._tabs[i];
      let info = null;
      try {
        const res = await this._send('Runtime.evaluate', { expression: '({ title: document.title, url: location.href })', returnByValue: true }, t.sessionId);
        info = res.result?.value || null;
      } catch { /* a tab mid-navigation still gets a row */ }
      out.push({ index: i, current: t.sessionId === this._sessionId, title: info?.title || '', url: info?.url || '' });
    }
    return out;
  }

  async switchTab(index) {
    const t = this._tabs[Number(index)];
    if (!t) throw new Error(`there is no tab ${index} — call browser_tabs() to list them.`);
    this._sessionId = t.sessionId;
    this._refs = [];
    return await this.evaluate('({ title: document.title, url: location.href })');
  }

  async closeTab(index) {
    const t = this._tabs[Number(index)];
    if (!t) throw new Error(`there is no tab ${index} — call browser_tabs() to list them.`);
    if (this._tabs.length === 1) throw new Error('that is the only tab — use browser_close to end the session.');
    await this._send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    this._forgetSession(t.sessionId);
    return await this.listTabs();
  }

  // How the next dialogs are answered. A confirm() guarding a delete is a real
  // path to test, and it needs Cancel as much as OK.
  setDialogPolicy({ accept = true, promptText = '' } = {}) {
    this._dialog = { accept: Boolean(accept), promptText: String(promptText || '') };
    return { ...this._dialog };
  }

  // Offline and slow connections: what a user on a train sees.
  async setNetworkCondition(condition) {
    const c = String(condition || 'normal').toLowerCase();
    const presets = {
      offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      slow: { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024 },
      normal: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    };
    if (!presets[c]) throw new Error(`unknown condition "${condition}" — use offline, slow or normal.`);
    await this._send('Network.emulateNetworkConditions', presets[c], this._sessionId);
    return { condition: c };
  }

  // Forward, the other half of back(): a tester who goes back to check
  // something then wants to carry on where they were.
  async forward() {
    const hist = await this._send('Page.getNavigationHistory', {}, this._sessionId);
    const idx = hist.currentIndex;
    let moved = false;
    if (idx < (hist.entries || []).length - 1) {
      await this._send('Page.navigateToHistoryEntry', { entryId: hist.entries[idx + 1].id }, this._sessionId);
      await new Promise(r => setTimeout(r, 600));
      moved = true;
    }
    const info = await this.evaluate('({ title: document.title, url: location.href })');
    return { ...(info || {}), moved };
  }

  // Drag one element onto another. Two different mechanisms answer to "drag":
  // HTML5 drag-and-drop, which needs real drag events, and the mousedown/
  // mousemove/mouseup that every JS drag library listens for. The HTML5 path is
  // tried first, and its own interception tells us whether the page wanted it.
  async drag(fromTarget, toTarget) {
    const from = await this._resolveTarget(fromTarget);
    const to = await this._resolveTarget(toTarget);
    if (!from) throw new Error(missingTarget(fromTarget));
    if (!to) throw new Error(missingTarget(toTarget));
    const a = await this._pointFor(from);
    const b = await this._pointFor(to);
    if (!a || !b) throw new Error('one of those elements has no area on screen — snapshot again, or scroll it into view.');
    const session = from.sessionId;

    let data = null;
    const onIntercept = (d) => { data = d; };
    this._dragWaiters.push(onIntercept);
    try {
      await this._send('Input.setInterceptDrags', { enabled: true }, session).catch(() => {});
      await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', buttons: 0 }, session);
      await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 }, session);
      // A few steps, because a single jump is not a gesture any library reads.
      for (let i = 1; i <= 4; i++) {
        const x = Math.round(a.x + ((b.x - a.x) * i) / 4);
        const y = Math.round(a.y + ((b.y - a.y) * i) / 4);
        await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, session);
        await new Promise(r => setTimeout(r, 40));
      }
      if (data) {
        // The page started an HTML5 drag: finish it as one.
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await this._send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data }, session).catch(() => {});
        }
      }
      await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 }, session);
      await new Promise(r => setTimeout(r, 300));
      return { from: a, to: b, html5: Boolean(data) };
    } finally {
      this._dragWaiters = this._dragWaiters.filter(w => w !== onIntercept);
      await this._send('Input.setInterceptDrags', { enabled: false }, session).catch(() => {});
    }
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
    await this.clearHover();
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
      // Back to whatever the caller had - a viewport set with setViewport is
      // part of the test (a phone-width run), not something a capture may drop.
      if (this._viewport) {
        await this._send('Emulation.setDeviceMetricsOverride',
          { ...this._viewport, deviceScaleFactor: 1 }, this._sessionId).catch(() => {});
      } else {
        await this._send('Emulation.clearDeviceMetricsOverride', {}, this._sessionId).catch(() => {});
      }
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
  quadArea, keySpec, KEYS, describeTarget, missingTarget,
  parseCssColor, blendOver, relativeLuminance, contrastRatio, a11yAuditScript, FOCUS_DESCRIBE_SCRIPT, analyzeFocusStops,
};
