/** Repository acceptance is an explicit user action; filtering never contacts the server. */
export const installRepositories = () => {
  const search = document.querySelector<HTMLInputElement>("[data-repository-search]");
  const filter = document.querySelector<HTMLSelectElement>("[data-repository-filter]");
  if (search === null || filter === null) return;
  const refresh = document.querySelector<HTMLButtonElement>("[data-repository-refresh]");
  if (refresh !== null) {
    refresh.disabled = false;
    refresh.addEventListener("click", () => location.reload());
  }
  const cards = [...document.querySelectorAll<HTMLElement>("[data-repository]")];
  const count = document.querySelector<HTMLElement>("[data-repository-count]");
  const empty = document.querySelector<HTMLElement>("[data-repository-empty]");
  const error = document.querySelector<HTMLElement>("[data-repository-error]");
  if ([...filter.options].some((option) => option.value === filter.dataset.initial))
    filter.value = filter.dataset.initial ?? "all";
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      card.hidden = !(card.dataset.search ?? "").includes(query) ||
        !(filter.value === "all" || filter.value === card.dataset.monitoring || (card.dataset.status ?? "").split(" ").includes(filter.value));
      if (!card.hidden) shown++;
    }
    if (count !== null) count.textContent = `${shown} of ${cards.length} repositories shown`;
    if (empty !== null) empty.hidden = shown > 0 || cards.length === 0;
    const url = new URL(location.href);
    if (search.value === "") url.searchParams.delete("q");
    else url.searchParams.set("q", search.value);
    if (filter.value === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", filter.value);
    history.replaceState(null, "", url);
    for (const key of ["q", "filter"]) {
      const input = document.querySelector<HTMLInputElement>(`.repository-scan input[name="${key}"]`);
      if (input !== null) input.value = url.searchParams.get(key) ?? "";
    }
  };
  search.addEventListener("input", apply);
  filter.addEventListener("change", apply);
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
