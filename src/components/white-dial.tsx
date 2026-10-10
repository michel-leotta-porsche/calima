"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { type Dials, type Meter } from "@/lib/camera";
import { haptic } from "@/lib/haptics";
import { useLang, useT } from "@/lib/i18n";
import { lightOf, MEASURED, rulerOf, type Light } from "@/lib/white";

// Weiß wie an einer Fujifilm, in drei Ebenen (Entwurf „Gravur“, weissabgleich-workshop 9.10.):
// 1. das Licht: A, Kunstlicht, Neon, Sonne, Wolken, Schatten, als Gravuren auf einem Lineal, das unter der Marke einrastet.
//    Gestellt wird der echte Weißabgleich der Kamera (Kelvin, bei Neon mit Tönung gegen den Grünstich).
// 2. die Feinabstimmung: das Shift-Raster R −9…+9 und B −9…+9 wie bei Fuji. Es verschiebt wbR/wbB im Look, landet also
//    wie ein Rezeptwert im Foto. Magenta und Grün liegen in den Ecken (R+ B+ / R− B−).
// 3. die Pipette (#184): wie „Custom WB“ an einer Fuji. Ein Quadrat in der Mitte, der Auslöser misst, das Licht heißt dann
//    „Gemessen“ und gilt, bis die Kamera zugeht. Gemessen wird vor dem Look, die Wärme des Looks bleibt also drauf.

export { LIGHTS, lightOf, MEASURED, type Light } from "@/lib/white";
export const useLightName = () => {
  const lang = useLang();
  return (l: Light) => (lang === "en" ? l.en : l.name);
};

export type Shift = { r: number; b: number };
const STEP = 56;
const CELL = 8;

/** Linien-Icons auf 24-px-Raster: 1,75 Strich, runde Kappen, currentColor */
const PATHS: Record<string, ReactNode> = {
  a: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.6 16.2 12 7.6l3.4 8.6M9.9 13.1h4.2" />
    </>
  ),
  bulb: <path d="M9.2 16.4c0-2.4-3.2-3.6-3.2-7.2a6 6 0 0 1 12 0c0 3.6-3.2 4.8-3.2 7.2zM9.8 18.9h4.4M10.6 21.2h2.8M10.2 12.4l1.8-2.5 1.8 2.5" />,
  neon: (
    <>
      <rect x="3.5" y="10.5" width="17" height="5" rx="2.5" />
      <path d="M1.75 13h1.75M20.5 13h1.75M7.5 5.5v2.25M12 4.25v3.5M16.5 5.5v2.25M7.5 19v1.25M12 19v1.75M16.5 19v1.25" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M16.6 7.4l1.76-1.76M7.4 7.4 5.64 5.64M16.6 16.6l1.76 1.76M7.4 16.6l-1.76 1.76" />
    </>
  ),
  cloud: <path d="M7 18.5h10a3.75 3.75 0 0 0 .55-7.46A5.5 5.5 0 0 0 7.1 9.9 4.3 4.3 0 0 0 7 18.5z" />,
  shade: <path d="M3.5 11 12 4.5l8.5 6.5M5.8 9.3v10.2h12.4V9.3M12 7v12.5M12 19.5l6.2-6.2M12 15.2l6.2-6.2M15.4 19.5l2.8-2.8" />,
  pipette: <path d="M14.6 4.6a2.4 2.4 0 0 1 3.4 0l1.4 1.4a2.4 2.4 0 0 1 0 3.4l-2 2-4.8-4.8zM13.2 7.4 5.4 15.2 4.5 19.5l4.3-.9 7.8-7.8M11.6 9l3.4 3.4" />,
  fine: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M12 4v16M4 12h16" />
      <circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
};

export function LightIcon({ icon, size = 14, className = "" }: { icon: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={`flex-none ${className}`} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[icon]}
    </svg>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
export const fmtShift = (s: Shift) => `R${signed(s.r)} B${signed(s.b)}`;

/** Das Weiß-Werkzeug unter den Chips: Lineal mit Licht-Gravuren, auf Wunsch das Shift-Raster */
export function WhiteDial({
  dials,
  meter,
  shift,
  base,
  onDials,
  onShift,
  metering,
  onPipette,
}: {
  dials: Dials;
  meter: Meter | null;
  /** Verschiebung, wie sie gerade gilt (der Look bringt seine eigene mit) */
  shift: Shift;
  /** die Verschiebung des Looks selbst, darauf setzt „0/0“ zurück */
  base: Shift;
  onDials: (next: Dials) => void;
  onShift: (next: Shift) => void;
  /** das Messquadrat steht im Sucher, der Auslöser misst */
  metering: boolean;
  onPipette: () => void;
}) {
  const t = useT();
  const nameOf = useLightName();
  const [fine, setFine] = useState(false);
  const light = lightOf(dials);
  // gemessenes Weiß steht als eigene Gravur vor Auto, solange es gilt
  const { stops, at } = rulerOf(dials);
  const drag = useRef<{ id: number; x: number; start: number; moved: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);

  const choose = (i: number) => {
    const l = stops[Math.max(0, Math.min(stops.length - 1, i))];
    if (l === light || l === MEASURED) return;
    haptic("select");
    onDials({ ...dials, kelvin: l.kelvin, tint: l.kelvin == null ? null : l.tint, gains: null });
  };

  // Lineal: relativ ziehen, je Gravur ein Rast; tippen auf eine Gravur springt hin
  const onDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, start: at, moved: false };
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const off = e.clientX - d.x;
    if (Math.abs(off) > 6) d.moved = true;
    if (!d.moved) return;
    // die Skala folgt dem Finger, zwischen zwei Gravuren mit Widerstand
    const i = Math.max(0, Math.min(stops.length - 1, d.start - Math.round(off / STEP)));
    setDx(Math.max(-STEP / 2, Math.min(STEP / 2, off - (d.start - i) * STEP)) * 0.5);
    choose(i);
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    setDx(0);
    if (d.moved) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    choose(at + Math.round((e.clientX - (r.left + r.width / 2)) / STEP));
  };

  const measured = meter?.kelvin ? `${Math.round(meter.kelvin / 100) * 100} K` : "";
  const moved = shift.r !== base.r || shift.b !== base.b;

  if (fine) return <ShiftGrid light={light} shift={shift} base={base} onShift={onShift} onDone={() => setFine(false)} />;
  return (
    <div className="border-on-table-2/25 bg-table border-y">
      <div
        className="relative h-16 touch-none overflow-hidden select-none [mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="slider"
        aria-label={t("Licht")}
        aria-valuenow={at}
        aria-valuetext={nameOf(light)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") choose(at + 1);
          if (e.key === "ArrowLeft") choose(at - 1);
        }}
      >
        <div
          className={`absolute inset-y-0 left-1/2 ${dragging ? "" : "transition-transform duration-200 ease-out"}`}
          style={{ transform: `translateX(${-at * STEP + dx}px)` }}
          aria-hidden
        >
          <span className="bg-on-table-2/60 absolute top-[44px] h-px" style={{ left: -STEP * 3, width: STEP * (stops.length + 5) }} />
          {Array.from({ length: (stops.length + 5) * 4 }, (_, i) => -12 + i).map((i) =>
            i % 4 ? <span key={i} className="bg-on-table-2/50 absolute top-[40px] h-1 w-px" style={{ left: (i * STEP) / 4 }} /> : null,
          )}
          {stops.map((l, i) => {
            const on = i === at;
            return (
            <span key={l.id} className={`absolute top-0 flex -translate-x-1/2 flex-col items-center ${on ? "text-on-table" : "text-on-table-2/80"}`} style={{ left: i * STEP }}>
              <LightIcon icon={l.icon} size={22} className="mt-1.5" />
              <span className={`mt-[9px] h-2.5 w-px ${on ? "bg-on-table" : "bg-on-table-2"}`} />
              <span className={`mt-0.5 text-[11px] tracking-[.04em] tabular-nums ${on ? "font-semibold" : ""}`}>{l === MEASURED ? t("gemessen") : (l.kelvin ?? "auto")}</span>
            </span>
            );
          })}
        </div>
        <span aria-hidden className="bg-cloth pointer-events-none absolute top-[30px] left-1/2 h-[18px] w-0.5 -translate-x-1/2 rounded-full" />
      </div>
      <div className="flex items-center justify-between px-4 pt-2 pb-3 text-[13px]">
        <span className="tabular-nums">
          <b className="font-bold">{nameOf(light)}</b>
          {light.kelvin ? ` · ${light.kelvin} K` : light === MEASURED ? (measured ? ` · ${measured}` : null) : measured ? <span className="text-on-table-2"> · {measured} {t("gemessen")}</span> : null}
        </span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPipette}
            aria-pressed={metering}
            aria-label={t("Weiß messen")}
            className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border ${metering ? "bg-on-table text-table-deep border-on-table" : "border-on-table-2/50"}`}
          >
            <LightIcon icon="pipette" size={15} />
          </button>
          <button type="button" onClick={() => setFine(true)} className="border-on-table-2/50 relative flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold">
            <LightIcon icon="fine" size={14} />
            {moved ? fmtShift(shift) : t("Feinabstimmung")}
            {moved && <span className="bg-cloth border-table-deep absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border-2" />}
          </button>
        </span>
      </div>
    </div>
  );
}

/** Shift-Raster wie bei Fuji: 19 × 19, der Punkt wandert relativ zum Finger und rastet je Kästchen; Doppeltipp: zurück */
function ShiftGrid({ light, shift, base, onShift, onDone }: { light: Light; shift: Shift; base: Shift; onShift: (s: Shift) => void; onDone: () => void }) {
  const t = useT();
  const nameOf = useLightName();
  const lastTap = useRef(0);
  const clamp = (n: number) => Math.max(-9, Math.min(9, n));
  const set = (s: Shift) => {
    if (s.r === shift.r && s.b === shift.b) return;
    haptic(Math.abs(s.r) === 9 || Math.abs(s.b) === 9 ? "warning" : "select");
    onShift(s);
  };
  // der Punkt liegt unter dem Finger, eingerastet aufs Kästchen darunter (Michel, 10.10.: relativ wirkte versetzt)
  const cellAt = (e: ReactPointerEvent): Shift => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { r: clamp(Math.floor((e.clientX - r.left) / CELL) - 9), b: clamp(9 - Math.floor((e.clientY - r.top) / CELL)) };
  };
  const onDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      haptic("press");
      onShift(base);
      return;
    }
    lastTap.current = now;
    set(cellAt(e));
  };
  const onMove = (e: ReactPointerEvent) => {
    if (e.buttons) set(cellAt(e));
  };
  const words = [shift.r > 0 ? t("röter") : shift.r < 0 ? t("türkiser") : "", shift.b > 0 ? t("blauer") : shift.b < 0 ? t("gelber") : ""].filter(Boolean);
  const size = 19 * CELL;
  return (
    <div className="border-on-table-2/25 bg-table flex items-start justify-between gap-3 border-y py-3 pr-3 pl-4">
      <div className="flex min-w-0 flex-col gap-1.5 pt-0.5">
        <button type="button" onClick={onDone} className="text-on-table-2 flex items-center gap-1.5 text-[12px] font-semibold">
          ‹ <LightIcon icon={light.icon} size={16} />
          {nameOf(light)}
        </button>
        <p className="mt-1 text-[30px] leading-none font-semibold tracking-[-.01em] tabular-nums">
          R{signed(shift.r)} <span className="ml-1">B{signed(shift.b)}</span>
        </p>
        <p className="text-on-table-2 text-[12px]">{words.length ? t("etwas {a}", { a: words.join(t(" und etwas ")) }) : t("neutral")}</p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={() => onShift(base)} className="border-on-table-2/50 h-[30px] rounded-full border px-3 text-[12px] font-semibold tabular-nums">
            {base.r || base.b ? t("Look") : "0 / 0"}
          </button>
          <button type="button" onClick={onDone} className="bg-on-table text-table-deep h-[30px] rounded-full px-3 text-[12px] font-semibold">
            {t("Fertig")}
          </button>
        </div>
      </div>
      <div className="relative flex-none p-4" aria-hidden>
        <span className="text-on-table-2 absolute top-0 left-1/2 -translate-x-1/2 text-[11px] leading-4 font-semibold">B+</span>
        <span className="text-on-table-2 absolute bottom-0 left-1/2 -translate-x-1/2 text-[11px] leading-4 font-semibold">B−</span>
        <span className="text-on-table-2 absolute top-1/2 left-0 -translate-y-1/2 text-[11px] font-semibold">R−</span>
        <span className="text-on-table-2 absolute top-1/2 right-0 -translate-y-1/2 text-[11px] font-semibold">R+</span>
        <span className="text-on-table-2/80 absolute top-0 right-0.5 text-[11px]">M</span>
        <span className="text-on-table-2/80 absolute bottom-0 left-1 text-[11px]">G</span>
        <div
          className="bg-table-deep border-on-table-2/25 relative touch-none border"
          style={{
            width: size,
            height: size,
            backgroundImage: "radial-gradient(circle, rgb(163 154 142 / .5) 0 0.8px, transparent 1.2px)",
            backgroundSize: `${CELL}px ${CELL}px`,
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          role="slider"
          aria-label={t("Weißabgleich verschieben")}
          aria-valuenow={shift.r}
          aria-valuetext={fmtShift(shift)}
          tabIndex={0}
          onKeyDown={(e) => {
            const m: Record<string, Shift> = { ArrowRight: { r: 1, b: 0 }, ArrowLeft: { r: -1, b: 0 }, ArrowUp: { r: 0, b: 1 }, ArrowDown: { r: 0, b: -1 } };
            const v = m[e.key];
            if (v) set({ r: clamp(shift.r + v.r), b: clamp(shift.b + v.b) });
          }}
        >
          {/* Achsen, ihre Enden tragen als einzige Farbe einen Hauch der Richtung */}
          <span className="bg-on-table-2/40 pointer-events-none absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2" />
          <span className="bg-on-table-2/40 pointer-events-none absolute top-1/2 right-0 left-0 h-px -translate-y-1/2" />
          <span className="pointer-events-none absolute -top-[5px] left-1/2 h-[2px] w-1.5 -translate-x-1/2 rounded-full bg-[#6f8bc4]" />
          <span className="pointer-events-none absolute -bottom-[5px] left-1/2 h-[2px] w-1.5 -translate-x-1/2 rounded-full bg-[#cdb04a]" />
          <span className="pointer-events-none absolute top-1/2 -left-[5px] h-1.5 w-[2px] -translate-y-1/2 rounded-full bg-[#5fa6a6]" />
          <span className="pointer-events-none absolute top-1/2 -right-[5px] h-1.5 w-[2px] -translate-y-1/2 rounded-full bg-[#c4604f]" />
          <span className="border-on-table-2 pointer-events-none absolute h-2 w-2 border" style={{ left: 9 * CELL, top: 9 * CELL }} />
          <span
            className="bg-cloth pointer-events-none absolute h-[7px] w-[7px] transition-[left,top] duration-75"
            style={{ left: (shift.r + 9) * CELL + 0.5, top: (9 - shift.b) * CELL + 0.5 }}
          />
        </div>
      </div>
    </div>
  );
}
