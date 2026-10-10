// Beiseitegelegte Filme in der Look-Leiste (#226): ab zwei liegen sie als ein Stapel vor den Looks.
import assert from "node:assert/strict";
import { test } from "node:test";

import { filmStrip, type Film } from "@/lib/film";

const film = (stack: string): Film => ({ stack, name: stack, approx: false, edit: null, count: 3 });

test("kein oder ein beiseitegelegter Film: wie bisher einzeln, kein Stapel", () => {
  assert.deepEqual(filmStrip([], false), { pile: null, films: [] });
  const one = [film("a")];
  assert.deepEqual(filmStrip(one, false), { pile: null, films: one });
});

test("ab zwei Filmen ein Stapel; zu zeigt er keine Filme, offen alle", () => {
  const five = ["a", "b", "c", "d", "e"].map(film);
  assert.deepEqual(filmStrip(five, false), { pile: 5, films: [] });
  assert.deepEqual(filmStrip(five, true), { pile: 5, films: five });
});

// Offene Filme mit Datum (#245): seit wann ein Film nicht belichtet wurde, ab 7 Tagen ein leiser Hinweis
import { filmAge, withLast } from "@/lib/film";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

test("ein Film weiß, seit wie vielen Tagen er liegt; der Tag wechselt um 4 Uhr früh", () => {
  const now = at(2026, 10, 10, 20);
  assert.equal(filmAge(at(2026, 10, 10, 9), now).days, 0);
  assert.equal(filmAge(at(2026, 10, 9, 9), now).days, 1);
  assert.equal(filmAge(at(2026, 10, 10, 2), at(2026, 10, 10, 9)).days, 1, "nach Mitternacht belichtet: gestern");
  const wed = filmAge(at(2026, 10, 7), now);
  assert.equal(wed.days, 3);
  assert.equal(wed.day.getDay(), 3, "Mittwoch");
  assert.equal(filmAge(at(2026, 10, 3), now).stale, true, "7 Tage: liegt seit 7 Tagen");
  assert.equal(filmAge(at(2026, 10, 4), now).stale, false);
});

test("Filme ohne Datum nehmen das jüngste Bild darauf", () => {
  const films = [film("a"), { ...film("b"), last: 5 }, film("c")];
  const prints = [
    { stack: "a", at: 10 },
    { stack: "a", at: 30 },
    { stack: "b", at: 99 },
  ];
  assert.deepEqual(withLast(films, prints).map((f) => f.last), [30, 5, undefined]);
});
