import { useRef, useState } from "react";
import type { CropRect } from "../lib/image";

interface Props {
  src: string;
  initial?: CropRect;
  onCancel(): void;
  onDone(crop: CropRect | undefined): void;
}

/**
 * Recorte sencillo: se arrastra un rectángulo sobre la foto.
 * Sirve para enviar solo la columna de fechas y la propia, sin las de compañeros.
 */
export function PhotoCrop({ src, initial, onCancel, onDone }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<CropRect | undefined>(initial);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  return (
    <div className="modal" role="dialog" aria-label="Recortar foto">
      <div className="modal-card crop-card">
        <p className="muted">Arrastra para quedarte con las fechas y tu columna.</p>
        <div
          ref={boxRef}
          className="crop-box"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            start.current = point(e);
            setRect({ ...start.current, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const p = point(e);
            const s = start.current;
            setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
          }}
          onPointerUp={() => {
            start.current = null;
            setRect((r) => (r && r.w > 0.02 && r.h > 0.02 ? r : undefined));
          }}
        >
          <img src={src} alt="" draggable={false} />
          {rect && (
            <div
              className="crop-rect"
              style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
            />
          )}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setRect(undefined)}>Sin recorte</button>
          <button className="btn ghost" onClick={onCancel}>Cancelar</button>
          <button className="btn" onClick={() => onDone(rect)}>Usar</button>
        </div>
      </div>
    </div>
  );
}
