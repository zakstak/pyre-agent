/**
 * Dependency-free interaction logic tests: node tests/browser_review.unit.cjs
 * Executes the production JS against a deliberately small DOM test double.
 * This supplements, and does not replace, browser_review.cjs or visual QA.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../skills/pr-review-canvas/assets/review.js"), "utf8");

class Element {
  constructor() {
    this.dataset = {};
    this.listeners = new Map();
    this.selectors = {};
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.checked = false;
    this.open = false;
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  emit(type, event = {}) { this.listeners.get(type)?.(event); }
  querySelector(selector) {
    assert.ok(selector in this.selectors, `Unknown selector ${selector}`);
    return this.selectors[selector];
  }
  querySelectorAll(selector) {
    assert.ok(selector in this.selectors, `Unknown selector ${selector}`);
    return this.selectors[selector];
  }
  remove() {}
  set innerHTML(_) { throw new Error("Untrusted HTML insertion"); }
}

function harness(fileCount = 3, failDownload = false) {
  const ids = new Map();
  const cards = [];
  const groups = [];
  for (const id of ["search", "review-filter", "progress", "filter-status", "no-results", "export-status", "export-preview",
    "general-notes", "expand-all", "collapse-all", "export-feedback", "feedback-json", "review-data"]) ids.set(id, new Element());
  ids.get("review-filter").value = "all";
  const files = [];
  for (let index = 0; index < fileCount; index++) {
    const group = ["core", "wiring", "mechanical"][index % 3];
    const file = { id: `file-${index}`, path: `src/${group}.js`, status: "modified", group };
    files.push(file);
    const card = new Element();
    card.dataset.search = `${file.path} modified ${group}`;
    card.selectors = {
      ".reviewed": new Element(), ".file-notes": new Element(), ".note-indicator": new Element(),
      ".file-details, .patch-details": [new Element(), new Element()],
    };
    ids.set(file.id, card);
    cards.push(card);
    const section = new Element();
    section.selectors[".file-card"] = [card];
    groups.push(section);
  }
  const metadata = { schema_version: 1, pr: { title: "Synthetic", head_sha: "1".repeat(40) }, input_sha256: "a".repeat(64), files };
  ids.get("review-data").dataset.review = JSON.stringify(metadata);
  let exportedBlob;
  const downloads = [];
  const window = new Element();
  const document = {
    getElementById: id => { assert.ok(ids.has(id), `Unknown id ${id}`); return ids.get(id); },
    querySelectorAll: selector => {
      if (selector === ".file-card") return cards;
      if (selector === ".review-group") return groups;
      throw new Error(`Unknown document selector ${selector}`);
    },
    createElement: tag => {
      assert.equal(tag, "a");
      const link = new Element();
      link.click = () => downloads.push({ href: link.href, filename: link.download });
      return link;
    },
    body: { append: () => {} },
  };
  const forbidden = () => { throw new Error("Unexpected external request or storage access"); };
  const context = {
    document, window, Blob, Date,
    URL: {
      createObjectURL: blob => {
        if (failDownload) throw new Error("Download blocked");
        exportedBlob = blob;
        return "blob:synthetic";
      },
      revokeObjectURL: () => {},
    },
    setTimeout: callback => callback(),
    fetch: forbidden,
    XMLHttpRequest: forbidden,
  };
  Object.defineProperty(context, "localStorage", { get: forbidden });
  Object.defineProperty(context, "sessionStorage", { get: forbidden });
  vm.runInNewContext(source, context, { filename: "review.js", timeout: 1000 });
  return { ids, cards, groups, window, downloads, getBlob: () => exportedBlob };
}

(async () => {
  const app = harness();
  const get = id => app.ids.get(id);
  assert.equal(get("progress").textContent, "0 of 3 reviewed");
  assert.equal(get("filter-status").textContent, "3 of 3 files shown");
  assert.equal(get("no-results").hidden, true);

  get("search").value = " CORE ";
  get("search").emit("input");
  assert.deepEqual(app.cards.map(card => card.hidden), [false, true, true]);
  assert.deepEqual(app.groups.map(group => group.hidden), [false, true, true]);
  get("expand-all").emit("click");
  assert.deepEqual(app.cards.map(card => card.selectors[".file-details, .patch-details"].every(detail => detail.open)), [true, false, false]);
  get("collapse-all").emit("click");
  assert.equal(app.cards[0].selectors[".file-details, .patch-details"].some(detail => detail.open), false);
  get("search").value = "no-match";
  get("search").emit("input");
  assert.equal(get("no-results").hidden, false);
  get("search").value = "";
  get("search").emit("input");

  const checkbox = app.cards[0].selectors[".reviewed"];
  checkbox.checked = true;
  checkbox.emit("change");
  assert.equal(get("progress").textContent, "1 of 3 reviewed");
  assert.equal(app.cards[0].classes.has("is-reviewed"), true);
  get("review-filter").value = "reviewed";
  get("review-filter").emit("change");
  assert.deepEqual(app.cards.map(card => card.hidden), [false, true, true]);
  get("review-filter").value = "remaining";
  get("review-filter").emit("change");
  assert.deepEqual(app.cards.map(card => card.hidden), [true, false, false]);

  const hostileNote = '</textarea><script>globalThis.PWNED=1</script>\nCheck boundary.';
  const notes = app.cards[0].selectors[".file-notes"];
  notes.value = hostileNote;
  notes.emit("input");
  assert.equal(app.cards[0].selectors[".note-indicator"].textContent, " · has notes");
  get("general-notes").value = "Clarify expected behavior.";
  get("general-notes").emit("input");
  get("export-feedback").emit("click");
  assert.equal(app.downloads.length, 1);
  assert.equal(app.downloads[0].filename, "pr-review-feedback-aaaaaaaaaaaa.json");
  const downloadText = await app.getBlob().text();
  const feedback = JSON.parse(downloadText);
  assert.equal(feedback.files.length, 3, "Export includes filtered-out files");
  assert.equal(feedback.files[0].notes, hostileNote);
  assert.equal(feedback.files[0].reviewed, true);
  assert.equal(feedback.files[1].reviewed, false);
  assert.equal(feedback.pr.head_sha.length, 40);
  assert.equal(feedback.general_notes, "Clarify expected behavior.");
  assert.equal(feedback.files.some(file => "patch" in file), false);
  assert.equal(downloadText, get("feedback-json").value);
  assert.equal(get("export-preview").hidden, false);
  let guarded = false;
  const event = { preventDefault() { guarded = true; } };
  app.window.emit("beforeunload", event);
  assert.equal(guarded, true, "Download request does not imply successful save");
  assert.equal(event.returnValue, "");
  notes.value = "Changed after export";
  notes.emit("input");
  assert.equal(get("export-preview").hidden, true, "Stale export snapshot is hidden");

  const failed = harness(3, true);
  failed.ids.get("general-notes").value = "Keep this despite a blocked download";
  failed.ids.get("general-notes").emit("input");
  failed.ids.get("export-feedback").emit("click");
  assert.equal(failed.ids.get("export-preview").hidden, false);
  assert.equal(failed.ids.get("export-preview").open, true);
  assert.match(failed.ids.get("export-status").textContent, /Copy the JSON/);
  assert.equal(JSON.parse(failed.ids.get("feedback-json").value).general_notes, "Keep this despite a blocked download");

  const empty = harness(0);
  assert.equal(empty.ids.get("no-results").hidden, true);
  assert.equal(empty.ids.get("progress").textContent, "0 of 0 reviewed");
  const fresh = harness();
  assert.equal(fresh.cards[0].selectors[".reviewed"].checked, false);
  assert.equal(fresh.cards[0].selectors[".file-notes"].value, "");
  console.log("PASS: production JS filters, groups, folding, reviewed flags, hostile notes as data, complete feedback export, blocked-download fallback, unload guard, fresh state, no storage/network calls. DOM test double only; real-browser/visual QA is separate.");
})().catch(error => { console.error(error); process.exitCode = 1; });
