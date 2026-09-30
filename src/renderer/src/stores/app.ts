import { create } from 'zustand';
import type { AppSettings, AppSettingsPatch } from '@shared/schemas/appSettings';
import type { EnvironmentInfo, ProjectSummary } from '@shared/schemas/app';
import type { ModelRef } from '@shared/schemas/common';
import type { ModelInfo, ProviderSummary } from '@shared/schemas/models';
import { errorText, invoke } from '../lib/ipc';

export interface ProviderModelsState {
  providerId: string;
  models: ModelInfo[];
  error: { code: string; message: string } | null;
}

interface AppState {
  phase: 'booting' | 'onboarding' | 'ready' | 'error';
  bootError: string | null;
  progress: { label: string; done: number; total: number } | null;
  quickSplash: boolean;
  /** Set once main has said whether this is a first launch (decides the splash style). */
  splashKnown: boolean;
  settings: AppSettings | null;
  providers: ProviderSummary[];
  environment: EnvironmentInfo | null;
  version: string;
  paths: { userData: string; graftHome: string } | null;
  models: ProviderModelsState[];
  modelsLoading: boolean;
  modelsError: string | null;
  projects: ProjectSummary[];
  projectsError: string | null;
  /** True right after onboarding, so home greets with "Welcome" instead of "Welcome back". */
  justOnboarded: boolean;
  boot: () => Promise<void>;
  setProgress: (label: string, done: number, total: number) => void;
  setSettings: (settings: AppSettings) => void;
  setProviders: (providers: ProviderSummary[]) => void;
  updateSettings: (patch: AppSettingsPatch) => Promise<AppSettings>;
  finishOnboarding: (settings: AppSettings) => void;
  loadModels: (refresh?: boolean) => Promise<void>;
  loadProjects: () => Promise<void>;
  upsertProject: (project: ProjectSummary) => void;
}

export const useApp = create<AppState>((set, get) => ({
  phase: 'booting',
  bootError: null,
  progress: null,
  quickSplash: false,
  splashKnown: false,
  settings: null,
  providers: [],
  environment: null,
  version: '',
  paths: null,
  models: [],
  modelsLoading: false,
  modelsError: null,
  projects: [],
  projectsError: null,
  justOnboarded: false,

  async boot() {
    set({ phase: 'booting', bootError: null });
    try {
      const quick = await invoke('app:quickSplash');
      set({ quickSplash: quick, splashKnown: true });
      const boot = await invoke('app:bootstrap');
      const done = get().progress;
      set({
        settings: boot.settings,
        providers: boot.providers,
        environment: boot.environment,
        version: boot.version,
        paths: boot.paths,
        progress: { label: 'Ready', done: done?.total ?? 1, total: done?.total ?? 1 }
      });
      if (!boot.firstRun) {
        void get().loadModels();
        void get().loadProjects();
      }
      set({ phase: boot.firstRun ? 'onboarding' : 'ready' });
    } catch (error) {
      set({ phase: 'error', bootError: errorText(error), splashKnown: true });
    }
  },

  setProgress(label, done, total) {
    set({ progress: { label, done, total } });
  },

  setSettings(settings) {
    set({ settings });
  },

  setProviders(providers) {
    set({ providers });
  },

  async updateSettings(patch) {
    const settings = await invoke('settings:update', patch);
    set({ settings });
    return settings;
  },

  finishOnboarding(settings) {
    set({ settings, phase: 'ready', justOnboarded: true });
    void get().loadModels();
    void get().loadProjects();
  },

  async loadModels(refresh = false) {
    set({ modelsLoading: true });
    try {
      const models = await invoke('models:list', { refresh });
      set({ models, modelsError: null });
    } catch (error) {
      set({ modelsError: errorText(error) });
    } finally {
      set({ modelsLoading: false });
    }
  },

  async loadProjects() {
    try {
      set({ projects: await invoke('projects:list'), projectsError: null });
    } catch (error) {
      set({ projectsError: errorText(error) });
    }
  },

  upsertProject(project) {
    const others = get().projects.filter((p) => p.id !== project.id);
    set({ projects: [project, ...others] });
  }
}));

export function allModels(state: Pick<AppState, 'models'>): ModelInfo[] {
  return state.models.flatMap((p) => p.models);
}

export function findModel(state: Pick<AppState, 'models'>, ref: ModelRef | null | undefined): ModelInfo | null {
  if (!ref) return null;
  return allModels(state).find((m) => m.ref.providerId === ref.providerId && m.ref.modelId === ref.modelId) ?? null;
}

export function sameRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId;
}
