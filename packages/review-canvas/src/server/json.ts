/** JSON requests and responses: body limits, strict decoding, and one error shape. */
import { Effect, Result, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type DocumentFormat,
  decodeBytes,
  decodeValue,
  InvalidDocument,
  parseStrictJson,
} from "../schema/document.ts";
import { ActionError } from "../review/state.ts";
import { NoSuchReview, StaleRevision } from "../store/store.ts";

export class RequestRefused extends Error {
  readonly status: number;
  readonly kind: string;
  readonly revision: number | undefined;
  constructor(
    status: number,
    kind: string,
    message: string,
    revision?: number,
  ) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.revision = revision;
  }
}

const refuse = (status: number, kind: string, message: string) =>
  Effect.fail(new RequestRefused(status, kind, message));

/** Reads a JSON body of at most `maxBytes`, as strict JSON, and decodes it with the schema, refusing unknown keys. */
export const readJson = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  maxBytes: number,
): Effect.Effect<
  S["Type"],
  RequestRefused,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const type = request.headers["content-type"] ?? "";
    if (!/^application\/json\b/i.test(type))
      return yield* refuse(415, "content_type", "Send application/json.");
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > maxBytes)
      return yield* refuse(
        413,
        "too_large",
        `The body exceeds ${maxBytes} bytes.`,
      );
    const bytes = yield* request.arrayBuffer.pipe(
      Effect.mapError(
        () => new RequestRefused(400, "body", "Could not read the body."),
      ),
    );
    if (bytes.byteLength > maxBytes)
      return yield* refuse(
        413,
        "too_large",
        `The body exceeds ${maxBytes} bytes.`,
      );
    const raw = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new RequestRefused(400, "encoding", "The body is not UTF-8."),
    });
    const parsed = parseStrictJson(raw);
    if (Result.isFailure(parsed))
      return yield* refuse(400, "syntax", parsed.failure.message);
    const decoded = Schema.decodeUnknownResult(schema)(parsed.success, {
      onExcessProperty: "error",
    });
    if (Result.isFailure(decoded)) {
      return yield* refuse(
        400,
        "schema",
        `The request is invalid: ${decoded.failure.message}`,
      );
    }
    return decoded.success;
  });

/** Reads a document body, such as a round's input, within its format's byte limit. */
export const readDocument = <S extends Schema.Codec<unknown, unknown>>(
  format: DocumentFormat<S>,
): Effect.Effect<
  S["Type"],
  RequestRefused,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const type = request.headers["content-type"] ?? "";
    if (!/^application\/json\b/i.test(type))
      return yield* refuse(415, "content_type", "Send application/json.");
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > format.maxBytes)
      return yield* refuse(
        413,
        "too_large",
        `${format.noun} exceeds ${format.maxBytes} bytes.`,
      );
    const bytes = yield* request.arrayBuffer.pipe(
      Effect.mapError(
        () => new RequestRefused(400, "body", "Could not read the body."),
      ),
    );
    const decoded = decodeBytes(format, new Uint8Array(bytes));
    if (Result.isFailure(decoded))
      return yield* Effect.fail(refusedDocument(decoded.failure));
    return decoded.success;
  });

export const refusedDocument = (error: InvalidDocument) =>
  new RequestRefused(
    error.reason === "too_large" ? 413 : 400,
    error.reason,
    error.message,
  );

export const decodeJsonValue = <S extends Schema.Codec<unknown, unknown>>(
  format: DocumentFormat<S>,
  value: unknown,
) => {
  const decoded = decodeValue(format, value);
  return Result.isFailure(decoded)
    ? Result.fail(refusedDocument(decoded.failure))
    : decoded;
};

const STATUS: Readonly<Record<ActionError["kind"], number>> = {
  closed: 409,
  no_round: 409,
  not_found: 404,
  not_your_turn: 409,
  resolved: 409,
  bad_anchor: 400,
  changed: 409,
  fingerprint: 409,
  invalid: 400,
};

/** The error a store call raises, as a refusal the client can read. Anything else is a defect. */
export const refusal = (error: unknown): RequestRefused => {
  if (error instanceof RequestRefused) return error;
  if (error instanceof ActionError)
    return new RequestRefused(STATUS[error.kind], error.kind, error.message);
  if (error instanceof StaleRevision)
    return new RequestRefused(409, "stale", error.message, error.revision);
  if (error instanceof NoSuchReview)
    return new RequestRefused(404, "not_found", error.message);
  throw error;
};

/** Runs a synchronous store call, turning its refusals into failures. */
export const attempt = <A>(work: () => A): Effect.Effect<A, RequestRefused> =>
  Effect.try({ try: work, catch: refusal });

export const ok = (body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: { "cache-control": "no-store" },
  });

export const refused = (error: RequestRefused) =>
  HttpServerResponse.jsonUnsafe(
    {
      ok: false,
      error: {
        kind: error.kind,
        message: error.message,
        ...(error.revision === undefined ? {} : { revision: error.revision }),
      },
    },
    { status: error.status, headers: { "cache-control": "no-store" } },
  );
