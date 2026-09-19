'use strict';

// Where Navy keeps what it remembers about a project: its chats and undo
// history, memory, the embedding index, background-process logs and visual
// baselines. In your profile, at ~/.navy-coder/<project>-<hash>, and never in
// the project itself - so none of it can be committed, pushed, copied into a
// Docker image or zipped up with the code, whatever tool does the copying.
// (It used to live in <project>/.navy, kept out of git by a .gitignore there,
// which protects against git and nothing else.)
//
// The short hash of the project's full path keeps two projects with the same
// folder name apart. Each folder holds a project.json naming the project it
// belongs to, so a person browsing ~/.navy-coder can tell them apart too.
//
// NAVY_HOME redirects all of it, as it does the project catalog - the test
// suite points it at a temp directory so no run can touch a real profile.

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fold, foldPath } = require('./paths.js');

function navyDataHome() {
  return process.env.NAVY_HOME
    ? path.join(process.env.NAVY_HOME, '.navy-coder')
    : path.join(os.homedir(), '.navy-coder');
}

// On Windows the name is case-folded like the hash: the same project opened as
// E:\App and e:\app is one project, and has to be one folder name, not two
// spellings that only the filesystem knows are the same.
function projectDataDir(root) {
  const full = path.resolve(String(root));
  const name = fold(path.basename(full)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project';
  const hash = crypto.createHash('sha1').update(foldPath(full)).digest('hex').slice(0, 8);
  return path.join(navyDataHome(), `${name}-${hash}`);
}

module.exports = { navyDataHome, projectDataDir };
