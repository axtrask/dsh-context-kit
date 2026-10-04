/** Optional, isolated browser regression. No DSH server, token, or model API is used. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPanelScript } from '../lib/edit-panel.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'lib', 'edit-client.js');
const clientScript = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
const home = join(root, '.suite-state', 'edit-panel-browser');
assert.ok(statSync(dirname(home)).isDirectory());
assert.ok(statSync(tmpdir()).isDirectory());
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');
const modulePath = process.env.EDITOR_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
const browser = await chromium.launch({ headless: process.env.EDITOR_HEADED !== '1', executablePath: process.env.EDITOR_BROWSER_PATH || undefined });
let checks = 0;
const failures = [];
const target = (at, kind, text, extra = {}) => ({ at, kind, label: kind === 'text' ? 'Answer' : 'Thinking', text,
  originalText: text, chars: text.length, editable: true, edited: false, changed: false, editStatus: 'none', ...extra });
const entry = (seq, targets, extra = {}) => {
  const text = targets.filter(t => t.kind === 'text').map(t => t.text).join('') || targets.map(t => t.text).join('');
  return { seq, originSeq: seq, id: `a${seq}`, originId: `a${seq}`, type: 'assistant/message', turn: seq, step: 1,
    branch: 'wire', editable: true, text, chars: text.length, edited: targets.some(t => t.edited),
    changed: targets.some(t => t.changed), editStatus: targets.some(t => t.edited) ? 'applied' : 'none', targets, ...extra };
};
const fixtures = () => [
  entry(8, [target(0, 'text', 'QUESTION', { label: 'Message' })], { type: 'user/message', userIndex: 0, id: 'u1', originId: 'u1', branch: 'durable' }),
  entry(15, [target(0, 'reasoning', '**THINK A**\nsecond line'), target(2, 'text', 'ANSWER')]),
  entry(16, [target(0, 'reasoning', 'ONLY THINK')]),
  entry(17, [target(0, 'reasoning', 'SIGNED', { signed: true }), target(1, 'text', 'SAFE')]),
];
const image = '<img alt="kept image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">';
// Actual slot boundary and both installed CSS-module token formats, without matching aliases.
const userRow = (key = 'u1', kind = 'user') => `<div data-chat-flow-key="13:input-message${key}" data-chat-flow-kind="${kind}"><div data-slot="conversation.chat.node" style="display:contents"><div class="Sixlwa_userRow"><div class="Sixlwa_userStack"><div data-message-attachments>${image}</div><div class="Sixlwa_bubble extra">QUESTION</div></div><button data-native-copy>Native copy</button></div></div></div>`;
const assistantRow = (seq = 15) => `<div data-chat-flow-key="14:assistant-step${seq}:1" data-chat-flow-kind="assistant-step"><div data-slot="conversation.chat.node" style="display:contents"><div class="hWmORq_root"><div class="hWmORq_body"><div data-process-reasoning hidden="until-found"><div data-variant="think" data-state="ok"><div role="button" tabindex="0" data-fold aria-expanded="false">Think <span class="lcKema_summary"><span class="lcKema_summaryText">THINK A</span></span></div></div></div><div class="_markdown_kcgor_5 extra"><p>ANSWER</p></div><div data-images>${image}</div><section data-tool><div class="tool_body"><div class="tool_markdown">TOOL ORIGINAL</div></div><button>Tool action</button></section></div></div><button data-native-copy>Native copy</button></div></div>`;
const markup = () => `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px system-ui}main{max-width:850px;margin:auto;padding:16px} [data-chat-flow-key]{position:relative;padding:12px;margin:8px 0;border:1px solid #ccc} .Sixlwa_userStack{display:flex;flex-direction:column}.hWmORq_body{display:flex;flex-direction:column;gap:16px}.lcKema_summaryText{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lcKema_thinkBody{padding:4px 0 4px 22px;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word}img{width:16px;height:16px}</style><main><button id="outside-focus">Outside control</button><div data-chat-flow>${userRow()}${assistantRow()}</div><div data-trajectory-scroll><div data-chat-flow>${userRow()}${assistantRow()}</div></div><div data-chat-flow-key="14:assistant-step15:1" data-chat-flow-kind="assistant-step" id="outside">NOT CHAT</div></main><div id="dsh-context-kit-editor"></div>`;

async function boot(page, current = 'A', mount = true) {
  await page.evaluate(current => {
    let snapshot = { current };
    const listeners = new Set();
    const cleanups = [];
    let registration;
    window.view = {
      getSnapshot: () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      setCurrent: current => { snapshot = { current }; for (const listener of listeners) listener(); },
      subscribers: () => listeners.size
    };
    // Loader registration is lazy; service injection and effect teardown mirror Cordis.
    window.__ModuleLoader__ = { load: value => { registration = value; } };
    window.mountClient = () => {
      if (!registration) return;
      if (registration.id !== 'dsh-context-kit') throw Error('wrong client package id');
      const plugin = registration.factory(() => { throw Error('unexpected client dependency'); });
      if (JSON.stringify(plugin.inject) !== '["sessions"]') throw Error('wrong service injection');
      plugin.apply({ sessions: { list: window.view }, effect: effect => { const cleanup = effect(); cleanups.push(cleanup); return cleanup; } });
    };
    window.disposeClient = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: current }));
    window.nativeCopy = () => 'ANSWER';
    window.ledger = Object.freeze({ text: 'ANSWER' });
    window.originals = [...document.querySelectorAll('.Sixlwa_bubble, ._markdown_kcgor_5, [data-tool], img')];
    document.addEventListener('click', event => {
      const process = event.target.closest('[data-turn-process]');
      if (process) {
        const expanded = process.getAttribute('aria-expanded') !== 'true';
        process.setAttribute('aria-expanded', String(expanded));
        const flow = process.closest('[data-chat-flow]');
        for (const row of flow.children) {
          if (row.getAttribute('data-chat-flow-key') !== '14:assistant-step' + process.dataset.turnProcess + ':1') continue;
          const body = row.querySelector('[data-process-reasoning]');
          if (expanded) body.removeAttribute('hidden');
          else body.setAttribute('hidden', 'until-found');
        }
        return;
      }
      const button = event.target.closest('[data-fold]');
      if (!button) return;
      const think = button.parentElement;
      const expanded = !think.hasAttribute('data-expanded');
      think.toggleAttribute('data-expanded', expanded);
      button.setAttribute('aria-expanded', String(expanded));
      if (expanded) {
        button.querySelector('.lcKema_summary')?.remove();
        const body = document.createElement('div');
        body.className = 'lcKema_thinkBody'; body.textContent = '**THINK A**\nsecond line'; think.append(body);
      } else {
        think.querySelector('.lcKema_thinkBody')?.remove();
        const summary = document.createElement('span'); summary.className = 'lcKema_summary';
        const text = document.createElement('span'); text.className = 'lcKema_summaryText';
        text.textContent = 'THINK A'; summary.append(text); button.append(summary);
      }
    });
  }, current);
  if (clientScript) await page.addScriptTag({ content: clientScript });
  if (mount) await page.evaluate(() => window.mountClient());
  await page.addScriptTag({ type: 'module', content: createPanelScript('/ctxkit.edit') });
}

async function fixture(run, { width = 1280, height = 900, rows = fixtures(), mount = true, hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch, permissions: ['clipboard-read', 'clipboard-write'] });
  const errors = [];
  context.on('page', page => {
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (['warning', 'error'].includes(m.type())) errors.push(m.text()); });
  });
  const page = await context.newPage();
  const state = { sessions: { A: rows, B: [entry(15, [target(2, 'text', 'SESSION B')])] },
    statuses: { A: { enabled: true }, B: { enabled: true } }, requests: [], commits: [], hold: null, listError: false };
  await context.route('https://editor.invalid/**', async route => {
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: markup() });
    const request = route.request().postDataJSON();
    assert.equal(new URL(route.request().url()).pathname, '/ctxkit.edit/' + request.method);
    assert.equal(request.type, 'client-request');
    state.requests.push(request);
    const { payload, method } = request;
    const current = state.sessions[payload.sessionId] || [];
    let value;
    if (method.endsWith('.list')) value = { ok: true, sessionId: payload.sessionId, entries: structuredClone(current.slice(-40)),
      transcript: structuredClone(current), counts: { total: current.length, editable: current.length }, editor: { enabled: true }, doctrine: [] };
    else if (method.endsWith('.status')) value = state.statuses[payload.sessionId];
    else {
      state.commits.push(payload);
      const item = current.find(e => e.seq === payload.seq && e.id === payload.id);
      const block = item?.targets.find(t => t.at === payload.block);
      if (state.commitError) value = { ok: false, reason: state.commitError };
      else if (!block || payload.expected !== block.text) value = { ok: false, reason: 'stale expected text; reload' };
      else {
        const before = block.text;
        const next = payload.restore === true ? block.originalText : payload.text;
        Object.assign(block, { text: next, chars: next.length, edited: true, changed: next !== block.originalText, editStatus: 'applied' });
        Object.assign(item, { text: item.targets.filter(t => t.kind === 'text').map(t => t.text).join('') || block.text,
          edited: true, changed: item.targets.some(t => t.changed), editStatus: 'applied' });
        item.chars = item.text.length;
        if (item.branch === 'durable') { item.seq += 100; item.id = `replacement-${item.seq}`; }
        value = { ok: true, report: { branch: item.branch, seq: payload.seq, newSeq: item.seq, before, block: payload.block } };
      }
    }
    if (method.endsWith('.list') && state.listError) value = { ok: false, reason: 'list unavailable' };
    if (state.hold?.method === method && state.hold.session === payload.sessionId) {
      const held = state.hold;
      state.hold = null;
      held.seen();
      await held.wait;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { ok: true, value } }) });
  });
  await page.goto('https://editor.invalid/');
  await boot(page, 'A', mount);
  const panel = page.locator('#dsh-context-kit-editor');
  const row = seq => panel.locator(`li[data-seq="${seq}"]`);
  const chat = page.locator('main > [data-chat-flow]');
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const settle = () => page.waitForTimeout(380);
  const open = async seq => { await panel.locator('.launch').click(); await row(seq).locator('.edit').click(); };
  const save = async (seq, text) => { await row(seq).locator('textarea').fill(text); await row(seq).locator('.save').click();
    await page.waitForFunction(() => document.querySelector('#dsh-context-kit-editor').shadowRoot.querySelector('footer').className === 'good'); };
  const switchSession = async id => {
    await page.evaluate(({ id, html }) => {
      window.view.setCurrent(id);
      // The installed session-keyed Chat boundary remounts, rather than reusing old rows.
      const flow = document.createElement('div');
      flow.setAttribute('data-chat-flow', '');
      flow.innerHTML = html;
      document.querySelector('main > [data-chat-flow]').replaceWith(flow);
    }, { id, html: id === 'B' ? assistantRow().replace('<p>ANSWER</p>', '<p>SESSION B</p>') : userRow() + assistantRow() });
    await settle();
  };
  const hold = (method, session = 'A') => {
    let release, seen;
    const wait = new Promise(r => { release = r; });
    const started = new Promise(r => { seen = r; });
    state.hold = { method: 'contextKit.edit.' + method, session, wait, seen };
    return { release, started };
  };
  let deadline;
  try {
    await settle();
    await Promise.race([
      run({ page, context, panel, chat, row, state, refresh, settle, open, save, switchSession, hold }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('regression case exceeded 20s')), 20000); })
    ]);
    await settle();
    const count = state.requests.length;
    await page.waitForTimeout(650);
    assert.equal(state.requests.length, count, 'observer must not repeatedly fetch its own mutations');
    assert.deepEqual(errors, [], 'browser console must be clean');
  } finally { clearTimeout(deadline); await context.close(); }
}

const check = async (name, run, options) => {
  if (process.env.EDITOR_CASE && !new RegExp(process.env.EDITOR_CASE).test(name)) return;
  try { await fixture(run, options); checks++; console.log(`[ok] ${name}`); }
  catch (error) { failures.push(name); console.error(`[FAIL] ${name}: ${error.message}`); }
};
const confirmEdit = (page, accept = true) => page.locator('#dsh-context-kit-editor .confirm ' + (accept ? '.accept' : '.keep')).click();
/**
 * Open a target through the panel's own pointer path: a plain click on the region placePencil
 * marked for it. The chip is gone, so this is how a reader opens an editor. Synthetic, so an
 * editor-behaviour check does not depend on where a block's centre happens to fall; the pointer
 * rules themselves (links, code, selection, right click) are checked for real further down.
 */
const openTarget = async (chat, key) => {
  await chat.locator(`[data-ctxkit-for="${key}"]`).evaluate((n) => {
    (n.regions?.[0] ?? n.anchor).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  // The panel outwaits one gesture before it opens, so the wait is part of the path.
  await new Promise((resolve) => setTimeout(resolve, 320));
};
try {
  for (const width of [1280, 390]) await check(`Served legacy: client update moves existing controls below blocks at ${width}`, async ({ page, chat, settle, state }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await settle();
    await chat.evaluate(n => {
      for (const [key, selector, label] of [['15:0', '[data-variant="think"]', 'Thinking'], ['15:2', '._markdown_kcgor_5', 'Answer']]) {
        const pin = n.querySelector(`[data-ctxkit-for="${key}"]`), anchor = n.querySelector(selector);
        pin.shadowRoot.querySelector('button').lastChild.textContent = label;
        pin.anchor = anchor;
        if (label === 'Thinking') {
          anchor.append(pin); pin.style.position = 'absolute'; pin.style.top = '0';
          pin.cleanup = () => { pin.dataset.headerReleased = 'true'; };
        } else { anchor.before(pin); pin.style.marginBottom = '-12px'; }
      }
    });
    await settle();
    for (const [key, selector] of [['15:0', '[data-variant="think"]'], ['15:2', '._markdown_kcgor_5']]) {
      const pin = chat.locator(`[data-ctxkit-for="${key}"]`), source = chat.locator(selector);
      const backInFlow = async () => {
        const placed = await pin.evaluate((n) => {
          const relation = n.anchor.compareDocumentPosition(n);
          return { position: getComputedStyle(n).position,
            contained: n.anchor.contains(n),
            follows: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
            bottomActions: !!n.shadowRoot.querySelector('[data-bottom-actions]') };
        });
        // The legacy shapes are what this check exists for: the Thinking control lived INSIDE its
        // header, absolutely positioned, and the answer control sat BEFORE its block. Either must
        // be gone once the client has done its own update. The pin paints nothing at rest now, so
        // its geometry is no longer the contract - its place in the flow is.
        assert.equal(placed.contained, false, `${key}: the control must not be left inside its block`);
        assert.equal(placed.follows, true, `${key}: the control must follow the block it edits, not sit before it`);
        assert.equal(placed.position, 'relative', `${key}: the control must be back in normal flow`);
      };
      await backInFlow();
      await openTarget(chat, key);
      const surface = chat.locator('[contenteditable]');
      await surface.fill('LOCAL DRAFT');
      await backInFlow();
      await page.evaluate(() => { window.disposeClient(); window.mountClient(); });
      await settle();
      await openTarget(chat, key);
      const recovered = page.locator('#dsh-context-kit-editor li.open');
      assert.equal(await recovered.locator('textarea').inputValue(), 'LOCAL DRAFT', 'client refresh must retain the recoverable draft');
      await recovered.locator('.cancel').click(); await confirmEdit(page); await settle();
      await page.locator('#dsh-context-kit-editor').getByRole('button', { name: 'Close', exact: true }).click(); await settle();
    }
    assert.equal(state.commits.length, 0);
  }, { width, hasTouch: width === 390 });
  for (const width of [1280, 390]) await check(`Hidden chip, bottom-only editor: every editor action stays below its block while scrolling at ${width}`, async ({ page, chat, state, refresh, settle }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await page.locator('main').evaluate(n => { n.style.height = '240px'; n.style.overflowY = 'auto'; });
    const cases = [
      { key: '8:0', source: '.Sixlwa_bubble', label: 'message', entry: 0, block: 0 },
      { key: '15:2', source: '._markdown_kcgor_5', label: 'answer', entry: 1, block: 1 },
      { key: '15:0', source: '.lcKema_thinkBody', label: 'thinking', entry: 1, block: 0 }
    ];
    for (const item of cases) {
      const text = Array(90).fill('Long editable content').join('\n');
      Object.assign(state.sessions.A[item.entry].targets[item.block], { text, chars: text.length,
        edited: true, changed: true, editStatus: 'applied' });
      Object.assign(state.sessions.A[item.entry], { text, chars: text.length, edited: true, changed: true, editStatus: 'applied' });
      await refresh(); await settle();
      const source = chat.locator(item.source), pin = chat.locator(`[data-ctxkit-for="${item.key}"]`);
      const below = async (control, body, label) => {
        const a = await control.boundingBox(), b = await body.boundingBox();
        assert.ok(a && b && a.y >= b.y + b.height - 1, `${item.label} ${label} must be below the entire text block`);
      };
      // The closed pin is the one control that is NOT below: it is invisible now, so what is
      // asserted is that it takes no room and that its block still carries the edit mark. The old
      // row placement, and the labelled chip after it, are both exactly what the redesign removed.
      const collapsed = async (label) => {
        const resting = await pin.evaluate((n) => {
          const box = n.getBoundingClientRect();
          const region = n.regions?.[0];
          return { width: Math.round(box.width), height: Math.round(box.height),
            marked: region?.getAttribute('data-ctxkit-edit') === '',
            marker: region?.tagName.toLowerCase() + '.' + String(region?.className || '').split(' ')[0],
            plant: n.getAttribute('data-ctxkit-plant') !== null };
        });
        assert.ok(resting.width === 0 && resting.height === 0,
          `${item.label} ${label}: the resting pin must take no room (got ${resting.width}x${resting.height})`);
        assert.equal(resting.plant, false, `${item.label} ${label}: the seated chip must be gone`);
        assert.equal(resting.marked, true,
          `${item.label} ${label}: the region a reader clicks must be marked (region ${resting.marker})`);
      };
      await collapsed('before editing');
      await below(chat.getByRole('button', { name: 'Copy effective ' + item.label, exact: true }), source, 'Copy');
      await openTarget(chat, item.key);
      const surface = chat.locator('[contenteditable]');
      await surface.evaluate(n => n.scrollIntoView({ block: 'start' })); await settle();
      await below(pin, surface, 'toolbar after scroll');
      for (const control of ['.cancel', '.restore', '.save']) await below(pin.locator(control), surface, control);
      assert.ok(!['sticky', 'fixed', 'absolute'].includes(await pin.evaluate(n => getComputedStyle(n).position)));
      await pin.locator('.cancel').evaluate(n => n.click()); await settle();
      await collapsed('after cancel');
      await below(chat.getByRole('button', { name: 'Copy effective ' + item.label, exact: true }), source, 'Copy after cancel');
    }
  }, { width, hasTouch: width === 390 });
  await check('Comfort: collapsed Thinking stays collapsed through open, cancel and save', async ({ page, chat, state, settle }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    const think = chat.locator('[data-variant="think"]');
    const pin = chat.locator('[data-ctxkit-for="15:0"]');
    await openTarget(chat, '15:0');
    assert.equal(await think.getAttribute('data-expanded'), null);
    const source = chat.locator('[contenteditable="plaintext-only"]');
    assert.equal(await source.innerText(), '**THINK A**\nsecond line');
    assert.ok((await pin.boundingBox()).y >= (await source.boundingBox()).y + (await source.boundingBox()).height - 1);
    await source.press('Escape'); await settle();
    assert.equal(await think.getAttribute('data-expanded'), null);
    await openTarget(chat, '15:0');
    await chat.locator('[contenteditable]').fill('123');
    await chat.locator('[data-ctxkit-inline] .save').click(); await settle();
    assert.equal(await think.getAttribute('data-expanded'), null);
    assert.equal(state.commits.at(-1).text, '123');
    assert.equal(await chat.locator('[contenteditable]').count(), 0);
  });
  for (const width of [1280, 390]) await check(`Comfort: short content fits, grows and supports manual resizing at ${width}`, async ({ page, chat, state, refresh, settle }) => {
    const block = state.sessions.A[1].targets[1]; block.text = '123'; block.chars = 3;
    await chat.locator('._markdown_kcgor_5').evaluate(n => { n.style.minHeight = '500px'; n.textContent = '123'; });
    await refresh(); await settle();
    await openTarget(chat, '15:2');
    const source = chat.locator('[contenteditable]');
    assert.ok((await source.boundingBox()).height < 100, 'short raw text must not inherit the rendered height');
    assert.equal(await source.evaluate(n => getComputedStyle(n).resize), 'vertical');
    await source.fill(Array(90).fill('long line').join('\n')); await settle();
    assert.ok((await source.boundingBox()).height <= 421);
    await source.fill('123'); await settle();
    assert.ok((await source.boundingBox()).height < 100);
    if (width === 1280) {
      const bounds = await source.boundingBox();
      await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height - 3);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + 197, { steps: 8 });
      await page.mouse.up();
    } else await source.evaluate(n => { n.style.height = '200px'; });
    await settle();
    await source.fill('1234'); await settle();
    assert.ok((await source.boundingBox()).height >= 199, 'typing must respect a manually resized height');
    const controls = chat.locator('[data-ctxkit-inline]');
    assert.ok((await controls.boundingBox()).y >= (await source.boundingBox()).y + 199);
    await page.screenshot({ path: join(home, `comfort-editor-${width}.png`) });
  }, { width, hasTouch: width === 390 });
  await check('Comfort: custom discard is keyboard safe and session scoped', async ({ page, panel, chat, settle, switchSession, state }) => {
    let nativeDialogs = 0; page.on('dialog', d => { nativeDialogs++; void d.dismiss(); });
    await openTarget(chat, '8:0');
    await chat.locator('[contenteditable]').fill('KEEP');
    await chat.locator('[data-ctxkit-inline] .cancel').click();
    const confirm = panel.locator('dialog.confirm'); await confirm.waitFor({ state: 'visible' });
    assert.equal(await confirm.getAttribute('role'), 'alertdialog');
    await page.keyboard.press('Escape');
    assert.equal(await chat.locator('[contenteditable]').innerText(), 'KEEP');
    await chat.locator('[data-ctxkit-inline] .cancel').click();
    await switchSession('B');
    assert.equal(await confirm.isVisible(), false);
    assert.equal(nativeDialogs, 0); assert.equal(state.commits.length, 0);
  });
  await check('Comfort: user edit is alongside native actions, unavailable target explains why', async ({ page, chat, state, refresh, settle }) => {
    await chat.locator('.Sixlwa_userRow').evaluate(n => {
      const actions = document.createElement('div'); actions.className = 'xzv4MW_actions';
      actions.append(n.querySelector('[data-native-copy]')); n.append(actions);
    }); await settle();
    assert.equal(await chat.locator('.xzv4MW_actions [data-ctxkit-for="8:0"]').count(), 1);
    state.sessions.A.splice(0, 1); await refresh(); await settle();
    const unavailable = chat.locator('[data-ctxkit-unavailable]');
    assert.equal(await unavailable.count(), 1, 'an unavailable row must still carry its marker');
    assert.match(await unavailable.evaluate((n) => n.shadowRoot.textContent), /^Unavailable: .*not among the messages/is,
      'the unavailable reason is not permanently visible');
    assert.equal(await unavailable.getAttribute('data-ctxkit-pencil'), null,
      'an unavailable row is still a clickable edit affordance');
    assert.equal(await unavailable.evaluate((n) => n.regions.length), 0);
    const disabled = chat.locator('[data-ctxkit-delete] button');
    assert.equal(await disabled.count(), 2, 'the unmatched user row lost its destructive controls');
    assert.equal(await disabled.evaluateAll((buttons) => buttons.every((button) => button.disabled)), true);
    assert.equal(state.commits.length, 0);
  });
  for (const width of [1280, 390]) for (const kind of ['user', 'answer']) await check(`Native unified: ${kind} bounded editing and exact cancel at ${width}px`, async ({ page, chat, state, refresh, settle }) => {
    const source = chat.locator(kind === 'user' ? '.Sixlwa_bubble' : '._markdown_kcgor_5');
    const key = kind === 'user' ? '8:0' : '15:2';
    const text = Array.from({ length: 60 }, (_, i) => `Line ${i}: **source** and <em>literal</em>.`).join('\n\n');
    const item = state.sessions.A[kind === 'user' ? 0 : 1];
    const block = item.targets[kind === 'user' ? 0 : 1];
    Object.assign(block, { text, originalText: text, chars: text.length });
    item.text = text; item.chars = text.length;
    await source.evaluate((n, text) => {
      n.replaceChildren();
      const child = document.createElement('p'); child.textContent = text; n.append(child);
      if (n.classList.contains('_markdown_kcgor_5')) {
        const code = document.createElement('div'); code.className = 'md-code-block';
        code.innerHTML = '<div data-code-block-banner><button class="_copyButton_rsn9u_62"><svg aria-hidden="true"></svg>Copy</button></div><div data-code-block-content><pre><code>code example</code></pre></div>';
        n.append(code);
      }
      n.style.cssText = 'white-space:pre-wrap;font:17px/26px sans-serif;padding:10px 16px;color:rgb(72,80,94)';
      window.nativeNode = n; window.nativeChildren = [...n.childNodes]; window.nativeStyle = n.getAttribute('style');
    }, text);
    await refresh(); await settle();
    await openTarget(chat, key);
    assert.equal(await source.getAttribute('contenteditable'), 'plaintext-only', 'edit the actual native container');
    assert.equal(await source.evaluate(n => n === window.nativeNode && document.activeElement === n), true);
    assert.equal(await chat.locator('[data-ctxkit-inline] textarea:visible').count(), 0);
    const geometry = await source.evaluate(n => ({ height: n.getBoundingClientRect().height, scroll: n.scrollHeight,
      overflow: getComputedStyle(n).overflowY, font: getComputedStyle(n).fontSize, width: n.getBoundingClientRect().right }));
    assert.ok(geometry.height <= Math.min(420, 900 * .45) + 1 && geometry.scroll > geometry.height);
    assert.equal(geometry.overflow, 'auto'); assert.equal(geometry.font, '17px'); assert.ok(geometry.width <= width);
    await source.fill('CANCEL ONLY'); await source.press('Escape'); await confirmEdit(page); await settle();
    assert.equal(await source.evaluate(n => window.nativeChildren.every((child, i) => n.childNodes[i] === child)), true, 'restore renderer-owned nodes, not HTML clones');
    assert.equal(await source.getAttribute('style'), await page.evaluate(() => window.nativeStyle));
    assert.equal(state.commits.length, 0);
  }, { width, hasTouch: width === 390 });
  for (const width of [1280, 390]) await check(`Native unified: labeled controls stay beside their own block at ${width}px`, async ({ page, chat, settle }) => {
    assert.equal(await chat.locator('[data-ctxkit-for="15:0"]').isVisible(), false, 'Thinking action stays in its collapsed group, not under the answer');
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden')); await settle();
    const thinking = chat.locator('[data-ctxkit-for="15:0"]');
    const answer = chat.locator('[data-ctxkit-for="15:2"]');
    const user = chat.locator('[data-ctxkit-for="8:0"]');
    assert.match(await thinking.locator('button').textContent(), /Edit thinking/);
    assert.match(await answer.locator('button').textContent(), /Edit answer/);
    assert.match(await user.locator('button').textContent(), /Edit message/);
    assert.equal(await thinking.evaluate(n => n.previousElementSibling?.matches('[data-variant="think"]')), true);
    assert.equal(await user.evaluate(n => n.previousElementSibling?.classList.contains('Sixlwa_bubble')), true);
    assert.equal(await answer.evaluate(n => n.previousElementSibling?.classList.contains('_markdown_kcgor_5')), true);
    // FALSIFICATION OF THE VISIBLE CHIP, in both the shapes it had: first a labelled row BELOW its
    // block, then a labelled chip seated on the block's corner. Neither may come back. The pin now
    // paints nothing at rest, its button is the visually-hidden keyboard path, and the thing a
    // reader clicks is the marked message text.
    assert.equal(await page.evaluate(() => document.head.querySelector('style[data-ctxkit-affordance]') !== null), true,
      'the hover affordance must be a document rule, because the regions are the shell\'s own nodes');
    for (const [name, pin] of [['thinking', thinking], ['answer', answer], ['user', user]]) {
      const resting = await pin.evaluate((n) => {
        const box = n.getBoundingClientRect(), button = n.shadowRoot.querySelector('button');
        const b = button.getBoundingClientRect(), style = getComputedStyle(button);
        return { pinW: Math.round(box.width), pinH: Math.round(box.height),
          buttonW: Math.round(b.width), buttonH: Math.round(b.height), clip: style.clipPath,
          regions: (n.regions || []).length,
          marked: (n.regions || []).every((region) => region.getAttribute('data-ctxkit-edit') === ''),
          own: (n.regions || []).includes(n.anchor),
          plant: n.getAttribute('data-ctxkit-plant') !== null || n.style.getPropertyValue('--ctxkit-pin-lift') !== '' };
      });
      assert.equal(resting.plant, false, `${name}: the seated-chip placement must be gone`);
      assert.equal(resting.pinW, 0, `${name}: the pin must take no room at rest (got ${resting.pinW}px)`);
      assert.equal(resting.pinH, 0, `${name}: the pin must take no height at rest (got ${resting.pinH}px)`);
      assert.ok(resting.buttonW <= 1 && resting.buttonH <= 1,
        `${name}: the chip must collapse to the visually-hidden square (got ${resting.buttonW}x${resting.buttonH})`);
      assert.match(resting.clip, /inset\(50%\)/u, `${name}: the collapsed chip must clip itself away`);
      assert.ok(resting.regions >= 1 && resting.marked, `${name}: every region it answers for must carry the edit mark`);
      assert.ok(resting.own, `${name}: the block it edits must be one of those regions`);
      assert.equal(await pin.locator('button svg').count(), 0, `${name}: the pencil glyph must be gone`);
    }
    // No chip in any state. Focus stays on the visually-hidden pin, so the reader sees the glow the
    // document stylesheet puts on the marked block instead; only a coarse pointer keeps a target.
    const focused = await thinking.evaluate(async (n) => {
      const button = n.shadowRoot.querySelector('button');
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const box = button.getBoundingClientRect();
      const marked = n.parentElement?.querySelector('[data-ctxkit-edit]') ?? document.querySelector('[data-ctxkit-edit]');
      return { width: Math.round(box.width), height: Math.round(box.height), focused: n.matches(':focus-within'), coarse: matchMedia('(pointer: coarse)').matches, glow: marked === null ? 'none' : getComputedStyle(marked).boxShadow };
    });
    assert.equal(focused.focused, true, 'the pin must keep keyboard focus while it is the control');
    if (focused.coarse) assert.ok(focused.width >= 44 && focused.height >= 44, `the coarse-pointer pin must keep a touch target (got ${focused.width}x${focused.height})`);
    else assert.ok(focused.width <= 1 && focused.height <= 1, `the pin must never paint a chip for a fine pointer (got ${focused.width}x${focused.height})`);
    assert.notEqual(focused.glow, 'none', 'the marked block must carry the focus glow the chip no longer paints');
    await page.screenshot({ path: join(home, `native-actions-${width}.png`) });
  }, { width, hasTouch: width === 390 });
  for (const width of [1280, 390]) await check(`Thinking in-place: same body, typography and scroll at ${width}px`, async ({ page, chat, state, refresh, settle }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    const body = chat.locator('.lcKema_thinkBody');
    const longText = Array.from({ length: 40 }, (_, i) => `Line ${i}: native Thinking wraps without a nested scroll box.`).join('\n\n');
    state.sessions.A[1].targets[0] = target(0, 'reasoning', longText);
    await body.evaluate((n, text) => { n.textContent = text; }, longText);
    await refresh(); await settle();
    await body.evaluate(n => {
      n.style.cssText = 'padding:4px 0 4px 22px;color:rgb(173,178,184);font:18px/30px sans-serif;white-space:pre-wrap;word-break:break-word';
      n.closest('main').style.cssText = 'height:480px;overflow:auto';
      window.thinkSource = n;
      n.closest('main').scrollTop = 80;
    });
    // Keep native typography and focus position while bounding only the editing height.
    await page.evaluate(() => {
      window.thinkGeometry = () => {
        const n = window.thinkSource, r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return { top: r.top, height: r.height, width: r.width, font: s.font, padding: s.padding,
          color: s.color, scroll: n.closest('main').scrollTop, page: scrollY };
      };
    });
    await settle();
    const before = await page.evaluate(() => window.thinkGeometry());
    await openTarget(chat, '15:0');
    await settle();
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only', 'edit the original thinkBody, not a sibling card');
    assert.equal(await body.evaluate(n => n === window.thinkSource && document.activeElement === n), true);
    const during = await page.evaluate(() => window.thinkGeometry());
    assert.ok(during.height <= Math.min(420, 900 * .45) + 1);
    assert.deepEqual({ ...during, height: before.height }, before);
    assert.equal(await body.evaluate(n => n.scrollHeight > n.clientHeight && getComputedStyle(n).overflowY === 'auto'), true);
    assert.equal(await chat.locator('[data-ctxkit-inline] textarea:visible').count(), 0);
    const firstLine = await body.evaluate(n => {
      const range = document.createRange(); range.selectNodeContents(n);
      return range.getClientRects()[0].top;
    });
    for (const button of await chat.locator('[data-ctxkit-inline] button:visible').all()) {
      const bounds = await button.boundingBox();
      assert.ok(bounds.y >= firstLine + 30, 'Thinking toolbar is below text, never over its first line');
    }
    await page.screenshot({ path: join(home, `thinking-in-place-${width}.png`) });
    await body.fill('UNSAVED');
    await body.press('Escape'); await confirmEdit(page); await settle();
    assert.equal(await body.getAttribute('contenteditable'), null);
    const after = await page.evaluate(() => window.thinkGeometry());
    assert.deepEqual({ ...after, top: before.top, scroll: before.scroll }, before);
    assert.ok(await chat.locator('[data-ctxkit-for="15:0"]').evaluate(n => {
      const r = n.getBoundingClientRect(), parent = n.closest('main').getBoundingClientRect();
      return r.top >= parent.top && r.bottom <= parent.bottom;
    }), 'Cancel keeps the bottom action in view rather than jumping back to the top of a long body');
  }, { width, hasTouch: width === 390, rows: [fixtures()[0], entry(15, [target(0, 'reasoning', '**THINK A**\nsecond line'), target(2, 'text', 'ANSWER')])] });
  await check('Thinking in-place: literal multiline save, reopen and restore keep the native body', async ({ page, chat, state, settle }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await openTarget(chat, '15:0');
    const body = chat.locator('.lcKema_thinkBody');
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only');
    await body.fill('LINE ONE'); await body.press('End'); await body.press('Enter');
    await page.keyboard.insertText('<em>literal</em>');
    await body.press('Control+Enter'); await settle();
    assert.equal(state.commits.at(-1).text, 'LINE ONE\n<em>literal</em>');
    assert.equal(state.commits.at(-1).block, 0);
    assert.equal(state.commits.at(-1).expected, '**THINK A**\nsecond line');
    assert.equal(await body.innerText(), 'LINE ONE\n<em>literal</em>');
    assert.equal(await body.locator('em').count(), 0);
    assert.equal(await body.evaluate(n => getComputedStyle(n).display !== 'none'), true);
    assert.equal(await body.getAttribute('contenteditable'), null);
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'ANSWER');
    await openTarget(chat, '15:0');
    assert.equal(await body.innerText(), 'LINE ONE\n<em>literal</em>');
    await chat.locator('[data-ctxkit-inline] .restore').click(); await confirmEdit(page); await settle();
    assert.equal(state.commits.at(-1).restore, true);
    assert.equal(await body.innerText(), '**THINK A**\nsecond line');
    assert.equal(state.sessions.A[1].targets[1].text, 'ANSWER');
  });
  await check('Thinking in-place: busy, refusal, composition and retry preserve the draft', async ({ page, chat, state, settle, hold }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await openTarget(chat, '15:0');
    const body = chat.locator('.lcKema_thinkBody');
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only');
    await body.fill('RETRY THINK');
    await body.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await body.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    assert.equal(state.commits.length, 0);
    state.commitError = 'stale expected text; reload';
    const pending = hold('commit');
    try {
      await body.press('Control+Enter'); await pending.started;
      assert.equal(await body.getAttribute('contenteditable'), 'false');
      assert.equal(await chat.locator('[data-ctxkit-inline] .cancel').isDisabled(), true);
    } finally { pending.release(); }
    await settle();
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only');
    assert.equal(await body.innerText(), 'RETRY THINK');
    assert.match(await chat.locator('[data-ctxkit-inline] .why').innerText(), /stale expected/);
    state.commitError = null;
    await body.press('Meta+Enter'); await settle();
    assert.equal(await body.innerText(), 'RETRY THINK');
    assert.equal(state.commits.length, 2);
  });
  for (const change of ['replace', 'rewrite', 'collapse']) await check(`Thinking in-place: ${change} recovers the last typed draft`, async ({ page, chat, panel, row, state, settle }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await openTarget(chat, '15:0');
    const body = chat.locator('.lcKema_thinkBody');
    assert.equal(await body.getAttribute('contenteditable'), 'plaintext-only');
    await body.fill('KEEP THINK DRAFT');
    if (change === 'collapse') await chat.locator('[data-fold]').click();
    else await body.evaluate((n, change) => {
      if (change === 'replace') { const replacement = n.cloneNode(false); replacement.textContent = 'HOST RERENDER'; n.replaceWith(replacement); }
      else n.textContent = 'HOST RERENDER';
    }, change);
    await settle();
    assert.equal(await panel.locator('dialog.wrap').isVisible(), true);
    assert.equal(await row(15).locator('textarea').inputValue(), 'KEEP THINK DRAFT');
    if (change === 'rewrite') assert.equal(await body.textContent(), 'HOST RERENDER', 'cleanup must not overwrite a host update');
    assert.equal(state.commits.length, 0);
  });
  await check('Thinking in-place: rich paste stays plain and session switches retain the draft', async ({ page, chat, row, state, settle, switchSession }) => {
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await chat.locator('[data-fold]').click();
    await openTarget(chat, '15:0');
    const body = chat.locator('.lcKema_thinkBody');
    const source = await body.elementHandle();
    await body.fill('');
    await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob(['<b>RICH</b><br>PASTE'], { type: 'text/html' }),
      'text/plain': new Blob(['RICH\nPASTE'], { type: 'text/plain' })
    })]));
    await body.press('Control+V'); await settle();
    assert.equal(await body.innerText(), 'RICH\nPASTE');
    assert.equal(await body.locator('b').count(), 0);
    await switchSession('B');
    assert.equal(await source.evaluate(n => n.getAttribute('contenteditable')), null);
    assert.equal(await source.textContent(), '**THINK A**\nsecond line');
    await switchSession('A');
    await openTarget(chat, '15:0');
    await row(15).locator('textarea').waitFor();
    assert.equal(await row(15).locator('textarea').inputValue(), 'RICH\nPASTE');
    assert.equal(state.commits.length, 0);
  });
  await check('UX: inline refusal keeps the reason and draft, then allows retry', async ({ page, panel, chat, state, settle }) => {
    await openTarget(chat, '15:2');
    const inline = chat.locator('[data-ctxkit-inline]');
    await chat.locator('[contenteditable]').fill('KEEP THIS DRAFT');
    state.sessions.A[1].targets[1].text = 'EXTERNAL CHANGE';
    await inline.locator('.save').click(); await settle();
    assert.match(await inline.locator('.why').innerText(), /stale expected text; reload/);
    assert.equal(await chat.locator('[contenteditable]').innerText(), 'KEEP THIS DRAFT');
    assert.equal(await inline.locator('.save').isEnabled(), true);
    assert.equal(await inline.locator('.why').evaluate(n => getComputedStyle(n).color), 'rgb(255, 154, 154)');
    assert.match(await chat.locator('[contenteditable]').getAttribute('aria-description'), /stale expected/);
    assert.equal(await panel.locator('.notice').isVisible(), false, 'inline errors should not also cover the composer');
    state.sessions.A[1].targets[1].text = 'ANSWER';
    await inline.locator('.save').click(); await inline.waitFor({ state: 'detached' });
    assert.equal(state.sessions.A[1].text, 'KEEP THIS DRAFT');
  });
  await check('UX: long refusal stays inside narrow inline editor', async ({ chat, state, settle }) => {
    await openTarget(chat, '15:2');
    const inline = chat.locator('[data-ctxkit-inline]');
    state.commitError = 'Unavailable: ' + 'long-server-diagnostic-'.repeat(40);
    await chat.locator('[contenteditable]').fill('RETRY ME'); await inline.locator('.save').click(); await settle();
    assert.ok((await inline.locator('.why').innerText()).includes(state.commitError));
    assert.equal(await inline.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  }, { width: 320, hasTouch: true });
  for (const mode of ['inline', 'panel']) await check(`UX: ${mode} save has explicit busy state and blocks conflicting actions`, async ({ page, panel, chat, row, open, hold, settle }) => {
    if (mode === 'inline') await openTarget(chat, '15:2');
    else await open(15);
    const editor = mode === 'inline' ? chat.locator('[data-ctxkit-inline]') : row(15);
    const surface = mode === 'inline' ? chat.locator('[contenteditable]') : editor.locator('textarea');
    await surface.fill('BUSY DRAFT');
    const pending = hold('commit');
    try {
      await editor.locator('.save').click(); await pending.started;
      assert.equal(await editor.locator('.save').innerText(), 'Saving...');
      if (mode === 'inline') assert.equal(await surface.getAttribute('contenteditable'), 'false');
      else assert.equal(await surface.getAttribute('readonly'), '');
      assert.equal(await editor.locator('.cancel').isDisabled(), true);
      assert.equal(await editor.locator('select').isDisabled(), true);
      assert.equal(await editor.locator('.restore').isDisabled(), true);
      if (mode === 'inline') assert.equal(await editor.locator('li.row').getAttribute('aria-busy'), 'true');
      else assert.equal(await editor.getAttribute('aria-busy'), 'true');
    } finally { pending.release(); }
    await settle();
    assert.equal(await panel.locator('footer').getAttribute('class'), 'good');
  });
  await check('UX: panel Ctrl+Enter and Cmd+Enter save the selected target', async ({ page, panel, row, state, open, settle }) => {
    await open(15);
    for (const key of ['Control+Enter', 'Meta+Enter']) {
      await row(15).locator('textarea').fill(key);
      await row(15).locator('textarea').press(key); await settle();
      assert.equal(state.commits.at(-1)?.text, key);
      assert.equal(state.commits.at(-1)?.block, 2);
      assert.equal(await row(15).locator('textarea').isVisible(), false);
      await row(15).locator('.edit').click();
    }
    assert.equal(await row(15).locator('.save').getAttribute('aria-keyshortcuts'), 'Control+Enter Meta+Enter');
  });
  await check('UX: composing text does not trigger save or Escape cancellation', async ({ page, chat, state, settle }) => {
    await openTarget(chat, '15:2');
    const inline = chat.locator('[data-ctxkit-inline]');
    const area = chat.locator('[contenteditable]');
    await area.fill('UNFINISHED COMPOSITION');
    let dialogs = 0;
    page.on('dialog', async d => { dialogs++; await d.dismiss(); });
    await area.evaluate(n => {
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, isComposing: true }));
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, composed: true, isComposing: true }));
    });
    await settle();
    assert.equal(dialogs, 0, 'IME Escape must not ask to discard the draft');
    assert.equal(state.commits.length, 0, 'IME Enter must not submit a half-composed draft');
    assert.equal(await area.innerText(), 'UNFINISHED COMPOSITION');
  });
  await check('UX: clicking the active text focuses its draft without asking to discard it', async ({ page, chat, state, settle }) => {
    const answer = chat.locator('._markdown_kcgor_5');
    const control = chat.locator('[data-ctxkit-for="15:2"] button').first();
    await answer.click(); await settle();
    const area = chat.locator('[contenteditable]');
    await area.fill('SAME DRAFT'); await settle();
    const requests = state.requests.length;
    let dialogs = 0;
    page.on('dialog', async d => { dialogs++; await d.dismiss(); });
    // Re-activating the target while its editor is open must focus that draft, not ask to throw it
    // away. The surface itself refuses the click (it is the editor), so this goes through the
    // control's own action - the same one the collapsed chip's keyboard activation runs.
    await control.dispatchEvent('click'); await settle();
    assert.equal(dialogs, 0);
    assert.equal(await area.innerText(), 'SAME DRAFT');
    assert.equal(await area.evaluate(n => n === n.getRootNode().activeElement), true);
    assert.equal(state.requests.length, requests, 'the active editor needs no additional fetch');
  });
  await check('the words are the button: a user bubble is the target and its click opens the editor', async ({ page, chat, settle }) => {
    const bubble = chat.locator('[data-ctxkit-edit][class*="bubble"]').first();
    assert.ok(await bubble.count() > 0, 'the user bubble itself must carry the edit mark');
    assert.equal(await chat.locator('[data-ctxkit-edit][class*="actions"]').count(), 0, 'the empty strip below a message must not be a target');
    // A message that carries an image beside its words is editable exactly like a plain one,
    // and the image is never the thing that gets hidden to make room for the editor.
    const attached = chat.locator('[data-message-attachments] img').first();
    assert.equal(await attached.isVisible(), true, 'the fixture must show an image beside the words');
    await bubble.click(); await settle();
    assert.ok(await chat.locator('[data-ctxkit-inline]').count() >= 1, 'clicking the words of a user message must open its editor');
    assert.equal(await attached.isVisible(), true, 'the open editor must leave the image beside the words visible');
    assert.equal(await attached.evaluate(n => n.isConnected), true, 'the image must not be replaced by the editor');
    await chat.locator('[data-ctxkit-inline] .cancel').click(); await settle();
  });
  for (const mode of ['inline', 'panel']) await check(`UX: ${mode} touch controls fit a narrow viewport`, async ({ page, panel, chat, row, open }) => {
    if (mode === 'inline') await openTarget(chat, '15:2');
    else await open(15);
    const editor = mode === 'inline' ? chat.locator('[data-ctxkit-inline]') : row(15);
    if (mode === 'panel') assert.ok(await editor.locator('textarea').evaluate(n => parseFloat(getComputedStyle(n).fontSize) >= 16), 'panel input must not use tiny desktop type');
    else assert.equal(await chat.locator('[contenteditable]').evaluate(n => getComputedStyle(n).fontSize), '14px', 'native editing inherits Chat typography');
    const visible = mode === 'panel' ? await panel.locator('ul.list').boundingBox() : { y: 0, height: 640 };
    for (const selector of mode === 'panel' ? ['.save', '.cancel', '.restore', 'select'] : ['.save', '.cancel']) {
      const box = await editor.locator(selector).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${selector} must have a usable touch target`);
      assert.ok(box.x >= 0 && box.x + box.width <= 320, `${selector} must fit the viewport`);
      assert.ok(box.y >= visible.y && box.y + box.height <= visible.y + visible.height,
        `${selector} must be visible when the editor opens, not clipped below the panel: ${JSON.stringify({ box, visible })}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(home, `ux-${mode}-touch.png`) });
  }, { width: 320, height: 640, hasTouch: true });
  for (const width of [1280, 390]) await check(`Copy icons: native artwork, tooltip and compact controls at ${width}`, async ({ page, chat, state, refresh, settle }) => {
    await chat.locator('[data-native-copy]').first().evaluate(button => {
      button.className = 'xzv4MW_action'; button.setAttribute('aria-label', 'Copy');
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path data-native-art="copy" d="M5 5h8v8H5zM3 10H2V2h8v1" stroke="currentColor"/></svg>';
      window.copyOriginal = button; window.copyOriginalHTML = button.outerHTML;
    });
    await chat.locator('._markdown_kcgor_5').evaluate(source => {
      const block = document.createElement('div'); block.className = 'md-code-block';
      block.innerHTML = '<div data-code-block-banner><button class="_copyButton_rsn9u_62" type="button">Copy</button></div><div data-code-block-content><pre><code>NATIVE CODE</code></pre></div>';
      source.after(block);
      const button = block.querySelector('button'); window.codeCopyText = button.firstChild;
      button.onclick = async () => {
        await navigator.clipboard.writeText('NATIVE CODE'); button.firstChild.nodeValue = 'Copied';
        setTimeout(() => { button.firstChild.nodeValue = 'Copy'; }, 1000);
      };
    });
    for (const entry of state.sessions.A.slice(0, 2)) {
      for (const target of entry.targets) Object.assign(target, { text: target.text + ' EDITED', edited: true, changed: true, editStatus: 'applied' });
      Object.assign(entry, { text: entry.targets.filter(t => t.kind === 'text').map(t => t.text).join(''), edited: true, changed: true, editStatus: 'applied' });
    }
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden'));
    await refresh(); await settle();
    for (const label of ['message', 'answer', 'thinking']) {
      const copy = chat.getByRole('button', { name: 'Copy effective ' + label, exact: true });
      assert.equal(await copy.locator(':scope > svg [data-native-art="copy"]').count(), 1, 'reuse the native icon');
      assert.equal(await copy.evaluate(n => [...n.childNodes].some(c => c.nodeType === Node.TEXT_NODE && c.textContent.trim())), false, 'no visible Copy text');
      assert.equal(await copy.getAttribute('title'), 'Copy effective ' + label);
      const size = width === 390 ? 44 : 28;
      const box = await copy.boundingBox();
      assert.ok(Math.abs(box.width - size) < 0.01); assert.ok(Math.abs(box.height - size) < 0.01);
      await copy.hover();
      await copy.focus();
      assert.equal(await copy.evaluate(n => n === n.getRootNode().activeElement), true);
    }
    assert.equal(await page.evaluate(() => window.copyOriginal.isConnected && window.copyOriginal.outerHTML === window.copyOriginalHTML), true, 'native Copy stays untouched');
    const codeCopy = chat.locator('[data-code-block-banner] button');
    assert.equal(await codeCopy.getAttribute('title'), 'Copy');
    assert.equal(await codeCopy.evaluate(n => getComputedStyle(n).fontSize), '0px');
    assert.match(await codeCopy.evaluate(n => getComputedStyle(n, '::before').maskImage), /data:image\/svg\+xml/, 'native code Copy must show an icon');
    assert.equal(await codeCopy.evaluate(n => n.firstChild === window.codeCopyText), true, 'do not replace React-owned text nodes');
    await codeCopy.click();
    await page.waitForFunction(() => document.querySelector('[data-code-block-banner] button').title === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'NATIVE CODE');
    await page.waitForFunction(() => document.querySelector('[data-code-block-banner] button').title === 'Copy');
    assert.equal(await codeCopy.evaluate(n => n.firstChild === window.codeCopyText), true);
    await page.screenshot({ path: join(home, `copy-icons-${width}.png`) });
  }, { width, hasTouch: width === 390 });
  await check('UX: effective copy confirms success and recovers after clipboard refusal', async ({ page, panel, chat, open, save }) => {
    await open(15); await save(15, 'COPY THIS'); await panel.locator('header .x').click();
    const copy = chat.locator('[data-ctxkit-projection]').getByRole('button', { name: 'Copy effective answer', exact: true });
    await copy.click();
    await copy.filter({ hasText: /^Copied$/ }).waitFor();
    assert.equal(await copy.innerText(), 'Copied');
    assert.equal(await copy.getAttribute('title'), 'Copied');
    assert.equal(await copy.locator('svg').count(), 1, 'success must remain icon-only');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'COPY THIS');
    await page.evaluate(() => {
      window.originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable'); };
    });
    await copy.click();
    await copy.filter({ hasText: /Copy failed/ }).waitFor();
    assert.match(await copy.innerText(), /Copy failed/);
    assert.match(await copy.getAttribute('title'), /Copy failed/);
    assert.equal(await copy.locator('svg').count(), 1, 'failure must remain icon-only');
    await page.evaluate(() => { navigator.clipboard.writeText = window.originalWriteText; });
    await copy.click();
    await copy.filter({ hasText: /^Copied$/ }).waitFor();
    assert.equal(await copy.innerText(), 'Copied');
    assert.equal(await copy.isEnabled(), true);
  });
  for (const width of [1280, 390]) await check(`inline user and answer edit/restore at ${width}px`, async ({ page, panel, chat, state, settle }) => {
    const original = await chat.locator('.Sixlwa_bubble').innerHTML();
    for (const [key, initial, changed] of [['8:0', 'QUESTION', 'USER INLINE'], ['15:2', 'ANSWER', 'ANSWER INLINE']]) {
      await openTarget(chat, key);
      const inline = chat.locator('[data-ctxkit-inline]');
      const surface = chat.locator('[contenteditable]');
      await surface.waitFor();
      assert.equal(await panel.locator('dialog.wrap').isVisible(), false);
      assert.equal(await surface.innerText(), initial);
      assert.equal(await inline.locator('.restore').isDisabled(), true);
      assert.equal(await inline.evaluate(n => n.getBoundingClientRect().right <= innerWidth && n.scrollWidth <= n.clientWidth), true);
      await surface.fill(changed);
      await inline.locator('.save').click(); await inline.waitFor({ state: 'detached' }); await settle();
      const current = key.startsWith('8:') ? '108:0' : key;
      await openTarget(chat, current);
      await surface.waitFor();
      assert.equal(await surface.innerText(), changed);
      await inline.locator('.restore').click(); await confirmEdit(page, false);
      assert.equal(await surface.innerText(), changed);
      await inline.locator('.restore').click(); await confirmEdit(page);
      await inline.waitFor({ state: 'detached' }); await settle();
      assert.equal(state.commits.at(-1).restore, true);
      assert.equal(state.commits.at(-1).expected, changed);
    }
    assert.equal(state.sessions.A[0].text, 'QUESTION');
    assert.equal(state.sessions.A[1].text, 'ANSWER');
    assert.equal(await chat.locator('.Sixlwa_bubble').innerHTML(), original);
    await openTarget(chat, '208:0');
    await page.screenshot({ path: join(home, `inline-${width}.png`) });
  }, { width });
  await check('inline Thinking preserves disclosures and Answer and cancels dirty drafts safely', async ({ page, panel, chat, state, settle }) => {
    await chat.locator('[data-chat-flow-kind="assistant-step"]').evaluate(node => {
      const process = document.createElement('div');
      process.dataset.chatFlowKey = '12:turn-process15'; process.dataset.chatFlowKind = 'turn-process';
      process.innerHTML = '<button data-turn-process="15" aria-expanded="false">Thought for a while</button>';
      node.before(process);
    });
    await chat.locator('[data-turn-process]').click();
    await openTarget(chat, '15:0');
    const inline = chat.locator('[data-ctxkit-inline]');
    const body = chat.locator('[data-ctxkit-surface][contenteditable="plaintext-only"]');
    await body.waitFor();
    assert.equal(await inline.evaluate(n => n.checkVisibility()), true);
    assert.equal(await chat.locator('[data-turn-process]').getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.locator('dialog.wrap').isVisible(), false);
    assert.equal(await chat.locator('[data-fold]').getAttribute('aria-expanded'), 'false');
    await body.fill('THINK INLINE');
    await body.press('Escape'); await confirmEdit(page, false);
    assert.equal(await body.innerText(), 'THINK INLINE');
    await openTarget(chat, '8:0');
    await confirmEdit(page, false);
    assert.equal(await chat.locator('[data-ctxkit-inline]').count(), 1);
    assert.equal(await body.innerText(), 'THINK INLINE');
    await body.press('Control+Enter');
    await inline.waitFor({ state: 'detached' }); await settle();
    assert.equal(state.sessions.A[1].targets[0].text, 'THINK INLINE');
    assert.equal(state.sessions.A[1].targets[1].text, 'ANSWER');
  });
  await check('inline session draft survives leaving and returning through a pencil', async ({ panel, chat, row, state, switchSession }) => {
    await openTarget(chat, '15:2');
    await chat.locator('[contenteditable]').fill('UNSAVED INLINE SESSION A');
    await switchSession('B');
    assert.equal(await chat.locator('[data-ctxkit-inline]').count(), 0);
    await switchSession('A');
    await openTarget(chat, '15:2');
    await row(15).locator('textarea').waitFor();
    assert.equal(await row(15).locator('textarea').inputValue(), 'UNSAVED INLINE SESSION A');
    assert.equal(await panel.locator('.row.open').count(), 1);
    assert.equal(state.commits.length, 0);
  });
  await check('inline removal recovers draft in panel; unknown layout uses panel without hiding text', async ({ page, panel, chat, row, settle }) => {
    await openTarget(chat, '15:2');
    const inline = chat.locator('[data-ctxkit-inline]');
    await chat.locator('[contenteditable]').fill('KEEP REMOVED DRAFT');
    await chat.locator('._markdown_kcgor_5').evaluate(n => n.remove()); await settle();
    await panel.locator('dialog.wrap').waitFor({ state: 'visible' });
    assert.equal(await panel.locator('dialog.wrap').isVisible(), true);
    assert.equal(await row(15).locator('textarea').inputValue(), 'KEEP REMOVED DRAFT');
    await panel.locator('header .x').click(); await confirmEdit(page);
    await openTarget(chat, '15:2');
    await panel.locator('dialog.wrap').waitFor({ state: 'visible' });
    assert.equal(await panel.locator('dialog.wrap').isVisible(), true);
    assert.equal(await chat.locator('[data-ctxkit-inline]').count(), 0);
  });
  for (const [key, name] of [
    ['8:0', 'Edit message (seq 8, block 0)'],
    ['15:2', 'Edit answer (seq 15, block 2)'],
    ['15:0', 'Edit thinking (seq 15, block 0)']
  ]) await check(`pencil accessible name: ${name}`, async ({ chat }) => {
    const pin = chat.locator(`[data-ctxkit-for="${key}"]`);
    assert.equal(await pin.locator('button').getAttribute('title'), name);
    assert.equal(await pin.getByRole('button', { name, exact: true, includeHidden: true }).count(), 1,
      'the accessible name must include the target and position, not just the pencil glyph');
  });
  await check('multi-target chooser accessible name includes choose-a-block instruction', async ({ page, chat, state, refresh, settle }) => {
    state.sessions.A[1].targets.push(target(6, 'text', 'SECOND ANSWER'));
    await refresh(); await settle();
    const pin = chat.locator('[data-ctxkit-for="15"]');
    const name = 'Edit message (choose a block)';
    assert.equal(await pin.locator('button').getAttribute('title'), name);
    assert.equal(await pin.getByRole('button', { name, exact: true }).count(), 1,
      'the chooser accessible name must match its final title');
    // And the text of that message opens the block chooser rather than guessing a block: a
    // chooser names no block of its own, so it answers for every text region of its message.
    await chat.locator('._markdown_kcgor_5').click(); await settle();
    const chooserState = await chat.locator('[data-ctxkit-for="15"]').evaluate((n) => ({
      regions: (n.regions || []).map((region) => region.tagName.toLowerCase() + '.' + String(region.className || '').split(' ')[0]
        + '[mark=' + (region.hasAttribute('data-ctxkit-edit') ? 'yes' : 'no') + ']'),
      anchor: n.anchor.tagName.toLowerCase() + '.' + String(n.anchor.className || '').split(' ')[0],
      action: typeof n.open, buttonHidden: n.shadowRoot.querySelector('button').hidden,
    }));
    const surfaceState = {
      inline: await chat.locator('[data-ctxkit-inline]').count(),
      editable: await chat.locator('[contenteditable]').count(),
      modal: await page.locator('#dsh-context-kit-editor dialog.wrap').isVisible(),
    };
    // A message with more than two targets has no single block to open, so the panel answers with
    // its chooser surface (the named panel, not an inline editor). What matters is that the text
    // opened an editor and that every block is on offer, rather than one of them being guessed.
    assert.ok(surfaceState.modal || surfaceState.inline === 1,
      `clicking the text of a message with more than two targets must open its editor (${JSON.stringify(chooserState)} ${JSON.stringify(surfaceState)})`);
    const offers = await page.locator('#dsh-context-kit-editor select.target option').count();
    assert.equal(offers, 3, 'the chooser must offer every block instead of opening one of them');
    await page.locator('#dsh-context-kit-editor').getByRole('button', { name: 'Close', exact: true }).click(); await settle();
  });
  await check('the glow follows the text, and the keyboard still gets a chip', async ({ page, panel, chat, settle }) => {
    assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), true);
    const pin = chat.locator('[data-ctxkit-for="8:0"]');
    const button = pin.locator('button');
    const region = chat.locator('.Sixlwa_bubble');
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1');
    // THE GLOW IS THE AFFORDANCE NOW, AND IT SITS ON THE TEXT. A real pointer over the marked
    // region must paint the ring and halo that say "click and you are editing", and leaving must
    // take them away. Before this redesign the glow lived on a chip, so a plain hover on the text
    // is the falsification.
    const paint = () => region.evaluate(n => {
      const style = getComputedStyle(n);
      return { outline: style.outlineStyle + ' ' + style.outlineWidth, shadow: style.boxShadow };
    });
    await page.mouse.move(0, 0); await settle();
    assert.deepEqual(await paint(), { outline: 'none 0px', shadow: 'none' }, 'resting text must not glow');
    await region.hover(); await settle();
    const hovered = await paint();
    assert.match(hovered.outline, /solid 2px/u, `the hovered text must take a ring, got: ${JSON.stringify(hovered)}`);
    assert.match(hovered.shadow, /14px 3px/u, `the hovered text must take a halo, got: ${JSON.stringify(hovered)}`);
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1');
    await panel.locator('.launch').hover(); await settle();
    assert.deepEqual(await paint(), { outline: 'none 0px', shadow: 'none' }, 'the glow must leave with the pointer');
    assert.equal(await pin.evaluate(n => n.style.opacity), '1');
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1');
    // The collapsed chip is not dead: focusing it keeps the reader's affordance on the text itself,
    // because no chip is painted in any state.
    await button.focus(); await settle();
    assert.equal(await button.evaluate(n => n === n.getRootNode().activeElement), true);
    assert.equal(await pin.evaluate(n => n.matches(':focus-within')), true);
    const shown = await button.boundingBox();
    assert.ok(shown.width <= 1 && shown.height <= 1, `the focused pin must stay collapsed (got ${shown.width}x${shown.height})`);
    const focused = await paint();
    assert.match(focused.outline, /solid 2px/u, `keyboard focus must ring the marked text, got: ${JSON.stringify(focused)}`);
    assert.match(focused.shadow, /14px 3px/u, `keyboard focus must halo the marked text, got: ${JSON.stringify(focused)}`);
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1',
      'keyboard focus must override the opacity left by mouseleave');
    await page.keyboard.press('Tab'); await settle();
    assert.equal(await pin.evaluate(n => n.matches(':focus-within')), false);
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1');
  });
  await check('the message text is the button: one click in, and the shell keeps every other click', async ({ page, chat, settle }) => {
    const answer = '._markdown_kcgor_5';
    const inline = () => chat.locator('[data-ctxkit-inline]').count();
    // The collapsed chip's keyboard activation comes first, while the row is untouched: the
    // pointer path must not have cost the keyboard one.
    await chat.locator('[data-ctxkit-for="15:2"] button').first().press('Enter'); await settle();
    assert.equal(await inline(), 1, 'Enter on the collapsed chip must open the editor');
    await chat.locator('[data-ctxkit-inline] .cancel').click(); await settle();
    assert.equal(await inline(), 0);
    // A plain click on the text opens the editor on exactly that block.
    await chat.locator(answer).click(); await settle();
    assert.equal(await inline(), 1, 'clicking the answer text must open its editor');
    assert.equal(await chat.locator('[contenteditable]').getAttribute('contenteditable'), 'plaintext-only');
    await chat.locator('[data-ctxkit-inline] .cancel').click(); await settle();
    assert.equal(await inline(), 0, 'the inline editor must close on Cancel');
    // A right click is the reader's own menu.
    await chat.locator(answer).click({ button: 'right' }); await settle();
    assert.equal(await inline(), 0, 'a right click must not open the editor');
    // A link, a piece of code and a control inside the text keep their own meaning.
    await chat.locator(answer).evaluate((n) => {
      const link = document.createElement('a');
      link.href = '#probe'; link.textContent = 'a link';
      link.addEventListener('click', (event) => event.preventDefault());
      const code = document.createElement('pre');
      code.innerHTML = '<code>probe()</code>';
      const control = document.createElement('button');
      control.type = 'button'; control.textContent = 'a control';
      n.append(link, code, control);
    });
    for (const selector of ['a', 'code', 'button']) {
      await chat.locator(`${answer} ${selector}`).click(); await settle();
      assert.equal(await inline(), 0, `a click on ${selector} inside the text must not open the editor`);
    }
    // A click made while text is selected belongs to the selection.
    await chat.locator(answer).evaluate((n) => {
      const range = document.createRange(); range.selectNodeContents(n);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.probeSelected = selection.toString().length;
    });
    assert.ok(await page.evaluate(() => window.probeSelected) > 0, 'the probe must have selected text');
    await chat.locator(answer).click(); await settle();
    assert.equal(await inline(), 0, 'a click made while text is selected must not open the editor');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    // And a drag that selects is left alone rather than opening underneath the selection.
    await page.mouse.move(0, 0);
    const box = await chat.locator(answer).boundingBox();
    await page.mouse.move(box.x + 4, box.y + 4); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 6 }); await page.mouse.up();
    await settle();
    assert.equal(await inline(), 0, 'selecting text with the mouse must not open the editor');
    assert.ok(await page.evaluate(() => document.getSelection().toString().length) > 0, 'the drag must still select text');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    // The user message answers for its own bubble, not for the row around it.
    await chat.locator('.Sixlwa_bubble').click(); await settle();
    assert.equal(await inline(), 1, 'clicking the user bubble must open its editor');
    assert.equal(await chat.locator('[data-ctxkit-inline]').evaluate(n => n.getAttribute('data-ctxkit-inline')), '8:0');
    await chat.locator('[data-ctxkit-inline] .cancel').evaluate(n => n.click()); await settle();
    assert.equal(await inline(), 0);
  });
  await check('touch/coarse: the collapsed chip stays visible to assistive tech without a hover state', async ({ page, panel, chat, settle }) => {
    assert.equal(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), true);
    const pin = chat.locator('[data-ctxkit-for="8:0"]');
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1');
    // A finger has no hover, and the chip has no room: the touch target is the message text, so
    // what must survive here is the chip's focusable presence, not any pointer state.
    await chat.locator('[data-ctxkit-for="8:0"]').evaluate((n) => n.closest('[data-chat-flow-key]').dispatchEvent(new Event('mouseenter')));
    await settle();
    assert.equal(await pin.evaluate(n => n.style.opacity), '1');
    assert.equal(await pin.evaluate(n => n.matches(':focus-within')), false);
    assert.equal(await pin.evaluate(n => getComputedStyle(n).opacity), '1',
      'hover-none visibility must override the opacity left by mouseleave without focus');
    const resting = await pin.evaluate((n) => {
      const box = n.getBoundingClientRect();
      return { width: box.width, height: box.height, focusable: !!n.shadowRoot.querySelector('button'),
        mark: (n.regions || []).some((region) => region.getAttribute('data-ctxkit-edit') === '') };
    });
    assert.equal(resting.width, 0, 'the touch pin must take no room either');
    assert.equal(resting.focusable, true, 'the touch pin must keep its focusable button');
    assert.equal(resting.mark, true, 'the touch pin must leave its text marked');
  }, { width: 390, hasTouch: true });
  await check('page-local controller: two tabs share storage, not selection or pending responses', async ({ page, context, panel, chat, row, state, open, hold, refresh, settle, save }) => {
    const pending = hold('list'); await refresh(); await pending.started;
    const other = await context.newPage();
    await other.goto('https://editor.invalid/'); await boot(other, 'B');
    pending.release(); await settle();
    assert.equal(await page.evaluate(() => window.view.getSnapshot().current), 'A');
    assert.match(await page.evaluate(() => localStorage.getItem('dsh.sessions.current')), /B/);
    await page.bringToFront();
    await open(15);
    assert.equal(await row(15).locator('textarea').inputValue(), 'ANSWER');
    await save(15, 'ONLY TAB A');
    assert.equal(state.commits.at(-1).sessionId, 'A');
    assert.equal(state.sessions.B[0].text, 'SESSION B');
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'ONLY TAB A');
    await panel.locator('header .x').click();
    await other.bringToFront();
    await other.locator('#dsh-context-kit-editor .launch').click();
    assert.equal(await other.locator('#dsh-context-kit-editor li[data-seq="15"] .text').innerText(), 'SESSION B');
    await other.close();
  });
  for (const width of [1280, 390]) await check(`startup selection: quiet waiting, automatic recovery and real errors at ${width}`, async ({ page, panel, chat, row, state, settle }) => {
    assert.equal(state.requests.length, 0, 'no session may be guessed before the bridge mounts');
    assert.equal(await panel.locator('.notice').isVisible(), false, 'normal startup must not show an error toast');
    assert.equal(await panel.locator('footer').getAttribute('class'), '');
    assert.match(await panel.locator('footer').textContent(), /Waiting for a conversation/);
    await page.evaluate(() => { window.view.setCurrent(undefined); window.mountClient(); });
    await settle();
    await panel.locator('.launch').click();
    assert.equal(state.requests.length, 0, 'a mounted bridge without selection must still fail closed');
    assert.equal(await panel.locator('footer').getAttribute('class'), '');
    assert.match(await panel.locator('footer').innerText(), /Waiting for a conversation/);
    await page.evaluate(() => window.view.setCurrent('A')); await settle();
    assert.equal(await row(15).locator('.text').innerText(), 'ANSWER');
    assert.equal(await chat.locator('[data-ctxkit-pencil]').count(), 3);
    await panel.locator('header .x').click();
    const requests = state.requests.length;
    await page.evaluate(() => window.view.setCurrent(undefined));
    assert.equal(await panel.locator('.notice').isVisible(), false, 'temporary selection gaps must not show an error toast');
    assert.equal(await chat.locator('[data-ctxkit-pencil]').count(), 0);
    await settle();
    assert.equal(state.requests.length, requests, 'no requests may use the departing session');
    assert.equal(await panel.locator('footer').getAttribute('class'), '');
    await page.evaluate(() => window.view.setCurrent('A')); await settle();
    assert.equal(await chat.locator('[data-ctxkit-pencil]').count(), 3, 'editing must recover automatically');
    assert.equal(await panel.locator('.notice').isVisible(), false);
    state.listError = true;
    await panel.locator('.launch').click(); await settle();
    assert.equal(await panel.locator('footer').getAttribute('class'), 'err', 'real list failures must remain visible');
    assert.match(await panel.locator('footer').innerText(), /list unavailable/);
    assert.equal(await chat.locator('[data-ctxkit-pencil]').count(), 0);
    assert.equal(state.commits.length, 0);
  }, { width, hasTouch: width === 390, mount: false });
  await check('controller bridge: late init, synchronous empty selection and disposal fail closed', async ({ page, panel, chat, row, state, open, save, settle }) => {
    assert.equal(state.requests.length, 0, 'storage is not authority before the client bridge mounts');
    await panel.locator('.launch').click();
    assert.match(await panel.locator('footer').innerText(), /Waiting for a conversation/);
    await page.evaluate(() => window.mountClient()); await settle();
    await row(15).locator('.edit').click(); await save(15, 'VISIBLE EFFECTIVE');
    await row(15).locator('.edit').click(); await row(15).locator('textarea').fill('UNSAVED');
    const commits = state.commits.length;
    const cleared = await page.evaluate(() => {
      window.view.setCurrent(undefined);
      return { rows: document.querySelector('#dsh-context-kit-editor').shadowRoot.querySelectorAll('li').length,
        projections: document.querySelectorAll('[data-ctxkit-projection], [data-ctxkit-pencil]').length };
    });
    assert.deepEqual(cleared, { rows: 0, projections: 0 }, 'cleanup must happen within the controller notification');
    assert.equal(await panel.locator('header .x').evaluate(n => n === n.getRootNode().activeElement), true);
    await settle(); assert.equal(state.commits.length, commits);
    await page.evaluate(() => window.view.setCurrent('A')); await settle();
    assert.equal(await row(15).locator('textarea').inputValue(), 'UNSAVED');
    await page.evaluate(() => window.disposeClient());
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0);
    assert.equal(await chat.locator('._markdown_kcgor_5').evaluate(n => n.style.display), '');
    assert.equal(await page.evaluate(() => window.view.subscribers()), 0);
    assert.match(await panel.locator('footer').innerText(), /Waiting for a conversation/);
  }, { mount: false });
  await check('fast provider dispose/remount reloads the same session and retained rows', async ({ page, panel, chat, row, state, settle }) => {
    await panel.locator('.launch').click(); await row(15).locator('.text').waitFor(); await settle();
    const source = await chat.locator('._markdown_kcgor_5').elementHandle();
    const lists = state.requests.filter(request => request.method.endsWith('.list')).length;
    state.sessions.A[1] = entry(15, [target(0, 'reasoning', '**THINK A**\nsecond line'),
      target(2, 'text', 'AFTER FAST RETURN', { edited: true, changed: true, editStatus: 'applied' })]);
    const cleared = await page.evaluate(() => {
      window.disposeClient();
      const rows = document.querySelector('#dsh-context-kit-editor').shadowRoot.querySelectorAll('li').length;
      window.mountClient();
      return rows;
    });
    assert.equal(cleared, 0);
    await settle();
    assert.equal(state.requests.filter(request => request.method.endsWith('.list')).length, lists + 1,
      'A -> unavailable -> A in one task must still fetch a fresh list');
    assert.equal(await row(15).locator('.text').innerText(), 'AFTER FAST RETURN');
    assert.equal(await chat.locator('[data-ctxkit-pencil]').count(), 3);
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'AFTER FAST RETURN');
    assert.equal(await source.evaluate(node => node.isConnected && node.checkVisibility()), true,
      'same-session provider recovery must keep the existing Chat rows usable');
  });
  await check('session transition refuses retained old Chat rows until the keyed boundary remounts', async ({ page, panel, chat, row, state, open, save, refresh, settle, hold, switchSession }) => {
    await open(15); await save(15, 'EDIT A');
    const oldSource = await chat.locator('._markdown_kcgor_5').elementHandle();
    state.sessions.B = [entry(15, [target(2, 'text', 'EDIT B', { edited: true, changed: true, editStatus: 'applied' })]),
      entry(99, [target(2, 'text', 'B LATE ROW', { edited: true, changed: true, editStatus: 'applied' })])];
    const pending = hold('list', 'B');
    await page.evaluate(html => {
      // This extra A row has no entry and has not reached the mutation-observer pass yet.
      document.querySelector('main > [data-chat-flow]').insertAdjacentHTML('beforeend', html);
      window.view.setCurrent('B');
    }, assistantRow(99));
    await pending.started;
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0);
    assert.equal(await oldSource.evaluate(node => node.style.display), '');
    pending.release(); await settle();
    assert.equal(await row(15).locator('.text').innerText(), 'EDIT B', 'the panel may load B before Chat finishes switching');
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0,
      'neither matched nor previously unowned A rows may receive B controls or projections');
    assert.deepEqual(await chat.locator('._markdown_kcgor_5').allTextContents(), ['ANSWER', 'ANSWER']);
    await refresh(); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0,
      'another fetch must not adopt recycled cross-session nodes');
    await switchSession('B');
    assert.equal(await oldSource.evaluate(node => node.isConnected), false);
    assert.equal(await chat.locator('[data-ctxkit-for="15:2"]').count(), 1);
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'EDIT B');
    assert.equal(await chat.locator('._markdown_kcgor_5').isVisible(), true);
  });
  await check('B2/B3/B5: answer default, selected chars, exclusive draft and target guard', async ({ page, row, open }) => {
    await open(15);
    assert.equal(await row(15).locator('textarea').inputValue(), 'ANSWER');
    assert.match(await row(15).locator('.meta').innerText(), /6 chars/);
    await row(15).locator('textarea').fill('UNSAVED');
    await row(8).locator('.edit').click();
    await confirmEdit(page, false);
    assert.equal(await row(15).locator('textarea').inputValue(), 'UNSAVED');
    assert.equal(await row(8).getAttribute('class'), 'row');
    await row(15).locator('select').selectOption('0');
    await confirmEdit(page, false);
    assert.equal(await row(15).locator('select').inputValue(), '2');
    assert.equal(await row(15).locator('textarea').inputValue(), 'UNSAVED');
    await row(8).locator('.edit').click();
    await confirmEdit(page);
    assert.equal(await page.locator('#dsh-context-kit-editor .row.open').count(), 1);
    assert.match(await page.locator('#dsh-context-kit-editor footer').innerText(), /message/i);
    await row(8).locator('.cancel').click();
    await row(16).locator('.edit').click();
    assert.equal(await row(16).locator('textarea').inputValue(), 'ONLY THINK');
  });
  await check('B2/B3: picker saves thinking explicitly; legacy user fallback says message', async ({ page, panel, row, state, open, save }) => {
    await open(15);
    await row(15).locator('select').selectOption('0');
    assert.equal(await row(15).locator('textarea').inputValue(), '**THINK A**\nsecond line');
    assert.match(await row(15).locator('.meta').innerText(), /23 chars/);
    await save(15, 'THINKING VIA PICKER');
    assert.equal(state.commits[0].block, 0);
    assert.equal(state.commits[0].expected, '**THINK A**\nsecond line');
    assert.match(await panel.locator('footer').innerText(), /thinking.*next model request/i);
    const user = state.sessions.A[0];
    delete user.targets;
    await panel.locator('header .x').click();
    await open(8);
    assert.match(await panel.locator('footer').innerText(), /message/i);
    assert.equal(await row(8).locator('textarea').inputValue(), 'QUESTION');
    assert.equal(await page.locator('main > [data-chat-flow] [data-ctxkit-for="8"] button').getAttribute('title'), 'Edit message (seq 8)');
  });
  await check('B1/B2/B4/B6: save effective answer, second expected, safe shadow projection and thinking fold', async ({ page, panel, chat, row, state, open, save, settle }) => {
    const trajectory = await page.locator('[data-trajectory-scroll]').innerHTML();
    await open(15);
    await save(15, 'ANSWER B <img onerror=alert(1)>');
    assert.equal(state.commits[0].block, 2);
    assert.equal(state.commits[0].expected, 'ANSWER');
    assert.match(await panel.locator('footer').innerText(), /answer.*next model request/i);
    assert.doesNotMatch(await row(15).locator('.meta').innerText(), /\bwire\b/);
    assert.match(await row(15).locator('.meta').innerText(), /edited/i);
    const effective = chat.locator('._markdown_kcgor_5');
    assert.equal(await effective.first().innerText(), 'ANSWER B <img onerror=alert(1)>');
    assert.equal(await effective.isVisible(), true, 'effective text stays in the native Markdown container');
    assert.equal(await effective.locator('img').count(), 0, 'edited HTML remains literal text');
    await panel.locator('header .x').click();
    await chat.locator('[data-ctxkit-projection]').getByRole('button', { name: 'Copy effective answer', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ANSWER B <img onerror=alert(1)>');
    assert.equal(await page.evaluate(() => window.nativeCopy()), 'ANSWER');
    await open(15);
    assert.equal(await row(15).locator('textarea').inputValue(), state.sessions.A[1].text);
    await save(15, 'ANSWER C');
    assert.equal(state.commits[1].expected, 'ANSWER B <img onerror=alert(1)>');
    await panel.locator('header .x').click();
    await open(15); await row(15).locator('select').selectOption('0');
    assert.equal(await row(15).locator('textarea').inputValue(), '**THINK A**\nsecond line');
    await save(15, '**THINK B**\nprivate second line');
    assert.equal(state.commits[2].expected, '**THINK A**\nsecond line');
    assert.match(await panel.locator('footer').innerText(), /thinking.*next model request/i);
    await panel.locator('header .x').click();
    const think = chat.locator('[data-variant="think"]');
    assert.equal(await chat.locator('[data-process-reasoning]').getAttribute('hidden'), 'until-found');
    await chat.locator('[data-process-reasoning]').evaluate(n => n.removeAttribute('hidden')); await settle();
    assert.equal(await think.locator('.effective-text').innerText(), 'THINK B');
    assert.equal(await think.locator('.lcKema_summaryText').evaluate(n => n.style.display), 'none');
    await think.evaluate(n => {
      const hidden = document.createElement('div'); hidden.className = 'lcKema_thinkBody'; hidden.hidden = true;
      hidden.textContent = 'HIDDEN ORIGINAL'; n.append(hidden);
    });
    await settle();
    assert.equal(await think.locator('.effective-text').count(), 1, 'a mounted but collapsed body must not reveal full thinking');
    await think.locator('.lcKema_thinkBody').evaluate(n => n.remove());
    await think.locator('[data-fold]').click(); await settle();
    assert.equal(await think.locator('.lcKema_thinkBody').innerText(), '**THINK B**\nprivate second line');
    assert.equal(await think.locator('.lcKema_thinkBody').evaluate(n => n.style.display), '');
    await think.locator('[data-fold]').click(); await settle();
    assert.equal(await think.locator('.effective-text').innerText(), 'THINK B');
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'ANSWER C');
    assert.equal(await chat.locator('[data-tool]').innerText(), 'TOOL ORIGINAL\nTool action');
    assert.equal(await chat.locator('img').count(), 2);
    assert.equal(await page.locator('[data-trajectory-scroll]').innerHTML(), trajectory);
    assert.equal(await page.locator('#outside [data-ctxkit-pencil]').count(), 0);
    assert.equal(await page.evaluate(() => window.originals.every(n => n.isConnected) && window.ledger.text === 'ANSWER'), true);
  });
  await check('B1/B4: durable provenance, repeated new seq, reload and transcript beyond 40', async ({ page, panel, chat, row, state, open, save, settle, refresh }) => {
    await open(8); await save(8, 'MESSAGE B');
    assert.equal(await chat.locator('.Sixlwa_bubble').innerText(), 'MESSAGE B', 'effective text stays in the native user bubble');
    await row(108).locator('.edit').click(); await save(108, 'MESSAGE C');
    assert.equal(state.commits[1].expected, 'MESSAGE B');
    assert.equal(state.commits[1].id, 'replacement-108');
    assert.match(await panel.locator('footer').innerText(), /message.*unchanged/i);
    for (let n = 1000; n < 1045; n++) state.sessions.A.push(entry(n, [target(0, 'text', 'TAIL')]));
    await panel.locator('header .x').click();
    await page.reload();
    await boot(page);
    await settle();
    assert.equal(await chat.locator('[data-ctxkit-for="208:0"]').count(), 1);
    assert.equal(await chat.locator('.Sixlwa_bubble').innerText(), 'MESSAGE C');
    await openTarget(chat, '208:0');
    assert.equal(await chat.locator('[contenteditable]').innerText(), 'MESSAGE C');
    state.sessions.A[0].originId = 'unrelated';
    await refresh(); await settle();
    assert.equal(await chat.locator('[data-ctxkit-for="208:0"]').count(), 0);
    assert.equal(await chat.locator('.Sixlwa_bubble').isVisible(), true);
  });
  await check('B4: re-render, streaming, failed mapping, removal and refusal restore originals', async ({ page, chat, state, refresh, settle }) => {
    Object.assign(state.sessions.A[1].targets[1], { text: 'EFFECTIVE', chars: 9, edited: true, changed: true, editStatus: 'applied' });
    await refresh(); await settle();
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'EFFECTIVE');
    await chat.locator('._markdown_kcgor_5').evaluate(n => { window.detachedSource = n; const next = n.cloneNode(true); next.style.removeProperty('display'); n.replaceWith(next); });
    await settle();
    assert.equal(await page.evaluate(() => window.detachedSource.style.display), '');
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 1);
    await chat.locator('[data-ctxkit-projection]').evaluate(n => n.remove()); await settle();
    assert.equal(await chat.locator('._markdown_kcgor_5').innerText(), 'EFFECTIVE');
    await chat.locator('.hWmORq_root').evaluate(n => n.setAttribute('data-streaming', 'true')); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 0);
    assert.equal(await chat.locator('._markdown_kcgor_5').isVisible(), true);
    await chat.locator('.hWmORq_root').evaluate(n => n.removeAttribute('data-streaming')); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 1);
    state.listError = true; await refresh(); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0);
    assert.equal(await chat.locator('._markdown_kcgor_5').isVisible(), true);
    state.listError = false; await refresh(); await settle();
    await chat.locator('._markdown_kcgor_5').evaluate(n => n.className = 'fixture_markdown_unknown'); await settle();
    assert.equal(await chat.locator('.fixture_markdown_unknown').isVisible(), true);
    assert.match(await chat.locator('[data-ctxkit-projection] .badge').innerText(), /layout.*original|original.*layout/i);
    Object.assign(state.sessions.A[1].targets[1], { changed: false, editStatus: 'refused' });
    await refresh(); await settle();
    assert.match(await chat.locator('[data-ctxkit-projection] .badge').innerText(), /refused/i);
    assert.equal(await chat.locator('[data-ctxkit-projection] .effective-text').count(), 0);
    state.sessions.A = []; await refresh(); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection], [data-ctxkit-pencil]').count(), 0);
  });
  await check('B4: sparse multi-text blocks, signed disclosure, media fallback and recycled rows', async ({ page, chat, state, refresh, settle }) => {
    state.sessions.A[1].targets.push(target(6, 'text', 'SECOND EFFECTIVE', { edited: true, changed: true, editStatus: 'applied' }));
    Object.assign(state.sessions.A[1].targets[1], { text: 'FIRST EFFECTIVE', chars: 15, edited: true, changed: true, editStatus: 'applied' });
    await chat.locator('.hWmORq_body').evaluate(body => {
      const text = document.createElement('div'); text.className = 'other_markdown'; text.textContent = 'SECOND ORIGINAL'; body.append(text);
    });
    await chat.evaluate((flow, html) => flow.insertAdjacentHTML('beforeend', html), assistantRow(17));
    await refresh(); await settle();
    assert.deepEqual(await chat.locator('._markdown_kcgor_5, .other_markdown').allTextContents(), ['FIRST EFFECTIVE', 'SECOND EFFECTIVE', 'ANSWER']);
    assert.equal(await chat.locator('[data-ctxkit-for="17:0"]').count(), 1);
    assert.equal(await chat.locator('[data-ctxkit-for="17:1"]').count(), 1);
    const signed = chat.locator('[data-chat-flow-key="14:assistant-step17:1"] [data-variant="think"]');
    assert.equal(await signed.locator('[data-ctxkit-projection]').count(), 0);
    assert.equal(await signed.locator('.lcKema_summaryText').evaluate(n => n.style.display), '');
    const assistant = chat.locator('[data-chat-flow-key="14:assistant-step15:1"]');
    await assistant.locator('._markdown_kcgor_5').evaluate(n => { const img = document.querySelector('img').cloneNode(); n.append(img); });
    await settle();
    assert.equal(await assistant.locator('._markdown_kcgor_5').isVisible(), true, 'media in Markdown must remain visible');
    assert.match(await assistant.locator('[data-ctxkit-projection="2"] .badge').innerText(), /original display kept/);
    await assistant.evaluate(n => n.setAttribute('data-chat-flow-key', '14:assistant-step999:1')); await settle();
    assert.equal(await assistant.locator('[data-ctxkit-projection]').count(), 0);
    const recycled = chat.locator('[data-chat-flow-key="14:assistant-step999:1"]');
    assert.equal(await recycled.locator('.other_markdown').isVisible(), true);
    await recycled.evaluate(n => n.setAttribute('data-chat-flow-key', '14:assistant-step15:1')); await settle();
    await assistant.evaluate(n => { window.removedRow = n; n.remove(); }); await settle();
    assert.equal(await page.evaluate(() => window.removedRow.querySelector('.other_markdown').style.display), '');
    assert.equal(await page.evaluate(() => window.removedRow.querySelectorAll('[data-ctxkit-projection], [data-ctxkit-pencil]').length), 0);
  });
  await check('B1/B5: same-shape focus refresh, session drafts and list/save/status races', async ({ page, panel, row, chat, open, state, refresh, settle, switchSession, hold }) => {
    await open(15); await row(15).locator('textarea').fill('PRESERVED DRAFT');
    const oldList = hold('list'); await refresh(); await oldList.started;
    await switchSession('B'); oldList.release(); await settle();
    assert.equal(await panel.locator('textarea:visible').count(), 0);
    assert.match(await row(15).locator('.text').innerText(), /SESSION B/);
    assert.equal(await chat.locator('[data-ctxkit-for="8:0"]').count(), 0);
    await switchSession('A');
    assert.equal(await row(15).locator('textarea').inputValue(), 'PRESERVED DRAFT');
    await row(15).locator('textarea').fill('ANSWER'); await row(15).locator('.cancel').click();
    state.sessions.A[1].targets[1].text = 'EXTERNAL'; state.sessions.A[1].targets[1].chars = 8;
    state.sessions.A[1].text = 'EXTERNAL'; state.sessions.A[1].chars = 8;
    await refresh(); await settle(); await row(15).locator('.edit').click();
    assert.equal(await row(15).locator('textarea').inputValue(), 'EXTERNAL');
    const oldSave = hold('commit'); await row(15).locator('textarea').fill('SAVED A'); await row(15).locator('.save').click(); await oldSave.started;
    await switchSession('B'); oldSave.release(); await settle();
    assert.doesNotMatch(await panel.locator('footer').innerText(), /Saved|answer.*next request/i);
    assert.equal(await row(15).locator('.text').innerText(), 'SESSION B');
    state.statuses.B = { enabled: false, messages: 999 };
    const oldStatus = hold('status', 'B'); await panel.locator('header .x').click(); await panel.locator('.launch').click(); await oldStatus.started;
    await switchSession('A'); oldStatus.release(); await settle();
    assert.doesNotMatch(await panel.locator('footer').innerText(), /disabled|999/);
  });
  await check('stale refusal retains draft; unedited targets have no edited badge', async ({ page, panel, row, chat, state, open }) => {
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 0);
    await open(15);
    assert.doesNotMatch(await row(15).locator('.meta').innerText(), /edited/i);
    state.sessions.A[1].targets[1].text = 'CHANGED ELSEWHERE';
    await row(15).locator('textarea').fill('STALE DRAFT'); await row(15).locator('.save').click();
    await page.waitForFunction(() => document.querySelector('#dsh-context-kit-editor').shadowRoot.querySelector('footer').className === 'err');
    assert.equal(await row(15).locator('textarea').inputValue(), 'STALE DRAFT');
    assert.match(await panel.locator('footer').innerText(), /Not saved/);
    assert.equal(await row(17).locator('option').count(), 2);
  });
  await check('B5: delayed post-save reload cannot leave two rows open or erase the next draft', async ({ panel, row, open, hold, settle }) => {
    await open(15);
    const reload = hold('list');
    await row(15).locator('textarea').fill('SAVED ANSWER'); await row(15).locator('.save').click(); await reload.started;
    await row(8).locator('.edit').click(); await row(8).locator('textarea').fill('NEXT DRAFT');
    assert.equal(await panel.locator('.row.open').count(), 1);
    reload.release(); await settle();
    assert.equal(await panel.locator('.row.open').count(), 1);
    assert.equal(await row(8).locator('textarea').inputValue(), 'NEXT DRAFT');
  });
  await check('multi-text user: edit A then B, one aggregate Chat bubble and per-block picker', async ({ page, panel, chat, row, state, open, save, refresh, settle }) => {
    assert.equal(state.sessions.A[0].text, 'AB');
    await panel.locator('.launch').click();
    assert.equal(await row(8).locator('.text').innerText(), 'AB');
    await row(8).locator('.edit').click();
    assert.equal(await row(8).locator('textarea').inputValue(), 'A');
    await save(8, 'X');
    assert.deepEqual(state.sessions.A[0].targets.map(t => t.text), ['X', 'B']);
    assert.equal(await chat.locator('.Sixlwa_bubble').isVisible(), true);
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 1);
    assert.equal(await chat.locator('.Sixlwa_bubble').innerText(), 'XB');
    await row(108).locator('.edit').click(); await row(108).locator('select').selectOption('1');
    assert.equal(await row(108).locator('textarea').inputValue(), 'B');
    await save(108, 'Y');
    assert.deepEqual(state.commits.map(c => [c.block, c.expected]), [[0, 'A'], [1, 'B']]);
    assert.deepEqual(state.sessions.A[0].targets.map(t => t.text), ['X', 'Y']);
    assert.equal(await chat.locator('.Sixlwa_bubble').innerText(), 'XY');
    assert.equal(await row(208).locator('.text').innerText(), 'XY');
    await chat.locator('.Sixlwa_bubble').evaluate(n => {
      const duplicate = n.cloneNode(true); duplicate.style.removeProperty('display'); n.after(duplicate);
    });
    await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 0, 'ambiguous user layout cannot be projected');
    assert.deepEqual(await chat.locator('.Sixlwa_bubble').evaluateAll(nodes => nodes.map(n => n.style.display)), ['', '']);
    await chat.locator('.Sixlwa_bubble').last().evaluate(n => n.remove());
    state.sessions.A[0].editable = false; state.sessions.A[0].reason = 'this message carries no text block, and a durable edit rewrites the text of a message';
    await refresh(); await settle();
    assert.equal(await chat.locator('[data-ctxkit-projection]').count(), 0, 'mixed user content stays untouched');
    assert.equal(await chat.locator('.Sixlwa_bubble').evaluate(n => n.style.display), '');
  }, { rows: [entry(8, [target(0, 'text', 'A', { label: 'Message' }), target(1, 'text', 'B', { label: 'Message' })],
    { type: 'user/message', id: 'u1', originId: 'u1', userIndex: 0, branch: 'durable' })] });
  await check('modal keyboard: named controls, focus trap/return, dirty Escape refusal and refresh focus', async ({ page, panel, row, refresh, settle }) => {
    await panel.locator('.launch').focus(); await page.keyboard.press('Enter');
    const dialog = panel.getByRole('dialog', { name: 'Edit history', exact: true });
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await panel.locator('header .x').evaluate(n => n === n.getRootNode().activeElement), true);
    await page.locator('#outside-focus').evaluate(n => n.focus());
    assert.equal(await page.locator('#outside-focus').evaluate(n => n === document.activeElement), false);
    await row(15).locator('.edit').focus(); await page.keyboard.press('Enter');
    const area = row(15).getByRole('textbox', { name: /answer/i });
    assert.equal(await area.inputValue(), 'ANSWER');
    assert.equal(await row(15).getByRole('combobox', { name: /target/i }).count(), 1);
    await area.fill('KEEP ME'); await page.keyboard.press('Escape'); await confirmEdit(page, false);
    assert.equal(await dialog.isVisible(), true); assert.equal(await area.inputValue(), 'KEEP ME');
    assert.equal(await area.evaluate(n => n === n.getRootNode().activeElement), true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(n => n.contains(n.getRootNode().activeElement)), true);
    }
    await area.fill('ANSWER'); await refresh(); await settle();
    assert.equal(await row(15).locator('textarea').evaluate(n => n === n.getRootNode().activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await panel.locator('.launch').evaluate(n => n === n.getRootNode().activeElement), true);
  });
  await check('16 targets at 390px: compact keyboard chooser, no overlapping or off-screen controls', async ({ page, panel, chat, row }) => {
    const pins = chat.locator('[data-ctxkit-pencil]');
    assert.equal(await pins.count(), 1, 'many targets must use one compact chooser');
    const button = pins.getByRole('button', { name: /edit message/i });
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await button.focus(); await page.keyboard.press('Enter');
    const editor = row(8);
    const picker = editor.getByRole('combobox', { name: /target/i });
    await picker.waitFor({ state: 'visible' });
    assert.equal(await picker.locator('option').count(), 16);
    await picker.focus(); await page.keyboard.press('End'); await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#dsh-context-kit-editor').shadowRoot.querySelector('textarea')?.value === 'BLOCK 15');
    assert.equal(await editor.locator('textarea').inputValue(), 'BLOCK 15');
    const box = await picker.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.equal(await editor.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    assert.equal(await button.evaluate(n => n === n.getRootNode().activeElement), true, 'closing returns keyboard focus to the chooser');
  }, { width: 390, rows: [entry(8, Array.from({ length: 16 }, (_, at) => target(at, 'text', `BLOCK ${at}`, { label: 'Message' })),
    { type: 'user/message', id: 'u1', originId: 'u1', userIndex: 0, branch: 'durable' })] });
  for (const width of [1280, 390]) await check(`desktop/mobile fit ${width}`, async ({ page, panel, open }) => {
    await open(15);
    const box = await panel.locator('.panel').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    assert.equal(await panel.locator('.panel').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(home, `panel-${width}.png`) });
  }, { width });
} finally { await browser.close(); }
console.log(`edit panel browser: ${checks} passed, ${failures.length} failed; screenshots: ${home}`);
assert.deepEqual(failures, [], 'browser regressions failed');
