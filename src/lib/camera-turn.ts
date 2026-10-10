// Querformat (#221): die Oberfläche der Kamera bleibt hochkant, damit der Sucher nicht springt; nur die Knöpfe drehen
// sich mit, wie in Apples Kamera. Das Foto selbst dreht die App nach der Lage des Telefons (CalimaCamera.swift, angle()).

/** Lage des Telefons, wie die App sie im Ereignis „orientation“ meldet (UIDeviceOrientation) */
export type Orientation = "portrait" | "portraitUpsideDown" | "landscapeLeft" | "landscapeRight" | "faceUp" | "faceDown" | "unknown";

/** um wie viel Grad die Knöpfe drehen; flach, auf dem Kopf oder unbekannt bleibt es bei der letzten Drehung */
export function turnFor(o: string | undefined, last: number): number {
  if (o === "portrait") return 0;
  if (o === "landscapeLeft") return 90;
  if (o === "landscapeRight") return -90;
  return last;
}
