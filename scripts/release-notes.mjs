// Prints the GitHub release notes for one version as Markdown, from the notes
// the app shows in "What's new". The release workflow fails when a version has
// no notes, so every release ships with them.
//
//   node scripts/release-notes.mjs 0.3.0
import fs from 'node:fs';

const version = process.argv[2];
const notes = JSON.parse(fs.readFileSync(new URL('../src/renderer/src/features/home/releaseNotes.json', import.meta.url), 'utf8'));
const release = notes.find((entry) => entry.version === version);
if (!release) {
  console.error(`No notes for version ${version} in src/renderer/src/features/home/releaseNotes.json.`);
  process.exit(1);
}

console.log(
  [
    ...release.items.map((item) => `- ${item}`),
    '',
    '### Install',
    '',
    `- **Windows:** \`Graft-Setup-${version}.exe\`. The installer isn't code-signed yet, so SmartScreen may ask first: choose **More info → Run anyway**.`,
    '- **macOS (Apple silicon):** the `.dmg`. The app isn\'t notarized yet: if macOS won\'t open it, choose **Open Anyway** in System Settings → Privacy & Security.',
    '- **Linux:** the `.AppImage` (mark it executable) or the `.deb`.',
    '',
    'Already using Graft? It downloads this update in the background and asks to restart.'
  ].join('\n')
);
