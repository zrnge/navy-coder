// Builds a standalone preview of the chat panel and opens it in your browser.
//
//   node tools/preview.js            # build and open
//   node tools/preview.js --no-open  # just build, print the path
//
// The panel's look is the one thing the test suites cannot check. jsdom has no
// layout and never paints; the VS Code integration suite deliberately is not a
// rendering test. So every visual change so far has shipped verified only in
// structure — the icons in 0.2.9 among them.
//
// This uses the REAL artefacts: src/webview-html.js for the markup, the real
// icon sprite, media/styles.css unmodified, and media/main.js driven with the
// same postMessage protocol the extension uses. What you see here is what the
// panel renders, minus VS Code's own theme variables — which is why the page
// supplies a light and a dark set and lets you flip between them: the point is
// to catch a colour that only works on one theme, which is exactly the class of
// bug 0.2.8 spent itself on.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { getWebviewHtml } = require(path.join(ROOT, 'src', 'webview-html.js'));

// A conversation that exercises the things worth looking at: every slash-menu
// icon, both message roles, a diff card, a terminal card, an activity log, a
// queued prompt with its Cancel button, and the markdown shapes that have been
// buggy — snake_case, globs, numbered steps around a code block, a table.
const SCRIPT = [
  { type: 'restore', messages: [
    { role: 'user', text: 'Refactor read_file and write_file, then delete *.log files' },
    { role: 'assistant', text: [
      'Here is the plan.',
      '',
      '1. Read `src/app_main.js` and check `MAX_RETRIES`',
      '   ```js',
      '   const MAX_RETRIES = 5;',
      '   if (count > MAX_RETRIES) throw new Error("give_up");',
      '   ```',
      '2. Delete *.log and **/*.tmp files',
      '3. Override __init__ and __repr__ in my_class.py',
      '',
      '| file | change |',
      '|------|--------|',
      '| `app_main.js` | edited |',
      '| `util_b.js` | created |',
      '',
      'See [the wiki](https://en.wikipedia.org/wiki/Foo_(bar)) for background.',
      '',
      '**Done:** two files changed. *Nothing else* was touched.',
    ].join('\n') },
  ] },
  { type: 'start' },
  { type: 'toolCall', tool: 'read_file', args: { path: 'src/app_main.js' }, callId: 'c1' },
  { type: 'toolResult', tool: 'read_file', result: 'ok, 240 lines', callId: 'c1' },
  { type: 'toolCall', tool: 'run_command', args: { command: 'npm test -- --grep "a_b"' }, callId: 'c2' },
  { type: 'toolResult', tool: 'run_command', result: 'Exit code: 0\n1194 passed', callId: 'c2' },
  { type: 'chunk', text: 'Tests pass. Applying the edit now.' },
  { type: 'pendingDiff', id: 'd1', path: 'src/app_main.js',
    oldText: 'const MAX_RETRIES = 3;\nconst DELAY = 100;\n',
    newText: 'const MAX_RETRIES = 5;\nconst DELAY = 100;\n' },
  { type: 'done' },
  // Left running on purpose: this is what puts the task dock on screen, which
  // is the whole point of looking at a preview rather than reading a test.
  { type: 'runProjectStart', projectName: 'Vidz', command: 'npm run dev' },
  { type: 'runProjectReady', url: 'http://localhost:5173/Vidz/' },
  { type: 'bgProcessOutput', id: 'tsc-watch', chunk: 'Watching for file changes.\n' },
];

function build() {
  const html = getWebviewHtml({
    scriptUri: '', styleUri: '', cspSource: '', nonce: 'preview',
    version: require(path.join(ROOT, 'package.json')).version,
  });
  const css = fs.readFileSync(path.join(ROOT, 'media', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');

  // VS Code supplies these; a plain browser does not. Both palettes are here so
  // a theme-only bug has somewhere to show itself.
  const THEMES = `
    :root, [data-preview-theme="dark"] {
      --vscode-font-family: system-ui, sans-serif;
      --vscode-editor-font-family: ui-monospace, Consolas, monospace;
      --vscode-editor-background: #1e1e1e;
      --vscode-editor-foreground: #d4d4d4;
      --vscode-foreground: #cccccc;
      --vscode-descriptionForeground: #9d9d9d;
      --vscode-panel-border: #3c3c3c;
      --vscode-textLink-foreground: #4daafc;
      --vscode-button-background: #0e639c;
      --vscode-button-foreground: #ffffff;
      --vscode-input-background: #3c3c3c;
      --vscode-input-foreground: #cccccc;
      --vscode-inputValidation-errorBackground: #5a1d1d;
      --vscode-sideBar-background: #252526;
      color-scheme: dark;
    }
    [data-preview-theme="light"] {
      --vscode-editor-background: #ffffff;
      --vscode-editor-foreground: #3b3b3b;
      --vscode-foreground: #3b3b3b;
      --vscode-descriptionForeground: #616161;
      --vscode-panel-border: #e5e5e5;
      --vscode-textLink-foreground: #005fb8;
      --vscode-button-background: #005fb8;
      --vscode-button-foreground: #ffffff;
      --vscode-input-background: #ffffff;
      --vscode-input-foreground: #3b3b3b;
      --vscode-inputValidation-errorBackground: #fdd;
      --vscode-sideBar-background: #f8f8f8;
      color-scheme: light;
    }
    .preview-bar {
      position: fixed; z-index: 99999; top: 0; right: 0;
      display: flex; gap: 8px; align-items: center;
      padding: 6px 10px; font: 12px system-ui, sans-serif;
      background: #000; color: #fff; border-bottom-left-radius: 6px; opacity: .85;
    }
    .preview-bar button { font: inherit; cursor: pointer; padding: 2px 8px; }
  `;

  // No inline onclick: the shell's CSP is nonce-based, and an inline event
  // handler needs 'unsafe-inline' — so these buttons would simply not respond.
  // Wired in the driver script below, which does carry the nonce.
  const BAR = `
    <div class="preview-bar">
      <span>Navy panel preview</span>
      <button type="button" id="previewDark">Dark</button>
      <button type="button" id="previewLight">Light</button>
      <span id="previewWidth"></span>
    </div>`;

  // Stand in for the host: collect what the webview posts, and replay the
  // scripted conversation once main.js has wired itself up.
  const DRIVER = `
    window.acquireVsCodeApi = () => ({ postMessage: (m) => console.log('[to extension]', m),
                                       getState: () => undefined, setState: () => {} });
    window.addEventListener('DOMContentLoaded', () => {
      const send = (m) => window.dispatchEvent(new MessageEvent('message', { data: { sessionId: 'preview', ...m } }));
      const script = ${JSON.stringify(SCRIPT)};
      let i = 0;
      const step = () => { if (i < script.length) { send(script[i++]); setTimeout(step, 40); } };
      setTimeout(step, 60);
      const setTheme = (t) => document.documentElement.setAttribute('data-preview-theme', t);
      document.querySelector('#previewDark')?.addEventListener('click', () => setTheme('dark'));
      document.querySelector('#previewLight')?.addEventListener('click', () => setTheme('light'));
      const w = document.querySelector('#previewWidth');
      const report = () => { if (w) w.textContent = window.innerWidth + 'px wide'; };
      window.addEventListener('resize', report); report();
    });
  `;

  // Function replacers, not strings: a replacement STRING gives `$&`, `$'` and
  // `` $` `` special meaning, and main.js contains a literal `$'` (in
  // "· ≈$" + shown). As a plain replacement that sequence expanded to the rest
  // of the document and produced a file whose script ended mid-string.
  // Every injected script carries the page's nonce. The shell's CSP is
  // `script-src 'nonce-preview'`, so a bare <script> is refused outright — and
  // jsdom does not enforce CSP, which is exactly why a preview verified there
  // still opened as an inert page with no JavaScript at all in a real browser.
  // The empty `<script src="">` from the shell goes too: with no scriptUri it
  // asks the browser to execute the HTML document as a script.
  const out = html
    .replace(/<script[^>]*src=""[^>]*><\/script>/g, () => '')
    .replace('</head>', () => `<style>${THEMES}</style><style>${css}</style></head>`)
    .replace('<body>', () => `<body>${BAR}`)
    .replace('</body>', () =>
      `<script nonce="preview">${DRIVER}</script><script nonce="preview">${js}</script></body>`);

  const dest = path.join(ROOT, 'panel-preview.html');
  fs.writeFileSync(dest, out);
  return dest;
}

const dest = build();
console.log('wrote ' + path.relative(ROOT, dest) + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
console.log('Narrow the window to a sidebar width — most layout bugs only appear there.');

if (!process.argv.includes('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', dest]]
    : process.platform === 'darwin' ? ['open', [dest]]
      : ['xdg-open', [dest]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
  catch { console.log('Open it yourself: ' + dest); }
}
