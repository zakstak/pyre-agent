// Helpers for the schema tests: read fixtures, edit raw JSON documents, and check what a decoder accepts or refuses.
import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { InvalidDocument, InvalidReason } from "./document.ts";

export type Json =
  | null
  | boolean
  | number
  | string
  | Array<Json>
  | { [key: string]: Json };
export type JsonPath = ReadonlyArray<string | number>;

export const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url));

/** A fresh copy of a fixture, to edit. */
export const fixture = (name: string): Json =>
  JSON.parse(fixtureBytes(name).toString("utf8"));

export const encode = (value: Json): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const child = (node: Json, key: string | number): Json => {
  const next = Array.isArray(node)
    ? node[Number(key)]
    : typeof node === "object" && node !== null
      ? node[key]
      : undefined;
  if (next === undefined)
    throw new Error(`The document has nothing at ${String(key)}`);
  return next;
};

export const get = (doc: Json, path: JsonPath): Json => path.reduce(child, doc);

/** Sets the value at a path, or removes the key or element there when the value is undefined. */
export const set = (
  doc: Json,
  path: JsonPath,
  value: Json | undefined,
): Json => {
  const key = path.at(-1);
  const parent = get(doc, path.slice(0, -1));
  if (key === undefined) throw new Error("A path names at least one key");
  if (Array.isArray(parent)) {
    if (value === undefined) parent.splice(Number(key), 1);
    else parent[Number(key)] = value;
  } else if (typeof parent === "object" && parent !== null) {
    if (value === undefined) delete parent[key];
    else parent[key] = value;
  } else {
    throw new Error(
      `The document has no object or array at ${path.slice(0, -1).join(".")}`,
    );
  }
  return doc;
};

/** A deep copy, so one fixture value can appear twice in a document. */
export const copy = (value: Json): Json => structuredClone(value);

export const accepted = <A>(result: Result.Result<A, InvalidDocument>): A => {
  if (Result.isFailure(result)) assert.fail(result.failure.message);
  return result.success;
};

export const refused = (
  result: Result.Result<unknown, InvalidDocument>,
  message: RegExp,
  reason: InvalidReason = "schema",
) => {
  if (Result.isSuccess(result))
    assert.fail(`Expected a refusal matching ${message}`);
  assert.match(result.failure.message, message);
  assert.equal(result.failure.reason, reason, result.failure.message);
};
