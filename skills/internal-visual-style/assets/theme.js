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
    const status = document.querySelector('#font-status');
    if (status) {
      document.fonts.load('400 18px "Atkinson Hyperlegible Next"').then(faces => {
        status.textContent = faces.length ? 'Reading font: Atkinson Hyperlegible Next loaded.' : 'Reading font: system fallback. Atkinson Hyperlegible Next did not load.';
      }).catch(() => { status.textContent = 'Reading font: system fallback. Atkinson Hyperlegible Next did not load.'; });
    }
  });
})();
