"use client";

import { dayOf, dayStack, daysAgo } from "@/lib/day-stack";
import type { PhotoEdit } from "@/lib/develop/model";

// Filme der Kamera (Stufe 2): ein Film hält einen Look fest, FILM_FRAMES Bilder, ein Stapel im Fotostudio. Wie bei einer
// echten Kamera lässt sich ein angefangener Film beiseitelegen, mit einem anderen weiterfotografieren und später weiter
// belichten. Die Bilder darauf sieht man erst, wenn der Film entwickelt ist (voll oder bewusst entwickelt): bis dahin
// zeigt die Kamera kein Vorschaubild und das Fotostudio keinen Stapel. Liegt im Gerät (localStorage), nicht am Konto.

/** Regeln einer Einwegkamera-Vorlage (disposable.ts): so viele Bilder, fester Ausschnitt (Zoom zur Hauptkamera), Blitz */
export type FilmRules = { id: string; frames: number; zoom: number; flash: boolean };
/** last: wann zuletzt belichtet (Millisekunden), für „seit Mi.“ im Filme-Stapel (#245); ältere Filme kennen es nicht */
export type Film = { stack: string; name: string; approx: boolean; edit: PhotoEdit | null; count: number; rules?: FilmRules; last?: number };
export type Shelf = { loaded: string | null; films: Film[] };

const KEY = "calima:films";
const OLD_KEY = "calima:film";

const isFilm = (f: unknown): f is Film =>
  !!f && typeof f === "object" && typeof (f as Film).stack === "string" && typeof (f as Film).count === "number" && typeof (f as Film).name === "string";

/** alle unentwickelten Filme und welcher eingelegt ist; ein alter einzelner Film (vor dem Wechsel) wird übernommen */
export function readShelf(): Shelf {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Shelf> | null;
    if (s && Array.isArray(s.films)) {
      const films = s.films.filter(isFilm);
      return { loaded: films.some((f) => f.stack === s.loaded) ? (s.loaded as string) : null, films };
    }
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? "null");
    if (isFilm(old)) {
      const shelf = { loaded: old.stack, films: [old] };
      writeShelf(shelf);
      localStorage.removeItem(OLD_KEY);
      return shelf;
    }
  } catch {}
  return { loaded: null, films: [] };
}

export function writeShelf(s: Shelf) {
  try {
    if (s.films.length) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {}
}

/** Stapel, deren Bilder noch im Dunkeln liegen: unentwickelte Filme */
export const undevelopedStacks = (): Set<string> => new Set(readShelf().films.map((f) => f.stack));

/**
 * Die beiseitegelegten Filme in der Look-Leiste (#226): ab zwei liegen sie als ein Stapel („Filme · N“) vor den Looks,
 * damit die Looks ohne Scrollen erreichbar bleiben. pile ist die Zahl am Stapel (null: kein Stapel), films was zu sehen ist.
 */
export const filmStrip = (aside: Film[], open: boolean): { pile: number | null; films: Film[] } =>
  aside.length < 2 ? { pile: null, films: aside } : { pile: aside.length, films: open ? aside : [] };

/** ab so vielen Tagen ohne Bild zeigt ein Film leise, wie lange er schon liegt; keine Mitteilung, kein Entwickeln (#245) */
export const STALE_DAYS = 7;

/** seit wann ein Film nicht belichtet wurde: Tage (0 heute, 1 gestern), der Tag selbst und ob er schon lange liegt */
export function filmAge(last: number, now = Date.now()): { days: number; day: Date; stale: boolean } {
  const stack = dayStack(last);
  const days = Math.max(0, daysAgo(stack, now));
  return { days, day: dayOf(stack), stale: days >= STALE_DAYS };
}

/** Filme ohne Datum (vor #245) nehmen das jüngste Bild auf ihnen */
export function withLast(films: Film[], prints: { stack?: string; at: number }[]): Film[] {
  return films.map((f) => {
    if (f.last) return f;
    const ats = prints.filter((p) => p.stack === f.stack).map((p) => p.at);
    return ats.length ? { ...f, last: Math.max(...ats) } : f;
  });
}
