"use strict";
(() => {
  // Input becomes text or JSON only. Never HTML, script, a URL, or executable code.
  const metadata = JSON.parse(document.getElementById("review-data").dataset.review);
  const cards = Array.from(document.querySelectorAll(".file-card"));
  const search = document.getElementById("search");
  const filter = document.getElementById("review-filter");
  let dirty = false;

  function refresh() {
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    let reviewed = 0;
    for (const card of cards) {
      const checked = card.querySelector(".reviewed").checked;
      reviewed += Number(checked);
      card.classList.toggle("is-reviewed", checked);
      card.hidden = !card.dataset.search.toLocaleLowerCase().includes(query)
        || (filter.value === "reviewed" && !checked)
        || (filter.value === "remaining" && checked);
      shown += Number(!card.hidden);
    }
    for (const group of document.querySelectorAll(".review-group")) {
      group.hidden = !Array.from(group.querySelectorAll(".file-card")).some(card => !card.hidden);
    }
    document.getElementById("progress").textContent = `${reviewed} of ${cards.length} reviewed`;
    document.getElementById("filter-status").textContent = `${shown} of ${cards.length} files shown`;
    document.getElementById("no-results").hidden = shown > 0 || cards.length === 0;
  }

  function changed() {
    dirty = true;
    document.getElementById("export-status").textContent = "Changes are in this tab only. Export to save them.";
    // A prior export preview is a snapshot, not a live saved version.
    document.getElementById("export-preview").hidden = true;
  }

  search.addEventListener("input", refresh);
  filter.addEventListener("change", refresh);
  for (const card of cards) {
    card.querySelector(".reviewed").addEventListener("change", () => {
      changed();
      refresh();
    });
    const notes = card.querySelector(".file-notes");
    notes.addEventListener("input", () => {
      card.querySelector(".note-indicator").textContent = notes.value ? " · has notes" : "";
      changed();
    });
  }
  document.getElementById("general-notes").addEventListener("input", changed);
  for (const [id, open] of [["expand-all", true], ["collapse-all", false]]) {
    document.getElementById(id).addEventListener("click", () => {
      for (const card of cards.filter(card => !card.hidden)) {
        for (const detail of card.querySelectorAll(".file-details, .patch-details")) detail.open = open;
      }
    });
  }

  document.getElementById("export-feedback").addEventListener("click", () => {
    const feedback = {
      feedback_schema_version: 1,
      pr: metadata.pr,
      input_sha256: metadata.input_sha256,
      exported_at: new Date().toISOString(),
      general_notes: document.getElementById("general-notes").value,
      files: metadata.files.map(file => {
        const card = document.getElementById(file.id);
        return {
          path: file.path,
          status: file.status,
          group: file.group,
          reviewed: card.querySelector(".reviewed").checked,
          notes: card.querySelector(".file-notes").value,
        };
      }),
    };
    const output = JSON.stringify(feedback, null, 2) + "\n";
    document.getElementById("feedback-json").value = output;
    const preview = document.getElementById("export-preview");
    preview.hidden = false;
    try {
      const blob = new Blob([output], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pr-review-feedback-${metadata.input_sha256.slice(0, 12)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.getElementById("export-status").textContent = "Download requested. Confirm it saved, then send the JSON file to your agent. You can also copy the export below.";
      // A download request is not proof the user saved it. Keep the unload guard.
    } catch (_) {
      preview.open = true;
      document.getElementById("export-status").textContent = "Download unavailable. Copy the JSON below to save your feedback.";
    }
  });

  window.addEventListener("beforeunload", event => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  refresh();
})();
