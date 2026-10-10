import type { Dials, Gains } from "@/lib/camera";

// Das Licht am Weiß-Rad (white-dial.tsx) und die Weiß-Pipette (#184). Ohne JSX, damit die Tests es laden können.

// Namen nicht über t(): „Schatten“ heißt im Fotostudio „Shadows“, hier das Licht im Schatten („Shade“)
export type Light = { id: string; name: string; en: string; kelvin: number | null; tint: number; icon: string };
/** Kelvin sind Richtwerte der üblichen Kameravoreinstellungen; Neon zieht mit Magenta gegen den Grünstich */
export const LIGHTS: Light[] = [
  { id: "auto", name: "Auto", en: "Auto", kelvin: null, tint: 0, icon: "a" },
  { id: "kunst", name: "Kunstlicht", en: "Tungsten", kelvin: 3200, tint: 0, icon: "bulb" },
  { id: "neon", name: "Neon", en: "Fluorescent", kelvin: 4000, tint: 18, icon: "neon" },
  { id: "sonne", name: "Sonne", en: "Daylight", kelvin: 5500, tint: 0, icon: "sun" },
  { id: "wolken", name: "Wolken", en: "Cloudy", kelvin: 6500, tint: 0, icon: "cloud" },
  { id: "schatten", name: "Schatten", en: "Shade", kelvin: 7500, tint: 0, icon: "shade" },
];
/** mit der Pipette gemessen; steht nicht auf dem Lineal, gilt bis die Kamera zugeht */
export const MEASURED: Light = { id: "gemessen", name: "Gemessen", en: "Custom", kelvin: null, tint: 0, icon: "pipette" };
export const lightOf = (d: Dials): Light => (d.gains ? MEASURED : (LIGHTS.find((l) => l.kelvin === d.kelvin) ?? LIGHTS[0]));

/**
 * Die Gravuren auf dem Lineal und wo die Marke steht. Gemessen steht dort als eigene Gravur vor Auto, solange es gilt:
 * dann liegt Auto gleich daneben, ein Tipp oder ein Zug nach rechts genügt (Michel 10.10.: abwählen war umständlich,
 * weil die Marke schon auf „auto“ zu stehen schien)
 */
export function rulerOf(d: Dials): { stops: Light[]; at: number } {
  const light = lightOf(d);
  const stops = light === MEASURED ? [MEASURED, ...LIGHTS] : LIGHTS;
  return { stops, at: stops.indexOf(light) };
}

/**
 * Was die App im Messquadrat sieht: Mittel von Rot, Grün, Blau linear (0…1), gemessen vor dem Look, dazu die
 * Weißabgleich-Gains, mit denen das Bild gerade entsteht.
 */
export type WhiteSample = { r: number; g: number; b: number; gains: Gains };
export type WhiteResult = { ok: true; gains: Gains; done: boolean } | { ok: false; reason: "hell" | "dunkel" | "farbig" };

/** ab hier ist ein Kanal fast ausgefressen, das Mittel lügt */
const BRIGHT = 0.85;
/** darunter rauscht es mehr, als es misst (gut fünf Blenden unter Mittelgrau) */
const DARK = 0.02;
/** weiter weg von Grau ist es kein Weiß, sondern eine Farbe */
const COLORFUL = 3;
/** so nah an Grau gilt es als neutral (2 %) */
const NEUTRAL = 0.02;

/**
 * Wie „Custom WB“ an einer Fuji: die Gains so verschieben, dass das Quadrat grau wird. Grün bleibt der Bezug,
 * am Ende ist der kleinste Gain 1 (so verlangt es die Kamera). done heißt: schon neutral, keine weitere Runde nötig.
 */
export function correctWhite(s: WhiteSample): WhiteResult {
  if (Math.max(s.r, s.g, s.b) > BRIGHT) return { ok: false, reason: "hell" };
  if (s.g < DARK || s.r <= 0 || s.b <= 0) return { ok: false, reason: "dunkel" };
  const rg = s.r / s.g;
  const bg = s.b / s.g;
  if (rg > COLORFUL || rg < 1 / COLORFUL || bg > COLORFUL || bg < 1 / COLORFUL) return { ok: false, reason: "farbig" };
  const done = Math.abs(rg - 1) < NEUTRAL && Math.abs(bg - 1) < NEUTRAL;
  const r = s.gains.r / rg;
  const g = s.gains.g;
  const b = s.gains.b / bg;
  const min = Math.min(r, g, b);
  return { ok: true, gains: { r: r / min, g: g / min, b: b / min }, done };
}
