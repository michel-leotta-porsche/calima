// Film-Bilder sind gesichert, bevor er entwickelt ist (#247): die App hält Regal und Bilder in eigenen Dateien, das
// Web holt zurück, was im WebKit-Speicher fehlt.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Film, Shelf } from "@/lib/film";
import { lostShots, restoreShelf, type SavedShot } from "@/lib/film-safe";

const film = (stack: string, count: number): Film => ({ stack, name: stack, approx: false, edit: null, count });

test("Leeres Regal (WebKit-Speicher geleert): das gesicherte kommt zurück", () => {
  const saved: Shelf = { loaded: "f1", films: [film("f1", 5)] };
  assert.deepEqual(restoreShelf({ loaded: null, films: [] }, saved, []), saved);
});

test("Fehlt nur ein Film, kommt er dazu; der eingelegte bleibt", () => {
  const local: Shelf = { loaded: "f2", films: [film("f2", 1)] };
  const out = restoreShelf(local, { loaded: "f1", films: [film("f1", 5), film("f2", 1)] }, []);
  assert.equal(out.loaded, "f2");
  assert.deepEqual(out.films.map((f) => f.stack).sort(), ["f1", "f2"]);
});

test("Der Zähler folgt den gesicherten Bildern, wenn der Absturz vor dem Speichern des Regals kam", () => {
  const shots: SavedShot[] = [1, 2, 3].map((i) => ({ stack: "f1", id: `p${i}`, path: `/x/${i}.jpg`, at: i }));
  const out = restoreShelf({ loaded: "f1", films: [film("f1", 2)] }, null, shots);
  assert.equal(out.films[0].count, 3);
});

test("Gesicherte Bilder ohne Regal-Eintrag (Absturz beim ersten Bild) bekommen einen Film", () => {
  const shots: SavedShot[] = [{ stack: "f9", id: "p1", path: "/x/1.jpg", at: 1 }];
  const out = restoreShelf({ loaded: null, films: [] }, null, shots);
  assert.equal(out.films.length, 1);
  assert.equal(out.films[0].stack, "f9");
  assert.equal(out.films[0].count, 1);
});

test("Zurückgeholt wird nur, was im Speicher fehlt, mit der Position auf dem Film", () => {
  const shots: SavedShot[] = [
    { stack: "f1", id: "a", path: "/a.jpg", at: 30 },
    { stack: "f1", id: "b", path: "/b.jpg", at: 10 },
    { stack: "f1", id: "c", path: "/c.jpg", at: 20 },
  ];
  assert.deepEqual(
    lostShots(shots, new Set(["c"])).map((s) => [s.id, s.pos]),
    [
      ["b", 0],
      ["a", 2],
    ],
  );
});
