/*
 * Crypto Price plugin - editorial / share-worthy layout.
 *
 * Mono tags get a clean black & white card; tri-colour tags get a
 * dramatic accent treatment on the sparkline fill, the delta badge,
 * the corner brackets and a thin underline accent on the price - the
 * kind of thing that looks intentional in a photo of an e-paper tag.
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";

const COIN_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  DOGE: "dogecoin", ADA: "cardano", BNB: "binancecoin", LINK: "chainlink",
};
const RANGE_DAYS: Record<string, number> = { "24H": 1, "7D": 7, "30D": 30 };
/* The Canvas now ships €/£/¥ glyphs in FONT_EXTRA so we can render them
 * literally as the price prefix - same width budget as "$". */
const CCY_PREFIX: Record<string, string> = { USD: "$", EUR: "\u20AC", GBP: "\u00A3" };

function formatPrice(v: number, prefix: string): string {
  let body: string;
  if (v >= 1) body = v.toFixed(2);
  else if (v >= 0.01) body = v.toFixed(4);
  else body = v.toFixed(6);
  const [intPart, frac] = body.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return prefix + withCommas + (frac ? "." + frac : "");
}

async function fetchPrice(id: string, vs: string): Promise<{ price: number; change: number }> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}&include_24hr_change=true`;
  const r = await fetch(url, { headers: { "User-Agent": "TagTinker/1.0" } });
  if (!r.ok) throw new Error(`price ${r.status}`);
  const j: any = await r.json();
  const c = j[id];
  if (!c) throw new Error("coin not in response");
  const k = vs.toLowerCase();
  return { price: c[k] ?? 0, change: c[`${k}_24h_change`] ?? 0 };
}

async function fetchHistory(id: string, vs: string, days: number, samples: number): Promise<number[]> {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs.toLowerCase()}&days=${days}`;
  const r = await fetch(url, { headers: { "User-Agent": "TagTinker/1.0" } });
  if (!r.ok) throw new Error(`history ${r.status}`);
  const j: any = await r.json();
  const arr: [number, number][] = j.prices ?? [];
  if (arr.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const idx = Math.floor((i * (arr.length - 1)) / Math.max(1, samples - 1));
    out.push(arr[idx][1]);
  }
  return out;
}

/* ─── Drawing helpers ─────────────────────────────────────────────── */

const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

function fillStippled(c: Canvas, x: number, y: number, w: number, h: number,
                      density: number, ink: Ink) {
  const t = Math.max(0, Math.min(15, Math.round(density * 16) - 1));
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      if (BAYER4[yy & 3][xx & 3] <= t) c.setPixel(x + xx, y + yy, ink);
    }
  }
}

function fillUnderCurve(c: Canvas, xs: number[], ys: number[],
                        baselineY: number, ink: Ink) {
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i],     y0 = ys[i];
    const x1 = xs[i + 1], y1 = ys[i + 1];
    const dx = x1 - x0;
    if (dx <= 0) continue;
    for (let x = x0; x <= x1; x++) {
      const t = (x - x0) / dx;
      const y = Math.round(y0 + (y1 - y0) * t);
      const top = Math.min(y, baselineY);
      const bot = Math.max(y, baselineY);
      for (let yy = top; yy <= bot; yy++) {
        if (BAYER4[yy & 3][x & 3] < 8) c.setPixel(x, yy, ink);
      }
    }
  }
}

function cornerBrackets(c: Canvas, x: number, y: number, w: number, h: number,
                        len: number, ink: Ink) {
  c.hline(x, y, len, ink);                    c.vline(x, y, len, ink);
  c.hline(x + w - len, y, len, ink);          c.vline(x + w - 1, y, len, ink);
  c.hline(x, y + h - 1, len, ink);            c.vline(x, y + h - len, len, ink);
  c.hline(x + w - len, y + h - 1, len, ink);  c.vline(x + w - 1, y + h - len, len, ink);
}

/* ─── Plugin ─────────────────────────────────────────────────────── */

export const cryptoPlugin: Plugin = {
  manifest: {
    id: "crypto",
    name: "Crypto Price",
    description: "Editorial price card with sparkline",
    accent_modes: 1 | 2 | 4,
    params: [
      { key: "symbol", label: "Coin", type: "enum", default: "BTC",
        options: Object.keys(COIN_MAP) },
      { key: "currency", label: "Currency", type: "enum", default: "USD",
        options: Object.keys(CCY_PREFIX) },
      { key: "range", label: "Range", type: "enum", default: "24H",
        options: Object.keys(RANGE_DAYS) },
    ],
  },

  async render(params, W, H, accent: AccentMode) {
    const sym = (params.symbol ?? "BTC").toUpperCase();
    const vs = (params.currency ?? "USD").toUpperCase();
    const range = (params.range ?? "24H").toUpperCase();
    const id = COIN_MAP[sym] ?? "bitcoin";
    const days = RANGE_DAYS[range] ?? 1;
    const prefix = CCY_PREFIX[vs] ?? "$";

    const { price, change } = await fetchPrice(id, vs);
    const samples = Math.min(W, 256);
    const hist = await fetchHistory(id, vs, days, samples);

    const planes: 1 | 2 = accent === "none" ? 1 : 2;
    const c = new Canvas(W, H, planes);
    /* On mono tags accent ink == primary - visually a bit boring but the
     * structural design (corner brackets, dithered fills, big type) still
     * carries the look. On tri-colour tags the accent plane gives the
     * splash of red/yellow that makes the card pop. */
    const acc: Ink = planes === 2 ? 1 : 0;
    const blk: Ink = 0;

    const margin = W < 200 ? 4 : 8;

    /* ── Corner viewfinder brackets in accent ─────────────────────── */
    const bracketLen = Math.max(8, Math.min(16, Math.floor(W / 24)));
    cornerBrackets(c, 1, 1, W - 2, H - 2, bracketLen, acc);

    /* ── Header row: symbol/ccy on the left, delta badge right ────── */
    const headerY = margin + 2;
    const symLabel = `${sym}/${vs}`;
    /* Header: "BTC/USD" in scale 2 - the focal element of the top bar. */
    c.drawText(margin + 4, headerY, symLabel, blk, 2);
    const symH = c.textSize(symLabel, 2).h;

    /* Range chip on header row right of the symbol. */
    {
      const chip = range;
      const cs = c.textSize(chip, 1);
      const cx = margin + 4 + c.textSize(symLabel, 2).w + 6;
      const cy = headerY + Math.max(0, (symH - cs.h) >> 1);
      /* Box outline in primary, the chip text reads black on white. */
      c.rect(cx - 2, cy - 1, cs.w + 4, cs.h + 2, blk);
      c.drawText(cx, cy, chip, blk, 1);
    }

    /* Delta badge top-right: solid accent block with a chunky black
     * triangle and the % delta in black, all rendered on plane 0 over
     * the accent plane fill. Reads cleanly as "black ink on red/yellow
     * paint" on tri-colour tags - and as plain black on mono tags. */
    {
      const arrow = change >= 0 ? "\u25B2" : "\u25BC";   // ▲ / ▼ glyph
      const pct   = `${change >= 0 ? "+" : "-"}${Math.abs(change).toFixed(2)}%`;
      const arrowSize = c.textSize(arrow, 1);
      const pctSize   = c.textSize(pct, 1);
      const padX = 5;
      const gap  = 3;
      const bw = padX + arrowSize.w + gap + pctSize.w + padX;
      const bh = Math.max(arrowSize.h, pctSize.h) + 6;
      const bx = W - margin - bw - 2;
      const by = headerY + Math.max(0, (symH - bh) >> 1);

      /* Solid accent fill behind everything, then knock out the arrow
       * and the % text in WHITE (paper showing through both planes).
       * White-on-red has way higher contrast than black-on-red on the
       * actual e-paper - the black ink and the red ink absorb similar
       * amounts of light, so black text on red reads as a muddy
       * monochrome blob. White (paper) on red is the print-magazine
       * standard for a reason. */
      c.fillRect(bx, by, bw, bh, acc);
      const ax = bx + padX;
      const ay = by + ((bh - arrowSize.h) >> 1);
      c.drawTextWhite(ax, ay, arrow, 1);
      const px = ax + arrowSize.w + gap;
      const py = by + ((bh - pctSize.h) >> 1);
      c.drawTextWhite(px, py, pct, 1);
    }

    /* ── Big price ─────────────────────────────────────────────── */
    const priceTxt = formatPrice(price, prefix);
    /* Pick the largest scale that fits. */
    let pscale = W >= 280 ? 4 : W >= 200 ? 3 : 2;
    while (pscale > 1 && c.textSize(priceTxt, pscale).w > W - 2 * margin - 6) pscale--;
    const pSize = c.textSize(priceTxt, pscale);
    const priceY = headerY + symH + Math.max(6, Math.floor(H / 14));
    const priceX = (W - pSize.w) >> 1;
    c.drawText(priceX, priceY, priceTxt, blk, pscale);

    /* ── Sparkline + accent fill ─────────────────────────────── */
    if (hist.length >= 2) {
      /* No underline now - the price headline breathes and the sparkline
       * gets the full lower half of the card. */
      const sparkTop = priceY + pSize.h + Math.max(6, Math.floor(H / 14));
      const sparkBot = H - margin - 4;
      const sparkH = sparkBot - sparkTop;
      const sparkX = margin + 4;
      const sparkW = W - 2 * (margin + 4);

      if (sparkH > 8) {
        let lo = Infinity, hi = -Infinity;
        for (const v of hist) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi === lo) hi = lo + 1;
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < hist.length; i++) {
          const px = sparkX + Math.round((i * (sparkW - 1)) / (hist.length - 1));
          const py = sparkTop + sparkH - 1 -
                     Math.round(((hist[i] - lo) * (sparkH - 1)) / (hi - lo));
          xs.push(px); ys.push(py);
        }

        /* Accent stippled fill below the curve - the visual hero. */
        fillUnderCurve(c, xs, ys, sparkBot - 1, acc);

        /* Curve itself in BLACK, drawn thick so it pops over the
         * stippled fill - this is the "real" line the eye reads. */
        for (let i = 1; i < xs.length; i++) {
          c.line(xs[i - 1], ys[i - 1], xs[i], ys[i], blk);
          /* Add a 1-pixel "halo" above for extra weight. */
          if (ys[i] > sparkTop)
            c.line(xs[i - 1], ys[i - 1] - 1, xs[i], ys[i] - 1, blk);
        }

        /* Baseline rule. */
        c.hline(sparkX, sparkBot, sparkW, blk);

        /* Latest value pin: small accent dot + black ring. */
        const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
        c.fillRect(lx - 2, ly - 2, 5, 5, acc);
        c.rect(lx - 2, ly - 2, 5, 5, blk);
      }
    }

    return c;
  },
};
