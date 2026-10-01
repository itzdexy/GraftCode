import { useId } from 'react';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';

/** "All projects" or one project, for settings that exist per scope. */
export function ProjectPicker({ value, onChange, className }: { value: string | null; onChange: (projectPath: string | null) => void; className?: string }) {
  const projects = useApp((s) => s.projects);
  const id = useId();
  return (
    <div className={cn('flex items-center gap-8', className)}>
      <label htmlFor={id} className="text-sm text-fg-muted">
        Project
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-28 w-[200px] rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
      >
        <option value="">None (all projects only)</option>
        {projects.map((p) => (
          <option key={p.id} value={p.path}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
