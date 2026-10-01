import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { NicknameSchema } from '@shared/schemas/appSettings';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { errorText, invoke } from '../../lib/ipc';
import { ImageInputError, loadImageFile, renderCrop, type CropState } from '../../lib/image';
import { useApp } from '../../stores/app';
import { reportError, useToasts } from '../../stores/toasts';
import { AvatarCropper, CROP_VIEWPORT } from '../onboarding/AvatarCropper';
import { Group, SettingRow } from './common';

const INITIAL_CROP: CropState = { zoom: 1, x: 0, y: 0 };

/** Picks, crops and saves a new profile picture. Mounted only while open. */
function AvatarDialog({ onClose }: { onClose: () => void }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropState>(INITIAL_CROP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    try {
      setImage(await loadImageFile(file));
      setCrop(INITIAL_CROP);
    } catch (e) {
      setError(e instanceof ImageInputError ? e.message : errorText(e));
    }
  };

  const save = async (): Promise<void> => {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await invoke('profile:update', { avatar: renderCrop(image, crop, CROP_VIEWPORT, 256) });
      useApp.getState().setSettings(settings);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title="Profile picture"
      description="Drag to position, scroll or use the slider to zoom. The picture stays on this computer."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!image || busy}>
            {busy ? 'Saving…' : 'Save picture'}
          </Button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="flex flex-col items-center gap-12 pb-8">
        {image ? <AvatarCropper image={image} crop={crop} onChange={setCrop} /> : null}
        <Button variant="secondary" leading={<ImagePlus className="size-14" />} onClick={() => inputRef.current?.click()}>
          {image ? 'Choose another' : 'Choose image'}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

export function ProfileSection() {
  const profile = useApp((s) => s.settings?.profile);
  const savedName = profile?.name ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pictureOpen, setPictureOpen] = useState(false);
  const name = draft ?? savedName;
  const dirty = draft !== null && draft.trim() !== savedName;

  const saveName = async (): Promise<void> => {
    const parsed = NicknameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name.');
      return;
    }
    try {
      const settings = await invoke('profile:update', { name: parsed.data });
      useApp.getState().setSettings(settings);
      setDraft(null);
      setError(null);
      useToasts.getState().push({ tone: 'success', title: 'Name saved' });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const removePicture = (): void => {
    invoke('profile:update', { avatar: null })
      .then((settings) => useApp.getState().setSettings(settings))
      .catch((e: unknown) => reportError("Couldn't remove the picture", e));
  };

  return (
    <div className="flex flex-col gap-24">
      <Group>
        <SettingRow
          label="Picture"
          description="Shown in the sidebar and next to your messages."
          control={
            <>
              {profile?.avatar ? (
                <Button size="sm" variant="ghost" onClick={removePicture}>
                  Remove
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => setPictureOpen(true)}>
                Change
              </Button>
              <Avatar name={savedName} src={profile?.avatar ?? null} size={40} />
            </>
          }
        />
        <div className="px-14 py-12">
          <form
            className="flex items-end gap-8"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <TextField
              label="Name"
              value={name}
              maxLength={40}
              className="max-w-[320px] flex-1"
              error={error}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
            />
            <Button type="submit" variant="secondary" disabled={!dirty} className={error ? 'mb-26' : undefined}>
              Save
            </Button>
          </form>
        </div>
      </Group>
      <Dialog open={pictureOpen} onOpenChange={setPictureOpen}>
        {pictureOpen ? <AvatarDialog onClose={() => setPictureOpen(false)} /> : null}
      </Dialog>
    </div>
  );
}
