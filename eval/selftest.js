// Checker self-test — validates the eval checkers WITHOUT calling any model.
//
// A buggy checker silently corrupts every score it touches: one that can never
// pass makes a good model look broken, one that can never fail makes a bad model
// look fine. This simulates the ideal outcome for each task (and, where it's
// cheap to express, a wrong outcome) and asserts the checker reacts correctly.
//
//   node eval/selftest.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TASKS } = require('./tasks.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failures.push(name); console.error('  FAIL', name, detail !== undefined ? '— ' + detail : ''); }
}

// Reuse the runner's real context builder so the self-test exercises the same
// helpers the scoring path uses, not a re-implementation that could drift.
const runner = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
function extract(name) {
  const start = runner.indexOf('function ' + name);
  if (start === -1) throw new Error('cannot find ' + name + ' in run.js');
  let depth = 0;
  for (let j = runner.indexOf('{', start); j < runner.length; j++) {
    if (runner[j] === '{') depth++;
    else if (runner[j] === '}') { depth--; if (depth === 0) return runner.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}
const deps = [extract('listFilesRec'), extract('runNodeIn'), extract('makeCheckContext')].join('\n');
const makeCheckContext = new Function('fs', 'path', 'os', 'spawn',
  deps + '\nreturn makeCheckContext;'
)(fs, path, os, require('child_process').spawn);

function seedRepo(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-selftest-'));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const W = (dir, rel, content) => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

// For each task: `solve` mutates the repo into the ideal end state (checker must
// PASS), `breakIt` into a plausible wrong state (checker must FAIL).
const SCENARIOS = {
  'write-basic': {
    solve: (d) => W(d, 'math.js', 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n'),
    breakIt: () => {}, // file never created — the hallucinated-edit failure mode
  },
  'edit-actually-lands': {
    solve: (d) => W(d, 'index.html', fs.readFileSync(path.join(d, 'index.html'), 'utf8').replace('Hello World!', 'Hello Job!')),
    breakIt: () => {},
  },
  'edit-scope-single-constant': {
    solve: (d) => W(d, 'config.js', fs.readFileSync(path.join(d, 'config.js'), 'utf8').replace('MAX_RETRIES = 3', 'MAX_RETRIES = 5')),
    // Correct value, but the whole file was rewritten — exactly the over-broad
    // edit this task exists to catch.
    breakIt: (d) => W(d, 'config.js', 'const MAX_RETRIES = 5;\nmodule.exports = { MAX_RETRIES };\n'),
  },
  'no-collateral-damage': {
    solve: (d) => W(d, 'alpha.js', '// entry point\n' + fs.readFileSync(path.join(d, 'alpha.js'), 'utf8')),
    breakIt: (d) => { W(d, 'alpha.js', '// entry point\n' + fs.readFileSync(path.join(d, 'alpha.js'), 'utf8')); W(d, 'beta.js', '// meddled\n'); },
  },
  'append-preserves-existing': {
    solve: (d) => W(d, 'utils.js', 'function add(a,b){return a+b;}\nfunction multiply(a,b){return a*b;}\nfunction subtract(a,b){return a-b;}\nmodule.exports={add,multiply,subtract};\n'),
    breakIt: (d) => W(d, 'utils.js', 'function subtract(a,b){return a-b;}\nmodule.exports={subtract};\n'),
  },
  'fix-off-by-one': {
    solve: (d) => W(d, 'sum.js', 'function sumTo(n){let t=0;for(let i=1;i<=n;i++)t+=i;return t;}\nmodule.exports=sumTo;\n'),
    breakIt: () => {},
  },
  'fix-crash-null-guard': {
    solve: (d) => W(d, 'greet.js', 'function greet(name){if(name==null)return "Hello, guest!";return "Hello, "+name.trim()+"!";}\nmodule.exports=greet;\n'),
    // Handles null but silently breaks the existing trim behaviour.
    breakIt: (d) => W(d, 'greet.js', 'function greet(name){if(name==null)return "Hello, guest!";return "Hello, "+name+"!";}\nmodule.exports=greet;\n'),
  },
  'fix-async-missing-await': {
    solve: (d) => W(d, 'loader.js', 'function fetchValue(){return Promise.resolve(42);}\nasync function main(){const v=await fetchValue();console.log(v);}\nmain();\n'),
    breakIt: () => {},
  },
  'multi-file-rename-consistency': {
    solve: (d) => {
      W(d, 'user.js', 'function fetchUser(id){return {id:id,name:"user"+id};}\nmodule.exports={fetchUser};\n');
      W(d, 'app.js', 'const {fetchUser}=require("./user.js");\nfunction run(){const u=fetchUser(7);return u.name;}\nmodule.exports=run;\n');
    },
    // Renamed the definition but not the call site — the classic half-rename.
    breakIt: (d) => W(d, 'user.js', 'function fetchUser(id){return {id:id,name:"user"+id};}\nmodule.exports={fetchUser};\n'),
  },
  'json-stays-valid': {
    solve: (d) => {
      const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      p.scripts.lint = 'eslint .';
      W(d, 'package.json', JSON.stringify(p, null, 2) + '\n');
    },
    // Added the script but dropped everything else — data loss disguised as success.
    breakIt: (d) => W(d, 'package.json', JSON.stringify({ name: 'demo-app', scripts: { lint: 'eslint .' } }, null, 2)),
  },
  'json-nested-edit': {
    solve: (d) => {
      const t = JSON.parse(fs.readFileSync(path.join(d, 'tsconfig.json'), 'utf8'));
      t.compilerOptions.strict = true;
      W(d, 'tsconfig.json', JSON.stringify(t, null, 2) + '\n');
    },
    breakIt: (d) => W(d, 'tsconfig.json', '{ "compilerOptions": { "strict": true, '), // corrupt JSON
  },
  'retrieval-among-decoys': {
    solve: (d) => W(d, 'src/validation.js', '// validated per RFC 5322\n' + fs.readFileSync(path.join(d, 'src/validation.js'), 'utf8')),
    breakIt: (d) => W(d, 'src/router.js', '// validated per RFC 5322\n' + fs.readFileSync(path.join(d, 'src/router.js'), 'utf8')),
  },
  'retrieval-semantic-no-keyword': {
    solve: (d) => W(d, 'store.js', '// session persistence\n' + fs.readFileSync(path.join(d, 'store.js'), 'utf8')),
    breakIt: (d) => W(d, 'math.js', '// session persistence\n' + fs.readFileSync(path.join(d, 'math.js'), 'utf8')),
  },
  'scope-discipline-no-extra-files': {
    solve: (d) => W(d, 'numbers.js', 'function isOdd(n){return n%2!==0;}\nfunction isEven(n){return n%2===0;}\nmodule.exports={isOdd,isEven};\n'),
    // Correct code, but created the test file it was explicitly told not to.
    breakIt: (d) => {
      W(d, 'numbers.js', 'function isOdd(n){return n%2!==0;}\nfunction isEven(n){return n%2===0;}\nmodule.exports={isOdd,isEven};\n');
      W(d, 'numbers.test.js', 'test stub');
    },
  },
  'question-only-no-edits': {
    solve: () => {},                                     // correct behaviour is doing nothing
    breakIt: (d) => W(d, 'dates.js', '// rewritten\n'),
    reply: 'It parses a YYYY-MM-DD string into a Date.',
  },
  'exact-string-requested': {
    solve: (d) => W(d, 'banner.js', 'const VERSION="2.0.0-rc.1";\nconst NAME="banner";\nmodule.exports={VERSION,NAME};\n'),
    breakIt: (d) => W(d, 'banner.js', 'const VERSION="2.0.0";\nconst NAME="banner";\nmodule.exports={VERSION,NAME};\n'),
  },
  'no-unrequested-deletion': {
    solve: (d) => W(d, 'new.js', '// current implementation\n' + fs.readFileSync(path.join(d, 'new.js'), 'utf8')),
    breakIt: (d) => {
      W(d, 'new.js', '// current implementation\n' + fs.readFileSync(path.join(d, 'new.js'), 'utf8'));
      fs.rmSync(path.join(d, 'old.js'));
    },
  },
  'preserve-unrelated-data': {
    solve: (d) => {
      const s = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));
      s.theme = 'dark';
      W(d, 'settings.json', JSON.stringify(s, null, 2) + '\n');
    },
    breakIt: (d) => W(d, 'settings.json', JSON.stringify({ theme: 'dark' }, null, 2)),
  },
  'stays-parseable-after-edit': {
    solve: (d) => W(d, 'deep.js', 'class Counter{constructor(){this.count=0;}increment(){this.count+=1;return this.count;}double(){this.count*=2;return this.count;}reset(){this.count=0;return this.count;}}\nmodule.exports=Counter;\n'),
    breakIt: (d) => W(d, 'deep.js', 'class Counter{constructor(){this.count=0;}reset(){this.count=0;}}\nmodule.exports=Counter;\n'),
  },
  'nested-structure-edit': {
    solve: (d) => W(d, 'routes.js', 'const routes={"/":function(){return "home";},"/about":function(){return "about";},"/contact":function(){return "contact";},"/health":function(){return "ok";}};\nfunction handle(p){const f=routes[p];return f?f():"404";}\nmodule.exports={handle,routes};\n'),
    breakIt: (d) => W(d, 'routes.js', 'const routes={"/health":function(){return "ok";}};\nfunction handle(p){const f=routes[p];return f?f():"404";}\nmodule.exports={handle,routes};\n'),
  },
  'must-read-to-answer': {
    solve: () => {},
    reply: 'The value of SECRET_TIMEOUT is 8471.',
    breakIt: () => {},
    breakReply: 'It looks like a standard 3000ms timeout.',
  },
  'no-invented-content': {
    solve: () => {},
    reply: 'alpha, gamma',
    breakIt: () => {},
    breakReply: 'alpha, beta, gamma',
  },
};

async function main() {
  console.log('\neval checker self-test (no model calls):\n');

  // Every task must have a scenario, or it silently goes unvalidated.
  const missing = TASKS.filter(t => !SCENARIOS[t.id]).map(t => t.id);
  check('every task has a self-test scenario', missing.length === 0, missing.join(', '));

  for (const task of TASKS) {
    const sc = SCENARIOS[task.id];
    if (!sc) continue;

    // Ideal outcome → checker must PASS.
    let dir = seedRepo(task);
    try {
      await sc.solve(dir);
      const ctx = makeCheckContext(dir, task, sc.reply || '');
      const v = await task.check(ctx);
      check(`${task.id}: passes on a correct outcome`, v.pass === true, v.reason);
    } catch (e) {
      check(`${task.id}: passes on a correct outcome`, false, 'checker threw: ' + e.message);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    // Wrong outcome → checker must FAIL (otherwise it can never detect anything).
    if (!sc.breakIt) continue;
    dir = seedRepo(task);
    try {
      await sc.breakIt(dir);
      const ctx = makeCheckContext(dir, task, sc.breakReply !== undefined ? sc.breakReply : '');
      const v = await task.check(ctx);
      check(`${task.id}: fails on a wrong outcome`, v.pass === false, 'checker passed a bad outcome — it cannot detect failure');
    } catch (e) {
      check(`${task.id}: fails on a wrong outcome`, false, 'checker threw: ' + e.message);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
