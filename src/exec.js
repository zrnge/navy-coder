// Shared facts about how Navy runs external processes.
//
// Currently just the working directory for verification/probe commands; this is
// the intended home for the rest of the spawn infrastructure (_shellSpec,
// _shellEscapeArg, _spawnOptions, _runChecker) as extension.js continues to be
// broken up.

// Verification commands (`node --check`, `python -m py_compile`, `docker info`,
// …) are deliberately run OUTSIDE the project. Running them in the project's own
// directory lets a repo-local config or shim be picked up by the tool being used
// to inspect that repo — which is code execution from the thing under
// inspection. The temp dir is stable, writable, and contains nothing of ours.
const CHECKER_CWD = require('os').tmpdir();

module.exports = { CHECKER_CWD };
