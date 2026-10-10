// Querformat (#221): dreht man das iPhone, drehen sich die Knöpfe mit, der Sucher bleibt stehen.
import assert from "node:assert/strict";
import { test } from "node:test";

import { turnFor } from "@/lib/camera-turn";

test("Knöpfe bleiben aufrecht: Oberkante nach links → 90° im Uhrzeigersinn", () => {
  assert.equal(turnFor("portrait", 0), 0);
  assert.equal(turnFor("landscapeLeft", 0), 90);
  assert.equal(turnFor("landscapeRight", 0), -90);
});

test("flach hingelegt, auf dem Kopf oder unbekannt: die Knöpfe bleiben, wie sie waren", () => {
  assert.equal(turnFor("faceUp", 90), 90);
  assert.equal(turnFor("portraitUpsideDown", -90), -90);
  assert.equal(turnFor(undefined, 0), 0);
});
