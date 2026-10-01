/**
 * electron-builder configuration.
 *
 * Only the built app (out/) and production dependencies are packaged; sources,
 * tests, docs and the reference screenshots never ship.
 *
 * Updates: installed builds check the GitHub releases of itzdexy/GraftCode
 * (the release workflow publishes them on each version tag). Set
 * GRAFT_UPDATE_URL to a generic HTTPS feed (latest.yml plus installers) to
 * ship from somewhere else instead.
 *
 * Native modules (better-sqlite3, node-pty) ship N-API prebuilds that load in
 * Electron as-is, so no rebuild runs here. They and ripgrep are unpacked from
 * the asar because they are loaded or spawned from disk. Prebuilds for other
 * platforms are left out of each build.
 */
const fs = require('node:fs');
const path = require('node:path');

const updateUrl = process.env.GRAFT_UPDATE_URL?.trim();

/** Platform being packaged, from the CLI flags (the config is loaded before targets are resolved). */
const targetPlatform = process.argv.includes('--mac') ? 'darwin' : process.argv.includes('--linux') ? 'linux' : process.argv.includes('--win') ? 'win32' : process.platform;
/** Windows builds are x64 only; macOS and Linux keep both architectures. */
const keepPrebuild = (name) => (targetPlatform === 'win32' ? name.startsWith('win32-x64') : name.startsWith(targetPlatform) || (targetPlatform === 'linux' && name.startsWith('linuxmusl')));

function otherPlatformPatterns() {
  const patterns = [];
  const sqlite = path.join(__dirname, 'node_modules', 'better-sqlite3', 'prebuilds');
  if (fs.existsSync(sqlite)) {
    for (const file of fs.readdirSync(sqlite)) if (!keepPrebuild(file)) patterns.push(`!**/node_modules/better-sqlite3/prebuilds/${file}`);
  }
  const pty = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds');
  if (fs.existsSync(pty)) {
    for (const dir of fs.readdirSync(pty)) if (!keepPrebuild(dir)) patterns.push(`!**/node_modules/node-pty/prebuilds/${dir}/**`);
  }
  if (targetPlatform === 'win32') patterns.push('!**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**');
  if (targetPlatform !== 'win32') patterns.push('!**/node_modules/node-pty/third_party/**');
  return patterns;
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.graft.desktop',
  productName: 'Graft',
  copyright: 'Copyright © 2026 Graft contributors',
  // GRAFT_DIST_DIR builds elsewhere, e.g. while a copy from dist/ is still open.
  directories: { output: process.env.GRAFT_DIST_DIR?.trim() || 'dist', buildResources: 'build' },
  files: [
    'out/**',
    'package.json',
    '!**/*.map',
    // Build-time sources of the SQLite binding; the prebuilt binary is all that loads.
    '!**/node_modules/better-sqlite3/{deps,src}/**',
    ...otherPlatformPatterns()
  ],
  extraResources: [
    { from: 'resources/icons', to: 'icons' },
    { from: 'resources/catalog', to: 'catalog' }
  ],
  asar: true,
  asarUnpack: ['**/node_modules/node-pty/**', '**/node_modules/better-sqlite3/**', '**/node_modules/@vscode/ripgrep-*/bin/**'],
  npmRebuild: false,
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : [{ provider: 'github', owner: 'itzdexy', repo: 'GraftCode', releaseType: 'release' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Graft',
    uninstallDisplayName: 'Graft',
    artifactName: 'Graft-Setup-${version}.${ext}'
  },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    hardenedRuntime: true
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    icon: 'build/icon.png',
    maintainer: 'Graft contributors'
  }
};
