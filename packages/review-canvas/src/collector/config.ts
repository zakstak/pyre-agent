export interface ConfigEntry {
  /**
   * The variable's name without its key, as Git names it: the section lowercased, then "." and the subsection as
   * written, such as "includeif.gitdir:/". The deprecated [section.subsection] form lowercases all of it.
   */
  readonly section: string
  /** Lowercase. */
  readonly key: string
  /** null for a key written without "=". */
  readonly value: string | null
}

const ESCAPES: ReadonlyMap<string, string> = new Map([["n", "\n"], ["t", "\t"], ["b", "\b"], ['"', '"'], ["\\", "\\"]])

// Git's own character classes, which are ASCII only: isspace is space, tab, LF, and CR.
const isSpace = (character: string) => character === " " || character === "\t" || character === "\n" || character === "\r"
const isAlpha = (character: string) => /^[A-Za-z]$/.test(character)
const isKeyChar = (character: string) => /^[A-Za-z0-9-]$/.test(character)

/**
 * The entries of Git config text, read with the grammar of Git's config.c: a section name ends at whitespace or "]",
 * a subsection follows whitespace in quotes with backslash escapes and needs "]" right after its closing quote, the
 * deprecated [section.subsection] form is lowercased whole, a key without "=" must end its line, and a value keeps its
 * inner whitespace, drops unquoted outer whitespace and comments, decodes \n \t \b \" \\, and continues past a
 * backslash at the end of a line. A byte order mark at the start is skipped, and CRLF is one line ending. Reading
 * stops at the first construct Git rejects, since Git then refuses the whole file.
 */
export const configEntries = (source: string): Array<ConfigEntry> => {
  const text = (source.startsWith("\ufeff") ? source.slice(1) : source).replaceAll("\r\n", "\n")
  const entries: Array<ConfigEntry> = []
  let index = 0
  let eof = false
  // Like Git's get_next_char: past the end it reports a line break and sets eof.
  const next = (): string => {
    const character = text[index]
    if (character === undefined) {
      eof = true
      return "\n"
    }
    index += 1
    return character
  }

  // After "[" and a section name, whitespace, then the quoted subsection: [section "subsection"].
  const subsection = (name: string, first: string): string | null => {
    let character = first
    do {
      if (character === "\n") return null
      character = next()
    } while (isSpace(character))
    if (character !== '"') return null
    let written = ""
    for (;;) {
      character = next()
      if (character === "\n") return null
      if (character === '"') break
      if (character === "\\") {
        character = next()
        if (character === "\n") return null
      }
      written += character
    }
    return next() === "]" ? `${name}.${written}` : null
  }

  // After "[": the section name up to "]", or up to whitespace and a subsection.
  const header = (): string | null => {
    let name = ""
    for (;;) {
      const character = next()
      if (eof) return null
      if (character === "]") return name
      if (isSpace(character)) return subsection(name, character)
      if (!isKeyChar(character) && character !== ".") return null
      name += character.toLowerCase()
    }
  }

  const value = (): string | null => {
    let quoted = false
    let comment = false
    let written = ""
    // Where trailing unquoted whitespace starts, or 0 while there is none.
    let trimAt = 0
    for (;;) {
      const character = next()
      if (character === "\n") {
        if (quoted) return null
        return trimAt > 0 ? written.slice(0, trimAt) : written
      }
      if (comment) continue
      if (isSpace(character) && !quoted) {
        if (trimAt === 0) trimAt = written.length
        if (written.length > 0) written += character
        continue
      }
      if (!quoted && (character === ";" || character === "#")) {
        comment = true
        continue
      }
      trimAt = 0
      if (character === "\\") {
        const escaped = next()
        if (escaped === "\n") continue // the value continues on the next line
        const decoded = ESCAPES.get(escaped)
        if (decoded === undefined) return null
        written += decoded
      } else if (character === '"') {
        quoted = !quoted
      } else {
        written += character
      }
    }
  }

  let section = ""
  let comment = false
  for (;;) {
    const character = next()
    if (character === "\n") {
      if (eof) return entries
      comment = false
      continue
    }
    if (comment || isSpace(character)) continue
    if (character === "#" || character === ";") {
      comment = true
      continue
    }
    if (character === "[") {
      const name = header()
      if (name === null || name === "") return entries
      section = name
      continue
    }
    if (!isAlpha(character)) return entries
    let key = character.toLowerCase()
    let after = next()
    while (!eof && isKeyChar(after)) {
      key += after.toLowerCase()
      after = next()
    }
    while (after === " " || after === "\t") after = next()
    if (after === "\n") {
      entries.push({ section, key, value: null })
      if (eof) return entries
      continue
    }
    if (after !== "=") return entries
    const parsed = value()
    if (parsed === null) return entries
    entries.push({ section, key, value: parsed })
  }
}
