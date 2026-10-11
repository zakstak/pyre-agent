import * as Schema from "effect/Schema"
import * as Limits from "./limits.ts"

/**
 * Plain text of at most `maxUnits` UTF-16 code units, with no refused control character or unpaired surrogate.
 * HTML and Markdown in it are never interpreted.
 */
export const text = (maxUnits: number) =>
  Schema.String.check(
    Schema.makeFilter((value: string) => value.length <= maxUnits || `exceeds ${maxUnits} UTF-16 code units`),
    Schema.makeFilter((value: string) =>
      !Limits.REFUSED_CONTROL_CHARACTERS.test(value) || "contains a control character other than tab, LF, or CR"
    ),
    Schema.makeFilter((value: string) => value.isWellFormed() || "contains an unpaired Unicode surrogate")
  )

/** {@link text} that holds more than JavaScript whitespace, which `String.prototype.trim` removes. */
export const nonEmptyText = (maxUnits: number) =>
  text(maxUnits).check(Schema.makeFilter((value: string) => value.trim() !== "" || "must not be empty"))

/** An integer from `minimum` through `maximum`, both within the safe integer range. */
export const integer = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }))

/** A line count or declared file count. */
export const Count = integer(0, Limits.MAX_COUNT)

const pattern = (regExp: RegExp, expected: string) => Schema.String.check(Schema.isPattern(regExp, { expected }))

const LocalId = pattern(
  new RegExp(`^[A-Za-z0-9_-]{1,${Limits.MAX_ID_LENGTH}}$`),
  `1 to ${Limits.MAX_ID_LENGTH} letters, digits, hyphens, or underscores`
)
/** A comment's ID, unique in its review. */
export const CommentId = LocalId.pipe(Schema.brand("CommentId"))
export type CommentId = typeof CommentId.Type
/** A reply's ID, unique in its review across reviewer replies, agent answers, and replies imported from GitHub. */
export const ReplyId = LocalId.pipe(Schema.brand("ReplyId"))
export type ReplyId = typeof ReplyId.Type
/** An agent thread's ID, which the server assigns when the thread registers. */
export const ThreadId = LocalId.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type
/** A review's ID. A target can have several reviews: the open one, and earlier ones that a fresh start closed. */
export const ReviewId = LocalId.pipe(Schema.brand("ReviewId"))
export type ReviewId = typeof ReviewId.Type

/** The host's own ID for an agent session, such as a Claude Code session ID. */
export const HostSessionId = nonEmptyText(Limits.MAX_LABEL_UNITS).pipe(Schema.brand("HostSessionId"))
export type HostSessionId = typeof HostSessionId.Type

/** The secret a thread presents with each request: 32 random bytes in unpadded base64url. */
export const ThreadToken = pattern(/^[A-Za-z0-9_-]{43}$/, "a 43-character thread token").pipe(
  Schema.brand("ThreadToken")
)
export type ThreadToken = typeof ThreadToken.Type

const Sha256 = pattern(/^[a-f0-9]{64}$/, "64 lowercase hexadecimal characters")
/**
 * One exact version of the change to one file: SHA-256 over its path, original path, old and new blob IDs, and old
 * and new modes. An approval holds while the file's fingerprint still matches.
 */
export const Fingerprint = Sha256.pipe(Schema.brand("Fingerprint"))
export type Fingerprint = typeof Fingerprint.Type
/** The SHA-256 of a round's input, which identifies that snapshot. */
export const InputDigest = Sha256.pipe(Schema.brand("InputDigest"))
export type InputDigest = typeof InputDigest.Type
/** The SHA-256 of one file's patch, so an anchor attaches at once to the same patch. */
export const PatchDigest = Sha256.pipe(Schema.brand("PatchDigest"))
export type PatchDigest = typeof PatchDigest.Type

/** A full commit hash: 40 hexadecimal characters for SHA-1, 64 for SHA-256. */
export const CommitSha = pattern(
  /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
  "a full 40- or 64-character hexadecimal commit hash"
).pipe(Schema.brand("CommitSha"))
export type CommitSha = typeof CommitSha.Type

/** A six-digit octal Git mode, such as 100644. */
export const GitMode = pattern(/^[0-7]{6}$/, "a six-digit octal Git mode such as 100644").pipe(Schema.brand("GitMode"))
export type GitMode = typeof GitMode.Type

/** The review's change counter. Each action raises it by one, and carries the revision it saw. */
export const Revision = integer(0, Number.MAX_SAFE_INTEGER).pipe(Schema.brand("Revision"))
export type Revision = typeof Revision.Type
/** A round's number in its review, from 1. */
export const RoundNumber = integer(1, Number.MAX_SAFE_INTEGER).pipe(Schema.brand("RoundNumber"))
export type RoundNumber = typeof RoundNumber.Type

const UTC_TIME = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/
/**
 * A UTC time exactly as `Date.prototype.toISOString` writes it, from year 1 through 9999. One spelling per moment
 * means times compare as strings. The round trip refuses dates JavaScript would roll over, such as February 31 or
 * 24:00:00.
 */
export const Timestamp = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const time = UTC_TIME.test(value) ? Date.parse(value) : Number.NaN
    return (Number.isFinite(time) && new Date(time).toISOString() === value) ||
      "expected a UTC time with milliseconds, such as 2026-10-10T09:00:00.000Z"
  })
).pipe(Schema.brand("Timestamp"))
export type Timestamp = typeof Timestamp.Type

/**
 * An exact repository-relative path, as Git names it: segments joined by single slashes, with no empty, `.`, or `..`
 * segment and no leading or trailing slash. The collector writes Git's names as they are, so a name may hold spaces,
 * backslashes, tabs, line breaks, or a byte order mark, and may be only those: it is plain text, not trimmed. A name
 * that is not UTF-8 or holds another control character, NUL included, has no representation, and the collector
 * refuses it.
 */
export const RepoPath = text(Limits.MAX_PATH_UNITS).check(
  Schema.makeFilter((value: string) =>
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") ||
    "expected a repository-relative path with no empty, . or .. segment and no leading or trailing slash"
  )
).pipe(Schema.brand("RepoPath"))
export type RepoPath = typeof RepoPath.Type

/**
 * A working tree's absolute POSIX path, as `git rev-parse --show-toplevel` prints it: no empty, `.`, or `..`
 * segment and no trailing slash. Reviews of a working tree are keyed by it, so one tree has one spelling.
 */
export const WorktreeRoot = text(Limits.MAX_PATH_UNITS).check(
  Schema.makeFilter((value: string) => {
    const segments = value.slice(1).split("/")
    return value === "/" ||
      (value.startsWith("/") && segments.every((part) => part !== "" && part !== "." && part !== "..")) ||
      "expected an absolute path with no empty, . or .. segment and no trailing slash"
  })
).pipe(Schema.brand("WorktreeRoot"))
export type WorktreeRoot = typeof WorktreeRoot.Type

const GITHUB_REPO = "https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*"
/** A pull request on github.com, which also names its review. */
export const PullRequestUrl = text(Limits.MAX_TEXT_UNITS).check(
  Schema.isPattern(new RegExp(`^${GITHUB_REPO}$`), { expected: "https://github.com/OWNER/REPO/pull/NUMBER" })
).pipe(Schema.brand("PullRequestUrl"))
export type PullRequestUrl = typeof PullRequestUrl.Type

/** A comment on a pull request: a review comment, a conversation comment, or a review summary. */
export const GitHubCommentUrl = text(Limits.MAX_TEXT_UNITS).check(
  Schema.isPattern(new RegExp(`^${GITHUB_REPO}#(?:discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]*$`), {
    expected: "a pull request comment URL, such as https://github.com/OWNER/REPO/pull/1#discussion_r2"
  })
).pipe(Schema.brand("GitHubCommentUrl"))
export type GitHubCommentUrl = typeof GitHubCommentUrl.Type

/**
 * A GitHub GraphQL node ID, such as PRRC_kwDOA1b2c3: unique across comment types, so a refresh imports each comment
 * once. Older IDs are base64.
 */
export const GitHubCommentId = pattern(/^[A-Za-z0-9_=+/-]{1,200}$/, "a GitHub node ID").pipe(
  Schema.brand("GitHubCommentId")
)
export type GitHubCommentId = typeof GitHubCommentId.Type

/** A GitHub login. Apps post as their name with a [bot] suffix. */
export const GitHubLogin = pattern(/^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/, "a GitHub login").pipe(
  Schema.brand("GitHubLogin")
)
export type GitHubLogin = typeof GitHubLogin.Type
