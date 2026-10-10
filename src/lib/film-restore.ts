"use client";

import { CalimaCamera } from "@/lib/camera";
import { readShelf, writeShelf, type Shelf } from "@/lib/film";
import { lostShots, restoreShelf } from "@/lib/film-safe";
import { newId } from "@/lib/store";
import { listPrints, putPrints, type Print } from "@/lib/studio-store";

/**
 * Filme aus der Sicherung der App zurückholen (#247): erst das Regal (sonst hielte das Aufräumen die Filmbilder für
 * gewöhnliche Stapel), dann jedes Bild, das im WebKit-Speicher fehlt. Gibt die Zahl der zurückgeholten Bilder zurück.
 */
export async function restoreFilms(uid: string): Promise<number> {
  const saved = await CalimaCamera.savedFilms();
  const shots = saved.shots ?? [];
  let fromApp: Shelf | null = null;
  try {
    fromApp = saved.shelf ? (JSON.parse(saved.shelf) as Shelf) : null;
  } catch {}
  if (!shots.length && !fromApp?.films?.length) return 0;
  const local = readShelf();
  const shelf = restoreShelf(local, fromApp && Array.isArray(fromApp.films) ? fromApp : null, shots);
  if (JSON.stringify(shelf) !== JSON.stringify(local)) writeShelf(shelf);

  const have = new Set((await listPrints(uid)).map((p) => p.id));
  const lost = lostShots(shots, have);
  if (!lost.length) return 0;
  const { studioSource } = await import("@/lib/ingest");
  const ps: Print[] = [];
  for (const s of lost) {
    const { Capacitor } = await import("@capacitor/core");
    // lesen, nicht holen: die Datei bleibt bei der App, bis der Film entwickelt ist
    const res = await fetch(Capacitor.convertFileSrc(s.path)).catch(() => null);
    if (!res?.ok) continue;
    const file = new File([await res.blob()], `${s.id}.jpg`, { type: "image/jpeg", lastModified: s.at });
    const src = await studioSource(file).catch(() => null);
    if (!src) continue;
    const film = shelf.films.find((f) => f.stack === s.stack);
    ps.push({ id: s.id || newId(), name: s.id, at: s.at, w: src.w, h: src.h, work: src.work, page: src.page, thumb: src.thumb, meta: src.meta, edit: film?.edit ?? undefined, stack: s.stack, pos: s.pos });
  }
  if (ps.length) await putPrints(uid, ps);
  return ps.length;
}
