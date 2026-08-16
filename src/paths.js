// Path identity, shared by every module that compares two paths.
//
// Windows paths are case-insensitive — every path/root-identity comparison
// needs to fold case there (and nowhere else). `fold` is the bare case-fold;
// `foldPath` additionally normalizes first (mixed slash styles, redundant
// `.`/`..` segments, trailing separators), for callers comparing two real
// filesystem paths rather than an already-known-clean string. One shared pair
// instead of nine-plus independent inline copies, so a correction to either
// rule can't be applied to some call sites and missed on others.
//
// Lives here rather than in extension.js because src/projects.js needs the same
// pair, and importing it back out of extension.js would be circular.

const path = require('path');

function fold(p) { return process.platform === 'win32' ? p.toLowerCase() : p; }
function foldPath(p) { return fold(path.normalize(p)); }

module.exports = { fold, foldPath };
