"use client";

import { Box, ChevronLeft, ChevronRight, Film as FilmIcon, Lock, SlidersHorizontal, Sun, SwitchCamera, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { allAuto, DIALS, DialChips, GridOverlay, isManual, MeterBadge, Ruler, type DialKey } from "@/components/camera-dials";
import { fmtShift, WhiteDial, type Shift } from "@/components/white-dial";
import { PhotoZoom } from "@/components/photo-zoom";
import { IconButton } from "@/components/ui/button";
import { DISPOSABLE_FRAMES, DISPOSABLES, disposableEdit, type Disposable } from "@/lib/disposable";
import { filmStrip, readShelf, writeShelf, type Film, type Shelf } from "@/lib/film";
import { AUTO, CalimaCamera, FILM_FRAMES, focalZoom, grainOf, isDenied, LUT_N, lutOf, realFocals, takeShot, type CameraInfo, type Dials, type Frame, type Gains, type Meter } from "@/lib/camera";
import { bakePhoto } from "@/lib/develop/bake";
import { buildLut, neutralEdit, PRESETS, type NamedRecipe, type PhotoEdit } from "@/lib/develop/model";
import { applySettings, type CopiedSettings } from "@/lib/develop/settings";
import { haptic } from "@/lib/haptics";
import { SIZES, studioSource } from "@/lib/ingest";
import { saveToLibrary } from "@/lib/library-save";
import { useT } from "@/lib/i18n";
import { correctWhite } from "@/lib/white";
import { useRecentSettings } from "@/lib/settings-clipboard";
import { myRecipes, newId } from "@/lib/store";
import type { Print } from "@/lib/studio-store";

// Calimas Kamera (Kamera-Workshop 9.10.2026, kamera-workshop-2026-10-09/): ein Bildschirm, eine Hand, kein Menü.
// Der Sucher ist der native Teil (ios/App/App/CalimaCamera.swift) hinter der durchsichtigen Seite; hier liegen nur
// Look-Pillen, Auslöser und Gesten. Gedrückt halten zeigt das Original (wie beim Bearbeiten), Wischen nach oben oder
// unten macht heller oder dunkler, zwei Finger zoomen, ein Tipp stellt scharf. Jedes Foto wird ein Abzug im Fotostudio,
// mit dem Look als Bearbeitung; eingerechnet wird erst beim Sichern, dann auch die Klarheit. Die Körnung läuft schon im
// Sucher mit. „Film einlegen“ (Stufe 2) hält einen Look fest: FILM_FRAMES Bilder, die als ein Stapel im Fotostudio
// landen, auch über mehrere Kamera-Sitzungen hinweg; der Kamera-Knopf und die Lautstärketasten lösen aus. Ohne Film liegt
// jedes Foto auf dem Stapel des Tages (Abendstapel, reisebuch-workshop-2026-10-09/abendstapel-plan.md). Das Werkzeug
// (Expertenmodus E1, camera-dials.tsx) liegt hinter dem Schieberegler-Knopf oben: Brennweiten, Räder mit „A“, Messer,
// Raster mit Wasserwaage, Lupe beim Scharfstellen von Hand.

type Look = { id: string; name: string; approx: boolean; edit: PhotoEdit | null };
const ORIGINAL = "original";
const LAST_KEY = "calima:kamera-look";
const SHIFT_KEY = "calima:kamera-weiss";
const TOOLS_KEY = "calima:kamera-werkzeug";
const HOLD_MS = 220;
const MOVE_PX = 10;
const EV_MAX = 2;
/** Seite des Messquadrats der Weiß-Pipette, Anteil der Sucherbreite */
const PATCH = 0.18;

const lookOfSettings = (s: CopiedSettings, id: string): Look => ({ id, name: s.name, approx: s.approx, edit: applySettings(neutralEdit(), s) });
const lookOfRecipe = (r: NamedRecipe): Look => ({ id: r.id, name: r.name, approx: false, edit: { ...neutralEdit(), ...(r.f ?? {}), rec: { ...r.v }, recName: r.name } });

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
/** so viele Bilder passen auf den Film: eine Einwegkamera bringt ihre eigene Zahl mit */
const framesOf = (f: Film) => f.rules?.frames ?? FILM_FRAMES;
const evLabel = (ev: number) => `${ev > 0 ? "+" : ev < 0 ? "−" : "±"}${Math.abs(ev).toFixed(1)}`;

/** taken: von „So fotografieren“ geöffnet, der eben mitgenommene Look kommt vor dem zuletzt gewählten */
export function Camera({ uid, taken, onShot, onFilmDone, onClose }: { uid: string; taken?: boolean; onShot: (p: Print, stack?: string) => void; onFilmDone: (stack: string, name: string) => void; onClose: () => void }) {
  const t = useT();
  const recent = useRecentSettings();
  const [own, setOwn] = useState<NamedRecipe[]>([]);
  const [lookId, setLookId] = useState<string>(() => {
    // der neueste mitgenommene Look steht in der Liste immer als recent-0
    if (taken) return "recent-0";
    try {
      return localStorage.getItem(LAST_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [front, setFront] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [ev, setEv] = useState(0);
  const [showEv, setShowEv] = useState(false);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  /** das letzte Foto groß (Seitengröße, mit Look, sobald eingerechnet); ein Tipp aufs Vorschaubild zeigt es */
  const [review, setReview] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  useEffect(() => () => void (review && URL.revokeObjectURL(review)), [review]);
  // zum Hineinzoomen: das letzte Foto groß (2560 px) mit Look, erst beim Öffnen gerechnet, damit Auslösen nichts kostet
  const lastShot = useRef<{ work: Blob; edit?: PhotoEdit } | null>(null);
  const [sharp, setSharp] = useState<string | null>(null);
  useEffect(() => () => void (sharp && URL.revokeObjectURL(sharp)), [sharp]);
  const openReview = () => {
    const shot = lastShot.current;
    setViewing(true);
    if (!shot || sharp) return;
    if (!shot.edit) return setSharp(URL.createObjectURL(shot.work));
    const url = URL.createObjectURL(shot.work);
    const edit = shot.edit;
    bakePhoto({ url, lut: buildLut(edit, LUT_N), n: LUT_N, rec: edit.rec, sizes: { large: SIZES.large, page: SIZES.thumb, thumb: SIZES.thumb } })
      .then((r) => lastShot.current === shot && setSharp(URL.createObjectURL(r.blobs.large)))
      .catch(() => {})
      .finally(() => URL.revokeObjectURL(url));
  };
  /** Marke, wo zuletzt scharf gestellt wurde; locked: Schärfe und Helligkeit sind festgehalten (zweiter Tipp auf die Marke) */
  const [reticle, setReticle] = useState<{ x: number; y: number; k: number; locked?: boolean } | null>(null);
  // Werkzeug (E1): offen oder zu bleibt gemerkt; die Räder selbst fangen bei jedem Öffnen auf A an
  const [toolsOpen, setTools] = useState(() => {
    try {
      return localStorage.getItem(TOOLS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [info, setInfo] = useState<CameraInfo | null>(null);
  const [dials, setDials] = useState<Dials>(AUTO);
  /** Weiß-Pipette: das Messquadrat steht im Sucher, der Auslöser misst statt aufzunehmen */
  const [pipette, setMetering] = useState(false);
  const [whiteMsg, setWhiteMsg] = useState<string | null>(null);
  const [dial, setDial] = useState<DialKey | "focal" | null>(null);
  const [focal, setFocal] = useState<number | null>(null);
  const [grid, setGrid] = useState(false);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [roll, setRoll] = useState<number | null>(null);
  // die Filme im Gerät: einer eingelegt, die anderen beiseitegelegt, alle noch nicht entwickelt
  const [shelf, setShelf] = useState<Shelf>(readShelf);
  const film = useMemo(() => shelf.films.find((f) => f.stack === shelf.loaded) ?? null, [shelf]);
  // Einwegkamera: der Film bringt feste Regeln mit; Werkzeug, Zoom, Tippen und Heller/Dunkler gibt es dann nicht
  const fixed = film?.rules ?? null;
  const fixedRef = useRef(fixed);
  useEffect(() => {
    fixedRef.current = fixed;
  });
  const tools = toolsOpen && !fixed;
  /** Reihe unter dem Sucher: Looks oder Einwegkamera-Vorlagen */
  const [tab, setTab] = useState<"looks" | "einweg">("looks");
  const aside = shelf.films.filter((f) => f.stack !== shelf.loaded);
  /** ab zwei beiseitegelegten Filmen liegen sie als Stapel vor den Looks; offen zeigt er sie alle */
  const [pileOpen, setPileOpen] = useState(false);
  const strip = filmStrip(aside, pileOpen);
  const box = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    myRecipes(uid)
      .then(setOwn)
      .catch(() => {});
  }, [uid]);

  // Looks in der Reihenfolge Original, zuletzt mitgenommen, Deine Looks, Voreinstellungen; gleiche Namen nur einmal
  const looks = useMemo<Look[]>(() => {
    const out: Look[] = [{ id: ORIGINAL, name: t("Original"), approx: false, edit: null }];
    const seen = new Set<string>();
    const add = (l: Look) => {
      if (seen.has(l.name)) return;
      seen.add(l.name);
      out.push(l);
    };
    recent.forEach((s, i) => add(lookOfSettings(s, `recent-${i}`)));
    own.forEach((r) => add(lookOfRecipe(r)));
    PRESETS.forEach((r) => add({ ...lookOfRecipe(r), name: t(r.name) }));
    return out;
  }, [recent, own, t]);
  // ein eingelegter Film legt den Look fest; sonst der zuletzt gewählte, sonst der zuletzt mitgenommene („So fotografieren“), sonst Honig
  const chosen = looks.find((l) => l.id === lookId) ?? (recent.length ? looks[1] : (looks.find((l) => l.id === PRESETS[0].id) ?? looks[0]));
  // gemerkt, damit der Look-Effekt (190 kB LUT an die App) nur bei einem echten Wechsel läuft, nicht bei jedem Zoom- oder Belichtungsschritt
  const active = useMemo<Look>(() => (film ? { id: "film", name: film.name, approx: film.approx, edit: film.edit } : chosen), [film, chosen]);
  // Weiß-Feinabstimmung wie bei Fuji: verschiebt wbR/wbB des Looks, je Look auf dem Gerät gemerkt; der Film behält seine
  /** Werkzeug weggezogen: die Räder bleiben gestellt, der Sucher bekommt den Platz */
  const [toolsDown, setToolsDown] = useState(false);
  const grip = useRef<number | null>(null);
  /** Fingerweg am Griff, solange gezogen wird */
  const [pull, setPull] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(0);
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPanelH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tools]);
  const [shifts, setShifts] = useState<Record<string, Shift>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SHIFT_KEY) ?? "{}") as Record<string, Shift>;
    } catch {
      return {};
    }
  });
  const base: Shift = { r: active.edit?.rec.wbR ?? 0, b: active.edit?.rec.wbB ?? 0 };
  const shift = (!film && shifts[active.id]) || base;
  const setShift = (s: Shift) =>
    setShifts((prev) => {
      const next = { ...prev, [active.id]: s };
      try {
        localStorage.setItem(SHIFT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  /** der Look, wie er gerade in den Sucher und ins Foto geht: mit Weiß-Verschiebung */
  const lookNow = useMemo<Look>(() => {
    if (shift.r === base.r && shift.b === base.b) return active;
    const e = active.edit ?? neutralEdit();
    return { ...active, edit: { ...e, rec: { ...e.rec, wbR: shift.r, wbB: shift.b } } };
    // base hängt an active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, shift.r, shift.b]);

  const frameOf = useCallback((): Frame | null => {
    const r = box.current?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }, []);

  // Seite durchsichtig machen und die Kamera hinter dem Sucher starten
  useEffect(() => {
    document.documentElement.dataset.kamera = "";
    let alive = true;
    const run = async () => {
      // erst nach dem ersten Zeichnen: der Rahmen muss stehen, bevor der Sucher seine Lage bekommt
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const frame = frameOf();
      if (!frame || !alive) return;
      try {
        const lut = active.edit ? lutOf(active.edit) : undefined;
        const r = await CalimaCamera.start({ frame, ...lut });
        if (!alive) return;
        started.current = true;
        setFront(r.front);
        setInfo(r);
        setReady(true);
      } catch (e) {
        if (alive) setError(isDenied(e) ? t("Calima darf die Kamera nicht nutzen. Erlaube sie in den Einstellungen des iPhones unter Calima.") : t("Die Kamera lässt sich gerade nicht öffnen."));
      }
    };
    run();
    const onResize = () => {
      const frame = frameOf();
      if (frame && started.current) CalimaCamera.layout({ frame }).catch(() => {});
    };
    window.addEventListener("resize", onResize);
    // der Sucher wächst, wenn das Werkzeug zuklappt: das Bild der App folgt seinem Kasten
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    if (box.current) ro?.observe(box.current);
    return () => {
      alive = false;
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      delete document.documentElement.dataset.kamera;
      CalimaCamera.stop().catch(() => {});
      started.current = false;
    };
    // nur beim Öffnen; der Look danach läuft über setLut
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Look wechseln: der LUT geht hinüber, der Name bleibt gemerkt. Beim Ziehen im Weiß-Raster höchstens alle 120 ms ein
  // neuer LUT (190 kB über die Brücke), der letzte Stand kommt immer an
  const lutSent = useRef(0);
  const lutTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const send = () => {
      lutSent.current = performance.now();
      const l = lookNow.edit ? lutOf(lookNow.edit) : null;
      if (l) CalimaCamera.setLut(l).catch(() => {});
      else CalimaCamera.setOriginal({ on: true }).catch(() => {});
      if (l && !holding) CalimaCamera.setOriginal({ on: false }).catch(() => {});
      CalimaCamera.setGrain(grainOf(lookNow.edit)).catch(() => {});
    };
    window.clearTimeout(lutTimer.current);
    const wait = 120 - (performance.now() - lutSent.current);
    if (wait <= 0) send();
    else lutTimer.current = window.setTimeout(send, wait);
    try {
      localStorage.setItem(LAST_KEY, active.id);
    } catch {}
    // holding gehört nicht dazu: beim Loslassen stellt der Zeiger den Look selbst zurück
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookNow, ready]);

  const pick = (l: Look) => {
    if (l.id === active.id) return;
    haptic("select");
    setLookId(l.id);
  };

  /* ----- Werkzeug (E1): Räder an die App, Raster mit Wasserwaage, Brennweite als Zoom ----- */

  useEffect(() => {
    if (ready) CalimaCamera.setDials(dials).catch(() => {});
  }, [dials, ready]);
  useEffect(() => {
    if (ready) CalimaCamera.setLevel({ on: tools && grid }).catch(() => {});
  }, [tools, grid, ready]);
  const toggleTools = () => {
    haptic("select");
    setToolsDown(false);
    setTools((on) => {
      try {
        localStorage.setItem(TOOLS_KEY, on ? "0" : "1");
      } catch {}
      return !on;
    });
    setDial(null);
    setMetering(false);
  };
  const pickFocal = (mm: number) => {
    haptic("select");
    setFocal(mm);
    CalimaCamera.setZoom({ factor: focalZoom(mm) })
      .then((r) => setZoom(r.factor))
      .catch(() => {});
  };
  const changeDials = (next: Dials) => {
    if (dial !== "kelvin" && next[dial as DialKey] !== dials[dial as DialKey]) haptic("select");
    setDials(next);
  };
  const lenses = useMemo(() => realFocals(info?.lenses ?? [1]), [info]);
  // die Pipette gehört zum Weiß-Rad: wer es zuklappt oder ein anderes Rad nimmt, misst nicht mehr
  const whiteOpen = tools && dial === "kelvin";
  const metering = pipette && whiteOpen;
  const resetDial = (k: DialKey) => {
    haptic("press");
    setDials((d) => ({ ...d, [k]: null, ...(k === "kelvin" ? { tint: null, gains: null } : {}) }));
  };
  const togglePipette = () => {
    haptic("select");
    setWhiteMsg(null);
    setMetering(!metering);
  };
  /** Lupe beim Scharfstellen von Hand: angekündigt, damit die Vergrößerung nicht wie Unschärfe wirkt (#225) */
  const [magnified, setMagnified] = useState(false);
  const magnifyWhile = (on: boolean) => {
    setMagnified(on);
    CalimaCamera.setMagnify({ on }).catch(() => {});
  };

  /* ----- Film: ein Look, FILM_FRAMES Bilder, ein Stapel. Beiseitelegen und später weiter belichten geht; die Bilder
     sieht man erst, wenn der Film entwickelt ist (voll oder bewusst entwickelt) ----- */

  // immer vom letzten Stand aus: ein Foto ist noch unterwegs, während der Film schon beiseitegelegt sein kann
  const update = (fn: (s: Shelf) => Shelf) =>
    setShelf((prev) => {
      const next = fn(prev);
      writeShelf(next);
      return next;
    });
  const loadFilm = () => {
    if (!ready || film) return;
    haptic("press");
    const f: Film = { name: active.name, approx: active.approx, edit: active.edit, stack: newId(), count: 0 };
    update((s) => ({ loaded: f.stack, films: [...s.films, f] }));
  };
  /** Einwegkamera-Vorlage: ein Film mit festen Regeln (disposable.ts) */
  const loadDisposable = (d: Disposable) => {
    if (!ready || film) return;
    haptic("press");
    const name = t(d.name);
    const f: Film = {
      name,
      approx: false,
      edit: disposableEdit(d, name),
      stack: newId(),
      count: 0,
      rules: { id: d.id, frames: DISPOSABLE_FRAMES, zoom: focalZoom(d.mm), flash: d.flash },
    };
    takeFixed();
    update((s) => ({ loaded: f.stack, films: [...s.films, f] }));
  };
  /** eine Einwegkamera kommt in die Hand: Räder auf A, keine Marke, kein Heller/Dunkler */
  const takeFixed = () => {
    setFocal(null);
    setDial(null);
    setReticle(null);
    setDials(AUTO);
    setEv(0);
  };
  // fester Ausschnitt, solange sie eingelegt ist; beim Herausnehmen zurück auf die Hauptkamera
  const fixedZoom = fixed?.zoom ?? null;
  useEffect(() => {
    if (!ready) return;
    if (fixedZoom != null) CalimaCamera.setExposure({ ev: 0 }).catch(() => {});
    CalimaCamera.setZoom({ factor: fixedZoom ?? 1 })
      .then((r) => setZoom(r.factor))
      .catch(() => {});
  }, [fixedZoom, ready]);
  /** einen beiseitegelegten Film wieder einlegen */
  const resumeFilm = (stack: string) => {
    if (!ready || film) return;
    haptic("press");
    if (shelf.films.find((f) => f.stack === stack)?.rules) takeFixed();
    update((s) => ({ ...s, loaded: stack }));
  };
  /** Film herausnehmen, aber behalten: wie zurückspulen und in die Tasche stecken. Ein leerer Film fliegt raus. */
  const setAside = () => {
    if (!film) return;
    haptic("select");
    update((s) => ({ loaded: null, films: film.count ? s.films : s.films.filter((f) => f.stack !== film.stack) }));
  };
  /** Film entwickeln: erst jetzt werden die Bilder sichtbar, als Umschlag vorn auf dem Pult (#244) */
  const develop = (f: Film) => {
    update((s) => ({ loaded: null, films: s.films.filter((x) => x.stack !== f.stack) }));
    if (f.count) onFilmDone(f.stack, f.name);
  };

  /* ----- Gesten im Sucher: halten (Original), wischen (Licht), zwei Finger (Zoom), tippen (Schärfe) ----- */

  const gesture = useRef<{ id: number; x: number; y: number; t: number; ev0: number; mode: "wait" | "hold" | "drag" | "pinch" | "done"; timer: number; d0?: number; z0?: number; second?: { id: number; x: number; y: number } } | null>(null);
  const raf = useRef(0);
  const queued = useRef<(() => void) | null>(null);
  const later = (fn: () => void) => {
    queued.current = fn;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      queued.current?.();
      queued.current = null;
    });
  };

  const holdOriginal = (on: boolean) => {
    if (!lookNow.edit) return;
    setHolding(on);
    CalimaCamera.setOriginal({ on }).catch(() => {});
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!ready) return;
    const g = gesture.current;
    if (g && g.mode !== "done" && e.pointerId !== g.id) {
      // die Einwegkamera hat keinen Zoom
      if (fixed) return;
      // zweiter Finger: ab jetzt wird gezoomt
      window.clearTimeout(g.timer);
      if (g.mode === "hold") holdOriginal(false);
      g.second = { id: e.pointerId, x: e.clientX, y: e.clientY };
      g.d0 = Math.hypot(e.clientX - g.x, e.clientY - g.y);
      g.z0 = zoom;
      g.mode = "pinch";
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const timer = window.setTimeout(() => {
      const cur = gesture.current;
      if (cur && cur.mode === "wait") {
        cur.mode = "hold";
        holdOriginal(true);
      }
    }, HOLD_MS);
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), ev0: ev, mode: "wait", timer };
  };

  const onMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || g.mode === "done") return;
    if (g.mode === "pinch") {
      if (e.pointerId === g.id) {
        g.x = e.clientX;
        g.y = e.clientY;
      } else if (g.second && e.pointerId === g.second.id) {
        g.second.x = e.clientX;
        g.second.y = e.clientY;
      } else return;
      if (!g.second || !g.d0 || !g.z0) return;
      const d = Math.hypot(g.second.x - g.x, g.second.y - g.y);
      const want = Math.min(10, Math.max(0.5, (g.z0 * d) / g.d0));
      setFocal(null);
      later(() => CalimaCamera.setZoom({ factor: want }).then((r) => setZoom(r.factor)).catch(() => {}));
      return;
    }
    if (e.pointerId !== g.id) return;
    const dy = e.clientY - g.y;
    if (g.mode === "wait" && Math.hypot(e.clientX - g.x, dy) > MOVE_PX) {
      window.clearTimeout(g.timer);
      // Einwegkamera: nichts einzustellen, auch kein Heller/Dunkler
      g.mode = fixed ? "done" : "drag";
      if (!fixed) setShowEv(true);
    }
    if (g.mode === "drag") {
      const next = Math.round(Math.min(EV_MAX, Math.max(-EV_MAX, g.ev0 - dy / 120)) * 10) / 10;
      if (next !== ev) {
        setEv(next);
        later(() => CalimaCamera.setExposure({ ev: next }).catch(() => {}));
      }
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "pinch") {
      // der erste Finger, der geht, beendet den Zoom; der andere macht nichts mehr
      g.mode = "done";
      return;
    }
    if (e.pointerId !== g.id) return;
    window.clearTimeout(g.timer);
    if (g.mode === "hold") holdOriginal(false);
    if (g.mode === "drag") window.setTimeout(() => setShowEv(false), 900);
    // die Einwegkamera stellt selbst scharf, Tippen tut nichts
    if (g.mode === "wait" && e.type !== "pointercancel" && !fixed) {
      // kurzer Tipp: scharf stellen, die Marke zeigt wo. Noch ein Tipp auf die Marke hält Schärfe und Helligkeit fest,
      // ein Tipp auf die festgehaltene Marke löst sie wieder; ein Tipp woanders stellt dort neu scharf
      const r = box.current?.getBoundingClientRect();
      if (r) {
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const onMark = reticle && Math.hypot(px - reticle.x, py - reticle.y) < 48;
        if (onMark && reticle.locked) {
          haptic("select");
          CalimaCamera.focus({ x: reticle.x / r.width, y: reticle.y / r.height }).catch(() => {});
          setReticle(null);
        } else if (onMark) {
          haptic("press");
          CalimaCamera.focus({ x: reticle.x / r.width, y: reticle.y / r.height, lock: true }).catch(() => {});
          setReticle({ ...reticle, k: Date.now(), locked: true });
        } else {
          CalimaCamera.focus({ x: px / r.width, y: py / r.height }).catch(() => {});
          const k = Date.now();
          setReticle({ x: px, y: py, k });
          // so lange bleibt Zeit für den zweiten Tipp
          window.setTimeout(() => setReticle((cur) => (cur && cur.k === k && !cur.locked ? null : cur)), 2200);
        }
      }
    }
    gesture.current = null;
  };

  /* ----- Auslösen: das Original kommt als Datei, der Look liegt als Bearbeitung auf dem Abzug ----- */

  /**
   * Weiß messen wie „Custom WB“ an einer Fuji: Quadrat lesen, Gains rechnen, stellen und zur Kontrolle noch einmal lesen
   * (höchstens drei Runden). Das Quadrat liegt in der Mitte, seine Seite ist PATCH der Sucherbreite (der Sucher ist 3:4).
   */
  const measureWhite = async () => {
    if (!ready || busy) return;
    setBusy(true);
    haptic("press");
    const rect = { x: 0.5 - PATCH / 2, y: 0.5 - (PATCH * 0.75) / 2, w: PATCH, h: PATCH * 0.75 };
    const lock = (gains: Gains) => ({ ...dials, kelvin: null, tint: null, gains });
    try {
      let gains: Gains | null = null;
      for (let round = 0; round < 3; round++) {
        const res = correctWhite(await CalimaCamera.measureWhite({ rect }));
        if (!res.ok) {
          if (gains) break;
          haptic("warning");
          setWhiteMsg(
            res.reason === "hell"
              ? t("Zu hell zum Messen. Stell Heller/Dunkler etwas dunkler oder nimm eine Stelle ohne Glanz.")
              : res.reason === "dunkel"
                ? t("Zu dunkel zum Messen. Mehr Licht, oder stell Heller/Dunkler etwas heller.")
                : t("Das sieht nicht weiß aus. Richte das Quadrat auf etwas Weißes oder Graues."),
          );
          return;
        }
        gains = res.gains;
        if (res.done) break;
        // stellen und die Kamera kurz nachziehen lassen, dann misst die nächste Runde das neue Bild
        await CalimaCamera.setDials(lock(gains));
        await new Promise((r) => window.setTimeout(r, 350));
      }
      if (gains) {
        haptic("success");
        setDials(lock(gains));
        setMetering(false);
        setWhiteMsg(null);
      }
    } catch {
      haptic("warning");
      setWhiteMsg(t("Messen hat nicht geklappt. Versuch es noch einmal."));
    } finally {
      setBusy(false);
    }
  };

  const shoot = async () => {
    if (metering) return measureWhite();
    if (!ready || busy) return;
    setBusy(true);
    haptic("press");
    setFlash(true);
    window.setTimeout(() => setFlash(false), 140);
    try {
      const { path } = await CalimaCamera.capture(film?.rules?.flash ? { flash: true } : undefined);
      const file = await takeShot(path, `${t("Kamera")} ${stamp()}`);
      const s = await studioSource(file);
      const edit = lookNow.edit ?? undefined;
      const onFilm = film;
      const print: Print = { id: newId(), name: file.name.replace(/\.jpg$/, ""), at: Date.now(), w: s.w, h: s.h, work: s.work, page: s.page, thumb: s.thumb, meta: s.meta, edit, pos: onFilm?.count };
      onShot(print, onFilm?.stack);
      if (onFilm) {
        const next = { ...onFilm, count: onFilm.count + 1 };
        if (next.count >= framesOf(next)) {
          // voll: der Film wird entwickelt und kommt auf den Abendstapel
          haptic("success");
          develop(next);
        } else {
          update((s) => ({ ...s, films: s.films.map((f) => (f.stack === next.stack ? next : f)) }));
        }
      } else {
        // zusätzlich in die Mediathek (#210), groß und mit Look; Filme erst beim Entwickeln
        saveToLibrary([print], () => {
          setError(t("Ohne Erlaubnis für die Mediathek liegen die Fotos nur in Calima. Erlauben kannst du es in den iPhone-Einstellungen unter Calima → Fotos."));
          window.setTimeout(() => setError(null), 5000);
        });
        setCount((n) => n + 1);
        setLast((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(s.thumb);
        });
        setReview(URL.createObjectURL(s.page));
        lastShot.current = { work: s.work, edit };
        setSharp(null);
      }
      // das letzte Bild unten links zeigt den Look, sobald er klein eingerechnet ist
      if (edit) {
        const url = URL.createObjectURL(s.page);
        bakePhoto({ url, lut: buildLut(edit, LUT_N), n: LUT_N, rec: edit.rec, sizes: { large: SIZES.thumb, page: onFilm ? SIZES.thumb : SIZES.page, thumb: SIZES.thumb } })
          .then((r) => {
            onShot({ ...print, shot: r.blobs.thumb }, onFilm?.stack);
            // auf dem Film bleibt das Bild im Dunkeln, bis er entwickelt ist
            if (!onFilm) {
              setLast((old) => {
                if (old) URL.revokeObjectURL(old);
                return URL.createObjectURL(r.blobs.thumb);
              });
              setReview(URL.createObjectURL(r.blobs.page));
            }
          })
          .catch(() => {})
          .finally(() => URL.revokeObjectURL(url));
      }
    } catch {
      haptic("warning");
      setError(t("Das Foto ließ sich nicht aufnehmen. Versuch es noch einmal."));
      window.setTimeout(() => setError(null), 2500);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => void (last && URL.revokeObjectURL(last)), [last]);

  // Kamera-Knopf und Lautstärketasten lösen aus, Wischen am Knopf zoomt; der Auslöser hier ist immer der aktuelle
  const shootRef = useRef(shoot);
  useEffect(() => {
    shootRef.current = shoot;
  });
  useEffect(() => {
    const sub = CalimaCamera.addListener("event", (e) => {
      if (e.name === "shutter") shootRef.current();
      else if (e.name === "zoom" && typeof e.data.factor === "number") {
        // die Einwegkamera hat keinen Zoom: zurück auf ihren Ausschnitt
        const keep = fixedRef.current?.zoom;
        if (keep != null) {
          CalimaCamera.setZoom({ factor: keep })
            .then((r) => setZoom(r.factor))
            .catch(() => {});
          return;
        }
        setZoom(e.data.factor);
        setFocal(null);
      } else if (e.name === "meter" && typeof e.data.offset === "number") setMeter(e.data as Meter);
      else if (e.name === "level" && typeof e.data.roll === "number") setRoll(e.data.roll);
    });
    return () => {
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  const flip = () => {
    if (!ready || busy) return;
    haptic("select");
    CalimaCamera.flip()
      .then((r) => {
        setFront(r.front);
        setInfo(r);
        setZoom(1);
        // die Frontkamera kennt die Sperren nicht: alles zurück auf A
        setDials(AUTO);
        setFocal(null);
        setDial(null);
      })
      .catch(() => {});
  };

  const title = holding ? t("Original") : active.name;
  const sub = holding
    ? t("Loslassen bringt den Look zurück")
    : film
      ? fixed
        ? t("Einwegkamera, {i} von {n}", { i: film.count, n: framesOf(film) })
        : t("Film, {i} von {n}", { i: film.count, n: FILM_FRAMES })
      : active.approx
        ? t("nachempfunden")
        : active.edit
          ? ""
          : t("Ohne Look");

  return createPortal(
    <div id="calima-kamera" className="text-on-table fixed inset-0 z-[600] flex flex-col bg-transparent select-none" role="dialog" aria-label={t("Kamera")}>
      <header className="bg-table-deep flex items-center justify-between gap-2 px-3 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}>
        <IconButton label={t("Schließen")} variant="quiet" onClick={onClose} className="text-on-table">
          <X aria-hidden />
        </IconButton>
        <div className="min-w-0 text-center" aria-live="polite">
          <p className="truncate text-[15px] leading-tight font-bold tracking-[-0.01em]">{title}</p>
          <p className="text-on-table-2 truncate text-[12px] leading-tight">{sub || " "}</p>
        </div>
        <span className="flex items-center gap-1">
          <span className="text-on-table-2 text-right text-[13px] tabular-nums" aria-label={t("Zoom {factor}", { factor: `${zoom.toFixed(zoom < 1 ? 1 : zoom % 1 ? 1 : 0)}×` })}>
            {zoom.toFixed(zoom < 1 || zoom % 1 ? 1 : 0)}×
          </span>
          <IconButton label={tools ? t("Werkzeug weglegen") : t("Werkzeug")} variant="quiet" onClick={toggleTools} disabled={!!fixed} aria-pressed={tools} className={`${tools || !allAuto(dials) ? "text-cloth" : "text-on-table"} disabled:opacity-30`}>
            <SlidersHorizontal aria-hidden />
          </IconButton>
        </span>
      </header>

      {/* Sucher: 3:4 wie das Foto, durchsichtig; dahinter zeichnet die App. Hier darf nichts einen Hintergrund malen. */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-transparent">
        <div
          ref={box}
          className="relative mx-auto w-full max-w-full touch-none"
          style={{ aspectRatio: "3 / 4", maxHeight: "100%" } as CSSProperties}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {!ready && !error && (
            <p className="text-on-table-2 absolute inset-0 grid place-items-center text-sm" aria-live="polite">
              {t("Kamera öffnet …")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-on-table absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[15px] leading-snug">
              {error}
            </p>
          )}
          {tools && grid && <GridOverlay roll={roll} />}
          {tools && ready && <MeterBadge meter={meter} />}
          {metering && (
            // das Messquadrat: hierauf zielt die Pipette, wie das Feld bei „Custom WB“ an einer Fuji
            <span aria-hidden className="border-on-table pointer-events-none absolute top-1/2 left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 border-2 shadow-[0_0_0_1px_rgb(0_0_0/.35)]" style={{ width: `${PATCH * 100}%` }}>
              <span className="bg-table-deep/70 absolute -top-7 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap">{t("Weiß messen")}</span>
            </span>
          )}
          {magnified && (
            <span aria-hidden className="bg-table-deep/70 text-on-table absolute top-3 left-3 rounded-full px-2.5 py-1 text-[13px] font-semibold">
              {t("Lupe 3×")}
            </span>
          )}
          {flash && <span aria-hidden className="bg-paper/90 absolute inset-0" />}
          {reticle && (
            <span
              aria-hidden
              className={`pointer-events-none absolute h-16 w-16 border-2 transition-colors ${reticle.locked ? "border-cloth" : "border-on-table/90"}`}
              style={{ left: reticle.x - 32, top: reticle.y - 32 }}
            >
              {reticle.locked && (
                <span className="bg-cloth text-cloth-ink absolute -top-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap">
                  <Lock className="h-2.5 w-2.5" />
                  {t("Fest")}
                </span>
              )}
            </span>
          )}
          {showEv && (
            <span aria-hidden className="bg-table-deep/70 text-on-table absolute top-3 right-3 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums">
              {evLabel(ev)}
            </span>
          )}
        </div>
      </div>

      <footer className="bg-table-deep grid gap-3 pt-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
        {tools && (
          // Griff: das Werkzeug folgt dem Finger nach unten weg und wieder herauf; der Sucher wächst mit
          <div
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              grip.current = e.clientY;
              setPull(0);
            }}
            onPointerMove={(e) => grip.current != null && setPull(e.clientY - grip.current)}
            onPointerUp={(e) => {
              const dy = grip.current == null ? 0 : e.clientY - grip.current;
              grip.current = null;
              setPull(null);
              // ein Drittel des Wegs reicht; ein kurzer Tipp klappt um
              const next = Math.abs(dy) < 8 ? !toolsDown : toolsDown ? dy > -panelH / 3 : dy > panelH / 3;
              if (next !== toolsDown) haptic("select");
              setToolsDown(next);
            }}
            onPointerCancel={() => {
              grip.current = null;
              setPull(null);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setToolsDown((d) => !d)}
            aria-expanded={!toolsDown}
            aria-label={toolsDown ? t("Werkzeug hervorholen") : t("Werkzeug wegziehen, Sucher größer")}
            className="-mt-3 -mb-2 flex h-8 cursor-grab touch-none items-center justify-center gap-2 select-none"
          >
            <span aria-hidden className="bg-on-table-2/60 h-1 w-9 rounded-full" />
            {toolsDown && (
              <span className="text-on-table-2 flex items-center gap-1.5 text-[11px] font-semibold tabular-nums">
                {DIALS.filter((k) => isManual(dials, k)).length ? t("{n} von Hand", { n: DIALS.filter((k) => isManual(dials, k)).length }) : t("alles auf A")}
                {(shift.r !== base.r || shift.b !== base.b) && ` · ${fmtShift(shift)}`}
              </span>
            )}
          </div>
        )}
        {/* weggezogen bleibt alles stehen (auch ein offenes Raster), es ist nur versteckt */}
        <div
          className={tools ? "-mt-3 overflow-hidden" : "hidden"}
          style={{
            height: pull == null ? (toolsDown ? 0 : panelH || "auto") : Math.max(0, Math.min(panelH, toolsDown ? -pull : panelH - pull)),
            transition: pull == null ? "height .28s cubic-bezier(.2,.8,.2,1)" : "none",
          }}
        >
          <div ref={panel} className="grid gap-3 pt-3">
            {tools && (
              <DialChips dials={dials} dial={dial} meter={meter} focal={focal} realFocals={lenses} grid={grid} onPick={(k) => {
                  setMetering(false);
                  setDial(k);
                }} onFocal={pickFocal} onGrid={() => setGrid((g) => !g)} onReset={resetDial} />
            )}
            {tools && dial === "kelvin" && <WhiteDial dials={dials} meter={meter} shift={shift} base={base} onDials={changeDials} onShift={setShift} metering={metering} onPipette={togglePipette} />}
            {tools && dial && dial !== "focal" && dial !== "kelvin" && (
              <Ruler dial={dial} dials={dials} meter={meter} info={info} onChange={changeDials} onDragging={dial === "focus" ? magnifyWhile : undefined} />
            )}
          </div>
        </div>
        {film ? (
          <div className="flex items-center gap-3 px-4 pb-1">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="truncate font-semibold">{film.name}</span>
                <span className="text-on-table-2 flex-none tabular-nums">{t("{i} von {n}", { i: film.count, n: framesOf(film) })}</span>
              </div>
              {/* der Zählstreifen: ein Strich je Bild, so viele voll wie belichtet */}
              <div className="mt-1.5 flex gap-[3px]" aria-hidden>
                {Array.from({ length: framesOf(film) }, (_, i) => (
                  <span key={i} className={`h-1.5 flex-1 rounded-full ${i < film.count ? "bg-cloth" : "bg-on-table-2/30"}`} />
                ))}
              </div>
            </div>
            <button type="button" onClick={setAside} className="border-on-table-2/50 text-on-table flex-none rounded-full border px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap">
              {film.count ? t("Beiseitelegen") : t("Film raus")}
            </button>
            {film.count > 0 && (
              <button type="button" onClick={() => develop(film)} className="bg-cloth border-cloth text-cloth-ink flex-none rounded-full border px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap">
                {t("Entwickeln")}
              </button>
            )}
          </div>
        ) : tab === "einweg" ? (
        // Einwegkamera-Vorlagen: ein Tipp legt sie als Film ein, mit festen Regeln
        <ul className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" aria-label={t("Einwegkamera")}>
          <li className="flex-none">
            <button
              type="button"
              onClick={() => {
                haptic("select");
                setTab("looks");
              }}
              className="border-on-table-2/50 text-on-table-2 flex items-center gap-1 rounded-full border px-3 py-2 text-[13px] font-semibold whitespace-nowrap"
            >
              <ChevronLeft aria-hidden className="h-4 w-4" />
              {t("Looks")}
            </button>
          </li>
          {DISPOSABLES.map((d) => (
            <li key={d.id} className="flex-none">
              <button
                type="button"
                onClick={() => loadDisposable(d)}
                disabled={!ready}
                aria-label={t("Einwegkamera „{name}“ einlegen: {txt}", { name: t(d.name), txt: t(d.txt) })}
                className="border-on-table-2/50 text-on-table flex items-center gap-1.5 rounded-full border px-3 py-2 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50"
              >
                {d.flash ? <Zap aria-hidden className="text-cloth h-4 w-4" /> : <Sun aria-hidden className="text-on-table-2 h-4 w-4" />}
                {t(d.name)}
              </button>
            </li>
          ))}
        </ul>
        ) : (
        <ul className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" aria-label={t("Looks")}>
          <li className="flex-none">
            <button type="button" onClick={loadFilm} disabled={!ready} className="border-on-table-2/50 text-on-table flex items-center gap-1.5 rounded-full border px-3 py-2 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50">
              <FilmIcon aria-hidden className="h-4 w-4" />
              {t("Film einlegen")}
            </button>
          </li>
          <li className="flex-none">
            <button
              type="button"
              onClick={() => {
                haptic("select");
                setTab("einweg");
              }}
              className="border-on-table-2/50 text-on-table flex items-center gap-1.5 rounded-full border px-3 py-2 text-[13px] font-semibold whitespace-nowrap"
            >
              <Box aria-hidden className="h-4 w-4" />
              {t("Einwegkamera")}
              <ChevronRight aria-hidden className="text-on-table-2 -mr-1 h-4 w-4" />
            </button>
          </li>
          {/* beiseitegelegte Filme: wieder einlegen und weiter belichten; ab zwei als ein Stapel (#226) */}
          {strip.pile != null && (
            <li className="flex-none">
              <button
                type="button"
                onClick={() => {
                  haptic("select");
                  setPileOpen((o) => !o);
                }}
                aria-expanded={pileOpen}
                className="border-cloth/60 text-on-table flex items-center gap-1.5 rounded-full border border-dashed px-3 py-2 text-[13px] font-semibold whitespace-nowrap"
              >
                <FilmIcon aria-hidden className="text-cloth h-4 w-4" />
                {t("Filme · {n}", { n: strip.pile })}
                <ChevronRight aria-hidden className={`text-on-table-2 -mr-1 h-4 w-4 transition-transform ${pileOpen ? "rotate-90" : ""}`} />
              </button>
            </li>
          )}
          {strip.films.map((f) => (
            <li key={f.stack} className="flex-none">
              <button
                type="button"
                onClick={() => {
                  setPileOpen(false);
                  resumeFilm(f.stack);
                }}
                disabled={!ready}
                aria-label={t("Film „{name}“ weiter belichten, {i} von {n}", { name: f.name, i: f.count, n: framesOf(f) })}
                className="border-cloth/60 text-on-table flex items-center gap-1.5 rounded-full border border-dashed px-3 py-2 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50"
              >
                <FilmIcon aria-hidden className="text-cloth h-4 w-4" />
                {f.name}
                <span className="text-on-table-2 tabular-nums">{t("{i}/{n}", { i: f.count, n: framesOf(f) })}</span>
              </button>
            </li>
          ))}
          {looks.map((l) => {
            const on = l.id === active.id;
            return (
              <li key={l.id} className="flex-none">
                <button
                  type="button"
                  onClick={() => pick(l)}
                  aria-pressed={on}
                  className={`rounded-full border px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap transition-colors ${on ? "bg-cloth border-cloth text-cloth-ink" : "border-on-table-2/50 text-on-table"}`}
                >
                  {l.name}
                </button>
              </li>
            );
          })}
        </ul>
        )}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center px-7">
          <span className="justify-self-start">
            <button
              type="button"
              onClick={openReview}
              disabled={!!film || !review}
              aria-label={t("Letztes Foto ansehen")}
              className="relative grid h-12 w-12 place-items-center overflow-hidden rounded-[10px] border-2 border-on-table-2/60"
            >
              {film ? (
                // auf dem Film kein Vorschaubild: das gibt es erst nach dem Entwickeln
                <FilmIcon aria-hidden className="text-on-table-2 h-5 w-5" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- Blob vom Gerät
                last && <img src={last} alt="" className="h-full w-full object-cover" />
              )}
              {(film ? film.count : count) > 0 && (
                <span className="bg-cloth text-cloth-ink absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold tabular-nums">{film ? film.count : count}</span>
              )}
            </button>
          </span>
          <button
            type="button"
            onClick={shoot}
            disabled={!ready || busy}
            aria-label={metering ? t("Weiß messen") : t("Auslösen")}
            className="border-on-table grid h-[76px] w-[76px] place-items-center rounded-full border-4 disabled:opacity-50"
          >
            <span aria-hidden className={`bg-on-table block h-[60px] w-[60px] rounded-full transition-transform ${busy ? "scale-90" : ""}`} />
          </button>
          <span className="justify-self-end">
            <IconButton label={front ? t("Rückkamera") : t("Frontkamera")} variant="quiet" onClick={flip} className="text-on-table border-on-table-2/60 h-12 w-12 rounded-full border-2">
              <SwitchCamera aria-hidden />
            </IconButton>
          </span>
        </div>
        <p className="text-on-table-2 px-6 text-center text-[12px]">
          {reticle?.locked
            ? t("Schärfe und Licht stehen fest. Ein Tipp auf die Marke löst sie.")
            : reticle
              ? t("Noch ein Tipp auf die Marke hält Schärfe und Licht fest.")
              : metering
                ? (whiteMsg ?? t("Richte das Quadrat auf etwas Weißes oder Graues und drück den Auslöser. Es wird kein Foto gemacht."))
              : tools && dial === "kelvin"
                ? t("Ziehen oder tippen wählt das Licht. Feinabstimmung verschiebt die Farbe wie bei Fuji.")
                : tools && dial === "focus"
                  ? t("Ziehen stellt scharf. Solange du ziehst, zeigt die Lupe die Mitte dreifach groß.")
                : tools && dial && dial !== "focal"
            ? t("Ziehen auf dem Lineal dreht das Rad. A gibt es der Kamera zurück.")
            : tools && focal != null && !lenses.includes(focal)
              ? t("{mm} mm ist ein Ausschnitt aus der Hauptkamera, kein eigenes Objektiv.", { mm: focal })
              : fixed
                ? fixed.flash
                  ? t("Einwegkamera: fester Ausschnitt, nichts einzustellen, jedes Bild mit Blitz. Entwickelt wird bei {n}.", { n: fixed.frames })
                  : t("Einwegkamera: fester Ausschnitt, nichts einzustellen, ohne Blitz. Entwickelt wird bei {n}.", { n: fixed.frames })
              : film
            ? t("Die Bilder siehst du erst nach dem Entwickeln. Voll ist der Film bei {n}; beiseitegelegt wartet er auf dich.", { n: FILM_FRAMES })
            : count
              ? t("{n} auf dem Stapel von heute. Einsortieren kannst du abends.", { n: count === 1 ? t("Ein Foto") : t("{n} Fotos", { n: count }) })
              : lookNow.edit
                ? t("Halten zeigt das Original, Wischen macht heller oder dunkler.")
                : t("Mit einem Look zeigt Halten das Original. Wischen macht heller oder dunkler.")}
        </p>
      </footer>
      {viewing && review && !film && <PhotoZoom src={sharp ?? review} alt={t("Letztes Foto")} onClose={() => setViewing(false)} />}
    </div>,
    document.body,
  );
}
