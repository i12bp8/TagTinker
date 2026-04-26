/*
 * TagTinker WiFi Plugins - Cloudflare Worker entry.
 *
 * Endpoints:
 *
 *   GET /plugins
 *     -> JSON: { plugins: [ {id,name,description,accent_modes,params}, ... ] }
 *
 *   GET /render/:id?w=<int>&h=<int>&accent=<none|red|yellow>&<param>=<val>...
 *     -> application/octet-stream
 *        Format (little-endian):
 *          uint16 width, uint16 height, uint8 planes, uint8 reserved,
 *          uint16 row_stride,
 *          plane0 bytes (rowStride * height),
 *          plane1 bytes (if planes == 2).
 *
 * The ESP32 simply forwards the byte stream to the Flipper as a
 * RESULT_BEGIN + N x RESULT_CHUNK + RESULT_END frame sequence.
 */

import { Plugin, AccentMode } from "./plugin";
import { cryptoPlugin } from "./plugins/crypto";
import { weatherPlugin } from "./plugins/weather";
import { identiconPlugin } from "./plugins/identicon";

const PLUGINS: Plugin[] = [cryptoPlugin, weatherPlugin, identiconPlugin];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function parseAccent(s: string | null): AccentMode {
  return s === "red" || s === "yellow" ? s : "none";
}

async function handleRender(id: string, url: URL): Promise<Response> {
  const plugin = PLUGINS.find((p) => p.manifest.id === id);
  if (!plugin) return errorResponse(`unknown plugin '${id}'`, 404);

  const w = parseInt(url.searchParams.get("w") ?? "296", 10);
  const h = parseInt(url.searchParams.get("h") ?? "128", 10);
  if (!(w > 0 && w <= 1024 && h > 0 && h <= 1024)) {
    return errorResponse("bad w/h", 400);
  }
  const accent = parseAccent(url.searchParams.get("accent"));

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k !== "w" && k !== "h" && k !== "accent") params[k] = v;
  }

  try {
    const c = await plugin.render(params, w, h, accent);
    const bytes = c.toBytes();
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  } catch (e: any) {
    return errorResponse(`render failed: ${e?.message ?? e}`, 500);
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "tagtinker-cloud-plugins",
        plugins: PLUGINS.length,
      });
    }

    if (url.pathname === "/plugins") {
      return jsonResponse({ plugins: PLUGINS.map((p) => p.manifest) });
    }

    const m = url.pathname.match(/^\/render\/([a-zA-Z0-9_-]+)$/);
    if (m) return handleRender(m[1], url);

    return errorResponse("not found", 404);
  },
};
