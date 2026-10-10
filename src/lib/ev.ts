import type { Dials } from "@/lib/camera";

// Heller/Dunkler im Sucher (#224). Auf Vollautomatik ist es Apples Belichtungskorrektur. Steht nur Zeit oder nur ISO von
// Hand, regelt die App das andere Rad nach und zielt dabei auf die Korrektur (CalimaCamera.swift, meter). Stehen beide
// von Hand, gibt es nichts mehr nachzuregeln: dann sagt der Sucher das, statt einen Wert zu zeigen, der nichts tut.

export const EV_MAX = 2;
/** Striche der Skala, in Dritteln wie an einer Kamera */
export const EV_TICKS = Array.from({ length: 6 * EV_MAX + 1 }, (_, i) => (i - 3 * EV_MAX) / 3);

export type EvMode = "auto" | "semi" | "manual";
export const evMode = (d: Dials): EvMode => (d.duration != null && d.iso != null ? "manual" : d.duration != null || d.iso != null ? "semi" : "auto");

/** auf das nächste Drittel, höchstens ±EV_MAX */
export const evStep = (raw: number) => Math.round(Math.min(EV_MAX, Math.max(-EV_MAX, raw)) * 3) / 3;

const THIRDS = ["", "⅓", "⅔"];
export function evLabel(ev: number): string {
  const n = Math.round(Math.abs(ev) * 3);
  if (!n) return "±0";
  const whole = Math.floor(n / 3);
  return `${ev > 0 ? "+" : "−"}${whole || !THIRDS[n % 3] ? whole : ""}${THIRDS[n % 3]}`;
}
