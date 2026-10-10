import type { Plate } from "@/content/books";
import type { CopiedSettings } from "@/lib/develop/settings";
import camera from "@/content/camera.json";
import { isNeutral } from "@/lib/develop/model";
import { de } from "@/lib/i18n";

// Rezepte und Kameradaten zu den Tafeln.
// Fuji: Die Fuerteventura-Fotos sind mit einem Fuji-Rezept entstanden, die Werte stecken in den
// MakerNotes der Originale. Die Dateien hier haben keine Metadaten mehr (über den Chat geladen),
// deshalb stehen bis zum Einlesen der Originale Platzhalter da, sichtbar als „Platzhalter“ markiert.
// Lightroom: zwei freie Beispiel-Presets (peva3/Lightroom-Presets, MIT), ebenfalls als Beispiel markiert.
// Kamera: echte EXIF-Werte aus Michels iPhone-DNGs (scripts: einmal mit exifr ausgelesen).

export type FujiRecipe = {
  kind: "fuji";
  name: string;
  film: string;
  dr: string;
  wb: { mode: string; r: number; b: number };
  highlight: number;
  shadow: number;
  color: number;
  sharpness: number;
  nr: number;
  clarity: number;
  grain: { strength: 0 | 1 | 2; size: "klein" | "groß" };
  colorChrome: 0 | 1 | 2;
  fxBlue: 0 | 1 | 2;
  iso: string;
  ev: string;
  placeholder: boolean;
};

export type LightroomRecipe = {
  kind: "lightroom";
  name: string;
  /** Pfad zur .xmp-Datei, wird beim Öffnen gelesen und kann heruntergeladen werden */
  xmp?: string;
  /** oder das Preset selbst, aus einem hochgeladenen Foto erzeugt */
  inline?: string;
  source?: { label: string; url: string };
  placeholder: boolean;
};

export type CameraInfo = {
  device: string;
  focal35?: number;
  aperture?: number;
  shutter?: number;
  iso?: number;
  ev?: number;
  date?: string;
  /** Blitz hat ausgelöst (#221); fehlt, wenn die Datei es nicht sagt */
  flash?: boolean;
};

/** Calimas eigene Einstellungen aus einer gesicherten Datei (XMP-Block calima:settings), so wie die Zwischenablage sie hält */
export type CalimaRecipe = {
  kind: "calima";
  name: string;
  settings: CopiedSettings;
  placeholder: false;
};

export type Recipe = FujiRecipe | LightroomRecipe | CalimaRecipe;

const sommerlicht: FujiRecipe = {
  kind: "fuji",
  name: de("Sommerlicht"),
  film: "Classic Chrome",
  dr: "DR400",
  wb: { mode: "Auto", r: 2, b: -4 },
  highlight: -1,
  shadow: 1,
  color: 2,
  sharpness: -1,
  nr: -4,
  clarity: 0,
  grain: { strength: 1, size: "klein" },
  colorChrome: 2,
  fxBlue: 1,
  iso: de("Auto bis 3200"),
  ev: "+1/3",
  placeholder: true,
};
const nachmittag: FujiRecipe = {
  kind: "fuji",
  name: de("Nachmittag"),
  film: "Classic Negative",
  dr: "DR200",
  wb: { mode: "5500K", r: 1, b: -2 },
  highlight: 0,
  shadow: -1,
  color: 3,
  sharpness: 0,
  nr: -4,
  clarity: -2,
  grain: { strength: 2, size: "klein" },
  colorChrome: 1,
  fxBlue: 0,
  iso: de("Auto bis 6400"),
  ev: "±0",
  placeholder: true,
};
const kalkwand: FujiRecipe = {
  kind: "fuji",
  name: de("Kalkwand"),
  film: "Nostalgic Neg.",
  dr: "DR Auto",
  wb: { mode: de("Tageslicht"), r: 3, b: -5 },
  highlight: -2,
  shadow: 0,
  color: 1,
  sharpness: -2,
  nr: -4,
  clarity: 1,
  grain: { strength: 1, size: "groß" },
  colorChrome: 2,
  fxBlue: 2,
  iso: de("Auto bis 1600"),
  ev: "+2/3",
  placeholder: true,
};

const neon: LightroomRecipe = {
  kind: "lightroom",
  name: "Tokyo Neon Night",
  xmp: "/presets/tokyo-neon-night.xmp",
  source: { label: "peva3/Lightroom-Presets (MIT)", url: "https://github.com/peva3/Lightroom-Presets" },
  placeholder: true,
};
const tempel: LightroomRecipe = {
  kind: "lightroom",
  name: "Kyoto Temple",
  xmp: "/presets/kyoto-temple.xmp",
  source: { label: "peva3/Lightroom-Presets (MIT)", url: "https://github.com/peva3/Lightroom-Presets" },
  placeholder: true,
};

// Zuordnung pro Foto (Schlüssel aus books.ts)
const recipes: Record<string, Recipe> = {
  schild: sommerlicht,
  palme: sommerlicht,
  rettungsturm: sommerlicht,
  sonnenschirm: sommerlicht,
  strand: nachmittag,
  felsbogen: nachmittag,
  mittagsblume: nachmittag,
  seetraube: nachmittag,
  trompetenblume: nachmittag,
  weihnachtsstern: nachmittag,
  gartenAuto: nachmittag,
  gitterGarten: nachmittag,
  wolfsmilch: nachmittag,
  bougainvillea: nachmittag,
  padel: nachmittag,
  drachenbaum: kalkwand,
  kaktusDach: kalkwand,
  markisen: kalkwand,
  blumentopf: kalkwand,
  raupe: kalkwand,
  stuhl: kalkwand,
  spiegel: kalkwand,
  nr2: kalkwand,
  reifen: kalkwand,
  hunde: kalkwand,
  stuehleGelb: kalkwand,
  leuchtreklame: neon,
  jizo: tempel,
};

const cameras = camera as Record<string, CameraInfo>;

export function recipeOf(plate: Plate): Recipe | undefined {
  return plate.recipe ?? recipes[plate.key];
}
export function cameraOf(plate: Plate): CameraInfo | undefined {
  return plate.camera ?? cameras[plate.key];
}
/** Hat die Tafel einen Zettel (Rezept oder Kamera)? */
export const hasSlip = (plate: Plate) => !!recipeOf(plate) || !!cameraOf(plate) || !isNeutral(plate.edit);
