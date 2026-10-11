/**
 * The one spelling every document is written in: JSON indented by two spaces, ending in a line feed. Size limits on
 * a document's value measure this text, so an export that passes them fits its format's byte limit.
 */
export const documentText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const utf8 = new TextEncoder()

/** The bytes of a document's text. */
export const documentBytes = (value: unknown): Uint8Array => utf8.encode(documentText(value))
