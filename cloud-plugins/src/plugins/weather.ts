/*
 * Weather plugin.
 *
 * Renders a clean, minimalist weather card:
 *
 *  ┌────────────────────────────────────────┐
 *  │  AMSTERDAM                          NL │
 *  │                                        │
 *  │   ☀     12°C                           │
 *  │ partly cloudy                          │
 *  │                                        │
 *  │  Mon 14° / 8°    Tue 11° / 6°          │
 *  └────────────────────────────────────────┘
 *
 * Procedural icons (sun, cloud, rain, snow, storm) drawn with the canvas
 * primitives - they scale cleanly to any tag size and look distinctive
 * even at the smallest 152x152 panels.
 *
 * Data source: wttr.in (free, no key, returns JSON when ?format=j1).
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";

type Sky = "sun" | "cloud" | "rain" | "snow" | "storm" | "fog";

function classify(code: number): Sky {
  // wttr WWO weatherCode mapping to a small icon vocabulary.
  if ([113].includes(code)) return "sun";
  if ([116, 119, 122].includes(code)) return "cloud";
  if ([143, 248, 260].includes(code)) return "fog";
  if ([200, 386, 389, 392, 395].includes(code)) return "storm";
  if ([179, 227, 230, 320, 323, 326, 329, 332, 335, 338, 350, 368, 371, 374, 377].includes(code))
    return "snow";
  return "rain";
}

function drawIcon(c: Canvas, sky: Sky, cx: number, cy: number, r: number, accent: Ink): void {
  switch (sky) {
    case "sun": {
      // Filled disc + 8 rays in accent ink.
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++)
          if (x * x + y * y <= (r - 1) * (r - 1)) c.setPixel(cx + x, cy + y, accent);
      const rr = r + 2, R = r + r;
      c.line(cx - R, cy, cx - rr, cy, accent);
      c.line(cx + rr, cy, cx + R, cy, accent);
      c.line(cx, cy - R, cx, cy - rr, accent);
      c.line(cx, cy + rr, cx, cy + R, accent);
      c.line(cx - R, cy - R, cx - rr, cy - rr, accent);
      c.line(cx + rr, cy - rr, cx + R, cy - R, accent);
      c.line(cx - R, cy + R, cx - rr, cy + rr, accent);
      c.line(cx + rr, cy + rr, cx + R, cy + R, accent);
      break;
    }
    case "cloud": {
      // Three overlapping discs forming a cloud silhouette.
      const blob = (ox: number, oy: number, br: number) => {
        for (let y = -br; y <= br; y++)
          for (let x = -br; x <= br; x++)
            if (x * x + y * y <= br * br) c.setPixel(cx + ox + x, cy + oy + y, 0);
      };
      blob(-r, 2, Math.floor(r * 0.6));
      blob(0, -2, Math.floor(r * 0.7));
      blob(r - 2, 2, Math.floor(r * 0.6));
      c.hline(cx - r, cy + Math.floor(r * 0.6), 2 * r, 0);
      break;
    }
    case "rain":
      drawIcon(c, "cloud", cx, cy, r, 0);
      for (let i = -r; i <= r; i += 4) {
        c.line(cx + i, cy + r + 2, cx + i - 2, cy + r + 6, accent);
      }
      break;
    case "snow":
      drawIcon(c, "cloud", cx, cy, r, 0);
      for (let i = -r; i <= r; i += 5) {
        const yy = cy + r + 4;
        c.setPixel(cx + i, yy, accent);
        c.setPixel(cx + i - 1, yy + 1, accent);
        c.setPixel(cx + i + 1, yy + 1, accent);
        c.setPixel(cx + i, yy + 2, accent);
      }
      break;
    case "storm":
      drawIcon(c, "cloud", cx, cy, r, 0);
      // Lightning bolt
      const bx = cx, by = cy + r;
      c.line(bx, by, bx + 3, by + 4, accent);
      c.line(bx + 3, by + 4, bx - 1, by + 5, accent);
      c.line(bx - 1, by + 5, bx + 3, by + 9, accent);
      break;
    case "fog":
      for (let i = 0; i < 4; i++) {
        c.hline(cx - r + (i % 2) * 2, cy - r + i * 4, 2 * r - (i % 2) * 4, 0);
      }
      break;
  }
}

async function fetchWeather(loc: string): Promise<any> {
  const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
  const r = await fetch(url, { headers: { "User-Agent": "TagTinker/1.0" } });
  if (!r.ok) throw new Error(`wttr ${r.status}`);
  return await r.json();
}

export const weatherPlugin: Plugin = {
  manifest: {
    id: "weather",
    name: "Weather",
    description: "Live weather card with forecast",
    accent_modes: 1 | 2 | 4,
    params: [
      { key: "location", label: "Location", type: "string", default: "Paris" },
      { key: "units", label: "Units", type: "enum", default: "C", options: ["C", "F"] },
    ],
  },

  async render(params, W, H, accent: AccentMode) {
    const loc = (params.location ?? "Paris").trim() || "Paris";
    /* Defensive: only accept C or F. The Flipper used to (briefly) leak
     * stale param values across plugins, which once produced "20°USD". */
    const rawUnits = (params.units ?? "C").toUpperCase();
    const units = rawUnits === "F" ? "F" : "C";
    const data = await fetchWeather(loc);

    const cur = data.current_condition?.[0] ?? {};
    const code = parseInt(cur.weatherCode ?? "113", 10);
    const sky = classify(code);
    const tempC = parseFloat(cur.temp_C ?? "0");
    const tempF = parseFloat(cur.temp_F ?? "32");
    const desc = (cur.weatherDesc?.[0]?.value ?? "").toLowerCase();
    const area = data.nearest_area?.[0];
    const city = (area?.areaName?.[0]?.value ?? loc).toUpperCase();
    const country = area?.country?.[0]?.value ?? "";

    const planes: 1 | 2 = accent === "none" ? 1 : 2;
    const c = new Canvas(W, H, planes);
    const accentInk: Ink = planes === 2 ? 1 : 0;

    const margin = W < 200 ? 4 : 8;

    // Header: city + country on right.
    c.drawText(margin, margin, city, 0, 1);
    c.drawTextRight(W - margin, margin, country.toUpperCase(), 0, 1);
    c.hline(margin, margin + 9, W - 2 * margin, 0);

    // Big icon + temperature
    const iconR = Math.min(20, Math.floor(H / 6));
    const ix = margin + iconR + 4;
    const iy = margin + 18 + iconR;
    drawIcon(c, sky, ix, iy, iconR, accentInk);

    const t = `${units === "F" ? Math.round(tempF) : Math.round(tempC)}\xB0${units}`;
    let scale = W >= 260 ? 3 : 2;
    while (scale > 1 && c.textSize(t, scale).w > W - ix - iconR - margin * 2) scale--;
    c.drawText(ix + iconR + 8, iy - Math.floor(c.textSize(t, scale).h / 2), t, 0, scale);

    // Description in italics-ish (just plain, but a row under).
    c.drawText(margin, iy + iconR + 6, desc, 0, 1);

    // 2-day forecast.
    const fcs = data.weather?.slice(0, 2) ?? [];
    if (fcs.length > 0) {
      const baseY = H - margin - 9;
      const cellW = Math.floor((W - 2 * margin) / fcs.length);
      for (let i = 0; i < fcs.length; i++) {
        const f = fcs[i];
        const lo = units === "F" ? f.mintempF : f.mintempC;
        const hi = units === "F" ? f.maxtempF : f.maxtempC;
        const dn = f.date ? new Date(f.date).toLocaleDateString("en-US", { weekday: "short" }) : "";
        const txt = `${dn} ${hi}\xB0/${lo}\xB0`;
        c.drawText(margin + i * cellW, baseY, txt, 0, 1);
      }
    }

    return c;
  },
};
