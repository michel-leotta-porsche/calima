import type { Film, Shelf } from "@/lib/film";

// Film-Bilder sichern (#247). Bis zum Entwickeln liegen sie sonst nur im WebKit-Speicher, der schon einmal Abzüge
// verloren hat (#146). Die App legt deshalb jedes Bild auf einem Film beim Auslösen auch als eigene Datei ab
// (Application Support, übersteht Updates und kommt mit ins iPhone-Backup) und merkt sich das Regal. Fehlt im Web
// etwas, holt das Studio es beim Öffnen von dort zurück. Nach dem Entwickeln liegen die Bilder in der Mediathek,
// dann räumt die App ihre Dateien weg.

/** ein gesichertes Bild: Film, Kennung des Abzugs, Datei, Aufnahmezeit (ms) */
export type SavedShot = { stack: string; id: string; path: string; at: number };

/** das Regal aus WebKit-Speicher und Sicherung zusammenführen: was fehlt, kommt dazu; Zähler nie kleiner als die Bilder */
export function restoreShelf(local: Shelf, saved: Shelf | null, shots: SavedShot[]): Shelf {
  const films = new Map<string, Film>(local.films.map((f) => [f.stack, f]));
  for (const f of saved?.films ?? []) if (!films.has(f.stack)) films.set(f.stack, f);
  for (const s of shots) if (!films.has(s.stack)) films.set(s.stack, { stack: s.stack, name: "Film", approx: false, edit: null, count: 0 });
  const out = [...films.values()].map((f) => {
    const n = shots.filter((s) => s.stack === f.stack).length;
    return n > f.count ? { ...f, count: n } : f;
  });
  const loaded = local.loaded ?? (saved?.loaded && films.has(saved.loaded) ? saved.loaded : null);
  return { loaded, films: out };
}

/** gesicherte Bilder, die im Speicher fehlen, mit ihrer Position auf dem Film (nach Aufnahmezeit) */
export function lostShots(shots: SavedShot[], have: Set<string>): (SavedShot & { pos: number })[] {
  const out: (SavedShot & { pos: number })[] = [];
  const byStack = new Map<string, SavedShot[]>();
  for (const s of shots) byStack.set(s.stack, [...(byStack.get(s.stack) ?? []), s]);
  for (const list of byStack.values()) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((s, pos) => !have.has(s.id) && out.push({ ...s, pos }));
  }
  return out.sort((a, b) => a.at - b.at);
}
