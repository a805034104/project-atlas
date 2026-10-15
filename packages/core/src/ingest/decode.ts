import iconv from "iconv-lite";

/**
 * Bytes → text. Chinese enterprise Java code is frequently GBK-encoded, so a
 * failed strict UTF-8 decode falls back to GBK instead of producing mojibake.
 *
 *   BOM? ─yes─▶ decode as BOM says
 *    │no
 *   strict UTF-8 ok? ─yes─▶ utf-8
 *    │no
 *   GBK (gb18030 superset)
 */

export interface Decoded {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "gb18030";
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

export function decodeSource(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  try {
    return { text: utf8Strict.decode(bytes), encoding: "utf-8" };
  } catch {
    // Not valid UTF-8: the only other encoding seen in practice for this audience.
    return { text: iconv.decode(Buffer.from(bytes), "gb18030"), encoding: "gb18030" };
  }
}

/** Heuristic binary sniff: NUL bytes in the first 8 KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}
