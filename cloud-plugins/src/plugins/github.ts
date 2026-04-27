/*
 * GitHub Profile plugin.
 *
 * Layout (designed for 208x112, scales up to 296x128):
 *
 *   ┌────────────────────────────────────────┐
 *   │ ┌───────┐  Linus Torvalds              │  <- display name (scale 1)
 *   │ │       │  @torvalds  ★ 178K           │  <- handle + stars (scale 1, accent star)
 *   │ │AVATAR │                               │
 *   │ │       │  Creator of Linux,            │  <- bio (scale 1, word-wrapped,
 *   │ │       │  unrepentantly cranky,        │      multiple lines, can extend
 *   │ │       │  mostly benevolent dictator   │      below the avatar)
 *   │ └───────┘                               │
 *   │                                          │
 *   │ ░▒░▒░░▒▒░▒░░░▒▒░░▒░░▒▒░░▒░░▒▒░░▒░░▒▒░  │  <- contribution heatmap
 *   │ ░▒░▒░░▒▒░▒░░░▒▒░░▒░░▒▒░░▒░░▒▒░░▒░░▒▒░  │     (red dots, hottest = black)
 *   │ ░▒░▒░░▒▒░▒░░░▒▒░░▒░░▒▒░░▒░░▒▒░░▒░░▒▒░  │
 *   │           1,234 contribs / yr           │  <- caption
 *   └────────────────────────────────────────┘
 *
 * Palette (kept light + airy on purpose):
 *   - Black: typography, avatar frame, hottest-day cells (level 4).
 *   - Accent: the star glyph and most heatmap cells (levels 1-3).
 *   - White: paper / bg.
 *
 * No solid coloured banner, no boxed badges - the card reads as a
 * tiny print-magazine page rather than a UI screenshot.
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
  for (; i < words.length; i++) {
    const w = words[i];
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= maxChars) {
      cur = cand;
    } else {
      if (cur) lines.push(cur);
      cur = w.length <= maxChars ? w : w.slice(0, maxChars);
      if (lines.length >= maxLines) { i++; break; }
    }
  }
  if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; }
  /* Anything that didn't fit gets reflected as an ellipsis on the
   * last line, so the user can tell text was truncated. */
  if (i < words.length || cur) {
    if (lines.length === 0) return lines;
    const last = lines[lines.length - 1];
    if (last.length <= maxChars - 3) lines[lines.length - 1] = last + "...";
    else lines[lines.length - 1] = last.slice(0, maxChars - 3) + "...";
  }
  return lines;
}

export const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    name: "GitHub Profile",
    description: "Avatar, bio and contribution heatmap card",
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

    /* ── Geometry ─────────────────────────────────────────────
     * Tuned for 208×112; scales up to 296×128 with a bigger
     * avatar and roomier heatmap cells. */
    const isWide  = W >= 256;
    const margin  = 4;
    const charW   = 6;            // FONT_5x7_W + gap
    const lineH   = 9;            // FONT_5x7_H + gap

    /* Avatar: dominate the upper-left. Bigger here = more typography
     * room AND more pixels for the dithered face. */
    const avatarS = isWide ? 64 : 60;
    const avX = margin;
    const avY = margin;

    c.rect(avX, avY, avatarS, avatarS, blk);
    const avatar = await fetchImageGray(`${user.avatar_url}&s=${avatarS * 2}`);
    if (avatar) {
      blitGrayDither(c, avX + 1, avY + 1, avatarS - 2, avatarS - 2, avatar, blk);
    } else {
      const ini = (user.login.charAt(0) || "?").toUpperCase();
      const sz = c.textSize(ini, 5);
      c.drawText(avX + ((avatarS - sz.w) >> 1),
                 avY + ((avatarS - sz.h) >> 1),
                 ini, blk, 5);
    }

    /* ── Right column: name / handle+stars / bio ─────────────── */
    const tX = avX + avatarS + 6;
    const tW = W - tX - margin;
    const maxChars = Math.max(1, Math.floor(tW / charW));

    /* Heatmap budget computed up-front so we know where the bio is
     * allowed to flow into. */
    const cols = 53, rows = 7;
    const captionH  = lineH + 2;
    const heatCellTarget = isWide ? 4 : 3;
    const heatBudget  = rows * heatCellTarget;
    const heatBlockH  = heatBudget + captionH + 4;
    const bioMaxBot   = H - heatBlockH - 2;

    let ty = avY;

    /* Display name first, in primary ink. Falls back to login
     * (capitalised) if the user has no display name set. */
    const displayName = user.name && user.name.trim()
      ? truncate(ascii(user.name).trim(), maxChars)
      : truncate(user.login, maxChars);
    if (displayName) {
      c.drawText(tX, ty, displayName, blk, 1);
      ty += lineH;
    }

    /* Handle + stars on a single line. The ★ glyph is drawn in
     * accent for a deliberate splash of colour right next to the
     * stars number; everything else stays primary. */
    {
      const handle = "@" + ascii(user.login);
      const sNum   = `\u2605 ${compact(stars ?? 0)}`;
      const hSize  = c.textSize(handle, 1);
      const sSize  = c.textSize(sNum,   1);
      const sep    = "  ";
      const sepW   = c.textSize(sep, 1).w;
      /* If both pieces fit, draw them inline. Else drop the handle
       * (the avatar already says who this is). */
      if (hSize.w + sepW + sSize.w <= tW) {
        c.drawText(tX, ty, handle, blk, 1);
        /* Star glyph in accent, number text in primary - splits the
         * `★ 178K` string into two drawText calls so the colour break
         * is exactly at the glyph. */
        const sx = tX + hSize.w + sepW;
        c.drawText(sx,                       ty, "\u2605", acc, 1);
        c.drawText(sx + c.textSize("\u2605 ", 1).w, ty, compact(stars ?? 0), blk, 1);
      } else {
        c.drawText(tX, ty, "\u2605", acc, 1);
        c.drawText(tX + c.textSize("\u2605 ", 1).w, ty, compact(stars ?? 0), blk, 1);
      }
      ty += lineH + 2;
    }

    /* Followers / repos line(s) - drawn at the BOTTOM of the right
     * column, left-aligned to the same `tX` as name / handle / bio.
     * Reserve their vertical room first so the bio knows when to
     * stop wrapping. The single-line form is preferred; if it
     * doesn't fit the column width, fall back to two stacked lines. */
    const statSingle = `${compact(user.followers)} followers \u00B7 ${compact(user.public_repos)} repos`;
    const statLines: string[] = c.textSize(statSingle, 1).w <= tW
      ? [statSingle]
      : [`${compact(user.followers)} followers`,
         `${compact(user.public_repos)} repos`];
    const statsBlockH = statLines.length * lineH;
    /* Stats sit just above the heatmap caption / heatmap, butted up
     * against the bottom of the right column. */
    const statsTop  = bioMaxBot - statsBlockH;
    const bioBudget = statsTop - 2 - ty;       // px the bio is allowed

    /* Bio - word-wrapped into the budget left after the stats are
     * accounted for. */
    if (user.bio && bioBudget >= lineH) {
      const maxLines = Math.max(0, Math.floor(bioBudget / lineH));
      if (maxLines > 0) {
        const lines = wrapText(ascii(user.bio).trim(), maxChars, maxLines);
        for (const line of lines) {
          c.drawText(tX, ty, line, blk, 1);
          ty += lineH;
        }
      }
    }

    /* Now drop the stats in left-aligned with everything else. */
    {
      let sy = statsTop;
      for (const line of statLines) {
        c.drawText(tX, sy, line, blk, 1);
        sy += lineH;
      }
    }

    /* ── Heatmap ─────────────────────────────────────────────── */
    const heatTop = H - heatBlockH;
    const heatBot = H - captionH;
    const heatH   = heatBot - heatTop;

    let cell = Math.max(1, Math.min(
      Math.floor((W - margin * 2 + 1) / cols),
      Math.floor((heatH + 1) / rows),
    ));
    let gap = cell >= 3 ? 1 : 0;
    while (cell > 1 &&
           (cell * cols + gap * (cols - 1) > W - margin * 2 ||
            cell * rows + gap * (rows - 1) > heatH)) {
      if (gap > 0) gap--;
      else cell--;
    }
    const gw = cell * cols + gap * (cols - 1);
    const gh = cell * rows + gap * (rows - 1);
    const gx = (W - gw) >> 1;
    const gy = heatTop + ((heatH - gh) >> 1);

    if (contrib) {
      const data = contrib.contributions;
      const padN = Math.max(0, data.length - cols * rows);
      for (let i = padN; i < data.length; i++) {
        const off = i - padN;
        const col = Math.floor(off / rows);
        const row = off % rows;
        const cx = gx + col * (cell + gap);
        const cy = gy + row * (cell + gap);
        const lvl = data[i].level;
        if (lvl === 0) continue;
        /* See doc-comment at top of file for the palette story. */
        if (lvl >= 4) {
          c.fillRect(cx, cy, cell, cell, blk);
        } else if (lvl >= 3 || cell <= 2) {
          c.fillRect(cx, cy, cell, cell, acc);
        } else if (lvl === 2) {
          c.fillRect(cx + 1, cy + 1, cell - 2, cell - 2, acc);
        } else {
          if (cell >= 4) c.fillRect(cx + 1, cy + 1, cell - 2, cell - 2, acc);
          else           c.setPixel(cx + (cell >> 1), cy + (cell >> 1), acc);
        }
      }
    } else {
      const t = "GRAPH OFFLINE";
      const sz = c.textSize(t, 1);
      c.drawText((W - sz.w) >> 1, gy + ((gh - sz.h) >> 1), t, blk, 1);
    }

    /* ── Caption: tight, abbreviated so it always fits ─────────
     * "1.2K contribs / yr" is 17 chars ≈ 102 px at scale 1, fits in
     * 200 px easily. We use compact() on the total so a 50K-streak
     * pro doesn't break the layout. */
    {
      const total = contrib
        ? (contrib.total["lastYear"]
           ?? Object.values(contrib.total).reduce((a, b) => a + b, 0))
        : 0;
      const cap = contrib
        ? `${compact(total)} contribs / yr`
        : `last 12 mo \u00B7 offline`;
      const cs = c.textSize(cap, 1);
      const cx = (W - cs.w) >> 1;
      const cy = H - cs.h - 2;
      c.drawText(cx, cy, cap, blk, 1);
    }

    /* Outer 1-px frame. */
    c.rect(0, 0, W, H, blk);

    return c;
  },
};
