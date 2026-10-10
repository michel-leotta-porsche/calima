"use client";

import exifr from "exifr";

import type { CameraInfo, Recipe } from "@/content/recipes";
import { cleanSettings } from "@/lib/develop/settings";
import { exifDate, type ExifFields } from "@/lib/exif-write";
import { flashFired } from "@/lib/flash";
import { readFujiRecipe } from "@/lib/fuji";
import { findSubject } from "@/lib/subject";
import { t } from "@/lib/i18n";
import { parseCalimaXmp, parseXmp, toPreset } from "@/lib/xmp";

// Ein Foto für ein neues Buch vorbereiten, ganz im Browser:
// Rezept und Kameradaten lesen, dann neu kodieren in drei Größen. Beim Neukodieren fallen alle
// Metadaten weg, also auch GPS und Seriennummer. Hochgeladen werden nur die neuen Dateien.

export const SIZES = { thumb: 360, page: 1280, large: 2560 } as const;
export type SizeName = keyof typeof SIZES;

export type Ingested = {
  key: string;
  name: string;
  w: number;
  h: number;
  blobs: Record<SizeName, Blob>;
  /** mittlere Farbe in Lab, für die automatische Folge */
  color: [number, number, number];
  /** Hauptmotiv (0..1) und ob es ein Gesicht ist */
  subject: [number, number];
  face: boolean;
  taken?: string;
  camera?: CameraInfo;
  recipe?: Recipe;
};

// Was der Browser nicht selbst öffnen kann, wird vorher lesbar gemacht:
// DNG (iPhone ProRAW, Kamera-RAW) bringt ein fertig entwickeltes JPEG in voller Größe mit, HEIC wandelt heic-to um.
const isDng = (f: File) => /\.dng$/i.test(f.name) || /dng/i.test(f.type);
const isHeic = (f: File) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);

/** Größtes eingebettetes JPEG aus einer TIFF/DNG-Datei, dazu die Lage laut IFD0 */
async function dngPreview(file: File): Promise<{ blob: Blob; orientation: number } | null> {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  if (dv.getUint16(2, le) !== 42) return null;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const values = (e: number) => {
    const type = u16(e + 2);
    const count = u32(e + 4);
    if (type !== 3 && type !== 4 && type !== 13) return [];
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? e + 8 : u32(e + 8);
    return Array.from({ length: Math.min(count, 64) }, (_, i) => (size === 2 ? u16(at + i * 2) : u32(at + i * 4)));
  };
  let best: { offset: number; length: number; area: number } | null = null;
  let orientation = 1;
  const seen = new Set<number>();
  const walk = (off: number, top: boolean) => {
    if (!off || off + 2 > buf.byteLength || seen.has(off)) return;
    seen.add(off);
    const n = u16(off);
    const t: Record<number, number[]> = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > buf.byteLength) break;
      t[u16(e)] = values(e);
    }
    if (top && t[274]) orientation = t[274][0];
    const w = t[256]?.[0] ?? 0;
    const h = t[257]?.[0] ?? 0;
    // Kompression 6/7 = JPEG; nur ein Streifen, sonst ist es kein ganzes Bild
    const offset = t[513]?.[0] ?? (t[273]?.length === 1 ? t[273][0] : 0);
    const length = t[514]?.[0] ?? (t[279]?.length === 1 ? t[279][0] : 0);
    if ((t[259]?.[0] === 6 || t[259]?.[0] === 7) && offset && length && offset + length <= buf.byteLength) {
      // verlustfreie JPEGs (SOF3) sind die Rohdaten, die kann kein Browser zeigen
      const head = new Uint8Array(buf, offset, Math.min(length, 65536));
      let baseline = false;
      for (let i = 2; i < head.length - 1; i++)
        if (head[i] === 0xff && (head[i + 1] === 0xc0 || head[i + 1] === 0xc1 || head[i + 1] === 0xc2)) {
          baseline = true;
          break;
        } else if (head[i] === 0xff && head[i + 1] === 0xc3) break;
      if (baseline && head[0] === 0xff && head[1] === 0xd8 && (!best || w * h > best.area)) best = { offset, length, area: w * h || length };
    }
    for (const sub of t[330] ?? []) walk(sub, false);
    walk(u32(off + 2 + n * 12), false);
  };
  walk(u32(4), true);
  const b = best as { offset: number; length: number } | null;
  return b ? { blob: new Blob([buf.slice(b.offset, b.offset + b.length)], { type: "image/jpeg" }), orientation } : null;
}

type Source = { image: ImageBitmap | HTMLImageElement; w: number; h: number; orientation: number; close: () => void };

async function decode(blob: Blob, orientation = 1): Promise<Source> {
  // createImageBitmap dekodiert außerhalb des Hauptthreads und dreht nach EXIF
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { image: bmp, w: bmp.width, h: bmp.height, orientation, close: () => bmp.close() };
    } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { image: img, w: img.naturalWidth, h: img.naturalHeight, orientation, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("unsupported");
  }
}

async function open(file: File): Promise<Source> {
  if (isDng(file)) {
    const p = await dngPreview(file).catch(() => null);
    if (!p) throw new Error(t("DNG ohne Vorschaubild, bitte als JPEG exportieren"));
    // trägt das Vorschaubild seine Lage selbst (iPhone), dreht der Browser; sonst gilt die Lage aus der DNG
    const own = await exifr.orientation(p.blob).catch(() => undefined);
    return decode(p.blob, own ? 1 : p.orientation);
  }
  try {
    return await decode(file);
  } catch {}
  if (isHeic(file)) {
    // Chrome und Firefox können HEIC nicht öffnen; die Umwandlung kommt erst, wenn sie gebraucht wird
    const { heicTo } = await import("heic-to");
    const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 }).catch(() => null);
    if (jpeg) return decode(jpeg);
  }
  throw new Error(t("Bildformat wird nicht unterstützt"));
}

/** Erste Stufe: Original auf die große Größe bringen, gedreht nach Orientation (nur bei DNG nötig) */
function drawLarge(src: Source, long: number): HTMLCanvasElement {
  const swap = src.orientation >= 5 && src.orientation <= 8;
  const ow = swap ? src.h : src.w;
  const oh = swap ? src.w : src.h;
  const s = Math.min(1, long / Math.max(ow, oh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(ow * s);
  canvas.height = Math.round(oh * s);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const W = canvas.width;
  const H = canvas.height;
  // EXIF-Orientation als Matrix
  const m: Record<number, [number, number, number, number, number, number]> = {
    2: [-1, 0, 0, 1, W, 0],
    3: [-1, 0, 0, -1, W, H],
    4: [1, 0, 0, -1, 0, H],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, W, 0],
    7: [0, -1, -1, 0, W, H],
    8: [0, -1, 1, 0, 0, H],
  };
  if (m[src.orientation]) ctx.setTransform(...m[src.orientation]);
  ctx.drawImage(src.image, 0, 0, swap ? H : W, swap ? W : H);
  return canvas;
}

function shrink(from: HTMLCanvasElement, long: number): HTMLCanvasElement {
  const s = Math.min(1, long / Math.max(from.width, from.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(from.width * s);
  canvas.height = Math.round(from.height * s);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toJpeg = (canvas: HTMLCanvasElement, quality = 0.86) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("Kodieren fehlgeschlagen")))), "image/jpeg", quality));

// sRGB → Lab (D65), reicht für Farbähnlichkeit
function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function averageColor(canvas: HTMLCanvasElement): [number, number, number] {
  const small = document.createElement("canvas");
  small.width = 12;
  small.height = 12;
  const ctx = small.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, 12, 12);
  const d = ctx.getImageData(0, 0, 12, 12).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  return toLab(r / n, g / n, b / n);
}

/** EXIF-Zahl nur übernehmen, wenn sie wirklich eine ist (manche Programme schreiben Brüche als Paar) */
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const pick = ["Make", "Model", "LensModel", "FocalLengthIn35mmFormat", "FocalLength", "FNumber", "ExposureTime", "ISO", "ExposureCompensation", "DateTimeOriginal", "Flash"];

/**
 * Messpunkt: was eine Datei an Metadaten mitbringt, um Dateiauswahl am Rechner, Datei-Feld auf dem iPhone und
 * native Fotoauswahl zu vergleichen. Läuft in der Entwicklung immer, sonst nur mit localStorage „calima:meta“ = 1.
 */
function logMeta(file: File, found: Record<string, unknown>) {
  let on = process.env.NODE_ENV !== "production";
  try {
    on ||= localStorage.getItem("calima:meta") === "1";
  } catch {}
  if (on) console.info("calima:meta", { name: file.name, type: file.type, size: file.size, ...found });
}

/** Was beim Öffnen gelesen wird: Datum, Kamera, Rezept, dazu die Felder fürs Zurückschreiben (ohne Ort) */
export type PhotoMeta = { taken?: string; camera?: CameraInfo; recipe?: Recipe; exif: ExifFields };

export async function readMeta(file: File): Promise<PhotoMeta> {
  let meta: Record<string, unknown> = {};
  try {
    // makerNote: die MakerNote kommt roh mit (für das Fuji-Rezept), aus JPEG, HEIF und DNG gleichermaßen
    meta = (await exifr.parse(file, { pick: [...pick, "MakerNote"], makerNote: true })) ?? {};
  } catch {}
  const iso = num(meta.ISO);
  const ev = num(meta.ExposureCompensation);
  const make = String(meta.Make ?? "");
  const taken = meta.DateTimeOriginal instanceof Date ? meta.DateTimeOriginal.toISOString() : undefined;

  let recipe: Recipe | undefined;
  const note = meta.makerNote instanceof Uint8Array ? meta.makerNote : undefined;
  if (note && /fujifilm/i.test(make)) recipe = readFujiRecipe(note, { iso, ev }) ?? undefined;
  // XMP getrennt lesen: mit pick lässt exifr den XMP-Block weg
  let xmp: string | undefined;
  try {
    const x = await exifr.parse(file, { tiff: false, xmp: { parse: false } });
    xmp = typeof x?.xmp === "string" ? x.xmp : undefined;
  } catch {}
  // eine von Calima gesicherte Datei trägt ihre Einstellungen selbst
  if (!recipe && xmp) {
    const own = cleanSettings(parseCalimaXmp(xmp));
    if (own) recipe = { kind: "calima", name: own.name, settings: own, placeholder: false };
  }
  if (!recipe && xmp) {
    const lr = parseXmp(xmp);
    // nur wenn wirklich Entwicklungswerte drinstehen, nicht bloß ein Profilname
    if (lr && (lr.basics.some((b) => b.value !== 0) || lr.gray)) {
      const name = lr.name ?? "Lightroom-Einstellungen";
      recipe = { kind: "lightroom", name, inline: toPreset(xmp, name), placeholder: false };
    }
  }
  logMeta(file, { make, note: !!note, xmp: !!xmp, crs: !!xmp?.includes("camera-raw-settings"), recipe: recipe?.kind });

  const camera: CameraInfo | undefined = meta.Model
    ? {
        device: [/apple/i.test(make) ? "" : make.replace(/\s*CORPORATION/i, ""), String(meta.Model)].filter(Boolean).join(" "),
        focal35: num(meta.FocalLengthIn35mmFormat) ?? num(meta.FocalLength),
        aperture: num(meta.FNumber),
        shutter: num(meta.ExposureTime),
        iso,
        ev,
        date: taken?.slice(0, 10),
        // nur „ausgelöst“ merken: ein Blitz, der nicht kam, ist für das Rezept keine Zeile wert
        ...(flashFired(meta.Flash) ? { flash: true } : {}),
      }
    : undefined;

  const exif: ExifFields = {
    make: make || undefined,
    model: meta.Model ? String(meta.Model) : undefined,
    lens: meta.LensModel ? String(meta.LensModel) : undefined,
    taken: meta.DateTimeOriginal instanceof Date ? exifDate(meta.DateTimeOriginal) : undefined,
    exposure: num(meta.ExposureTime),
    fnumber: num(meta.FNumber),
    iso,
    ev,
    focal: num(meta.FocalLength),
    focal35: num(meta.FocalLengthIn35mmFormat),
  };
  return { taken, camera, recipe, exif };
}

export async function ingest(file: File, key: string, known?: PhotoMeta): Promise<Ingested> {
  const { taken, camera, recipe } = known ?? (await readMeta(file));
  const src = await open(file);
  const canvases: HTMLCanvasElement[] = [];
  try {
    // Stufen statt dreimal vom Original: schneller und genauso scharf
    const large = drawLarge(src, SIZES.large);
    const page = shrink(large, SIZES.page);
    const thumb = shrink(page, SIZES.thumb);
    canvases.push(large, page, thumb);
    const [bl, bp, bt, subject] = await Promise.all([toJpeg(large), toJpeg(page), toJpeg(thumb), findSubject(page)]);
    return {
      key,
      name: file.name,
      w: large.width,
      h: large.height,
      blobs: { large: bl, page: bp, thumb: bt },
      color: averageColor(thumb),
      subject: subject.point,
      face: subject.face,
      taken,
      camera,
      recipe,
    };
  } finally {
    // wie im Fotostudio: Safari gibt große Zeichenflächen sonst erst spät frei, bei 60 Fotos ist dann der Speicher voll
    for (const c of canvases) c.width = c.height = 0;
    src.close();
  }
}

/** Fürs Fotostudio: das Foto als Arbeitsfassung (lange Kante 4096, gedreht), dazu Seiten- und Daumengröße für die Vorschau */
export type StudioSource = { w: number; h: number; work: Blob; page: Blob; thumb: Blob; meta: PhotoMeta };
export const STUDIO_LONG = 4096;

export async function studioSource(file: File): Promise<StudioSource> {
  const meta = await readMeta(file);
  const src = await open(file);
  const canvases: HTMLCanvasElement[] = [];
  try {
    const large = drawLarge(src, STUDIO_LONG);
    canvases.push(large);
    // Bild sofort freigeben: ein entpacktes 48-MP-Foto belegt fast 200 MB
    src.close();
    const page = shrink(large, SIZES.page);
    const thumb = shrink(page, SIZES.thumb);
    canvases.push(page, thumb);
    const [work, bp, bt] = await Promise.all([toJpeg(large, 0.92), toJpeg(page), toJpeg(thumb)]);
    return { w: large.width, h: large.height, work, page: bp, thumb: bt, meta };
  } finally {
    src.close();
    // Safari gibt den Speicher großer Zeichenflächen sonst erst spät frei, auch wenn etwas schiefging
    for (const c of canvases) c.width = c.height = 0;
  }
}
