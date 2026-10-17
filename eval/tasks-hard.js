// Navy eval — the hard tier.
//
//   npm run eval -- --suite hard --model <name>
//
// The core suite (tasks.js) encodes failure modes seen in the wild, and a
// strong model passes nearly all of it: deepseek-v4.1-flash scored 32/34,
// every debugging task included. That makes it good at catching regressions
// and useless for telling whether a change made Navy any smarter.
//
// These are small multi-file projects where the work is understanding, not
// typing: a cause in a different file from the symptom, a convention to
// follow, a vague report, a spec to read, a fix that must not break a sibling
// module. Every checker runs the project's own tests AND cases those tests do
// not show, so a patch fitted to the visible test fails.
//
// Each task carries its own self-test (eval/selftest.js): the seed as given
// must FAIL its checker, `solve` must PASS, `breakIt` — a plausible wrong fix
// — must FAIL.

const L = (...lines) => lines.join('\n') + '\n';

// Runs the repo's test file, then a probe printing JSON, and compares.
async function testsThenProbe(c, { tests = 'test.js', testsUnchanged = true, probe, expect, what }) {
  if (testsUnchanged && !c.unchanged(tests)) return { pass: false, reason: tests + ' was edited' };
  const t = await c.runNode(tests);
  if (!t.ok) return { pass: false, reason: `node ${tests} fails: ` + (t.stdout + t.stderr).replace(/\s+/g, ' ').slice(-200) };
  const r = await c.runNode('__probe.js', probe);
  if (!r.ok) return { pass: false, reason: 'hidden cases crashed: ' + r.stderr.slice(0, 200) };
  const got = r.stdout.trim();
  const want = JSON.stringify(expect);
  if (got !== want) return { pass: false, reason: `hidden cases: expected ${want.slice(0, 160)}, got ${got.slice(0, 160)}` };
  return { pass: true, reason: what };
}

// A tiny test runner each project's test.js uses, so failures print their name.
const RUNNER = L(
  "const assert = require('assert');",
  'let failed = 0;',
  'const t = (name, fn, setup) => { if (setup) setup(); try { fn(); console.log("ok   " + name); } catch (e) { failed++; console.log("FAIL " + name + ": " + e.message); } };',
  'const done = () => { if (failed) { console.log(failed + " failing"); process.exit(1); } console.log("all tests passed"); };',
);

const HARD_TASKS = [
  // ── A failed order leaks the stock it had already reserved ───────────────
  {
    id: 'hard-inventory-rollback',
    category: 'hard',
    prompt: 'Support says that after an order fails, stock counts are wrong. `node test.js` shows one case. Find the cause and fix it properly — do not change test.js.',
    files: {
      'store.js': L(
        'const stock = new Map();',
        'function setStock(sku, n) { stock.set(sku, n); }',
        'function getStock(sku) { return stock.get(sku) ?? 0; }',
        'function adjust(sku, delta) { stock.set(sku, getStock(sku) + delta); }',
        'function reset() { stock.clear(); }',
        'module.exports = { setStock, getStock, adjust, reset };',
      ),
      'inventory.js': L(
        "const store = require('./store');",
        '',
        'class OutOfStock extends Error {',
        "  constructor(sku) { super('Out of stock: ' + sku); this.sku = sku; }",
        '}',
        '',
        'function reserve(sku, qty) {',
        '  if (store.getStock(sku) < qty) throw new OutOfStock(sku);',
        '  store.adjust(sku, -qty);',
        '}',
        '',
        'function release(sku, qty) {',
        '  store.adjust(sku, qty);',
        '}',
        '',
        'module.exports = { reserve, release, OutOfStock };',
      ),
      'orders.js': L(
        "const { reserve } = require('./inventory');",
        '',
        'const orders = new Map();',
        'let nextId = 1;',
        '',
        '// Places an order for several lines ({ sku, qty }); throws OutOfStock if',
        '// any line cannot be filled.',
        'function placeOrder(lines) {',
        '  for (const line of lines) reserve(line.sku, line.qty);',
        '  const id = nextId++;',
        "  orders.set(id, { id, lines, status: 'placed' });",
        '  return id;',
        '}',
        '',
        'module.exports = { placeOrder, getOrder: (id) => orders.get(id) };',
      ),
      'test.js': RUNNER + L(
        "const store = require('./store');",
        "const { placeOrder } = require('./orders');",
        "const { OutOfStock } = require('./inventory');",
        "t('an order reserves its stock', () => {",
        "  placeOrder([{ sku: 'apple', qty: 2 }, { sku: 'pear', qty: 1 }]);",
        "  assert.strictEqual(store.getStock('apple'), 3);",
        "  assert.strictEqual(store.getStock('pear'), 4);",
        "}, () => { store.reset(); store.setStock('apple', 5); store.setStock('pear', 5); });",
        "t('a failed order leaves stock as it was', () => {",
        "  assert.throws(() => placeOrder([{ sku: 'apple', qty: 2 }, { sku: 'pear', qty: 1 }]), OutOfStock);",
        "  assert.strictEqual(store.getStock('apple'), 5);",
        "}, () => { store.reset(); store.setStock('apple', 5); store.setStock('pear', 0); });",
        'done();',
      ),
    },
    async check(c) {
      return testsThenProbe(c, {
        probe: L(
          "const store = require('./store');",
          "const { placeOrder } = require('./orders');",
          "const { OutOfStock } = require('./inventory');",
          'const out = [];',
          'const tryOrder = (lines) => { try { placeOrder(lines); return "ok"; } catch (e) { return e instanceof OutOfStock ? "out:" + e.sku : "other:" + e.message; } };',
          "store.reset(); store.setStock('a', 3);",
          "out.push(tryOrder([{ sku: 'a', qty: 2 }, { sku: 'a', qty: 2 }]), store.getStock('a'));",
          "store.reset(); store.setStock('a', 5); store.setStock('b', 5); store.setStock('c', 0);",
          "out.push(tryOrder([{ sku: 'a', qty: 1 }, { sku: 'b', qty: 4 }, { sku: 'c', qty: 1 }]), store.getStock('a'), store.getStock('b'));",
          "out.push(tryOrder([{ sku: 'a', qty: 5 }]), store.getStock('a'));",
          'console.log(JSON.stringify(out));',
        ),
        expect: ['out:a', 3, 'out:c', 5, 5, 'ok', 0],
        what: 'a failed order releases everything it reserved, the same item twice included',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'orders.js', L(
        "const { reserve, release } = require('./inventory');",
        'const orders = new Map();',
        'let nextId = 1;',
        'function placeOrder(lines) {',
        '  const done = [];',
        '  try {',
        '    for (const line of lines) { reserve(line.sku, line.qty); done.push(line); }',
        '  } catch (e) {',
        '    for (const line of done) release(line.sku, line.qty);',
        '    throw e;',
        '  }',
        '  const id = nextId++;',
        "  orders.set(id, { id, lines, status: 'placed' });",
        '  return id;',
        '}',
        'module.exports = { placeOrder, getOrder: (id) => orders.get(id) };',
      )),
      // Checks every line up front, one at a time - which misses the same
      // item asked for twice.
      breakIt: (d, W) => W(d, 'orders.js', L(
        "const { reserve, OutOfStock } = require('./inventory');",
        "const store = require('./store');",
        'const orders = new Map();',
        'let nextId = 1;',
        'function placeOrder(lines) {',
        '  for (const line of lines) if (store.getStock(line.sku) < line.qty) throw new OutOfStock(line.sku);',
        '  for (const line of lines) reserve(line.sku, line.qty);',
        '  const id = nextId++;',
        "  orders.set(id, { id, lines, status: 'placed' });",
        '  return id;',
        '}',
        'module.exports = { placeOrder, getOrder: (id) => orders.get(id) };',
      )),
    },
  },

  // ── A new command that has to look like the others ───────────────────────
  {
    id: 'hard-cli-follow-conventions',
    category: 'hard',
    prompt: 'Add a `remove <id>` command to this todo CLI that deletes a todo. Follow how the existing commands are written and wired up, and add tests for it to test.js.',
    files: {
      'store.js': L(
        'let todos = [];',
        'let nextId = 1;',
        'function reset() { todos = []; nextId = 1; }',
        'function add(title) { const t = { id: nextId++, title, done: false }; todos.push(t); return t; }',
        'function all() { return todos.slice(); }',
        'function find(id) { return todos.find((t) => t.id === id); }',
        'module.exports = { reset, add, all, find };',
      ),
      'format.js': L(
        "function formatTodo(t) { return '#' + t.id + ' [' + (t.done ? 'x' : ' ') + '] ' + t.title; }",
        'module.exports = { formatTodo };',
      ),
      'commands/add.js': L(
        "const store = require('../store');",
        "const { formatTodo } = require('../format');",
        'module.exports = {',
        "  name: 'add',",
        "  usage: 'add <title>',",
        '  run(args, out) {',
        "    const title = args.join(' ').trim();",
        "    if (!title) { out.error('Usage: todo add <title>'); return 1; }",
        "    out.log('Added ' + formatTodo(store.add(title)));",
        '    return 0;',
        '  },',
        '};',
      ),
      'commands/list.js': L(
        "const store = require('../store');",
        "const { formatTodo } = require('../format');",
        'module.exports = {',
        "  name: 'list',",
        "  usage: 'list',",
        '  run(args, out) {',
        '    const todos = store.all();',
        "    if (!todos.length) { out.log('Nothing to do.'); return 0; }",
        '    for (const t of todos) out.log(formatTodo(t));',
        '    return 0;',
        '  },',
        '};',
      ),
      'commands/done.js': L(
        "const store = require('../store');",
        "const { formatTodo } = require('../format');",
        'module.exports = {',
        "  name: 'done',",
        "  usage: 'done <id>',",
        '  run(args, out) {',
        '    const id = Number(args[0]);',
        "    if (!Number.isInteger(id)) { out.error('Usage: todo done <id>'); return 1; }",
        '    const todo = store.find(id);',
        "    if (!todo) { out.error('No todo with id ' + id); return 1; }",
        '    todo.done = true;',
        "    out.log('Completed ' + formatTodo(todo));",
        '    return 0;',
        '  },',
        '};',
      ),
      'commands/index.js': L(
        "module.exports = [require('./add'), require('./list'), require('./done')];",
      ),
      'cli.js': L(
        "const commands = require('./commands');",
        'function cli(argv, out) {',
        '  const [name, ...args] = argv;',
        "  if (!name || name === 'help') {",
        "    out.log('Usage:');",
        "    for (const c of commands) out.log('  todo ' + c.usage);",
        '    return 0;',
        '  }',
        '  const cmd = commands.find((c) => c.name === name);',
        "  if (!cmd) { out.error('Unknown command: ' + name); return 1; }",
        '  return cmd.run(args, out);',
        '}',
        'module.exports = { cli };',
      ),
      'test.js': RUNNER + L(
        "const store = require('./store');",
        "const { cli } = require('./cli');",
        'const capture = () => { const o = { logs: [], errors: [] }; o.log = (s) => o.logs.push(s); o.error = (s) => o.errors.push(s); return o; };',
        "t('add prints the new todo', () => {",
        "  const o = capture(); assert.strictEqual(cli(['add', 'Buy', 'milk'], o), 0);",
        "  assert.deepStrictEqual(o.logs, ['Added #1 [ ] Buy milk']);",
        '}, store.reset);',
        "t('done marks it and says so', () => {",
        "  store.add('Walk'); const o = capture(); assert.strictEqual(cli(['done', '1'], o), 0);",
        "  assert.deepStrictEqual(o.logs, ['Completed #1 [x] Walk']);",
        '}, store.reset);',
        "t('done on a missing id is an error', () => {",
        "  const o = capture(); assert.strictEqual(cli(['done', '4'], o), 1);",
        "  assert.deepStrictEqual(o.errors, ['No todo with id 4']);",
        '}, store.reset);',
        "t('help lists every command', () => {",
        "  const o = capture(); cli(['help'], o);",
        "  assert.ok(o.logs.includes('  todo done <id>'));",
        '}, store.reset);',
        'done();',
      ),
    },
    async check(c) {
      if (!c.exists('commands/remove.js')) return { pass: false, reason: 'no commands/remove.js — the other commands each live in their own file under commands/' };
      const tests = c.read('test.js') || '';
      if (!/remove/.test(tests)) return { pass: false, reason: 'no tests for remove were added to test.js' };
      if (!/done marks it and says so/.test(tests) || !/help lists every command/.test(tests)) return { pass: false, reason: 'existing tests were removed from test.js' };
      return testsThenProbe(c, {
        testsUnchanged: false,
        probe: L(
          "const store = require('./store');",
          "const { cli } = require('./cli');",
          'const capture = () => { const o = { logs: [], errors: [] }; o.log = (s) => o.logs.push(s); o.error = (s) => o.errors.push(s); return o; };',
          'const out = [];',
          "store.reset(); cli(['add', 'Buy', 'milk'], capture()); cli(['add', 'Walk'], capture());",
          "let o = capture(); out.push(cli(['remove', '1'], o), /^(Removed|Deleted) #1 \\[ \\] Buy milk$/.test(o.logs[0] || ''), o.errors.length);",
          "o = capture(); cli(['list'], o); out.push(o.logs);",
          "o = capture(); out.push(cli(['remove', '9'], o), o.errors);",
          "o = capture(); out.push(cli(['remove', 'x'], o), o.errors);",
          "o = capture(); cli(['help'], o); out.push(o.logs.includes('  todo remove <id>'));",
          'console.log(JSON.stringify(out));',
        ),
        expect: [0, true, 0, ['#2 [ ] Walk'], 1, ['No todo with id 9'], 1, ['Usage: todo remove <id>'], true],
        what: 'remove follows the file layout, registration, messages and errors of the other commands',
      });
    },
    selftest: {
      solve: (d, W) => {
        W(d, 'store.js', L(
          'let todos = [];',
          'let nextId = 1;',
          'function reset() { todos = []; nextId = 1; }',
          'function add(title) { const t = { id: nextId++, title, done: false }; todos.push(t); return t; }',
          'function all() { return todos.slice(); }',
          'function find(id) { return todos.find((t) => t.id === id); }',
          'function remove(id) { const i = todos.findIndex((t) => t.id === id); return i === -1 ? null : todos.splice(i, 1)[0]; }',
          'module.exports = { reset, add, all, find, remove };',
        ));
        W(d, 'commands/remove.js', L(
          "const store = require('../store');",
          "const { formatTodo } = require('../format');",
          'module.exports = {',
          "  name: 'remove',",
          "  usage: 'remove <id>',",
          '  run(args, out) {',
          '    const id = Number(args[0]);',
          "    if (!Number.isInteger(id)) { out.error('Usage: todo remove <id>'); return 1; }",
          '    const todo = store.remove(id);',
          "    if (!todo) { out.error('No todo with id ' + id); return 1; }",
          "    out.log('Removed ' + formatTodo(todo));",
          '    return 0;',
          '  },',
          '};',
        ));
        W(d, 'commands/index.js', "module.exports = [require('./add'), require('./list'), require('./done'), require('./remove')];\n");
        const fs = require('fs'); const path = require('path');
        const t = fs.readFileSync(path.join(d, 'test.js'), 'utf8').replace('done();', L(
          "t('remove deletes it', () => {",
          "  store.add('X'); const o = capture(); assert.strictEqual(cli(['remove', '1'], o), 0);",
          "  assert.deepStrictEqual(o.logs, ['Removed #1 [ ] X']);",
          '}, store.reset);',
          'done();',
        ));
        W(d, 'test.js', t);
      },
      // Works, but ignores every convention: inline in cli.js, its own wording.
      breakIt: (d, W) => {
        W(d, 'commands/remove.js', "module.exports = { name: 'remove', usage: 'remove', run(args, out) { out.log('Todo ' + args[0] + ' deleted'); return 0; } };\n");
        W(d, 'commands/index.js', "module.exports = [require('./add'), require('./list'), require('./done'), require('./remove')];\n");
        const fs = require('fs'); const path = require('path');
        W(d, 'test.js', fs.readFileSync(path.join(d, 'test.js'), 'utf8').replace('done();', "t('remove', () => {});\ndone();"));
      },
    },
  },

  // ── A vague report whose cause is a fixed UTC offset ─────────────────────
  {
    id: 'hard-receipt-timezone',
    category: 'hard',
    prompt: 'Bug report from our Berlin store: receipts printed in summer show the time an hour early. Receipts should show the date and time at the store. Please fix this properly.',
    files: {
      'stores.js': L(
        'module.exports = {',
        "  berlin: { name: 'Berlin Mitte', tz: 'Europe/Berlin', utcOffsetMinutes: 60 },",
        "  nyc: { name: 'NYC Soho', tz: 'America/New_York', utcOffsetMinutes: -300 },",
        '};',
      ),
      'receipt.js': L(
        "const stores = require('./stores');",
        "const pad = (n) => String(n).padStart(2, '0');",
        '',
        '// The time at the store, for the printed receipt.',
        'function storeTime(date, storeId) {',
        '  const store = stores[storeId];',
        '  const local = new Date(date.getTime() + store.utcOffsetMinutes * 60000);',
        "  return pad(local.getUTCHours()) + ':' + pad(local.getUTCMinutes());",
        '}',
        '',
        'function receiptHeader(date, storeId) {',
        "  return stores[storeId].name + ' - ' + date.toISOString().slice(0, 10) + ' ' + storeTime(date, storeId);",
        '}',
        '',
        'module.exports = { storeTime, receiptHeader };',
      ),
      'test.js': RUNNER + L(
        "const { storeTime, receiptHeader } = require('./receipt');",
        "t('berlin in winter', () => assert.strictEqual(storeTime(new Date('2026-01-15T10:00:00Z'), 'berlin'), '11:00'));",
        "t('header', () => assert.strictEqual(receiptHeader(new Date('2026-01-15T10:00:00Z'), 'berlin'), 'Berlin Mitte - 2026-01-15 11:00'));",
        'done();',
      ),
    },
    async check(c) {
      // The prompt does not forbid touching test.js, and adding a summer case
      // to it is good practice - so it may grow, but what it already checked
      // must still be there. The hidden cases decide whether the fix is right.
      const tests = c.read('test.js') || '';
      if (!/berlin in winter/.test(tests) || !/Berlin Mitte - 2026-01-15 11:00/.test(tests)) {
        return { pass: false, reason: 'the existing tests in test.js were removed or changed' };
      }
      return testsThenProbe(c, {
        testsUnchanged: false,
        probe: L(
          "const { storeTime, receiptHeader } = require('./receipt');",
          'console.log(JSON.stringify([',
          "  storeTime(new Date('2026-07-15T10:00:00Z'), 'berlin'),",
          "  storeTime(new Date('2026-01-15T10:00:00Z'), 'berlin'),",
          "  storeTime(new Date('2026-07-15T15:00:00Z'), 'nyc'),",
          "  storeTime(new Date('2026-01-15T15:00:00Z'), 'nyc'),",
          "  receiptHeader(new Date('2026-07-15T22:30:00Z'), 'berlin'),",
          "  receiptHeader(new Date('2026-01-15T03:15:00Z'), 'nyc'),",
          ']));',
        ),
        expect: ['12:00', '11:00', '11:00', '10:00', 'Berlin Mitte - 2026-07-16 00:30', 'NYC Soho - 2026-01-14 22:15'],
        what: 'store time follows each store\'s time zone, summer time and the date after midnight included',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'receipt.js', L(
        "const stores = require('./stores');",
        'function parts(date, storeId) {',
        "  const f = new Intl.DateTimeFormat('en-CA', { timeZone: stores[storeId].tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });",
        '  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));',
        '}',
        "function storeTime(date, storeId) { const p = parts(date, storeId); return p.hour + ':' + p.minute; }",
        "function receiptHeader(date, storeId) { const p = parts(date, storeId); return stores[storeId].name + ' - ' + p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute; }",
        'module.exports = { storeTime, receiptHeader };',
      )),
      // Fixes the hour with a summer-time rule, but leaves the date in UTC.
      breakIt: (d, W) => W(d, 'receipt.js', L(
        "const stores = require('./stores');",
        "const pad = (n) => String(n).padStart(2, '0');",
        'function offset(date, storeId) {',
        '  const m = date.getUTCMonth();',
        '  return stores[storeId].utcOffsetMinutes + (m >= 2 && m <= 9 ? 60 : 0);',
        '}',
        'function storeTime(date, storeId) {',
        '  const local = new Date(date.getTime() + offset(date, storeId) * 60000);',
        "  return pad(local.getUTCHours()) + ':' + pad(local.getUTCMinutes());",
        '}',
        "function receiptHeader(date, storeId) { return stores[storeId].name + ' - ' + date.toISOString().slice(0, 10) + ' ' + storeTime(date, storeId); }",
        'module.exports = { storeTime, receiptHeader };',
      )),
    },
  },

  // ── Events applied in parallel overtake each other ───────────────────────
  {
    id: 'hard-ledger-ordering',
    category: 'hard',
    prompt: '`node test.js` fails: a withdrawal right after a deposit is rejected for insufficient funds. Find the cause and fix it without changing test.js.',
    files: {
      'io.js': L(
        '// Stands in for the database round trip; deposits are slower to commit.',
        "function latency(type) { return new Promise((r) => setTimeout(r, type === 'deposit' ? 30 : 5)); }",
        'module.exports = { latency };',
      ),
      'ledger.js': L(
        "const { latency } = require('./io');",
        'const balances = new Map();',
        'function reset() { balances.clear(); }',
        'function balance(account) { return balances.get(account) || 0; }',
        '',
        'async function apply(ev) {',
        '  await latency(ev.type);',
        '  const bal = balance(ev.account);',
        "  if (ev.type === 'withdraw') {",
        "    if (bal < ev.amount) return { ok: false, reason: 'insufficient funds' };",
        '    balances.set(ev.account, bal - ev.amount);',
        '  } else {',
        '    balances.set(ev.account, bal + ev.amount);',
        '  }',
        '  return { ok: true };',
        '}',
        '',
        '// Events arrive in the order they happened. Returns one result per event.',
        'async function processEvents(events) {',
        '  return Promise.all(events.map(apply));',
        '}',
        '',
        'module.exports = { processEvents, balance, reset };',
      ),
      'test.js': L(
        "const assert = require('assert');",
        "const { processEvents, balance, reset } = require('./ledger');",
        '(async () => {',
        '  reset();',
        "  const results = await processEvents([{ account: 'a', type: 'deposit', amount: 100 }, { account: 'a', type: 'withdraw', amount: 40 }]);",
        '  assert.deepStrictEqual(results.map((r) => r.ok), [true, true]);',
        "  assert.strictEqual(balance('a'), 60);",
        "  console.log('all tests passed');",
        '})().catch((e) => { console.log(e.message); process.exit(1); });',
      ),
    },
    async check(c) {
      return testsThenProbe(c, {
        probe: L(
          "const { processEvents, balance, reset } = require('./ledger');",
          '(async () => {',
          '  reset();',
          '  const r = await processEvents([',
          "    { account: 'a', type: 'withdraw', amount: 10 },",
          "    { account: 'b', type: 'deposit', amount: 50 },",
          "    { account: 'a', type: 'deposit', amount: 30 },",
          "    { account: 'b', type: 'withdraw', amount: 20 },",
          "    { account: 'a', type: 'withdraw', amount: 25 },",
          "    { account: 'a', type: 'withdraw', amount: 10 },",
          '  ]);',
          "  console.log(JSON.stringify([r.map((x) => x.ok), balance('a'), balance('b')]));",
          '})();',
        ),
        // In order: a has nothing yet (rejected); b +50; a +30; b -20; a -25
        // leaves 5; a -10 is more than that (rejected).
        expect: [[false, true, true, true, true, false], 5, 30],
        what: 'events are applied in the order they happened, with one result per event in that order',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'ledger.js', require('fs').readFileSync(require('path').join(d, 'ledger.js'), 'utf8')
        .replace('return Promise.all(events.map(apply));', 'const out = [];\n  for (const ev of events) out.push(await apply(ev));\n  return out;')),
      // Puts every deposit first: the visible test passes, the order is gone.
      breakIt: (d, W) => W(d, 'ledger.js', require('fs').readFileSync(require('path').join(d, 'ledger.js'), 'utf8')
        .replace('return Promise.all(events.map(apply));',
          "const order = [...events].sort((x, y) => (x.type === 'deposit' ? 0 : 1) - (y.type === 'deposit' ? 0 : 1));\n  const out = new Map();\n  for (const ev of order) out.set(ev, await apply(ev));\n  return events.map((ev) => out.get(ev));")),
    },
  },

  // ── A CSV parser that only handles the easy cases ────────────────────────
  {
    id: 'hard-csv-quoting',
    category: 'hard',
    prompt: '`node test.js` shows parse() in csv.js getting quoted fields wrong. Fix the parser so it handles CSV properly (see the comment at the top of csv.js). Do not change test.js.',
    files: {
      'csv.js': String.raw`// Parses CSV text (RFC 4180). Fields are separated by commas and rows by
// newlines (\n or \r\n). A field may be wrapped in double quotes; inside the
// quotes, commas and newlines are part of the field, and a doubled quote ("")
// stands for one quote character. A final newline does not start a new row.
function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { fields.push(cur); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}
module.exports = { parse };
`,
      'test.js': RUNNER + String.raw`const { parse } = require('./csv');
t('plain rows', () => assert.deepStrictEqual(parse('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]));
t('a quoted comma', () => assert.deepStrictEqual(parse('x,"1,5"\n'), [['x', '1,5']]));
t('escaped quotes', () => assert.deepStrictEqual(parse('a,"he said ""hi"""\n'), [['a', 'he said "hi"']]));
t('a newline inside quotes', () => assert.deepStrictEqual(parse('"line1\nline2",z\n'), [['line1\nline2', 'z']]));
done();
`,
    },
    async check(c) {
      return testsThenProbe(c, {
        probe: String.raw`const { parse } = require('./csv');
console.log(JSON.stringify([
  parse('a,b\r\nc,d\r\n'),
  parse('a,,b\n'),
  parse('"",x'),
  parse('""""'),
  parse('"a\r\nb",c\r\n'),
  parse(''),
  parse('q,"x, ""y"", z"'),
]));
`,
        expect: [[['a', 'b'], ['c', 'd']], [['a', '', 'b']], [['', 'x']], [['"']], [['a\r\nb', 'c']], [], [['q', 'x, "y", z']]],
        what: 'quotes, escaped quotes, newlines in fields, empty fields and CRLF all parse correctly',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'csv.js', String.raw`function parse(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false, started = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; started = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; started = true; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; i++; continue; }
    field += ch; started = true; i++;
  }
  if (started || field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
module.exports = { parse };
`),
      // Handles doubled quotes and the visible newline case, not CRLF.
      breakIt: (d, W) => W(d, 'csv.js', String.raw`function parse(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
module.exports = { parse };
`),
    },
  },

  // ── Two separate bugs behind one wrong total ─────────────────────────────
  {
    id: 'hard-checkout-two-bugs',
    category: 'hard',
    prompt: 'Checkout totals are wrong whenever a discount is involved. `node test.js` shows one case. The pricing rules are in README.md. Fix it without changing test.js.',
    files: {
      'README.md': L(
        '# Pricing rules',
        '',
        '1. The subtotal is the sum of price × quantity over the lines.',
        '2. A cart discount (percent) applies once, to the subtotal.',
        '3. Tax is charged on the discounted subtotal and rounded once, to the cent.',
        '4. Total = discounted subtotal + tax, rounded to the cent.',
      ),
      'pricing/round.js': L(
        'function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }',
        'module.exports = { round2 };',
      ),
      'pricing/discount.js': L(
        'function applyDiscount(amount, pct) { return amount * (1 - pct / 100); }',
        'module.exports = { applyDiscount };',
      ),
      'cart.js': L(
        "const { applyDiscount } = require('./pricing/discount');",
        'function subtotal(cart) { return cart.lines.reduce((s, l) => s + l.price * l.qty, 0); }',
        'function discountedSubtotal(cart) { return cart.discountPct ? applyDiscount(subtotal(cart), cart.discountPct) : subtotal(cart); }',
        'module.exports = { subtotal, discountedSubtotal };',
      ),
      'tax.js': L(
        "const { round2 } = require('./pricing/round');",
        '// Tax for a cart at `rate` (0.2 = 20%).',
        'function taxFor(cart, rate) {',
        '  return cart.lines.reduce((sum, l) => sum + round2(l.price * l.qty * rate), 0);',
        '}',
        'module.exports = { taxFor };',
      ),
      'checkout.js': L(
        "const { discountedSubtotal } = require('./cart');",
        "const { applyDiscount } = require('./pricing/discount');",
        "const { taxFor } = require('./tax');",
        "const { round2 } = require('./pricing/round');",
        'function total(cart, rate) {',
        '  const base = applyDiscount(discountedSubtotal(cart), cart.discountPct || 0);',
        '  return round2(base + taxFor(cart, rate));',
        '}',
        'module.exports = { total };',
      ),
      'test.js': RUNNER + L(
        "const { total } = require('./checkout');",
        "t('a cart with no discount', () => assert.strictEqual(total({ lines: [{ price: 10, qty: 2 }] }, 0.2), 24));",
        "t('a discounted cart', () => assert.strictEqual(total({ lines: [{ price: 19.99, qty: 3 }, { price: 5.01, qty: 1 }], discountPct: 10 }, 0.2), 70.18));",
        'done();',
      ),
    },
    async check(c) {
      // Expected values from the rules in README.md, computed here rather than
      // typed in, so the reference is the rules and not someone's arithmetic.
      const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
      const ref = (cart, rate) => {
        const sub = cart.lines.reduce((s, l) => s + l.price * l.qty, 0);
        const disc = cart.discountPct ? sub * (1 - cart.discountPct / 100) : sub;
        return round2(disc + round2(disc * rate));
      };
      const carts = [
        [{ lines: [{ price: 0.05, qty: 1 }, { price: 0.05, qty: 1 }, { price: 0.05, qty: 1 }] }, 0.1],
        [{ lines: [{ price: 33.33, qty: 3 }, { price: 1.15, qty: 7 }], discountPct: 15 }, 0.19],
        [{ lines: [{ price: 99.99, qty: 1 }], discountPct: 50 }, 0.07],
        [{ lines: [{ price: 2.49, qty: 4 }, { price: 0.99, qty: 3 }], discountPct: 5 }, 0.2],
      ];
      return testsThenProbe(c, {
        probe: L(
          "const { total } = require('./checkout');",
          `const carts = ${JSON.stringify(carts)};`,
          'console.log(JSON.stringify(carts.map(([c, r]) => Math.round(total(c, r) * 100) / 100)));',
        ),
        expect: carts.map(([cart, rate]) => ref(cart, rate)),
        what: 'the discount applies once, and tax is charged on the discounted subtotal, rounded once',
      });
    },
    selftest: {
      solve: (d, W) => {
        W(d, 'tax.js', L(
          "const { round2 } = require('./pricing/round');",
          "const { discountedSubtotal } = require('./cart');",
          'function taxFor(cart, rate) { return round2(discountedSubtotal(cart) * rate); }',
          'module.exports = { taxFor };',
        ));
        W(d, 'checkout.js', L(
          "const { discountedSubtotal } = require('./cart');",
          "const { taxFor } = require('./tax');",
          "const { round2 } = require('./pricing/round');",
          'function total(cart, rate) { return round2(discountedSubtotal(cart) + taxFor(cart, rate)); }',
          'module.exports = { total };',
        ));
      },
      // Fixes the double discount only; tax is still per line on the full price.
      breakIt: (d, W) => W(d, 'checkout.js', L(
        "const { discountedSubtotal } = require('./cart');",
        "const { taxFor } = require('./tax');",
        "const { round2 } = require('./pricing/round');",
        'function total(cart, rate) { return round2(discountedSubtotal(cart) + taxFor(cart, rate)); }',
        'module.exports = { total };',
      )),
    },
  },

  // ── The tempting fix is in a helper another module depends on ───────────
  {
    id: 'hard-shared-helper',
    category: 'hard',
    prompt: '`node test.js` fails: the router does not match a path with a trailing slash ("/users/"). Fix it so all the tests pass, without changing test.js.',
    files: {
      'util/path.js': L(
        '// Collapses repeated slashes.',
        "function normalize(p) { return p.replace(/\\/{2,}/g, '/'); }",
        'module.exports = { normalize };',
      ),
      'router.js': L(
        "const { normalize } = require('./util/path');",
        'function createRouter() {',
        '  const routes = new Map();',
        '  return {',
        '    get(path, handler) { routes.set(normalize(path), handler); },',
        "    handle(path) { const h = routes.get(normalize(path)); return h ? h() : '404 Not Found'; },",
        '  };',
        '}',
        'module.exports = { createRouter };',
      ),
      'static.js': L(
        "const { normalize } = require('./util/path');",
        '// Maps a URL path to a file under public/; a directory serves its index.html.',
        'function resolveStatic(urlPath) {',
        '  const p = normalize(urlPath);',
        "  return 'public' + (p.endsWith('/') ? p + 'index.html' : p);",
        '}',
        'module.exports = { resolveStatic };',
      ),
      'test.js': RUNNER + L(
        "const { createRouter } = require('./router');",
        "const { resolveStatic } = require('./static');",
        "const r = createRouter(); r.get('/users', () => 'users');",
        "t('router: exact path', () => assert.strictEqual(r.handle('/users'), 'users'));",
        "t('router: trailing slash', () => assert.strictEqual(r.handle('/users/'), 'users'));",
        "t('static: a directory serves its index', () => assert.strictEqual(resolveStatic('/docs/'), 'public/docs/index.html'));",
        "t('static: repeated slashes', () => assert.strictEqual(resolveStatic('//img//a.png'), 'public/img/a.png'));",
        'done();',
      ),
    },
    async check(c) {
      return testsThenProbe(c, {
        probe: L(
          "const { createRouter } = require('./router');",
          "const { resolveStatic } = require('./static');",
          "const r = createRouter(); r.get('/users', () => 'users'); r.get('/about/', () => 'about'); r.get('/', () => 'home');",
          "console.log(JSON.stringify([r.handle('/users//'), r.handle('/about'), r.handle('/'), r.handle('/nope/'), resolveStatic('/docs//'), resolveStatic('/a.css')]));",
        ),
        expect: ['users', 'about', 'home', '404 Not Found', 'public/docs/index.html', 'public/a.css'],
        what: 'the router ignores a trailing slash without changing what static.js relies on',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'router.js', L(
        "const { normalize } = require('./util/path');",
        "const key = (p) => { const n = normalize(p); return n.length > 1 ? n.replace(/\\/+$/, '') : n; };",
        'function createRouter() {',
        '  const routes = new Map();',
        '  return {',
        '    get(path, handler) { routes.set(key(path), handler); },',
        "    handle(path) { const h = routes.get(key(path)); return h ? h() : '404 Not Found'; },",
        '  };',
        '}',
        'module.exports = { createRouter };',
      )),
      // Strips the trailing slash in the shared helper: the router passes,
      // static.js no longer sees directories.
      breakIt: (d, W) => W(d, 'util/path.js', L(
        "function normalize(p) { const n = p.replace(/\\/{2,}/g, '/'); return n.length > 1 ? n.replace(/\\/+$/, '') : n; }",
        'module.exports = { normalize };',
      )),
    },
  },

  // ── Follow a written spec exactly ────────────────────────────────────────
  {
    id: 'hard-semver-spec',
    category: 'hard',
    prompt: 'compare() in semver.js does not follow our versioning spec in docs/versioning.md. Make it follow the spec exactly. Do not change test.js.',
    files: {
      'docs/versioning.md': L(
        '# Version precedence',
        '',
        'Versions look like MAJOR.MINOR.PATCH, optionally followed by a pre-release',
        '(`-` then dot-separated identifiers) and build metadata (`+` then anything).',
        '',
        '1. Build metadata is ignored when comparing: 1.0.0+20130313 equals 1.0.0.',
        '2. MAJOR, MINOR and PATCH are compared numerically, in that order.',
        '3. When those are equal, a version with a pre-release is LOWER than one without: 1.0.0-alpha < 1.0.0.',
        '4. Two pre-releases are compared identifier by identifier, left to right:',
        '   - identifiers of digits only are compared numerically;',
        '   - other identifiers are compared as ASCII strings;',
        '   - a numeric identifier is lower than a non-numeric one;',
        '   - if all shared identifiers are equal, the version with fewer identifiers is lower.',
        '5. Identifiers may themselves contain hyphens: in 1.0.0-x-y.1 the pre-release is "x-y.1".',
        '',
        'Example, lowest to highest:',
        '1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0',
      ),
      'semver.js': L(
        'function parse(v) {',
        "  const [core, pre] = v.split('-');",
        "  const [major, minor, patch] = core.split('.').map(Number);",
        "  return { major, minor, patch, pre: pre || '' };",
        '}',
        '',
        '// -1, 0 or 1, as a is lower than, equal to or higher than b.',
        'function compare(a, b) {',
        '  const x = parse(a), y = parse(b);',
        "  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;",
        '  if (x.pre === y.pre) return 0;',
        '  if (!x.pre) return 1;',
        '  if (!y.pre) return -1;',
        '  return x.pre < y.pre ? -1 : 1;',
        '}',
        '',
        'module.exports = { compare };',
      ),
      'test.js': RUNNER + L(
        "const { compare } = require('./semver');",
        "t('release above its pre-release', () => assert.strictEqual(compare('1.0.0', '1.0.0-rc.1'), 1));",
        "t('numeric identifiers compare as numbers', () => assert.strictEqual(compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1));",
        'done();',
      ),
    },
    async check(c) {
      const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
      const pairs = [];
      for (let i = 0; i < chain.length - 1; i++) pairs.push([chain[i], chain[i + 1], -1], [chain[i + 1], chain[i], 1]);
      pairs.push(['1.0.0+20130313', '1.0.0', 0], ['1.0.0-beta+exp.sha', '1.0.0-beta', 0], ['2.10.0', '2.9.0', 1],
        ['1.0.0-x-y.1', '1.0.0-x-y.2', -1], ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-alpha', '1.0.0-alpha.0', -1], ['1.2.3', '1.2.3', 0]);
      return testsThenProbe(c, {
        probe: L(
          "const { compare } = require('./semver');",
          `const pairs = ${JSON.stringify(pairs)};`,
          'console.log(JSON.stringify(pairs.map(([a, b]) => Math.sign(compare(a, b)))));',
        ),
        expect: pairs.map((p) => p[2]),
        what: 'compare() follows every rule in docs/versioning.md',
      });
    },
    selftest: {
      solve: (d, W) => W(d, 'semver.js', L(
        'function parse(v) {',
        "  const noBuild = v.split('+')[0];",
        "  const dash = noBuild.indexOf('-');",
        '  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);',
        "  const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split('.');",
        "  const [major, minor, patch] = core.split('.').map(Number);",
        '  return { major, minor, patch, pre };',
        '}',
        'function cmpId(a, b) {',
        '  const na = /^\\d+$/.test(a), nb = /^\\d+$/.test(b);',
        '  if (na && nb) return Math.sign(Number(a) - Number(b));',
        '  if (na) return -1;',
        '  if (nb) return 1;',
        '  return a < b ? -1 : a > b ? 1 : 0;',
        '}',
        'function compare(a, b) {',
        '  const x = parse(a), y = parse(b);',
        "  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;",
        '  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;',
        '  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) { const r = cmpId(x.pre[i], y.pre[i]); if (r) return r; }',
        '  return Math.sign(x.pre.length - y.pre.length);',
        '}',
        'module.exports = { compare };',
      )),
      // Numeric identifiers fixed, build metadata and hyphenated identifiers not.
      breakIt: (d, W) => W(d, 'semver.js', L(
        'function parse(v) {',
        "  const [core, pre] = v.split('-');",
        "  const [major, minor, patch] = core.split('.').map(Number);",
        "  return { major, minor, patch, pre: pre ? pre.split('.') : [] };",
        '}',
        'function cmpId(a, b) {',
        '  const na = /^\\d+$/.test(a), nb = /^\\d+$/.test(b);',
        '  if (na && nb) return Math.sign(Number(a) - Number(b));',
        '  if (na) return -1;',
        '  if (nb) return 1;',
        '  return a < b ? -1 : a > b ? 1 : 0;',
        '}',
        'function compare(a, b) {',
        '  const x = parse(a), y = parse(b);',
        "  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;",
        '  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;',
        '  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) { const r = cmpId(x.pre[i], y.pre[i]); if (r) return r; }',
        '  return Math.sign(x.pre.length - y.pre.length);',
        '}',
        'module.exports = { compare };',
      )),
    },
  },
];

module.exports = { HARD_TASKS };
