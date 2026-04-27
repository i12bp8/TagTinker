/* Minimal type shims for the CommonJS image libraries we use in the
 * worker bundle. These libs have no official @types packages, and we
 * only touch a tiny slice of each surface, so a hand-written shim is
 * cheaper than wrestling with `allowJs`. */

declare module "jpeg-js" {
  interface DecodedJpeg {
    width: number;
    height: number;
    data: Uint8Array | Buffer;
  }
  interface JpegJs {
    decode(buf: ArrayBuffer | Uint8Array,
           opts?: { useTArray?: boolean; maxMemoryUsageInMB?: number; formatAsRGBA?: boolean })
      : DecodedJpeg;
    encode(rawImageData: { data: Uint8Array; width: number; height: number },
           quality?: number): { data: Uint8Array; width: number; height: number };
  }
  const jpegJs: JpegJs;
  export default jpegJs;
}

declare module "upng-js" {
  interface DecodedPng {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    data: Uint8Array;
    tabs: Record<string, unknown>;
    frames: unknown[];
  }
  export function decode(buf: ArrayBuffer | Uint8Array): DecodedPng;
  export function toRGBA8(out: DecodedPng): ArrayBuffer[];
}
