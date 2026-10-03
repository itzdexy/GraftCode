import type { ProjectSummary } from '@shared/schemas/app';
import { invoke } from './ipc';
import { useApp } from '../stores/app';

/** Images offered in Settings → Sandbox; any other image can be typed in. */
export const SANDBOX_IMAGES: Array<{ image: string; label: string }> = [
  { image: 'node:22-bookworm', label: 'Node.js 22 (Debian)' },
  { image: 'python:3.12-bookworm', label: 'Python 3.12 (Debian)' },
  { image: 'golang:1.23-bookworm', label: 'Go 1.23 (Debian)' },
  { image: 'rust:1-bookworm', label: 'Rust (Debian)' },
  { image: 'ubuntu:24.04', label: 'Ubuntu 24.04 (no tools)' }
];

/**
 * Turns a project's sandbox on or off. Turning it on checks the engine first,
 * so the switch never claims protection that the next command can't deliver.
 */
export async function setProjectSandbox(project: ProjectSummary, on: boolean): Promise<void> {
  if (on) {
    const status = await invoke('sandbox:status', { refresh: true });
    if (status.problem) throw new Error(status.problem);
  }
  const updated = await invoke('projects:update', { id: project.id, settings: { ...project.settings, sandbox: on } });
  useApp.getState().upsertProject(updated);
}
