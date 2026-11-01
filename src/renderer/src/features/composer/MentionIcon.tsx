import { CircleAlert, FileText, Folder, GitCompareArrows, Globe, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { MentionKind } from './suggestions';

const ICONS: Record<MentionKind, LucideIcon> = {
  file: FileText,
  folder: Folder,
  diff: GitCompareArrows,
  problems: CircleAlert,
  terminal: SquareTerminal,
  url: Globe
};

/** What an "@" row attaches, as a picture beside its text; the text says it too, so the picture is not read out. */
export function MentionIcon({ kind }: { kind: MentionKind }) {
  const Icon = ICONS[kind];
  return <Icon className="size-14 shrink-0 text-icon" aria-hidden="true" />;
}
