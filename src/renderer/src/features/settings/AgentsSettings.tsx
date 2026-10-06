import { useId, useMemo } from 'react';
import { MODEL_ROLE_HELP, MODEL_ROLE_LABELS, MODEL_ROLES, type ModelRoleId } from '@shared/schemas/agentRuns';
import type { AppSettings } from '@shared/schemas/appSettings';
import type { ModelInfo } from '@shared/schemas/models';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { BUDGET_CHOICES, budgetLabel, modelKey, modelOfKey, roleModelOptions } from './agentSettings';
import { Group, saveSettings, SettingRow } from './common';

const ROUTINGS: Array<{ value: AppSettings['agents']['routing']; label: string }> = [
  { value: 'session', label: 'Session’s model' },
  { value: 'auto', label: 'Automatic' }
];

const SELECT = 'h-28 rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong';

/** `wide`: one fixed width, so a column of them lines up whatever each one lists. */
function Choice({ id, value, onChange, options, label, wide = false }: { id?: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; label: string; wide?: boolean }) {
  return (
    <select id={id} aria-label={id ? undefined : label} value={value} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, wide ? 'w-[240px]' : 'max-w-[260px]')}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function RoleRow({ role, agents, models, providerLabels }: { role: ModelRoleId; agents: AppSettings['agents']; models: ModelInfo[]; providerLabels: Record<string, string> }) {
  const id = useId();
  const current = agents.roles[role];
  const options = roleModelOptions(role, models, current, agents.routing, providerLabels);
  return (
    <SettingRow
      label={MODEL_ROLE_LABELS[role]}
      description={MODEL_ROLE_HELP[role]}
      labelFor={id}
      control={
        <Choice
          wide
          id={id}
          label={MODEL_ROLE_LABELS[role]}
          value={current ? modelKey(current) : ''}
          options={options}
          onChange={(key) => saveSettings({ agents: { roles: { ...agents.roles, [role]: modelOfKey(key, models) } } }, "Couldn't change the model for that work")}
        />
      }
    />
  );
}

/** Settings → Models → Agents: which model each kind of agent work runs on, and what a group may use. */
export function AgentsSettings({ models }: { models: ModelInfo[] }) {
  const agents = useApp((s) => s.settings?.agents);
  const providers = useApp((s) => s.providers);
  const providerLabels = useMemo(() => Object.fromEntries(providers.map((p) => [p.id, p.label])), [providers]);
  const parallelId = useId();
  const budgetId = useId();
  const retriesId = useId();
  if (!agents) return null;
  const budgets = BUDGET_CHOICES.includes(agents.tokenBudget) ? BUDGET_CHOICES : [...BUDGET_CHOICES, agents.tokenBudget];

  return (
    <>
      <Group
        title="Agents"
        description="When a task splits up, Graft can run it as a group of agents, each with a role, a context of its own and its own model. Ask for it in a code session; the Agents panel shows the group as a graph."
      >
        <SettingRow
          label="Models for agents"
          description={
            agents.routing === 'auto'
              ? 'Automatic: quick reading and research go to the cheapest capable model from the same provider as the session; work that needs the strongest reasoning stays on the session’s model.'
              : 'Every agent runs on the session’s model, unless its kind of work has a model of its own below.'
          }
        >
          <div role="radiogroup" aria-label="Models for agents" className="flex self-start rounded-md border border-border p-2">
            {ROUTINGS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={agents.routing === value}
                onClick={() => saveSettings({ agents: { routing: value } })}
                className={cn('h-24 rounded-sm px-10 text-sm whitespace-nowrap transition-ui', agents.routing === value ? 'bg-hover text-fg-strong' : 'text-fg-muted hover:text-fg-secondary')}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        {MODEL_ROLES.map((role) => (
          <RoleRow key={role} role={role} agents={agents} models={models} providerLabels={providerLabels} />
        ))}
      </Group>

      <Group title="Agent limits" description="What one group of agents may use. Each agent also stops at a time limit set by its role.">
        <SettingRow
          label="Agents working at once"
          description="Agents that only read run side by side up to this many, and so do agents that change files when each is given its own paths. An agent that may change any file, or drives the browser, runs alone."
          labelFor={parallelId}
          control={
            <Choice
              id={parallelId}
              label="Agents working at once"
              value={String(agents.maxParallel)}
              options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(value) => saveSettings({ agents: { maxParallel: Number(value) } })}
            />
          }
        />
        <SettingRow
          label="Token budget for each agent"
          description="An agent that spends more than this is stopped and reports as failed. The spending counts towards the session as usual."
          labelFor={budgetId}
          control={
            <Choice
              id={budgetId}
              label="Token budget for each agent"
              value={agents.tokenBudget === null ? '' : String(agents.tokenBudget)}
              options={budgets.map((n) => ({ value: n === null ? '' : String(n), label: budgetLabel(n) }))}
              onChange={(value) => saveSettings({ agents: { tokenBudget: value === '' ? null : Number(value) } })}
            />
          }
        />
        <SettingRow
          label="Tries again after a provider failure"
          description="Only failures of the model provider (rate limits, overload, network) are tried again. A failed check, a refusal or a spent budget is not."
          labelFor={retriesId}
          control={
            <Choice
              id={retriesId}
              label="Tries again after a provider failure"
              value={String(agents.retries)}
              options={[
                { value: '0', label: 'Never' },
                { value: '1', label: 'Once' },
                { value: '2', label: 'Twice' },
                { value: '3', label: '3 times' }
              ]}
              onChange={(value) => saveSettings({ agents: { retries: Number(value) } })}
            />
          }
        />
      </Group>
    </>
  );
}
