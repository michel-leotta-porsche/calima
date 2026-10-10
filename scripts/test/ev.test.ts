// Heller/Dunkler (#224): wirkt auch mit Rädern von Hand, springt in Drittelstufen wie an einer Kamera.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTO } from "@/lib/camera";
import { evLabel, evMode, evStep, EV_TICKS } from "@/lib/ev";

test("Modus: alles A, eins von Hand, beide von Hand", () => {
  assert.equal(evMode(AUTO), "auto");
  assert.equal(evMode({ ...AUTO, iso: 800 }), "semi");
  assert.equal(evMode({ ...AUTO, duration: 1 / 30 }), "semi");
  // Zeit und ISO fest: nichts mehr, was heller machen könnte, ohne an einem Rad zu drehen
  assert.equal(evMode({ ...AUTO, iso: 800, duration: 1 / 30 }), "manual");
  // Schärfe oder Weiß von Hand ändern an der Belichtung nichts
  assert.equal(evMode({ ...AUTO, focus: 0.3, kelvin: 3200 }), "auto");
});

test("Wischen rastet in Dritteln ein und bleibt in ±2", () => {
  assert.equal(evStep(0.1), 0);
  assert.equal(evStep(0.2), 1 / 3);
  assert.equal(evStep(-0.7), -2 / 3);
  assert.equal(evStep(1.1), 1);
  assert.equal(evStep(5), 2);
  assert.equal(evStep(-5), -2);
});

test("Anzeige wie an der Kamera: Drittel als Bruch", () => {
  assert.equal(evLabel(0), "±0");
  assert.equal(evLabel(1 / 3), "+⅓");
  assert.equal(evLabel(-2 / 3), "−⅔");
  assert.equal(evLabel(1), "+1");
  assert.equal(evLabel(-4 / 3), "−1⅓");
  assert.equal(evLabel(5 / 3), "+1⅔");
  assert.equal(evLabel(2), "+2");
});

test("Skala: 13 Striche von −2 bis +2", () => {
  assert.equal(EV_TICKS.length, 13);
  assert.equal(EV_TICKS[0], -2);
  assert.equal(EV_TICKS[12], 2);
});
