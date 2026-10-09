/* Uses existing Playwright/Chromium. No installation or global activation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const skill = path.join(root, 'skills/internal-visual-style');
const out = path.join(root, 'validation/internal-visual-style');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-style-'));
// Exercise an installed copy outside the repository, with no sibling dependencies.
fs.cpSync(skill, path.join(temporary, 'internal-visual-style'), { recursive: true });
const assets = path.join(temporary, 'internal-visual-style/assets');
const compiled = process.env.TAILWIND_CSS;
if (compiled) {
  fs.copyFileSync(compiled, path.join(assets, 'compiled.css'));
  const html = path.join(assets, 'reference.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('./style.css', './compiled.css'));
}
const mode = compiled ? 'tailwind' : 'plain';
const report = { mode, browser: null, states: [], contrasts: [], checks: [], screenshots: [] };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ttf': 'font/ttf', '.md': 'text/plain' };
const server = http.createServer((request, response) => {
  const file = path.resolve(temporary, '.' + decodeURIComponent(request.url.split('?')[0]));
  if (!file.startsWith(temporary + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end(); return;
  }
  response.setHeader('Content-Type', mime[path.extname(file)] || 'text/plain');
  response.end(fs.readFileSync(file));
});

function auditReferences(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) auditReferences(file);
    else if (/\.(md|html|css)$/.test(file)) {
      const source = fs.readFileSync(file, 'utf8');
      const refs = [...source.matchAll(/\]\(([^)]+)\)|(?:src|href)="([^"]+)"|@import "([^"]+)"|url\("([^"]+)"\)/g)];
      for (const match of refs) {
        const ref = match[1] || match[2] || match[3] || match[4];
        if (/^(https?:|#)/.test(ref) || ref === 'tailwindcss') continue;
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), ref.split('#')[0])), `${file}: missing ${ref}`);
      }
    }
  }
}

function contrast(a, b) {
  const luminance = value => {
    const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
      const v = n / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

(async () => {
  let browser;
  try {
    fs.mkdirSync(out, { recursive: true });
    auditReferences(path.join(temporary, 'internal-visual-style'));
    report.checks.push('complete installed-copy reference audit');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/internal-visual-style/assets/reference.html`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    report.browser = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], failed = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failed.push(request.url()));
    page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) external.push(request.url()); });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#font-status').textContent.includes('loaded.'), null, { timeout: 5000 }).catch(async error => { console.log(await page.evaluate(() => ({ status: document.querySelector('#font-status').textContent, font: getComputedStyle(document.querySelector('p')).fontFamily, fonts: [...document.fonts].map(f => ({ family: f.family, status: f.status })) })), { errors, failed }); throw error; });
    await page.waitForFunction(() => document.querySelector('#technical-font-status').textContent.includes('Atkinson Hyperlegible Mono loaded.'));
    const session = await context.newCDPSession(page);
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const documentNode = await session.send('DOM.getDocument');
    const paragraph = await session.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#decisions + p' });
    const fonts = await session.send('CSS.getPlatformFontsForNode', { nodeId: paragraph.nodeId });
    assert.ok(fonts.fonts.some(font => font.isCustomFont && font.familyName === 'Atkinson Hyperlegible Next' && font.glyphCount > 0));
    report.renderedReadingFonts = fonts.fonts;
    const code = await session.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'pre code' });
    const codeFonts = await session.send('CSS.getPlatformFontsForNode', { nodeId: code.nodeId });
    report.renderedTechnicalFonts = codeFonts.fonts;
    assert.ok(codeFonts.fonts.some(font => font.isCustomFont && font.familyName === 'Atkinson Hyperlegible Mono ExtraLight' && font.glyphCount > 0));
    report.technicalWeight = await page.locator('pre code').evaluate(e => getComputedStyle(e).fontWeight);
    assert.equal(report.technicalWeight, '400');
    report.checks.push('chosen reading and technical fonts render custom glyphs');
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
      assert.equal(await page.locator('#theme-toggle').textContent(), theme === 'dark' ? 'Dark mode: on' : 'Dark mode: off');
      assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), String(theme === 'dark'));
      for (const width of [1440, 390, 320]) {
        for (const scale of [1, 2]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(({ scale }) => {
            document.documentElement.style.fontSize = `${16 * scale}px`;
          }, { scale });
          const state = await page.evaluate(() => ({
            pageWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            readingSize: getComputedStyle(document.querySelector('#decisions + p')).fontSize,
            modeLabel: document.querySelector('#theme-toggle').textContent,
            modePressed: document.querySelector('#theme-toggle').getAttribute('aria-pressed'),
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            controls: [...document.querySelectorAll('button,summary')].map(e => ({ height: e.getBoundingClientRect().height, text: e.textContent.trim() }))
          }));
          assert.ok(state.scrollWidth <= width, `overflow ${theme} ${width} ${scale}`);
          assert.equal(state.readingSize, `${18 * scale}px`);
          assert.equal(state.colorScheme, theme);
          assert.ok(state.controls.every(control => control.height >= 44));
          report.states.push({ theme, width, textScale: scale, ...state });
          if (!compiled && width !== 320 && (scale === 1 || width === 390)) {
            const name = `${theme}-${width}-${scale * 100}.png`;
            await page.screenshot({ path: path.join(out, name), fullPage: true }); report.screenshots.push(name);
          }
        }
      }
      const pairs = await page.evaluate(() => {
        const roles = [['primary/page', '--text-primary', '--bg-page', 4.5], ['secondary/page', '--text-secondary', '--bg-page', 4.5],
          ['primary/surface', '--text-primary', '--bg-surface', 4.5], ['secondary/surface', '--text-secondary', '--bg-surface', 4.5],
          ['link/page', '--link', '--bg-page', 4.5], ['link/surface', '--link', '--bg-surface', 4.5],
          ['border/page', '--border', '--bg-page', 3], ['border/surface', '--border', '--bg-surface', 3],
          ['focus/page', '--focus', '--bg-page', 3], ['focus/surface', '--focus', '--bg-surface', 3]];
        for (const name of ['neutral', 'success', 'warning', 'danger']) roles.push([name, `--status-${name}`, `--status-${name}-bg`, 4.5]);
        const probe = document.createElement('span'); document.body.append(probe);
        const pairs = roles.map(([role, fg, bg, minimum]) => {
          probe.style.color = `var(${fg})`; probe.style.backgroundColor = `var(${bg})`;
          const computed = getComputedStyle(probe); return { role, foreground: computed.color, background: computed.backgroundColor, minimum };
        }); probe.remove(); return pairs;
      });
      for (const pair of pairs) {
        const ratio = contrast(pair.foreground, pair.background); assert.ok(ratio >= pair.minimum, `${theme} ${pair.role}: ${ratio}`);
        report.contrasts.push({ theme, ...pair, ratio: Number(ratio.toFixed(2)) });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '16px';
      const style = document.createElement('style'); style.textContent = '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'; document.head.append(style);
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.checks.push('user text spacing without page overflow');
    await page.reload();
    await page.keyboard.press('Tab'); assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
    await page.keyboard.press('Enter'); assert.equal(await page.locator(':focus').getAttribute('id'), 'content');
    await page.locator('#theme-toggle').focus();
    assert.equal(await page.locator('#theme-toggle').evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    const previous = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('Space');
    const changed = await page.locator('html').getAttribute('data-theme'); assert.notEqual(changed, previous);
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), String(changed === 'dark'));
    await page.reload(); assert.equal(await page.locator('html').getAttribute('data-theme'), changed);
    await page.locator('summary').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('details').getAttribute('open'), '');
    await page.locator('.code-region').focus(); assert.ok(await page.locator('.code-region').evaluate(e => e.scrollWidth > e.clientWidth));
    await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.querySelector('.code-region').scrollLeft > 0);
    await page.locator('a[href="../references/BRAND.md"]').click(); assert.ok((await page.textContent('body')).includes('Internal visual reference'));
    report.checks.push('keyboard skip, toggle, visible focus, persistence, disclosure, code scrolling, reference link');
    assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(external, []);
    const automatic = await browser.newContext({ colorScheme: 'light' }); const autoPage = await automatic.newPage(); await autoPage.goto(url);
    assert.equal(await autoPage.locator('html').getAttribute('data-theme'), 'light');
    await autoPage.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await autoPage.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    report.checks.push('system theme updates before manual selection; reduced-motion mode');
    const blocked = await browser.newContext(); await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
    }); const blockedPage = await blocked.newPage(); await blockedPage.goto(url); await blockedPage.locator('#theme-toggle').click();
    assert.equal(await blockedPage.locator('html').getAttribute('data-theme'), 'dark');
    report.checks.push('manual toggle survives unavailable storage');
    const missing = await browser.newContext(); const missingPage = await missing.newPage();
    await missingPage.route('**/*.ttf', route => route.abort()); await missingPage.goto(url);
    await missingPage.waitForFunction(() => document.querySelector('#font-status').textContent.includes('system fallback.'));
    await missingPage.waitForFunction(() => document.querySelector('#technical-font-status').textContent.includes('system fallback.'));
    report.checks.push('both missing fonts disclosed visibly');
    for (const theme of ['light', 'dark']) {
      const noScript = await browser.newContext({ javaScriptEnabled: false, colorScheme: theme, viewport: { width: 390, height: 844 } });
      const staticPage = await noScript.newPage(); await staticPage.goto(url);
      assert.equal(await staticPage.locator('#theme-toggle').isVisible(), false);
      assert.equal(await staticPage.locator('html').evaluate(e => getComputedStyle(e).colorScheme), 'light dark');
      const bg = await staticPage.locator('html').evaluate(e => getComputedStyle(e).backgroundColor);
      assert.equal(bg, theme === 'dark' ? 'rgb(23, 28, 32)' : 'rgb(246, 245, 241)');
      assert.ok(await staticPage.locator('noscript').isVisible());
      await noScript.close();
    }
    report.checks.push('no-JS content and system colors in both modes');
    // Direct file use must work without a local server or network request.
    const localPage = await browser.newPage(); await localPage.goto('file://' + path.join(assets, 'reference.html'));
    await localPage.waitForFunction(() => document.querySelector('#font-status').textContent.includes('loaded.'));
    await localPage.waitForFunction(() => document.querySelector('#technical-font-status').textContent.includes('Atkinson Hyperlegible Mono loaded.'));
    await localPage.locator('#theme-toggle').click(); report.checks.push('direct file URL loads both chosen fonts and operates toggle');
    if (compiled) {
      await autoPage.evaluate(() => {
        const sample = document.createElement('section'); sample.id = 'utility-sample';
        sample.innerHTML = '<h1 class="text-4xl font-normal dark:underline">Utility heading</h1><button class="bg-page p-8">Utility button</button><span class="font-sans text-success bg-success-tint">Passed</span><code class="font-mono">Technical utility</code>';
        document.body.append(sample);
      });
      const actual = await autoPage.locator('#utility-sample').evaluate(e => {
        const heading = getComputedStyle(e.querySelector('h1')), button = getComputedStyle(e.querySelector('button')), status = getComputedStyle(e.querySelector('span'));
        return { headingSize: heading.fontSize, weight: heading.fontWeight, decoration: heading.textDecorationLine, padding: button.paddingTop,
          background: button.backgroundColor, page: getComputedStyle(document.documentElement).backgroundColor, status: status.color, tint: status.backgroundColor, font: status.fontFamily, mono: getComputedStyle(e.querySelector('code')).fontFamily };
      });
      assert.equal(actual.headingSize, '36px'); assert.equal(actual.weight, '400'); assert.equal(actual.decoration, 'underline');
      assert.equal(actual.padding, '32px'); assert.equal(actual.background, actual.page);
      assert.equal(actual.status, 'rgb(163, 215, 182)'); assert.equal(actual.tint, 'rgb(38, 60, 48)');
      assert.ok(actual.font.startsWith('\"Atkinson Hyperlegible Next\"'));
      assert.ok(actual.mono.startsWith('\"Atkinson Hyperlegible Mono\"'));
      report.tailwindUtilities = actual; report.checks.push('compiled semantic utilities, explicit dark variant, utility overrides of specimen defaults');
    }
    report.result = 'PASS';
  } catch (error) { report.result = 'FAIL'; report.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${mode === 'plain' ? 'browser' : 'tailwind'}-results.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ result: report.result, browser: report.browser, states: report.states.length, contrasts: report.contrasts.length, checks: report.checks, error: report.error }));
  }
})();
