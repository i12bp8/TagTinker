/*
 * Plugin shape. A plugin exports:
 *   - manifest: served verbatim from /plugins
 *   - render(params, w, h, accent): builds a Canvas and returns it
 *
 * Adding a new plugin = drop a new file in src/plugins/, import + push it
 * to PLUGINS in src/index.ts. Cloudflare deploys, Flipper picks it up on
 * the next "Refresh Plugins".
 */

import { Canvas } from "./canvas";

export type ParamType = "string" | "int" | "enum" | "bool";

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  default: string;
  options?: string[];
  min?: number;
  max?: number;
}

export const ACCENT_NONE = 0;
export const ACCENT_RED = 1;
export const ACCENT_YELLOW = 2;

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  /** Bitmask: 1 = mono OK, 2 = red, 4 = yellow */
  accent_modes: number;
  params: ParamSpec[];
}

export type AccentMode = "none" | "red" | "yellow";

export interface Plugin {
  manifest: PluginManifest;
  render(params: Record<string, string>, w: number, h: number, accent: AccentMode): Promise<Canvas>;
}
