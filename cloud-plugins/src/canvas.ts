/*
 * Server-side 1bpp / 2bpp canvas. Each plane is a packed bitmap with the
 * exact byte layout the ESP forwards to the Flipper (and the Flipper
 * TXes verbatim to the tag): rows top-down, bytes MSB-first within a
 * row, row_stride padded to 4 bytes (BMP convention).
 *
 *   bit == 0  ->  ink off (white)
 *   bit == 1  ->  ink on  (black on plane 0, accent on plane 1)
 *
 * Plane 1 only allocated when accent is requested AND supported.
 */

import { FONT_5x7, FONT_5x7_W, FONT_5x7_H } from "./font";

export type Ink = 0 | 1; // 0 = primary (black), 1 = accent (red/yellow)

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly planes: number;
  readonly rowStride: number;
  readonly plane0: Uint8Array;
  readonly plane1: Uint8Array | null;

  constructor(width: number, height: number, planes: 1 | 2) {
    this.width = width;
    this.height = height;
    this.planes = planes;
    this.rowStride = ((width + 31) >> 5) << 2; // round up to 4 bytes
    this.plane0 = new Uint8Array(this.rowStride * height);
    this.plane1 = planes === 2 ? new Uint8Array(this.rowStride * height) : null;
  }

  private plane(ink: Ink): Uint8Array {
    if (ink === 1 && this.plane1) return this.plane1;
    return this.plane0;
  }

  setPixel(x: number, y: number, ink: Ink = 0): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const p = this.plane(ink);
    const i = y * this.rowStride + (x >> 3);
    p[i] |= 0x80 >> (x & 7);
  }

  clearPixel(x: number, y: number, ink: Ink = 0): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const p = this.plane(ink);
    const i = y * this.rowStride + (x >> 3);
    p[i] &= ~(0x80 >> (x & 7));
  }

  hline(x: number, y: number, w: number, ink: Ink = 0): void {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, ink);
  }

  vline(x: number, y: number, h: number, ink: Ink = 0): void {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, ink);
  }

  line(x0: number, y0: number, x1: number, y1: number, ink: Ink = 0): void {
    // Bresenham
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      this.setPixel(x0, y0, ink);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  rect(x: number, y: number, w: number, h: number, ink: Ink = 0): void {
    this.hline(x, y, w, ink);
    this.hline(x, y + h - 1, w, ink);
    this.vline(x, y, h, ink);
    this.vline(x + w - 1, y, h, ink);
  }

  fillRect(x: number, y: number, w: number, h: number, ink: Ink = 0): void {
    for (let yy = 0; yy < h; yy++) this.hline(x, y + yy, w, ink);
  }

  /* ---- Text -------------------------------------------------------- */

  textSize(s: string, scale = 1): { w: number; h: number } {
    return { w: s.length * (FONT_5x7_W + 1) * scale, h: FONT_5x7_H * scale };
  }

  drawText(x: number, y: number, s: string, ink: Ink = 0, scale = 1): void {
    for (let ci = 0; ci < s.length; ci++) {
      const ch = s.charCodeAt(ci);
      const idx = ch >= 32 && ch <= 127 ? ch - 32 : 0;
      const glyph = FONT_5x7[idx] ?? FONT_5x7[0];
      for (let row = 0; row < FONT_5x7_H; row++) {
        const bits = glyph[row];
        for (let col = 0; col < FONT_5x7_W; col++) {
          if (bits & (1 << (FONT_5x7_W - 1 - col))) {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                this.setPixel(
                  x + (ci * (FONT_5x7_W + 1) + col) * scale + dx,
                  y + row * scale + dy,
                  ink,
                );
              }
            }
          }
        }
      }
    }
  }

  drawTextCentered(cx: number, y: number, s: string, ink: Ink = 0, scale = 1): void {
    const { w } = this.textSize(s, scale);
    this.drawText(cx - (w >> 1), y, s, ink, scale);
  }

  drawTextRight(rx: number, y: number, s: string, ink: Ink = 0, scale = 1): void {
    const { w } = this.textSize(s, scale);
    this.drawText(rx - w, y, s, ink, scale);
  }

  /* ---- Sparkline --------------------------------------------------- */

  sparkline(
    x: number, y: number, w: number, h: number,
    samples: number[], ink: Ink = 0, dot = true,
  ): void {
    if (samples.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (const v of samples) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi === lo) hi = lo + 1;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const px = x + Math.round((i * (w - 1)) / (samples.length - 1));
      const py = y + h - 1 - Math.round(((samples[i] - lo) * (h - 1)) / (hi - lo));
      xs.push(px); ys.push(py);
    }
    for (let i = 1; i < samples.length; i++) {
      this.line(xs[i - 1], ys[i - 1], xs[i], ys[i], ink);
    }
    if (dot) {
      const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
      this.fillRect(lx - 1, ly - 1, 3, 3, ink);
    }
  }

  /* ---- Floyd-Steinberg dither (image to 1bpp/2bpp) ----------------- */

  /**
   * Blit a pre-scaled grayscale (or RGB) image into the canvas with
   * Floyd-Steinberg dithering. `gray` is row-major, 1 byte per pixel.
   * `rgb` (optional) is row-major RGB triplets; when present and an accent
   * mode is set, saturated red/yellow pixels are routed to plane 1.
   */
  blitDithered(
    dx: number, dy: number, dw: number, dh: number,
    gray: Uint8Array, rgb: Uint8Array | null, sw: number, sh: number,
    accentMode: "none" | "red" | "yellow",
  ): void {
    // Nearest-neighbour scale source -> dest, then dither in place.
    const buf = new Float32Array(dw * dh);
    const accFlag = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
        const gi = sy * sw + sx;
        buf[y * dw + x] = gray[gi];
        if (rgb && accentMode !== "none") {
          const ri = gi * 3;
          const r = rgb[ri], g = rgb[ri + 1], b = rgb[ri + 2];
          if (accentMode === "red" && r > 150 && g < 90 && b < 90) {
            accFlag[y * dw + x] = 1;
          } else if (accentMode === "yellow" && r > 180 && g > 150 && b < 100) {
            accFlag[y * dw + x] = 1;
          }
        }
      }
    }
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = y * dw + x;
        const old = buf[i];
        const isAccent = accFlag[i] === 1;
        const newPx = old < 128 ? 0 : 255;
        if (newPx === 0) {
          this.setPixel(dx + x, dy + y, isAccent ? 1 : 0);
        }
        const err = old - newPx;
        if (x + 1 < dw)             buf[i + 1]      += err * 7 / 16;
        if (y + 1 < dh) {
          if (x > 0)                buf[i + dw - 1] += err * 3 / 16;
          buf[i + dw]                                += err * 5 / 16;
          if (x + 1 < dw)           buf[i + dw + 1] += err * 1 / 16;
        }
      }
    }
  }

  /* ---- Serialization ---------------------------------------------- */

  /**
   * Encode as the binary blob the ESP forwards to the Flipper:
   *   uint16 width LE, uint16 height LE, uint8 planes, uint8 reserved,
   *   uint16 row_stride LE,
   *   plane0 bytes,
   *   plane1 bytes (if planes == 2).
   */
  toBytes(): Uint8Array {
    const planeBytes = this.rowStride * this.height;
    const total = 8 + planeBytes * this.planes;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint16(0, this.width, true);
    view.setUint16(2, this.height, true);
    out[4] = this.planes;
    out[5] = 0;
    view.setUint16(6, this.rowStride, true);
    out.set(this.plane0, 8);
    if (this.plane1) out.set(this.plane1, 8 + planeBytes);
    return out;
  }
}
