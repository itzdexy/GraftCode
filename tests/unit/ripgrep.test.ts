import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRipgrep } from '../../src/main/tools/builtin';
import { makeTempDir } from '../support/tmp';

describe('findRipgrep', () => {
  it('resolves the bundled binary through module resolution, independent of the app path', () => {
    const rg = findRipgrep();
    expect(fs.existsSync(rg)).toBe(true);
    expect(path.basename(rg)).toBe(process.platform === 'win32' ? 'rg.exe' : 'rg');
  });

  it('prefers the app.asar.unpacked copy in a packaged app', () => {
    const root = makeTempDir('graft-rg-');
    const inAsar = path.join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe');
    const unpacked = inAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    fs.mkdirSync(path.dirname(unpacked), { recursive: true });
    fs.writeFileSync(unpacked, '');
    expect(findRipgrep('win32', 'x64', () => inAsar)).toBe(unpacked);
  });

  it('explains which platform package is missing', () => {
    const missing = (): string => {
      throw new Error('Cannot find module');
    };
    expect(() => findRipgrep('linux', 'riscv64', missing)).toThrow(/@vscode\/ripgrep-linux-riscv64\/bin\/rg/);
  });
});
