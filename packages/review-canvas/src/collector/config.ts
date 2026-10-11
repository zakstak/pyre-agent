export interface ConfigEntry {
  /** Lowercase, with ".subsection" appended as written. */
  readonly section: string
  /** Lowercase. */
  readonly key: string
  /** null for a key written without "=". */
  readonly value: string | null
}

const ESCAPES: ReadonlyMap<string, string> = new Map([["n", "\n"], ["t", "\t"], ["b", "\b"], ['"', '"'], ["\\", "\\"]])
const KEY = /[A-Za-z][A-Za-z0-9-]*/y

/**
 * The entries of Git config text, decoded as Git's parser does: quotes removed, the escapes \n \t \b \" \\ decoded, a
 * backslash before a line break continuing the line, comments after an unquoted # or ; dropped, and unquoted spaces
 * trimmed at the ends. Parsing stops at a line Git would reject, since Git then refuses the whole file.
 */
export const configEntries = (source: string): Array<ConfigEntry> => {
  const text = source.replaceAll("\r\n", "\n") // Git reads CRLF as one line ending
  const entries: Array<ConfigEntry> = []
  const length = text.length
  const nextLine = (from: number) => {
    const end = text.indexOf("\n", from)
    return end < 0 ? length : end + 1
  }
  let index = 0
  let section = ""
  while (index < length) {
    const character = text[index] ?? ""
    if (" \t\r\n".includes(character)) {
      index += 1
    } else if (character === "#" || character === ";") {
      index = nextLine(index)
    } else if (character === "[") {
      const end = text.indexOf("]", index)
      if (end < 0) return entries
      const header = text.slice(index + 1, end).trim()
      const space = header.indexOf(" ")
      const name = space < 0 ? header : header.slice(0, space)
      let subsection = space < 0 ? "" : header.slice(space + 1).trim()
      if (subsection.startsWith('"') && subsection.endsWith('"')) subsection = subsection.slice(1, -1).replace(/\\([^\n])/g, "$1")
      section = name.toLowerCase() + (subsection ? `.${subsection}` : "")
      index = end + 1
    } else {
      KEY.lastIndex = index
      const match = KEY.exec(text)
      if (match === null) return entries
      const key = match[0].toLowerCase()
      index += match[0].length
      while (index < length && (text[index] === " " || text[index] === "\t")) index += 1
      if (text[index] !== "=") {
        entries.push({ section, key, value: null })
        continue
      }
      index += 1
      while (index < length && (text[index] === " " || text[index] === "\t")) index += 1
      // Spaces wait in pending until a later character shows they are inside the value rather than at its end.
      const value: Array<string> = []
      let pending = 0
      let quoted = false
      while (index < length) {
        const next = text[index] ?? ""
        index += 1
        if (next === "\n") {
          if (quoted) return entries
          break
        }
        if (!quoted && (next === " " || next === "\t")) {
          if (value.length > 0) pending += 1
          continue
        }
        if (!quoted && (next === "#" || next === ";")) {
          index = nextLine(index)
          break
        }
        value.push(" ".repeat(pending))
        pending = 0
        if (next === "\\") {
          const escaped = text[index] ?? ""
          index += 1
          if (escaped === "\n") continue // the value continues on the next line
          const decoded = ESCAPES.get(escaped)
          if (decoded === undefined) return entries
          value.push(decoded)
        } else if (next === '"') {
          quoted = !quoted
        } else {
          value.push(next)
        }
      }
      entries.push({ section, key, value: value.join("") })
    }
  }
  return entries
}
