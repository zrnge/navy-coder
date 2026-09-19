const { fs, path, check, makeContext, sharedMock } = require('./harness.js');

// Navy keeps a project's chats, memory and the rest in the profile
// (~/.navy-coder/<project>-<hash>), never in the project - so nothing of it can
// be committed, pushed or packaged with the code. Projects from before that
// have theirs moved out the first time Navy opens them.
async function navyDataDirSuite() {
  console.log('\nwhere Navy keeps a project\'s data (the profile, not the project):');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const { projectDataDir, navyDataHome } = require('../src/data-dir.js');
  const { vscode, ctrl } = sharedMock();
  const { NavyCoderViewProvider } = require('../src/extension.js');
  const made = [];
  const tmpDir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-dd-' + tag + '-')); made.push(d); return d; };
  const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const providerFor = (root) => {
    const p = new NavyCoderViewProvider(makeContext(root));
    p.projectRoot = root;
    p.view = { webview: { postMessage: () => Promise.resolve(true) } };
    return p;
  };

  try {
    // ── Where ────────────────────────────────────────────────────────────────
    const a = tmpDir('where');
    const dir = projectDataDir(a);
    check('where: under the profile\'s .navy-coder folder, not in the project',
      dir.startsWith(navyDataHome() + path.sep) && !dir.startsWith(a), dir);
    check('where: named for the project, with a short hash of its path',
      new RegExp('^' + path.basename(a).replace(/[^A-Za-z0-9._-]+/g, '-') + '-[0-9a-f]{8}$', 'i').test(path.basename(dir)), path.basename(dir));
    const twinA = path.join(tmpDir('twin1'), 'app');
    const twinB = path.join(tmpDir('twin2'), 'app');
    check('where: two projects with the same folder name get a folder each', projectDataDir(twinA) !== projectDataDir(twinB));
    if (process.platform === 'win32') {
      check('where: the same project spelled in another case is the same project', projectDataDir(a.toUpperCase()) === dir);
    }

    // ── Nothing lands in the project ────────────────────────────────────────
    const fresh = tmpDir('fresh');
    const p1 = providerFor(fresh);
    p1.messages = [{ role: 'user', text: 'my key is sk-live-SECRET' }, { role: 'assistant', text: 'ok' }];
    await p1.saveProjectSession();
    await p1.toolRemember('the staging password is hunter2');
    p1.createCheckpoint(path.join(fresh, 'app.js'), 'old', 'new');
    await new Promise(r => setTimeout(r, 700)); // the chat write is debounced
    const { fd } = await p1._openPersistLog(fresh, 'dev');
    fs.closeSync(fd);
    let offered = null;
    const realSave = vscode.window.showSaveDialog;
    vscode.window.showSaveDialog = async (o) => { offered = o.defaultUri; return o.defaultUri; };
    try { await p1.exportConversation(); } finally { vscode.window.showSaveDialog = realSave; }
    check('project: after chats, memory, checkpoints, logs and an export, the project has no .navy at all',
      !fs.existsSync(path.join(fresh, '.navy')), fs.existsSync(path.join(fresh, '.navy')) ? fs.readdirSync(path.join(fresh, '.navy')).join(',') : '');
    const home1 = p1.getNavyDir(fresh);
    check('project: it is all in the profile folder instead',
      fs.readdirSync(path.join(home1, 'chats')).length === 1 && fs.readFileSync(path.join(home1, 'memory.md'), 'utf8').includes('hunter2')
      && fs.existsSync(path.join(home1, 'bg-logs')));
    check('project: an export is offered in the profile folder, outside the project',
      Boolean(offered) && offered.fsPath.startsWith(path.join(home1, 'exports')) && !offered.fsPath.startsWith(fresh), offered && offered.fsPath);
    const about = JSON.parse(fs.readFileSync(path.join(home1, 'project.json'), 'utf8'));
    check('project: the profile folder says which project it belongs to', about.path === path.resolve(fresh) && about.name === path.basename(fresh));

    let haveGit = true;
    try { execFileSync('git', ['init', '-q'], { cwd: fresh, stdio: 'ignore' }); } catch { haveGit = false; }
    if (haveGit) {
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: fresh, encoding: 'utf8' });
      check('project: in a git repository, git sees nothing of Navy\'s to commit', !/navy/i.test(status), status);
    }

    // ── Moving an old project's .navy out ───────────────────────────────────
    const old = tmpDir('old');
    put(path.join(old, '.navy', 'chats', 'c1.json'), JSON.stringify({ id: 'c1', messages: [{ role: 'user', text: 'from before' }], digest: '', checkpoints: [] }));
    put(path.join(old, '.navy', 'memory.md'), '- an old fact');
    put(path.join(old, '.navy', 'embeddings', 'shard-01.json'), '{}');
    put(path.join(old, '.navy', 'commands', 'deploy.md'), 'Deploy it.');
    put(path.join(old, '.navy', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    put(path.join(old, '.navy', '.gitignore'), NavyCoderViewProvider.LEGACY_NAVY_GITIGNORES[1]);
    ctrl.shown.info.length = 0;
    const p2 = providerFor(old);
    await p2._ensureProjectChatsLoaded(old);
    const home2 = p2.getNavyDir(old);
    check('migrate: an old project\'s chats move to the profile, and still load',
      fs.existsSync(path.join(home2, 'chats', 'c1.json')) && !fs.existsSync(path.join(old, '.navy', 'chats'))
      && [...p2.sessions.values()].some(s => s.messages.some(m => m.text === 'from before')));
    check('migrate: ...and so do its memory and embedding index',
      fs.readFileSync(path.join(home2, 'memory.md'), 'utf8') === '- an old fact' && fs.existsSync(path.join(home2, 'embeddings', 'shard-01.json'))
      && !fs.existsSync(path.join(old, '.navy', 'memory.md')));
    check('migrate: the team\'s commands and skills stay in the project, where they are shared',
      fs.existsSync(path.join(old, '.navy', 'commands', 'deploy.md')) && fs.existsSync(path.join(old, '.navy', 'skills', 'mine', 'SKILL.md')));
    check('migrate: and Navy says where things went', ctrl.shown.info.some(m => /moved .* chats and memory out of the project/.test(m)), JSON.stringify(ctrl.shown.info));

    const onlyNavy = tmpDir('only');
    put(path.join(onlyNavy, '.navy', 'chats', 'c.json'), JSON.stringify({ id: 'c', messages: [] }));
    put(path.join(onlyNavy, '.navy', '.gitignore'), '*\n');
    await providerFor(onlyNavy)._ensureProjectChatsLoaded(onlyNavy);
    check('migrate: a .navy holding nothing but Navy\'s own files goes entirely', !fs.existsSync(path.join(onlyNavy, '.navy')));

    const edited = tmpDir('edited');
    put(path.join(edited, '.navy', 'chats', 'c.json'), JSON.stringify({ id: 'c', messages: [] }));
    put(path.join(edited, '.navy', '.gitignore'), '*\n# my own rule\n');
    await providerFor(edited)._ensureProjectChatsLoaded(edited);
    check('migrate: an ignore file someone edited is theirs, and stays',
      fs.readFileSync(path.join(edited, '.navy', '.gitignore'), 'utf8') === '*\n# my own rule\n');

    const clash = tmpDir('clash');
    put(path.join(clash, '.navy', 'memory.md'), 'older');
    const p3 = providerFor(clash);
    put(path.join(p3.getNavyDir(clash), 'memory.md'), 'newer');
    await p3._ensureProjectChatsLoaded(clash);
    check('migrate: nothing already in the profile folder is overwritten - the other copy is left where it was',
      fs.readFileSync(path.join(p3.getNavyDir(clash), 'memory.md'), 'utf8') === 'newer'
      && fs.readFileSync(path.join(clash, '.navy', 'memory.md'), 'utf8') === 'older');
  } finally {
    ctrl.reset?.();
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { navyDataDirSuite };
