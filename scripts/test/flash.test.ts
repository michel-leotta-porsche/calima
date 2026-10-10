// Blitz in Calimas Kamera (#221): Aus, Auto, An; im Rezept steht, ob er ausgelöst hat.
import assert from "node:assert/strict";
import { test } from "node:test";

import { flashFired, nextFlash, readFlash } from "@/lib/flash";

test("der Blitz-Knopf schaltet Aus → Auto → An → Aus", () => {
  assert.equal(nextFlash("off"), "auto");
  assert.equal(nextFlash("auto"), "on");
  assert.equal(nextFlash("on"), "off");
});

test("gemerkte Einstellung: nur gültige Werte, sonst Aus", () => {
  assert.equal(readFlash("auto"), "auto");
  assert.equal(readFlash("on"), "on");
  assert.equal(readFlash(null), "off");
  assert.equal(readFlash("blitz"), "off");
});

test("aus den Exif-Daten: hat der Blitz ausgelöst?", () => {
  assert.equal(flashFired(0x19), true, "Bit 0 gesetzt");
  assert.equal(flashFired(0x18), false);
  assert.equal(flashFired("Flash fired, auto mode"), true);
  assert.equal(flashFired("Flash did not fire, compulsory flash mode"), false);
  assert.equal(flashFired("No flash function"), false);
  assert.equal(flashFired(undefined), undefined);
});
