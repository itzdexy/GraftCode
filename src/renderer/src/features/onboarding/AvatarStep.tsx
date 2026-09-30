import { useRef, useState, type DragEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { errorText, invoke } from '../../lib/ipc';
import { ImageInputError, loadImageFile, renderCrop, type CropState } from '../../lib/image';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { AvatarCropper, CROP_VIEWPORT } from './AvatarCropper';
import { StepLayout, type StepProps } from './StepLayout';

const INITIAL_CROP: CropState = { zoom: 1, x: 0, y: 0 };

export function AvatarStep({ onNext, onBack }: StepProps) {
  const name = useApp((s) => s.settings?.profile.name ?? '');
  const saved = useApp((s) => s.settings?.profile.avatar ?? null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropState>(INITIAL_CROP);
  const [dragOver, setDragOver] = useState(false);
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

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    void take(event.dataTransfer.files[0]);
  };

  const save = async (avatar: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const settings = await invoke('profile:update', { avatar });
      useApp.getState().setSettings(settings);
      await onNext();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (image) {
      let dataUrl: string;
      try {
        dataUrl = renderCrop(image, crop, CROP_VIEWPORT, 256);
      } catch (e) {
        setError(errorText(e));
        return;
      }
      await save(dataUrl);
    } else {
      setBusy(true);
      try {
        await onNext();
      } catch (e) {
        setError(errorText(e));
        setBusy(false);
      }
    }
  };

  const hasPicture = image !== null || saved !== null;
  const chooseButton = (
    <Button variant="secondary" data-autofocus onClick={() => inputRef.current?.click()} leading={<ImagePlus className="size-14" />}>
      {hasPicture ? 'Choose another' : 'Choose image'}
    </Button>
  );

  return (
    <StepLayout
      title="Add a profile picture"
      description="Optional. It stays on this computer. Skip it and Graft uses your initial."
      onSubmit={submit}
      onBack={onBack}
      primaryLabel={hasPicture ? 'Continue' : 'Skip'}
      primaryVariant={hasPicture ? 'primary' : 'secondary'}
      busy={busy}
      error={error}
      extra={
        saved !== null && image === null ? (
          <Button variant="ghost" onClick={() => void save(null)} disabled={busy}>
            Remove picture
          </Button>
        ) : null
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
      {image ? (
        <div className="flex flex-col items-center gap-16">
          <AvatarCropper image={image} crop={crop} onChange={setCrop} />
          <div className="flex gap-8">
            {chooseButton}
            <Button variant="ghost" onClick={() => setImage(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center gap-16 rounded-xl border border-dashed px-24 py-28 transition-ui',
            dragOver ? 'border-border-strong bg-hover' : 'border-border'
          )}
        >
          <Avatar name={name} src={saved} size={88} />
          <p className="text-base text-fg-muted">Drag an image here, or</p>
          {chooseButton}
        </div>
      )}
    </StepLayout>
  );
}
