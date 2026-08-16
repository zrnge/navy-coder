// The in-editor suite. Runs INSIDE a real VS Code instance with Navy loaded,
// which is the one thing the other two suites structurally cannot do:
// test/run.js drives the provider against a mock `vscode`, and
// test/webview-run.js drives the webview through jsdom. Both can pass while the
// extension fails to activate at all — a fatal error in activation, a command
// declared in package.json with no handler behind it, a setting whose id was
// mistyped in one place and not the other.
//
// Deliberately not a rendering test. jsdom already covers the webview's logic,
// and asserting on pixels here would be slow and flaky for very little. What
// this covers is the contract between package.json and the code: does the thing
// start, and is everything it advertises actually there.
//
// No test framework: `run()` is what @vscode/test-electron calls, and the same
// hand-rolled check() the rest of the suite uses is enough.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const EXT_ID = 'Zrnge.navy-coder';

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function run() {
  console.log('\nreal VS Code integration:');

  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

  // 1. Does it load and start at all? Everything else is meaningless if not,
  // and an activation throw is invisible to every other suite we have.
  const ext = vscode.extensions.getExtension(EXT_ID);
  check('the extension is installed in the test instance', Boolean(ext), EXT_ID);
  if (!ext) return report();

  let activationError = null;
  try { await ext.activate(); } catch (err) { activationError = err; }
  check('activate() completes without throwing',
    activationError === null, activationError && (activationError.stack || activationError.message));
  check('the extension reports itself active', ext.isActive === true);

  // 2. Every command the manifest advertises must have a handler behind it.
  // The Command Palette lists them from package.json alone, so a missing
  // registration is a menu entry that errors when clicked — and nothing in the
  // repository could catch that before this suite existed.
  const registered = new Set(await vscode.commands.getCommands(true));
  const declared = manifest.contributes.commands.map(c => c.command);
  const unregistered = declared.filter(c => !registered.has(c));
  check(`all ${declared.length} declared commands are registered`,
    unregistered.length === 0, unregistered.join(', '));

  // …and the reverse: a command registered under the navy. prefix but never
  // declared is unreachable from the palette, which is usually a mistake.
  //
  // Two things are legitimately absent from the manifest and must not fail
  // this. VS Code generates a family of commands for every contributed view
  // (navy.chatView.focus, .open, .resetViewLocation, …) — those are the
  // editor's, not ours. And navy.fixDiagnostic is invoked from a quick-fix, so
  // listing it in the palette would offer an action with no diagnostic to
  // apply it to.
  const viewIds = Object.values(manifest.contributes.views || {}).flat().map(v => v.id);
  const PALETTE_EXEMPT = new Set(['navy.fixDiagnostic']);
  const undeclared = [...registered].filter(c =>
    c.startsWith('navy.')
    && !declared.includes(c)
    && !PALETTE_EXEMPT.has(c)
    && !viewIds.some(id => c.startsWith(id + '.')));
  check('no navy.* command is registered but hidden from the palette',
    undeclared.length === 0, undeclared.join(', '));

  // 3. Every declared setting must actually resolve, with the declared default.
  // Catches an id typed one way in package.json and another at the call site —
  // which reads at runtime as "the setting does nothing".
  const cfg = vscode.workspace.getConfiguration();
  const settings = Object.keys(manifest.contributes.configuration.properties);
  const unresolved = settings.filter(key => cfg.inspect(key) === undefined);
  check(`all ${settings.length} declared settings resolve`,
    unresolved.length === 0, unresolved.join(', '));

  const wrongDefaults = settings.filter((key) => {
    const declaredDefault = manifest.contributes.configuration.properties[key].default;
    if (declaredDefault === undefined) return false;
    const live = cfg.inspect(key)?.defaultValue;
    return JSON.stringify(live) !== JSON.stringify(declaredDefault);
  });
  check('every setting\'s live default matches the manifest',
    wrongDefaults.length === 0, wrongDefaults.join(', '));

  // 4. The view container the whole UI hangs off. If this id ever drifts from
  // the manifest, Navy loads and then simply has nowhere to appear.
  const viewId = manifest.contributes.views?.[Object.keys(manifest.contributes.views)[0]]?.[0]?.id;
  check('the manifest declares a view for the panel', Boolean(viewId), String(viewId));
  if (viewId) {
    let focusError = null;
    try { await vscode.commands.executeCommand(viewId + '.focus'); }
    catch (err) { focusError = err; }
    check('the panel view can be focused', focusError === null,
      focusError && (focusError.message || String(focusError)));
  }

  // 5. A command that runs entirely locally, executed for real. Chosen because
  // it touches no provider and no network, so it exercises the command path
  // end-to-end without needing a key or being flaky.
  let clearError = null;
  try { await vscode.commands.executeCommand('navy.clearChat'); }
  catch (err) { clearError = err; }
  check('a real command executes end-to-end', clearError === null,
    clearError && (clearError.message || String(clearError)));

  return report();
}

function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    throw new Error('Integration failures:\n  - ' + failures.join('\n  - '));
  }
}

module.exports = { run };
