// Builds the Linux installers (AppImage and .deb) in a clean Linux container
// from the committed HEAD, then smoke-tests the packaged app there. Lets
// Windows and macOS machines with Docker produce Linux releases without CI.
//
//   npm run dist:linux:docker      → dist/linux/
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'linux');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const steps = [
  'set -e',
  'export DEBIAN_FRONTEND=noninteractive CI=1',
  'apt-get update -qq',
  // Electron's runtime libraries and a virtual display for the smoke test.
  'apt-get install -y -qq --no-install-recommends xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 libatspi2.0-0 libdrm2 libxkbfile1 libxshmfence1 libgl1 > /dev/null',
  'mkdir /src && cd /src && tar xf -',
  'npm ci --no-audit --no-fund',
  'npm run build',
  'npx electron-builder --config electron-builder.config.cjs --linux --publish never',
  'GRAFT_PACKAGED_EXE=dist/linux-unpacked/graft xvfb-run -a npx playwright test packaged',
  'cp dist/*.AppImage dist/*.deb dist/latest-linux.yml /out/'
].join('\n');

const source = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 1 << 30 });
const run = spawnSync('docker', ['run', '--rm', '-i', '--shm-size=2g', '-v', `${out}:/out`, 'node:24-bookworm', 'bash', '-c', steps], {
  input: source,
  stdio: ['pipe', 'inherit', 'inherit'],
  maxBuffer: 1 << 30
});
if (run.error) {
  console.error(`Couldn't run docker: ${run.error.message}`);
  process.exit(1);
}
if (run.status === 0) console.log(`\nLinux installers: ${out}`);
process.exit(run.status ?? 1);
