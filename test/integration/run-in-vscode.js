// Downloads a real VS Code, installs this extension into it, and runs
// test/integration/suite.js inside it.
//
// Not part of `npm test`: it downloads ~150 MB on a cold cache and needs a
// display (xvfb on Linux CI), so making every local `npm test` pay that would
// be hostile. `npm run test:vscode` runs it on demand; CI runs it on both
// Linux and Windows alongside the fast suites.

const path = require('path');
const { pathToFileURL } = require('url');
const { runTests } = require('@vscode/test-electron');

// VS Code's integrated terminal and its extension host both export
// ELECTRON_RUN_AS_NODE=1. Inherited by the child, it makes the VS Code we just
// downloaded start as plain Node, which then rejects every VS Code flag with
// "bad option: --extensionDevelopmentPath=…" — including the ones
// @vscode/test-electron passes itself. That reads as if the flags were wrong
// rather than the environment, so it is cleared here: running the suite from
// the editor's own terminal is the normal case, not an exotic one.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        // A throwaway folder as the workspace: Navy behaves differently with
        // no folder open, and this suite is about the normal case. Passed as
        // --folder-uri rather than a bare path — a positional here is parsed
        // by Electron as the main module to require, which fails with a
        // MODULE_NOT_FOUND that says nothing about folders.
        '--folder-uri=' + pathToFileURL(path.resolve(__dirname, 'fixture')).toString(),
        // Other extensions are noise here and a source of flakes in CI.
        '--disable-extensions',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    console.error('\nIntegration run failed.');
    console.error(err?.message || err);
    process.exit(1);
  }
})();
