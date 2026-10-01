import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..', '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  userData: string;
  graftHome: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  userData?: string;
  graftHome?: string;
  env?: Record<string, string>;
  /** Launch an installed or packaged Graft.exe instead of the development build in out/. */
  executablePath?: string;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Launches the built app (out/main, or a packaged executable) with isolated userData and ~/.graft. */
export async function launchGraft(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = options.userData ?? makeTempDir('graft-e2e-data-');
  const graftHome = options.graftHome ?? makeTempDir('graft-e2e-home-');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  Object.assign(env, { GRAFT_USER_DATA_DIR: userData, GRAFT_HOME: graftHome, GRAFT_E2E: '1' }, options.env ?? {});

  const app = options.executablePath
    ? await electron.launch({ executablePath: options.executablePath, args: [], env, cwd: ROOT })
    : await electron.launch({ args: [path.join(ROOT, 'out', 'main', 'index.js')], env, cwd: ROOT });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return {
    app,
    window,
    userData,
    graftHome,
    async close() {
      await app.close();
    }
  };
}
