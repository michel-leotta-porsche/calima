"use client";

import type { PhotoEdit } from "@/lib/develop/model";
import { isSortPile, toEnvelope } from "@/lib/envelope";
import { undevelopedStacks } from "@/lib/film";
import { t } from "@/lib/i18n";
import type { PhotoMeta } from "@/lib/ingest";

// Abzüge im Fotostudio: die letzten bearbeiteten Fotos, nur auf diesem Gerät (IndexedDB), nie hochgeladen.
// Jeder Abzug gehört einem Konto: wer sich auf demselben Gerät anmeldet, sieht nur seine eigenen.
// Ein Abzug hält die Arbeitsfassung (4096 px), kleine Vorschauen, die Aufnahmedaten und die Bearbeitung. Die
// Arbeitsfassung liegt für sich und wird erst geladen, wenn gerechnet wird (workOf): ein Tagesstapel (Abendstapel)
// kann viele Fotos halten, und die Bytes aller Arbeitsfassungen auf einmal sprengen auf dem iPhone den Speicher.
// Geht IndexedDB nicht (privates Fenster, gesperrter Speicher), arbeitet das Studio ohne Gedächtnis weiter.

export type Print = {
  id: string;
  /** Dateiname ohne Endung, für den Namen der gesicherten Datei */
  name: string;
  /** zuletzt geändert, Millisekunden */
  at: number;
  w: number;
  h: number;
  /** Arbeitsfassung: nur bei frisch gemachten Abzügen im Speicher, sonst über workOf() */
  work?: Blob;
  page: Blob;
  thumb: Blob;
  meta: PhotoMeta;
  edit?: PhotoEdit;
  /** kleine eingerechnete Fassung fürs Pult */
  shot?: Blob;
  /** uid des Kontos; ältere Abzüge ohne Besitzer zeigt das Studio niemandem mehr */
  owner?: string;
  /** Stapel: zusammen gewählte Fotos tragen dieselbe Kennung und ihre Stelle darin */
  stack?: string;
  pos?: number;
  /** Abendstapel: eingeordnet ins Buch oder weggelegt, und wann (für Rückgängig und KEEP_AWAY); bleibt beim Schließen erhalten */
  pick?: "in" | "out";
  pickAt?: number;
  /** der Satz zum Foto, wird im Buch sein Titel */
  line?: string;
  /** Umschlag (#244): Name des Films und wann er entwickelt wurde; frisch Entwickeltes liegt vorn */
  roll?: string;
  dev?: number;
  /** Platz des Stapels auf dem Pult, wenn er von Hand umsortiert wurde; neue Stapel ohne Platz liegen vorn */
  rank?: number;
};

/** so viele Fotos lassen sich auf einmal wählen; mehr sprengt auf älteren iPhones den Speicher */
export const MAX_STACK = 20;
/** so viele Fotos bleiben je Konto höchstens liegen, über alle Stapel (je etwa 5 MB) */
const MAX_KEPT = 40;

/** Abzüge in Stapel gruppiert, neuester Stapel zuerst, außer der Pult wurde umsortiert; ein einzelnes Foto ist ein Stapel aus einem */
export function piles(prints: Print[]): Print[][] {
  const by = new Map<string, Print[]>();
  for (const p of prints) {
    const k = p.stack ?? p.id;
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  const at = (pile: Print[]) => Math.max(...pile.map((p) => p.dev ?? p.at));
  const rank = (pile: Print[]) => Math.min(...pile.map((p) => p.rank ?? Infinity));
  return [...by.values()]
    .map((pile) => pile.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)))
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      // von Hand gelegte Stapel behalten ihren Platz; was neu dazukommt, liegt vorn, neuestes zuerst
      return ra === rb ? at(b) - at(a) : ra === Infinity ? -1 : rb === Infinity ? 1 : ra - rb;
    });
}

/** so lange liegt ein weggelegtes Foto vom Abendstapel noch unter dem Pult, zum Zurückholen */
export const KEEP_AWAY = 7 * 864e5;

/**
 * was liegen bleibt: höchstens MAX_PRINTS Stapel und MAX_KEPT Fotos, der neueste Stapel immer ganz.
 * Tagesstapel (Abendstapel) und Umschläge entwickelter Filme räumt das Studio nicht selbst weg und zählt sie nicht mit: Fotos aus Calimas Kamera
 * gibt es nur hier, bis sie im Buch liegen. Nur was dort seit KEEP_AWAY weggelegt ist, geht. Unentwickelte Filme (dark)
 * bleiben ebenso ganz und zählen nicht mit: ihre Bilder gibt es nirgends sonst, und man sieht sie erst nach dem Entwickeln.
 */
export function trimPiles(all: Print[][], now = Date.now(), dark = undevelopedStacks()): { keep: Print[][]; drop: Print[] } {
  const keep: Print[][] = [];
  let kept = 0;
  let n = 0;
  for (const pile of all) {
    if (isSortPile(pile[0].stack)) {
      const left = pile.filter((p) => p.pick !== "out" || (p.pickAt ?? now) > now - KEEP_AWAY);
      if (left.length) keep.push(left);
      continue;
    }
    if (pile[0].stack && dark.has(pile[0].stack)) {
      keep.push(pile);
      continue;
    }
    if (kept && (kept >= MAX_PRINTS || n + pile.length > MAX_KEPT)) continue;
    keep.push(pile);
    kept++;
    n += pile.length;
  }
  const stays = new Set(keep.flat());
  return { keep, drop: all.flat().filter((p) => !stays.has(p)) };
}

/** so viele Stapel (oder einzelne Abzüge) bleiben je Konto liegen; ältere räumt das Studio selbst weg */
export const MAX_PRINTS = 8;

const DB = "calima-studio";
const STORE = "prints";
/** Arbeitsfassungen, je Abzug ein Eintrag mit derselben id */
const WORK = "work";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      if (!names.contains(WORK)) req.result.createObjectStore(WORK, { keyPath: "id" });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void, store = STORE): Promise<T | undefined> {
  const d = await db();
  return new Promise((ok, fail) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => {
      d.close();
      ok(req ? req.result : undefined);
    };
    tx.onerror = tx.onabort = () => {
      d.close();
      fail(tx.error);
    };
  });
}

/*
 * Die Bilder liegen als Bytes in der Datenbank, nicht als Blob: WebKit legt Blobs aus IndexedDB als Dateien ab und
 * verliert sie in der iPhone-App, sobald die App aktualisiert wird (der Datenordner bekommt einen neuen Pfad). Ältere
 * Abzüge mit Blob werden beim Lesen angefasst; lassen sie sich nicht mehr lesen, fliegen sie leise raus.
 */
type Packed = { buf: ArrayBuffer; type: string };
const BLOBS = ["work", "page", "thumb", "shot"] as const;
/** work nur noch in älteren Einträgen; beim Lesen zieht sie in den eigenen Speicher um */
type Stored = Omit<Print, (typeof BLOBS)[number]> & { work?: Blob | Packed; page: Blob | Packed; thumb: Blob | Packed; shot?: Blob | Packed };

const pack = async (b: Blob): Promise<Packed> => ({ buf: await b.arrayBuffer(), type: b.type });
const unpack = (x: Blob | Packed): Blob => (x instanceof Blob ? x : new Blob([x.buf], { type: x.type }));
const readable = (b: Blob) =>
  b
    .slice(0, 8)
    .arrayBuffer()
    .then(() => true)
    .catch(() => false);

async function unpackPrint(s: Stored): Promise<Print | null> {
  const out = { ...s } as unknown as Print;
  for (const k of BLOBS) {
    const v = s[k];
    if (!v) continue;
    if (v instanceof Blob && !(await readable(v))) return null;
    out[k] = unpack(v);
  }
  return out;
}

/** der Eintrag ohne Arbeitsfassung, Bilder als Bytes */
async function light(p: Print, uid: string): Promise<Stored> {
  return { ...p, work: undefined, owner: uid, page: await pack(p.page), thumb: await pack(p.thumb), shot: p.shot ? await pack(p.shot) : undefined };
}

const putWork = async (id: string, work: Blob) => {
  const w = { id, ...(await pack(work)) };
  await run("readwrite", (st) => st.put(w), WORK);
};

/** Abzüge dieses Kontos ohne Arbeitsfassung, neueste zuerst; nicht mehr lesbare werden dabei entfernt */
export async function listPrints(uid: string): Promise<Print[]> {
  const all = (await run<Stored[]>("readonly", (s) => s.getAll() as IDBRequest<Stored[]>)) ?? [];
  const out: Print[] = [];
  for (const s of all.filter((p) => p.owner === uid)) {
    const p = await unpackPrint(s);
    if (!p) {
      await removePrint(s.id).catch(() => {});
      continue;
    }
    // ältere Einträge tragen die Arbeitsfassung noch selbst: einmal umziehen, danach liegt sie für sich
    if (p.work) {
      const moved = { ...p };
      await putWork(p.id, p.work)
        .then(async () => {
          const l = await light(moved, uid);
          await run("readwrite", (st) => st.put(l));
        })
        .catch(() => {});
    }
    out.push({ ...p, work: undefined });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Die Arbeitsfassung eines Abzugs (4096 px), zum Rechnen und Hochladen */
export async function workOf(p: Print): Promise<Blob> {
  if (p.work) return p.work;
  const w = await run<Packed & { id: string }>("readonly", (s) => s.get(p.id) as IDBRequest<Packed & { id: string }>, WORK).catch(() => undefined);
  if (!w) throw new Error(t("Das Foto liegt nicht mehr auf diesem Gerät."));
  return unpack(w);
}

/**
 * Für dieses Konto speichern und, was über die Grenzen hinausgeht, wegräumen. Die Arbeitsfassung wird nur geschrieben,
 * wenn sie mitkommt; Änderungen beim Einsortieren schreiben nur den kleinen Eintrag.
 */
export async function putPrints(uid: string, ps: Print[]) {
  // ein Tag auf dem Pult: iOS soll den Speicher bei Platzmangel nicht von selbst leeren
  if (ps.some((p) => isSortPile(p.stack))) navigator.storage?.persist?.().catch(() => {});
  for (const p of ps) {
    if (p.work) await putWork(p.id, p.work);
    const l = await light(p, uid);
    await run("readwrite", (st) => st.put(l));
  }
  // Tage und Umschläge räumt niemand weg, also ändert ein Foto darauf nichts an den anderen: nicht alles neu lesen
  if (ps.every((p) => isSortPile(p.stack))) return;
  for (const old of trimPiles(piles(await listPrints(uid))).drop) await removePrint(old.id);
}

/** einen Film aus der Kamera über dem Buch entwickeln, ohne dass das Studio offen ist: er kommt als Umschlag auf den Pult */
export async function developFilm(uid: string, stack: string, name: string) {
  const roll = (await listPrints(uid)).filter((p) => p.stack === stack);
  if (roll.length) await putPrints(uid, toEnvelope(roll, stack, name, Date.now()));
  return roll.length;
}

export async function removePrint(id: string) {
  await run("readwrite", (s) => s.delete(id));
  await run("readwrite", (s) => s.delete(id), WORK);
}

/** Beim Löschen des Kontos: alle Abzüge dieses Kontos und die alten ohne Besitzer vom Gerät entfernen */
export async function clearPrints(uid: string) {
  const all = (await run<Stored[]>("readonly", (s) => s.getAll() as IDBRequest<Stored[]>)) ?? [];
  for (const p of all) if (!p.owner || p.owner === uid) await removePrint(p.id);
}
