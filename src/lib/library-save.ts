"use client";

import { CalimaCamera, LUT_N } from "@/lib/camera";
import { bakePhoto } from "@/lib/develop/bake";
import { buildLut } from "@/lib/develop/model";
import { SIZES } from "@/lib/ingest";
import { base64 } from "@/lib/native";
import { workOf, type Print } from "@/lib/studio-store";

// Kamerafotos zusätzlich in die iOS-Mediathek (#210): bis sie in einem Buch sind, liegen sie sonst nur im Speicher der
// App und gehen mit ihr verloren. Gesichert wird groß (SIZES.large) und mit Look, so wie das Foto im Sucher aussah.
// Fotos auf einem Film erst beim Entwickeln. Eins nach dem anderen, damit beim schnellen Auslösen nichts den Speicher
// sprengt; ein Fehler hält die Kamera nie auf.

let queue: Promise<unknown> = Promise.resolve();
const DENIED_KEY = "calima:mediathek-verweigert";

/** true, wenn die Mediathek das Sichern schon einmal verweigert hat (für einen einmaligen Hinweis) */
export const libraryDenied = () => {
  try {
    return localStorage.getItem(DENIED_KEY) === "1";
  } catch {
    return false;
  }
};

async function bakeLarge(p: Print): Promise<Blob> {
  const work = await workOf(p);
  if (!p.edit) return work;
  const url = URL.createObjectURL(work);
  try {
    const r = await bakePhoto({ url, lut: buildLut(p.edit, LUT_N), n: LUT_N, rec: p.edit.rec, sizes: { large: SIZES.large, page: SIZES.thumb, thumb: SIZES.thumb } });
    return r.blobs.large;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fotos in die Mediathek legen; meldet über onDenied, wenn die Berechtigung fehlt (einmal je Gerät). videos: je Foto
 * der bewegte Teil eines Live Photos (#188), das Foto mit Look wird sein Standbild
 */
export function saveToLibrary(prints: Print[], onDenied?: () => void, videos: Record<string, string> = {}): Promise<void> {
  const run = async () => {
    for (const p of prints) {
      try {
        const video = videos[p.id];
        const r = await CalimaCamera.saveToLibrary({ data: await base64(await bakeLarge(p)), ...(video ? { video } : {}) });
        if (r.denied) {
          for (const v of Object.values(videos)) CalimaCamera.discard({ path: v }).catch(() => {});
          if (!libraryDenied()) onDenied?.();
          try {
            localStorage.setItem(DENIED_KEY, "1");
          } catch {}
          return;
        }
        try {
          localStorage.removeItem(DENIED_KEY);
        } catch {}
      } catch {}
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
