import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { Slider } from '../../components/Slider';
import { clampCrop, coverScale, type CropState } from '../../lib/image';

export const CROP_VIEWPORT = 192;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
const PAN_STEP = 8;
const ZOOM_STEP = 0.1;

interface AvatarCropperProps {
  image: HTMLImageElement;
  crop: CropState;
  onChange: (crop: CropState) => void;
}

/**
 * Circular crop: drag (or arrow keys) to move the picture, wheel / slider /
 * +/- to zoom. The preview is drawn to a canvas at device resolution.
 */
export function AvatarCropper({ image, crop, onChange }: AvatarCropperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: CropState } | null>(null);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const update = (next: CropState): void => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
    onChange(clampCrop({ ...next, zoom }, w, h, CROP_VIEWPORT));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CROP_VIEWPORT * dpr;
    canvas.height = CROP_VIEWPORT * dpr;
    const scale = coverScale(w, h, CROP_VIEWPORT) * crop.zoom;
    const dw = w * scale;
    const dh = h * scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CROP_VIEWPORT, CROP_VIEWPORT);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, (CROP_VIEWPORT - dw) / 2 + crop.x, (CROP_VIEWPORT - dh) / 2 + crop.y, dw, dh);
  }, [image, crop, w, h]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: crop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    update({ zoom: d.origin.zoom, x: d.origin.x + event.clientX - d.startX, y: d.origin.y + event.clientY - d.startY });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    update({ ...crop, zoom: crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-PAN_STEP, 0],
      ArrowRight: [PAN_STEP, 0],
      ArrowUp: [0, -PAN_STEP],
      ArrowDown: [0, PAN_STEP]
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      update({ ...crop, x: crop.x + move[0], y: crop.y + move[1] });
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      update({ ...crop, zoom: crop.zoom + ZOOM_STEP });
    } else if (event.key === '-') {
      event.preventDefault();
      update({ ...crop, zoom: crop.zoom - ZOOM_STEP });
    }
  };

  return (
    <div className="flex flex-col items-center gap-12">
      <div
        role="img"
        tabIndex={0}
        aria-label="Picture crop. Drag or use the arrow keys to move it; use plus and minus to zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className="relative cursor-grab touch-none overflow-hidden rounded-full bg-control active:cursor-grabbing"
        style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }}
      >
        <canvas ref={canvasRef} className="block size-full" style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }} />
      </div>
      <div className="flex w-[220px] items-center gap-8 text-icon-muted">
        <ZoomOut className="size-14 shrink-0" aria-hidden="true" />
        <Slider
          value={crop.zoom}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          onChange={(zoom) => update({ ...crop, zoom })}
          label="Zoom"
          valueText={`${Math.round(crop.zoom * 100)}%`}
        />
        <ZoomIn className="size-14 shrink-0" aria-hidden="true" />
      </div>
    </div>
  );
}
