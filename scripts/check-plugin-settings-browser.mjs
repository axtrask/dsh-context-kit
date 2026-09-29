/** Browser guards against a separately started, throwaway DSH home on port 3181. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const url = new URL(process.env.PLUGIN_SETTINGS_URL ?? 'http://127.0.0.1:3181/');
assert.equal(url.origin, 'http://127.0.0.1:3181', 'Never run settings mutations against the user server');
const { chromium } = await import(pathToFileURL(process.env.EDITOR_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: process.env.EDITOR_HEADED !== '1', executablePath: process.env.EDITOR_BROWSER_PATH });
let passed = 0, failed = 0;
const errors = [];
const check = async (label, fn) => {
  try { await fn(); passed++; console.log('[ok] ' + label); }
  catch (error) { failed++; console.error('[FAIL] ' + label + ': ' + error.stack); }
};
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const card = ns => page.locator(`[data-plugin-settings="${ns}"]`);
async function openSettings() {
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  const later = page.getByRole('button', { name: 'Configure later', exact: true });
  const plugins = page.getByRole('button', { name: 'Plugins', exact: true });
  // The empty fixture's API-key onboarding can arrive after Settings has opened.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if (await later.isVisible()) await later.click({ timeout: 1000 });
      else if (await notice.isVisible()) await notice.click({ timeout: 1000 });
      else if (await plugins.isVisible()) {
        await plugins.click({ timeout: 1000 });
        await card('history-editor').waitFor({ timeout: 3000 });
        return;
      } else await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 1000 });
    } catch (error) { if (attempt === 29) throw error; }
    await page.waitForTimeout(200);
  }
  throw new Error('Settings did not become available after onboarding');
}
async function expand(ns) {
  const header = card(ns).locator('.ctxkit-settings-header');
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}
try {
  await openSettings();
  await check('three native cards are present without a context-kit preset', async () => {
    for (const ns of ['dcp', 'context-mode', 'history-editor']) {
      assert.equal(await card(ns).count(), 1);
      assert.equal(await card(ns).locator('.ctxkit-settings-header').getAttribute('aria-expanded'), 'false');
    }
    assert.ok(await page.getByRole('button', { name: 'Standard mode', exact: true }).count());
  });
  await check('card titles keep the native color under markdown palette styling', async () => {
    const palette = await page.addStyleTag({ content: 'strong { color: rgb(245, 167, 66) !important; }' });
    try {
      const nativeColor = await page.getByRole('button', { name: 'Show settings: Shell', exact: true })
        .locator('span span').first().evaluate(el => getComputedStyle(el).color);
      for (const ns of ['dcp', 'context-mode', 'history-editor']) {
        const color = await card(ns).locator('.ctxkit-settings-header > span > :first-child')
          .evaluate(el => getComputedStyle(el).color);
        assert.equal(color, nativeColor, ns + ' title must match the native plugin titles');
      }
    } finally { await palette.evaluate(el => el.remove()); }
  });
  await check('DCP settings save independently and survive a page reload', async () => {
    await expand('dcp');
    const checkbox = card('dcp').getByRole('checkbox', { name: 'Manual mode', exact: true });
    const initial = await checkbox.isChecked();
    await checkbox.setChecked(!initial);
    await card('dcp').getByRole('button', { name: 'Save', exact: true }).click();
    await card('dcp').getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
    await openSettings(); await expand('dcp');
    assert.equal(await checkbox.isChecked(), !initial);
    assert.equal(await card('context-mode').getByRole('checkbox', { name: 'Enable Context Mode', exact: true, includeHidden: true }).isChecked(), true);
    await checkbox.setChecked(initial);
    await card('dcp').getByRole('button', { name: 'Save', exact: true }).click();
    await card('dcp').getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  });
  await check('DCP thresholds share Advanced, persist live and reject invalid values', async () => {
    const dcp = card('dcp');
    await dcp.getByText('Advanced configuration', { exact: true }).click();
    const json = dcp.getByRole('textbox', { name: 'DCP configuration JSON', exact: true });
    const original = await json.inputValue();
    for (const [name, value] of [['Reminder threshold', '70'], ['Context-limit threshold', '90']]) {
      await dcp.getByRole('combobox', { name: name + ' unit', exact: true }).selectOption('%');
      await dcp.getByRole('spinbutton', { name, exact: true }).fill(value);
    }
    assert.equal(JSON.parse(await json.inputValue()).compress.minContextLimit, '70%');
    await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
    await openSettings(); await expand('dcp');
    assert.equal(await dcp.getByRole('spinbutton', { name: 'Reminder threshold', exact: true }).inputValue(), '70');
    assert.equal(await dcp.getByRole('combobox', { name: 'Reminder threshold unit', exact: true }).inputValue(), '%');
    await dcp.getByRole('spinbutton', { name: 'Context-limit threshold', exact: true }).fill('101');
    await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'draft is kept' }).waitFor();
    assert.equal(await dcp.getByRole('spinbutton', { name: 'Context-limit threshold', exact: true }).inputValue(), '101');
    await dcp.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await dcp.getByRole('spinbutton', { name: 'Context-limit threshold', exact: true }).inputValue(), '90');
    await dcp.getByText('Advanced configuration', { exact: true }).click();
    await json.fill(original); await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
  });
  await check('six editable prompts preserve multiline drafts, reload and reset to defaults', async () => {
    const dcp = card('dcp'), json = dcp.getByRole('textbox', { name: 'DCP configuration JSON', exact: true });
    const original = await json.inputValue();
    await dcp.getByText('Prompts', { exact: true }).click();
    const choose = dcp.getByRole('combobox', { name: 'DCP prompt', exact: true });
    const text = dcp.getByRole('textbox', { name: 'DCP prompt text', exact: true });
    const names = ['system', 'turnNudge', 'contextLimitNudge', 'iterationNudge', 'compressRange', 'compressMessage'];
    for (const name of names) {
      await choose.selectOption(name);
      assert.ok((await text.inputValue()).length > 0, name + ' must show its bundled default');
      await text.fill(''); assert.equal(await text.inputValue(), '', 'an empty draft must not snap back while typing');
      await text.fill('TEST ' + name + '\nsecond line <literal>');
    }
    assert.equal(Object.keys(JSON.parse(await json.inputValue()).prompts).length, 6);
    await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
    await openSettings(); await expand('dcp'); await dcp.getByText('Prompts', { exact: true }).click();
    for (const name of names) {
      await choose.selectOption(name); assert.equal(await text.inputValue(), 'TEST ' + name + '\nsecond line <literal>');
    }
    await choose.selectOption('system'); await dcp.getByRole('button', { name: 'Use default prompt', exact: true }).click();
    assert.ok(!(await text.inputValue()).startsWith('TEST '));
    await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
    await dcp.getByText('Advanced configuration', { exact: true }).click();
    assert.equal(JSON.parse(await json.inputValue()).prompts.system, '');
    await json.fill(original); await dcp.getByRole('button', { name: 'Save', exact: true }).click();
    await dcp.getByRole('status').filter({ hasText: 'Applies to the next step' }).waitFor();
  });
  await check('invalid JSON and server validation keep the unsaved draft', async () => {
    await expand('context-mode');
    await card('context-mode').getByText('Advanced configuration', { exact: true }).click();
    const input = card('context-mode').getByRole('textbox');
    const original = await input.inputValue();
    await input.fill('{'); await card('context-mode').getByRole('button', { name: 'Save', exact: true }).click();
    await card('context-mode').getByRole('status').filter({ hasText: 'JSON object' }).waitFor();
    assert.equal(await input.inputValue(), '{');
    const invalid = JSON.parse(original); invalid.batchConcurrency = -1;
    await input.fill(JSON.stringify(invalid)); await card('context-mode').getByRole('button', { name: 'Save', exact: true }).click();
    await card('context-mode').getByRole('status').filter({ hasText: 'draft is kept' }).waitFor();
    assert.equal(JSON.parse(await input.inputValue()).batchConcurrency, -1);
    await card('context-mode').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await input.inputValue(), original);
  });
  await check('editor enable is live and does not change DCP settings', async () => {
    await expand('history-editor');
    const input = card('history-editor').getByRole('checkbox', { name: 'Enable history editing', exact: true });
    for (const enabled of [false, true]) {
      await input.setChecked(enabled);
      await card('history-editor').getByRole('button', { name: 'Save', exact: true }).click();
      await card('history-editor').getByRole('status').filter({ hasText: 'Changes are active' }).waitFor();
      assert.equal(await input.isChecked(), enabled);
    }
    assert.equal(await card('dcp').getByRole('checkbox', { name: 'Enable DCP', exact: true }).isChecked(), true);
  });
  for (const width of [1280, 390]) await check(`cards fit the native settings panel at ${width}px`, async () => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await openSettings();
    for (const ns of ['dcp', 'context-mode', 'history-editor']) {
      const header = card(ns).locator('.ctxkit-settings-header');
      if (await header.getAttribute('aria-expanded') === 'true') await header.click();
      await header.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const box = await header.boundingBox();
      assert.ok(box && box.width > 180 && box.x >= 0 && box.x + box.width <= width + 1);
    }
    await card('history-editor').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(tmpdir(), `ctxkit-independent-settings-${width}.png`) });
    assert.equal(await card('history-editor').isVisible(), true, 'screenshot must show the settings, not a dismissed dialog');
    await expand('dcp');
    const input = card('dcp').getByRole('spinbutton', { name: 'Reminder threshold', exact: true });
    await input.scrollIntoViewIfNeeded();
    const inputBox = await input.boundingBox();
    assert.ok(inputBox.width > 60 && inputBox.x >= 0 && inputBox.x + inputBox.width <= width);
    await page.screenshot({ path: join(tmpdir(), `ctxkit-dcp-thresholds-${width}.png`) });
    assert.equal(await input.isVisible(), true);
    await card('dcp').getByText('Prompts', { exact: true }).click();
    const prompt = card('dcp').getByRole('textbox', { name: 'DCP prompt text', exact: true });
    await prompt.scrollIntoViewIfNeeded();
    const promptBox = await prompt.boundingBox();
    assert.ok(promptBox.width > 180 && promptBox.x >= 0 && promptBox.x + promptBox.width <= width);
    await page.screenshot({ path: join(tmpdir(), `ctxkit-dcp-prompts-${width}.png`) });
    assert.equal(await prompt.isVisible(), true);
  });
  await check('no browser runtime errors', () => assert.deepEqual(errors, []));
} finally { await browser.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
