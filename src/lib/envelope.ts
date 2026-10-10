import { dayOf, dayStack, isDayStack } from "@/lib/day-stack";
import type { Print } from "@/lib/studio-store";

// Umschlag (#244, Michel 10.10.2026): ein entwickelter Film kommt wie vom Labor als ein Stapel auf den Pult, nicht
// verteilt auf die Tage seiner Aufnahmen. Der Zettel trägt Filmname und Zeitraum, eingeordnet wird er wie ein Tag,
// und im Buch bekommt er eine Filmseite. Jedes Bild behält sein Aufnahmedatum.

const PREFIX = "umschlag-";

/** Kennung des Umschlags zu einem Film (dessen Stapel) */
export const envelopeOf = (film: string) => `${PREFIX}${film}`;

export const isEnvelope = (stack: string | undefined): stack is string => !!stack && stack.startsWith(PREFIX);

/** Stapel, die sich zum Einsortieren öffnen und die das Fotostudio nie selbst wegräumt: Tage und Umschläge */
export const isSortPile = (stack: string | undefined): stack is string => isDayStack(stack) || isEnvelope(stack);

/** die Bilder eines Films in seinen Umschlag: Reihenfolge des Films, Filmname, wann entwickelt (liegt dann vorn) */
export const toEnvelope = (roll: Print[], film: string, name: string, now: number): Print[] =>
  roll.map((p) => ({ ...p, stack: envelopeOf(film), pos: p.pos ?? p.at, roll: name, dev: now }));

/** „Hafen · 8. Okt.“ oder „Sonnenschein · 8.–15. Okt.“; der Tag wechselt wie beim Abendstapel um 4 Uhr früh */
export function envelopeLabel(pile: Print[], loc: string): string {
  const days = pile.map((p) => dayOf(dayStack(p.at)).getTime());
  const fmt = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" });
  const span = fmt.formatRange(Math.min(...days), Math.max(...days));
  const name = pile.find((p) => p.roll)?.roll?.trim();
  return name ? `${name} · ${span}` : span;
}
