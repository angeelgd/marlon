import type { ChatImage } from "@marlon/shared";

export interface CropRect {
  /** Fracciones 0..1 respecto a la imagen original. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo abrir la imagen."));
    };
    img.src = url;
  });
}

/**
 * Recorta (opcional) y reduce la imagen en el navegador antes de enviarla:
 * menos datos de terceros, menos CPU en el Worker y menos tokens.
 */
export async function prepareImage(file: Blob, crop?: CropRect, maxSide = 1600): Promise<ChatImage> {
  const img = await loadImage(file);
  const sx = Math.round((crop?.x ?? 0) * img.naturalWidth);
  const sy = Math.round((crop?.y ?? 0) * img.naturalHeight);
  const sw = Math.max(1, Math.round((crop?.w ?? 1) * img.naturalWidth));
  const sh = Math.max(1, Math.round((crop?.h ?? 1) * img.naturalHeight));
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("El navegador no permite procesar la imagen.");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
