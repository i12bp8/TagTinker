/*
 * Identicon plugin - DEF CON / hardware-hacker badge aesthetic.
 *
 * The card is laid out like an actual electronics badge: a "chip" on the
 * left holding the symmetric pixel-art identicon (with silkscreen border
 * and orientation notch), a typographic stack on the right with the
 * callsign in big type / a hex UID / a role tag, PCB-style pin headers
 * along the top edge, and a binary "barcode" footer that's deterministic
 * from the seed so two people with the same name get the same pattern -
 * exactly like a real con badge. Accent ink (red/yellow on tri-colour
 * tags) carries the role tag, chip notch, pin row and a few signature
 * highlights so the card pops in a photo.
 *
 * Avatar sources:
 *   - "local"    : the built-in symmetric 5x5/7x7/9x9 pixel grid.
 *   - DiceBear   : pixel-art / bottts / lorelei / micah / adventurer /
 *                  fun-emoji / shapes / pixel - fetched from the public
 *                  DiceBear API as a small PNG, decoded with upng-js,
 *                  and Floyd-Steinberg dithered into the chip area.
 *                  Same callsign always picks the same face because
 *                  the seed is the literal name.
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";
import { fetchImageGray, blitGrayDither } from "../image_util";

/* FNV-1a 32-bit. Used everywhere we need a deterministic seed. */
function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/* xorshift32 PRNG factory. */
function rng(seed: number) {
  let r = seed || 0xCAFEBABE;
  return () => {
    r ^= r << 13; r >>>= 0;
    r ^= r >>> 17;
    r ^= r << 5;  r >>>= 0;
    return r;
  };
}

/* Hacker-flavoured class tags. Pick deterministically from the seed
 * so the same name always gets the same role - just like a real con
 * where your callsign is the immutable part of your identity. */
const ROLES = [
  "OPERATOR", "ANALYST", "PHREAK", "CRACKER",
  "HACKER",   "AGENT",   "GHOST",  "ROGUE",
  "ARTIST",   "WIZARD",  "SCOUT",  "CIPHER",
];

/* DiceBear style ids supported by this plugin. The empty string maps to
 * the local generator. Order matters - it's the order shown in the FAP
 * dropdown. */
const STYLES = [
  "local", "pixel-art", "bottts", "lorelei",
  "adventurer", "micah", "fun-emoji", "shapes",
];

/* DiceBear avatar URL builder. The actual fetch / decode / dither is
 * done by the shared `image_util` helpers so every other image plugin
 * (GitHub avatars, NASA APOD, etc.) shares the same pipeline. */
function dicebearUrl(style: string, seed: string, size: number): string {
  return `https://api.dicebear.com/9.x/${encodeURIComponent(style)}` +
         `/png?seed=${encodeURIComponent(seed)}` +
         `&size=${size}` +
         `&backgroundColor=ffffff`;
}

/* ─── Drawing helpers ─────────────────────────────────────────────── */

/** A dashed horizontal line - reads as a PCB trace. */
function dashedHLine(c: Canvas, x: number, y: number, w: number, dash: number, gap: number, ink: Ink) {
  let xx = 0;
  while (xx < w) {
    const len = Math.min(dash, w - xx);
    for (let i = 0; i < len; i++) c.setPixel(x + xx + i, y, ink);
    xx += dash + gap;
  }
}

/** Pin-header row: alternating filled/empty squares like an IC pin
 *  strip. Used at the top of the badge for hardware authenticity. */
function pinHeader(c: Canvas, x: number, y: number, count: number,
                   pin: number, gap: number, ink: Ink) {
  for (let i = 0; i < count; i++) {
    const px = x + i * (pin + gap);
    if ((i & 1) === 0) {
      // filled square
      for (let dy = 0; dy < pin; dy++)
        for (let dx = 0; dx < pin; dx++)
          c.setPixel(px + dx, y + dy, ink);
    } else {
      // empty square (outline only)
      c.rect(px, y, pin, pin, ink);
    }
  }
}

/** Chip silkscreen: rounded-corner rectangle with a notch on top
 *  (the universal "this is an IC" affordance). */
function chipFrame(c: Canvas, x: number, y: number, w: number, h: number,
                   notchInk: Ink, frameInk: Ink) {
  // Outer frame
  c.rect(x, y, w, h, frameInk);
  // Inner shadow line for "engraved" feel
  c.rect(x + 2, y + 2, w - 4, h - 4, frameInk);
  // Top-centre orientation notch (semicircle approximation in 5 px)
  const nx = x + (w >> 1) - 2;
  const ny = y;
  // Fill paper above the notch then re-draw with notch ink.
  for (let i = 0; i < 5; i++) c.whitePixel(nx + i, ny);
  for (let i = 0; i < 5; i++) c.whitePixel(nx + i, ny + 1);
  // Notch arc
  c.setPixel(nx + 1, ny, notchInk);
  c.setPixel(nx + 2, ny, notchInk);
  c.setPixel(nx + 3, ny, notchInk);
  c.setPixel(nx,     ny + 1, notchInk);
  c.setPixel(nx + 4, ny + 1, notchInk);
  c.setPixel(nx + 1, ny + 2, notchInk);
  c.setPixel(nx + 2, ny + 2, notchInk);
  c.setPixel(nx + 3, ny + 2, notchInk);
}

/** Crosshair / reticle - decorative element. */
function crosshair(c: Canvas, cx: number, cy: number, r: number, ink: Ink) {
  c.line(cx - r, cy, cx + r, cy, ink);
  c.line(cx, cy - r, cx, cy + r, ink);
  // Outer tick marks
  c.setPixel(cx - r - 2, cy, ink);
  c.setPixel(cx + r + 2, cy, ink);
  c.setPixel(cx, cy - r - 2, ink);
  c.setPixel(cx, cy + r + 2, ink);
  // Centre dot
  c.setPixel(cx, cy, ink);
}

/** Binary "barcode" strip derived from a seed. Each bit becomes a
 *  filled or empty cell of the given width. Looks like a hardware
 *  serial barcode, reads as cyberpunk decoration. */
function binaryBar(c: Canvas, x: number, y: number, totalW: number, h: number,
                   seed: number, ink: Ink) {
  const cellW = 2;
  const cells = Math.floor(totalW / cellW);
  let r = seed;
  for (let i = 0; i < cells; i++) {
    r ^= r << 13; r >>>= 0;
    r ^= r >>> 17;
    r ^= r << 5;  r >>>= 0;
    if ((r & 0xFF) > 110) {
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < cellW; dx++)
          c.setPixel(x + i * cellW + dx, y + dy, ink);
    }
  }
}

/* ─── Plugin ─────────────────────────────────────────────────────── */

export const identiconPlugin: Plugin = {
  manifest: {
    id: "identicon",
    name: "Identicon",
    description: "DEF CON-style hacker badge from a callsign",
    accent_modes: 1 | 2 | 4,
    params: [
      { key: "name",  label: "Callsign", type: "string", default: "Dolphin" },
      { key: "style", label: "Style",    type: "enum",   default: "pixel-art",
        options: STYLES },
      /* These two only matter when style == "local" - the DiceBear
       * styles render a pre-composed image and ignore them. */
      { key: "grid",    label: "Grid",      type: "enum", default: "7",
        options: ["5", "7", "9"] },
      { key: "subStyle", label: "Local Pat.", type: "enum", default: "blocky",
        options: ["blocky", "rings", "diagonal"] },
    ],
  },

  async render(params, W, H, accent: AccentMode) {
    const name     = ((params.name ?? "Dolphin").trim() || "Dolphin").toUpperCase();
    const style    = params.style ?? "pixel-art";
    const grid     = parseInt(params.grid ?? "7", 10);
    const subStyle = params.subStyle ?? "blocky";
    const seed     = hash32(name);

    const planes: 1 | 2 = accent === "none" ? 1 : 2;
    const c = new Canvas(W, H, planes);
    const acc: Ink = planes === 2 ? 1 : 0;
    const blk: Ink = 0;

    /* ── Geometry ──────────────────────────────────────────────── */
    const margin = 4;
    const headerH = 8;       // top pin row + trace
    const footerH = 12;      // bottom barcode + tagline

    /* ── Top pin header strip ──────────────────────────────────── */
    {
      const pinSize = 3;
      const pinGap  = 2;
      const stride  = pinSize + pinGap;
      const count   = Math.floor((W - margin * 2) / stride);
      const px = margin + 1;
      const py = margin;
      pinHeader(c, px, py, count, pinSize, pinGap, acc);
    }
    /* PCB trace just under the pin row, with a gap in the middle for
     * a small label tag. */
    {
      const traceY = margin + 8;
      const tagText = `\u25C6 DEFCON 2026 \u25C6`;
      const tagSize = c.textSize(tagText, 1);
      const tagX = (W - tagSize.w) >> 1;
      // Left dashed segment.
      dashedHLine(c, margin + 4, traceY, tagX - margin - 8, 4, 2, blk);
      // Right dashed segment.
      const rStart = tagX + tagSize.w + 4;
      dashedHLine(c, rStart, traceY, W - margin - 4 - rStart, 4, 2, blk);
      // Tag label centred.
      c.drawText(tagX, traceY - 3, tagText, blk, 1);
    }

    /* ── Identicon "chip" on the left ─────────────────────────── */
    const bodyTop = margin + headerH + 8;
    const bodyBot = H - footerH - margin;
    const bodyH   = bodyBot - bodyTop;

    const chipSize = Math.min(bodyH, Math.floor(W * 0.42));
    const chipX = margin + 2;
    const chipY = bodyTop + ((bodyH - chipSize) >> 1);

    chipFrame(c, chipX, chipY, chipSize, chipSize, acc, blk);

    /* Inner area where the avatar lives - the chip frame eats 6 px on
     * each side so the avatar isn't crowding the silkscreen. */
    const inset    = 6;
    const innerW   = chipSize - inset * 2;
    const innerH   = chipSize - inset * 2;
    const innerX   = chipX + inset;
    const innerY   = chipY + inset;

    if (style === "local") {
      /* Built-in symmetric pixel grid (zero-network). */
      const cell  = Math.floor(innerW / grid);
      const used  = cell * grid;
      const ax    = chipX + ((chipSize - used) >> 1);
      const ay    = chipY + ((chipSize - used) >> 1);
      const half  = Math.ceil(grid / 2);
      const next  = rng(seed);

      const cells: boolean[][] = [];
      for (let y = 0; y < grid; y++) {
        cells.push([]);
        for (let x = 0; x < half; x++) {
          let on = (next() & 0xFF) > 110;
          if (subStyle === "rings") {
            const dx = x - (half - 1) / 2;
            const dy = y - (grid - 1) / 2;
            on = on !== ((Math.round(Math.sqrt(dx * dx + dy * dy)) & 1) === 0);
          } else if (subStyle === "diagonal") {
            on = on !== (((x + y) & 1) === 0);
          }
          cells[y].push(on);
        }
      }
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const sx = x < half ? x : grid - 1 - x;
          if (cells[y][sx]) {
            c.fillRect(ax + x * cell, ay + y * cell, cell, cell, blk);
          }
        }
      }
    } else {
      /* DiceBear-rendered avatar: fetch a small PNG (max(innerW, 96))
       * for crisp dithering, then Floyd-Steinberg into the chip. We
       * fall through to the local generator on any network failure
       * so a flaky connection still produces a valid badge. */
      const fetchSize = Math.max(96, innerW);
      const dib = await fetchImageGray(dicebearUrl(style, name, fetchSize));
      if (dib) {
        blitGrayDither(c, innerX, innerY, innerW, innerH, dib, blk);
      } else {
        /* Soft fallback: a single accented "?" in the chip area so the
         * user knows the avatar fetch failed but the rest of the
         * badge is still useful. */
        const q = "?";
        const qs = c.textSize(q, 4);
        c.drawText(innerX + ((innerW - qs.w) >> 1),
                   innerY + ((innerH - qs.h) >> 1),
                   q, acc, 4);
      }
    }

    /* Tiny crosshair in the chip's bottom-right corner - reads as a
     * registration/orientation mark, very PCB. */
    crosshair(c, chipX + chipSize - 6, chipY + chipSize - 6, 2, acc);

    /* ── Right column: callsign / UID / role tag ──────────────── */
    const rightX = chipX + chipSize + 8;
    const rightW = W - rightX - margin - 2;

    /* CALLSIGN: pick the largest scale the name fits in. */
    let callScale = 3;
    while (callScale > 1 && c.textSize(name, callScale).w > rightW) callScale--;
    const callY = bodyTop + 2;
    c.drawText(rightX, callY, name.slice(0, 12), blk, callScale);
    const callH = c.textSize(name, callScale).h;

    /* Black underline below callsign - thick statement bar. */
    {
      const ulY = callY + callH + 2;
      const ulW = Math.min(rightW - 4, c.textSize(name.slice(0, 12), callScale).w);
      for (let i = 0; i < 2; i++) c.hline(rightX, ulY + i, ulW, blk);
    }

    /* UID line: "UID 0xA4F1B2C3" in mono. */
    const uidY = callY + callH + 8;
    const uidStr = "UID 0x" + (seed >>> 0).toString(16).toUpperCase().padStart(8, "0");
    c.drawText(rightX, uidY, uidStr, blk, 1);

    /* Role pill: "OPERATOR" etc. in solid accent block with white
     * knockout text - matches the crypto badge styling. */
    {
      const role = ROLES[seed % ROLES.length];
      const roleSize = c.textSize(role, 1);
      const padX = 4;
      const padY = 3;
      const bw = roleSize.w + padX * 2;
      const bh = roleSize.h + padY * 2;
      const bx = rightX;
      const by = uidY + roleSize.h + 6;
      c.fillRect(bx, by, bw, bh, acc);
      c.drawTextWhite(bx + padX, by + padY, role, 1);
    }

    /* "MEMBER SINCE 2026" small caps line, lower right. */
    {
      const labelY = bodyBot - 8;
      const small = "MEMBER \u00B7 2026";
      c.drawText(rightX, labelY, small, blk, 1);
    }

    /* ── Footer: binary barcode + tagline ─────────────────────── */
    {
      const fy = H - footerH - 1;
      // Left & right ranger marks.
      c.drawText(margin, fy + 4, "\u25A0\u25A0\u25A1\u25A0", blk, 1);
      const tail = "\u25A0\u25A1\u25A0\u25A0";
      const tailW = c.textSize(tail, 1).w;
      c.drawText(W - margin - tailW, fy + 4, tail, blk, 1);

      // Binary barcode strip in the middle.
      const barX = margin + 28;
      const barW = W - margin * 2 - 56;
      binaryBar(c, barX, fy + 2, barW, 6, seed ^ 0xA5A5A5A5, blk);
    }

    /* ── Outer card border + corner brackets in accent ────────── */
    c.rect(0, 0, W, H, blk);
    /* Heavy corner brackets in accent give the card the "viewfinder"
     * frame look that translates so well to a phone photo. */
    const cornerLen = 8;
    // top-left
    for (let i = 0; i < 2; i++) {
      c.hline(0, i, cornerLen, acc);
      c.vline(i, 0, cornerLen, acc);
    }
    // top-right
    for (let i = 0; i < 2; i++) {
      c.hline(W - cornerLen, i, cornerLen, acc);
      c.vline(W - 1 - i, 0, cornerLen, acc);
    }
    // bottom-left
    for (let i = 0; i < 2; i++) {
      c.hline(0, H - 1 - i, cornerLen, acc);
      c.vline(i, H - cornerLen, cornerLen, acc);
    }
    // bottom-right
    for (let i = 0; i < 2; i++) {
      c.hline(W - cornerLen, H - 1 - i, cornerLen, acc);
      c.vline(W - 1 - i, H - cornerLen, cornerLen, acc);
    }

    return c;
  },
};
