#!/usr/bin/env node
'use strict';

// Opens an Extension Development Host for Navy, paused on its first line with
// the extension-host inspector on 127.0.0.1:<port>, and exits at once. The
// "Run Extension" configuration runs this as its preLaunchTask and then
// attaches to that address - see the top of .vscode/launch.json for why the
// debugger is not left to launch the host itself.
//
//   node tools/dev-host.js <path to Code.exe> <workspace folder> [port] [extra Code args...]
//
// The window is started detached: Code.exe launched straight from a task
// stays tied to the task, the task never finishes, and the attach waiting on it
// never starts. NAVY_DEV_HOST_ARGS adds arguments too (space-separated), for
// a --profile or --user-data-dir of your own.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const [, , codeExe, workspace, portArg = '9333', ...extra] = process.argv;
const port = Number(portArg);

function fail(message) {
  console.error('navy dev host: ' + message);
  process.exit(1);
}

if (!codeExe || !fs.existsSync(codeExe)) fail(`VS Code was not found at "${codeExe || ''}".`);
if (!workspace || !fs.existsSync(workspace)) fail(`the workspace "${workspace || ''}" does not exist.`);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`"${portArg}" is not a usable port.`);

// A port already answering means an earlier Development Host is still open on
// it - and the attach would reach that one, not the host about to start. Say
// so rather than let F5 silently debug a stale window.
const probe = net.connect({ host: '127.0.0.1', port });
probe.setTimeout(1500);
probe.once('connect', () => {
  probe.destroy();
  fail(`something is already listening on 127.0.0.1:${port} - most likely a Development Host from an earlier run. Close that window and press F5 again.`);
});
probe.once('timeout', () => { probe.destroy(); launch(); });
probe.once('error', () => launch());

function launch() {
  // A task's terminal can carry the variables that make Code.exe start as
  // plain Node (ELECTRON_RUN_AS_NODE) or talk to the wrong instance; the
  // window this opens needs neither.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('VSCODE_')));
  const more = String(process.env.NAVY_DEV_HOST_ARGS || '').split(/\s+/).filter(Boolean);
  const child = spawn(codeExe, [
    `--extensionDevelopmentPath=${workspace}`,
    `--inspect-brk-extensions=${port}`,
    '--new-window',
    ...extra, ...more,
  ], { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.on('error', (e) => fail('could not start VS Code: ' + e.message));
  child.unref();
  console.log(`navy dev host: starting, paused on 127.0.0.1:${port}. The debugger attaches next.`);
  // Give spawn a moment to report a launch failure before this exits.
  setTimeout(() => process.exit(0), 300);
}
