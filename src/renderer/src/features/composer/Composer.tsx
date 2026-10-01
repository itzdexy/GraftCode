import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CornerDownLeft, Plus, Square, X } from 'lucide-react';
import type { SlashCommand } from '@shared/schemas/app';
import type { ImageBlock } from '@shared/schemas/messages';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { reportError, useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { filesToImages, imageSrc, MAX_IMAGES } from './attachments';
import { detectToken, useSuggestions, type Suggestion } from './suggestions';

export interface ComposerProps {
  /** Key under which the unsent text survives navigation. */
  draftKey: string;
  /** "code": compact box with controls below it. "chat": roomy box with controls inside. */
  variant: 'code' | 'chat';
  placeholder: string;
  /** False when the current model can't read images. */
  supportsImages: boolean;
  /** A turn is running: shows the stop button; Enter queues. */
  busy?: boolean;
  /** Blocks sending entirely (e.g. no model configured); the reason is shown as the tooltip. */
  blockedReason?: string | null;
  onSubmit: (text: string, images: ImageBlock[]) => Promise<boolean>;
  onInterrupt?: () => void;
  onCyclePermission?: () => void;
  leftControls?: ReactNode;
  rightControls?: ReactNode;
  /** Decoration anchored to the box's top-right edge (the mascot on Code home). */
  perch?: ReactNode;
  /** Enables the "/" command menu. */
  commands?: SlashCommand[] | null;
  /** Project folder for "@" file mentions; null disables them. */
  mentionRoot?: string | null;
  autoFocus?: boolean;
  className?: string;
}

const MAX_HEIGHT = 'min(40vh, 320px)';

/**
 * Message box shared by the home screens and sessions: autogrowing text,
 * Enter to send (Shift+Enter for a newline), image attachments by button,
 * paste or drop, Shift+Tab to cycle permission mode and Esc to stop.
 */
export function Composer({
  draftKey,
  variant,
  placeholder,
  supportsImages,
  busy = false,
  blockedReason = null,
  onSubmit,
  onInterrupt,
  onCyclePermission,
  leftControls,
  rightControls,
  perch,
  commands = null,
  mentionRoot = null,
  autoFocus = false,
  className
}: ComposerProps) {
  const text = useUi((s) => s.drafts[draftKey] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const [images, setImages] = useState<ImageBlock[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  const rawToken = commands || mentionRoot ? detectToken(text, caret) : null;
  const tokenKey = rawToken ? `${rawToken.kind}:${rawToken.start}:${rawToken.query}` : null;
  const token = rawToken && tokenKey !== dismissed ? rawToken : null;
  const suggestions = useSuggestions(token, commands, mentionRoot);
  const popupOpen = token !== null && (suggestions.items.length > 0 || suggestions.loading);
  const activeIndex = Math.min(active, Math.max(0, suggestions.items.length - 1));

  const focus = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    useUi.getState().registerComposer(focus);
    return () => {
      if (useUi.getState().focusComposer === focus) useUi.getState().registerComposer(null);
    };
  }, [focus]);

  useEffect(() => {
    if (autoFocus) focus();
  }, [autoFocus, focus]);

  // Autogrow: reset to one line, then fit the content (capped; beyond that it scrolls).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    if (!supportsImages) {
      useToasts.getState().push({ tone: 'info', title: "This model can't read images", description: 'Pick a vision-capable model to attach images.' });
      return;
    }
    try {
      const result = await filesToImages(files, MAX_IMAGES - images.length);
      if (result.images.length > 0) setImages((current) => [...current, ...result.images].slice(0, MAX_IMAGES));
      if (result.rejected.length > 0) useToasts.getState().push({ tone: 'error', title: 'Some files were not attached', description: result.rejected.join(' ') });
    } catch (error) {
      reportError("Couldn't attach the image", error);
    }
  };

  const hasContent = text.trim().length > 0 || images.length > 0;
  const canSend = hasContent && !sending && blockedReason === null;

  const submit = async (override?: string): Promise<void> => {
    const message = override ?? text;
    if ((message.trim().length === 0 && images.length === 0) || sending || blockedReason !== null) return;
    setSending(true);
    try {
      const sent = await onSubmit(message, images);
      if (sent) {
        setDraft(draftKey, '');
        setImages([]);
      }
    } catch (error) {
      reportError("Couldn't send the message", error);
    } finally {
      setSending(false);
    }
  };

  const choose = (item: Suggestion, viaEnter: boolean): void => {
    if (!token) return;
    const next = text.slice(0, token.start) + item.insert + text.slice(token.end);
    if (viaEnter && item.sendOnEnter && next.trim() === item.insert.trim()) {
      setDraft(draftKey, next);
      void submit(next);
      return;
    }
    pendingCaret.current = token.start + item.insert.length;
    setCaret(token.start + item.insert.length);
    setDraft(draftKey, next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (popupOpen) {
      const count = suggestions.items.length;
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
        event.preventDefault();
        setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && count > 0) {
        const item = suggestions.items[activeIndex];
        if (item) {
          event.preventDefault();
          choose(item, event.key === 'Enter');
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(tokenKey);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Tab' && event.shiftKey && onCyclePermission) {
      event.preventDefault();
      onCyclePermission();
    } else if (event.key === 'Escape' && busy && onInterrupt) {
      event.preventDefault();
      onInterrupt();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const attachButton = (
    <IconButton
      label={supportsImages ? 'Attach images' : "This model can't read images"}
      size="sm"
      disabled={!supportsImages}
      onClick={() => fileRef.current?.click()}
    >
      <Plus className="size-16" />
    </IconButton>
  );

  const actionButton = busy && onInterrupt && !hasContent ? (
    <IconButton label="Stop" size="sm" onClick={onInterrupt} className="text-icon-strong">
      <span className="flex size-16 items-center justify-center rounded-full border border-icon">
        <Square className="size-6 fill-current" strokeWidth={0} />
      </span>
    </IconButton>
  ) : (
    <IconButton
      label={blockedReason ?? (busy ? 'Queue message' : 'Send')}
      size="sm"
      disabled={!canSend}
      onClick={() => void submit()}
      className={cn(canSend && 'text-icon-strong')}
    >
      <CornerDownLeft className="size-16" />
    </IconButton>
  );

  const thumbnails =
    images.length > 0 ? (
      <ul className="flex flex-wrap gap-6 px-10 pt-8" aria-label="Attached images">
        {images.map((image, i) => (
          <li key={`${i}-${image.data.length}`} className="group relative">
            <img src={imageSrc(image)} alt={`Attachment ${i + 1}`} className="size-48 rounded-md border border-border object-cover" />
            <button
              type="button"
              aria-label={`Remove attachment ${i + 1}`}
              onClick={() => setImages((current) => current.filter((_, j) => j !== i))}
              className="absolute -top-5 -right-5 flex size-16 items-center justify-center rounded-full border border-border bg-surface text-icon opacity-0 transition-ui group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-10" />
            </button>
          </li>
        ))}
      </ul>
    ) : null;

  const textarea = (
    <textarea
      ref={textareaRef}
      value={text}
      rows={1}
      aria-label={placeholder}
      placeholder={placeholder}
      spellCheck
      onChange={(e) => {
        setDraft(draftKey, e.target.value);
        setCaret(e.target.selectionStart);
        setActive(0);
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={() => setDismissed(tokenKey)}
      onFocus={() => setDismissed(null)}
      role={popupOpen ? 'combobox' : undefined}
      aria-autocomplete={commands || mentionRoot ? 'list' : undefined}
      aria-expanded={popupOpen ? true : undefined}
      aria-controls={popupOpen ? listId : undefined}
      aria-activedescendant={popupOpen && suggestions.items.length > 0 ? `${listId}-${activeIndex}` : undefined}
      style={{ maxHeight: MAX_HEIGHT }}
      className={cn(
        'block w-full resize-none overflow-y-auto bg-transparent text-fg outline-none',
        variant === 'code' ? 'px-10 py-8 text-md leading-[1.4]' : 'px-14 pt-12 pb-4 text-prompt leading-[1.45]'
      )}
    />
  );

  const popup = popupOpen ? (
    <div
      id={listId}
      role="listbox"
      aria-label={token?.kind === 'slash' ? 'Commands' : 'Files'}
      className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-[var(--g-z-popover)] max-h-[260px] overflow-y-auto rounded-lg border border-border bg-surface p-4 shadow-popover"
    >
      {suggestions.items.length === 0 ? <p className="px-8 py-6 text-base text-fg-muted">Searching files…</p> : null}
      {suggestions.items.map((item, i) => (
        <div
          key={item.key}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            choose(item, false);
          }}
          onMouseMove={() => setActive(i)}
          className={cn('flex min-h-[var(--g-menu-row-height)] cursor-default items-center gap-12 rounded-md px-8', i === activeIndex && 'bg-hover')}
        >
          <span className={cn('shrink-0 text-base text-fg', token?.kind === 'mention' && 'min-w-0 flex-1 truncate font-mono text-sm')}>{item.label}</span>
          {item.detail ? <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{item.detail}</span> : null}
        </div>
      ))}
    </div>
  ) : null;

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      multiple
      accept="image/png,image/jpeg,image/gif,image/webp"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        void addFiles([...(e.target.files ?? [])]);
        e.target.value = '';
      }}
    />
  );

  const boxClass = cn(
    'relative border bg-surface shadow-composer transition-ui',
    dragOver ? 'border-blue' : 'border-border focus-within:border-border-strong'
  );

  const dropProps = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        setDragOver(true);
      }
    },
    onDragLeave: () => setDragOver(false),
    onDrop
  };

  if (variant === 'chat') {
    return (
      <div className={cn('relative', className)}>
        {fileInput}
        {popup}
        <div className={cn(boxClass, 'flex min-h-[var(--g-home-composer-height)] flex-col rounded-xl')} {...dropProps}>
          {perch}
          {thumbnails}
          {textarea}
          <div className="mt-auto flex items-center gap-6 px-8 pb-8">
            {attachButton}
            {leftControls}
            <div className="flex-1" />
            {rightControls}
            {actionButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      {fileInput}
      {popup}
      <div className={cn(boxClass, 'rounded-lg')} {...dropProps}>
        {perch}
        {thumbnails}
        <div className="flex items-end">
          <div className="min-w-0 flex-1">{textarea}</div>
          <div className="flex shrink-0 items-center py-5 pr-5">{actionButton}</div>
        </div>
      </div>
      <div className="mt-6 flex h-24 items-center gap-2">
        {attachButton}
        {leftControls}
        <div className="flex-1" />
        {rightControls}
      </div>
    </div>
  );
}
