import { Ghost } from 'lucide-react';
import { Button } from '../../components/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { incognitoNote } from './privacyText';

/** "Incognito" marker in a chat header; opens what that means for this chat's data. */
export function IncognitoBadge({ providerId }: { providerId: string | null }) {
  const provider = useApp((s) => s.providers.find((p) => p.id === providerId));
  const localOnly = useApp((s) => s.settings?.privacy.incognitoLocalOnly ?? false);
  const note = incognitoNote(provider, localOnly);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-20 shrink-0 items-center gap-4 rounded-xs bg-control px-6 text-2xs font-medium text-fg-secondary transition-ui hover:bg-hover data-[state=open]:bg-hover"
        >
          <Ghost className="size-10" aria-hidden="true" />
          Incognito · not saved
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-[300px] p-12">
        <p className="text-base font-medium text-fg-strong">Incognito chat</p>
        <p className="mt-4 text-sm text-fg-muted">
          Graft doesn’t save this chat or name it with a model, keeps your profile name out of it, and leaves its text out of notifications. It’s gone
          when you delete it or quit.
        </p>
        <p className={note.blocked ? 'mt-8 text-sm text-danger' : 'mt-8 text-sm text-fg-muted'}>{note.text}</p>
        <Button size="sm" variant="secondary" className="mt-10" onClick={() => useNav.getState().go({ name: 'settings', section: 'privacy' })}>
          Privacy settings
        </Button>
      </PopoverContent>
    </Popover>
  );
}
