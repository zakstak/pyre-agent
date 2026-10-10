"use strict";
(() => {
  const contract = globalThis.PyreReviewFeedback;
  const metadata = JSON.parse(document.getElementById("review-data").dataset.review);
  const byId = id => document.getElementById(id);
  const cards = Array.from(document.querySelectorAll(".file-card"));
  const search = byId("search"), filter = byId("review-filter");
  const snapshot = { pr: metadata.pr, input_sha256: metadata.input_sha256 };
  const sources = new Map(metadata.files.map(file => {
    const card = byId(file.id);
    let offset = 0;
    const rows = Array.from(card.querySelectorAll(".diff tbody tr")).map(row => {
      const code = row.querySelector(".source code"), text = code.textContent;
      const item = { row, code, text, start: offset, end: offset + text.length };
      offset += text.length + 1; return item;
    });
    return [file.path, { ...file, card, rows, source: rows.map(row => row.text).join("\n") }];
  }));
  let dirty = false, comments = [], retained = [], selection = null, composerAnchor = null, editing = null, reattaching = null, deleted = null, importSequence = 0;
  const editedNotes = new Set(), editedFlags = new Set(); let editedGeneral = false;
  const pinned = Boolean(metadata.pr.url && metadata.pr.head_sha);

  function refresh() {
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0, reviewed = 0;
    for (const card of cards) {
      const checked = card.querySelector(".reviewed").checked;
      reviewed += Number(checked); card.classList.toggle("is-reviewed", checked);
      card.hidden = !card.dataset.search.toLocaleLowerCase().includes(query) || (filter.value === "reviewed" && !checked) || (filter.value === "remaining" && checked);
      shown += Number(!card.hidden);
    }
    for (const group of document.querySelectorAll(".review-group")) group.hidden = !Array.from(group.querySelectorAll(".file-card")).some(card => !card.hidden);
    byId("progress").textContent = `${reviewed} of ${cards.length} reviewed`;
    byId("filter-status").textContent = `${shown} of ${cards.length} files shown`;
    byId("no-results").hidden = shown > 0 || cards.length === 0;
  }
  function changed() {
    dirty = true;
    byId("export-status").textContent = "Changes are in this tab only. Export to save them.";
    byId("export-preview").hidden = true;
  }
  function currentFiles() {
    return metadata.files.map(file => {
      const card = byId(file.id);
      return { path: file.path, status: file.status, group: file.group, reviewed: card.querySelector(".reviewed").checked, notes: card.querySelector(".file-notes").value };
    });
  }
  function feedback() {
    return contract.validateFeedback({ feedback_schema_version: 2, ...snapshot, exported_at: new Date().toISOString(),
      general_notes: byId("general-notes").value, files: currentFiles(),
      comments: comments.map(comment => ({ ...comment, attachment: contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path)) })), retained_reviews: retained });
  }
  function samePR(other) {
    return metadata.pr.url && other.pr.url ? metadata.pr.url === other.pr.url : other.input_sha256 === metadata.input_sha256;
  }
  function makeAnchor(file, start, end) {
    const first = file.rows.find(row => start >= row.start && start <= row.end);
    const last = file.rows.find(row => end > row.start && end <= row.end);
    if (!first || !last || end <= start || end - start > 20000 || !file.source.slice(start, end).trim()) throw Error("Select 1–20,000 code characters within one file.");
    return { snapshot, path: file.path, patch_sha256: file.patch_sha256, start, end, quote: file.source.slice(start, end),
      prefix: file.source.slice(Math.max(0, start - 80), start).replace(/^[\uDC00-\uDFFF]/, ""), suffix: file.source.slice(end, end + 80).replace(/[\uD800-\uDBFF]$/, ""),
      start_row: Number(first.row.dataset.row), end_row: Number(last.row.dataset.row),
      old_line: first.row.dataset.old ? Number(first.row.dataset.old) : null, new_line: first.row.dataset.new ? Number(first.row.dataset.new) : null };
  }
  function selectedRange() {
    const value = window.getSelection();
    if (!pinned || !value || value.isCollapsed || value.rangeCount !== 1) return;
    const range = value.getRangeAt(0);
    const element = node => node.nodeType === 1 ? node : node.parentElement;
    const startCode = element(range.startContainer)?.closest(".source code"), endCode = element(range.endContainer)?.closest(".source code");
    if (!startCode || !endCode || startCode.closest(".file-card") !== endCode.closest(".file-card")) {
      selection = null; byId("comment-selection").disabled = true; byId("selection-status").textContent = "Select source text within one file, excluding line numbers and controls."; return;
    }
    const file = Array.from(sources.values()).find(item => item.card === startCode.closest(".file-card"));
    const offset = (code, node, position) => {
      const prefix = document.createRange(); prefix.selectNodeContents(code); prefix.setEnd(node, position); return prefix.toString().length;
    };
    try {
      const first = file.rows.find(row => row.code === startCode), last = file.rows.find(row => row.code === endCode);
      selection = makeAnchor(file, first.start + offset(startCode, range.startContainer, range.startOffset), last.start + offset(endCode, range.endContainer, range.endOffset));
      byId("comment-selection").disabled = false;
      byId("selection-status").textContent = `${selection.quote.length} code characters selected in ${file.path}.`;
    } catch (error) {
      selection = null; byId("comment-selection").disabled = true; byId("selection-status").textContent = error.message;
    }
  }
  function closeComposer() {
    byId("comment-composer").hidden = true; editing = null; reattaching = null; selection = null; composerAnchor = null;
    byId("comment-selection").disabled = true; byId("selection-status").textContent = pinned ? "No code text selected." : "Inline comments require a PR URL and pinned head commit in the input.";
  }
  function compose(anchor, comment = null, reattach = false) {
    composerAnchor = anchor; editing = comment && !reattach ? comment.id : null; reattaching = reattach ? comment.id : null;
    byId("comment-composer").hidden = false;
    byId("composer-heading").textContent = reattach ? "Reattach comment" : comment ? "Edit comment" : "New inline comment";
    byId("selected-quote").textContent = anchor.quote;
    byId("comment-body").value = comment?.body || "";
    byId("comment-body").focus();
  }
  function element(tag, className, content) {
    const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node;
  }
  function button(label, action) {
    const node = element("button", "", label); node.type = "button"; node.addEventListener("click", action); return node;
  }
  function showCode(comment, attachment) {
    const file = sources.get(comment.anchor.path);
    search.value = ""; filter.value = "all"; refresh();
    for (const detail of file.card.querySelectorAll(".file-details, .patch-details")) detail.open = true;
    const row = file.rows.find(item => attachment.start >= item.start && attachment.start <= item.end);
    row.row.querySelector(".comment-line").focus(); row.row.scrollIntoView({ block: "nearest" });
  }
  function drawComments() {
    const ranges = new Map();
    for (const file of sources.values()) { file.card.querySelector(".comment-list").replaceChildren(); file.card.querySelector(".comment-count").textContent = "(0)"; }
    byId("orphan-list").replaceChildren(); let orphans = 0;
    for (const comment of comments) {
      const attachment = contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path));
      const file = sources.get(comment.anchor.path), attached = attachment.state === "attached";
      const node = element("article", "inline-comment"); node.dataset.commentId = comment.id;
      node.append(element("p", "comment-location", `${comment.anchor.path} · original rows ${comment.anchor.start_row + 1}–${comment.anchor.end_row + 1} · head ${comment.anchor.snapshot.pr.head_sha || "unverified"}`),
        element("pre", "comment-quote", comment.anchor.quote), element("p", "comment-body", comment.body), element("p", "anchor-status", attachment.reason));
      const actions = element("div", "comment-actions");
      if (attached) {
        actions.append(button("Show highlighted code", () => showCode(comment, attachment)));
        if (!ranges.has(file.path)) ranges.set(file.path, []); ranges.get(file.path).push(attachment);
      } else {
        orphans++;
        actions.append(button("Attach to selected text", () => {
          if (!selection) { byId("comment-status").textContent = "Select the intended code text first, then choose Attach to selected text."; return; }
          compose(selection, comment, true);
        }));
      }
      actions.append(button("Edit comment", () => compose(comment.anchor, comment)), button("Delete comment", () => {
        deleted = comment; comments = comments.filter(item => item.id !== comment.id); byId("undo-delete").hidden = false;
        closeComposer(); drawComments(); changed(); byId("comment-status").textContent = "Comment deleted. Undo is available until another deletion or import.";
      }));
      node.append(actions);
      (attached ? file.card.querySelector(".comment-list") : byId("orphan-list")).append(node);
    }
    for (const file of sources.values()) {
      file.card.querySelector(".comment-count").textContent = `(${file.card.querySelector(".comment-list").childElementCount})`;
      // Rebuild from immutable original text, so overlapping marks never corrupt offsets.
      const endpoints = new Map();
      for (const range of ranges.get(file.path) || []) for (const row of file.rows) {
        const start = Math.max(range.start, row.start) - row.start, end = Math.min(range.end, row.end) - row.start;
        if (end > start) { if (!endpoints.has(row)) endpoints.set(row, []); endpoints.get(row).push([start, end]); }
      }
      for (const row of file.rows) {
        row.code.replaceChildren();
        const spans = endpoints.get(row) || [], points = [...new Set([0, row.text.length, ...spans.flat()])].sort((a, b) => a - b);
        for (let i = 1; i < points.length; i++) {
          const text = row.text.slice(points[i - 1], points[i]);
          row.code.append(spans.some(([start, end]) => start <= points[i - 1] && end >= points[i]) ? element("mark", "", text) : document.createTextNode(text));
        }
      }
    }
    byId("orphan-comments").hidden = orphans === 0;
    byId("retained-reviews").hidden = retained.length === 0;
    byId("retained-json").textContent = retained.length ? JSON.stringify(retained, null, 2) : "";
  }
  byId("save-comment").addEventListener("click", () => {
    const body = byId("comment-body").value;
    if (!body.trim()) { byId("comment-status").textContent = "Write a comment before saving."; return; }
    const now = new Date().toISOString(); const previous = comments.find(comment => comment.id === (editing || reattaching));
    const next = previous ? { ...previous, body, updated_at: now, anchor: reattaching ? composerAnchor : previous.anchor,
      history: reattaching ? [...previous.history, previous.anchor] : previous.history } : { id: crypto.randomUUID(), body, created_at: now, updated_at: now, anchor: composerAnchor, history: [] };
    const candidate = previous ? comments.map(comment => comment.id === previous.id ? next : comment) : [...comments, next];
    const before = comments; comments = candidate;
    try { feedback(); } catch (error) { comments = before; byId("comment-status").textContent = error.message; return; }
    closeComposer(); drawComments(); changed(); byId("comment-status").textContent = "Comment saved in this tab. Export feedback to keep it.";
  });
  byId("cancel-comment").addEventListener("click", closeComposer);
  byId("comment-selection").addEventListener("click", () => { if (selection) compose(selection); });
  byId("undo-delete").addEventListener("click", () => {
    if (!deleted) return;
    if (comments.length >= 1000) { byId("comment-status").textContent = "Comment limit reached; export before adding more."; return; }
    const before = comments; comments = [...comments, deleted];
    try { feedback(); } catch (error) { comments = before; byId("comment-status").textContent = `Cannot undo: ${error.message}`; return; }
    deleted = null; byId("undo-delete").hidden = true; drawComments(); changed();
  });
  document.addEventListener("selectionchange", selectedRange);
  for (const file of sources.values()) for (const row of file.rows) {
    const control = row.row.querySelector(".comment-line"); control.disabled = !pinned || !row.text.trim();
    control.addEventListener("click", () => {
      try { compose(makeAnchor(file, row.start, row.end)); } catch (error) { byId("comment-status").textContent = error.message; }
    });
  }
  search.addEventListener("input", refresh); filter.addEventListener("change", refresh);
  for (const card of cards) {
    card.querySelector(".reviewed").addEventListener("change", () => { editedFlags.add(card.id); changed(); refresh(); });
    const notes = card.querySelector(".file-notes");
    notes.addEventListener("input", () => { editedNotes.add(card.id); card.querySelector(".note-indicator").textContent = notes.value ? " · has notes" : ""; changed(); });
  }
  byId("general-notes").addEventListener("input", () => { editedGeneral = true; changed(); });
  for (const [id, open] of [["expand-all", true], ["collapse-all", false]]) byId(id).addEventListener("click", () => {
    for (const card of cards.filter(card => !card.hidden)) for (const detail of card.querySelectorAll(".file-details, .patch-details")) detail.open = open;
  });
  byId("export-feedback").addEventListener("click", () => {
    let output;
    try { output = JSON.stringify(feedback(), null, 2) + "\n"; if (new Blob([output]).size > contract.MAX_BYTES) throw Error("Feedback exceeds the 8 MiB save/import limit."); }
    catch (error) { byId("export-status").textContent = error.message; return; }
    byId("feedback-json").value = output; const preview = byId("export-preview"); preview.hidden = false;
    try {
      const url = URL.createObjectURL(new Blob([output], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `pr-review-feedback-${metadata.input_sha256.slice(0, 12)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      byId("export-status").textContent = "Download requested. Confirm it saved, then hand the JSON to your agent. It can be imported here later. A copy is available below.";
    } catch (_) { preview.open = true; byId("export-status").textContent = "Download unavailable. Copy the JSON below to save your feedback."; }
    // A requested download does not prove a successful durable save; keep the unload guard.
  });
  byId("import-feedback").addEventListener("change", async event => {
    const token = ++importSequence, file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      if (file.size > contract.MAX_BYTES) throw Error("Feedback exceeds 8 MiB.");
      const incoming = contract.parseFeedback(await file.text()); if (token !== importSequence) return;
      if (!samePR(incoming) || incoming.comments.some(comment => !samePR(comment.anchor.snapshot) || comment.history.some(anchor => !samePR(anchor.snapshot))) || incoming.retained_reviews.some(review => !samePR(review))) throw Error("Feedback belongs to another PR or an unidentified snapshot.");
      if (!byId("comment-composer").hidden && byId("comment-body").value) throw Error("Finish or cancel the open comment draft before importing.");
      const same = incoming.input_sha256 === metadata.input_sha256;
      if (same && (incoming.files.length !== metadata.files.length || incoming.files.some(file => !sources.has(file.path)))) throw Error("Feedback inventory does not match this snapshot.");
      const incomingComments = incoming.comments.map(({ attachment: _, ...comment }) => comment);
      const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
      const comparable = value => JSON.stringify(normalized(value));
      for (const comment of incomingComments) {
        const local = comments.find(item => item.id === comment.id);
        if (local && comparable(local) !== comparable(comment)) throw Error("Conflicting comment ID. Open review preserved; export it before restoring into a fresh page.");
      }
      const localFiles = currentFiles();
      if (same && (localFiles.some(local => {
        const saved = incoming.files.find(file => file.path === local.path);
        const id = sources.get(local.path).id;
        return ((editedNotes.has(id) || local.notes) && local.notes !== saved.notes) || (editedFlags.has(id) && local.reviewed !== saved.reviewed);
      }) || ((editedGeneral || byId("general-notes").value) && byId("general-notes").value !== incoming.general_notes))) throw Error("Conflicting notes or review flags. Open review preserved; export it before restoring into a fresh page.");
      const nextRetained = retained.slice();
      const earlier = incoming.retained_reviews.slice();
      if (!same) earlier.push({ pr: incoming.pr, input_sha256: incoming.input_sha256, general_notes: incoming.general_notes, files: incoming.files });
      for (const review of earlier) {
        const local = nextRetained.find(item => item.input_sha256 === review.input_sha256);
        if (local && comparable(local) !== comparable(review)) throw Error("Conflicting retained snapshot. Open review preserved.");
        if (!local) nextRetained.push(review);
      }
      const nextComments = comments.concat(incomingComments.filter(comment => !comments.some(local => local.id === comment.id)));
      const nextFiles = same ? incoming.files : localFiles;
      const nextGeneral = same ? incoming.general_notes : byId("general-notes").value;
      contract.validateFeedback({ feedback_schema_version: 2, ...snapshot, exported_at: new Date().toISOString(), general_notes: nextGeneral, files: nextFiles,
        comments: nextComments.map(comment => ({ ...comment, attachment: contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path)) })), retained_reviews: nextRetained });
      const hadLocal = dirty || comments.length || retained.length;
      comments = nextComments; retained = nextRetained;
      if (same) {
        for (const saved of incoming.files) {
          const card = sources.get(saved.path).card; card.querySelector(".file-notes").value = saved.notes; card.querySelector(".reviewed").checked = saved.reviewed;
          card.querySelector(".note-indicator").textContent = saved.notes ? " · has notes" : "";
        }
        byId("general-notes").value = incoming.general_notes;
      }
      deleted = null; byId("undo-delete").hidden = true; closeComposer(); drawComments(); refresh();
      dirty = Boolean(hadLocal || !same); byId("export-preview").hidden = true;
      byId("import-status").textContent = `Imported ${incoming.comments.length} comments. ${comments.filter(comment => contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path)).state === "orphan").length} unattached. ${same ? "Snapshot notes restored." : "Earlier notes and flags preserved separately; current review flags were not carried forward."}`;
      byId("export-status").textContent = dirty ? "Export the combined feedback to save this state." : "Saved snapshot restored from your local file.";
    } catch (error) { if (token === importSequence) byId("import-status").textContent = `Import rejected: ${error.message} Existing feedback was not changed.`; }
  });
  window.addEventListener("beforeunload", event => { if (dirty || (!byId("comment-composer").hidden && byId("comment-body").value)) { event.preventDefault(); event.returnValue = ""; } });
  closeComposer(); drawComments(); refresh();
})();
