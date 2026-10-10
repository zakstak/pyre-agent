/* Offline feedback contract and conservative anchor matching. No DOM, storage or network. */
"use strict";
(() => {
  const VERSION = 3;
  const MAX_BYTES = 8 * 1024 * 1024;
  const HASH = /^[a-f0-9]{64}$/;
  const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
  const PR = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/;
  const ROOT = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+)/;
  const statuses = new Set(["added", "modified", "deleted", "removed", "renamed", "copied", "changed", "unchanged"]);
  function object(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected an object.");
    const keys = Object.keys(value);
    if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) throw Error("Missing or unsupported feedback fields.");
  }
  function text(value, limit = 20000, nonempty = false) {
    if (typeof value !== "string" || value.length > limit || (nonempty && !value.trim())) throw Error("Invalid or oversized feedback text.");
    for (let i = 0; i < value.length; i++) {
      const n = value.charCodeAt(i);
      if ((n < 32 && ![9, 10, 13].includes(n)) || (n >= 0xDC00 && n <= 0xDFFF)) throw Error("Unsupported text character.");
      if (n >= 0xD800 && n <= 0xDBFF) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) throw Error("Unpaired Unicode surrogate.");
      }
    }
  }
  function integer(value, max = 50000000, min = 0) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error("Invalid feedback position.");
  }
  // Mirrors the renderer's target validation: a GitHub PR, or a working tree that is always pinned.
  function target(value) {
    if (!value || typeof value !== "object" || !["github_pr", "worktree"].includes(value.kind)) throw Error("Invalid review target.");
    if (value.kind === "github_pr") {
      object(value, ["kind", "title"], ["url", "head_sha", "base_sha", "changed_files"]);
      if (Object.hasOwn(value, "url") && (typeof value.url !== "string" || !PR.test(value.url))) throw Error("Invalid PR identity.");
    } else {
      object(value, ["kind", "title", "root", "head_sha"], ["branch", "changed_files"]);
      text(value.root, 4096, true);
      if (!ROOT.test(value.root)) throw Error("Invalid working tree root.");
      if (Object.hasOwn(value, "branch")) text(value.branch, 1024, true);
    }
    text(value.title, 20000, true);
    for (const key of ["head_sha", "base_sha"]) if (Object.hasOwn(value, key) && (typeof value[key] !== "string" || !SHA.test(value[key]))) throw Error("Invalid commit snapshot.");
    if (Object.hasOwn(value, "changed_files")) integer(value.changed_files, 10 ** 12);
  }
  const pinned = value => value.kind === "worktree" || Boolean(value.url && value.head_sha);
  function snapshot(value) {
    object(value, ["target", "input_sha256"]);
    target(value.target);
    if (typeof value.input_sha256 !== "string" || !HASH.test(value.input_sha256)) throw Error("Invalid input digest.");
  }
  function files(value) {
    if (!Array.isArray(value) || value.length > 2000) throw Error("Invalid feedback file inventory.");
    const paths = new Set();
    for (const file of value) {
      object(file, ["path", "status", "group", "notes"]);
      text(file.path, 4096, true); text(file.notes);
      if (paths.has(file.path) || !statuses.has(file.status) || !["core", "wiring", "mechanical"].includes(file.group)) throw Error("Invalid or duplicate feedback file.");
      paths.add(file.path);
    }
  }
  function approvals(value) {
    if (!Array.isArray(value) || value.length > 2000) throw Error("Invalid approval list.");
    const paths = new Set();
    for (const approval of value) {
      object(approval, ["path", "fingerprint", "approved_at"]);
      text(approval.path, 4096, true); text(approval.approved_at, 40, true);
      if (typeof approval.fingerprint !== "string" || !HASH.test(approval.fingerprint) || paths.has(approval.path)) throw Error("Invalid or duplicate approval.");
      paths.add(approval.path);
    }
  }
  function anchor(value) {
    object(value, ["snapshot", "path", "patch_sha256", "start", "end", "quote", "prefix", "suffix", "start_row", "end_row", "side", "start_line", "end_line"]);
    snapshot(value.snapshot);
    if (!pinned(value.snapshot.target)) throw Error("Comments require a pinned target: a PR URL and head commit, or a working tree.");
    text(value.path, 4096, true);
    if (typeof value.patch_sha256 !== "string" || !HASH.test(value.patch_sha256)) throw Error("Invalid patch digest.");
    integer(value.start); integer(value.end); integer(value.start_row, 10000); integer(value.end_row, 10000);
    text(value.quote, 20000, true); text(value.prefix, 80); text(value.suffix, 80);
    if (value.end <= value.start || value.end - value.start !== value.quote.length || value.end_row < value.start_row) throw Error("Invalid quote range.");
    if (!["old", "new"].includes(value.side)) throw Error("Invalid anchor side.");
    integer(value.start_line, 10 ** 12, 1); integer(value.end_line, 10 ** 12, 1);
    if (value.end_line < value.start_line) throw Error("Invalid source line range.");
  }
  // A reviewer's answer to the agent. Agent replies live in the review input, so each file keeps one writer.
  function replies(value, ids) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw Error("Invalid reviewer replies.");
    let total = 0;
    for (const reply of value) {
      object(reply, ["id", "actor", "created_at", "body", "action"]);
      if (typeof reply.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(reply.id) || ids.has(reply.id)) throw Error("Invalid or duplicate reply ID.");
      ids.add(reply.id);
      if (reply.actor !== "reviewer") throw Error("Feedback replies come from the reviewer; agent replies belong in the review input.");
      if (!["accept", "reopen", "reply"].includes(reply.action)) throw Error("Invalid reply action.");
      text(reply.created_at, 40, true);
      // Reply times order a thread, so both languages must parse them alike: UTC, with optional milliseconds.
      // The round trip rejects impossible dates such as February 31, which Date.parse would roll into March.
      const time = Date.parse(reply.created_at);
      // Python's datetime starts at year 1, so year 0000 is refused here too.
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(reply.created_at) || reply.created_at.startsWith("0000") || Number.isNaN(time)
        || new Date(time).toISOString().slice(0, 19) !== reply.created_at.slice(0, 19)) throw Error("Reply times must be UTC ISO 8601, such as 2026-10-10T09:00:00.000Z.");
      text(reply.body, 20000, reply.action !== "accept");
      total += reply.body.length;
    }
    return total;
  }
  function attachment(value) {
    object(value, ["state", "reason", "start", "end"]);
    if (!["attached", "orphan"].includes(value.state)) throw Error("Invalid attachment state.");
    text(value.reason, 200);
    if (value.state === "attached") { integer(value.start); integer(value.end); if (value.end <= value.start) throw Error("Invalid attachment range."); }
    else if (value.start !== null || value.end !== null) throw Error("Orphan range must be null.");
  }
  function validateFeedback(value) {
    if (value && typeof value === "object" && !Array.isArray(value) && value.feedback_schema_version !== VERSION) throw Error(`Feedback version ${JSON.stringify(value.feedback_schema_version ?? null)} is not supported; expected ${VERSION}. There is no migration.`);
    object(value, ["feedback_schema_version", "target", "input_sha256", "exported_at", "general_notes", "files", "approvals", "comments", "retained_reviews"]);
    snapshot(reviewSnapshot(value));
    text(value.exported_at, 40, true); text(value.general_notes); files(value.files); approvals(value.approvals);
    if (!Array.isArray(value.comments) || value.comments.length > 1000 || !Array.isArray(value.retained_reviews) || value.retained_reviews.length > 50) throw Error("Feedback collection limit exceeded.");
    const ids = new Set(), replyIds = new Set(); let total = value.general_notes.length;
    for (const file of value.files) total += file.notes.length;
    for (const comment of value.comments) {
      object(comment, ["id", "body", "created_at", "updated_at", "anchor", "history", "attachment"], ["replies"]);
      if (typeof comment.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(comment.id) || ids.has(comment.id)) throw Error("Invalid or duplicate comment ID.");
      ids.add(comment.id); text(comment.body, 20000, true); text(comment.created_at, 40, true); text(comment.updated_at, 40, true); anchor(comment.anchor); attachment(comment.attachment);
      if (!Array.isArray(comment.history) || comment.history.length > 20) throw Error("Comment anchor history limit exceeded.");
      for (const previous of comment.history) { anchor(previous); total += previous.quote.length + previous.path.length; }
      if (Object.hasOwn(comment, "replies")) total += replies(comment.replies, replyIds);
      total += comment.body.length + comment.anchor.quote.length + comment.anchor.path.length;
    }
    const retained = new Set();
    for (const review of value.retained_reviews) {
      object(review, ["target", "input_sha256", "general_notes", "files"]);
      snapshot(reviewSnapshot(review)); text(review.general_notes); files(review.files);
      if (retained.has(review.input_sha256)) throw Error("Duplicate retained snapshot.");
      retained.add(review.input_sha256); total += review.general_notes.length;
      for (const file of review.files) total += file.notes.length;
    }
    if (total > 2 * 1024 * 1024) throw Error("Feedback text budget exceeded.");
    return value;
  }
  const reviewSnapshot = review => ({ target: review.target, input_sha256: review.input_sha256 });
  // Two snapshots belong to one review when they name the same PR, or the same working tree root.
  function sameTarget(a, b) {
    if (a.target.kind !== b.target.kind) return false;
    if (a.target.kind === "worktree") return a.target.root === b.target.root;
    return a.target.url && b.target.url ? a.target.url === b.target.url : a.input_sha256 === b.input_sha256;
  }
  // JSON.parse checks syntax first. A bounded token walk additionally rejects duplicate keys and non-integer numbers,
  // which JSON.parse would silently turn into integers such as 7 for 7.0.
  function parseFeedback(raw) {
    if (typeof raw !== "string" || (raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES)) throw Error("Feedback exceeds 8 MiB.");
    const value = JSON.parse(raw);
    const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
    let i = 0;
    function walk(depth) {
      if (depth > 32) throw Error("Feedback is nested too deeply.");
      const token = tokens[i++];
      if (token === "{") {
        const keys = new Set();
        if (tokens[i] === "}") { i++; return; }
        while (true) {
          const key = JSON.parse(tokens[i++]);
          if (keys.has(key)) throw Error("Duplicate JSON field.");
          keys.add(key); i++; walk(depth + 1);
          if (tokens[i++] === "}") break;
        }
      } else if (token === "[") {
        if (tokens[i] === "]") { i++; return; }
        while (true) { walk(depth + 1); if (tokens[i++] === "]") break; }
      } else if (/^-?\d/.test(token) && /[.eE]/.test(token)) throw Error("Feedback numbers must be integers.");
    }
    walk(0);
    return validateFeedback(value);
  }
  function resolveAnchor(value, file) {
    const orphan = reason => ({ state: "orphan", reason, start: null, end: null });
    if (!file || file.path !== value.path || !file.patch_sha256) return orphan("File or patch is absent in this snapshot.");
    const source = file.source;
    if (file.patch_sha256 === value.patch_sha256 && source.slice(value.start, value.end) === value.quote) return { state: "attached", reason: "Exact patch and range.", start: value.start, end: value.end };
    let match = -1, count = 0, position = 0;
    while ((position = source.indexOf(value.quote, position)) !== -1) {
      const end = position + value.quote.length;
      if (source.slice(Math.max(0, position - value.prefix.length), position) === value.prefix && source.slice(end, end + value.suffix.length) === value.suffix) {
        match = position; if (++count > 1) return orphan("Quote and context match more than once.");
      }
      position++;
    }
    if (!count) return orphan("Selected text or its context changed.");
    return { state: "attached", reason: "Unique quote and context in revised patch.", start: match, end: match + value.quote.length };
  }
  const api = Object.freeze({ VERSION, MAX_BYTES, parseFeedback, validateFeedback, resolveAnchor, reviewSnapshot, sameTarget, pinned });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.PyreReviewFeedback = api;
})();
