/**
 * The home page's repositories: one search field that narrows them by name, path, or branch, kept in the URL as `q`,
 * and the explicit Monitor and Remove actions. Filtering never contacts the server. An incoming `filter` (monitored,
 * discovered, changed, unavailable) from an older link still hides the rows that do not match; the page has no
 * control for it, since rows are grouped by monitoring and every checkout says its state.
 */
const FILTERS = ["monitored", "discovered", "changed", "unavailable"];

export const installRepositories = () => {
  const search = document.querySelector<HTMLInputElement>("[data-repository-search]");
  if (search === null) return;
  const refresh = document.querySelector<HTMLButtonElement>("[data-repository-refresh]");
  if (refresh !== null) {
    refresh.disabled = false;
    refresh.addEventListener("click", () => location.reload());
  }
  const rows = [...document.querySelectorAll<HTMLElement>("[data-repository]")];
  const count = document.querySelector<HTMLElement>("[data-repository-count]");
  const empty = document.querySelector<HTMLElement>("[data-repository-empty]");
  const error = document.querySelector<HTMLElement>("[data-repository-error]");
  const filter = FILTERS.includes(search.dataset.filter ?? "") ? (search.dataset.filter ?? "") : "";
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      row.hidden =
        !(row.dataset.search ?? "").includes(query) ||
        !(filter === "" || filter === row.dataset.monitoring || (row.dataset.status ?? "").split(" ").includes(filter));
      if (!row.hidden) shown++;
    }
    // A group whose rows are all hidden hides its heading too.
    for (const list of document.querySelectorAll<HTMLElement>("[data-repositories] ul.rows")) {
      const any = [...list.querySelectorAll<HTMLElement>(":scope > [data-repository]")].some((row) => !row.hidden);
      list.hidden = !any;
      const head = list.previousElementSibling;
      if (head instanceof HTMLElement && head.classList.contains("found-head")) head.hidden = !any;
    }
    if (count !== null) count.textContent = `${shown} of ${rows.length} repositories shown`;
    if (empty !== null) empty.hidden = shown > 0 || rows.length === 0;
    const url = new URL(location.href);
    if (search.value === "") url.searchParams.delete("q");
    else url.searchParams.set("q", search.value);
    history.replaceState(null, "", url);
    const input = document.querySelector<HTMLInputElement>(`.repository-scan input[name="q"]`);
    if (input !== null) input.value = search.value;
  };
  search.addEventListener("input", apply);
  apply();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-repository-action]")) {
    button.disabled = false;
    button.addEventListener("click", async () => {
      button.disabled = true;
      if (error !== null) error.hidden = true;
      try {
        const response = await fetch("/repositories/actions", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(button.dataset.repositoryAction === "accept"
            ? { kind: "accept", id: button.dataset.id, root: button.dataset.root }
            : { kind: "remove", id: button.dataset.id }),
        });
        if (!response.ok) throw new Error(response.status === 409
          ? "This checkout's repository identity changed. Refresh and try again."
          : response.status === 400
          ? "This path is no longer a readable Git repository root. Scan again."
          : "Could not update monitoring. Refresh this page and try again.");
        location.reload();
      } catch (cause) {
        if (error !== null) {
          error.textContent = cause instanceof Error ? cause.message : "Could not reach the server.";
          error.hidden = false;
        }
        button.disabled = false;
      }
    });
  }
};
