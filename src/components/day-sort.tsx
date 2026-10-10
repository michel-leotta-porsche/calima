"use client";

import { BookPlus, Check, Ellipsis, ImagePlus, PenLine, SlidersHorizontal, Undo2, X } from "lucide-react";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform, type PanInfo } from "motion/react";
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";

import { OpenBook } from "@/components/table";
import { Button, IconButton } from "@/components/ui/button";
import { ListGroup, ListRow } from "@/components/ui/list";
import { Menu, MenuItem } from "@/components/ui/menu";
import { dayOf } from "@/lib/day-stack";
import { envelopeLabel, isEnvelope } from "@/lib/envelope";
import { bakePhoto } from "@/lib/develop/bake";
import { outSize } from "@/lib/develop/geo";
import { buildLut, isNeutral } from "@/lib/develop/model";
import { friendlyError } from "@/lib/errors";
import type { User } from "@/lib/firebase";
import { haptic } from "@/lib/haptics";
import { de, getLang, locale, useT } from "@/lib/i18n";
import { STORY_MAX } from "@/lib/day-page";
import { layDay } from "@/lib/shelve";
import { BOOK_MAX, BookFull, nextVolume, roomIn } from "@/lib/book-limit";
import { toBookData, type ClothId, type StoredBook } from "@/lib/store";
import type { Print } from "@/lib/studio-store";

// Abendstapel (Reisebuch-Workshop 9.10.2026, reisebuch-workshop-2026-10-09/abendstapel-plan.md): der Stapel eines Tages,
// ein Foto nach dem anderen, groß. Nach rechts ins Buch, nach links weg, antippen für einen Satz. Jede Entscheidung liegt
// sofort auf dem Gerät (Print.pick), wer schließt, macht später dort weiter; nichts erinnert, nichts zählt rot.
// Sind alle entschieden, legt „Fertig für heute“ den Tag als eigene Seiten ins Buch: ins zuletzt benutzte Tagebuch,
// beim ersten Mal schlägt Calima die Buchart vor. Weggelegt heißt: nicht ins Buch. Es verlässt den Pult sofort und liegt
// noch eine Woche darunter zum Zurückholen (studio-store KEEP_AWAY), ein Archiv gibt es nicht. Aus der Mediathek löscht
// Calima nie.

/** Bucharten fürs erste Tagebuch; bis die Bucharten mit Tagen kommen, sind sie Titel und Leinen des neuen Buchs */
const KINDS: { title: string; cloth: ClothId }[] = [
  { title: de("Reisetagebuch"), cloth: "meer" },
  { title: de("Tagebuch"), cloth: "ringelblume" },
  { title: de("Waldtagebuch"), cloth: "salbei" },
];
/** das Buch, in das der Abendstapel zuletzt gelegt hat: dort geht es am nächsten Abend weiter */
const RUNNING_KEY = "calima:tagebuch";
const readRunning = () => {
  try {
    return localStorage.getItem(RUNNING_KEY);
  } catch {
    return null;
  }
};
const writeRunning = (id: string) => {
  try {
    localStorage.setItem(RUNNING_KEY, id);
  } catch {}
};
/** was man zum Tag schreibt, bleibt auf dem Gerät, bis der Tag im Buch liegt (wer schließt, findet es wieder) */
const storyKey = (stack: string) => `calima:tagtext:${stack}`;
const readStory = (stack: string) => {
  try {
    return localStorage.getItem(storyKey(stack)) ?? "";
  } catch {
    return "";
  }
};
const writeStory = (stack: string, text: string) => {
  try {
    if (text) localStorage.setItem(storyKey(stack), text);
    else localStorage.removeItem(storyKey(stack));
  } catch {}
};

/** so weit (px) muss ein Foto zur Seite, damit es entschieden ist; schneller geworfen reicht weniger */
const THRESH = 110;
const FLING = 650;
const LINE_MAX = 50;
const N = 33;
const hand: CSSProperties = { fontFamily: "var(--font-hand), cursive" };
const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Target = { book: StoredBook } | { kind: number };
type Laid = { book: StoredBook; firstKey: string; count: number; spread: number };

export function DaySort({
  stack,
  prints,
  user,
  books,
  adding,
  onChange,
  onAdd,
  onEditAll,
  onLaid,
  onClose,
}: {
  stack: string;
  /** der Stapel, in der Reihenfolge der Aufnahme */
  prints: Print[];
  user: User;
  books: StoredBook[] | null;
  /** Fortschritt, solange Fotos aus der Mediathek dazukommen */
  adding: string | null;
  onChange: (ps: Print[]) => void;
  onAdd: (files: File[]) => void;
  onEditAll: () => void;
  /** der Tag liegt im Buch: was darin liegt, verlässt den Pult */
  onLaid: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // ein Umschlag (#244) öffnet sich wie ein Tag; Überschrift und Filmseite tragen Filmname und Zeitraum statt des Datums
  const film = isEnvelope(stack);
  const dayLong = film ? envelopeLabel(prints, locale(getLang())) : dayOf(stack).toLocaleDateString(locale(getLang()), { weekday: "long", day: "numeric", month: "long" });
  const open = prints.filter((p) => !p.pick);
  const current = open[0];
  const next = open[1];
  const done = prints.length - open.length;
  const last = prints.filter((p) => p.pick).sort((a, b) => (b.pickAt ?? 0) - (a.pickAt ?? 0))[0];
  const [writing, setWriting] = useState(false);
  const [laid, setLaid] = useState<Laid | null>(null);
  // solange der Tag hochlädt, bleibt alles offen: sonst ließe er sich ein zweites Mal ins Buch legen
  const [busy, setBusy] = useState(false);
  const fly = useRef<((dir: 1 | -1) => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const box = useCardBox();
  const looks = useLooks();

  // die Seite darunter steht still, solange einsortiert wird; der Fokus wandert mit herein
  useEffect(() => {
    dialog.current?.focus();
    const el = document.documentElement;
    const before = el.style.overflow;
    el.style.overflow = "hidden";
    return () => {
      el.style.overflow = before;
    };
  }, []);

  // die nächsten zwei Fotos schon mit Look rechnen, damit beim Wischen nichts wartet
  useEffect(() => {
    open.slice(0, 3).forEach((p) => void looks.get(p));
  }, [open, looks]);

  const decide = (p: Print, pick: "in" | "out") => {
    haptic(pick === "in" ? "press" : "select");
    onChange([{ ...p, pick, pickAt: Date.now() }]);
  };
  const undo = () => {
    if (!last) return;
    haptic("select");
    setWriting(false);
    onChange([{ ...last, pick: undefined, pickAt: undefined }]);
  };
  const push = (dir: 1 | -1) => {
    if (!current || writing) return;
    if (fly.current) fly.current(dir);
    else decide(current, dir > 0 ? "in" : "out");
  };

  // Tastatur am Rechner: Pfeile entscheiden, Esc schließt
  const close = () => !busy && onClose();
  const keys = useRef({ push, undo, close, writing });
  useEffect(() => {
    keys.current = { push, undo, close, writing };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.writing || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight") k.push(1);
      else if (e.key === "ArrowLeft") k.push(-1);
      else if (e.key === "Escape") k.close();
      else if (e.key === "z" && (e.metaKey || e.ctrlKey)) k.undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const finished = !current && !laid;
  const title = laid ? (film ? t("Der Film liegt im Buch") : t("Der Tag liegt im Buch")) : finished ? (film ? t("Fertig mit dem Film") : t("Fertig für heute")) : dayLong;
  const sub = adding ?? (laid ? dayLong : finished ? dayLong : t("{i} von {n}", { i: Math.min(done + 1, prints.length), n: prints.length }));

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal
      aria-label={t("Einsortieren")}
      className="linen table-surface bg-table text-on-table fixed inset-0 z-[550] flex flex-col overscroll-contain outline-none select-none"
    >
      <header className="flex items-center gap-2 px-3 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}>
        <IconButton label={laid ? t("Schließen") : t("Später weiter")} variant="quiet" onClick={close} disabled={busy} className="text-on-table">
          <X aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1 text-center" aria-live="polite">
          <h1 className="truncate text-[17px] leading-tight font-bold tracking-[-0.02em]" style={{ fontVariationSettings: '"wdth" 80' }}>
            {title}
          </h1>
          <p className="text-on-table-2 truncate text-[13px] leading-tight tabular-nums">{sub}</p>
        </div>
        {laid || busy ? (
          <span className="w-11" />
        ) : (
          <div className="flex">
            <IconButton label={t("Rückgängig")} variant="quiet" onClick={undo} disabled={!last || busy} className="text-on-table disabled:opacity-35">
              <Undo2 aria-hidden />
            </IconButton>
            <Menu
              trigger={
                <IconButton label={t("Mehr")} variant="quiet" className="text-on-table">
                  <Ellipsis aria-hidden />
                </IconButton>
              }
            >
              <MenuItem icon={<ImagePlus aria-hidden />} onClick={() => input.current?.click()}>
                {t("Fotos aus der Mediathek dazulegen …")}
              </MenuItem>
              <MenuItem icon={<SlidersHorizontal aria-hidden />} onClick={onEditAll}>
                {t("Alle im Fotostudio bearbeiten")}
              </MenuItem>
            </Menu>
          </div>
        )}
      </header>
      {!laid && !finished && (
        <span aria-hidden className="bg-on-table/10 mx-4 block h-1 overflow-hidden rounded-full">
          <span className="bg-cloth block h-full rounded-full transition-[width] duration-300" style={{ width: `${(done / Math.max(1, prints.length)) * 100}%` }} />
        </span>
      )}

      {current && !laid ? (
        <>
          <div className="relative min-h-0 flex-1">
            {next && (
              <div aria-hidden className="absolute inset-0 grid place-items-center" style={{ rotate: "-3deg", scale: 0.95, opacity: 0.85 }}>
                <Paper print={next} box={box} looks={looks} />
              </div>
            )}
            <SortCard
              key={current.id}
              print={current}
              box={box}
              looks={looks}
              flyRef={fly}
              onGone={(dir) => decide(current, dir > 0 ? "in" : "out")}
              onTap={() => setWriting(true)}
            />
            {writing && (
              <LineNote
                key={`satz-${current.id}`}
                initial={current.line ?? ""}
                onDone={(line) => {
                  setWriting(false);
                  if (line !== (current.line ?? "")) onChange([{ ...current, line: line || undefined }]);
                }}
              />
            )}
          </div>
          <footer className="grid gap-3 px-4 pt-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}>
            <div className="flex items-center justify-center gap-5">
              <RoundButton label={t("Weglegen")} onClick={() => push(-1)}>
                <X aria-hidden className="size-6" />
              </RoundButton>
              <RoundButton label={t("Einen Satz dazu")} small onClick={() => setWriting(true)}>
                <PenLine aria-hidden className="size-5" />
              </RoundButton>
              <RoundButton label={t("Ins Buch")} cloth onClick={() => push(1)}>
                <Check aria-hidden className="size-6" strokeWidth={2.6} />
              </RoundButton>
            </div>
            <p className="text-on-table-2 text-center text-[13px]">{t("Nach rechts ins Buch, nach links weg. Antippen für einen Satz.")}</p>
          </footer>
        </>
      ) : laid ? (
        <LaidView laid={laid} dayLong={dayLong} onClose={onClose} />
      ) : prints.length ? (
        <Finish
          stack={stack}
          prints={prints}
          user={user}
          books={books}
          dayLong={dayLong}
          onBusy={setBusy}
          onLaid={(l) => {
            setLaid(l);
            onLaid();
          }}
          onDone={onClose}
        />
      ) : null}

      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif,.dng"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const el = e.currentTarget;
          const fs = [...(el.files ?? [])];
          if (fs.length) onAdd(fs);
          el.value = "";
        }}
      />
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Bild mit Look */

/** Größe des Fotos beim Einsortieren: so groß, wie zwischen Kopf und Knöpfen Platz ist */
function useCardBox() {
  const read = () => ({ w: Math.min(window.innerWidth - 56, 420), h: Math.max(220, Math.min(window.innerHeight - 330, 560)) });
  const [box, setBox] = useState(read);
  useEffect(() => {
    const on = () => setBox(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return box;
}

/** Fotos mit ihrem Look in Seitengröße, einmal gerechnet und gemerkt; ohne Bearbeitung die Seitengröße selbst */
function useLooks() {
  return useMemo(() => {
    const cache = new Map<string, Promise<Blob>>();
    return {
      get(p: Print): Promise<Blob> {
        const id = `${p.id}:${p.at}`;
        let job = cache.get(id);
        if (!job) {
          const e = p.edit;
          if (!e || isNeutral(e)) job = Promise.resolve(p.page);
          else {
            const url = URL.createObjectURL(p.page);
            job = bakePhoto({ url, lut: buildLut(e, N), n: N, rec: e.rec, geo: e.geo, vignette: e.more?.vignette, clarity: e.more?.clarity, sizes: { large: 1280, page: 1280, thumb: 360 } })
              .then((r) => r.blobs.page)
              .catch(() => p.shot ?? p.page)
              .finally(() => URL.revokeObjectURL(url));
          }
          cache.set(id, job);
        }
        return job;
      },
    };
  }, []);
}
type Looks = ReturnType<typeof useLooks>;

/**
 * Objekt-URL eines Blobs, solange ihn jemand zeigt. Gezählt statt je Komponente: dasselbe Foto liegt erst unten im
 * Stapel und dann oben, und React hängt Effekte beim Entwickeln einmal probehalber ab und wieder an.
 */
const urlOf = new WeakMap<Blob, string>();
const users = new Map<string, number>();
function useBlobUrl(blob: Blob | undefined) {
  let url = blob && urlOf.get(blob);
  if (blob && !url) {
    url = URL.createObjectURL(blob);
    urlOf.set(blob, url);
  }
  useEffect(() => {
    if (!blob || !url) return;
    users.set(url, (users.get(url) ?? 0) + 1);
    return () => {
      users.set(url, (users.get(url) ?? 1) - 1);
      window.setTimeout(() => {
        if ((users.get(url) ?? 0) > 0 || urlOf.get(blob) !== url) return;
        users.delete(url);
        urlOf.delete(blob);
        URL.revokeObjectURL(url);
      }, 0);
    };
  }, [blob, url]);
  return url;
}

/** Ein Abzug, groß: weißer Rand, unten Platz für den Satz in Handschrift */
function Paper({ print, box, looks, children }: { print: Print; box: { w: number; h: number }; looks: Looks; children?: ReactNode }) {
  const [look, setLook] = useState<Blob | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    looks.get(print).then((b) => alive && setLook(b));
    return () => {
      alive = false;
    };
  }, [print, looks]);
  // bis der Look gerechnet ist: der kleine Abzug vom Pult, der ihn schon zeigt
  const url = useBlobUrl(look ?? print.shot ?? print.thumb);
  const [pw, ph] = outSize(print.edit?.geo, print.w, print.h);
  const k = Math.min((box.w - 16) / pw, (box.h - 44) / ph);
  const w = Math.round(pw * k);
  const h = Math.round(ph * k);
  return (
    <span className="bg-paper relative block p-2 pb-9 shadow-[0_1px_1px_rgb(12_10_8/0.5),0_22px_40px_-14px_rgb(12_10_8/0.85)]">
      {/* eslint-disable-next-line @next/next/no-img-element -- Blob vom Gerät */}
      {url ? <img src={url} alt="" draggable={false} className="block object-cover" style={{ width: w, height: h }} /> : <span className="bg-paper-shade block" style={{ width: w, height: h }} />}
      {print.line && (
        <span className="text-ink absolute inset-x-3 bottom-1 truncate text-[22px] leading-[1.3]" style={hand}>
          {print.line}
        </span>
      )}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Wischen */

function SortCard({
  print,
  box,
  looks,
  flyRef,
  onGone,
  onTap,
}: {
  print: Print;
  box: { w: number; h: number };
  looks: Looks;
  flyRef: React.RefObject<((dir: 1 | -1) => void) | null>;
  onGone: (dir: 1 | -1) => void;
  onTap: () => void;
}) {
  const t = useT();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 260], [-12, 12]);
  const inBook = useTransform(x, [24, THRESH], [0, 1]);
  const away = useTransform(x, [-THRESH, -24], [1, 0]);
  const armed = useRef<-1 | 0 | 1>(0);
  const gone = useRef(false);
  const dragged = useRef(false);

  // über die Schwelle: ein leichter Tick, damit die Hand weiß, dass Loslassen jetzt entscheidet
  useMotionValueEvent(x, "change", (v) => {
    const a = v > THRESH ? 1 : v < -THRESH ? -1 : 0;
    if (a !== armed.current) {
      armed.current = a;
      if (a) haptic("select");
    }
  });

  const out = (dir: 1 | -1) => {
    if (gone.current) return;
    gone.current = true;
    if (still()) return onGone(dir);
    animate(x, dir * (window.innerWidth / 2 + box.w), { duration: 0.26, ease: [0.4, 0, 1, 1] }).then(() => onGone(dir));
  };
  useEffect(() => {
    flyRef.current = out;
    return () => {
      flyRef.current = null;
    };
  });

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > THRESH || info.velocity.x > FLING) out(1);
    else if (info.offset.x < -THRESH || info.velocity.x < -FLING) out(-1);
    else animate(x, 0, { type: "spring", stiffness: 520, damping: 34 });
  };

  return (
    <motion.div
      className="absolute inset-0 grid cursor-grab touch-pan-y place-items-center active:cursor-grabbing"
      style={{ x, rotate }}
      drag="x"
      dragMomentum={false}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={onDragEnd}
      onTap={() => {
        if (dragged.current) dragged.current = false;
        else onTap();
      }}
      role="img"
      aria-label={print.line ? t("Foto: {line}", { line: print.line }) : t("Foto")}
    >
      <Paper print={print} box={box} looks={looks}>
        <motion.span style={{ opacity: inBook }} className="bg-cloth text-cloth-ink linen absolute top-5 left-4 rotate-[-8deg] overflow-hidden rounded-full px-4 py-2 text-[17px] font-bold shadow-[0_6px_14px_-4px_rgb(12_10_8/0.6)]">
          {t("Ins Buch")}
        </motion.span>
        <motion.span style={{ opacity: away }} className="bg-paper text-ink absolute top-5 right-4 rotate-[8deg] rounded-full px-4 py-2 text-[17px] font-bold shadow-[0_6px_14px_-4px_rgb(12_10_8/0.6)]">
          {t("Weglegen")}
        </motion.span>
      </Paper>
    </motion.div>
  );
}

function RoundButton({ label, onClick, cloth = false, small = false, children }: { label: string; onClick: () => void; cloth?: boolean; small?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`press grid place-items-center rounded-full ${small ? "size-12" : "size-14"} ${cloth ? "bg-cloth text-cloth-ink linen overflow-hidden" : "bg-on-table/8 text-on-table shadow-[inset_0_0_0_1px_rgb(236_230_220/0.12)]"}`}
    >
      {children}
    </button>
  );
}

/** Ein Satz zum Foto, auf einem Zettel über dem Abzug; im Buch wird er der Titel unter dem Foto */
function LineNote({ initial, onDone }: { initial: string; onDone: (line: string) => void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const finish = () => onDone(text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX));
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-[rgb(12_10_8/0.45)] px-6" onClick={finish}>
      <form
        className="note-paper deal w-full max-w-sm -rotate-1 px-4 pt-3 pb-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish();
        }}
      >
        <label className="text-ink-2 block text-[13px] font-semibold" htmlFor="tages-satz">
          {t("Ein Satz zu diesem Foto")}
        </label>
        <textarea
          id="tages-satz"
          autoFocus
          rows={2}
          maxLength={LINE_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish();
            } else if (e.key === "Escape") onDone(initial);
          }}
          enterKeyHint="done"
          placeholder={t("Ramen mit Ei. Wieder hin.")}
          className="text-ink placeholder:text-ink-2/50 mt-1 block w-full resize-none bg-transparent text-[26px] leading-[1.1] outline-none"
          style={hand}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-ink-2 text-[12px] tabular-nums">
            {text.length}/{LINE_MAX}
          </span>
          <Button type="submit" variant="paper" size="sm">
            {t("Fertig")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------------- Fertig für heute */

function Finish({
  stack,
  prints,
  user,
  books,
  dayLong,
  onBusy,
  onLaid,
  onDone,
}: {
  stack: string;
  prints: Print[];
  user: User;
  books: StoredBook[] | null;
  dayLong: string;
  onBusy: (on: boolean) => void;
  onLaid: (l: Laid) => void;
  onDone: () => void;
}) {
  const t = useT();
  const ins = prints.filter((p) => p.pick === "in");
  const outs = prints.length - ins.length;
  const own = (books ?? []).filter((b) => !b.trashed);
  const [running] = useState(readRunning);
  const [target, setTarget] = useState<Target | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState(() => readStory(stack));
  const runningBook = own.find((b) => b.id === running);
  const chosen: Target = target ?? (runningBook ? { book: runningBook } : { kind: 0 });
  // Ein Tag kommt nur ganz in ein Buch (#212). Passt er nicht mehr ins gewählte, geht er in dessen nächsten Band.
  const tooMany = ins.length - BOOK_MAX;
  const full = "book" in chosen && roomIn(chosen.book) < ins.length ? chosen.book : null;
  const volume = full ? { title: nextVolume(full.title || t("Tagebuch")), cloth: full.cloth } : null;

  if (!ins.length)
    return (
      <Scroll>
        <p className="text-on-table text-[22px] leading-snug font-bold tracking-[-0.02em]">{t("Heute kommt nichts ins Buch.")}</p>
        <p className="text-on-table-2 text-[15px]">
          {t("Was du weggelegt hast, liegt noch eine Woche unter dem Pult. Dort holst du es zurück, danach räumt Calima es weg.")}
        </p>
        <Button variant="quiet" className="mt-2 w-full" onClick={onDone}>
          {t("Fertig")}
        </Button>
      </Scroll>
    );

  const lay = async () => {
    setError(null);
    setBusy(0);
    onBusy(true);
    try {
      const into = volume ?? ("book" in chosen ? { book: chosen.book } : { title: t(KINDS[chosen.kind].title), cloth: KINDS[chosen.kind].cloth });
      const r = await layDay(user, ins, { heading: dayLong, story }, into, (i) => setBusy(i));
      writeRunning(r.book.id);
      writeStory(stack, "");
      haptic("success");
      onLaid({ book: r.book, firstKey: r.firstKey, count: ins.length, spread: r.spread });
    } catch (e) {
      // auf einem anderen Gerät voll geworden: den frischen Stand zeigen, dann bietet der Abschluss den nächsten Band an
      if (e instanceof BookFull && "book" in chosen) return setTarget({ book: e.book as StoredBook });
      setError(t("Hat nicht geklappt. Prüf die Verbindung und tipp noch einmal. ({error})", { error: friendlyError(e) }));
    } finally {
      setBusy(null);
      onBusy(false);
    }
  };

  const cta = volume
    ? t("„{title}“ anfangen", { title: volume.title })
    : "book" in chosen
      ? t("In „{title}“ legen", { title: chosen.book.title || t("Ohne Titel") })
      : t("{kind} anlegen", { kind: t(KINDS[chosen.kind].title) });

  return (
    <Scroll>
      <Story
        film={isEnvelope(stack)}
        value={story}
        disabled={busy !== null}
        onChange={(v) => {
          setStory(v);
          writeStory(stack, v);
        }}
      />
      <Spread prints={ins} dayLong={dayLong} story={story} />
      <p className="text-on-table-2 text-[15px]">
        <span className="text-on-table font-semibold">{ins.length === 1 ? t("Ein Foto kommt ins Buch.") : t("{n} Fotos kommen ins Buch.", { n: ins.length })}</span>{" "}
        {outs > 0 && (outs === 1 ? t("Eins hast du weggelegt, es liegt noch eine Woche unter dem Pult.") : t("{n} hast du weggelegt, sie liegen noch eine Woche unter dem Pult.", { n: outs }))}
      </p>

      {choosing ? (
        <ListGroup label={t("In welches Buch?")}>
          {own.map((b) => (
            <ListRow
              key={b.id}
              lead={<Cover book={b} />}
              title={b.title || t("Ohne Titel")}
              detail={roomIn(b) < ins.length ? t("Voll, der Tag braucht {n} Plätze", { n: ins.length }) : b.id === running ? t("Zuletzt dein Tagebuch") : undefined}
              onClick={() => {
                setTarget({ book: b });
                setChoosing(false);
              }}
            />
          ))}
          <ListRow
            lead={<BookPlus aria-hidden />}
            title={t("Neues Tagebuch")}
            onClick={() => {
              setTarget({ kind: 0 });
              setChoosing(false);
            }}
          />
        </ListGroup>
      ) : "book" in chosen ? (
        <div className="flex items-center gap-3">
          <Cover book={chosen.book} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold">{chosen.book.title || t("Ohne Titel")}</p>
            <p className="text-on-table-2 text-[13px]">
              {!full
                ? t("Der Tag kommt hinten dazu.")
                : roomIn(full)
                  ? t("Hat nur noch Platz für {room} Fotos. Der Tag kommt ganz in einen neuen Band.", { room: roomIn(full) })
                  : t("Ist voll ({max} Fotos). Der Tag kommt in einen neuen Band.", { max: BOOK_MAX })}
            </p>
          </div>
          <Button size="sm" onClick={() => setChoosing(true)} disabled={busy !== null}>
            {t("Anderes Buch")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2.5">
          <p className="text-on-table-2 text-[13px]">{t("Dein erstes Tagebuch. Calima schlägt vor:")}</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Buchart")}>
            {KINDS.map((k, i) => {
              const on = chosen.kind === i;
              return (
                <button
                  key={k.title}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy !== null}
                  onClick={() => setTarget({ kind: i })}
                  className={`press rounded-full px-3.5 py-2 text-[14px] font-semibold ${on ? "bg-on-table text-table" : "bg-on-table/8 text-on-table shadow-[inset_0_0_0_1px_rgb(236_230_220/0.12)]"}`}
                >
                  {t(k.title)}
                </button>
              );
            })}
          </div>
          {own.length > 0 && (
            <Button size="sm" className="justify-self-start" onClick={() => setChoosing(true)} disabled={busy !== null}>
              {t("Lieber in ein Buch, das es schon gibt")}
            </Button>
          )}
        </div>
      )}

      {!choosing && (
        <div className="grid gap-1.5">
          {tooMany > 0 && (
            <p className="text-on-table text-[15px]" role="status">
              {t("Ein Buch fasst {max} Fotos, und ein Tag kommt nur ganz hinein. Leg noch {n} weg: oben mit Rückgängig zurück zum Einsortieren.", { max: BOOK_MAX, n: tooMany })}
            </p>
          )}
          <Button variant="cloth" className="w-full" onClick={lay} disabled={busy !== null || tooMany > 0}>
            {busy !== null ? t("Lege Foto {i} von {n} …", { i: busy + 1, n: ins.length }) : cta}
          </Button>
          {busy !== null && (
            <span aria-hidden className="bg-on-table/10 block h-1 overflow-hidden rounded-full">
              <span className="bg-cloth block h-full transition-[width] duration-300" style={{ width: `${(busy / ins.length) * 100}%` }} />
            </span>
          )}
          <p className="text-on-table-2 min-h-5 text-center text-[13px]" aria-live="polite" role={error ? "alert" : undefined}>
            {error ?? (busy !== null ? t("Lädt hoch. Lass Calima dabei offen.") : "")}
          </p>
        </div>
      )}
    </Scroll>
  );
}

/** „Wie war der Tag?“: einmal für den ganzen Tag, von Hand auf die Tagesseite; leer lassen ist in Ordnung */
function Story({ film, value, disabled, onChange }: { film: boolean; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <div className="note-paper deal w-full rotate-[-0.6deg] px-4 pt-3 pb-2.5">
      <label className="text-ink-2 block text-[13px] font-semibold" htmlFor="tages-text">
        {film ? t("Was ist auf dem Film?") : t("Wie war der Tag?")}
      </label>
      <textarea
        id="tages-text"
        rows={3}
        maxLength={STORY_MAX}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("Früh los, Nebel am See. Abends Ramen.")}
        className="text-ink placeholder:text-ink-2/50 mt-1 block w-full resize-none bg-transparent text-[24px] leading-[1.15] outline-none"
        style={hand}
      />
      <p className="text-ink-2 flex justify-between gap-3 text-[12px]">
        <span>{t("Steht auf der Tagesseite. Leer lassen geht auch.")}</span>
        <span className="tabular-nums">
          {value.length}/{STORY_MAX}
        </span>
      </p>
    </div>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-md gap-4 px-5 pt-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)" }}>
        {children}
      </div>
    </div>
  );
}

/** Einband-Miniatur eines eigenen Buchs */
function Cover({ book }: { book: StoredBook }) {
  const thumb = (book.photos.find((p) => p.key === book.coverKey) ?? book.photos.find((p) => !p.shelved))?.thumb;
  // eslint-disable-next-line @next/next/no-img-element -- Einband-Miniatur aus dem eigenen Speicher
  return thumb ? <img src={thumb} alt="" className="h-10 w-[30px] flex-none object-cover" /> : <span className="bg-paper-shade block h-10 w-[30px] flex-none" />;
}

/** Vorschau der Tagesseite: links das Datum und der Text von Hand, darunter das erste Foto, rechts versetzt die nächsten */
function Spread({ prints, dayLong, story }: { prints: Print[]; dayLong: string; story: string }) {
  const page = "linen bg-paper relative overflow-hidden";
  const text = story.trim();
  return (
    <div aria-hidden className="deal grid grid-cols-2 shadow-[0_26px_44px_-16px_rgb(12_10_8/0.95)]" style={{ aspectRatio: "3 / 2" }}>
      <div className={`${page} shadow-[inset_-12px_0_16px_-12px_rgb(12_10_8/0.3)]`}>
        <p className="text-ink absolute top-[6%] right-[6%] left-[9%] text-[18px] leading-tight" style={hand}>
          {dayLong}
        </p>
        {text && (
          <p className="text-ink absolute top-[20%] right-[6%] left-[9%] line-clamp-3 text-[11px] leading-[1.25]" style={hand}>
            {text}
          </p>
        )}
        {prints[0] && <Thumb print={prints[0]} className={`absolute left-[16%] ${text ? "top-[48%] h-[44%]" : "top-[28%] h-[60%]"}`} />}
      </div>
      <div className={`${page} shadow-[inset_12px_0_16px_-12px_rgb(12_10_8/0.3)]`}>
        {prints[1] && <Thumb print={prints[1]} className="absolute top-[7%] left-[8%] h-[27%]" />}
        {prints[2] && <Thumb print={prints[2]} className="absolute top-[37%] right-[8%] h-[27%]" />}
        {prints[3] && <Thumb print={prints[3]} className="absolute top-[67%] left-[8%] h-[27%]" />}
      </div>
    </div>
  );
}

function Thumb({ print, className }: { print: Print; className: string }) {
  const url = useBlobUrl(print.shot ?? print.thumb);
  // eslint-disable-next-line @next/next/no-img-element -- Blob vom Gerät
  return url ? <img src={url} alt="" className={`bg-paper w-auto p-[3px] pb-[9px] shadow-[0_1px_1px_rgb(12_10_8/0.4),0_6px_12px_-6px_rgb(12_10_8/0.6)] ${className}`} /> : null;
}

/**
 * Danach: der Tag liegt im Buch. „Seite gestalten“ führt gleich auf die Bühne der Tagesseite (dort geht Schreiben,
 * Zeichnen, Kleben), „Buch aufschlagen“ zeigt sie zum Lesen.
 */
function LaidView({ laid, dayLong, onClose }: { laid: Laid; dayLong: string; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const { open } = useContext(OpenBook);
  const title = laid.book.title || t("Ohne Titel");
  const show = () => {
    const plate = toBookData(laid.book).plates.find((pl) => pl.key === laid.firstKey)?.no;
    onClose();
    open(laid.book.id, plate);
  };
  return (
    <Scroll>
      <div className="note-paper deal w-[86%] -rotate-1 justify-self-center px-4 pt-3 pb-3.5">
        <p className="text-ink text-[24px] leading-[1.05]" style={hand}>
          {dayLong}
        </p>
        <p className="text-ink-2 mt-1 text-[15px]">
          {laid.count === 1 ? t("Ein Foto liegt in „{title}“.", { title }) : t("{n} Fotos liegen in „{title}“.", { n: laid.count, title })}
        </p>
      </div>
      <Button
        variant="cloth"
        className="mt-2 w-full"
        onClick={() => {
          onClose();
          router.push(`/neu?id=${laid.book.id}&doppelseite=${laid.spread + 1}`);
        }}
      >
        {t("Seite gestalten")}
      </Button>
      <Button className="w-full" onClick={show}>
        {t("Buch aufschlagen")}
      </Button>
      <Button variant="quiet" className="justify-self-center" onClick={onClose}>
        {t("Schließen")}
      </Button>
    </Scroll>
  );
}
