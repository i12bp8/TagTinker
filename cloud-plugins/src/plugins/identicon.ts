/*
 * Identicon plugin.
 *
 * Procedural avatar from a name string. Hash -> symmetric pixel art with
 * an accent stripe so it actually looks like a *card*, not just a square.
 *
 *  ┌──────────────────────┐
 *  │  PIETER                              │
 *  │ ████  ██  ████                       │
 *  │ ██  ██████  ██                       │
 *  │ ██████  ██████                       │
 *  │ ██  ██████  ██                       │
 *  │ ████  ██  ████                       │
 *  │                       member since   │
 *  │                       2026 · #A4F1   │
 *  └──────────────────────────────────────┘
 *
 * No external API calls - pure compute, instant render.
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export const identiconPlugin: Plugin = {
  manifest: {
    id: "identicon",
    name: "Identicon",
    description: "Symmetric pixel-art avatar from a name",
    accent_modes: 1 | 2 | 4,
    params: [
      { key: "name", label: "Name", type: "string", default: "Dolphin" },
      { key: "grid", label: "Grid", type: "enum", default: "5", options: ["5", "7", "9"] },
      { key: "style", label: "Style", type: "enum", default: "blocky",
        options: ["blocky", "rings", "diagonal"] },
    ],
  },

  async render(params, W, H, accent: AccentMode) {
    const name = (params.name ?? "Dolphin").trim() || "Dolphin";
    const grid = parseInt(params.grid ?? "5", 10);
    const style = params.style ?? "blocky";
    const seed = hash32(name);

    const planes: 1 | 2 = accent === "none" ? 1 : 2;
    const c = new Canvas(W, H, planes);
    const accentInk: Ink = planes === 2 ? 1 : 0;

    const margin = W < 200 ? 6 : 10;

    // Header
    c.drawText(margin, margin, name.toUpperCase().slice(0, 24), 0, 1);

    // Avatar block: square sized to fit on the left half.
    const blockSize = Math.min(H - margin * 2 - 24, Math.floor(W * 0.55));
    const cell = Math.floor(blockSize / grid);
    const used = cell * grid;
    const ax = margin;
    const ay = margin + 16;

    const half = Math.ceil(grid / 2);
    let r = seed;
    const next = () => {
      // xorshift32
      r ^= r << 13; r >>>= 0;
      r ^= r >>> 17;
      r ^= r << 5;  r >>>= 0;
      return r;
    };

    const cells: boolean[][] = [];
    for (let y = 0; y < grid; y++) {
      cells.push([]);
      for (let x = 0; x < half; x++) {
        let on = (next() & 0xff) > 110;
        if (style === "rings") {
          const dx = x - (half - 1) / 2;
          const dy = y - (grid - 1) / 2;
          on = on !== ((Math.round(Math.sqrt(dx * dx + dy * dy)) & 1) === 0);
        } else if (style === "diagonal") {
          on = on !== (((x + y) & 1) === 0);
        }
        cells[y].push(on);
      }
    }
    // Mirror to right half.
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const sx = x < half ? x : grid - 1 - x;
        if (cells[y][sx]) {
          c.fillRect(ax + x * cell, ay + y * cell, cell, cell, 0);
        }
      }
    }

    // Accent stripe down the side of the block (signature flair).
    c.fillRect(ax + used + 4, ay, 3, used, accentInk);

    // Right-hand info column.
    const infoX = ax + used + 14;
    let iy = ay;
    c.drawText(infoX, iy, "MEMBER SINCE", 0, 1); iy += 10;
    c.drawText(infoX, iy, "2026", accentInk, 2); iy += 18;
    const codeStr = "#" + (seed >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 4);
    c.drawText(infoX, iy, codeStr, 0, 1);

    // Border + inner bevel for finish.
    c.rect(0, 0, W, H, 0);
    c.rect(2, 2, W - 4, H - 4, 0);

    return c;
  },
};
