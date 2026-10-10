// Live Photos (#188): Schalter „Live“, Standard aus; nie auf einem Film; Ton-Hinweis einmal, wenn das Mikrofon fehlt.
import assert from "node:assert/strict";
import { test } from "node:test";

import { liveFor, micHint, readLive } from "@/lib/live";

test("Live ist aus, solange nichts gemerkt ist", () => {
  assert.equal(readLive(null), false);
  assert.equal(readLive("0"), false);
  assert.equal(readLive("1"), true);
});

test("Live nimmt nur auf, wenn eingeschaltet, das iPhone es kann und kein Film eingelegt ist", () => {
  assert.equal(liveFor({ on: true, supported: true, film: false }), true);
  assert.equal(liveFor({ on: false, supported: true, film: false }), false);
  assert.equal(liveFor({ on: true, supported: false, film: false }), false);
  // ein Film zeigt seine Bilder erst entwickelt: keine Live Photos vorab in der Mediathek
  assert.equal(liveFor({ on: true, supported: true, film: true }), false);
});

test("Ohne Mikrofon kommt der Hinweis einmal, danach nicht mehr", () => {
  assert.equal(micHint({ audio: false }, false), true);
  assert.equal(micHint({ audio: false }, true), false);
  assert.equal(micHint({ audio: true }, false), false);
  // ältere App ohne Live-Antwort: nichts sagen
  assert.equal(micHint({}, false), false);
});
