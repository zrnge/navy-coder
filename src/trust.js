// ── Workspace-trust refusals ─────────────────────────────────────────────────
// The one sentence Navy says when an untrusted workspace blocks a tool, in one
// place so every tool refuses in the same words.
//
// Its own module because both extension.js and commands.js need it: run_tests
// stayed behind while run_project and start_process moved, and importing it
// back out of extension.js would be circular.

// Manifest support is "limited", not false: declaring false leaves the view
// container contributed but the extension never activates, so the panel renders
// as an empty box with no explanation — which reads as a crash. Navy stays
// usable for reading and answering; only the operations that would execute
// code from, or upload code out of, an untrusted folder are refused here.
const UNTRUSTED_REFUSAL = (what) =>
  `Refused: this workspace is not trusted, so Navy will not ${what} in it. `
  + `Tell the user to trust the folder (Workspaces: Manage Workspace Trust) if they want this. `
  + `Reading files and answering questions still work — do not retry this tool.`;

module.exports = { UNTRUSTED_REFUSAL };
