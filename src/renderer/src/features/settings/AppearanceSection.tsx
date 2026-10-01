import { Monitor, Moon, Sun } from 'lucide-react';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/appSettings';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Field';
import { Slider } from '../../components/Slider';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { Group, saveSettings, SettingRow } from './common';

const THEMES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun }
] as const;

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
      <Group>
        <SettingRow label="Theme" description="System follows your operating system's light or dark setting.">
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-8">
            {THEMES.map(({ value, label, icon: Icon }) => {
              const selected = appearance.theme === value;
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
