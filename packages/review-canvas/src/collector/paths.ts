import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { getSystemErrorMessage } from "node:util";
import { CollectError } from "./errors.ts";

/*
 * Git paths and file names are bytes, and Git allows bytes that are not valid UTF-8. Inside the collector a name is a
 * string that keeps every byte: valid UTF-8 decodes as usual, and each other byte becomes a lone surrogate from U+DC80
 * to U+DCFF, as Python's surrogateescape does. fsEncode restores the exact bytes. Such a string is for comparison and
 * file system access only; a path enters review input only after decodePath proves it valid UTF-8. Every file system
 * call takes the bytes from fsEncode, never the string, because Node would encode a lone surrogate as U+FFFD.
 */

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isContinuation = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** The code point of the valid UTF-8 sequence at index, with its length, or null when the byte there starts none. */
const sequenceAt = (
  bytes: Uint8Array,
  index: number,
): readonly [codePoint: number, length: number] | null => {
  const lead = bytes[index] ?? 0;
  const [b1, b2, b3] = [bytes[index + 1], bytes[index + 2], bytes[index + 3]];
  if (lead < 0x80) return [lead, 1];
  if (lead >= 0xc2 && lead <= 0xdf && isContinuation(b1))
    return [((lead & 0x1f) << 6) | ((b1 ?? 0) & 0x3f), 2];
  if (lead >= 0xe0 && lead <= 0xef && b1 !== undefined && isContinuation(b2)) {
    // E0 needs A0..BF after it to avoid an overlong form, and ED needs 80..9F to avoid encoding a surrogate.
    if (
      b1 < (lead === 0xe0 ? 0xa0 : 0x80) ||
      b1 > (lead === 0xed ? 0x9f : 0xbf)
    )
      return null;
    return [((lead & 0x0f) << 12) | ((b1 & 0x3f) << 6) | ((b2 ?? 0) & 0x3f), 3];
  }
  if (
    lead >= 0xf0 &&
    lead <= 0xf4 &&
    b1 !== undefined &&
    isContinuation(b2) &&
    isContinuation(b3)
  ) {
    if (
      b1 < (lead === 0xf0 ? 0x90 : 0x80) ||
      b1 > (lead === 0xf4 ? 0x8f : 0xbf)
    )
      return null;
    return [
      ((lead & 0x07) << 18) |
        ((b1 & 0x3f) << 12) |
        (((b2 ?? 0) & 0x3f) << 6) |
        ((b3 ?? 0) & 0x3f),
      4,
    ];
  }
  return null;
};

/** Decodes bytes as UTF-8, keeping each byte outside a valid sequence as a lone surrogate. */
export const fsDecode = (bytes: Uint8Array): string => {
  try {
    return strict.decode(bytes);
  } catch {
    // Not valid UTF-8: decode sequence by sequence below.
  }
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const sequence = sequenceAt(bytes, index);
    if (sequence === null) {
      text += String.fromCharCode(0xdc00 + (bytes[index] ?? 0));
      index += 1;
    } else {
      text += String.fromCodePoint(sequence[0]);
      index += sequence[1];
    }
  }
  return text;
};

/** The bytes a name from fsDecode came from. */
export const fsEncode = (text: string): Buffer => {
  const parts: Array<Buffer> = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1; // a surrogate pair is one supplementary character, encoded below with its run
        continue;
      }
    }
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit < 0xdc80 || unit > 0xdcff)
      throw new Error(
        `a lone surrogate U+${unit.toString(16)} is no escaped byte`,
      );
    parts.push(
      Buffer.from(text.slice(start, index), "utf8"),
      Buffer.from([unit - 0xdc00]),
    );
    start = index + 1;
  }
  if (start === 0) return Buffer.from(text, "utf8");
  parts.push(Buffer.from(text.slice(start), "utf8"));
  return Buffer.concat(parts);
};

export const isDecodable = (bytes: Uint8Array) => {
  try {
    strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** Bytes as text for a message, with each byte outside valid UTF-8 written as \xNN, as Python's backslashreplace. */
export const backslashReplace = (bytes: Uint8Array) =>
  fsDecode(bytes).replace(
    /[\udc80-\udcff]/g,
    (unit) =>
      `\\x${(unit.charCodeAt(0) - 0xdc00).toString(16).padStart(2, "0")}`,
  );

/** A path Git printed, which review input can carry only when it is valid UTF-8. */
export const decodePath = (raw: Uint8Array): string => {
  if (!isDecodable(raw)) {
    throw new CollectError({
      message: `path is not valid UTF-8, so review input cannot represent it: ${backslashReplace(raw)}`,
    });
  }
  return strict.decode(raw);
};

/** Orders strings by code point, as Python sorts them and as UTF-8 bytes sort, rather than by UTF-16 unit. */
export const byCodePoint = (a: string, b: string): number => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const [x, y] = [a.charCodeAt(index), b.charCodeAt(index)];
    if (x !== y) {
      // A surrogate stands for a code point above U+FFFF, so it sorts after U+E000..U+FFFF.
      const rank = (unit: number) =>
        unit >= 0xd800 && unit <= 0xdfff
          ? unit + 0x2000
          : unit >= 0xe000
            ? unit - 0x800
            : unit;
      return rank(x) - rank(y);
    }
  }
  return a.length - b.length;
};

/** Lowercases ASCII letters only, as Git folds case and as Python's bytes.lower does. */
export const asciiLower = (bytes: Uint8Array): Buffer =>
  Buffer.from(
    bytes.map((byte) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)),
  );

/** The NUL-terminated records in Git -z output. Like Python's split(b"\0")[:-1], text after the last NUL is dropped. */
export const records = (data: Buffer): Array<Buffer> => {
  const found: Array<Buffer> = [];
  for (
    let start = 0, end = data.indexOf(0);
    end >= 0;
    start = end + 1, end = data.indexOf(0, start)
  ) {
    found.push(data.subarray(start, end));
  }
  return found;
};

/** Git output without its one trailing line break. */
export const line = (data: Buffer) =>
  data.at(-1) === 0x0a ? data.subarray(0, -1) : data;

export const isSystemError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && typeof error.code === "string";

/** The system's text for an error, such as "permission denied". */
export const systemMessage = (error: NodeJS.ErrnoException) =>
  typeof error.errno === "number"
    ? getSystemErrorMessage(error.errno)
    : error.message;

/** A name relative to top, as bytes for the file system. */
export const onDisk = (top: string, name: string) =>
  fsEncode(name === "" ? top : `${top}/${name}`);

/** Whether anything, a dangling symbolic link included, exists at path. */
export const lexists = (path: Buffer) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const absolute = (path: string) =>
  isAbsolute(path) ? path : `${process.cwd()}/${path}`;

/**
 * The real path of path, resolving every symbolic link that exists and keeping the rest, as Python's non-strict
 * Path.resolve does. A ".." after a symbolic link goes to the parent of the link's target.
 */
export const resolveLoose = (path: string): string => {
  const full = absolute(path);
  try {
    return fsDecode(realpathSync(fsEncode(full), { encoding: "buffer" }));
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(resolveLoose(parent), basename(full));
  }
};

/** value resolved from base, as Git resolves a relative path in its configuration. */
export const resolveFrom = (base: string, value: string) =>
  resolveLoose(isAbsolute(value) ? value : `${base}/${value}`);

/** Whether path is root or inside it. Both must be absolute and normalized. */
export const isWithin = (path: string, root: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);
