import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { DEFAULT_APP_SETTINGS, type AccentId, type AppSettings, type PaletteId } from '@shared/schemas/appSettings';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Field';
import { Slider } from '../../components/Slider';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { Group, saveSettings, SettingRow } from './common';
import { ACCENTS, PALETTES } from './sections';

const WIDTHS = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'medium', label: 'Medium' },
  { value: 'wide', label: 'Wide' }
] as const;

const THEMES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun }
] as const;

/** A small window drawn with a palette's own tokens (palettes.css preview selectors). */
function PalettePreview({ palette, accent }: { palette: PaletteId; accent: AccentId }) {
  const line = 'block h-4 rounded-full';
  return (
    <div data-palette-preview={palette} data-accent-preview={accent} aria-hidden="true" className="flex h-[64px] overflow-hidden bg-bg">
      <div className="flex w-[34%] flex-col gap-5 border-r border-border-subtle bg-sidebar px-6 py-8">
        <span className={cn(line, 'w-[70%] bg-[var(--g-text-muted)]')} />
        <span className={cn(line, 'w-full bg-selected')} />
        <span className={cn(line, 'w-[55%] bg-[var(--g-text-faint)] opacity-60')} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-5 px-8 py-8">
        <span className={cn(line, 'w-[80%] bg-[var(--g-text)]')} />
        <span className={cn(line, 'w-[60%] bg-[var(--g-text-secondary)] opacity-70')} />
        <div className="mt-auto flex h-14 items-center justify-end rounded-sm border border-border bg-surface px-3">
          <span className="size-8 rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}

function ColorsGroup({ theme, palette, accent }: { theme: AppSettings['appearance']['theme']; palette: PaletteId; accent: AccentId }) {
  return (
    <Group title="Colors">
      <SettingRow label="Theme" description="System follows your operating system's light or dark setting.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-8">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const selected = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => saveSettings({ appearance: { theme: value } })}
                className={cn(
                  'flex h-36 items-center justify-center gap-8 rounded-md border text-base transition-ui',
                  selected ? 'border-border-strong bg-hover text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover'
                )}
              >
                <Icon className="size-14" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow label="Palette" description="The colors of every surface. Each palette has a light and a dark version.">
        <div role="radiogroup" aria-label="Palette" className="grid grid-cols-3 gap-8">
          {PALETTES.map((p) => {
            const selected = palette === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${p.label}: ${p.description}`}
                onClick={() => saveSettings({ appearance: { palette: p.id } })}
                className={cn(
                  'group flex flex-col overflow-hidden rounded-md border text-left transition-ui',
                  selected ? 'border-accent ring-1 ring-[var(--g-accent)]' : 'border-border hover:border-border-strong'
                )}
              >
                <PalettePreview palette={p.id} accent={accent} />
                <span className="flex items-center gap-6 border-t border-border-subtle px-8 py-6">
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-base', selected ? 'font-medium text-fg-strong' : 'text-fg')}>{p.label}</span>
                    <span className="block truncate text-sm text-fg-muted">{p.description}</span>
                  </span>
                  {selected ? <Check className="size-14 shrink-0 text-accent" aria-hidden="true" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow
        label="Accent"
        description="Switches, badges, progress and highlights."
        control={
          <div role="radiogroup" aria-label="Accent color" className="flex items-center gap-6">
            {ACCENTS.map((a) => {
              const selected = accent === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={a.label}
                  title={a.label}
                  data-accent-preview={a.id}
                  onClick={() => saveSettings({ appearance: { accent: a.id } })}
                  className={cn(
                    'flex size-22 items-center justify-center rounded-full bg-accent transition-ui hover:scale-110',
                    selected && 'ring-2 ring-[var(--g-text-strong)] ring-offset-2 ring-offset-[var(--g-surface-raised)]'
                  )}
                >
                  {selected ? <Check className="size-12 text-[var(--g-bg)]" strokeWidth={3} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        }
      />
    </Group>
  );
}

function SizeRow({ label, description, value, min, max, fallback, onChange }: { label: string; description: string; value: number; min: number; max: number; fallback: number; onChange: (value: number) => void }) {
  return (
    <SettingRow
      label={label}
      description={description}
      control={
        <>
          <div className="w-[160px]">
            <Slider label={label} value={value} min={min} max={max} step={1} valueText={`${value} pixels`} onChange={onChange} />
          </div>
          <span className="w-36 text-right text-sm text-fg-secondary tabular-nums">{value}px</span>
          <Button size="sm" variant="ghost" disabled={value === fallback} onClick={() => onChange(fallback)}>
            Reset
          </Button>
        </>
      }
    />
  );
}

export function AppearanceSection() {
  const appearance = useApp((s) => s.settings?.appearance);
  if (!appearance) return null;
  const defaults = DEFAULT_APP_SETTINGS.appearance;

  return (
    <div className="flex flex-col gap-24">
      <ColorsGroup theme={appearance.theme} palette={appearance.palette} accent={appearance.accent} />
      <Group title="Layout and text">
        <SettingRow
          label="Transcript width"
          description="How wide conversations and the message box get on large windows."
          control={
            <div role="radiogroup" aria-label="Transcript width" className="flex rounded-md border border-border p-2">
              {WIDTHS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={appearance.transcriptWidth === value}
                  onClick={() => saveSettings({ appearance: { transcriptWidth: value } })}
                  className={cn(
                    'h-24 rounded-sm px-10 text-sm transition-ui',
                    appearance.transcriptWidth === value ? 'bg-hover text-fg-strong' : 'text-fg-muted hover:text-fg-secondary'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <SizeRow
          label="Interface text size"
          description="Menus, the sidebar and messages."
          value={appearance.uiFontSize}
          min={11}
          max={18}
          fallback={defaults.uiFontSize}
          onChange={(uiFontSize) => saveSettings({ appearance: { uiFontSize } })}
        />
        <SizeRow
          label="Code text size"
          description="Code blocks, diffs and the terminal."
          value={appearance.codeFontSize}
          min={10}
          max={20}
          fallback={defaults.codeFontSize}
          onChange={(codeFontSize) => saveSettings({ appearance: { codeFontSize } })}
        />
        <SettingRow
          label="Reduce motion"
          description="Turns off animations such as the thinking mark and menu transitions."
          control={<Switch label="Reduce motion" checked={appearance.reducedMotion} onChange={(reducedMotion) => saveSettings({ appearance: { reducedMotion } })} />}
        />
      </Group>
    </div>
  );
}
