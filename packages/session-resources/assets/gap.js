// Time units for each idle cut on the shared time axis, so a cut is drawn about `px` wide in a plot `width` px wide
// holding `active` ms of live time. All cuts together take at most half the plot, which keeps the live share and
// gapU positive, so the axis transform stays strictly increasing.
// It is a global because the page script, inlined in a separate element, calls it.
globalThis.srGapUnits = (active, gaps, width) => {
  if (!gaps) return 0;
  const w = Math.max(width, 1),
    px = Math.min(88, w * 0.22, (w * 0.5) / gaps);
  return active > 0 ? (active * px) / (w - gaps * px) : 1;
};
