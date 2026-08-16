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

function createWebview(options = {}) {
  const html = getWebviewHtml({
    scriptUri: 'main.js', styleUri: 'styles.css',
    cspSource: '', nonce: 'test', version: '0.0.0-test',
  });
  // Strip the <script src> — the script is injected below instead, after the
  // vscode API shim exists.
  const doc = html.replace(/<script[^>]*src=[^>]*><\/script>/g, '');

  const dom = new JSDOM(doc, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom implements neither Web Speech API, and main.js feature-detects both
  // at load time — so a test for read-aloud or dictation has to install the
  // stubs BEFORE the script runs. Opting in per test keeps the default
  // environment honest: with `speech` off, the code must behave exactly as it
  // does in a renderer that lacks these APIs.
  // A Windows 11 machine's real list, in the order Chromium reports it — the
  // old SAPI5 voices first, which is exactly why taking getVoices()[0] sounded
  // the way it did, and a natural voice further down that ranking should find.
  // Tests may pass their own list (or an empty one) via `options.voices`.
  const DEFAULT_VOICES = [
    { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US', localService: true, default: true },
    { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US', localService: true },
    { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB', localService: true },
    { name: 'Microsoft Ava Online (Natural) - English (United States)', lang: 'en-US', localService: false },
    { name: 'Microsoft Denise - French (France)', lang: 'fr-FR', localService: true },
  ];
  const speech = { spoken: [], cancelled: 0, recognizers: [], utterances: [] };
  if (options.speech) {
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; }
    };
    speech.voices = options.voices || DEFAULT_VOICES;
    window.speechSynthesis = {
      speak: (u) => { speech.spoken.push(u.text); speech.utterances.push(u); speech.lastUtterance = u; },
      cancel: () => { speech.cancelled++; },
      getVoices: () => speech.voices,
      addEventListener: () => {},
    };
    window.SpeechRecognition = class {
      constructor() {
        this.started = 0; this.stopped = 0;
        speech.recognizers.push(this);
        speech.recognition = this;
      }
      start() { this.started++; }
      stop() { this.stopped++; }
      // Test helpers — drive the callbacks the real engine would fire.
      say(transcript, isFinal = true) {
        this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { 0: { transcript }, isFinal, length: 1 })] });
      }
      fail(error) { this.onerror?.({ error }); }
      end() { this.onend?.(); }
    };
  }

  // Permissions Policy. jsdom has no `document.featurePolicy`, which stands in
  // for the "can't tell" case; passing `micPolicy: false` reproduces the real
  // VS Code webview, whose iframe is built without `microphone` in its `allow`
  // list. Set before eval because main.js pre-flights the policy at load.
  if (options.micPolicy !== undefined) {
    Object.defineProperty(window.document, 'featurePolicy', {
      configurable: true,
      value: { allowsFeature: (feature) => feature !== 'microphone' || options.micPolicy },
    });
  }

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
    speech,
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
