// The input validation cases of the Python review canvas (ValidationTests in tests/test_review_renderer.py), converted
// to review-canvas.input/1.
import * as Schema from "effect/Schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeBytes, decodeValue, encodeDocument, InputDocument, WorktreeInputDocument } from "./document.ts"
import { ReviewInput, WorktreeInput } from "./input.ts"
import * as Limits from "./limits.ts"
import { accepted, copy, fixture, fixtureBytes, get, type Json, type JsonPath, refused, set } from "./testing.ts"

const PATCH = "@@ -1,2 +1,2 @@\n-old\n+new\n context\n"

const simpleReview = (): Json => ({
  format: "review-canvas.input/1",
  target: {
    kind: "github_pr",
    title: "Example",
    url: "https://github.com/example/project/pull/7",
    head_sha: "d".repeat(40)
  },
  files_complete: false,
  files: [{
    path: "a.py",
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    fingerprint: "c".repeat(64),
    patch: PATCH
  }]
})

const worktreeReview = (): Json =>
  set(simpleReview(), ["target"], {
    kind: "worktree",
    title: "Uncommitted changes on main",
    root: "/home/dev/project",
    head_sha: "d".repeat(40),
    branch: "main"
  })

const decode = (doc: Json) => decodeValue(InputDocument, doc)
const file = (key: string): JsonPath => ["files", 0, key]

test("the input fixtures decode to their own JSON and encode back", () => {
  for (const name of ["worktree", "pull-request"]) {
    const raw = fixture(`input/${name}.json`)
    const decoded = accepted(decodeBytes(InputDocument, fixtureBytes(`input/${name}.json`)))
    assert.deepEqual(decoded, raw, name)
    assert.deepEqual(Schema.encodeSync(ReviewInput)(decoded), raw, name)
  }
  accepted(decode(simpleReview()))
  accepted(decode(worktreeReview()))
})

test("the collector's working tree input is a review input too", () => {
  const input = accepted(decodeBytes(WorktreeInputDocument, fixtureBytes("input/worktree.json")))
  const asReview: ReviewInput = input
  assert.equal(asReview.target.kind, "worktree")
  assert.ok(input.files.every((item) => item.fingerprint.length === 64))
  assert.deepEqual(Schema.encodeSync(WorktreeInput)(input), fixture("input/worktree.json"))
  refused(decodeValue(WorktreeInputDocument, simpleReview()), /target\.(kind|url)/)
  refused(
    decodeValue(WorktreeInputDocument, set(worktreeReview(), file("fingerprint"), undefined)),
    /files\[0\]\.fingerprint: missing/
  )
})

test("input: bad PR links are refused", () => {
  for (
    const url of [
      "javascript:alert(1)",
      "http://github.com/a/b/pull/1",
      "https://github.com.evil/a/b/pull/1",
      "https://user@github.com/a/b/pull/1",
      "https://github.com:443/a/b/pull/1",
      "https://github.com/a/b/pull/0",
      "https://github.com/a/b/pull/1?x=y",
      "https://github.com/a/b/pull/1\n"
    ]
  ) {
    refused(
      decode(set(simpleReview(), ["target", "url"], url)),
      /target\.url: Expected https:\/\/github\.com\/OWNER\/REPO\/pull\/NUMBER/
    )
  }
})

const invalidFields: ReadonlyArray<readonly [JsonPath, Json, RegExp]> = [
  [["files_complete"], 1, /files_complete: Expected boolean/],
  [["surprise"], "unexpected", /surprise: unknown field/],
  [["target", "title"], "", /target\.title: must not be empty/],
  [["target", "head_sha"], "short", /target\.head_sha: Expected a full 40- or 64-character hexadecimal commit hash/],
  [["target", "base_sha"], "z".repeat(40), /target\.base_sha: Expected a full 40- or 64-character/],
  [["target", "changed_files"], true, /target\.changed_files: Expected number/],
  [["target", "changed_files"], -1, /target\.changed_files: Expected a value between 0 and 1000000000000/],
  [["target", "kind"], "branch", /target: Expected a target whose kind is github_pr or worktree/],
  [["target", "root"], "/home/dev/project", /target\.root: unknown field/],
  [["pr"], { title: "Old" }, /pr: unknown field/],
  [file("path"), "", /files\[0\]\.path: expected a repository-relative path/],
  [file("path"), "bad\u0000path", /files\[0\]\.path: contains a control character/],
  [file("path"), "bad\ud800path", /files\[0\]\.path: contains an unpaired Unicode surrogate/],
  [file("additions"), true, /files\[0\]\.additions: Expected number/],
  [file("deletions"), -1, /files\[0\]\.deletions: Expected a value between 0 and 1000000000000/],
  [file("additions"), 1.5, /files\[0\]\.additions: Expected an integer/],
  [file("group"), "unknown", /files\[0\]\.group: Expected "core" \| "wiring" \| "mechanical"/],
  [file("group"), [], /files\[0\]\.group: Expected "core"/],
  [file("status"), {}, /files\[0\]\.status: Expected "added"/],
  [file("patch_complete"), "true", /files\[0\]\.patch_complete: Expected boolean/],
  [file("patch"), [], /files\[0\]\.patch: Expected string/],
  [file("callouts"), [{ tag: "T", text: "T", url: "https://x" }], /files\[0\]\.callouts\[0\]\.url: unknown field/],
  [file("trace"), { input: "x", before: "y" }, /files\[0\]\.trace\.after: missing/],
  [file("fingerprint"), "C".repeat(64), /files\[0\]\.fingerprint: Expected 64 lowercase hexadecimal characters/],
  [file("fingerprint"), "c".repeat(63), /files\[0\]\.fingerprint: Expected 64 lowercase hexadecimal characters/],
  [file("old_path"), "b.py", /files\[0\]\.old_path: allowed only for a renamed or copied file/],
  [file("old_mode"), "644", /files\[0\]\.old_mode: Expected a six-digit octal Git mode/],
  [file("new_mode"), 100644, /files\[0\]\.new_mode: Expected string/],
  [file("patch_note"), "huge", /files\[0\]\.patch_note: Expected "binary"/],
  [file("patch_note"), "binary", /files\[0\]\.patch_note: binary is only for a file without a patch/],
  [file("patch_note"), "secret", /files\[0\]\.patch_note: secret is only for a file without a patch/],
  // New in version 1: a missing patch has one spelling, and answers are actions of their own.
  [file("patch"), null, /files\[0\]\.patch: Expected string/],
  [file("patch"), "", /files\[0\]\.patch: must not be empty; omit the patch instead/],
  [["replies"], [], /replies: unknown field/]
]

for (const [path, value, message] of invalidFields) {
  test(`input: ${path.join(".")} = ${JSON.stringify(value)} is refused`, () => {
    refused(decode(set(simpleReview(), path, value)), message)
  })
}

test("input: a replaced-characters note needs its patch, and an old path differs from the path", () => {
  refused(
    decode(set(set(simpleReview(), file("patch_note"), "replaced_characters"), file("patch"), undefined)),
    /patch_note: replaced_characters needs a patch/
  )
  accepted(decode(set(simpleReview(), file("patch_note"), "replaced_characters")))
  const renamed = set(simpleReview(), file("status"), "renamed")
  accepted(decode(set(copy(renamed), file("old_path"), "b.py")))
  // A moved file names where it came from; the Python version allowed a rename without one.
  refused(decode(copy(renamed)), /files\[0\]\.old_path: required for a renamed file: the path it came from/)
  refused(decode(set(simpleReview(), file("status"), "copied")), /files\[0\]\.old_path: required for a copied file/)
  accepted(decode(set(set(simpleReview(), file("status"), "copied"), file("old_path"), "b.py")))
  refused(
    decode(set(renamed, file("old_path"), "a.py")),
    /old_path: allowed only for a renamed or copied file, and must differ from path/
  )
})

test("input: paths are repository-relative, as Git names them", () => {
  // The Python collector writes Git's names unquoted. It refuses names that are not UTF-8 or that hold a control
  // character other than tab, LF, or CR; everything else it writes must decode.
  for (
    const path of [
      ".env.local",
      "notes/.keep",
      "...",
      "..hidden/file..",
      "dir with space/back\\slash",
      "tab\tand\nnewline",
      // Names Git allows that are only whitespace; the Python version refused them, and failed the whole collection.
      " ",
      "\t",
      "dir/ \r\n",
      "\ufeff",
      "\u3000/\u00a0",
      "🙂/é.txt"
    ]
  ) {
    accepted(decode(set(simpleReview(), file("path"), path)))
  }
  for (const path of ["/etc/passwd", "../outside", "a/../b", "a/./b", "a//b", "a/", ".", "..", "/", "./a"]) {
    refused(
      decode(set(simpleReview(), file("path"), path)),
      /files\[0\]\.path: expected a repository-relative path with no empty, \. or \.\. segment/
    )
  }
  refused(decode(set(simpleReview(), file("path"), "a\u0000b")), /files\[0\]\.path: contains a control character/)
  const renamed = set(simpleReview(), file("status"), "renamed")
  refused(
    decode(set(renamed, file("old_path"), "../a.py")),
    /files\[0\]\.old_path: expected a repository-relative path/
  )
})

test("input: format errors name the format", () => {
  refused(
    decode(set(simpleReview(), ["format"], true)),
    /^Unknown format true; expected "review-canvas\.input\/1"\.$/, "format"
  )
  refused(
    decode(set(simpleReview(), ["format"], "review-canvas.input/2")),
    /^"review-canvas\.input\/2" is not supported; this version reads "review-canvas\.input\/1"\.$/, "format"
  )
  refused(
    decode(fixture("feedback/minimal.json")),
    /^Expected review input \("review-canvas\.input\/1"\), but this is "review-canvas\.feedback\/1"\.$/, "format"
  )
})

test("input: Python versions name the version", () => {
  // test_old_versions_name_the_version, and version 1 with its pr object.
  for (const version of [1, 2, 3]) {
    const python = set(set(simpleReview(), ["format"], undefined), ["schema_version"], version)
    const message = new RegExp(`Python review canvas review input, schema_version ${version}, which this version`)
    refused(decode(python), message, "format")
  }
  refused(decode({ schema_version: 1, pr: { title: "Old" }, files: [] }), /schema_version 1/, "format")
})

test("input: a working tree target needs an absolute POSIX root, a full head commit, and fingerprints", () => {
  for (
    const [key, value] of [
      ["root", "relative/path"],
      ["root", ""],
      ["branch", ""],
      ["head_sha", "abc"],
      ["url", "https://github.com/example/project/pull/7"]
    ] as const
  ) {
    refused(decode(set(worktreeReview(), ["target", key], value)), new RegExp(`target\\.${key}`))
  }
  for (const key of ["root", "head_sha", "title"]) {
    refused(decode(set(worktreeReview(), ["target", key], undefined)), new RegExp(`target\\.${key}: missing`))
  }
  refused(
    decode(set(worktreeReview(), file("fingerprint"), undefined)),
    /files\[0\]\.fingerprint: required for a worktree target/
  )
  // The Python version accepted Windows drive and UNC roots; working trees are on Linux and macOS now.
  for (
    const root of [
      "C:\\work\\project",
      "\\\\server\\share\\project",
      "\\\\server",
      "\\project",
      "/home/dev/project/",
      "/home//dev/project",
      "/home/./dev/project",
      "/home/dev/../project"
    ]
  ) {
    refused(
      decode(set(worktreeReview(), ["target", "root"], root)),
      /target\.root: expected an absolute path with no empty, \. or \.\. segment/
    )
  }
  accepted(decode(set(worktreeReview(), ["target", "root"], "/")))
})

test("input: text limits count UTF-16 code units, like the page", () => {
  const review = worktreeReview()
  set(review, ["target", "branch"], "🙂".repeat(512))
  set(review, file("path"), "🙂".repeat(2048))
  accepted(decode(review))
  refused(
    decode(set(worktreeReview(), ["target", "branch"], "🙂".repeat(513))),
    /target\.branch: exceeds 1024 UTF-16 code units/
  )
  refused(
    decode(set(worktreeReview(), ["target", "root"], `/${"🙂".repeat(2048)}`)),
    /target\.root: exceeds 4096 UTF-16 code units/
  )
  refused(
    decode(set(worktreeReview(), file("path"), "🙂".repeat(2049))),
    /files\[0\]\.path: exceeds 4096 UTF-16 code units/
  )
})

const withFiles = (count: number, make: (index: number) => Json) =>
  set(simpleReview(), ["files"], Array.from({ length: count }, (_, index) => make(index)))
const fileAt = (path: string, patch: string | undefined = PATCH): Json =>
  set({ path, status: "modified", group: "core", additions: 1, deletions: 1 }, ["patch"], patch)

test("input: paths too long for feedback are refused", () => {
  const review = withFiles(1000, (index) => fileAt(`${String(index).padStart(4, "0")}/${"p".repeat(4000)}`))
  refused(
    decode(review),
    /files: the paths are too long for feedback on this review to fit its 8 MiB limit; split the review/
  )
})

test("input: missing file fields and duplicate files are refused", () => {
  for (const key of ["path", "status", "group", "additions", "deletions"]) {
    refused(decode(set(simpleReview(), file(key), undefined)), new RegExp(`files\\[0\\]\\.${key}: missing`))
  }
  const review = simpleReview()
  set(review, ["files", 1], copy(get(review, ["files", 0])))
  refused(decode(review), /files\[1\]\.path: duplicate file path/)
  refused(decode(set(simpleReview(), ["files_complete"], undefined)), /files_complete: missing/)
})

test("input: a complete file list must match the declared count", () => {
  for (const count of [undefined, 0, 2]) {
    const review = set(simpleReview(), ["files_complete"], true)
    if (count !== undefined) set(review, ["target", "changed_files"], count)
    refused(decode(review), /files_complete: true requires target\.changed_files matching the supplied file count/)
  }
  accepted(decode(set(set(simpleReview(), ["files_complete"], true), ["target", "changed_files"], 1)))
})

test("input: invalid JSON, duplicate keys, and non-finite values are refused", () => {
  const bytes = (raw: string) => decodeBytes(InputDocument, new TextEncoder().encode(raw))
  refused(
    bytes(`{"format":"review-canvas.input/1","format":"review-canvas.input/1"}`),
    /duplicate key: "format"/, "syntax"
  )
  refused(bytes(`{"x": NaN}`), /^Not valid JSON/, "syntax")
  refused(bytes(`{"x": Infinity}`), /^Not valid JSON/, "syntax")
  refused(bytes("[invalid]"), /^Not valid JSON/, "syntax")
  // A lone surrogate written as UTF-8 bytes, as Python's surrogatepass would, is not UTF-8.
  refused(
    decodeBytes(InputDocument, new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])),
    /^Review input is not valid UTF-8\.$/, "encoding"
  )
  // JSON.parse would read 1.0 as 1; a count is an integer as written.
  refused(
    bytes(JSON.stringify(simpleReview()).replace(`"additions":1`, `"additions":1.0`)),
    /numbers must be integers/, "syntax"
  )
})

test("input: resource limits", () => {
  refused(
    decode(set(simpleReview(), file("patch"), "x".repeat(Limits.MAX_PATCH_UNITS + 1))),
    /files\[0\]\.patch: exceeds 4194304 UTF-16 code units/
  )
  accepted(decode(withFiles(Limits.MAX_FILES, (index) => fileAt(`f${index}`, undefined))))
  refused(
    decode(withFiles(Limits.MAX_FILES + 1, (index) => fileAt(`f${index}`, undefined))),
    /files: Expected a value with a length of at most 2000/
  )
  refused(
    decodeBytes(InputDocument, new Uint8Array(Limits.MAX_INPUT_BYTES + 1).fill(0x20)),
    /^Review input exceeds 32 MiB\.$/, "too_large"
  )
})

test("input: every accepted input fits 32 MiB written in its one spelling", () => {
  // Minified, 2,000 files of 100 minimal callouts and a 10,200-character summary take about 25 MiB; indented, about
  // 34 MiB. The supplied bytes pass the limit, so only the schema's check of the written document refuses them.
  const callouts = Array.from({ length: Limits.MAX_CALLOUTS }, (): Json => ({ tag: "t", text: "x" }))
  const withCallouts = (count: number) =>
    withFiles(count, (index) =>
      set(set(fileAt(`f${index}`, undefined), ["summary"], "s".repeat(10_200)), ["callouts"], callouts))
  const minified = new TextEncoder().encode(JSON.stringify(withCallouts(2000)))
  assert.ok(minified.byteLength < Limits.MAX_INPUT_BYTES, String(minified.byteLength))
  refused(
    decodeBytes(InputDocument, minified),
    /^Review input is invalid: takes \d+ bytes as written JSON, more than 32 MiB$/
  )
  const fits = accepted(decode(withCallouts(1500)))
  const written = accepted(encodeDocument(InputDocument, fits))
  assert.ok(written.byteLength > 24 * 1024 * 1024, String(written.byteLength))
  assert.ok(written.byteLength <= Limits.MAX_INPUT_BYTES, String(written.byteLength))
  assert.deepEqual(accepted(decodeBytes(InputDocument, written)), fits)
})

test("input: line limits refuse a patch instead of truncating it", () => {
  accepted(decode(set(simpleReview(), file("patch"), "\n".repeat(Limits.MAX_PATCH_LINES))))
  refused(
    decode(set(simpleReview(), file("patch"), "\n".repeat(Limits.MAX_PATCH_LINES + 1))),
    /files\[0\]\.patch: exceeds 10000 lines; nothing was truncated/
  )
  refused(decode(set(simpleReview(), file("patch"), `${"\n".repeat(Limits.MAX_PATCH_LINES)}x`)), /exceeds 10000 lines/)
  const tooMany = withFiles(6, (index) => fileAt(`f${index}`, "\n".repeat(Limits.MAX_PATCH_LINES)))
  refused(decode(tooMany), /files\[5\]\.patch: patches exceed 50000 total lines; nothing was truncated/)
})

test("the input fixtures' hunk headers match their lines", () => {
  // test_fixtures_are_valid_and_consistent, for the inputs here.
  for (const name of ["worktree", "pull-request"]) {
    const input = accepted(decodeBytes(InputDocument, fixtureBytes(`input/${name}.json`)))
    for (const item of input.files) {
      if (item.patch === undefined) continue
      const lines = item.patch.replace(/\n$/, "").split("\n")
      const starts = [...lines.keys()].filter((index) => lines[index]?.startsWith("@@"))
      assert.equal(starts[0], 0, item.path)
      for (const [position, begin] of starts.entries()) {
        const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[begin] ?? "")
        assert.ok(header, item.path)
        const body = lines.slice(begin + 1, starts[position + 1] ?? lines.length)
        assert.equal(Number(header[1] ?? 1), body.filter((line) => /^[ -]/.test(line)).length, item.path)
        assert.equal(Number(header[2] ?? 1), body.filter((line) => /^[ +]/.test(line)).length, item.path)
      }
      if (item.patch_complete === true) {
        assert.equal(item.additions, lines.filter((line) => line.startsWith("+")).length, item.path)
        assert.equal(item.deletions, lines.filter((line) => line.startsWith("-")).length, item.path)
      }
    }
  }
})
