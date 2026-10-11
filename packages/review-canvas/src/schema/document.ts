import * as Data from "effect/Data"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { FEEDBACK_FORMAT, Feedback } from "./feedback.ts"
import { INPUT_FORMAT, ReviewInput, WorktreeInput } from "./input.ts"
import * as Limits from "./limits.ts"

/** Why a document was refused. */
export type InvalidReason = "too_large" | "encoding" | "syntax" | "format" | "schema"

/** A document that is not valid. The message names the field and the rule it breaks. */
export class InvalidDocument extends Data.TaggedError("InvalidDocument")<{
  readonly reason: InvalidReason
  readonly message: string
}> {}

/**
 * One serialized format: its key, the schema that decodes it, and its byte limit. Each format starts at version 1
 * under its own key, so no file of the Python review canvas reads as one of them.
 */
export interface DocumentFormat<S extends Schema.Codec<unknown, unknown>> {
  readonly key: string
  readonly noun: string
  readonly schema: S
  readonly maxBytes: number
}

export const InputDocument: DocumentFormat<typeof ReviewInput> = {
  key: INPUT_FORMAT,
  noun: "Review input",
  schema: ReviewInput,
  maxBytes: Limits.MAX_INPUT_BYTES
}
/** The collector's output: a {@link InputDocument} for a working tree. */
export const WorktreeInputDocument: DocumentFormat<typeof WorktreeInput> = { ...InputDocument, schema: WorktreeInput }
export const FeedbackDocument: DocumentFormat<typeof Feedback> = {
  key: FEEDBACK_FORMAT,
  noun: "Feedback",
  schema: Feedback,
  maxBytes: Limits.MAX_FEEDBACK_BYTES
}

const KEYS = [INPUT_FORMAT, FEEDBACK_FORMAT]
const FORMAT_KEY = /^review-canvas\.([a-z-]+)\/([0-9]+)$/

const invalid = (reason: InvalidReason, message: string) => Result.fail(new InvalidDocument({ reason, message }))

const shown = (value: unknown) => {
  const json = JSON.stringify(value) ?? String(value)
  return json.length > 80 ? `${json.slice(0, 80)}…` : json
}

/** Refuses a value that does not name this format, and says what it names instead. */
const checkFormat = (
  format: Pick<DocumentFormat<never>, "key" | "noun">,
  value: unknown
): Result.Result<void, InvalidDocument> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("format", `${format.noun} must be a JSON object with "format": "${format.key}".`)
  }
  if (!("format" in value)) {
    // The version fields of the Python review canvas. There is no conversion: finish such a review there.
    const python = "feedback_schema_version" in value
      ? `feedback, feedback_schema_version ${shown(value.feedback_schema_version)}`
      : "schema_version" in value
      ? `review input, schema_version ${shown(value.schema_version)}`
      : undefined
    return invalid(
      "format",
      python === undefined
        ? `${format.noun} has no "format" field; expected "${format.key}".`
        : `This is Python review canvas ${python}, which this version cannot read. ` +
          "Finish that review in the Python version."
    )
  }
  const named = value.format
  if (named === format.key) return Result.succeed(undefined)
  const match = typeof named === "string" ? FORMAT_KEY.exec(named) : null
  const expectedName = FORMAT_KEY.exec(format.key)?.[1]
  if (match !== null && match[1] === expectedName) {
    return invalid("format", `${shown(named)} is not supported; this version reads "${format.key}".`)
  }
  if (typeof named === "string" && KEYS.includes(named)) {
    return invalid("format", `Expected ${format.noun.toLowerCase()} ("${format.key}"), but this is ${shown(named)}.`)
  }
  return invalid("format", `Unknown format ${shown(named)}; expected "${format.key}".`)
}

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.reduce<string>(
    (out, key) =>
      typeof key === "number"
        ? `${out}[${key}]`
        : typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        ? out === "" ? key : `${out}.${key}`
        : `${out}[${shown(String(key))}]`,
    ""
  )

const describe = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey"
      ? "missing"
      : issue._tag === "UnexpectedKey"
      ? "unknown field"
      : SchemaIssue.defaultLeafHook(issue)
})

/**
 * Decodes a value already parsed from JSON. Prefer {@link decodeBytes} for anything read from a file or a request:
 * JSON.parse keeps the last of duplicate keys and reads 7.0 as 7, which the strict parser refuses.
 *
 * Decode documents here rather than with the schemas directly: Effect's decoders drop unknown fields by default,
 * and this refuses them.
 */
export const decodeValue = <S extends Schema.Codec<unknown, unknown>>(
  format: DocumentFormat<S>,
  value: unknown
): Result.Result<S["Type"], InvalidDocument> => {
  const named = checkFormat(format, value)
  if (Result.isFailure(named)) return named
  const decoded = Schema.decodeUnknownResult(format.schema)(value, { onExcessProperty: "error" })
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success)
  const problems = describe(decoded.failure.issue).issues.map((issue) =>
    issue.path === undefined || issue.path.length === 0
      ? issue.message
      : `${formatPath(issue.path.map((key) => (typeof key === "object" ? key.key : key)))}: ${issue.message}`
  )
  // Each member of a union reports its own failure, and they often agree.
  return invalid("schema", `${format.noun} is invalid: ${[...new Set(problems)].join("; ")}`)
}

/**
 * Parses JSON text strictly. Beyond JSON.parse, it refuses duplicate keys, numbers with a fraction or exponent, and
 * nesting deeper than {@link Limits.MAX_JSON_DEPTH}, so every reader of a document sees the same values.
 */
export const parseStrictJson = (raw: string): Result.Result<unknown, InvalidDocument> => {
  if (raw.startsWith("\ufeff")) return invalid("syntax", "Not valid JSON: it starts with a byte order mark.")
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return invalid("syntax", `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  // JSON.parse accepted the syntax, so a scan of the tokens only has to check what it does not.
  const frames: Array<{ readonly keys: Set<string> | undefined; expectKey: boolean }> = []
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]
    const top = frames.at(-1)
    const isKey = top?.keys !== undefined && top.expectKey
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "}" || char === "]") {
      if (char === "}" || char === "]") frames.pop()
      continue
    }
    if (char === ":") continue
    if (char === ",") {
      if (top !== undefined) top.expectKey = top.keys !== undefined
      continue
    }
    if (!isKey && frames.length > Limits.MAX_JSON_DEPTH) {
      return invalid("syntax", `JSON is nested deeper than ${Limits.MAX_JSON_DEPTH} levels.`)
    }
    if (char === "{" || char === "[") {
      frames.push({ keys: char === "{" ? new Set() : undefined, expectKey: char === "{" })
    } else if (char === "\"") {
      const start = at
      for (at++; raw[at] !== "\""; at++) if (raw[at] === "\\") at++
      if (isKey) {
        const key: string = JSON.parse(raw.slice(start, at + 1))
        if (top.keys.has(key)) return invalid("syntax", `JSON has a duplicate key: ${shown(key)}.`)
        top.keys.add(key)
        top.expectKey = false
      }
    } else if (char === "t" || char === "f" || char === "n") {
      at += char === "f" ? 4 : 3
    } else {
      const start = at
      while (at + 1 < raw.length && /[-+0-9.eE]/.test(raw[at + 1] ?? "")) at++
      const number = raw.slice(start, at + 1)
      if (/[.eE]/.test(number)) {
        return invalid("syntax", `JSON numbers must be integers, without a fraction or exponent: ${shown(number)}.`)
      }
    }
  }
  return Result.succeed(value)
}

/**
 * Decodes a document from the bytes of a file or request: at most the format's byte limit, strict UTF-8 without a
 * byte order mark, strict JSON, then the format and its schema.
 */
export const decodeBytes = <S extends Schema.Codec<unknown, unknown>>(
  format: DocumentFormat<S>,
  bytes: Uint8Array
): Result.Result<S["Type"], InvalidDocument> => {
  if (bytes.byteLength > format.maxBytes) {
    return invalid("too_large", `${format.noun} exceeds ${format.maxBytes / 1024 / 1024} MiB.`)
  }
  let raw: string
  try {
    // ignoreBOM keeps a byte order mark in the text, where JSON.parse refuses it.
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return invalid("encoding", `${format.noun} is not valid UTF-8.`)
  }
  const value = parseStrictJson(raw)
  return Result.isFailure(value) ? value : decodeValue(format, value.success)
}
