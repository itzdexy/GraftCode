import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import './editorContribs';
import { Dialog, DialogContent } from '../../components/Dialog';
import { editorLanguageForPath } from '../../lib/highlight';
import { useApp } from '../../stores/app';

/** The file on disk beside the unsaved draft, as a read-only diff: what Take theirs would drop and Keep mine would overwrite. */
export default function DiskCompare({ path, disk, draft, onClose }: { path: string; disk: string; draft: string; onClose: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const fontSize = useApp((s) => s.settings?.appearance.codeFontSize ?? 13);
  useEffect(() => {
    if (!host) return;
    const language = editorLanguageForPath(path);
    const original = monaco.editor.createModel(disk, language);
    const modified = monaco.editor.createModel(draft, language);
    const diff = monaco.editor.createDiffEditor(host, {
      readOnly: true, originalEditable: false, automaticLayout: true, useInlineViewWhenSpaceIsLimited: true,
      originalAriaLabel: `${path} on disk`, modifiedAriaLabel: `${path}, your draft`, accessibilitySupport: 'on',
      fontFamily: '"JetBrains Mono Variable", monospace', fontSize, minimap: { enabled: false }, scrollBeyondLastLine: false
    });
    diff.setModel({ original, modified });
    return () => {
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [host, path, disk, draft, fontSize]);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title="Compare with the file on disk" description={`${path}: the file on disk on the left, your draft on the right.`} className="w-[min(1100px,calc(100vw-48px))]!">
        <div ref={setHost} className="h-[60vh] min-h-[240px] pb-12" />
      </DialogContent>
    </Dialog>
  );
}
