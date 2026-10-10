// Weiß-Pipette (#184): aus dem gemessenen Quadrat werden neue Weißabgleich-Gains, wie „Custom WB“ an einer Fuji.
import assert from "node:assert/strict";
import { test } from "node:test";

import { correctWhite, LIGHTS, lightOf, MEASURED, rulerOf, type WhiteSample } from "@/lib/white";
import { AUTO } from "@/lib/camera";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const sample = (r: number, g: number, b: number, gains = { r: 2, g: 1, b: 1.6 }): WhiteSample => ({ r, g, b, gains });

test("Kunstlicht-Stich: Rot wird zurückgenommen, Blau verstärkt, bis das Quadrat neutral ist", () => {
  const res = correctWhite(sample(0.6, 0.4, 0.2));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // neu = alt × (G / Kanal), danach so skaliert, dass der kleinste Gain 1 ist
  const r = 2 * (0.4 / 0.6);
  const g = 1;
  const b = 1.6 * (0.4 / 0.2);
  const min = Math.min(r, g, b);
  near(res.gains.r, r / min);
  near(res.gains.g, g / min);
  near(res.gains.b, b / min);
  assert.equal(res.done, false);
});

test("ein schon neutrales Quadrat ist fertig und lässt die Gains, wie sie sind", () => {
  const res = correctWhite(sample(0.5, 0.505, 0.497));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.done, true);
});

test("kein Gain fällt unter 1", () => {
  const res = correctWhite(sample(0.2, 0.5, 0.7, { r: 1, g: 1, b: 1 }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(Math.min(res.gains.r, res.gains.g, res.gains.b) >= 1 - 1e-9);
});

test("ausgefressen oder zu dunkel: es wird nicht gemessen", () => {
  assert.deepEqual(correctWhite(sample(0.95, 0.9, 0.7)), { ok: false, reason: "hell" });
  assert.deepEqual(correctWhite(sample(0.01, 0.012, 0.008)), { ok: false, reason: "dunkel" });
});

test("eine kräftige Farbe statt Weiß wird abgelehnt", () => {
  assert.deepEqual(correctWhite(sample(0.5, 0.1, 0.05)), { ok: false, reason: "farbig" });
  assert.deepEqual(correctWhite(sample(0.05, 0.3, 0.6)), { ok: false, reason: "farbig" });
});

test("gemessenes Weiß heißt am Chip „Gemessen“, ein Licht vom Lineal löscht es", () => {
  assert.equal(lightOf({ ...AUTO, gains: { r: 1.2, g: 1, b: 2 } }), MEASURED);
  assert.equal(lightOf({ ...AUTO, kelvin: 3200, tint: 0 }).id, "kunst");
  assert.equal(lightOf(AUTO).id, "auto");
});

test("Gemessenes Weiß steht als eigene Gravur vor Auto: ein Tipp oder Zug nach rechts geht zurück auf Auto", () => {
  const measured = rulerOf({ ...AUTO, gains: { r: 1.2, g: 1, b: 2 } });
  assert.equal(measured.stops[0], MEASURED);
  assert.equal(measured.stops[1].id, "auto");
  assert.equal(measured.at, 0);
  // ohne Messung nur die Lichter, die Marke beim gewählten
  const plain = rulerOf({ ...AUTO, kelvin: 5500, tint: 0 });
  assert.deepEqual(plain.stops, LIGHTS);
  assert.equal(plain.stops[plain.at].id, "sonne");
});
