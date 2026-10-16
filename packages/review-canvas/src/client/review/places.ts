/** Where a location hash points on the review page. */
export type Place =
  | { readonly kind: "files"; readonly file?: string }
  | { readonly kind: "stop"; readonly index: number }
  /** An element on the page, such as a note in a stop or the skip link's target. */
  | { readonly kind: "element"; readonly id: string }
  | { readonly kind: "start" };

/**
 * Reads a hash: `#files`, `#files/PATH`, `#tour/N` for stop N from 1, or the ID of an element. An empty hash, or one
 * that does not decode, is the start of the tour.
 */
export const parseHash = (hash: string): Place => {
  let raw: string;
  try {
    raw = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return { kind: "start" };
  }
  if (raw === "") return { kind: "start" };
  if (raw === "files") return { kind: "files" };
  if (raw.startsWith("files/")) return { kind: "files", file: raw.slice(6) };
  const stop = /^tour\/([1-9][0-9]*)$/.exec(raw);
  if (stop !== null) return { kind: "stop", index: Number(stop[1]) - 1 };
  return { kind: "element", id: raw };
};

/** A hash that points at an element by its ID, encoded for a path's characters a hash cannot hold. */
export const hashOf = (id: string): string => `#${encodeURI(id).replaceAll("#", "%23")}`;
