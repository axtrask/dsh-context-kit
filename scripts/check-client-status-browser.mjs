/** Read-only UI fixtures: never opens the user's DSH or calls its APIs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.EDITOR_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: process.env.EDITOR_HEADED !== '1', executablePath: process.env.EDITOR_BROWSER_PATH });
const script = readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8');
let passed = 0, failed = 0;
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent('<!doctype html><style>ul{padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}li{min-width:0;list-style:none}button{width:100%;text-align:left}strong{font-size:13px}button>span{display:flex;justify-content:space-between}strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}code{display:block}</style><ul></ul><textarea aria-label="Unrelated draft">KEEP ME</textarea>');
      await page.evaluate(() => {
        const rows = [
          ['include:context-kit-dcp', 'dcp-plugin', 'DCP'],
          ['include:context-kit-context-mode', 'context-mode-plugin', 'Context Mode'],
          ['include:context-kit-history-editor', 'editor-plugin', 'History Editor'],
          ['foreign-plugin', 'dcp-plugin', null],
          ['include:context-kit-dcp', 'dcp-plugin', null, 'another-package']
        ];
        window.originals = [];
        for (const [id, file, label, pkg = 'dsh-context-kit'] of rows) {
          const module = `file:///C:/example/${pkg}/lib/${file}.js`;
          const li = document.createElement('li'); li.dataset.pluginEntry = id; li.dataset.pluginModule = module;
          const button = document.createElement('button');
          button.setAttribute('aria-label', `${module}, ${id}, Enabled`); button.setAttribute('aria-expanded', 'false');
          const line = document.createElement('span'), title = document.createElement('strong');
          title.title = module; title.textContent = module;
          line.append(title, Object.assign(document.createElement('span'), { textContent: 'Enabled' }));
          button.append(line, Object.assign(document.createElement('code'), { textContent: id }));
          const details = document.createElement('div'); details.textContent = module; details.hidden = true;
          button.onclick = () => { details.hidden = !details.hidden; button.setAttribute('aria-expanded', String(!details.hidden)); };
          li.append(button, details); document.querySelector('ul').append(li);
          window.originals.push({ li, button, title, node: title.firstChild, html: li.outerHTML, label, module });
        }
        let plugin, cleanups = [];
        window.__ModuleLoader__ = { load: definition => { plugin = definition.factory(() => { throw Error('Unexpected dependency'); }); } };
        window.mount = () => plugin.apply({ sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }, effect: fn => cleanups.push(fn()) });
        window.dispose = () => { for (const fn of cleanups.reverse()) if (typeof fn === 'function') fn(); cleanups = []; };
      });
      await page.addScriptTag({ content: script }); await page.evaluate(() => window.mount());
      await page.waitForFunction(() => document.querySelectorAll('[data-ctxkit-plugin-name]').length === 3, null, { timeout: 3000 });
      assert.deepEqual(await page.evaluate(() => window.originals.map(({ li, title, node, label }) => ({
        label: title.getAttribute('data-ctxkit-plugin-name'), sameNode: title.firstChild === node,
        untouched: label ? true : li.outerHTML === window.originals.find(item => item.li === li).html
      }))), ['DCP', 'Context Mode', 'History Editor', null, null].map(label => ({ label, sameNode: true, untouched: true })));
      const button = page.getByRole('button', { name: 'DCP, include:context-kit-dcp, Enabled', exact: true });
      await button.click();
      assert.equal(await page.evaluate(() => window.originals[0].li.lastChild.hidden), false);
      assert.equal(await page.evaluate(() => window.originals[0].title.title), 'file:///C:/example/dsh-context-kit/lib/dcp-plugin.js');
      assert.match(await page.evaluate(() => getComputedStyle(window.originals[1].title, '::before').content), /Context Mode/);
      await page.evaluate(() => { const { button, module } = window.originals[0]; button.setAttribute('aria-label', module + ', include:context-kit-dcp, Disabled'); });
      await page.getByRole('button', { name: 'DCP, include:context-kit-dcp, Disabled', exact: true }).waitFor();
      await page.evaluate(() => window.dispose());
      assert.equal(await page.locator('[data-ctxkit-plugin-name]').count(), 0);
      assert.equal(await page.evaluate(() => window.originals[0].button.getAttribute('aria-label')), 'file:///C:/example/dsh-context-kit/lib/dcp-plugin.js, include:context-kit-dcp, Disabled');
      await page.evaluate(() => window.mount());
      await page.getByRole('button', { name: 'DCP, include:context-kit-dcp, Disabled', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Unrelated draft' }).inputValue(), 'KEEP ME');
      assert.deepEqual(errors, []);
      console.log(`[ok] inventory names, native details, status changes and cleanup at ${width}px`); passed++;
    } catch (error) { console.error(`[FAIL] ${width}px: ${error.stack}`); failed++; }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
