(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const key = 'internal-visual-style-theme';
  let choice;
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark') choice = saved;
  } catch { /* Storage is optional, including when opened as a local file. */ }
  const current = () => choice || (system.matches ? 'dark' : 'light');
  const apply = () => {
    root.dataset.theme = current();
    const button = document.querySelector('#theme-toggle');
    if (button) {
      const dark = current() === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      button.textContent = dark ? 'Dark mode: on' : 'Dark mode: off';
    }
  };
  apply();
  system.addEventListener('change', () => { if (!choice) apply(); });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('#theme-toggle');
    if (button) {
      button.hidden = false;
      apply();
      button.addEventListener('click', () => {
        choice = current() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, choice); } catch { /* Keep the local choice. */ }
        apply();
      });
    }
  });
  window.addEventListener('load', () => {
    const tokens = getComputedStyle(root);
    for (const [id, role, token] of [
      ['font-status', 'Reading', '--font-reading'],
      ['technical-font-status', 'Technical', '--font-technical'],
    ]) {
      const status = document.getElementById(id);
      if (!status) continue;
      const family = tokens.getPropertyValue(token).split(',')[0].trim();
      const name = family.replace(/^"|"$/g, '');
      const fallback = `${role} font: system fallback. ${name} did not load.`;
      document.fonts.load(`400 18px ${family}`).then(faces => {
        status.textContent = faces.length ? `${role} font: ${name} loaded.` : fallback;
      }).catch(() => { status.textContent = fallback; });
    }
  });
})();
