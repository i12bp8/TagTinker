/*
 * Shared image-fetch / decode / dither helpers used by every plugin
 * that wants to render a downloaded raster onto the e-paper canvas.
 *
 * - fetchImageGray(url): downloads, sniffs PNG vs JPEG, decodes, then
 *   composites alpha over white and converts to perceptual luma. The
 *   result is always a tightly packed Uint8Array of grayscale 0..255.
 * - blitGrayDither(canvas, ...): nearest-neighbour scales a grayscale
 *   buffer into a destination rect on a Canvas and serpentine
 *   Floyd-Steinberg dithers it to monochrome ink in the process.
 *
 * Keeping these in one file means the worker bundle ships UPNG / jpeg-js
 * once, not once per plugin, and any pixel-level improvements (e.g.
 * a different dither) propagate everywhere automatically.
 */

import * as UPNG from "upng-js";
// jpeg-js is CommonJS without proper types, so import as any.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import jpegJs from "jpeg-js";
import { Canvas, Ink } from "./canvas";

export interface GrayImage { gray: Uint8Array; w: number; h: number; }

/** Fetch a remote image and reduce it to a grayscale luma buffer. PNG
 *  and JPEG are both supported - we sniff the magic bytes rather than
 *  trusting the URL extension or the Content-Type header (which CDNs
 *  frequently get wrong). */
export async function fetchImageGray(url: string): Promise<GrayImage | null> {
  let raw: ArrayBuffer;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "TagTinker/1.0" } });
    if (!r.ok) return null;
    raw = await r.arrayBuffer();
  } catch {
    return null;
  }
  return decodeImageGray(raw);
}

/** Decode a buffer into grayscale, sniffing PNG vs JPEG on first bytes. */
export function decodeImageGray(buf: ArrayBuffer): GrayImage | null {
  const u8 = new Uint8Array(buf);
  if (u8.length < 4) return null;
  let rgba: Uint8Array;
  let w: number, h: number;
  /* PNG magic: 89 50 4E 47 */
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
    let dec;
    try { dec = UPNG.decode(buf); } catch { return null; }
    const arr = UPNG.toRGBA8(dec);
    if (!arr.length) return null;
    rgba = new Uint8Array(arr[0]);
    w = dec.width; h = dec.height;
  /* JPEG magic: FF D8 FF */
  } else if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) {
    let dec;
    try { dec = jpegJs.decode(u8, { useTArray: true }); } catch { return null; }
    rgba = dec.data as Uint8Array;
    w = dec.width; h = dec.height;
  } else {
    return null;
  }

  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const r = rgba[j]     * a + 255 * (1 - a);
    const g = rgba[j + 1] * a + 255 * (1 - a);
    const b = rgba[j + 2] * a + 255 * (1 - a);
    gray[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
  }
  return { gray, w, h };
}

/** Serpentine Floyd-Steinberg dither into a destination rect. The
 *  source is nearest-neighbour scaled into a working float buffer so
 *  the dither runs at output resolution (where artefacts actually
 *  matter to the user). */
export function blitGrayDither(
  c: Canvas, dx: number, dy: number, dstW: number, dstH: number,
  img: GrayImage, ink: Ink = 0,
): void {
  const { gray, w: srcW, h: srcH } = img;
  const buf = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      buf[y * dstW + x] = gray[sy * srcW + sx];
    }
  }
  for (let y = 0; y < dstH; y++) {
    const rev = (y & 1) === 1;
    const xStart = rev ? dstW - 1 : 0;
    const xEnd   = rev ? -1       : dstW;
    const xStep  = rev ? -1       : 1;
    for (let x = xStart; x !== xEnd; x += xStep) {
      const i = y * dstW + x;
      const old = buf[i];
      const np = old < 128 ? 0 : 255;
      if (np === 0) c.setPixel(dx + x, dy + y, ink);
      const err = old - np;
      const sx = rev ? -1 : 1;
      if (x + sx >= 0 && x + sx < dstW)              buf[i + sx]            += err * 7 / 16;
      if (y + 1 < dstH) {
        if (x - sx >= 0 && x - sx < dstW)            buf[i + dstW - sx]     += err * 3 / 16;
        buf[i + dstW]                                                       += err * 5 / 16;
        if (x + sx >= 0 && x + sx < dstW)            buf[i + dstW + sx]     += err * 1 / 16;
      }
    }
  }
}
