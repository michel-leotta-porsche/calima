// Blitz in Calimas Kamera (#221): Aus, Auto, An wie in Apples Kamera. Die Einstellung bleibt auf dem Gerät; Einwegkameras
// bringen ihren Blitz selbst mit (Film-Regeln) und fragen hier nicht. Ob er ausgelöst hat, steht im Exif des Fotos.

export type FlashMode = "off" | "auto" | "on";

const ORDER: FlashMode[] = ["off", "auto", "on"];

export const nextFlash = (m: FlashMode): FlashMode => ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];

export const readFlash = (v: string | null | undefined): FlashMode => (ORDER.includes(v as FlashMode) ? (v as FlashMode) : "off");

/** Exif „Flash“: als Zahl ist Bit 0 „ausgelöst“, exifr übersetzt es sonst in einen Satz */
export function flashFired(v: unknown): boolean | undefined {
  if (typeof v === "number") return (v & 1) === 1;
  if (typeof v === "string") return /fired/i.test(v) && !/not fire/i.test(v);
  return undefined;
}
