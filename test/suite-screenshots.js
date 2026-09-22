const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch,
} = require('./harness.js');
const { saveScreenshot, pruneScreenshots, screenshotDir, SHOT_KEEP } = require('../src/screenshots.js');
const { navyDataHome } = require('../src/data-dir.js');
const { buildExportMarkdown } = require('../src/export.js');

// A 1x1 PNG - enough to prove the bytes written are the bytes decoded.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The screenshots /playthrough takes, shown in the chat. They already went to
// the model as a vision message and stopped there, so a playthrough read as a
// list of tool names with the pictures missing.
async function screenshotsSuite() {
  console.log('\nscreenshots in the chat:');
  const os = require('os');
  const { ctrl } = sharedMock();
  const realFetch = global.fetch;
  let provider, tmp, navyDir;

  try {
    // ── On disk ──────────────────────────────────────────────────────────────
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-shots-'));
    const shot = await saveScreenshot(store, 'browser_screenshot', PNG_1X1);
    check('saved: the PNG lands in the project\'s own screenshots folder',
      shot && path.dirname(shot) === screenshotDir(store), String(shot));
    check('saved: ...as the decoded image, not the base64 text',
      fs.readFileSync(shot).equals(Buffer.from(PNG_1X1, 'base64')));
    check('saved: ...named for the moment and the tool, so the folder reads as the run',
      /^\d{4}-\d{2}-\d{2}T[\d-]+Z-browser_screenshot\.png$/.test(path.basename(shot)), path.basename(shot));
    check('saved: nothing is written without an image', (await saveScreenshot(store, 'x', '')) === null);

    // Housekeeping: a playthrough takes dozens, so the folder prunes itself.
    const dir = screenshotDir(store);
    const many = [];
    for (let i = 0; i < 8; i++) {
      const f = path.join(dir, 'old-' + i + '.png');
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, new Date(1000 + i * 1000), new Date(1000 + i * 1000)); // oldest first
      many.push(f);
    }
    await pruneScreenshots(dir, 3, shot);
    const left = fs.readdirSync(dir);
    check('kept: only the most recent survive a prune',
      left.length === 4 && left.includes(path.basename(shot)), JSON.stringify(left));
    check('kept: ...the newest ones, not an arbitrary four',
      ['old-7.png', 'old-6.png', 'old-5.png'].every(n => left.includes(n)), JSON.stringify(left));
    check('kept: ...and never the one just written', fs.existsSync(shot));
    check('kept: the default keeps a playthrough\'s worth', SHOT_KEEP >= 30);

    // ── Through a real turn ──────────────────────────────────────────────────
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-shotturn-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    const fakeWebview = {
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u) => ({ toString: () => 'vscode-webview://navy' + String(u.fsPath).split('\\').join('/') }),
      cspSource: 'test-csp',
      onDidReceiveMessage: () => ({ dispose() {} }),
    };
    await provider.resolveWebviewView({ webview: fakeWebview, onDidDispose: () => {}, onDidChangeVisibility: () => {} });
    ctrl.config.approvalMode = 'auto-approve';

    // The browser is not launched here: what this is about is the path a
    // captured image takes from the tool result to the panel and the saved chat.
    const realExecute = provider.executeTool.bind(provider);
    provider.executeTool = async (tool) => {
      if (tool.name !== 'browser_screenshot') return realExecute(tool);
      return {
        __image: { data: PNG_1X1, mediaType: 'image/png', caption: '[Screenshot from browser_screenshot — the checkout page after submit]' },
        text: '[Screenshot captured at 1280x800]',
      };
    };

    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'browser_screenshot', args: {} }] },
      { text: 'The checkout page looks right.' },
    ]);
    await provider.askNavy('take a look at the checkout page', false, null, [], []);

    const image = posted.find(m => m.type === 'toolImage');
    check('turn: the picture is posted to the chat, not only to the model', Boolean(image), JSON.stringify(posted.map(m => m.type)));
    check('turn: ...as a file the panel may load, with what the tool said about it',
      Boolean(image) && /^vscode-webview:\/\//.test(image.uri) && /checkout page after submit/.test(image.caption),
      JSON.stringify(image));
    check('turn: ...written in the profile, never in the project',
      Boolean(image) && image.file.startsWith(navyDataHome() + path.sep) && !image.file.startsWith(tmp),
      String(image && image.file));
    check('turn: ...and the base64 does not ride along in the message',
      Boolean(image) && !JSON.stringify(image).includes(PNG_1X1.slice(0, 40)));

    const turn = provider.messages[provider.messages.length - 1] || {};
    const kinds = (turn.cards || []).map(c => c.kind || c.tool);
    check('turn: the card is saved with the turn, under the tool that took it',
      JSON.stringify(kinds) === '["browser_screenshot","image"]', JSON.stringify(kinds));
    const card = (turn.cards || []).find(c => c.kind === 'image');
    check('turn: ...keeping the path rather than the image, so the chat file stays small',
      Boolean(card) && card.file === image.file && !JSON.stringify(card).includes(PNG_1X1.slice(0, 40)), JSON.stringify(card));
    navyDir = path.dirname(path.dirname(card.file));

    // ── Reopening the chat ───────────────────────────────────────────────────
    const panel = provider._messagesForPanel();
    const panelCard = (panel[panel.length - 1].cards || []).find(c => c.kind === 'image');
    check('reopened: a saved card is given a URI the panel is allowed to load',
      /^vscode-webview:\/\//.test(panelCard.uri || ''), JSON.stringify(panelCard));
    check('reopened: ...without touching what is saved', card.uri === undefined);
    fs.unlinkSync(card.file);
    const gone = provider._messagesForPanel();
    const goneCard = (gone[gone.length - 1].cards || []).find(c => c.kind === 'image');
    check('reopened: a screenshot pruned since is marked, so the card says so instead of breaking',
      goneCard.missing === true && !goneCard.uri, JSON.stringify(goneCard));

    posted.length = 0;
    provider.restoreMessages();
    const restore = posted.find(m => m.type === 'restore');
    const restored = (restore.messages[restore.messages.length - 1].cards || []).find(c => c.kind === 'image');
    check('reopened: restoring the chat sends the mapped cards, not the raw ones', restored.missing === true);

    // ── Opening one in the editor ────────────────────────────────────────────
    const inside = path.join(screenshotDir(navyDir), 'open-me.png');
    fs.writeFileSync(inside, Buffer.from(PNG_1X1, 'base64'));
    ctrl.executedCommands.length = 0;
    await provider.openImageFile(inside);
    check('open: a screenshot opens in the editor\'s image viewer',
      ctrl.executedCommands.some(c => c.command === 'vscode.open' && c.args[0]?.fsPath === inside),
      JSON.stringify(ctrl.executedCommands.map(c => c.command)));

    // The panel names the file, so it must not be able to name any file.
    const outside = path.join(tmp, 'secrets.env');
    fs.writeFileSync(outside, 'TOKEN=1');
    ctrl.executedCommands.length = 0;
    await provider.openImageFile(outside);
    await provider.openImageFile(path.join(screenshotDir(navyDir), '..', '..', '..', 'secrets.env'));
    await provider.openImageFile('');
    check('open: nothing outside the folder Navy writes to is opened, however it is spelled',
      ctrl.executedCommands.length === 0, JSON.stringify(ctrl.executedCommands.map(c => c.args?.[0]?.fsPath)));

    if (process.platform === 'win32') {
      ctrl.executedCommands.length = 0;
      await provider.openImageFile(inside.toUpperCase());
      check('open: ...and a Windows path spelled in another case is the same file',
        ctrl.executedCommands.some(c => c.command === 'vscode.open'));
    }

    ctrl.shown.info.length = 0;
    ctrl.executedCommands.length = 0;
    await provider.openImageFile(path.join(screenshotDir(navyDir), 'pruned-away.png'));
    check('open: one that was pruned says so rather than failing silently',
      ctrl.executedCommands.length === 0 && ctrl.shown.info.length === 1, JSON.stringify(ctrl.shown.info));

    // ── The export ───────────────────────────────────────────────────────────
    const md = await buildExportMarkdown({
      messages: [{
        role: 'assistant', text: 'Checked it.',
        cards: [
          { tool: 'browser_screenshot', args: {}, result: '[Screenshot captured at 1280x800]' },
          { kind: 'image', tool: 'browser_screenshot', file: path.join('C:', 'Users', 'a b', '.navy-coder', 'p', 'screenshots', 's.png'), caption: '[the checkout page]' },
        ],
      }],
    });
    check('export: a screenshot is linked from the exported chat',
      /!\[the checkout page\]\(.*screenshots\/s\.png\)/.test(md), md);
    check('export: ...with a path a Markdown viewer can follow', /a%20b/.test(md), md);
    check('export: ...and is not counted as a second tool call', /1 tool call</.test(md), md);
  } finally {
    global.fetch = realFetch;
    ctrl.config.approvalMode = 'ask-always';
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { screenshotsSuite };
