"use client";

import { ArrowLeft, BookmarkPlus, Camera, Check, ClipboardCopy, Download, Share, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button, buttonClass } from "@/components/ui/button";
import { notify } from "@/components/ui/toaster";
import { IS_APP } from "@/lib/app-mode";
import { haptic } from "@/lib/haptics";
import { safeFileName, saveFile } from "@/lib/native";
import { plateName, type Plate } from "@/content/books";
import { cameraOf, recipeOf, type CalimaRecipe, type CameraInfo, type FujiRecipe, type LightroomRecipe } from "@/content/recipes";
import { dayStack } from "@/lib/day-stack";
import { cleanEdit, describeEdit, isNeutral, neutralEdit, type PhotoEdit } from "@/lib/develop/model";
import { applySettings, asLook, fromEdit, fromRecipe, type CopiedSettings } from "@/lib/develop/settings";
import { de, locale, useLang, useT } from "@/lib/i18n";
import { copySettings } from "@/lib/settings-clipboard";
import { developFilm, putPrints, type Print } from "@/lib/studio-store";
import { parseXmp, type LightroomSettings } from "@/lib/xmp";

// Rezeptzettel: gleitet unter dem Buch hervor und kommt leicht schräg zur Ruhe.
// Werte rollen wie ein Zählwerk ein, die Filmsimulation wird gestempelt, Stufen füllen sich.
// Alle Werte stehen sofort im DOM; die Bewegung ist nur der Weg dorthin.

// die Kamera ist groß und kommt erst, wenn jemand „So fotografieren“ antippt
const CameraView = dynamic(() => import("@/components/camera").then((m) => m.Camera), { ssr: false });

const EXPO = [0.16, 1, 0.3, 1] as const;
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");

/** Ein Wert rollt von unten in sein Fenster */
function Roll({ children, i, reduce }: { children: React.ReactNode; i: number; reduce: boolean }) {
  return (
    <span className="relative inline-flex overflow-hidden align-bottom">
      <motion.span
        className="inline-block"
        initial={reduce ? false : { y: "105%" }}
        animate={{ y: 0 }}
        transition={{ duration: 0.5, delay: 0.32 + i * 0.04, ease: EXPO }}
      >
        {children}
      </motion.span>
    </span>
  );
}

/** Drei Stufen (aus, schwach, stark) als Balken, die sich nacheinander füllen */
function Steps({ value, i, reduce, label }: { value: 0 | 1 | 2; i: number; reduce: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="flex gap-[3px]">
        {[0, 1].map((s) => (
          <span key={s} className="relative block h-2 w-5 bg-ink/12">
            {value > s && (
              <motion.span
                className="absolute inset-0 origin-left bg-ink"
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.5, delay: 0.4 + i * 0.04 + s * 0.12, ease: EXPO }}
              />
            )}
          </span>
        ))}
      </span>
      <Roll i={i} reduce={reduce}>
        {label}
      </Roll>
    </span>
  );
}

/** Weißabgleich-Verschiebung: ein Punkt wandert von der Mitte auf R/B */
function WbCross({ r, b, reduce }: { r: number; b: number; reduce: boolean }) {
  const s = 3.2; // Pixel pro Stufe, ±9 Stufen
  return (
    <svg aria-hidden viewBox="-32 -32 64 64" className="h-12 w-12 shrink-0 overflow-visible">
      <line x1="-30" y1="0" x2="30" y2="0" className="stroke-ink/25" strokeWidth="1" />
      <line x1="0" y1="-30" x2="0" y2="30" className="stroke-ink/25" strokeWidth="1" />
      <text x="31" y="-3" className="fill-ink-2 text-[9px]" textAnchor="end">R</text>
      <text x="3" y="-24" className="fill-ink-2 text-[9px]">B</text>
      <motion.circle
        r="3.2"
        className="fill-ink"
        initial={reduce ? false : { x: 0, y: 0 }}
        animate={{ x: r * s, y: -b * s }}
        transition={{ duration: 0.9, delay: 0.45, ease: [0.77, 0, 0.175, 1] }}
      />
    </svg>
  );
}

type Row = { id: string; label: string; value: React.ReactNode };
type Tr = ReturnType<typeof useT>;
const LEVELS = [de("Aus"), de("Schwach"), de("Stark")];

/** Zeilen in der Reihenfolge des Bildqualitäts-Menüs der Kamera */
function fujiRows(r: FujiRecipe, reduce: boolean, t: Tr): Row[] {
  const grain = t(LEVELS[r.grain.strength]) + (r.grain.strength ? `, ${r.grain.size === "groß" ? t("groß") : t("klein")}` : "");
  const level = (v: 0 | 1 | 2) => t(LEVELS[v]);
  let i = 0;
  const roll = (v: React.ReactNode) => (
    <Roll i={i++} reduce={reduce}>
      {v}
    </Roll>
  );
  return [
    { id: "grain", label: t("Körnung"), value: <Steps value={r.grain.strength} i={i++} reduce={reduce} label={grain} /> },
    { id: "cc", label: "Color Chrome", value: <Steps value={r.colorChrome} i={i++} reduce={reduce} label={level(r.colorChrome)} /> },
    { id: "fxb", label: t("Color Chrome FX Blau"), value: <Steps value={r.fxBlue} i={i++} reduce={reduce} label={level(r.fxBlue)} /> },
    { id: "wb", label: t("Weißabgleich"), value: roll(`${t(r.wb.mode)}, R${signed(r.wb.r)} B${signed(r.wb.b)}`) },
    { id: "dr", label: t("Dynamikbereich"), value: roll(r.dr) },
    { id: "hl", label: t("Lichter"), value: roll(signed(r.highlight)) },
    { id: "sh", label: t("Schatten"), value: roll(signed(r.shadow)) },
    { id: "col", label: t("Farbe"), value: roll(signed(r.color)) },
    { id: "sharp", label: t("Schärfe"), value: roll(signed(r.sharpness)) },
    { id: "nr", label: t("Rauschminderung"), value: roll(signed(r.nr)) },
    { id: "cl", label: t("Klarheit"), value: roll(signed(r.clarity)) },
    { id: "iso", label: "ISO", value: roll(t(r.iso)) },
    { id: "ev", label: t("Belichtungskorrektur"), value: roll(r.ev) },
  ];
}

// Abhaken an der Kamera, gemerkt pro Rezept auf diesem Gerät
const checkKey = (name: string) => `fuji:check:${name}`;
const readChecks = (name: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(checkKey(name)) ?? "[]");
  } catch {
    return [];
  }
};

function FujiSlip({ recipe, reduce }: { recipe: FujiRecipe; reduce: boolean }) {
  const t = useT();
  const [dial, setDial] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const rows = fujiRows(recipe, reduce, t);
  const toggle = (id: string) => {
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    setChecked(next);
    try {
      localStorage.setItem(checkKey(recipe.name), JSON.stringify(next));
    } catch {}
  };
  const done = checked.length === rows.length;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        {/* Filmsimulation als Stempel */}
        <motion.p
          className="border-2 px-2 py-1 text-[15px] leading-none font-bold tracking-[-0.01em] uppercase"
          style={{ color: "var(--cloth-ink)", borderColor: "var(--cloth-ink)", fontVariationSettings: '"wdth" 80' }}
          initial={reduce ? false : { clipPath: "inset(0 100% 0 0)", rotate: -6, scale: 1.12 }}
          animate={{ clipPath: "inset(0 0% 0 0)", rotate: -2, scale: 1 }}
          transition={{ duration: 0.45, delay: 0.22, ease: EXPO }}
        >
          {t(recipe.film)}
        </motion.p>
        <WbCross r={recipe.wb.r} b={recipe.wb.b} reduce={reduce} />
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-ink-2">
              {dial ? (
                <button type="button" role="checkbox" aria-checked={checked.includes(row.id)} onClick={() => toggle(row.id)} className="-my-1 flex min-h-7 cursor-pointer items-center gap-2 text-left">
                  {/* Haken im Kreis wie in der Checkliste: gesetzt in Tinte, springt kurz auf */}
                  <span
                    aria-hidden
                    className={`grid size-[18px] flex-none place-items-center rounded-full transition-colors duration-150 ${checked.includes(row.id) ? "bg-ink text-paper" : "shadow-[inset_0_0_0_1.5px_rgb(27_28_26/0.35)]"}`}
                  >
                    {checked.includes(row.id) && (
                      <motion.span initial={reduce ? false : { scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 22 }}>
                        <Check className="size-3" strokeWidth={3} />
                      </motion.span>
                    )}
                  </span>
                  {row.label}
                </button>
              ) : (
                row.label
              )}
            </dt>
            <dd className={`text-ink ${dial && checked.includes(row.id) ? "line-through decoration-ink-2" : ""}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            if (!dial) setChecked(readChecks(recipe.name));
            setDial((d) => !d);
          }}
          className={buttonClass("paper", "sm", "pl-2.5")}
        >
          {dial ? done ? <Check aria-hidden /> : <ArrowLeft aria-hidden /> : <Camera aria-hidden />}
          {dial ? (done ? t("Fertig. Auf C1 gespeichert?") : t("Zurück zum Rezept")) : t("An der Kamera einstellen")}
        </button>
      </div>
    </>
  );
}

/** Lightroom: Grundwerte, Tonkurve, die sich zeichnet, HSL als Balken um die Mitte */
function LightroomSlip({ recipe, reduce }: { recipe: LightroomRecipe; reduce: boolean }) {
  const t = useT();
  const [loaded, setLoaded] = useState<LightroomSettings | null>(null);
  const inline = useMemo(() => (recipe.inline ? parseXmp(recipe.inline) : null), [recipe.inline]);
  useEffect(() => {
    if (recipe.inline || !recipe.xmp) return;
    let alive = true;
    fetch(recipe.xmp)
      .then((r) => r.text())
      .then((x) => alive && setLoaded(parseXmp(x)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [recipe.inline, recipe.xmp]);
  const s = inline ?? loaded;
  // Preset sichern: Datei auf dem Server oder aus dem Foto erzeugt; in der App über das Teilen-Blatt
  const savePreset = async () => {
    const text = recipe.inline ?? (recipe.xmp ? await fetch(recipe.xmp).then((r) => r.text()).catch(() => null) : null);
    const r = text ? await saveFile(safeFileName(recipe.name, ".xmp"), text, "application/rdf+xml") : "failed";
    if (r === "shared" && IS_APP) {
      notify(t("Preset gesichert."));
      haptic("success");
    } else if (r === "failed") notify(t("Die Datei ließ sich nicht anlegen. Versuch es bitte noch einmal."));
  };
  if (!s) return <p className="text-ink-2 text-sm">{t("Lade Preset …")}</p>;
  const path = s.curve.map(([x, y], i) => `${i ? "L" : "M"}${(x / 255) * 100},${100 - (y / 255) * 100}`).join(" ");
  const fmt = (v: number, unit?: string) => (unit === "EV" ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}` : signed(v));
  return (
    <>
      <div className="flex items-start gap-4">
        <svg aria-label={t("Gradationskurve")} role="img" viewBox="-2 -2 104 104" className="h-24 w-24 shrink-0">
          <rect x="0" y="0" width="100" height="100" className="fill-none stroke-ink/20" strokeWidth="0.8" />
          <line x1="0" y1="100" x2="100" y2="0" className="stroke-ink/20" strokeWidth="0.8" strokeDasharray="2 2" />
          <motion.path
            d={path}
            className="fill-none stroke-ink"
            strokeWidth="1.6"
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.77, 0, 0.175, 1] }}
          />
        </svg>
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {s.basics
            .filter((b) => b.value !== 0)
            .map((b, i) => (
              <div key={b.key} className="contents">
                <dt className="text-ink-2">{t(b.label)}</dt>
                <dd className="text-ink text-right">
                  <Roll i={i} reduce={reduce}>
                    {fmt(b.value, b.unit)}
                  </Roll>
                </dd>
              </div>
            ))}
        </dl>
      </div>
      <p className="text-ink-2 mt-4 text-[12px]">{t("Farbmischer, Sättigung")}</p>
      <ul className="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-[12px]">
        {s.hsl.map((h, i) => (
          <li key={h.color} className="contents">
            <span className="text-ink-2">{t(h.color)}</span>
            <span aria-hidden className="relative h-1.5 bg-ink/10">
              <span className="absolute inset-y-0 left-1/2 w-px bg-ink/30" />
              {h.sat !== 0 && (
                <motion.span
                  className="absolute inset-y-0 bg-ink"
                  style={{
                    left: h.sat > 0 ? "50%" : `${50 + h.sat / 2}%`,
                    width: `${Math.abs(h.sat) / 2}%`,
                    transformOrigin: h.sat > 0 ? "left" : "right",
                  }}
                  initial={reduce ? false : { scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.5, delay: 0.5 + i * 0.04, ease: EXPO }}
                />
              )}
            </span>
            <span className="text-ink w-8 text-right">{signed(h.sat)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Button variant="paper" size="sm" className="pl-2.5" onClick={savePreset}>
          {IS_APP ? <Share aria-hidden /> : <Download aria-hidden />}
          {IS_APP ? t("Als Lightroom-Preset sichern …") : t("Preset sichern (.xmp)")}
        </Button>
        {recipe.source && (
          <a href={recipe.source.url} className="text-ink-2 text-[12px] underline underline-offset-2" target="_blank" rel="noreferrer">
            {recipe.source.label}
          </a>
        )}
      </div>
    </>
  );
}

const lens = (c: CameraInfo, t: Tr, lang: ReturnType<typeof useLang>) => {
  const time = c.shutter ? (c.shutter >= 1 ? `${c.shutter}s` : `1/${Math.round(1 / c.shutter)}s`) : undefined;
  return [
    [t("Gerät"), c.device],
    [t("Brennweite"), c.focal35 ? t("{mm} mm (KB)", { mm: c.focal35 }) : undefined],
    [t("Blende"), c.aperture ? `f/${c.aperture.toFixed(1)}` : undefined],
    [t("Zeit"), time],
    ["ISO", c.iso?.toString()],
    [t("Belichtung"), c.ev !== undefined ? `${c.ev > 0 ? "+" : c.ev < 0 ? "−" : "±"}${Math.abs(c.ev).toFixed(1)} EV` : undefined],
    [t("Datum"), c.date ? new Date(c.date).toLocaleDateString(locale(lang), { day: "numeric", month: "long", year: "numeric" }) : undefined],
  ].filter((r): r is [string, string] => !!r[1]);
};

function CameraSlip({ camera, reduce }: { camera: CameraInfo; reduce: boolean }) {
  const t = useT();
  const lang = useLang();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {lens(camera, t, lang).map(([k, v], i) => (
        <div key={k} className="contents">
          <dt className="text-ink-2">{k}</dt>
          <dd className="text-ink">
            <Roll i={i} reduce={reduce}>
              {v}
            </Roll>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Was im Editor nachbearbeitet wurde; die Rezeptwerte sind nachempfunden, nicht von der Kamera */
function EditSlip({ edit, reduce }: { edit: PhotoEdit; reduce: boolean }) {
  const t = useT();
  return (
    <div>
      <p className="text-ink-2 mb-2 text-[12px]">{t("Nachbearbeitet in Calima (nachempfunden)")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {describeEdit(edit).map((r, i) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-2">{r.label}</dt>
            <dd className="text-ink">
              <Roll i={i} reduce={reduce}>
                {r.value}
              </Roll>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Einstellungen aus einer von Calima gesicherten Datei: dieselben Regler, nur aus der Datei gelesen */
function CalimaSlip({ recipe, reduce }: { recipe: CalimaRecipe; reduce: boolean }) {
  const t = useT();
  const edit = useMemo(() => applySettings(neutralEdit(), recipe.settings), [recipe.settings]);
  return (
    <div>
      <p className="text-ink-2 mb-2 text-[12px]">{recipe.settings.approx ? t("Aus der Datei gelesen, in Calima nachempfunden") : t("Aus der Datei gelesen, so wie das Foto gesichert wurde")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {describeEdit(edit).map((r, i) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-2">{r.label}</dt>
            <dd className="text-ink">
              <Roll i={i} reduce={reduce}>
                {r.value}
              </Roll>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const noopSubscribe = () => () => {};

/**
 * Einstellungen der Tafel mitnehmen, auch aus fremden Büchern: das Rezept aus der Datei (übersetzt) und die
 * Calima-Bearbeitung, je für sich. Kopieren geht ohne Konto; als Look speichern braucht eins.
 * Firebase wird erst beim Speichern geladen, damit der Zettel die Startseite nicht schwerer macht.
 */
function TakeAlong({ plate, recipe }: { plate: Plate; recipe?: ReturnType<typeof recipeOf> }) {
  const t = useT();
  const from = plateName(plate.no, plate.title);
  const file = recipe ? fromRecipe(recipe, from) : null;
  const clean = isNeutral(plate.edit) ? null : cleanEdit(plate.edit);
  const edit = clean ? fromEdit(clean, undefined, from) : null;
  const [which, setWhich] = useState<"file" | "edit" | null>(null);
  const done = which === "file" ? file : which === "edit" ? edit : null;
  const [say, setSay] = useState<string | null>(null);
  const [shooting, setShooting] = useState<string | null>(null);
  if (!file && !edit) return null;
  const take = (w: "file" | "edit", s: CopiedSettings) => {
    copySettings(s);
    setWhich(w);
    setSay(t("Mitgenommen. Liegt im Fotostudio oben bei „Deine Looks“, und in der Werkbank unter „Look übernehmen“."));
  };
  const save = async () => {
    if (!done) return;
    setSay(t("Speichere …"));
    try {
      const uid = await currentUid();
      if (!uid) return setSay(t("Zum Speichern als Look brauchst du ein Konto. Mitgenommen ist es trotzdem."));
      const { saveRecipe } = await import("@/lib/store");
      await saveRecipe(uid, asLook(done, `own-${Date.now().toString(36)}`));
      setSay(t("„{name}“ liegt jetzt in deinen Looks.", { name: done.name }));
    } catch {
      setSay(t("Der Look ließ sich nicht speichern. Mitgenommen ist er trotzdem."));
    }
  };
  const fuji = recipe?.kind === "fuji";
  // „So fotografieren“ (Kamera-Workshop): der Look geht mit in Calimas Kamera. Nur in der App. Die Kamera legt sich über das
  // offene Buch, statt ins Zimmer zu wechseln: wer sie schließt, steht wieder an derselben Tafel, und die Werkbank bleibt offen
  const shoot = async () => {
    const s = file ?? edit;
    if (!s) return;
    copySettings(s);
    haptic("tap");
    const uid = await currentUid().catch(() => null);
    if (!uid) return setSay(t("Für die Kamera brauchst du ein Konto. Mitgenommen ist der Look trotzdem."));
    setShooting(uid);
  };
  return (
    <div className="mt-4 border-t border-ink/15 pt-4">
      {shooting && <SlipCamera uid={shooting} onClose={() => setShooting(null)} />}
      {IS_APP && (
        <button type="button" className={`${buttonClass("cloth", "sm", "pl-2.5")} mb-2`} onClick={shoot}>
          <Camera aria-hidden />
          {t("So fotografieren")}
        </button>
      )}
      <div className="flex flex-wrap gap-2">
        {file && (
          <button type="button" className={buttonClass(which === "file" ? "ink" : "paper", "sm", "pl-2.5")} onClick={() => take("file", file)}>
            <ClipboardCopy aria-hidden />
            {edit ? (fuji ? t("Fuji-Rezept mitnehmen") : recipe?.kind === "calima" ? t("Calima-Look mitnehmen") : t("Lightroom-Werte mitnehmen")) : t("Für eigene Fotos mitnehmen")}
          </button>
        )}
        {edit && (
          <button type="button" className={buttonClass(which === "edit" ? "ink" : "paper", "sm", "pl-2.5")} onClick={() => take("edit", edit)}>
            <ClipboardCopy aria-hidden />
            {file ? t("Bearbeitung mitnehmen") : t("Für eigene Fotos mitnehmen")}
          </button>
        )}
        {done && (
          <button type="button" className={buttonClass("paper", "sm", "pl-2.5")} onClick={save}>
            <BookmarkPlus aria-hidden />
            {t("Als Look speichern")}
          </button>
        )}
      </div>
      <p role="status" className="text-ink-2 mt-2 text-[12px] leading-snug">
        {say ??
          (file
            ? fuji
              ? t("Farbe und Licht ohne Zuschnitt. Das Rezept wird in Calima nachempfunden, nicht exakt.")
              : recipe?.kind === "calima"
                ? t("Farbe und Licht ohne Zuschnitt, so wie das Foto gesichert wurde.")
                : t("Farbe und Licht ohne Zuschnitt. Das Preset wird in Calima nachempfunden, nicht exakt.")
            : t("Farbe und Licht ohne Zuschnitt, für deine eigenen Fotos."))}
        {done?.lost.length ? ` ${t("Nicht übertragbar: {list}.", { list: done.lost.join(", ") })}` : ""}
      </p>
    </div>
  );
}

/**
 * side: auf welcher Seite der Zettel liegt. Er liegt auf der Gegenseite seines Fotos, damit er
 * nie das Nachbarbild verdeckt und klar ist, zu welchem Bild er gehört (UX-Kritik K10).
 */
async function currentUid(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_FUJI_MOCK === "1") return "test";
  const { auth } = await import("@/lib/firebase");
  await auth().authStateReady();
  return auth().currentUser?.uid ?? null;
}

/**
 * Calimas Kamera über dem Buch. Die Aufnahmen landen wie aus dem Zimmer auf dem Gerät (Abendstapel): ohne Film auf dem
 * Stapel ihres Tages, auf einem Film im Film (entwickelt als Umschlag). Ein Hinweis sagt, wo sie liegen, und das Buch bleibt, wie es war.
 */
function SlipCamera({ uid, onClose }: { uid: string; onClose: () => void }) {
  const t = useT();
  const made = useRef({ shots: new Set<string>(), films: new Set<string>(), developed: [] as string[] });
  const onShot = (p: Print, filmStack?: string) => {
    // auf einem Film zählt die Kamera selbst, der Stapel ist der Film
    if (filmStack) {
      made.current.films.add(filmStack);
      putPrints(uid, [{ ...p, stack: filmStack }]).catch(() => {});
      return;
    }
    made.current.shots.add(p.id);
    putPrints(uid, [{ ...p, stack: dayStack(p.at), pos: p.at }]).catch(() => {});
  };
  const close = () => {
    const { shots, films, developed } = made.current;
    onClose();
    if (developed.length === 1) notify(t("Entwickelt. Der Umschlag „{name}“ liegt im Fotostudio.", { name: developed[0] }));
    else if (developed.length) notify(t("Entwickelt. Die {n} Umschläge liegen im Fotostudio.", { n: developed.length }));
    else if (shots.size) notify(shots.size === 1 ? t("Das Foto liegt auf dem Stapel von heute.") : t("Die {n} Fotos liegen auf dem Stapel von heute.", { n: shots.size }));
    else if (films.size) notify(t("Der Film liegt im Fotostudio."));
  };
  // ein entwickelter Film kommt wie im Zimmer als Umschlag auf den Pult (#244)
  const onFilmDone = (stack: string, name: string) => {
    made.current.films.delete(stack);
    made.current.developed.push(name);
    developFilm(uid, stack, name).catch(() => {});
  };
  return <CameraView uid={uid} taken onShot={onShot} onFilmDone={onFilmDone} onClose={close} />;
}

export function RecipeSlip({ plate, onClose, side = "right" }: { plate: Plate; onClose: () => void; side?: "left" | "right" }) {
  const t = useT();
  const reduce = useReducedMotion() ?? false;
  const recipe = recipeOf(plate);
  const camera = cameraOf(plate);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const phone = useSyncExternalStore(noopSubscribe, () => window.innerWidth < 768, () => false);

  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const edit = isNeutral(plate.edit) ? null : plate.edit!;
  const kind = recipe?.kind === "fuji" ? t("Fuji-Rezept") : recipe?.kind === "lightroom" ? t("Lightroom-Preset") : recipe?.kind === "calima" ? t("Calima-Look") : camera ? t("Kamera") : t("Bearbeitung");
  const title = recipe ? t(recipe.name) : (camera?.device ?? t("Nachbearbeitet"));

  return (
    <motion.aside
      role="dialog"
      aria-label={t("{kind} zu {plate}", { kind, plate: plateName(plate.no, plate.title) })}
      tabIndex={0}
      className={`slip text-ink rounded-cut fixed z-[400] max-h-[calc(100svh-24px)] w-[min(360px,calc(100vw-24px))] overflow-y-auto overscroll-contain p-5 pb-4 md:max-h-[calc(100svh-120px)] shadow-[0_24px_40px_-18px_rgb(12_10_8/0.75),0_3px_8px_-3px_rgb(12_10_8/0.5)] md:bottom-24 ${side === "left" ? "md:left-[max(24px,calc(50vw-560px))]" : "md:right-[max(24px,calc(50vw-560px))]"}`}
      style={phone ? { left: 12, bottom: 12 } : undefined}
      initial={reduce ? false : { y: 140, clipPath: "inset(100% 0 0 0)", rotate: 0 }}
      animate={{ y: 0, clipPath: "inset(0% 0 0 0)", rotate: phone ? -0.6 : side === "left" ? 1.6 : -1.6 }}
      exit={reduce ? { opacity: 0 } : { y: 120, clipPath: "inset(100% 0 0 0)", rotate: 0 }}
      transition={{ duration: 0.5, ease: EXPO }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ink-2 text-[12px]">
            {kind} · {t("Tafel {n}", { n: plate.no })}
          </p>
          <p className="truncate text-lg leading-tight font-bold tracking-[-0.02em]" style={{ fontVariationSettings: '"wdth" 80' }}>
            {title}
          </p>
        </div>
        <button ref={closeBtn} type="button" onClick={onClose} aria-label={t("Schließen")} title={t("Schließen")} className={buttonClass("paper", "icon", "-mt-1 -mr-1.5")}>
          <X aria-hidden />
        </button>
      </header>
      {recipe?.kind === "fuji" && <FujiSlip recipe={recipe} reduce={reduce} />}
      {recipe?.kind === "lightroom" && <LightroomSlip recipe={recipe} reduce={reduce} />}
      {recipe?.kind === "calima" && <CalimaSlip recipe={recipe} reduce={reduce} />}
      {recipe && camera && <div className="my-4 border-t border-ink/15" />}
      {camera && <CameraSlip camera={camera} reduce={reduce} />}
      {edit && (recipe || camera) && <div className="my-4 border-t border-ink/15" />}
      {edit && <EditSlip edit={edit} reduce={reduce} />}
      <TakeAlong plate={plate} recipe={recipe} />
      {recipe?.placeholder && (
        <p className="text-ink-2 mt-4 text-[12px]">
          {recipe.kind === "fuji"
            ? t("Platzhalter: Die echten Werte kommen aus den Originaldateien der Kamera.")
            : t("Beispiel-Preset für den Prototyp, nicht die Bearbeitung dieses Fotos.")}
        </p>
      )}
    </motion.aside>
  );
}
