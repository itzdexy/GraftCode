import {
  APP_SETTINGS_SECTIONS,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsPatch,
  type AppSettingsSection
} from '@shared/schemas/appSettings';
import { GraftError } from '@shared/errors';
import type { Db } from '../db/database';
import { log } from '../app/log';

type Listener = (settings: AppSettings, previous: AppSettings) => void;

/**
 * App preferences, stored one JSON row per section. Unknown or invalid stored
 * values fall back to defaults section by section, so one bad row never
 * resets everything.
 */
export class AppSettingsService {
  private current: AppSettings;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: Db) {
    this.current = this.load();
  }

  get(): AppSettings {
    return this.current;
  }

  update(patch: AppSettingsPatch): AppSettings {
    const previous = this.current;
    const next = structuredClone(previous) as Record<AppSettingsSection, unknown>;
    const changed: AppSettingsSection[] = [];
    for (const section of APP_SETTINGS_SECTIONS) {
      const partial = patch[section];
      if (partial === undefined) continue;
      next[section] = { ...previous[section], ...partial };
      changed.push(section);
    }
    const parsed = AppSettingsSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new GraftError('invalid_settings', `Invalid setting ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
    }
    const write = this.db.prepare(
      'INSERT INTO app_settings (section, value) VALUES (?, ?) ON CONFLICT(section) DO UPDATE SET value = excluded.value'
    );
    const tx = this.db.transaction(() => {
      for (const section of changed) write.run(section, JSON.stringify(parsed.data[section]));
    });
    tx();
    this.current = parsed.data;
    for (const listener of this.listeners) listener(this.current, previous);
    return this.current;
  }

  /** Restores one section to defaults (used by "Reset onboarding"). */
  reset(section: AppSettingsSection): AppSettings {
    const patch: AppSettingsPatch = { [section]: DEFAULT_APP_SETTINGS[section] };
    return this.update(patch);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): AppSettings {
    const rows = this.db.prepare('SELECT section, value FROM app_settings').all() as Array<{ section: string; value: string }>;
    const stored = new Map(rows.map((r) => [r.section, r.value]));
    const result = structuredClone(DEFAULT_APP_SETTINGS) as Record<AppSettingsSection, unknown>;
    for (const section of APP_SETTINGS_SECTIONS) {
      const raw = stored.get(section);
      if (raw === undefined) continue;
      try {
        const merged = { ...(DEFAULT_APP_SETTINGS[section] as object), ...(JSON.parse(raw) as object) };
        const parsed = AppSettingsSchema.shape[section].safeParse(merged);
        if (parsed.success) result[section] = parsed.data;
        else log.warn('settings', 'Stored settings section invalid; using defaults', { section });
      } catch (error) {
        log.warn('settings', 'Stored settings section unreadable; using defaults', {
          section,
          message: (error as Error).message
        });
      }
    }
    return AppSettingsSchema.parse(result);
  }
}
