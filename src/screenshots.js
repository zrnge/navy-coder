'use strict';

// The screenshots /playthrough takes, kept so the chat can show them.
//
// A screenshot already goes to the model as a vision message; it just never
// reached the panel, so a playthrough read as a list of tool names with the
// pictures missing. Each one is written as a PNG in the project's folder in
// the profile (~/.navy-coder/<project>/screenshots) - never in the project -
// and the chat shows it under the tool that took it, as a thumbnail you can
// click.
//
// Files, not base64 in the saved chat: a 1280x800 screenshot is a few hundred
// kilobytes, and a playthrough takes dozens. In the chat file they would bloat
// every save of that conversation; on disk they are one folder that prunes
// itself to the most recent SHOT_KEEP.

const fs = require('fs');
const path = require('path');

const SHOT_KEEP = 60;
const SHOT_DIR = 'screenshots';

function screenshotDir(navyDir) {
  return path.join(navyDir, SHOT_DIR);
}

// Writes one PNG and returns its path. The name carries the time and the tool,
// so the folder reads as a record of the run rather than a pile of hashes.
async function saveScreenshot(navyDir, tool, base64, { keep = SHOT_KEEP } = {}) {
  if (!navyDir || !base64) return null;
  const dir = screenshotDir(navyDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTool = String(tool || 'screenshot').replace(/[^a-z0-9_-]+/gi, '-');
  const file = path.join(dir, `${stamp}-${safeTool}.png`);
  await fs.promises.writeFile(file, Buffer.from(String(base64), 'base64'));
  pruneScreenshots(dir, keep, file).catch(() => { /* housekeeping only */ });
  return file;
}

// Keeps the newest `keep` files, never the one just written.
async function pruneScreenshots(dir, keep = SHOT_KEEP, justWritten = '') {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return; }
  const shots = names.filter(n => n.endsWith('.png'));
  if (shots.length <= keep) return;
  const stated = await Promise.all(shots.map(async (name) => {
    const full = path.join(dir, name);
    try { return { full, mtime: (await fs.promises.stat(full)).mtimeMs }; } catch { return null; }
  }));
  const older = stated
    .filter(Boolean)
    .filter(e => e.full !== justWritten)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keep);
  for (const entry of older) {
    try { await fs.promises.unlink(entry.full); } catch { /* already gone */ }
  }
}

module.exports = { saveScreenshot, pruneScreenshots, screenshotDir, SHOT_KEEP };
