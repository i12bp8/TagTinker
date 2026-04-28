/*
 * GitHub Profile plugin.
 *
 * Layout, tuned for the 208x112 tag (the common case) and gracefully
 * scaling up to 296x128:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ ┌──────┐  Linus Torvalds                 │  display name
 *   │ │      │  @torvalds                      │  handle
 *   │ │AVATAR│  Creator of Linux,              │  bio (wraps under
 *   │ │      │  unrepentantly cranky...        │   avatar if it must)
 *   │ └──────┘                                 │
 *   │  ★ 178K   ◉ 234   ◆ 712 repos            │  stat row (1 line)
 *   │  ────────────────────────────────────    │  hairline rule
 *   │  J  F  M  A  M  J  J  A  S  O  N  D      │  month axis
 *   │  ░▒░▒░░▒▒░▒░░░▒▒░░▒░░▒▒░░▒░░▒▒░░▒░░▒▒░  │  contribution heatmap
 *   │  1.2K contribs · 42d streak              │  caption + streak
 *   └──────────────────────────────────────────┘
 *
 * Palette:
 *   - Black: typography, avatar frame, hottest-day cells (level 4).
 *   - Accent: star glyph, streak flame, heatmap levels 1-3.
 *   - White: paper.
 *
 * Data sources:
 *   - api.github.com/users/:login           (name, bio, avatar, counts)
 *   - api.github.com/users/:login/repos     (sum stargazers across page 1)
 *   - github-contributions-api.jogruber.de  (daily heatmap + totals)
 */

import { Canvas, Ink } from "../canvas";
import { Plugin, AccentMode } from "../plugin";
import { fetchImageGray, blitGrayDither } from "../image_util";

interface GhUser {
  login: string;
  name: string | null;
  bio: string | null;
  avatar_url: string;
  followers: number;
  public_repos: number;
}

interface GhRepoLite { stargazers_count: number; }

interface ContribCell { date: string; count: number; level: 0|1|2|3|4; }
interface ContribResp {
  total: Record<string, number>;
  contributions: ContribCell[];
}

async function fetchUser(login: string): Promise<GhUser | null> {
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { "User-Agent": "TagTinker/1.0", "Accept": "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    return await r.json() as GhUser;
  } catch { return null; }
}

async function fetchTotalStars(login: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}/repos` +
      `?per_page=100&sort=pushed`,
      { headers: { "User-Agent": "TagTinker/1.0", "Accept": "application/vnd.github+json" } });
    if (!r.ok) return null;
    const repos: GhRepoLite[] = await r.json();
    let total = 0;
    for (const r of repos) total += r.stargazers_count | 0;
    return total;
  } catch { return null; }
}

async function fetchContributions(login: string): Promise<ContribResp | null> {
  try {
    const r = await fetch(
      `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(login)}?y=last`,
      { headers: { "User-Agent": "TagTinker/1.0" } });
    if (!r.ok) return null;
    return await r.json() as ContribResp;
  } catch { return null; }
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + "K";
  return String(n);
}

function ascii(s: string): string {
  /* Smart-typography → ASCII so apostrophes / em-dashes survive. */
  return s
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E]/g, "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return s.slice(0, max - 3) + "...";
}

/** Greedy word-wrap into at most `maxLines` lines of `maxChars`. The
 *  last line gets an ellipsis if there's still content left over. */
function wrapText(s: string, maxChars: number, maxLines: number): string[] {
  if (maxChars <= 0 || maxLines <= 0) return [];
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length && lines.length < maxLines; i++) {
    const w = words[i];
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= maxChars) {
      cur = cand;
    } else {
      if (cur) lines.push(cur);
      if (lines.length >= maxLines) { cur = ""; break; }
      cur = w.length <= maxChars ? w : w.slice(0, maxChars);
    }
  }
  if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; }
  if ((i < words.length || cur) && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length <= maxChars - 3
      ? last + "..."
      : last.slice(0, maxChars - 3) + "...";
  }
  return lines;
}

/** Trailing streak in days. If today has 0 contributions we still
 *  count whatever streak ended yesterday (mirrors github.com's rule:
 *  a streak isn't broken until the day is fully over). */
function currentStreak(contribs: ContribCell[]): number {
  let i = contribs.length - 1;
  if (i >= 0 && contribs[i].count === 0) i--;
  let s = 0;
  while (i >= 0 && contribs[i].count > 0) { s++; i--; }
  return s;
}

/** Compute the column index at which each calendar month FIRST appears
 *  in the heatmap (column = floor(dayIndex / 7)). Returns 12 entries
 *  (Jan..Dec) with the leftmost column where that month is visible, or
 *  -1 if the month isn't in the visible window. */
function monthColumns(contribs: ContribCell[], cols: number, rows: number): number[] {
  const out = new Array<number>(12).fill(-1);
  const padN = Math.max(0, contribs.length - cols * rows);
  for (let i = padN; i < contribs.length; i++) {
    const d = new Date(contribs[i].date + "T00:00:00Z");
    const m = d.getUTCMonth();
    const col = Math.floor((i - padN) / rows);
    if (out[m] === -1) out[m] = col;
  }
  return out;
}

const MONTH_INITIAL = ["J","F","M","A","M","J","J","A","S","O","N","D"];

export const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    name: "GitHub Profile",
    description: "Avatar, bio, stats and contribution heatmap card",
    accent_modes: 1 | 2 | 4,
    params: [
      { key: "username", label: "Username", type: "string", default: "torvalds" },
    ],
  },

  async render(params, W, H, accent: AccentMode) {
    const login = ((params.username ?? "torvalds").trim() || "torvalds");

    const planes: 1 | 2 = accent === "none" ? 1 : 2;
    const c = new Canvas(W, H, planes);
    const acc: Ink = planes === 2 ? 1 : 0;
    const blk: Ink = 0;

    const [user, stars, contrib] = await Promise.all([
      fetchUser(login),
      fetchTotalStars(login),
      fetchContributions(login),
    ]);

    if (!user) {
      const t1 = "USER NOT FOUND";
      const t2 = "@" + login;
      const s1 = c.textSize(t1, 2), s2 = c.textSize(t2, 1);
      c.drawText((W - s1.w) >> 1, (H >> 1) - s1.h, t1, blk, 2);
      c.drawText((W - s2.w) >> 1, (H >> 1) + 2,    t2, blk, 1);
      c.rect(0, 0, W, H, blk);
      return c;
    }

    /* ── Geometry ───────────────────────────────────────────────
     * Tuned around 208x112; everything is computed from W/H so the
     * 296x128 tag (and any future panel) gets a nicer, roomier
     * version of the same layout for free. */
    const isWide  = W >= 256;
    const margin  = isWide ? 5 : 3;
    const charW   = 6;            // FONT_5x7_W + gap
    const lineH   = 9;            // FONT_5x7_H + gap

    const avatarS = isWide ? 60 : 50;
    const avX = margin;
    const avY = margin;

    /* ── Avatar ─────────────────────────────────────────────────
     * 1-px frame around a Floyd-Steinberg-dithered face. Fetch at
     * 2× to give the dither real detail to chew on. The ?s= query
     * param is what GitHub uses for size hints; avatar_url already
     * has a `?v=4` so we append with `&`. */
    c.rect(avX, avY, avatarS, avatarS, blk);
    const avatarUrl = user.avatar_url.includes("?")
      ? `${user.avatar_url}&s=${avatarS * 2}`
      : `${user.avatar_url}?s=${avatarS * 2}`;
    const avatar = await fetchImageGray(avatarUrl);
    if (avatar) {
      blitGrayDither(c, avX + 1, avY + 1, avatarS - 2, avatarS - 2, avatar, blk);
    } else {
      const ini = (user.login.charAt(0) || "?").toUpperCase();
      const sz = c.textSize(ini, 5);
      c.drawText(avX + ((avatarS - sz.w) >> 1),
                 avY + ((avatarS - sz.h) >> 1),
                 ini, blk, 5);
    }

    /* ── Right column: name / handle / bio ──────────────────────
     * The bio is allowed to wrap below the avatar baseline if it
     * needs the room - the stat row sits BELOW the avatar so they
     * don't compete for vertical space (the old layout did, and
     * the bio almost always lost). */
    const tX = avX + avatarS + (isWide ? 8 : 5);
    const tW = W - tX - margin;
    const maxChars = Math.max(1, Math.floor(tW / charW));

    /* Vertical budget for the bottom block (stat row + heatmap +
     * caption). We reserve this up-front so the bio knows where to
     * stop wrapping. */
    const cols = 53, rows = 7;
    const heatCell = isWide ? 3 : 2;
    const heatGap  = (isWide && cell_fits(cols, heatCell, 1, W - margin * 2)) ? 1 : 0;
    const heatH    = rows * heatCell + (rows - 1) * heatGap;
    const monthH  = lineH;        // single row of single-letter labels
    const statH   = lineH;        // ★ N   ◉ N   ◆ N
    const capH    = lineH;        // bottom caption (contribs · streak)
    const bottomBlockH = statH + 2 + monthH + heatH + 2 + capH + 1;
    const bottomTop    = H - bottomBlockH - 2;

    let ty = avY;

    /* Display name. Scale 2 if the column is wide enough AND the
     * name is short enough; otherwise scale 1. */
    const nameRaw = user.name && user.name.trim()
      ? ascii(user.name).trim()
      : user.login;
    const wantBig = !isWide ? false : c.textSize(nameRaw, 2).w <= tW;
    const nameScale = wantBig ? 2 : 1;
    const nameMax = nameScale === 2
      ? Math.max(1, Math.floor(tW / (charW * 2)))
      : maxChars;
    c.drawText(tX, ty, truncate(nameRaw, nameMax), blk, nameScale);
    ty += 7 * nameScale + 2;

    /* Handle line. */
    c.drawText(tX, ty, truncate("@" + ascii(user.login), maxChars), blk, 1);
    ty += lineH;

    /* Bio - allowed to flow under the avatar (down to bottomTop). */
    if (user.bio) {
      const bioBudget = bottomTop - ty;
      const maxLines  = Math.max(0, Math.floor(bioBudget / lineH));
      if (maxLines > 0) {
        for (const line of wrapText(ascii(user.bio).trim(), maxChars, maxLines)) {
          c.drawText(tX, ty, line, blk, 1);
          ty += lineH;
        }
      }
    }

    /* ── Stat row ───────────────────────────────────────────────
     * One horizontal line of icon+number triplets, full-width below
     * the avatar. Star glyph in accent for a deliberate splash. */
    const statY = bottomTop;
    {
      const items: Array<{ glyph: string; value: string; accentGlyph: boolean }> = [
        { glyph: "\u2605", value: compact(stars ?? 0),       accentGlyph: true  }, // ★
        { glyph: "\u25C9", value: compact(user.followers),   accentGlyph: false }, // ◉
        { glyph: "\u25C6", value: compact(user.public_repos), accentGlyph: false }, // ◆
      ];
      // Measure total width with " " between glyph & value, "   " between items.
      const sepW = c.textSize("   ", 1).w;
      let totalW = 0;
      const partW: number[] = [];
      for (const it of items) {
        const w = c.textSize(it.glyph + " " + it.value, 1).w;
        partW.push(w);
        totalW += w;
      }
      totalW += sepW * (items.length - 1);
      let sx = margin + Math.max(0, ((W - margin * 2) - totalW) >> 1);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        c.drawText(sx, statY, it.glyph, it.accentGlyph ? acc : blk, 1);
        const gW = c.textSize(it.glyph + " ", 1).w;
        c.drawText(sx + gW, statY, it.value, blk, 1);
        sx += partW[i] + sepW;
      }
    }

    /* ── Heatmap geometry ───────────────────────────────────────
     * Centred horizontally inside the page margins. */
    const gw = cols * heatCell + (cols - 1) * heatGap;
    const gh = rows * heatCell + (rows - 1) * heatGap;
    const gx = (W - gw) >> 1;
    const monthY = statY + statH + 2;
    const gy     = monthY + monthH;

    /* ── Month axis ─────────────────────────────────────────────
     * Single-letter initials placed at the left edge of each
     * month's first visible column. Letters are kept at scale 1
     * (5px wide) so even adjacent months don't collide unless the
     * month is shorter than 5 columns (rare; only happens at the
     * very start of the rolling window). */
    if (contrib) {
      const mc = monthColumns(contrib.contributions, cols, rows);
      let lastX = -999;
      for (let m = 0; m < 12; m++) {
        const col = mc[m];
        if (col < 0) continue;
        const lx = gx + col * (heatCell + heatGap);
        if (lx - lastX < 6) continue; // no overlap with prev label
        c.drawText(lx, monthY, MONTH_INITIAL[m], blk, 1);
        lastX = lx;
      }
    }

    /* ── Heatmap cells ──────────────────────────────────────────
     * Level 0 = paper (skip). Level 4 = solid black. Levels 1-3 in
     * accent ink, getting denser with level so even on a mono tag
     * you can still read the gradient (level 1 = centre dot,
     * level 2 = inset square, level 3 = full cell). */
    if (contrib) {
      const data = contrib.contributions;
      const padN = Math.max(0, data.length - cols * rows);
      for (let i = padN; i < data.length; i++) {
        const off = i - padN;
        const col = Math.floor(off / rows);
        const row = off % rows;
        const cx = gx + col * (heatCell + heatGap);
        const cy = gy + row * (heatCell + heatGap);
        const lvl = data[i].level;
        if (lvl === 0) continue;
        if (lvl >= 4) {
          c.fillRect(cx, cy, heatCell, heatCell, blk);
        } else if (lvl >= 3 || heatCell <= 2) {
          c.fillRect(cx, cy, heatCell, heatCell, acc);
        } else if (lvl === 2) {
          c.fillRect(cx + 1, cy + 1, heatCell - 2, heatCell - 2, acc);
        } else {
          if (heatCell >= 4) c.fillRect(cx + 1, cy + 1, heatCell - 2, heatCell - 2, acc);
          else               c.setPixel(cx + (heatCell >> 1), cy + (heatCell >> 1), acc);
        }
      }
    } else {
      const t = "GRAPH OFFLINE";
      const sz = c.textSize(t, 1);
      c.drawText((W - sz.w) >> 1, gy + ((gh - sz.h) >> 1), t, blk, 1);
    }

    /* ── Caption + streak ───────────────────────────────────────
     * "1.2K contribs • 42d streak" - bullet glyph (U+2022) is in
     * the extra-glyph table so it actually renders (the previous
     * version used U+00B7 which is not, leaving a phantom gap). */
    {
      const total = contrib
        ? (contrib.total["lastYear"]
           ?? Object.values(contrib.total).reduce((a, b) => a + b, 0))
        : 0;
      const streak = contrib ? currentStreak(contrib.contributions) : 0;
      const left  = contrib ? `${compact(total)} contribs` : `last 12 mo offline`;
      const right = contrib && streak > 0 ? `${streak}d streak` : "";
      const sep   = " \u2022 ";
      const cap   = right ? left + sep + right : left;
      const cs = c.textSize(cap, 1);
      const cyText = gy + gh + 2;
      const cxText = (W - cs.w) >> 1;
      c.drawText(cxText, cyText, cap, blk, 1);
      /* Highlight the streak number in accent - tiny, deliberate
       * splash that mirrors the star glyph above. */
      if (right) {
        const leftW = c.textSize(left + sep, 1).w;
        const numW  = c.textSize(`${streak}`, 1).w;
        c.drawText(cxText + leftW, cyText, `${streak}`, acc, 1);
        c.drawText(cxText + leftW + numW, cyText, "d streak", blk, 1);
      }
    }

    /* Outer 1-px frame. */
    c.rect(0, 0, W, H, blk);
    return c;
  },
};

/** Helper used while picking heatmap geometry: does N cells of
 *  size `cell` plus (N-1) gaps fit in `avail` pixels? */
function cell_fits(n: number, cell: number, gap: number, avail: number): boolean {
  return n * cell + (n - 1) * gap <= avail;
}
