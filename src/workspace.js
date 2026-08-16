// Workspace-trust predicate, shared by every module that gates on it.
//
// package.json declares untrustedWorkspaces.supported = false, so VS Code should
// never activate Navy in a restricted window. This is the belt-and-braces check
// for the paths that spawn processes or upload file contents: trust can be
// revoked while a session is live, and a manifest flag is not a runtime guard.
// Defaults to trusted when the API is unavailable (older VS Code) rather than
// bricking the extension.
//
// Lives in its own module because both extension.js and src/retrieval.js need
// it, and importing it back out of extension.js would be circular.

const vscode = require('vscode');

function workspaceIsTrusted() {
  return vscode.workspace.isTrusted !== false;
}

module.exports = { workspaceIsTrusted };
