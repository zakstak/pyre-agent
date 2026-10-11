// Pure checks on patch text and file names: what a reviewer may see, and what looks like a secret.

// C0 controls other than tab, LF, and CR, and DEL, show as control pictures. C1 controls, line and paragraph
// separators, and bidirectional formatting characters, which can hide or reorder code, show as U+FFFD.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const lenient = new TextDecoder("utf-8", { ignoreBOM: true })

/** Patch bytes decoded for display, and whether any byte or character was replaced. */
export const cleanText = (data: Uint8Array): { readonly text: string; readonly replaced: boolean } => {
  let decoded: string
  let invalid = false
  try {
    decoded = strict.decode(data)
  } catch {
    // Each maximal invalid sequence becomes one U+FFFD, as with Python's "replace".
    decoded = lenient.decode(data)
    invalid = true
  }
  const text = decoded.replace(CONTROL, (character) =>
    character === "\x7f" ? "\u2421" : character < "\x20" ? String.fromCharCode(0x2400 + character.charCodeAt(0)) : "\ufffd")
  return { text, replaced: invalid || text !== decoded }
}

const SECRET_NAMES: ReadonlySet<string> = new Set([".env", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials",
  ".htpasswd", "credentials", "credentials.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"])
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx"]
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist"]

/** Whether a path's name marks a likely secret file. */
export const secretName = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (name === ".env" || name.startsWith(".env.")) return !SAFE_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix))
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// Python's \b counts any Unicode letter or digit as part of a word; JavaScript's counts only ASCII ones.
const WORD = String.raw`[\p{L}\p{N}_]`

/** A private key block, or a token in a known format. Written with quantifiers and classes so this file never matches
 * its own patterns. */
export const SECRET_TEXT = new RegExp([
  String.raw`-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}`,
  String.raw`(?<!${WORD})AKIA[0-9A-Z]{16}(?!${WORD})`,
  String.raw`(?<!${WORD})gh[pousr]_[A-Za-z0-9]{36,}`,
  String.raw`(?<!${WORD})github_pat_[A-Za-z0-9_]{22,}`,
  String.raw`(?<!${WORD})xox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`
].join("|"), "u")
