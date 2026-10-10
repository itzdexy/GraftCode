import { Eye } from 'lucide-react';
import { TRANSCRIPT_VIEWS } from '@shared/schemas/appSettings';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../../components/Menu';
import { TRANSCRIPT_VIEW_INFO } from '../../lib/format';
import { useApp } from '../../stores/app';
import { saveSettings } from '../settings/common';

/** The eye under a code session's composer: how the transcript shows a turn's work, for every session. */
export function TranscriptViewMenu() {
  const value = useApp((s) => s.settings?.appearance.transcriptView ?? 'normal');
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton label={`Transcript view: ${TRANSCRIPT_VIEW_INFO[value].label}`} size="sm">
          <Eye className="size-14" />
        </IconButton>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-[300px]">
        <MenuLabel>Transcript view</MenuLabel>
        {TRANSCRIPT_VIEWS.map((view) => (
          <MenuItem key={view} checked={view === value} description={TRANSCRIPT_VIEW_INFO[view].description} onSelect={() => saveSettings({ appearance: { transcriptView: view } })}>
            {TRANSCRIPT_VIEW_INFO[view].label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
