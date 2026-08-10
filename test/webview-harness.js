// Runs media/main.js inside jsdom against the REAL webview HTML, so the chat
// rendering layer can be tested the way the extension actually drives it:
// by posting the same messages over the same protocol.
//
// Everything here is the production artefact — src/webview-html.js builds the
// markup, media/main.js is loaded unmodified. Nothing is reimplemented, so a
// test passing here means the shipped file behaves that way.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { getWebviewHtml } = require('../src/webview-html.js');

function createWebview() {
  const html = getWebviewHtml({
    scriptUri: 'main.js', styleUri: 'styles.css',
    cspSource: '', nonce: 'test', version: '0.0.0-test',
  });
  // Strip the <script src> — the script is injected below instead, after the
  // vscode API shim exists.
  const doc = html.replace(/<script[^>]*src=[^>]*><\/script>/g, '');

  const dom = new JSDOM(doc, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // Messages the webview sends BACK to the extension — what the tests assert on
  // for user actions (approve, stop, copy, …).
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  // jsdom has no layout, so scrollHeight is 0 and rAF is the only thing the
  // scroll path needs; run callbacks immediately so ordering assertions don't
  // depend on frame timing.
  window.requestAnimationFrame = (cb) => { cb(0); return 0; };
  window.cancelAnimationFrame = () => {};

  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  window.eval(script);

  return {
    dom,
    window,
    document: window.document,
    sent,
    // Deliver a message exactly as the extension host does. `sessionId` is
    // added because main.js gates every message on it; the first message seen
    // establishes the baseline session, so tests need not care beyond that.
    post(message) {
      const event = new window.MessageEvent('message', { data: { sessionId: 's1', ...message } });
      window.dispatchEvent(event);
    },
    // Convenience: the chat transcript in DOM order, one entry per top-level
    // node, so ordering bugs are visible as a plain array comparison.
    transcript() {
      const out = [];
      const walk = (el, depth) => {
        for (const child of el.children) {
          const cls = child.className && String(child.className).split(' ')[0];
          if (!cls) continue;
          out.push({ cls, text: (child.textContent || '').trim().slice(0, 60), depth });
          if (/message|activity-log/.test(cls)) walk(child, depth + 1);
        }
      };
      walk(window.document.querySelector('#messages'), 0);
      return out;
    },
    // main.js arms a self-watchdog setInterval that keeps Node's event loop
    // alive forever — without this the test process renders everything
    // correctly and then simply never exits.
    close() { try { dom.window.close(); } catch {} },
    // Flat, ordered list of just the things a reader sees as "the conversation",
    // which is what card-ordering assertions care about.
    flow() {
      const nodes = [...window.document.querySelectorAll(
        '#messages .message-bubble, #messages .activity-log, #messages .term-card, '
        + '#messages .diff-card, #messages .command-card, #messages .run-project-card, '
        + '#messages .message-bg-process')];
      return nodes.map(n => {
        const c = String(n.className).split(' ')[0];
        return c === 'message-bubble' ? 'text:' + (n.textContent || '').trim().slice(0, 24) : c;
      });
    },
  };
}

module.exports = { createWebview };
