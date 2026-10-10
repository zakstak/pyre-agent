"use strict";
(() => {
  const contract = globalThis.PyreReviewFeedback;
  const metadata = JSON.parse(document.getElementById("review-data").dataset.review);
  const byId = id => document.getElementById(id);
  const cards = Array.from(document.querySelectorAll(".file-card"));
  const search = byId("search"), filter = byId("review-filter");
  const composer = byId("comment-composer"), floating = byId("comment-selection"), toast = byId("toast");
  const snapshot = { target: metadata.target, input_sha256: metadata.input_sha256 };
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
  const byCard = new Map(Array.from(sources.values(), file => [file.card, file]));
  const nav = new Map(Array.from(document.querySelectorAll(".file-nav li[data-file]"), item => [item.dataset.file, item]));
  let dirty = false, comments = [], retained = [], approvals = new Map(), selection = null, composerAnchor = null, editing = null, reattaching = null, deleted = null, importSequence = 0;
  let composerRow = null, composerReturn = null, composerFallback = null, toastTimer = 0, orphanCount = 0, lastFocus = null, replyDraft = null;
  const editedNotes = new Set(), editedApprovals = new Set(); let editedGeneral = false;
  const pinned = contract.pinned(metadata.target);
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  function element(tag, className, content) {
    const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node;
  }
  function button(label, action, className = "quiet", name = "") {
    const node = element("button", className, label); node.type = "button"; if (name) node.setAttribute("aria-label", name); node.addEventListener("click", action); return node;
  }
  // A pending Undo stays until it is used, dismissed, or replaced by another deletion or an import.
  function announce(message) {
    clearTimeout(toastTimer);
    const leaving = !message && toast.contains(document.activeElement);
    byId("comment-status").textContent = message; byId("undo-delete").hidden = !deleted || !message; byId("toast-dismiss").hidden = !message;
    if (leaving) (lastFocus?.isConnected && lastFocus.checkVisibility() ? lastFocus : byId("files")).focus({ preventScroll: true });
    if (message && !deleted) toastTimer = setTimeout(() => announce(""), 6000);
  }
  function setExpanded(card, open) {
    card.querySelector(".file-toggle").setAttribute("aria-expanded", String(open));
    card.querySelector(".file-body").hidden = !open; card.classList.toggle("is-collapsed", !open);
  }
  function reveal(card) {
    if (card.hidden) { search.value = ""; filter.value = "all"; refresh(); }
    setExpanded(card, true);
    const diff = card.querySelector(".patch-details"); if (diff) diff.open = true;
  }
  // An approval covers one exact file version. A stored approval for another version means the file changed since.
  function approvalState(file) {
    const record = approvals.get(file.path);
    return !record ? "none" : file.fingerprint && record.fingerprint === file.fingerprint ? "approved" : "changed";
  }
  // Threads: agent replies come from the review input and reviewer replies from feedback, so each file keeps one writer.
  // A thread's state is never stored; it follows the last reply.
  const agentReplies = new Map();
  for (const reply of metadata.replies) {
    if (!agentReplies.has(reply.comment_id)) agentReplies.set(reply.comment_id, []);
    agentReplies.get(reply.comment_id).push(reply);
  }
  const DISPOSITION = { fixed: "Fixed", rejected: "Rejected", deferred: "Deferred", question: "Question" };
  const ACTION = { accept: "Accepted", reopen: "Reopened", reply: "Replied" };
  const when = reply => { const time = Date.parse(reply.created_at); return Number.isNaN(time) ? Infinity : time; };
  function thread(comment) {
    return [...(agentReplies.get(comment.id) || []), ...(comment.replies || [])]
      .sort((a, b) => when(a) - when(b) || (a.actor === b.actor ? 0 : a.actor === "agent" ? -1 : 1) || (a.id < b.id ? -1 : 1));
  }
  function threadState(replies) {
    const last = replies[replies.length - 1];
    if (!last) return { label: "Open", yours: false };
    if (last.actor === "agent") return { label: `Answered: ${DISPOSITION[last.disposition].toLowerCase()}`, yours: true };
    return { label: last.action === "accept" ? "Resolved" : ACTION[last.action], yours: false };
  }
  function summarize() {
    const approved = cards.filter(card => approvalState(byCard.get(card)) === "approved").length;
    const notes = cards.filter(card => card.querySelector(".file-notes").value).length;
    const answered = comments.filter(comment => threadState(thread(comment)).yours).length;
    byId("review-summary").textContent = [`${approved} of ${plural(cards.length, "file")} approved`,
      plural(comments.length, "comment") + (orphanCount ? `, ${orphanCount} unattached` : "") + (answered ? `, ${answered} answered by the agent` : ""),
      plural(notes, "file note")].join(" · ");
  }
  // Feedback persistence sits behind one boundary with two implementations: a file the reviewer exports and imports,
  // or the local review server, which saves automatically. Only a page the server served carries its session token.
  function fileStore() {
    let exported = false;
    const show = () => {
      const chip = byId("save-state");
      chip.hidden = !dirty; chip.className = exported ? "chip" : "chip warning"; chip.textContent = exported ? "Exported" : "Not exported";
    };
    return {
      start: show,
      changed() { exported = false; byId("export-status").textContent = "Changes are in this tab only. Export to save them."; show(); },
      draftChanged() { if (exported) { exported = false; show(); } },
      exported(draft) { exported = !draft; show(); },
      merged() { exported = false; show(); byId("export-status").textContent = dirty ? "Export the combined feedback to save this state." : "Saved snapshot restored from your local file."; },
      // A requested download does not prove a durable save, so any change keeps the unload warning.
      unsaved: () => dirty,
    };
  }
  function serverStore(token, round) {
    const chip = byId("save-state");
    let revision = "none", ready = false, timer = 0, saving = null, again = false, paused = "";
    const show = (text, warning = false) => { chip.hidden = false; chip.className = warning ? "chip warning" : "chip"; chip.textContent = text; };
    const call = (path, options = {}) => fetch(path, { ...options, cache: "no-store", credentials: "same-origin", headers: { "X-Review-Token": token, ...options.headers } })
      .then(async response => ({ status: response.status, reply: await response.json().catch(() => ({})) }));
    function notify(message, reload) {
      byId("server-notice-text").textContent = message; byId("server-reload").hidden = !reload; byId("server-notice").hidden = false;
    }
    function pause(message) { paused = message; show("Not saved", true); notify(message, true); }
    function save() {
      clearTimeout(timer); timer = 0;
      if (paused || !ready) return Promise.resolve();
      if (saving) { again = true; return saving; }
      let body;
      try { body = JSON.stringify(feedback()); } catch (error) { show("Not saved", true); byId("export-status").textContent = error.message; return Promise.resolve(); }
      saving = call("/feedback", { method: "PUT", body, headers: { "Content-Type": "application/json", "X-Review-Revision": revision } }).then(({ status, reply }) => {
        if (status === 200) {
          revision = reply.revision; show(draftOpen() ? "Saved, except the open draft" : "Saved");
          byId("export-status").textContent = "Saved to the agent's review folder. When you finish, tell your agent.";
        } else if (status === 409) pause(`${reply.error} Changes made in this tab since its last save are not saved; export them first to keep them.`);
        else { show("Not saved", true); byId("export-status").textContent = `Save rejected: ${reply.error || `HTTP ${status}`}. Export your feedback to keep it.`; }
      }, () => { show("Not saved", true); byId("export-status").textContent = "The review server is unreachable. Export your feedback to keep it."; })
        .finally(() => { saving = null; if (again) { again = false; save(); } });
      return saving;
    }
    // A newer round is offered, never loaded on its own, so an open draft or unsaved change is not lost.
    function poll() {
      call("/round").then(({ status, reply }) => {
        if (status === 200 && reply.round !== round) notify(`Round ${reply.round} is ready. Reload to review it; your saved feedback carries over.`, true);
        else if (status === 200) setTimeout(poll, 3000);
        else notify(`The review server refused to answer: ${reply.error || `HTTP ${status}`}`, false);
      }, () => notify("The review server stopped. Export your feedback to keep changes you make from now on.", false));
    }
    byId("server-reload").addEventListener("click", async () => {
      await save(); while (saving) await saving;
      location.reload();
    });
    return {
      async start() {
        byId("saving-file").hidden = true; byId("saving-server").hidden = false; show("Loading");
        const { status, reply } = await call("/feedback").catch(() => ({ status: 0, reply: {} }));
        if (status !== 200) { show("Not saved", true); paused = reply.error || "The review server did not return the saved feedback."; notify(`${paused} Saving is paused so nothing is overwritten.`, false); return; }
        revision = reply.revision;
        let carried = false;
        if (reply.feedback) {
          try {
            const result = mergeFeedback(contract.validateFeedback(reply.feedback));
            byId("import-status").textContent = `Loaded saved feedback: ${result.summary}`;
            carried = !result.same;
          } catch (error) { show("Not saved", true); paused = error.message; notify(`The saved feedback could not be loaded: ${error.message} Saving is paused so nothing is overwritten.`, false); return; }
        }
        ready = true; show("Saved");
        byId("export-status").textContent = "Feedback saves automatically to the agent's review folder. When you finish, tell your agent.";
        // Feedback from an earlier round is saved again against this snapshot, with its notes kept separately.
        if (carried || again) { again = false; save(); }
        poll();
      },
      changed() {
        if (!ready) { again = true; return; }
        if (!paused) show("Saving");
        clearTimeout(timer); timer = setTimeout(save, 500);
      },
      draftChanged() {},
      exported() {},
      merged() { this.changed(); },
      unsaved: () => Boolean(timer || saving || again || (paused && dirty)),
    };
  }
  const session = document.querySelector('meta[name="review-canvas-token"]');
  const persistence = location.protocol === "http:" && session
    ? serverStore(session.content, Number(document.querySelector('meta[name="review-canvas-round"]').content)) : fileStore();
  function refresh() {
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0, approved = 0;
    for (const card of cards) {
      const state = approvalState(byCard.get(card)), checked = state === "approved";
      card.querySelector(".approved").checked = checked; card.querySelector(".approval-changed").hidden = state !== "changed";
      approved += Number(checked); card.classList.toggle("is-approved", checked);
      card.hidden = !card.dataset.search.toLocaleLowerCase().includes(query) || (filter.value === "approved" && !checked) || (filter.value === "remaining" && checked);
      shown += Number(!card.hidden);
      const item = nav.get(card.id);
      if (item) {
        item.hidden = card.hidden; item.classList.toggle("is-approved", checked); item.classList.toggle("is-changed", state === "changed");
        item.querySelector(".nav-state").textContent = checked ? ", approved" : state === "changed" ? ", changed since approval" : "";
      }
    }
    for (const group of document.querySelectorAll(".review-group, .nav-group")) group.hidden = !Array.from(group.querySelectorAll(".file-card, li[data-file]")).some(item => !item.hidden);
    byId("progress").textContent = `${approved} of ${cards.length} approved`;
    document.querySelector(".progress").style.setProperty("--progress", `${cards.length ? approved / cards.length * 100 : 0}%`);
    byId("filter-status").textContent = `${shown} of ${cards.length} files shown`;
    byId("no-results").hidden = shown > 0 || cards.length === 0;
    summarize();
  }
  function changed() {
    dirty = true; byId("export-preview").hidden = true; persistence.changed(); summarize();
  }
  function currentFiles() {
    return metadata.files.map(file => {
      const card = byId(file.id);
      return { path: file.path, status: file.status, group: file.group, notes: card.querySelector(".file-notes").value };
    });
  }
  // Approvals for files outside this snapshot stay, so a file that returns unchanged is still approved. Past the limit, the oldest of those go first.
  function approvalList(map = approvals) {
    let list = [...map.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (list.length > 2000) {
      const drop = new Set(list.filter(record => !sources.has(record.path)).sort((a, b) => a.approved_at < b.approved_at ? -1 : 1).slice(0, list.length - 2000).map(record => record.path));
      list = list.filter(record => !drop.has(record.path));
    }
    return list;
  }
  function feedback() {
    return contract.validateFeedback({ feedback_schema_version: contract.VERSION, ...snapshot, exported_at: new Date().toISOString(),
      general_notes: byId("general-notes").value, files: currentFiles(), approvals: approvalList(),
      comments: comments.map(comment => ({ ...comment, attachment: contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path)) })), retained_reviews: retained });
  }
  const sameTarget = other => contract.sameTarget(snapshot, other);
  function makeAnchor(file, start, end) {
    const first = file.rows.find(row => start >= row.start && start <= row.end);
    const last = file.rows.find(row => end > row.start && end <= row.end);
    if (!first || !last || end <= start || end - start > 20000 || !file.source.slice(start, end).trim()) throw Error("Select 1–20,000 code characters within one file.");
    // A comment names one side. Deleted lines, alone or with context, are old-side; anything that reaches the new file is new-side.
    const rows = file.rows.slice(file.rows.indexOf(first), file.rows.indexOf(last) + 1).map(row => row.row.dataset);
    const oldOnly = rows.some(row => row.kind === "deletion") && !rows.some(row => row.kind === "addition");
    let side = oldOnly ? "old" : "new", lines = rows.filter(row => row[side]).map(row => Number(row[side]));
    if (!lines.length && side === "new") { side = "old"; lines = rows.filter(row => row.old).map(row => Number(row.old)); }
    if (!lines.length) throw Error("Select code lines, not diff headers.");
    return { snapshot, path: file.path, patch_sha256: file.patch_sha256, start, end, quote: file.source.slice(start, end),
      prefix: file.source.slice(Math.max(0, start - 80), start).replace(/^[\uDC00-\uDFFF]/, ""), suffix: file.source.slice(end, end + 80).replace(/[\uD800-\uDBFF]$/, ""),
      start_row: Number(first.row.dataset.row), end_row: Number(last.row.dataset.row), side, start_line: lines[0], end_line: lines[lines.length - 1] };
  }
  function rowAt(file, offset) {
    return file.rows.find(row => offset > row.start && offset <= row.end) || file.rows.find(row => offset >= row.start && offset <= row.end) || file.rows[file.rows.length - 1];
  }
  // New-side numbers when a row has one; deleted rows say "old" so a range never mixes sides silently.
  function linesLabel(file, start, end) {
    const lines = file.rows.filter(row => end > row.start && start <= row.end && (row.row.dataset.new || row.row.dataset.old))
      .map(row => row.row.dataset.new ? { old: false, number: row.row.dataset.new } : { old: true, number: row.row.dataset.old });
    if (!lines.length) return "Diff header";
    const first = lines[0], last = lines[lines.length - 1], name = (line, plural) => `${line.old ? "Old line" : "Line"}${plural ? "s" : ""}`;
    if (first.old === last.old && first.number === last.number) return `${name(first)} ${first.number}`;
    if (first.old === last.old) return `${name(first, true)} ${first.number}–${last.number}`;
    return `${name(first)} ${first.number} to ${name(last).toLowerCase()} ${last.number}`;
  }
  function originLabel(anchor) {
    return `originally ${anchor.side === "old" ? "old line" : "line"} ${anchor.start_line}`;
  }

  // Selection: snap a browser selection to the code rows of one file, then offer a floating button.
  function hideFloating() { floating.hidden = true; floating.disabled = true; }
  function showFloating(range) {
    const rects = range.getClientRects(), rect = rects[rects.length - 1] || range.getBoundingClientRect(), gap = 8;
    floating.hidden = false; floating.disabled = false;
    const width = floating.offsetWidth, height = floating.offsetHeight, topbar = document.querySelector(".topbar").getBoundingClientRect().bottom;
    const below = matchMedia("(pointer: coarse)").matches || rect.top - height - gap < Math.max(topbar, 0);
    const left = Math.min(Math.max(rect.right - width / 2, gap), document.documentElement.clientWidth - width - gap);
    floating.style.left = `${left + scrollX}px`;
    floating.style.top = `${(below ? rect.bottom + gap : rect.top - height - gap) + scrollY}px`;
  }
  // Rows are in document order, so two binary searches find the rows a range touches without scanning a 10,000-line diff.
  function rowsInRange(file, range) {
    const rows = file.rows; let low = 0, high = rows.length;
    while (low < high) { const mid = (low + high) >> 1; if (range.comparePoint(rows[mid].code, rows[mid].code.childNodes.length) < 0) low = mid + 1; else high = mid; }
    const first = low; high = rows.length;
    while (low < high) { const mid = (low + high) >> 1; if (range.comparePoint(rows[mid].code, 0) > 0) high = mid; else low = mid + 1; }
    return rows.slice(first, low);
  }
  function selectedRange() {
    const value = getSelection();
    if (!pinned || !value || value.rangeCount !== 1 || value.isCollapsed || document.activeElement?.matches("textarea, input")) { hideFloating(); return; }
    const range = value.getRangeAt(0), touched = [];
    for (const card of cards) if (range.intersectsNode(card)) { const inside = rowsInRange(byCard.get(card), range); if (inside.length) touched.push([card, inside]); }
    if (touched.length !== 1) {
      selection = null; hideFloating();
      if (touched.length > 1) byId("selection-status").textContent = "Select code within one file.";
      return;
    }
    const [[card, inside]] = touched, file = byCard.get(card), offset = (code, node, position) => {
      const prefix = document.createRange(); prefix.selectNodeContents(code); prefix.setEnd(node, position); return prefix.toString().length;
    };
    let first = inside[0], last = inside[inside.length - 1];
    let start = first.code.contains(range.startContainer) ? offset(first.code, range.startContainer, range.startOffset) : 0;
    let end = last.code.contains(range.endContainer) ? offset(last.code, range.endContainer, range.endOffset) : last.text.length;
    // A triple-click or drag can end at the start of the next line. Keep only the rows the reader chose.
    if (end === 0 && inside.length > 1) { last = inside[inside.length - 2]; end = last.text.length; }
    if (start === first.text.length && inside.length > 1 && first !== last) { first = inside[1]; start = 0; }
    try {
      selection = makeAnchor(file, first.start + start, last.start + end);
      byId("selection-status").textContent = `${selection.quote.length} code characters selected in ${file.path}.`;
      showFloating(range);
    } catch (error) {
      selection = null; hideFloating(); byId("selection-status").textContent = error.message;
    }
  }

  // Composer: opens under the selected rows, or beside the unattached comment it edits.
  function panelRow(className) {
    const row = element("tr", className), cell = element("td"), panel = element("div", "row-panel");
    cell.colSpan = 4; cell.append(panel); row.append(cell); return row;
  }
  function parkComposer() {
    composer.hidden = true; byId("composer-home").append(composer); composerRow?.remove(); composerRow = null;
    for (const node of document.querySelectorAll(".inline-comment[hidden]")) node.hidden = false;
  }
  function closeComposer(restoreFocus = false) {
    const fallback = composerFallback;
    parkComposer(); editing = null; reattaching = null; selection = null; composerAnchor = null; composerFallback = null; hideFloating();
    byId("selection-status").textContent = pinned ? "No code text selected." : "Inline comments are off.";
    if (restoreFocus) (composerReturn?.isConnected && composerReturn.checkVisibility() ? composerReturn : fallback?.())?.focus();
    composerReturn = null;
  }
  function draftOpen() { return !composer.hidden && byId("comment-body").value.trim() !== ""; }
  function revealComposer() {
    const card = composer.closest(".file-card"); if (card) reveal(card);
    composer.scrollIntoView({ block: "nearest" }); byId("comment-body").focus({ preventScroll: true });
  }
  function compose(anchor, comment = null, reattach = false) {
    // Never discard a draft silently, even one hidden by a collapsed file or a filter.
    if (draftOpen()) { revealComposer(); announce("Finish or cancel the open comment first."); return; }
    const trigger = document.activeElement;
    parkComposer();
    composerAnchor = anchor; editing = comment && !reattach ? comment.id : null; reattaching = reattach ? comment.id : null;
    // The floating button disappears once the composer opens, so focus returns to the line's + button instead.
    composerReturn = trigger instanceof HTMLElement && trigger !== document.body && trigger !== floating ? trigger : null;
    const file = sources.get(anchor.path);
    const attachment = editing ? contract.resolveAnchor(comment.anchor, file) : { state: "attached", start: anchor.start, end: anchor.end };
    byId("composer-heading").textContent = reattach ? "Reattach comment" : comment ? "Edit comment" : "New comment";
    byId("selected-quote").textContent = anchor.quote;
    if (attachment.state === "attached") {
      reveal(file.card);
      const row = rowAt(file, attachment.end).row;
      byId("composer-context").textContent = `${file.path} · ${linesLabel(file, attachment.start, attachment.end)}`;
      composerRow = panelRow("composer-row"); composerRow.querySelector(".row-panel").append(composer);
      (row.nextElementSibling?.classList.contains("thread-row") ? row.nextElementSibling : row).after(composerRow);
      composerFallback = () => row.querySelector(".comment-line:not(:disabled)") || file.card.querySelector(".diff-scroll");
    } else {
      byId("composer-context").textContent = `${anchor.path} · ${originLabel(anchor)}`;
      byId("orphan-list").after(composer);
      composerFallback = () => document.querySelector(`.inline-comment[data-comment-id="${CSS.escape(comment.id)}"]`);
    }
    for (const node of document.querySelectorAll(".inline-comment")) node.hidden = node.dataset.commentId === editing;
    composer.hidden = false; hideFloating();
    byId("comment-body").value = comment?.body || "";
    byId("comment-body").focus({ preventScroll: true }); composer.scrollIntoView({ block: "nearest" });
  }
  function commentNode(comment, attachment, file) {
    const attached = attachment.state === "attached";
    const node = element("article", "inline-comment"); node.dataset.commentId = comment.id; node.tabIndex = -1; node.hidden = comment.id === editing;
    const head = element("div", "comment-head"), actions = element("div", "comment-actions");
    head.append(element("span", "comment-author", "Your comment"),
      element("span", "comment-location", attached ? linesLabel(file, attachment.start, attachment.end) : `${comment.anchor.path} · ${originLabel(comment.anchor)}`));
    // Working tree rounds often share a HEAD, so an earlier snapshot is named by round when the commit matches.
    const origin = comment.anchor.snapshot;
    if (origin.input_sha256 !== metadata.input_sha256) head.append(element("span", "chip", origin.target.head_sha !== metadata.target.head_sha ? `From ${origin.target.head_sha.slice(0, 7)}` : "From an earlier round"));
    if (!attached) actions.append(button("Attach to selected text", () => {
      if (!selection) { announce("Select the intended code first, then choose Attach to selected text."); return; }
      compose(selection, comment, true);
    }));
    actions.append(button("Edit", () => compose(comment.anchor, comment), "quiet", "Edit comment"), button("Delete", () => removeComment(comment), "quiet", "Delete comment"));
    head.append(actions);
    const lines = comment.anchor.quote.split("\n");
    node.append(head, attached ? element("pre", "comment-quote is-inline", lines[0] + (lines.length > 1 ? " …" : "")) : element("pre", "comment-quote", comment.anchor.quote),
      element("p", "comment-body", comment.body));
    if (attachment.reason !== "Exact patch and range.") node.append(element("p", "anchor-status", attachment.reason));
    const replies = thread(comment), state = threadState(replies), last = replies[replies.length - 1];
    head.insertBefore(element("span", state.yours ? "chip warning thread-state" : "chip thread-state", state.label), actions);
    if (!replies.length) return node;
    const list = element("div", "thread-replies");
    list.append(...replies.map(reply => replyNode(reply)));
    const choices = element("div", "reply-actions");
    if (last.actor === "agent") choices.append(button("Accept", () => addReply(comment, "accept", ""), "quiet", "Accept the agent's answer"));
    if (last.actor === "agent" || last.action === "accept") choices.append(button("Reopen", () => openReply(comment, "reopen"), "quiet", "Reopen comment"));
    choices.append(button("Reply", () => openReply(comment, "reply"), "quiet", "Reply to the agent"));
    node.append(list, replyDraft?.commentId === comment.id ? replyComposer(comment) : choices);
    return node;
  }
  function replyNode(reply) {
    const node = element("div", `reply reply-${reply.actor}`), head = element("div", "comment-head");
    head.append(element("span", "comment-author", reply.actor === "agent" ? "Agent" : "You"),
      element("span", "chip", reply.actor === "agent" ? DISPOSITION[reply.disposition] : ACTION[reply.action]));
    node.append(head);
    if (reply.body) node.append(element("p", "comment-body", reply.body));
    if (reply.fixed_in?.commit) node.append(element("p", "anchor-status", `Fixed in commit ${reply.fixed_in.commit.slice(0, 7)}.`));
    if (reply.fixed_in?.fingerprint) {
      const fixed = metadata.files.find(file => file.fingerprint === reply.fixed_in.fingerprint);
      node.append(element("p", "anchor-status", fixed ? `Fixed in this round's version of ${fixed.path}.` : `Fixed in file version ${reply.fixed_in.fingerprint.slice(0, 12)}, which is not in this round.`));
    }
    if (reply.blocker) node.append(element("p", "anchor-status", `Blocker: ${reply.blocker}`));
    return node;
  }
  function openReply(comment, action) {
    replyDraft = { commentId: comment.id, action, body: replyDraft?.commentId === comment.id ? replyDraft.body : "" };
    drawComments(); byId(`reply-${comment.id}`)?.focus();
  }
  function replyComposer(comment) {
    const form = element("div", "reply-composer"), label = element("label", "", replyDraft.action === "reopen" ? "Why reopen?" : "Reply to the agent");
    const area = element("textarea"); area.id = `reply-${comment.id}`; label.htmlFor = area.id; area.rows = 3; area.maxLength = 20000; area.spellcheck = false; area.value = replyDraft.body;
    const save = () => addReply(comment, replyDraft.action, area.value), cancel = () => { replyDraft = null; drawComments(); jumpTo(comment.id); };
    area.addEventListener("input", () => { replyDraft.body = area.value; });
    area.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    const buttons = element("div", "composer-actions");
    buttons.append(button("Cancel", cancel, "quiet", "Cancel reply"), button(replyDraft.action === "reopen" ? "Reopen comment" : "Save reply", save, "primary"));
    form.append(label, area, buttons);
    return form;
  }
  function addReply(comment, action, body) {
    if (action !== "accept" && !body.trim()) { announce("Write a reply before saving."); return; }
    // A new reply always sorts last, even when the agent's clock ran ahead of this one.
    const latest = Math.max(Date.now(), ...thread(comment).map(when).filter(Number.isFinite).map(time => time + 1));
    const reply = { id: crypto.randomUUID(), actor: "reviewer", created_at: new Date(latest).toISOString(), body: action === "accept" ? body.trim() : body, action };
    const before = comments;
    comments = comments.map(item => item.id === comment.id ? { ...item, replies: [...(item.replies || []), reply] } : item);
    try { feedback(); } catch (error) { comments = before; announce(error.message); return; }
    replyDraft = null; drawComments(); changed();
    announce(action === "accept" ? "Answer accepted." : action === "reopen" ? "Comment reopened." : "Reply saved.");
    jumpTo(comment.id);
  }
  function jumpTo(id) {
    if (id === editing) { revealComposer(); return; }
    const find = () => document.querySelector(`.inline-comment[data-comment-id="${CSS.escape(id)}"]`);
    const card = find()?.closest(".file-card"); if (card) reveal(card);
    const node = find(); if (!node) return;
    node.scrollIntoView({ block: "center" }); node.focus({ preventScroll: true });
  }
  function drawComments() {
    const ranges = new Map(), threads = new Map(), counts = new Map(), index = [];
    for (const row of document.querySelectorAll(".thread-row")) row.remove();
    byId("orphan-list").replaceChildren(); byId("comment-index").replaceChildren(); orphanCount = 0;
    for (const comment of comments) {
      const file = sources.get(comment.anchor.path), attachment = contract.resolveAnchor(comment.anchor, file), attached = attachment.state === "attached";
      const node = commentNode(comment, attachment, file);
      if (attached) {
        if (!ranges.has(file.path)) ranges.set(file.path, []); ranges.get(file.path).push(attachment);
        const row = rowAt(file, attachment.end).row;
        if (!threads.has(row)) threads.set(row, []); threads.get(row).push(node);
        counts.set(file.path, (counts.get(file.path) || 0) + 1);
      } else { orphanCount++; byId("orphan-list").append(node); }
      const jump = button("", () => jumpTo(comment.id), "quiet comment-jump"), item = element("li"), state = threadState(thread(comment));
      jump.append(element("span", "jump-where", `${comment.anchor.path} · ${attached ? linesLabel(file, attachment.start, attachment.end) : "unattached"}`),
        element("span", "jump-text", comment.body.split("\n")[0]), element("span", state.yours ? "chip warning" : "chip", state.label));
      item.append(jump); index.push([attached ? cards.indexOf(file.card) : cards.length, attached ? attachment.start : 0, item]);
    }
    // List comments in reading order: file order on the page, then position in the diff.
    byId("comment-index").append(...index.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(entry => entry[2]));
    for (const [row, nodes] of threads) { const thread = panelRow("thread-row"); thread.querySelector(".row-panel").append(...nodes); row.after(thread); }
    for (const file of sources.values()) {
      const count = counts.get(file.path) || 0, chip = file.card.querySelector(".comment-count"), navCount = nav.get(file.id)?.querySelector(".nav-count");
      chip.hidden = !count; chip.textContent = plural(count, "comment");
      if (navCount) { navCount.hidden = !count; navCount.textContent = plural(count, "comment"); }
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
    const loaded = new Set(comments.map(comment => comment.id)), waiting = [...agentReplies.keys()].filter(id => !loaded.has(id)).length;
    byId("unmatched-replies").hidden = !waiting;
    byId("unmatched-replies").textContent = waiting ? `The agent answered ${plural(waiting, "comment")} that this page has not loaded. Import the feedback that holds them to see the answers.` : "";
    byId("orphan-comments").hidden = orphanCount === 0;
    byId("orphan-heading").textContent = `Unattached comments (${orphanCount})`;
    byId("retained-reviews").hidden = retained.length === 0;
    byId("retained-json").textContent = retained.length ? JSON.stringify(retained, null, 2) : "";
    summarize();
  }
  function removeComment(comment) {
    const card = sources.get(comment.anchor.path)?.card;
    deleted = comment; comments = comments.filter(item => item.id !== comment.id);
    if (editing === comment.id || reattaching === comment.id) closeComposer();
    drawComments(); changed();
    lastFocus = card && !card.hidden ? card.querySelector(".file-toggle") : byId("files");
    announce("Comment deleted."); byId("undo-delete").focus();
  }

  byId("save-comment").addEventListener("click", () => {
    const body = byId("comment-body").value;
    if (!body.trim()) { announce("Write a comment before saving."); return; }
    const now = new Date().toISOString(); const previous = comments.find(comment => comment.id === (editing || reattaching));
    const next = previous ? { ...previous, body, updated_at: now, anchor: reattaching ? composerAnchor : previous.anchor,
      history: reattaching ? [...previous.history, previous.anchor] : previous.history } : { id: crypto.randomUUID(), body, created_at: now, updated_at: now, anchor: composerAnchor, history: [] };
    const candidate = previous ? comments.map(comment => comment.id === previous.id ? next : comment) : [...comments, next];
    const before = comments; comments = candidate;
    try { feedback(); } catch (error) { comments = before; announce(error.message); return; }
    closeComposer(); drawComments(); changed(); announce("Comment saved in this tab. Export feedback to keep it.");
    document.querySelector(`.inline-comment[data-comment-id="${CSS.escape(next.id)}"]`)?.focus({ preventScroll: true });
  });
  byId("cancel-comment").addEventListener("click", () => closeComposer(true));
  byId("comment-body").addEventListener("input", () => persistence.draftChanged());
  composer.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); closeComposer(true); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); byId("save-comment").click(); }
  });
  // Keep the text selection alive while the floating button is pressed.
  floating.addEventListener("mousedown", event => event.preventDefault());
  floating.addEventListener("click", () => { if (selection) compose(selection); });
  byId("undo-delete").addEventListener("click", () => {
    if (!deleted) return;
    if (comments.length >= 1000) { announce("Comment limit reached; export before adding more."); return; }
    const before = comments, restored = deleted; comments = [...comments, deleted];
    try { feedback(); } catch (error) { comments = before; announce(`Cannot undo: ${error.message}`); return; }
    deleted = null; drawComments(); changed(); announce("Comment restored."); jumpTo(restored.id);
  });
  byId("toast-dismiss").addEventListener("click", () => { deleted = null; announce(""); });
  document.addEventListener("focusin", event => { if (!toast.contains(event.target)) lastFocus = event.target; });
  document.addEventListener("selectionchange", selectedRange);
  addEventListener("resize", hideFloating);
  for (const file of sources.values()) for (const row of file.rows) {
    const control = row.row.querySelector(".comment-line"); if (!control) continue;
    control.disabled = !pinned || !row.text.trim();
    control.addEventListener("click", () => {
      try { compose(makeAnchor(file, row.start, row.end)); } catch (error) { announce(error.message); }
    });
  }
  search.addEventListener("input", refresh); filter.addEventListener("change", refresh);
  for (const card of cards) {
    card.querySelector(".file-toggle").addEventListener("click", () => setExpanded(card, card.querySelector(".file-body").hidden));
    if (card.dataset.group === "mechanical") setExpanded(card, false);
    card.querySelector(".approved").addEventListener("change", event => {
      const file = byCard.get(card);
      if (event.target.checked) approvals.set(file.path, { path: file.path, fingerprint: file.fingerprint, approved_at: new Date().toISOString() });
      else approvals.delete(file.path);
      editedApprovals.add(file.path); changed();
      // Collapse an approved file, unless that would hide an open comment draft.
      if (composer.hidden || !card.contains(composer)) setExpanded(card, !event.target.checked);
      refresh();
      if (event.target.checked && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
    });
    const notes = card.querySelector(".file-notes");
    notes.addEventListener("input", () => { editedNotes.add(card.id); card.querySelector(".note-indicator").textContent = notes.value ? " · has notes" : ""; changed(); });
  }
  byId("general-notes").addEventListener("input", () => { editedGeneral = true; changed(); });
  for (const [id, open] of [["expand-all", true], ["collapse-all", false]]) byId(id).addEventListener("click", () => {
    for (const card of cards.filter(card => !card.hidden)) {
      setExpanded(card, open); const diff = card.querySelector(".patch-details"); if (diff) diff.open = open;
    }
  });
  byId("export-feedback").addEventListener("click", () => {
    let output;
    try { output = JSON.stringify(feedback(), null, 2) + "\n"; if (new Blob([output]).size > contract.MAX_BYTES) throw Error("Feedback exceeds the 8 MiB save/import limit."); }
    catch (error) { byId("export-status").textContent = error.message; return; }
    byId("feedback-json").value = output; const preview = byId("export-preview"); preview.hidden = false;
    try {
      const url = URL.createObjectURL(new Blob([output], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `review-feedback-${metadata.input_sha256.slice(0, 12)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      const draft = draftOpen();
      byId("export-status").textContent = draft
        ? "Download requested, without the open comment draft. Save or cancel the draft, then export again."
        : "Download requested. Confirm it saved, then hand the JSON to your agent. It can be imported here later. A copy is available below.";
      persistence.exported(draft);
    } catch (_) { preview.open = true; byId("export-status").textContent = "Download unavailable. Copy the JSON below to save your feedback."; }
    // A requested download does not prove a successful durable save; keep the unload guard.
  });
  // Merge validated feedback into the page: an imported file, or what the server saved earlier. Every check runs before
  // anything changes, so a conflict or another review's file leaves the open review as it was.
  function mergeFeedback(incoming) {
    if (!sameTarget(incoming) || incoming.comments.some(comment => !sameTarget(comment.anchor.snapshot) || comment.history.some(anchor => !sameTarget(anchor.snapshot))) || incoming.retained_reviews.some(review => !sameTarget(review))) throw Error("Feedback belongs to another review target or an unidentified snapshot.");
    if (!composer.hidden && byId("comment-body").value) { revealComposer(); throw Error("Finish or cancel the open comment draft before importing."); }
    const same = incoming.input_sha256 === metadata.input_sha256;
    if (same && (incoming.files.length !== metadata.files.length || incoming.files.some(file => !sources.has(file.path)))) throw Error("Feedback inventory does not match this snapshot.");
    const incomingComments = incoming.comments.map(({ attachment: _, ...comment }) => comment);
    const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
    const comparable = value => JSON.stringify(normalized(value));
    // Reviewer replies merge by ID, so two copies of one comment differ only in replies the other has not seen yet.
    const withoutReplies = ({ replies: _, ...comment }) => comment;
    for (const comment of incomingComments) {
      const local = comments.find(item => item.id === comment.id);
      if (local && comparable(withoutReplies(local)) !== comparable(withoutReplies(comment))) throw Error("Conflicting comment ID. Open review preserved; export it before restoring into a fresh page.");
      for (const reply of comment.replies || []) {
        const mine = local?.replies?.find(item => item.id === reply.id);
        if (mine && comparable(mine) !== comparable(reply)) throw Error("Conflicting reply ID. Open review preserved; export it before restoring into a fresh page.");
      }
    }
    const localFiles = currentFiles();
    if (same && (localFiles.some(local => {
      const saved = incoming.files.find(file => file.path === local.path);
      return (editedNotes.has(sources.get(local.path).id) || local.notes) && local.notes !== saved.notes;
    }) || ((editedGeneral || byId("general-notes").value) && byId("general-notes").value !== incoming.general_notes))) throw Error("Conflicting notes. Open review preserved; export it before restoring into a fresh page.");
    // Approvals merge by path. Keep the one for the current version, or else the newer one. An approval made in this
    // tab stays; one cleared in this tab is never restored silently.
    const nextApprovals = new Map(approvals);
    for (const record of incoming.approvals) {
      const local = approvals.get(record.path), current = sources.get(record.path)?.fingerprint;
      if (editedApprovals.has(record.path)) {
        if (!local) throw Error("Conflicting approval. Open review preserved; export it before restoring into a fresh page.");
      } else if (!local || ((record.fingerprint === current) !== (local.fingerprint === current) ? record.fingerprint === current : record.approved_at > local.approved_at)) {
        nextApprovals.set(record.path, record);
      }
    }
    const nextRetained = retained.slice();
    const earlier = incoming.retained_reviews.slice();
    if (!same) earlier.push({ target: incoming.target, input_sha256: incoming.input_sha256, general_notes: incoming.general_notes, files: incoming.files });
    for (const review of earlier) {
      const local = nextRetained.find(item => item.input_sha256 === review.input_sha256);
      if (local && comparable(local) !== comparable(review)) throw Error("Conflicting retained snapshot. Open review preserved.");
      if (!local) nextRetained.push(review);
    }
    const nextComments = comments.map(local => {
      const incomingReplies = incomingComments.find(comment => comment.id === local.id)?.replies || [];
      const added = incomingReplies.filter(reply => !local.replies?.some(item => item.id === reply.id));
      return added.length ? { ...local, replies: [...(local.replies || []), ...added] } : local;
    }).concat(incomingComments.filter(comment => !comments.some(local => local.id === comment.id)));
    const nextFiles = same ? incoming.files : localFiles;
    const nextGeneral = same ? incoming.general_notes : byId("general-notes").value;
    contract.validateFeedback({ feedback_schema_version: contract.VERSION, ...snapshot, exported_at: new Date().toISOString(), general_notes: nextGeneral, files: nextFiles, approvals: approvalList(nextApprovals),
      comments: nextComments.map(comment => ({ ...comment, attachment: contract.resolveAnchor(comment.anchor, sources.get(comment.anchor.path)) })), retained_reviews: nextRetained });
    const hadLocal = dirty || comments.length || retained.length || approvals.size;
    comments = nextComments; retained = nextRetained; approvals = nextApprovals;
    if (same) {
      for (const saved of incoming.files) {
        const card = sources.get(saved.path).card; card.querySelector(".file-notes").value = saved.notes;
        card.querySelector(".note-indicator").textContent = saved.notes ? " · has notes" : "";
      }
      byId("general-notes").value = incoming.general_notes;
    }
    deleted = null; announce(""); closeComposer(); drawComments(); refresh();
    dirty = Boolean(hadLocal || !same); byId("export-preview").hidden = true;
    const states = metadata.files.map(approvalState), approvedCount = states.filter(state => state === "approved").length, changedCount = states.filter(state => state === "changed").length;
    return { same, summary: `${plural(incoming.comments.length, "comment")}. ${orphanCount} unattached. ${approvedCount} of ${plural(cards.length, "file")} approved, ${changedCount} changed since approval. ${same ? "Snapshot notes restored." : "Notes from the earlier snapshot are kept separately."}` };
  }
  byId("import-feedback").addEventListener("change", async event => {
    const token = ++importSequence, file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      if (file.size > contract.MAX_BYTES) throw Error("Feedback exceeds 8 MiB.");
      const incoming = contract.parseFeedback(await file.text()); if (token !== importSequence) return;
      byId("import-status").textContent = `Imported ${mergeFeedback(incoming).summary}`;
      persistence.merged();
    } catch (error) { if (token === importSequence) byId("import-status").textContent = `Import rejected: ${error.message} Existing feedback was not changed.`; }
  });
  window.addEventListener("beforeunload", event => { if (persistence.unsaved() || (!composer.hidden && byId("comment-body").value) || replyDraft?.body.trim()) { event.preventDefault(); event.returnValue = ""; } });

  // Keep sticky offsets in step with the app bar, which wraps at large text sizes.
  const topbar = document.querySelector(".topbar");
  new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-height", `${topbar.offsetHeight}px`)).observe(topbar);
  if (nav.size) {
    const visible = new Set();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target);
      const current = cards.find(card => visible.has(card));
      for (const [id, item] of nav) {
        const link = item.querySelector("a");
        if (current?.id === id) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
      }
    }, { rootMargin: "-15% 0px -70% 0px" });
    for (const card of cards) observer.observe(card);
  }
  byId("selection-status").textContent = pinned ? "No code text selected." : "Inline comments are off.";
  closeComposer(); drawComments(); refresh(); persistence.start();
})();
