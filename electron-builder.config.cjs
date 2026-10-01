/**
 * electron-builder configuration.
 *
 * Updates: set GRAFT_UPDATE_URL (a generic HTTPS feed holding latest.yml and
 * the installers) when building to ship an update feed. Without it the build
 * has no feed and Settings → About says so; the updater stays idle.
 *
 * Native modules (better-sqlite3, node-pty) ship N-API prebuilds that load in
 * Electron as-is, so no rebuild runs here. They and ripgrep are unpacked from
 * the asar because they are loaded or spawned from disk.
 */
const updateUrl = process.env.GRAFT_UPDATE_URL?.trim();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.graft.desktop',
  productName: 'Graft',
  copyright: 'Copyright © 2026 Graft contributors',
  directories: { output: 'dist', buildResources: 'build' },
  files: [
    'out/**',
    'package.json',
    '!**/*.map',
    // Build-time sources of the SQLite binding; the prebuilt binary is all that loads.
    '!**/node_modules/better-sqlite3/{deps,src}/**'
  ],
  extraResources: [{ from: 'resources/icons', to: 'icons' }],
  asar: true,
  asarUnpack: ['**/node_modules/node-pty/**', '**/node_modules/better-sqlite3/**', '**/node_modules/@vscode/ripgrep-*/bin/**'],
  npmRebuild: false,
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    // The Windows build is x64 only: drop other platforms' native binaries.
    files: [
      '!**/node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node',
      '!**/node_modules/better-sqlite3/prebuilds/win32-arm64.node',
      '!**/node_modules/node-pty/prebuilds/{darwin-*,win32-arm64}/**',
      '!**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**'
    ]
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
