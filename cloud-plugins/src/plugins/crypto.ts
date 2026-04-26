/*
 * Crypto Price plugin.
 *
 * Renders the requested coin's spot price headline, 24h delta + a
 * sparkline filling the bottom band. Accent-capable tags get the arrow
 * and sparkline drawn on the accent plane.
 *
 *  ┌─────────────────────────────────────────┐
 *  │ BTC / USD                          LIVE │
 *  │                                         │
 *  │           $ 67,415.20                   │
 *  │            ▲ +2.31%   24H               │
 *  │ ╱╲                                      │
 *  │╱  ╲╱╲    ╱╲╱╲                           │
 *  │       ╲╱      ╲╱╲╱                      │
 *  └─────────────────────────────────────────┘
 *
 * Data source: CoinGecko free tier (no key required).
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";

const COIN_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  DOGE: "dogecoin", ADA: "cardano", BNB: "binancecoin", LINK: "chainlink",
};
const RANGE_DAYS: Record<string, number> = { "24H": 1, "7D": 7, "30D": 30 };
const CCY_PREFIX: Record<string, string> = { USD: "$", EUR: "EUR ", GBP: "GBP " };

function formatPrice(v: number, prefix: string): string {
  let body: string;
  if (v >= 1000) body = v.toFixed(2);
  else if (v >= 1) body = v.toFixed(2);
  else if (v >= 0.01) body = v.toFixed(4);
  else body = v.toFixed(6);
  // Thousand separators on the integer part.
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

export const cryptoPlugin: Plugin = {
  manifest: {
    id: "crypto",
    name: "Crypto Price",
    description: "Live coin price + sparkline",
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
    const accentInk: Ink = planes === 2 ? 1 : 0;

    const margin = W < 200 ? 4 : 8;

    // Header
    c.drawText(margin, margin, `${sym} / ${vs}`, 0, 1);

    // LIVE badge top-right (accent rectangle).
    {
      const badge = "LIVE";
      const { w: bw, h: bh } = c.textSize(badge, 1);
      const bx = W - margin - bw - 4;
      const by = margin - 1;
      c.rect(bx - 2, by - 1, bw + 4, bh + 2, accentInk);
      c.drawText(bx, by, badge, accentInk, 1);
    }

    // Price headline. Pick scale so it just fits.
    const priceTxt = formatPrice(price, prefix);
    let scale = W >= 280 ? 3 : W >= 180 ? 2 : 1;
    while (scale > 1 && c.textSize(priceTxt, scale).w > W - 2 * margin) scale--;
    const priceY = margin + 12 + Math.floor(H / 12);
    c.drawTextCentered(W >> 1, priceY, priceTxt, 0, scale);
    const priceH = c.textSize(priceTxt, scale).h;

    // Delta line: "▲ +X.XX% 24H"
    const delta = `${change >= 0 ? "+" : "-"}${Math.abs(change).toFixed(2)}%   ${range}`;
    const dy = priceY + priceH + Math.floor(H / 16);
    c.drawTextCentered(W >> 1, dy, delta, 0, 1);
    {
      const triW = 5;
      const dwt = c.textSize(delta, 1).w;
      const dx = (W >> 1) - (dwt >> 1) - triW - 2;
      const dyy = dy + 1;
      if (change >= 0) {
        c.line(dx, dyy + 5, dx + triW, dyy + 5, accentInk);
        c.line(dx, dyy + 5, dx + (triW >> 1), dyy, accentInk);
        c.line(dx + triW, dyy + 5, dx + (triW >> 1), dyy, accentInk);
      } else {
        c.line(dx, dyy, dx + triW, dyy, accentInk);
        c.line(dx, dyy, dx + (triW >> 1), dyy + 5, accentInk);
        c.line(dx + triW, dyy, dx + (triW >> 1), dyy + 5, accentInk);
      }
    }

    // Sparkline filling the bottom third.
    if (hist.length >= 2) {
      const sh = Math.floor(H / 3);
      const sy = H - margin - sh;
      const sx = margin;
      const sw = W - 2 * margin;
      c.hline(sx, sy + sh, sw, 0); // baseline tick on primary plane
      c.sparkline(sx, sy, sw, sh, hist, accentInk, true);
    }

    return c;
  },
};
