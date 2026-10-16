#!/usr/bin/env node
/**
 * Fetches the diagram-design skill (https://github.com/cathrynlavery/diagram-design,
 * MIT licence) at one pinned commit into resources/skills/diagram-design, byte
 * for byte, with upstream's licence files beside its SKILL.md and an
 * UPSTREAM.json that says what the folder is.
 *
 * Graft ships that folder as a built-in skill: text every model is told to
 * follow, and scripts an agent may run. So it is fetched only here, by someone
 * who then reads it before committing it, and never while Graft runs. To move
 * to a newer upstream: change COMMIT and VERSION, run this, read the diff.
 *
 * Usage: npm run skill:diagram
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'cathrynlavery/diagram-design';
const COMMIT = '7a2e22170ee838e859d8142ba825d83f8b6375e6';
const VERSION = '2.6.74';
const FOLDER = 'skills/diagram-design';
const TARGET = path.join(root, 'resources', 'skills', 'diagram-design');

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** Every file under a folder, as paths from it with forward slashes. A link is refused: it could lead out of the folder. */
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${path.relative(base, full)} is a link; the skill is copied only when it is made of plain files.`);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** One hash for the whole folder: a line a file (its own hash, two spaces, its path), sorted by path, hashed together. UPSTREAM.json is not part of it. */
function treeHash(dir) {
  const names = files(dir)
    .filter((f) => f !== 'UPSTREAM.json')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { count: names.length, hash: sha(names.map((f) => `${sha(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join('')) };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-skill-'));
  try {
    const response = await fetch(`https://codeload.github.com/${REPOSITORY}/tar.gz/${COMMIT}`);
    if (response.status !== 200) throw new Error(`Couldn't fetch ${REPOSITORY} at ${COMMIT}: HTTP ${response.status}.`);
    fs.writeFileSync(path.join(temp, 'src.tar.gz'), Buffer.from(await response.arrayBuffer()));
    // Relative names, so a path with spaces or a drive letter never reaches tar.
    execFileSync('tar', ['-xzf', 'src.tar.gz'], { cwd: temp, stdio: 'inherit' });
    const tops = fs.readdirSync(temp, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (tops.length !== 1) throw new Error(`The archive holds ${tops.length} top folders; one was expected.`);
    const top = path.join(temp, tops[0].name);

    const found = JSON.parse(fs.readFileSync(path.join(top, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    if (found !== VERSION) throw new Error(`expected ${VERSION}, found ${found}`);

    const source = path.join(top, ...FOLDER.split('/'));
    files(source);
    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.cpSync(source, TARGET, { recursive: true });
    for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.md']) fs.copyFileSync(path.join(top, name), path.join(TARGET, name));

    const tree = treeHash(TARGET);
    const upstream = { repository: `https://github.com/${REPOSITORY}`, commit: COMMIT, version: VERSION, treeHash: tree.hash };
    fs.writeFileSync(path.join(TARGET, 'UPSTREAM.json'), `${JSON.stringify(upstream, null, 2)}\n`);
    console.log(`diagram-design ${VERSION} (${COMMIT.slice(0, 7)}): ${tree.count} files, treeHash ${tree.hash}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
