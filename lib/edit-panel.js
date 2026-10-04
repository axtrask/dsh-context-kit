export function createPanelScript(channel) {
  return `
const HOST = document.getElementById('dsh-context-kit-editor');
if (HOST && HOST.shadowRoot === null) {
  const STATE = { sessionId: '', epoch: 0, request: 0, open: false, listed: false, entries: [], transcript: [], hidden: [], draft: null, pending: null };
  const drafts = new Map();
  // Open shadow roots isolate CSS while keeping the mount guard and browser checks usable.
  const root = HOST.attachShadow({ mode: 'open' });
  /**
   * Draw a control as a glyph.
   *
   * Same language as the rest of the panel's art: a 16px drawing that inherits the button's
   * colour, filled with nothing and stroked with currentColor. The name travels in the button's
   * aria-label, so the drawing itself is hidden from assistive technology.
   */
  const icon = (button, name, path) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    svg.append(line);
    button.textContent = '';
    button.append(svg);
    button.setAttribute('aria-label', name);
    return button;
  };
  const CHECK_PATH = 'm5 12.6 4.3 4.4L19 7.6';
  const CROSS_PATH = 'm6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6';
  const css = document.createElement('style');
  css.textContent = [
    ':host { all: initial; font: 13px/1.45 "Segoe UI", system-ui, sans-serif; }',
    '* { box-sizing: border-box; font-family: inherit; }',
    '.launch { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: flex; gap: 8px; align-items: center;',
    '  padding: 7px 10px; border: 1px solid var(--studio-line, #303a32); border-radius: 7px; corner-shape: round; background: var(--studio-panel, #191e1b); color: var(--studio-muted, #a0aca2);',
    '  cursor: pointer; box-shadow: none; font-size: 11px; }',
    '.launch:hover { color: var(--dsw-alias-label-primary, #e5ebe4); }',
    '.notice { position: fixed; left: 50%; transform: translateX(-50%); bottom: max(24px, env(safe-area-inset-bottom)); z-index: 2147483002; width: max-content; max-width: min(460px, 92vw); padding: 12px 44px 12px 16px; border: 1px solid var(--dsw-alias-border-l1, #3d3d3d); border-radius: 14px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eeeeee); box-shadow: 0 8px 32px #0003; overflow-wrap: anywhere; }',
    '.notice[data-kind="good"] { border-left: 3px solid var(--dsw-alias-state-success-primary, #55a57a); } .notice[data-kind="err"] { border-left: 3px solid var(--dsw-alias-state-error-primary, #d67869); }',
    '.notice button { position: absolute; right: 8px; top: 8px; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #808080); cursor: pointer; }',
    '.notice button:hover { background: transparent; color: var(--dsw-alias-label-primary, #eeeeee); } .notice button svg { display: block; width: 16px; height: 16px; }',
    '.notice[hidden] { display: none; }',
    '.confirm { box-sizing: border-box; width: min(400px, 92vw); max-height: 85dvh; padding: 24px; border: 1px solid var(--dsw-alias-border-l1, #3d3d3d); border-radius: 16px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eeeeee); box-shadow: 0 20px 80px #0005; }',
    '.confirm::backdrop { background: #090d1666; backdrop-filter: blur(3px); } .confirm h3 { margin: 0 0 8px; font-size: 17px; font-weight: 650; } .confirm p { margin: 0 0 24px; color: var(--dsw-alias-label-secondary, #808080); }',
    '.confirm .acts { justify-content: flex-end; } .confirm button { padding: 8px 14px; } .confirm .keep { border: 1px solid var(--dsw-alias-border-l1, #3d3d3d); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }',
    '.wrap { position: fixed; inset: 0; z-index: 2147483001; display: none; width: 100vw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; }',
    '.wrap.open { display: block; }',
    '.wrap::backdrop { background: transparent; }',
    '.scrim { position: absolute; inset: 0; background: rgba(8,10,14,.55); }',
    '.panel { position: absolute; top: 4vh; right: 4vw; bottom: 4vh; width: min(760px, 92vw); display: flex; flex-direction: column;',
    '  background: var(--studio-panel, #16191f); color: var(--studio-ink, #e8eaed); border: 1px solid var(--studio-line, rgba(255,255,255,.14)); border-radius: 14px; overflow: hidden;',
    '  box-shadow: 0 24px 60px rgba(0,0,0,.6); }',
    'header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.1); }',
    'header h2 { margin: 0; font-size: 15px; font-weight: 650; }',
    'header .sub { color: #9aa3b2; }',
    'header .spacer { flex: 1; }',
    'button { font-family: inherit; line-height: inherit; }',
    '.x, .edit, .delete { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; padding: 4px 10px; border: 1px solid transparent; border-radius: 8px; corner-shape: round; background: transparent; color: var(--dsw-alias-label-secondary, #808080); cursor: pointer; }',
    '.x:hover, .edit:hover, .delete:hover { background: transparent; color: var(--dsw-alias-label-primary, #eeeeee); }',
    'header .x { width: 28px; height: 28px; min-width: 28px; min-height: 28px; padding: 6px; border: 0; }',
    '.delete { color: var(--dsw-alias-state-error-primary, #d67869); }',
    '.note { margin: 0; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.08); color: #b9c0cc; }',
    '.doctrine { margin: 0; padding: 10px 16px 10px 32px; border-bottom: 1px solid rgba(255,255,255,.08); color: #8f98a8; font-size: 12px; }',
    'ul.list { list-style: none; margin: 0; padding: 8px; overflow: auto; flex: 1; }',
    'li.row { padding: 10px 12px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px; margin-bottom: 8px; background: #1a1e25; }',
    'li.row.refused { opacity: .62; }',
    '.meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; color: #8f98a8; font-size: 12px; margin-bottom: 6px; }',
    '.badge { color: #8ee0a8; } .badge.refused { color: #ffb58f; }',
    '.meta .n { color: #e8eaed; font-weight: 650; }',
    '.text { white-space: pre-wrap; word-break: break-word; max-height: 7.5em; overflow: hidden; }',
    '.row.open .text, .row.open .edit, .row.open .delete { display: none; }',
    'textarea { width: 100%; min-height: 8em; resize: vertical; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18);',
    '  background: #0f1216; color: #e8eaed; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }',
    'select.target { max-width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); background: #0f1216; color: #e8eaed; }',
    '.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }',
    '.acts .why { flex-basis: 100%; min-width: 0; overflow-wrap: anywhere; color: #9aa3b2; font-size: 12px; }',
    '.acts .why.err { color: #ff9a9a; } .acts .why.good { color: #8ee0a8; }',
    '.save { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-brand-primary, #fab283); cursor: pointer; }',
    '.save:not(.accept), .cancel { width: 28px; height: 28px; min-width: 28px; min-height: 28px; padding: 6px; background: transparent; }',
    '.cancel { color: var(--dsw-alias-label-secondary, #808080); }',
    '.save:disabled:not(.accept) { width: auto; min-width: 0; padding: 4px 10px; }',
    '.save:hover { background: transparent; color: var(--dsw-alias-brand-primary, #fab283); } .cancel:hover { background: transparent; color: var(--dsw-alias-label-primary, #eeeeee); }',
    '.save svg, .x svg { display: block; width: 16px; height: 16px; }',
    'button:disabled { opacity: .5; cursor: default; }',
    'button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #fab283); outline-offset: 2px; }',
    '@media (pointer: coarse) { button, select.target { min-width: 44px; min-height: 44px; } .save, .x, .edit, .delete, .cancel, .restore { min-width: 44px; min-height: 44px; } .save:not(.accept), .cancel, header .x, .notice button { width: 44px; height: 44px; min-width: 44px; min-height: 44px; } textarea, select.target { font-size: 16px; } }',
    'footer { padding: 10px 16px; border-top: 1px solid rgba(255,255,255,.1); color: #9aa3b2; font-size: 12px; min-height: 38px; }',
    'footer.err { color: #ff9a9a; }',
    'footer.good { color: #8ee0a8; }'
  ].join('\\n');
  const wrap = document.createElement('dialog');
  wrap.className = 'wrap';
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'editor-title');
  wrap.innerHTML = [
    '<div class="scrim"></div>',
    '<div class="panel">',
    '  <header><h2 id="editor-title">Edit history</h2><span class="sub"></span><span class="spacer"></span><button class="x" type="button"></button></header>',
    '  <p class="note"></p>',
    '  <ul class="doctrine"></ul>',
    '  <ul class="list"></ul>',
    '  <footer role="status" aria-live="polite"></footer>',
    '</div>'
  ].join('\\n');
  const launch = document.createElement('button');
  launch.className = 'launch';
  launch.type = 'button';
  launch.title = 'Edit a message the model already received';
  launch.textContent = 'Edit history';
  root.append(css, launch, wrap);
  icon(wrap.querySelector('header .x'), 'Close', CROSS_PATH);
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const noticeText = document.createElement('span');
  const dismissNotice = document.createElement('button');
  dismissNotice.type = 'button';
  icon(dismissNotice, 'Dismiss notification', CROSS_PATH);
  dismissNotice.addEventListener('click', () => { notice.hidden = true; });
  notice.append(noticeText, dismissNotice);
  root.append(notice);
  let noticeTimer;
  const confirmation = document.createElement('dialog');
  confirmation.className = 'confirm';
  confirmation.setAttribute('role', 'alertdialog');
  confirmation.setAttribute('aria-labelledby', 'confirm-title');
  confirmation.setAttribute('aria-describedby', 'confirm-copy');
  confirmation.innerHTML = '<h3 id="confirm-title"></h3><p id="confirm-copy"></p><div class="acts"><button class="keep" type="button">Keep editing</button><button class="save accept" type="button"></button></div>';
  root.append(confirmation);
  let confirming = null;
  const settleConfirmation = (accepted = false) => {
    const pending = confirming;
    if (!pending) return;
    confirming = null;
    confirmation.close();
    if (pending.focus?.isConnected) pending.focus.focus({ preventScroll: true });
    if (accepted && pending.session === currentSessionId() && pending.epoch === STATE.epoch
      && pending.draft === STATE.draft && !STATE.draft?.save.disabled) pending.accept();
  };
  const askConfirmation = (title, message, action, accept, cancel = 'Keep editing') => {
    if (confirming) return;
    let focus = document.activeElement;
    while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
    confirming = { accept, focus, session: STATE.sessionId, epoch: STATE.epoch, draft: STATE.draft };
    confirmation.querySelector('h3').textContent = title;
    confirmation.querySelector('p').textContent = message;
    confirmation.querySelector('.accept').textContent = action;
    confirmation.querySelector('.keep').textContent = cancel;
    confirmation.showModal();
    confirmation.querySelector('.keep').focus({ preventScroll: true });
  };
  confirmation.querySelector('.keep').addEventListener('click', () => settleConfirmation());
  confirmation.querySelector('.accept').addEventListener('click', () => settleConfirmation(true));
  confirmation.addEventListener('cancel', (event) => { event.preventDefault(); settleConfirmation(); });

  const el = (selector) => wrap.querySelector(selector);
  const list = el('ul.list');
  const footer = el('footer');
  const sub = el('header .sub');
  const note = el('p.note');
  const doctrine = el('ul.doctrine');
  let returnFocus = null;
  const clearList = () => {
    if (STATE.open && list.contains(root.activeElement)) el('header .x').focus();
    list.replaceChildren();
  };

  const say = (message, kind) => {
    footer.textContent = message || '';
    footer.className = kind || '';
    if (!kind) notice.hidden = true;
    if (STATE.draft?.inline) {
      STATE.draft.hint.textContent = message || '';
      STATE.draft.hint.className = 'why ' + (kind || '');
      STATE.draft.inline.source.setAttribute('aria-description', message || 'Ctrl or Cmd+Enter saves. Escape cancels.');
    }
    if (!STATE.open && kind && !STATE.draft?.inline) {
      noticeText.textContent = message;
      notice.dataset.kind = kind;
      notice.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { notice.hidden = true; }, 7000);
    }
  };

  const targetsOf = (entry) => (Array.isArray(entry.targets) ? entry.targets : []);
  const labelOf = (target) => String(target.label || 'Answer').toLowerCase();
  const optionValue = (target) => (Number.isInteger(target.at) ? String(target.at) : '');
  const fallbackTarget = (entry) => ({ ...entry, at: undefined, kind: 'text', label: entry.type === 'user/message' ? 'Message' : 'Answer' });
  const badgeText = (target) => {
    let status = '';
    if (target.editStatus === 'refused') status = 'Edit refused';
    else if (target.editStatus === 'mixed') status = 'Edited; some edits refused';
    else if (target.changed === true) status = 'Edited';
    else if (target.edited === true) status = 'Edited; original text restored';
    return status;
  };
  const finishDraft = (draft) => {
    const restoreView = draft.inline?.anchorView?.();
    draft.row.classList.remove('open');
    draft.box.hidden = true;
    if (draft.inline) {
      draft.inline.cleanup?.();
      for (const hidden of draft.inline.hidden) restoreDisplay(hidden);
      draft.inline.host.remove();
    }
    if (restoreView) requestAnimationFrame(restoreView);
  };
  const leaveDraft = (resume = () => {}) => {
    const draft = STATE.draft;
    if (!draft) return true;
    if (draft.save.disabled) { say('Wait for this save to finish.'); return false; }
    if (draft.area.value !== draft.target.text) {
      askConfirmation('Discard changes?', 'Your unsaved ' + labelOf(draft.target) + ' changes will be lost. The saved text stays unchanged.', 'Discard', () => {
        finishDraft(draft); STATE.draft = null; drafts.delete(STATE.sessionId); decorateTranscript(); resume();
      });
      return false;
    }
    finishDraft(draft);
    STATE.draft = null;
    drafts.delete(STATE.sessionId);
    decorateTranscript();
    return true;
  };

  const decorate = (entry) => {
    const row = document.createElement('li');
    row.className = 'row' + (entry.editable ? '' : ' refused');
    row.dataset.seq = String(entry.seq);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = entry.userIndex === undefined
      ? 'reply ' + entry.turn + ':' + entry.step + '  seq ' + entry.seq
      : '#' + entry.userIndex + '  seq ' + entry.seq;
    const id = document.createElement('span');
    id.textContent = String(entry.id).slice(0, 8);
    const chars = document.createElement('span');
    chars.textContent = entry.chars + ' chars';
    const badge = document.createElement('span');
    const showMeta = (target) => {
      chars.textContent = target.chars + ' chars';
      badge.textContent = badgeText(target);
      badge.className = 'badge' + (target.editable === false || ['refused', 'mixed'].includes(target.editStatus) ? ' refused' : '');
    };
    showMeta(entry);
    meta.append(n, id, chars, badge);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = entry.text;
    row.append(meta, text);
    const acts = document.createElement('div');
    acts.className = 'acts';
    if (canDeleteTurn(entry)) {
      const remove = document.createElement('button');
      remove.className = 'delete';
      remove.type = 'button';
      remove.textContent = 'Delete turn';
      remove.addEventListener('click', () => requestTurnDeletion(entry, remove));
      const truncate = document.createElement('button');
      truncate.className = 'delete';
      truncate.type = 'button';
      truncate.textContent = 'Hide all history after this message';
      truncate.addEventListener('click', () => requestTruncateAfter(entry, truncate));
      acts.append(remove, truncate);
    }
    if (entry.editable === false) {
      if (entry.directUser === true) row.append(acts);
      const why = document.createElement('div');
      why.className = 'why err';
      why.textContent = 'Unavailable: ' + (entry.reason || 'editing was refused');
      row.append(why);
      return row;
    }
    // Prefer the displayed answer, not an earlier reasoning block in the content array.
    // Refused targets stay visible in the picker and below the row, so redacted provider
    // state does not disappear as though the message never contained it.
    const targets = targetsOf(entry);
    const offers = targets.filter((target) => target.editable === true);
    const unavailable = targets.filter((target) => target.editable === false);
    if (offers.length === 0) offers.push(fallbackTarget(entry));
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.type = 'button';
    edit.textContent = 'Edit';
    acts.prepend(edit);
    const picker = document.createElement('select');
    picker.className = 'target';
    picker.setAttribute('aria-label', 'Edit target for seq ' + entry.seq);
    for (const target of [...offers, ...unavailable]) {
      const option = document.createElement('option');
      option.value = optionValue(target);
      option.disabled = target.editable === false;
      option.textContent = target.label + (targets.length > 1 ? ' [block ' + target.at + ']' : '')
        + (target.editable === false ? ' — unavailable: ' + (target.reason || 'refused') : ' (' + target.chars + ' chars)');
      picker.append(option);
    }
    if (targets.length > 1) acts.append(picker);
    picker.value = optionValue(offers.find((offer) => offer.kind === 'text') || offers[0]);
    const chosen = () => offers.find((offer) => optionValue(offer) === picker.value) || offers[0];
    showMeta(chosen());
    const box = document.createElement('div');
    box.hidden = true;
    const area = document.createElement('textarea');
    area.value = chosen().text;
    area.setAttribute('aria-label', chosen().label + ' text for seq ' + entry.seq);
    const save = document.createElement('button');
    save.className = 'save';
    save.type = 'button';
    // The row is a checkmark and a cross rather than two words: the meaning is in the drawing, and
    // the name a screen reader announces comes from the label kept beside it.
    icon(save, 'Save', CHECK_PATH);
    save.title = 'Save (Ctrl+Enter / Cmd+Enter)';
    save.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    const cancel = document.createElement('button');
    cancel.className = 'x cancel';
    cancel.type = 'button';
    icon(cancel, 'Cancel', CROSS_PATH);
    const restore = document.createElement('button');
    restore.className = 'x restore';
    restore.type = 'button';
    restore.textContent = 'Restore original';
    const canRestore = (target) => typeof target.originalText === 'string'
      && target.originalText.trim().length > 0 && target.originalText !== target.text;
    restore.disabled = !canRestore(chosen());
    const hint = document.createElement('span');
    hint.className = 'why';
    hint.id = 'edit-hint-' + entry.seq;
    area.setAttribute('aria-describedby', hint.id);
    const bar = document.createElement('div');
    bar.className = 'acts';
    hint.setAttribute('role', 'status');
    bar.append(cancel, restore, save, hint);
    box.append(area, bar);
    row.append(acts);
    if (unavailable.length > 0) {
      const unavailableNote = document.createElement('div');
      unavailableNote.className = 'why err';
      unavailableNote.textContent = unavailable.map((target) => 'Unavailable: '
        + (target.reason || 'the provider state cannot be edited safely')).join(' ');
      row.append(unavailableNote);
    }
    row.append(box);
    row.focusEditor = () => (row.inline?.inPlace ? row.inline.source : area).focus({ preventScroll: !!row.inline?.inPlace });
    row.openEditor = (at) => {
      syncSession();
      if (!row.isConnected) return;
      if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
      const target = Number.isInteger(at) ? offers.find((offer) => offer.at === at) : chosen();
      if (!target) return;
      if (STATE.draft?.row === row && optionValue(STATE.draft.target) === optionValue(target)) { row.focusEditor(); return; }
      if (!leaveDraft(() => row.openEditor(at))) return;
      const latest = entryFor(STATE.transcript, entry.type === 'user/message' ? entry.originId : { turn: entry.turn, step: entry.step });
      if (!latest) { say('This message is no longer available; reopen the panel.', 'err'); return; }
      if (JSON.stringify(latest) !== JSON.stringify(entry)) {
        render();
        focusRow(latest.seq, target.at);
        return;
      }
      picker.value = optionValue(target);
      row.classList.add('open');
      box.hidden = false;
      area.value = target.text;
      if (entry.type !== 'user/message') text.textContent = target.text;
      area.setAttribute('aria-label', target.label + ' text for seq ' + entry.seq);
      hint.textContent = '';
      restore.disabled = !canRestore(target);
      showMeta(target);
      STATE.draft = { row, box, area, target, entry, save, hint, inline: row.inline };
      row.inline?.start?.(target.text);
      say('Editing seq ' + entry.seq + ', ' + labelOf(target) + '. The original stays in the log.');
      if (STATE.open || row.inline) {
        row.focusEditor();
        if (STATE.open) box.scrollIntoView({ block: 'end' });
      }
    };
    edit.addEventListener('click', () => row.openEditor());
    picker.addEventListener('change', () => {
      const next = chosen();
      if (STATE.draft?.row === row) {
        picker.value = optionValue(STATE.draft.target);
        if (row.inline) { openAt(entry.seq, next.at); return; }
        row.openEditor(next.at);
        return;
      }
      showMeta(next);
      if (entry.type !== 'user/message') text.textContent = next.text;
      area.value = next.text;
      restore.disabled = !canRestore(next);
      hint.textContent = '';
    });
    cancel.addEventListener('click', () => {
      const focus = STATE.draft?.inline?.returnFocus || edit;
      const done = () => { say(''); if (focus.isConnected) focus.focus({ preventScroll: true }); };
      if (leaveDraft(done)) done();
    });
    row.editorKeydown = (event) => {
      if (row.inline) event.stopPropagation();
      if (event.isComposing) return;
      if (row.inline && event.key === 'Escape') { event.preventDefault(); cancel.click(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopPropagation(); save.click();
      }
    };
    row.addEventListener('keydown', row.editorKeydown);
    const commit = async (restoring = false, confirmed = false) => {
      syncSession();
      const draft = STATE.draft;
      if (!draft || draft.row !== row || save.disabled) return;
      const target = draft.target;
      if (restoring && !canRestore(target)) return;
      if (restoring && !confirmed) {
        askConfirmation('Restore original ' + labelOf(target) + '?', 'The current draft will be replaced with the original text. Edit history is kept.', 'Restore original', () => void commit(true, true));
        return;
      }
      const next = restoring ? target.originalText : area.value;
      if (next === target.text) { hint.textContent = 'nothing changed'; return; }
      const sessionId = STATE.sessionId;
      const epoch = STATE.epoch;
      STATE.request += 1;
      save.disabled = true;
      save.textContent = 'Saving...';
      save.setAttribute('aria-label', 'Saving...');
      row.setAttribute('aria-busy', 'true');
      cancel.disabled = true;
      picker.disabled = true;
      edit.disabled = true;
      restore.disabled = true;
      area.readOnly = true;
      draft.inline?.setReadOnly?.(true);
      hint.textContent = '';
      say('Saving...');
      try {
        // Block index disambiguates identical texts; expected guards concurrent edits.
        const payload = { sessionId, seq: entry.seq, id: entry.id, expected: target.text };
        if (restoring) payload.restore = true;
        else payload.text = next;
        if (Number.isInteger(target.at)) payload.block = target.at;
        const value = await call('contextKit.edit.commit', payload);
        if (!isCurrent(sessionId, epoch)) return;
        if (value.ok !== true) {
          const message = 'Not saved. ' + (value.reason || 'The server refused the edit.');
          hint.textContent = message;
          hint.className = 'why err';
          say(message, 'err');
          return;
        }
        const action = restoring ? 'Restored original ' : 'Saved ';
        const done = value.report && value.report.branch === 'wire'
          ? action + labelOf(target) + '. Applies to the next model request.'
          : action + labelOf(target) + '. Later messages are unchanged.';
        // Keep the native body steady until its refreshed text is available.
        const inPlace = !!draft.inline?.inPlace;
        if (!inPlace) {
          finishDraft(draft);
          STATE.draft = null;
          drafts.delete(sessionId);
        }
        const loaded = await load(true);
        if (inPlace && isCurrent(sessionId, epoch) && STATE.draft === draft) {
          finishDraft(draft);
          STATE.draft = null;
          drafts.delete(sessionId);
          render();
          decorateTranscript();
        }
        // Keep the target-specific confirmation visible after refreshing the list.
        if (isCurrent(sessionId, epoch) && loaded) {
          say(done, 'good');
          if (draft.inline && !STATE.draft) {
            const latest = entryFor(STATE.transcript, entry.type === 'user/message' ? entry.originId : { turn: entry.turn, step: entry.step });
            const pin = draft.inline.node.querySelector('[data-ctxkit-for="' + keyOf(latest?.seq, target.at)
              + '"], [data-ctxkit-for="' + latest?.seq + '"]');
            (pin?.shadowRoot?.querySelector('button') || launch).focus({ preventScroll: true });
          }
          if (STATE.open && !STATE.draft && (!root.activeElement || root.activeElement === wrap)) el('header .x').focus();
        }
      } catch (error) {
        if (!isCurrent(sessionId, epoch)) return;
        const message = 'The request failed. ' + String(error && error.message || error);
        hint.textContent = message;
        hint.className = 'why err';
        say(message, 'err');
      } finally {
        save.disabled = false;
        // The busy word lives in the button only while the request is in flight; the checkmark
        // comes back, so the resting control is never a word again.
        icon(save, 'Save', CHECK_PATH);
        row.removeAttribute('aria-busy');
        cancel.disabled = false;
        picker.disabled = false;
        edit.disabled = false;
        restore.disabled = !canRestore(target);
        area.readOnly = false;
        if (STATE.draft === draft) draft.inline?.setReadOnly?.(false);
      }
    };
    save.addEventListener('click', () => void commit());
    restore.addEventListener('click', () => void commit(true));
    return row;
  };

  const render = () => {
    const focused = root.activeElement;
    const seq = focused?.closest('li.row')?.dataset.seq;
    const selector = focused?.matches('select.target') ? 'select.target' : 'button.edit';
    clearList();
    if (STATE.entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'row';
      empty.textContent = 'No messages yet.';
      list.append(empty);
      return;
    }
    for (const entry of STATE.entries) list.append(decorate(entry));
    if (STATE.open && seq) (list.querySelector('li[data-seq="' + seq + '"] ' + selector) || el('header .x')).focus();
  };

  const rpcId = () => 'ctxkit-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  const call = async (method, payload, signal) => {
    // The generic channel requires the method in both the URL and the envelope.
    const response = await fetch('${channel}/' + method, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method, payload }),
      signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 200));
    const body = await response.json();
    const result = body && body.result;
    if (!result) throw new Error('the server answered without a result');
    if (result.ok !== true) throw new Error((result.error && result.error.message) || 'the channel refused the call');
    return result.value;
  };

  const canDeleteTurn = (entry) => entry?.type === 'user/message' && entry.directUser === true;
  const canDeleteMessage = (entry) => entry?.type === 'assistant/message';
  const moveFocusBeforeHiding = () => {
    const destination = STATE.open ? el('header .x') : launch;
    destination?.focus?.({ preventScroll: true });
  };
  const requestTurnDeletion = (entry, control) => {
    syncSession();
    if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
    if (!leaveDraft(() => requestTurnDeletion(entry, control))) return;
    const latest = entryFor(STATE.transcript, entry.originId);
    if (!canDeleteTurn(latest)) {
      say('This turn is no longer available; reopen the panel.', 'err');
      return;
    }
    askConfirmation('Delete this turn?', 'The selected user message and all assistant work in its turn will be hidden from future model requests. The session log stays unchanged.', 'Delete turn', async () => {
      syncSession();
      if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
      const current = entryFor(STATE.transcript, latest.originId);
      if (!canDeleteTurn(current)) {
        say('This turn is no longer available; reopen the panel.', 'err');
        return;
      }
      const sessionId = STATE.sessionId;
      const epoch = STATE.epoch;
      STATE.request += 1;
      if (control?.isConnected) control.disabled = true;
      say('Deleting turn...');
      try {
        const value = await call('contextKit.edit.deleteTurn', {
          sessionId,
          seq: current.seq,
          id: current.id,
          expected: current.text
        });
        if (!isCurrent(sessionId, epoch)) return;
        if (value.ok !== true) {
          say('Not deleted. ' + (value.reason || 'The server refused the deletion.'), 'err');
          return;
        }
        moveFocusBeforeHiding();
        const loaded = await load(true);
        if (isCurrent(sessionId, epoch) && loaded) {
          say('Turn hidden from future model requests. The session log is unchanged.', 'good');
        }
      } catch (error) {
        if (isCurrent(sessionId, epoch)) say('The request failed. ' + String(error && error.message || error), 'err');
      } finally {
        if (control?.isConnected) control.disabled = false;
      }
    }, 'Cancel');
  };

  const requestTruncateAfter = (entry, control) => {
    syncSession();
    if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
    if (!leaveDraft(() => requestTruncateAfter(entry, control))) return;
    const latest = entryFor(STATE.transcript, entry?.originId)
      || STATE.transcript.find((candidate) => canDeleteTurn(candidate)
        && Number(candidate.seq) === Number(entry?.seq) && String(candidate.id) === String(entry?.id));
    if (!canDeleteTurn(latest)) {
      say('This message is no longer available; reopen the panel.', 'err');
      return;
    }
    askConfirmation('Hide all history after this message?', 'Keep this message, but hide every message after it from future model requests. The session log stays unchanged.', 'Hide all history after this message', async () => {
      syncSession();
      if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
      const current = entryFor(STATE.transcript, latest.originId)
        || STATE.transcript.find((candidate) => canDeleteTurn(candidate)
          && Number(candidate.seq) === Number(latest.seq) && String(candidate.id) === String(latest.id));
      if (!canDeleteTurn(current)) {
        say('This message is no longer available; reopen the panel.', 'err');
        return;
      }
      const sessionId = STATE.sessionId;
      const epoch = STATE.epoch;
      STATE.request += 1;
      if (control?.isConnected) control.disabled = true;
      say('Hiding later history...');
      try {
        const value = await call('contextKit.edit.truncateAfter', {
          sessionId,
          seq: current.seq,
          id: current.id,
          expected: current.text
        });
        if (!isCurrent(sessionId, epoch)) return;
        if (value.ok !== true) {
          say('Not hidden. ' + (value.reason || 'The server refused the truncation.'), 'err');
          return;
        }
        moveFocusBeforeHiding();
        const loaded = await load(true);
        if (isCurrent(sessionId, epoch) && loaded) {
          say('Later history hidden from future model requests. The selected message was kept.', 'good');
        }
      } catch (error) {
        if (isCurrent(sessionId, epoch)) say('The request failed. ' + String(error && error.message || error), 'err');
      } finally {
        if (control?.isConnected) control.disabled = false;
      }
    }, 'Cancel');
  };

  const requestMessageDeletion = (entry, control) => {
    syncSession();
    if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
    if (!leaveDraft(() => requestMessageDeletion(entry, control))) return;
    const latest = entryFor(STATE.transcript, { turn: entry?.turn, step: entry?.step });
    if (!canDeleteMessage(latest)) {
      say('This message is no longer available; reopen the panel.', 'err');
      return;
    }
    askConfirmation('Delete this assistant message?', 'Only this assistant message and any immediately following tool results that belong to it will be hidden from future model requests. The session log stays unchanged.', 'Delete message', async () => {
      syncSession();
      if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
      const current = entryFor(STATE.transcript, { turn: latest.turn, step: latest.step });
      if (!canDeleteMessage(current)) {
        say('This message is no longer available; reopen the panel.', 'err');
        return;
      }
      const sessionId = STATE.sessionId;
      const epoch = STATE.epoch;
      STATE.request += 1;
      if (control?.isConnected) control.disabled = true;
      say('Deleting message...');
      try {
        const value = await call('contextKit.edit.deleteMessage', {
          sessionId,
          seq: current.seq,
          id: current.id,
          expected: current.text
        });
        if (!isCurrent(sessionId, epoch)) return;
        if (value.ok !== true) {
          say('Not deleted. ' + (value.reason || 'The server refused the deletion.'), 'err');
          return;
        }
        moveFocusBeforeHiding();
        const loaded = await load(true);
        if (isCurrent(sessionId, epoch) && loaded) {
          say('Message hidden from future model requests. The session log is unchanged.', 'good');
        }
      } catch (error) {
        if (isCurrent(sessionId, epoch)) say('The request failed. ' + String(error && error.message || error), 'err');
      } finally {
        if (control?.isConnected) control.disabled = false;
      }
    }, 'Cancel');
  };

  const isCurrent = (sessionId, epoch) => STATE.sessionId === sessionId && STATE.epoch === epoch && currentSessionId() === sessionId;
  const performLoad = async (foreground = false, signal) => {
    syncSession();
    const sessionId = STATE.sessionId;
    const epoch = STATE.epoch;
    const request = ++STATE.request;
    const valid = () => !signal?.aborted && isCurrent(sessionId, epoch) && STATE.request === request;
    // Selection is normally absent while the native controller starts or reconnects.
    if (sessionId === '') { say('Waiting for a conversation to load or be selected.'); return false; }
    if (signal?.aborted) return false;
    try {
      const value = await call('contextKit.edit.list', { sessionId }, signal);
      if (!valid()) return false;
      if (value.ok !== true || (value.sessionId && value.sessionId !== sessionId)) {
        if (foreground || STATE.open) say(value.reason || 'the list is unavailable', 'err');
        STATE.entries = [];
        STATE.transcript = [];
        STATE.hidden = [];
        STATE.listed = false;
        if (!STATE.draft) clearList();
        sub.textContent = '';
        decorateTranscript();
        return false;
      }
      STATE.entries = Array.isArray(value.entries) ? value.entries : [];
      STATE.transcript = Array.isArray(value.transcript) ? value.transcript : STATE.entries;
      STATE.hidden = Array.isArray(value.hidden) ? value.hidden : [];
      STATE.listed = true;
      const cleanDraft = STATE.draft;
      const latestDraft = cleanDraft && entryFor(STATE.transcript, cleanDraft.entry.type === 'user/message'
        ? cleanDraft.entry.originId : { turn: cleanDraft.entry.turn, step: cleanDraft.entry.step });
      if (cleanDraft && !cleanDraft.save.disabled && cleanDraft.area.value === cleanDraft.target.text
        && JSON.stringify(latestDraft) !== JSON.stringify(cleanDraft.entry)) {
        STATE.pending ??= { seq: cleanDraft.entry.seq, at: cleanDraft.target.at,
          inline: !!cleanDraft.inline, returnFocus: cleanDraft.inline?.returnFocus,
          identity: cleanDraft.entry.type === 'user/message' ? cleanDraft.entry.originId : { turn: cleanDraft.entry.turn, step: cleanDraft.entry.step } };
        leaveDraft();
      }
      sub.textContent = value.counts.editable + ' editable of ' + value.counts.total;
      note.textContent = 'Edit the text sent to the model. Chat shows a plain-text effective preview with its own Copy button; native Chat Copy still uses the original. The session log is preserved.';
      doctrine.replaceChildren();
      for (const line of value.doctrine || []) {
        const item = document.createElement('li');
        item.textContent = line;
        doctrine.append(item);
      }
      if (value.editor && value.editor.enabled !== true) say('The editor is disabled in dcp.jsonc, so saving will be refused.', 'err');
      else if (!STATE.draft) say('Ready.');
      if (!STATE.draft) render();
      decorateTranscript();
      if (STATE.pending && !drafts.has(sessionId)) {
        const wanted = STATE.pending;
        STATE.pending = null;
        const latest = entryFor(STATE.transcript, wanted.identity);
        const seq = latest?.seq ?? wanted.seq;
        const inline = wanted.inline && !STATE.open && await focusInline(seq, wanted.at, wanted.returnFocus);
        if (!valid()) return false;
        if (!inline) {
          if (wanted.inline) showPanel();
          focusRow(seq, wanted.at);
        }
      } else if (!STATE.draft && drafts.has(sessionId) && (STATE.open || STATE.pending)) {
        const saved = drafts.get(sessionId);
        STATE.pending = null;
        showPanel();
        focusRow(saved.seq, saved.at);
        if (STATE.draft && STATE.draft.entry.id === saved.id) {
          STATE.draft.target = { ...STATE.draft.target, text: saved.expected };
          STATE.draft.area.value = saved.text;
          say('Unsaved ' + labelOf(STATE.draft.target) + ' draft restored. Saving checks the text it originally opened.');
        } else {
          // A durable replacement may have changed seq while this session was away.
          // Keep the draft reachable without silently rebasing its expected text.
          say('An unsaved draft belongs to a replaced message. Copy it before continuing.', 'err');
          const recovery = document.createElement('textarea');
          recovery.value = saved.text;
          recovery.readOnly = true;
          recovery.setAttribute('aria-label', 'Unsaved draft from replaced message');
          list.prepend(recovery);
        }
      }
      // LIST is the single editor surface read. It already carries editor state and counts,
      // so a foreground refresh must not duplicate the work with a STATUS request.
      return true;
    } catch (error) {
      if (valid()) {
        STATE.entries = [];
        STATE.transcript = [];
        STATE.hidden = [];
        STATE.listed = false;
        if (!STATE.draft) clearList();
        sub.textContent = '';
        decorateTranscript();
        if (foreground || STATE.open) say(String(error && error.message || error), 'err');
      }
      return false;
    }
  };

  // While one fetch is active, later refreshes for the same session generation collapse
  // into one follow-up. Every flight owns an abortable lease: a hung request releases the
  // scheduler, and changing sessions aborts the old generation immediately.
  const createLoadScheduler = (perform, generationKey, leaseMs = 10000) => {
    let generation = null;
    const abort = (owner) => {
      if (owner?.controller && !owner.controller.signal.aborted) owner.controller.abort();
    };
    const start = (owner, foreground) => {
      const controller = new AbortController();
      owner.controller = controller;
      let lease;
      let onAbort;
      const stopped = new Promise((resolve) => {
        onAbort = () => resolve(false);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        lease = setTimeout(() => controller.abort(), leaseMs);
      });
      // Normalizing through a microtask gives synchronous throws and asynchronous rejections
      // the same cleanup and queued-continuation path.
      const performed = Promise.resolve().then(() => perform(foreground, controller.signal));
      const observed = performed.then(
        (value) => controller.signal.aborted ? false : value,
        (error) => {
          if (controller.signal.aborted) return false;
          throw error;
        }
      );
      const flight = Promise.race([observed, stopped]).finally(() => {
        clearTimeout(lease);
        controller.signal.removeEventListener('abort', onAbort);
        if (owner.controller === controller) owner.controller = null;
        if (owner.flight === flight) owner.flight = null;
      });
      owner.flight = flight;
      return flight;
    };
    const schedule = (foreground = false) => {
      const key = generationKey();
      if (generation === null || generation.key !== key) {
        const obsolete = generation;
        generation = null;
        if (obsolete) {
          obsolete.queuedForeground = false;
          abort(obsolete);
        }
        generation = { key, flight: null, queued: null, queuedForeground: false, controller: null };
        return start(generation, foreground);
      }
      if (generation.flight === null) return start(generation, foreground);
      const owner = generation;
      owner.queuedForeground ||= foreground;
      if (owner.queued === null) {
        const continueQueued = () => {
          owner.queued = null;
          if (generation !== owner) {
            owner.queuedForeground = false;
            return false;
          }
          const nextForeground = owner.queuedForeground;
          owner.queuedForeground = false;
          return start(owner, nextForeground);
        };
        owner.queued = owner.flight.then(continueQueued, continueQueued);
      }
      return owner.queued;
    };
    schedule.abort = () => {
      const obsolete = generation;
      generation = null;
      if (!obsolete) return;
      obsolete.queuedForeground = false;
      abort(obsolete);
    };
    return schedule;
  };
  const load = createLoadScheduler(performLoad, () => String(STATE.epoch) + '\u0000' + STATE.sessionId);

  // This getter belongs to the page-local sessions controller, never shared persistence.
  const currentSessionId = () => {
    try {
      const selected = window.__DSH_CONTEXT_KIT_SESSION__?.();
      return typeof selected === 'string' && selected.length > 0 ? selected : '';
    } catch {
      return '';
    }
  };

  // Chat keys: 13:input-message<originId> and 14:assistant-step<turn>:<step>.
  // The prefix is the definition-name LENGTH, not render order or log position.
  const FLOW_SELECTOR = '[data-chat-flow] > [data-chat-flow-key]';
  const PENCIL_ATTR = 'data-ctxkit-pencil';
  const DELETE_ACTION_ATTR = 'data-ctxkit-delete';
  const DELETE_REGION_ATTR = 'data-ctxkit-delete-region';
  const DELETE_STRIP_ATTR = 'data-ctxkit-delete-strip';
  const HIDDEN_TURN_ATTR = 'data-ctxkit-deleted-turn';
  // THE TEXT IS THE BUTTON. placePencil marks every region a reader may click to edit - the
  // markdown block, the Thinking element, the user bubble, or the whole message for a chooser.
  // The mark itself is visually neutral: the shell remains the sole owner of pointer hover paint.
  // Keyboard focus may outline the marked region without changing any native layout property.
  const EDIT_ATTR = 'data-ctxkit-edit';
  const AFFORDANCE_ATTR = 'data-ctxkit-affordance';
  // Clicks that belong to the shell or to a reader's own gesture never open the editor: no
  // right-click, no click on a link, code, control or disclosure inside the text, and no click
  // once text is selected.
  const INNER_CONTROL = 'a, button, input, textarea, select, summary, code, pre, [contenteditable], [role="button"], [data-tool], [data-code-block], svg';
  // Kept as an exported script invariant: zero means there is no click-to-edit timer.
  const GESTURE_GRACE = 0;
  // A shadow stylesheet cannot reach the shell's native text nodes. The document rule is kept
  // only for keyboard focus and for action strips that live in the following turn-tail row.
  // Pointer hover paint remains entirely native, preventing a second outline around the message.
  const installAffordance = () => {
    if (document.head.querySelector('style[' + AFFORDANCE_ATTR + ']') !== null) return;
    const affordance = document.createElement('style');
    affordance.setAttribute(AFFORDANCE_ATTR, '');
    affordance.textContent = [
      FLOW_SELECTOR + ':has([' + PENCIL_ATTR + ']:focus-within) [' + EDIT_ATTR + '] { outline: 2px solid var(--studio-accent, var(--dsw-alias-brand-primary, #4d6bfe)); outline-offset: 2px; border-radius: 8px; }',
      // Destructive actions stay out of the reading flow until their row, native turn tail or one
      // of the controls is hovered/focused. The adjacent-sibling rule joins an assistant message
      // to the native action strip rendered immediately after it.
      '[' + DELETE_STRIP_ATTR + '] { opacity: 0 !important; }',
      '[' + DELETE_REGION_ATTR + ']:hover [' + DELETE_STRIP_ATTR + '], [' + DELETE_REGION_ATTR + ']:hover + [data-chat-flow-kind="turn-tail"] [' + DELETE_STRIP_ATTR + '], [data-chat-flow-kind="turn-tail"]:hover [' + DELETE_STRIP_ATTR + '], [' + DELETE_REGION_ATTR + '][' + DELETE_STRIP_ATTR + ']:hover, [' + DELETE_STRIP_ATTR + ']:focus-within { opacity: 1 !important; }',
      '[' + HIDDEN_TURN_ATTR + '] { display: none !important; }'
    ].join('\\n');
    document.head.append(affordance);
  };
  const flowRows = () => [...document.querySelectorAll(FLOW_SELECTOR)].filter((node) => !node.closest('[data-trajectory-scroll]'));
  const chatRows = () => flowRows().filter((node) =>
    ['user', 'steering', 'assistant-step'].includes(node.getAttribute('data-chat-flow-kind')));
  const running = (node) => !!(node.closest('[data-streaming]:not([data-streaming="false"]), [data-state="running"]')
    || node.querySelector('[data-streaming]:not([data-streaming="false"]), [data-state="running"], [data-pending-steering], [data-submission-echo]'));
  const STOP_GENERATION = 'Generation is running. Stop generation before editing or deleting history.';
  const selectedGenerationRunning = () => {
    try { return window.__DSH_CONTEXT_KIT_GENERATING__?.() === true; } catch { return false; }
  };
  const generationRunning = () => selectedGenerationRunning() || chatRows().some(running);
  const flowBody = (node) => {
    return String(node.getAttribute('data-chat-node-key') || node.getAttribute('data-chat-flow-key') || '').replace(/^[0-9]+:/u, '');
  };
  const messageIdOf = (node) => {
    const body = flowBody(node);
    const prefix = ['input-message', 'steering-message'].find((value) => body.startsWith(value));
    return prefix ? body.slice(prefix.length) : '';
  };
  const turnOf = (node) => {
    const value = node.getAttribute('data-chat-turn');
    return typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : undefined;
  };
  const stepPrefix = 'assistant-step';
  const stepOf = (node) => {
    const body = flowBody(node);
    if (body.indexOf(stepPrefix) !== 0) return undefined;
    const parts = body.slice(stepPrefix.length).split(':');
    if (parts.length !== 2) return undefined;
    if (!/^[0-9]+$/u.test(parts[0]) || !/^[0-9]+$/u.test(parts[1])) return undefined;
    return { turn: Number(parts[0]), step: Number(parts[1]) };
  };
  const pinCss = [
    ':host { position: relative; display: flex; align-self: flex-start; min-height: 0; width: 0; height: 0; max-width: 100%; z-index: 6; opacity: 1; }',
    'button { box-sizing: border-box; font: 11px/1.4 var(--dsw-font-family, ui-sans-serif), system-ui, sans-serif; display: inline-flex; gap: 5px; align-items: center; justify-content: center;',
    '  min-height: 32px; padding: 4px 10px; border: 1px solid transparent; border-radius: 8px; corner-shape: round;',
    '  background: transparent; color: var(--dsw-alias-label-secondary, #808080); cursor: pointer;',
    '  transition: color .15s ease, background-color .15s ease, box-shadow .15s ease; }',
    'button[hidden] { display: none; }',
    // NO VISIBLE CHIP. The reader clicks the message text itself (see pointerEdit below), so the
    // pin contributes no box at rest. Its button survives as the keyboard and screen-reader path:
    // collapsed to the standard visually-hidden square, still focusable, still carrying the
    // accessible name edit-client.js and the tests read. It never expands in any state: no chip is
    // painted, and keyboard focus outlines the marked block itself. The mark stays invisible to a
    // pointer, by design.
    ':host button { width: 1px; height: 1px; min-height: 0; min-width: 0; padding: 0; border: 0; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }',
    ':host([data-editing]) { width: max-content; height: auto; min-height: 28px; border-radius: 0; background: transparent; box-shadow: none; }',
    // Keyboard and touch visibility must override hoverOnce's inline opacity.
    ':host(:focus-within), :host([data-editing]) { opacity: 1 !important; } @media (hover: none) { :host { opacity: 1 !important; } }',
    // The keyboard outline lives in the document stylesheet. No chip is painted in any state, so
    // focus is never dressed as a control on top of the block.
    'button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #fab283); outline-offset: 2px; }',
    '@media (pointer: coarse) { :host([data-editing]) { min-height: 44px; } :host(:focus-within) button { min-height: 44px; min-width: 44px; } }'
  ].join('\\n');

  // Bare seq markers from the first release still mean the default block.
  const parseKey = (value) => {
    const text = String(value || '');
    const parts = text.split(':');
    if (parts.length === 1 && /^[0-9]+$/u.test(parts[0])) return { seq: Number(parts[0]), at: undefined };
    if (parts.length === 2 && /^[0-9]+$/u.test(parts[0]) && /^[0-9]+$/u.test(parts[1])) {
      return { seq: Number(parts[0]), at: Number(parts[1]) };
    }
    return undefined;
  };
  const keyOf = (seq, at) => (Number.isInteger(at) && at >= 0
    ? String(seq) + ':' + String(at)
    : String(seq));

  // One listener pair per row, including rows whose pencils get replaced.
  const hovered = new WeakSet();
  const hoverOnce = (node) => {
    if (hovered.has(node)) return;
    hovered.add(node);
    const show = (opacity) => {
      for (const pin of node.querySelectorAll('[' + PENCIL_ATTR + ']')) pin.style.opacity = opacity;
    };
    node.addEventListener('mouseenter', () => show('1'));
    node.addEventListener('mouseleave', () => show('1'));
  };

  // One pointer listener per row, beside the hover pair above. The press flag matters because the
  // browser collapses an existing selection as the press completes: by the time the click arrives
  // the selection is gone, so whether the reader had one has to be read at press time.
  const pointed = new WeakSet();
  const pressed = { selected: false };
  const regionOwners = new WeakMap();
  const markRegion = (region) => {
    const owners = (regionOwners.get(region) || 0) + 1;
    regionOwners.set(region, owners);
    region.setAttribute(EDIT_ATTR, '');
  };
  const unmarkRegion = (region) => {
    const owners = (regionOwners.get(region) || 0) - 1;
    if (owners > 0) { regionOwners.set(region, owners); return; }
    regionOwners.delete(region);
    region.removeAttribute(EDIT_ATTR);
  };

  /**
   * The pin whose region the click landed in, deepest region first.
   *
   * Regions overlap by design: a chooser answers for the whole message, while a block pin answers
   * for its own block inside it. The innermost match wins, so clicking the answer of a message
   * with a chooser can never be answered by the chooser's outer region.
   */
  const pinAt = (node, target) => {
    let best;
    for (const pin of node.querySelectorAll('[' + PENCIL_ATTR + ']')) {
      for (const region of pin.regions || []) {
        if (!region.contains(target)) continue;
        if (best === undefined) { best = { pin, region }; continue; }
        if (best.region.contains(region)) best = { pin, region };
        else if (region.contains(best.region)) continue;
      }
    }
    return best?.pin;
  };

  /**
   * A click on the message text is the way into the editor; a click that belongs to the reader or
   * to the shell is not.
   *
   * Refused, in order: anything but a plain left click, a click the shell already handled
   * (defaultPrevented), a click on a link, code, control or disclosure inside the text, and a
   * click made while text is selected. What survives opens immediately from the cached Host list;
   * pointerdown preserves an existing selection before the browser can collapse it.
   */
  const pointerEdit = (node, event) => {
    const selectedBefore = pressed.selected;
    pressed.selected = false;
    if (selectedBefore) return;
    if (event.button !== 0 || event.defaultPrevented) return;
    const clicked = event.target;
    // Duck-typed on purpose: the node tests drive this panel through a minimal fake DOM.
    if (!clicked || typeof clicked.closest !== 'function') return;
    if (clicked.closest(INNER_CONTROL)) return;
    const selection = document.getSelection?.();
    if (selection && selection.isCollapsed === false) return;
    const pin = pinAt(node, clicked);
    if (pin === undefined || typeof pin.open !== 'function') return;
    if (!node.isConnected || !pin.isConnected) return;
    const button = pin.shadowRoot?.querySelector('button');
    // A hidden button means the panel's modal editor owns this target; the inline one excludes
    // itself because its surface is contenteditable, which INNER_CONTROL already refuses.
    if (button === undefined || button.hidden) return;
    pin.open(pin.blockAt?.(clicked));
  };

  const pointerOnce = (node) => {
    if (pointed.has(node)) return;
    pointed.add(node);
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const selection = document.getSelection?.();
      pressed.selected = !!(selection && selection.isCollapsed === false);
    });
    node.addEventListener('click', (event) => pointerEdit(node, event));
  };

  /**
   * Where a reader may click to edit this target.
   *
   * One region for a target that names a block: the very element placePencil anchored to. A
   * chooser names no block, so it answers for every text region of its message - never for the
   * whole row, which would put the timestamp and the images in the target too.
   */
  const regionsFor = (node, entry, target, anchor) => {
    if (entry?.type === 'user/message') {
      // The reader clicks the words. The hover actions sit in a strip below the bubble, and that
      // strip is empty space - never the target.
      const { containers } = textLayout(node, entry);
      if (containers.length > 0) return containers;
    }
    if (target.chooser !== true) return [anchor];
    const { containers, thinks } = textLayout(node, entry);
    const regions = [...new Set([...containers, ...thinks])];
    return regions.length > 0 ? regions : [anchor];
  };

  const addPencil = (node, entry, target) => {
    const pin = document.createElement('span');
    pin.setAttribute('data-ctxkit-for', keyOf(entry.seq, target.at));
    const pinRoot = pin.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = pinCss;
    pin.setAttribute(PENCIL_ATTR, '1');
    const button = document.createElement('button');
    button.type = 'button';
    button.title = 'Edit ' + labelOf(target) + ' (seq ' + entry.seq
      + (Number.isInteger(target.at) ? ', block ' + target.at : '') + ')';
    button.className = labelOf(target);
    // The chip IS its label: the pencil glyph was removed, so the button is one readable run of
    // text and the accessible name below still carries the target and its block.
    button.textContent = 'Edit ' + labelOf(target);
    if (target.chooser) {
      button.textContent = 'Edit message';
      button.className = 'chooser';
      button.title = 'Edit message (choose a block)';
    }
    button.setAttribute('aria-label', button.title);
    // The one action, shared by the two ways in: the text's own click (pointerEdit) and the
    // button's keyboard activation. A click inside a message is the shell's business (selection,
    // folding), so only the button path stops it from travelling.
    const open = (at) => {
      if (generationRunning()) { say(STOP_GENERATION, 'err'); return; }
      openAt(entry.seq, Number.isInteger(at) ? at : target.at);
    };
    pin.open = open;
    // Regions this pin answers for, filled in by placePencil. Until then it answers for nothing.
    pin.regions = [];
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    pinRoot.append(style, button, document.createElement('slot'));
    node.append(pin);
    hoverOnce(node);
    pointerOnce(node);
    return pin;
  };

  // Only verified origin ids or unique assistant positions; never guess id suffixes.
  const entryFor = (entries, target) => {
    if (typeof target === 'string') {
      const exact = entries.filter((candidate) => candidate.type === 'user/message' && candidate.originId === target);
      return exact.length === 1 ? exact[0] : undefined;
    }
    if (target === null || typeof target !== 'object') return undefined;
    if (!Number.isInteger(target.turn) || !Number.isInteger(target.step)) return undefined;
    const atStep = entries.filter((candidate) => candidate.type === 'assistant/message'
      && candidate.turn === target.turn && candidate.step === target.step);
    return atStep.length === 1 ? atStep[0] : undefined;
  };

  const targetOf = (node) => {
    if (node.getAttribute('data-chat-flow-kind') === 'assistant-step') return stepOf(node);
    if (!['user', 'steering'].includes(node.getAttribute('data-chat-flow-kind'))) return undefined;
    const id = messageIdOf(node);
    return id === '' ? undefined : id;
  };
  const deletedTurnsOf = (entries) => new Set(entries.filter((entry) => entry?.deletedTurn === true)
    .map((entry) => entry.turn).filter(Number.isInteger));
  const deletedEntryFor = (entries, turns, node) => {
    const exact = entryFor(entries, targetOf(node));
    if (exact?.deletedTurn === true || exact?.deletedMessage === true) return exact;
    return turns.has(turnOf(node)) ? { turn: turnOf(node) } : undefined;
  };

  // Transcript controls exist only for usable targets. Refused provider state remains explained
  // inside the editor panel, but it never creates a dead or warning-shaped control in the chat.
  // Missing targets retain the shipped implicit target.
  const pinTargets = (entry) => {
    const targets = targetsOf(entry);
    if (targets.length === 0) return entry.editable === true ? [fallbackTarget(entry)] : [];
    return targets.filter((target) => target.editable !== false && target.editStatus !== 'refused');
  };

  const sameTarget = (target, parsed) => (Number.isInteger(target.at) ? Number(target.at) === parsed.at : parsed.at === undefined);

  const projections = new Map();
  const deleteHosts = new WeakMap();
  const hasToken = (node, suffix) => [...node.classList].some((token) => {
    const match = /^(?:[A-Za-z0-9]+_([A-Za-z]+)|_([A-Za-z]+)_[A-Za-z0-9]+_[0-9]+)$/u.exec(token);
    return match !== null && (match[1] || match[2]) === suffix;
  });
  const embeddedContent = (source) => [...source.querySelectorAll('img, picture, video, audio, svg, canvas, iframe, button, input, textarea, select, [data-tool], [data-variant], [contenteditable]')].some((part) => {
    // The upstream Markdown code banner's Copy button is decoration, not a separate content block.
    if (!hasToken(source, 'markdown') || !part.matches('button, svg')) return true;
    const button = part.closest('button');
    const block = button?.closest('.md-code-block');
    return !button || !hasToken(button, 'copyButton') || !button.closest('[data-code-block-banner]')
      || !source.contains(block) || !block.querySelector('[data-code-block-content] pre code');
  });
  const restoreDisplay = (record) => {
    if (record.source && record.source.style.getPropertyValue('display') === 'none'
      && record.source.style.getPropertyPriority('display') === 'important') {
      if (record.display) record.source.style.setProperty('display', record.display, record.priority);
      else record.source.style.removeProperty('display');
    }
  };
  const restoreProjection = (record) => {
    if (record.inPlace) {
      if (record.source.innerHTML === record.html) record.source.replaceChildren(...record.original);
      record.cleanup();
    } else restoreDisplay(record);
    record.host.remove();
  };
  const textLayout = (node, entry) => {
    const targets = entry ? targetsOf(entry) : [];
    const texts = targets.filter((target) => target.kind === 'text');
    const thoughts = targets.filter((target) => target.kind === 'reasoning');
    // Slot wrappers are part of the public renderer boundary. Never search arbitrary descendants.
    const slots = [...node.children].filter((child) => child.getAttribute('data-slot') === 'conversation.chat.node');
    const children = slots.length === 1 ? [...slots[0].children] : [];
    const bodies = children.filter((child) => hasToken(child, 'root') && !child.matches('[data-tool], [data-variant]'))
      .flatMap((child) => [...child.children].filter((part) => hasToken(part, 'body')));
    const body = bodies.length === 1 ? bodies[0] : null;
    let containers = [];
    if (entry?.type === 'user/message') {
      containers = children.filter((part) => hasToken(part, 'userRow'))
        .flatMap((part) => [...part.children].filter((stack) => hasToken(stack, 'userStack')))
        .flatMap((stack) => [...stack.children].filter((bubble) => hasToken(bubble, 'bubble')));
    } else if (body) containers = [...body.children].filter((part) => hasToken(part, 'markdown'));
    const thinks = body ? [...body.children].flatMap((part) => part.matches('[data-variant="think"]')
      ? [part] : [...part.children].filter((child) => child.matches('[data-variant="think"]'))) : [];
    return { targets, texts, thoughts, containers, thinks };
  };
  const userActionStrip = (node, entry) => {
    const kind = node.getAttribute('data-chat-flow-kind');
    if (entry?.type !== 'user/message' && !['user', 'steering'].includes(kind)) return null;
    const layoutEntry = entry?.type === 'user/message' ? entry : { type: 'user/message', targets: [] };
    const { containers } = textLayout(node, layoutEntry);
    const user = containers[0]?.closest('[class]')?.parentElement?.parentElement;
    return user ? [...user.children].find((part) => hasToken(part, 'actions') && part.querySelector('button')) || null : null;
  };
  const assistantActionStrip = (node, entry) => {
    if (node.getAttribute('data-chat-flow-kind') !== 'assistant-step') return null;
    const tail = node.nextElementSibling;
    if (tail?.getAttribute('data-chat-flow-kind') !== 'turn-tail') return null;
    const turn = Number.isInteger(entry?.turn) ? entry.turn : stepOf(node)?.turn;
    const tailTurn = turnOf(tail);
    if (!Number.isInteger(turn) || !Number.isInteger(tailTurn) || turn !== tailTurn) return null;
    return [...tail.querySelectorAll('[class]')].find((part) => hasToken(part, 'actions') && part.querySelector('button')) || null;
  };
  const releaseDeleteStrip = (strip) => {
    if (strip && strip.querySelector('[' + DELETE_ACTION_ATTR + ']') === null) strip.removeAttribute(DELETE_STRIP_ATTR);
  };

  const placeDeleteAction = (node, entry) => {
    const strip = userActionStrip(node, entry) || assistantActionStrip(node, entry);
    const tracked = deleteHosts.get(node) || new Set();
    deleteHosts.set(node, tracked);
    const nearby = [
      ...node.querySelectorAll('[' + DELETE_ACTION_ATTR + ']'),
      ...(strip ? strip.querySelectorAll('[' + DELETE_ACTION_ATTR + ']') : [])
    ].filter((host) => host.ownerRow === undefined || host.ownerRow === node);
    for (const host of nearby) {
      host.ownerRow = node;
      tracked.add(host);
    }
    for (const host of [...tracked]) if (!host.isConnected) tracked.delete(host);
    const existing = [...tracked];
    const stripOf = (host) => host.closest?.('[' + DELETE_STRIP_ATTR + ']')
      || (host.parentNode?.hasAttribute?.(DELETE_STRIP_ATTR) ? host.parentNode : null);
    const discard = (host) => {
      const previousStrip = stripOf(host);
      host.remove();
      tracked.delete(host);
      releaseDeleteStrip(previousStrip);
    };
    const actions = canDeleteTurn(entry)
      ? [
          { key: 'turn:' + String(entry.seq), label: 'Delete this user turn', title: 'Delete turn', glyph: 'trash', run: requestTurnDeletion },
          { key: 'after:' + String(entry.seq), label: 'Hide all history after this message', title: 'Hide all history after this message', glyph: 'truncate', run: requestTruncateAfter }
        ]
      : canDeleteMessage(entry)
        ? [{ key: 'message:' + String(entry.seq), label: 'Delete this assistant message', title: 'Delete message', glyph: 'trash', run: requestMessageDeletion }]
        : [];
    if (!actions.length) {
      for (const host of existing) discard(host);
      for (const ownedStrip of node.querySelectorAll('[' + DELETE_STRIP_ATTR + ']')) releaseDeleteStrip(ownedStrip);
      releaseDeleteStrip(strip);
      deleteHosts.delete(node);
      node.removeAttribute(DELETE_REGION_ATTR);
      return;
    }
    installAffordance();
    node.setAttribute(DELETE_REGION_ATTR, '');
    const wanted = new Set(actions.map((action) => action.key));
    const byKey = new Map();
    for (const host of existing) {
      const key = host.getAttribute(DELETE_ACTION_ATTR);
      if (!wanted.has(key) || byKey.has(key)) discard(host);
      else byKey.set(key, host);
    }
    strip?.setAttribute(DELETE_STRIP_ATTR, '');
    const { containers, thinks } = textLayout(node, entry);
    let fallbackAfter = containers[containers.length - 1] || thinks[thinks.length - 1] || null;
    const place = (host) => {
      const previousStrip = stripOf(host);
      if (strip) {
        host.setAttribute('data-native-strip', '');
        if (host.parentNode !== strip) strip.append(host);
      } else {
        host.removeAttribute('data-native-strip');
        if (fallbackAfter) fallbackAfter.after(host);
        else if (host.parentNode !== node) node.append(host);
        fallbackAfter = host;
      }
      if (previousStrip !== strip) releaseDeleteStrip(previousStrip);
    };
    for (const action of actions) {
      let host = byKey.get(action.key);
      if (host) {
        host.ownerRow = node;
        place(host);
        continue;
      }
      host = document.createElement('span');
      host.ownerRow = node;
      host.setAttribute(DELETE_ACTION_ATTR, action.key);
      tracked.add(host);
      const actionRoot = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:inline-flex;align-items:center;align-self:flex-end;opacity:0;pointer-events:none;color:var(--dsw-alias-state-error-primary);transition:opacity .12s ease}'
        + ':host([data-native-strip]),:host-context([' + DELETE_REGION_ATTR + ']:hover),:host(:focus-within){opacity:1;pointer-events:auto}'
        + 'button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:7px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer}'
        + 'button:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'
        + 'svg{display:block;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
        + '@media(pointer:coarse){button{min-height:44px;min-width:44px;padding:10px}}';
      const button = document.createElement('button');
      button.type = 'button';
      const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      glyph.setAttribute('viewBox', '0 0 24 24');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', action.glyph === 'truncate'
        ? 'M5 6h8M5 12h5M5 18h2M17 5v14m-3-3 3 3 3-3'
        : 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5m4-5v5');
      glyph.append(path);
      button.append(glyph);
      button.setAttribute('aria-label', action.label);
      button.title = action.title;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.run(entry, button);
      });
      actionRoot.append(style, button);
      place(host);
    }
  };

  /**
   * Anchor the pin, and mark the regions a reader may click to edit.
   *
   * The pin itself is invisible: it is left as the block's next sibling only so that its
   * keyboard button lives beside the text it edits, and its real work is done by the marks.
   * Marking writes one attribute onto the shell's nodes and never a layout property, so a marked
   * block keeps its own containing block and its own flow. The marks are cleaned up whenever the
   * pin is re-placed or removed, so a row that stops being editable stops accepting clicks.
   */
  const placePencil = (pin, node, entry, target) => {
    installAffordance();
    const { texts, thoughts, containers, thinks } = textLayout(node, entry);
    const think = target.kind === 'reasoning' && thinks.length === thoughts.length ? thinks[thoughts.indexOf(target)] : null;
    const source = entry.type === 'user/message' ? containers[0]
      : containers.length === texts.length ? containers[texts.findIndex((item) => item.at === target.at)] : null;
    const projected = [...(projections.get(node)?.values() || [])].find((record) => record.source === source && !record.inPlace);
    const actions = userActionStrip(node, entry);
    const anchor = actions || think || projected?.host || source || node;
    if (pin.anchor === anchor && pin.isConnected) return;
    pin.cleanup?.(); pin.style.cssText = ''; pin.anchor = anchor;
    pin.cleanup = null;
    const regions = regionsFor(node, entry, target, anchor);
    pin.regions = regions;
    // A chooser answers for a whole message, but the reader still clicked one block of it:
    // resolving that block here is what keeps the click on the text instead of throwing the panel
    // open to ask which block was meant.
    pin.blockAt = (element) => {
      if (target.chooser !== true || element === undefined || element === null) return undefined;
      const { texts, thoughts, containers, thinks } = textLayout(node, entry);
      const inPart = (part) => part === element || part.contains(element);
      if (containers.length > 0 && containers.length === texts.length) {
        const index = containers.findIndex(inPart);
        if (index >= 0) return texts[index].at;
      }
      if (thinks.length > 0 && thinks.length === thoughts.length) {
        const index = thinks.findIndex(inPart);
        if (index >= 0) return thoughts[index].at;
      }
      return undefined;
    };
    for (const region of regions) markRegion(region);
    // Shared chooser/block regions retain the mark until their final pin is removed.
    pin.cleanup = () => {
      for (const region of pin.regions || []) unmarkRegion(region);
      pin.regions = [];
    };
    if (actions) actions.prepend(pin);
    else if (anchor === node) node.append(pin);
    else {
      anchor.after(pin);
      if (entry.type === 'user/message') pin.style.alignSelf = 'flex-end';
    }
  };
  const projectRow = (node, entry) => {
    if (STATE.draft?.inline?.node === node) return;
    const wanted = [];
    const { targets, texts, thoughts, containers, thinks } = textLayout(node, entry);
    const add = (target, key, source, text, preview = false, anchor = null, includeControls = false) => {
      // Never hide media or independent actions embedded in a familiar container.
      if (source && (source.closest('[data-chat-flow-key]') !== node || source.closest('[data-trajectory-scroll]'))) source = null;
      if (source && embeddedContent(source)) source = null;
      wanted.push({ target, key, source, text, preview, anchor, includeControls, fallback: !source && !includeControls });
    };
    // UserStyleBubble combines all text blocks. Keep per-block editors, but project once.
    if (entry?.type === 'user/message' && entry.editable === true && targets.length > 0
      && texts.length === targets.length && containers.length === 1 && badgeText(entry)) {
      const message = { ...entry, kind: 'text', label: 'Message' };
      if (entry.changed !== true || entry.editStatus === 'refused' || entry.editStatus === 'mixed') add(message, 'message', null, null);
      else add(message, 'message', containers[0], entry.text);
    }
    for (const target of entry?.type === 'user/message' ? [] : targets) {
      if (!badgeText(target)) continue;
      if (target.changed !== true || target.editStatus === 'refused') {
        add(target, String(target.at), null, null);
      } else if (target.kind === 'text') {
        const source = containers.length === texts.length ? containers[texts.indexOf(target)] : null;
        add(target, String(target.at), source, target.text);
      } else {
        const think = thinks.length === thoughts.length ? thinks[thoughts.indexOf(target)] : null;
        const summaries = think ? [...think.querySelectorAll('[class]')].filter((part) => hasToken(part, 'summaryText')) : [];
        const expanded = think ? [...think.querySelectorAll('[class]')].filter((part) => hasToken(part, 'thinkBody')) : [];
        if (think?.hasAttribute('data-expanded') && expanded.length === 1) {
          add(target, target.at + ':body', expanded[0], target.text);
        } else if (think && !think.hasAttribute('data-expanded') && summaries.length === 1) {
          add(target, target.at + ':summary', summaries[0], target.text.split('\\n')[0].replaceAll('**', ''), true, null, true);
        } else add(target, String(target.at), null, target.text);
      }
    }
    const records = projections.get(node) || new Map();
    const signature = (item) => JSON.stringify([STATE.sessionId, entry?.seq, entry?.id, item.target.at,
      item.text, item.target.text, badgeText(item.target), item.preview, item.fallback, item.includeControls]);
    for (const [key, record] of records) {
      const item = wanted.find((item) => item.key === key);
      if (!item || item.source !== record.source || item.anchor !== record.anchor || signature(item) !== record.signature
        || !record.host.isConnected || (record.inPlace ? record.source.innerHTML !== record.html
          : record.source && (record.source.nextSibling !== record.host || record.source.style.getPropertyValue('display') !== 'none'))) {
        restoreProjection(record);
        records.delete(key);
      }
    }
    for (const item of wanted) {
      if (records.has(item.key)) continue;
      const host = document.createElement('span');
      host.setAttribute('data-ctxkit-projection', item.key);
      const inPlace = item.source && !item.preview && (item.target.kind !== 'reasoning'
        || hasToken(item.source, 'thinkBody') && item.source.children.length === 0);
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;max-width:100%;min-width:0;font:inherit;color:inherit}'
        + '.effective-text{white-space:pre-wrap;overflow-wrap:anywhere}.badge,button,summary{font:12px/1.4 system-ui}'
        + '.badge{color:#438361} .refused{color:#b96a25}button{box-sizing:border-box;max-width:100%;margin:4px 8px 4px 0;padding:5px 9px;border:1px solid #ffffff24;border-radius:7px;background:#1d2129;color:#e8eaed;overflow-wrap:anywhere;cursor:pointer}'
        + 'button:focus-visible{outline:2px solid var(--studio-accent,#8caaff);outline-offset:2px}button:disabled{opacity:.5}@media(pointer:coarse){button{min-width:44px;min-height:44px}}'
        + (item.preview ? '.effective-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' : '');
      shadow.append(style);
      let content = shadow;
      if (item.fallback && item.text !== null && item.target.kind === 'reasoning') {
        content = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Effective thinking (display fallback)';
        content.append(summary);
        shadow.append(content);
      }
      if (!item.preview || item.includeControls) {
        const badge = document.createElement('span');
        badge.className = 'badge' + (item.target.editable === false || ['refused', 'mixed'].includes(item.target.editStatus) ? ' refused' : '');
        badge.textContent = (inPlace ? '' : item.target.label + ': ') + badgeText(item.target)
          + (item.fallback && item.text !== null ? '. Unknown layout: original display kept; effective text below.' : '');
        content.append(badge);
      }
      if (item.text !== null && !inPlace) {
        const text = document.createElement('div');
        text.className = 'effective-text';
        text.textContent = item.text;
        content.append(text);
      }
      if ((!item.preview || item.includeControls) && item.target.editable !== false && item.target.editStatus !== 'refused') {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy effective ' + labelOf(item.target);
        copy.setAttribute('aria-label', copy.textContent);
        if (inPlace) copy.textContent = 'Copy';
        const copyLabel = copy.textContent;
        copy.setAttribute('aria-live', 'polite');
        let copyTimer;
        copy.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(copyTimer);
          copy.disabled = true;
          try {
            await navigator.clipboard.writeText(item.target.text);
            copy.textContent = 'Copied';
            copyTimer = setTimeout(() => { copy.textContent = copyLabel; }, 2000);
          }
          catch { copy.textContent = 'Copy failed; select the effective text'; }
          finally { copy.disabled = false; }
        });
        content.append(copy);
      }
      const source = item.source;
      const record = { host, source, anchor: item.anchor, signature: signature(item),
        display: source?.style.getPropertyValue('display'), priority: source?.style.getPropertyPriority('display') };
      if (inPlace) {
        record.inPlace = true;
        record.original = [...source.childNodes];
        const whiteSpace = source.style.getPropertyValue('white-space');
        const priority = source.style.getPropertyPriority('white-space');
        source.replaceChildren(document.createTextNode(item.text));
        source.style.setProperty('white-space', 'pre-wrap');
        record.html = source.innerHTML;
        source.after(host);
        record.cleanup = () => {
          if (source.style.getPropertyValue('white-space') !== 'pre-wrap') return;
          if (whiteSpace) source.style.setProperty('white-space', whiteSpace, priority);
          else source.style.removeProperty('white-space');
        };
      } else if (source) { source.after(host); source.style.setProperty('display', 'none', 'important'); }
      else if (item.anchor) item.anchor.after(host);
      else node.append(host);
      records.set(item.key, record);
    }
    if (records.size) projections.set(node, records);
    else projections.delete(node);
  };
  const pinnedRows = new Set();
  const rowOwners = new WeakMap();
  const hiddenRows = new WeakSet();
  const setDeletedVisibility = (node, hidden) => {
    if (hidden) {
      if (!node.hasAttribute(HIDDEN_TURN_ATTR)) {
        node.setAttribute(HIDDEN_TURN_ATTR, '');
        hiddenRows.add(node);
      }
      return;
    }
    if (hiddenRows.has(node)) {
      node.removeAttribute(HIDDEN_TURN_ATTR);
      hiddenRows.delete(node);
    }
  };
  const restoreDeletedVisibility = () => {
    for (const node of document.querySelectorAll('[' + HIDDEN_TURN_ATTR + ']')) setDeletedVisibility(node, false);
  };
  const decorateTranscript = () => {
    const draft = STATE.draft;
    if (draft?.inline && (!draft.inline.host.isConnected || !draft.inline.source.isConnected
      || (draft.inline.inPlace && (draft.inline.source.innerHTML !== draft.inline.html
        || draft.inline.source.checkVisibility?.() === false
        || draft.inline.think && draft.inline.think.hasAttribute('data-expanded') !== draft.inline.expanded))
      || running(draft.inline.node) || !draft.save.disabled && entryFor(STATE.transcript, targetOf(draft.inline.node))?.id !== draft.entry.id)) {
      // React may unmount a bubble or disclosure. Move the existing editor, never lose its draft.
      draft.inline.cleanup?.();
      for (const hidden of draft.inline.hidden) restoreDisplay(hidden);
      draft.inline.host.remove();
      draft.inline = null;
      draft.row.inline = null;
      list.querySelector('li[data-seq="' + draft.entry.seq + '"]')?.remove();
      list.prepend(draft.row);
      showPanel();
      draft.area.focus();
      say('The Chat block moved. Your draft is kept here; saving still checks the original target.', 'err');
    }
    installAffordance();
    const ownedRows = flowRows().filter((node) => {
      if (STATE.sessionId === '') return false;
      if (!rowOwners.has(node)) rowOwners.set(node, STATE.sessionId);
      return rowOwners.get(node) === STATE.sessionId;
    });
    const rows = ownedRows.filter((node) =>
      ['user', 'steering', 'assistant-step'].includes(node.getAttribute('data-chat-flow-kind')));
    const hiddenTurns = deletedTurnsOf(STATE.hidden);
    const hiddenFor = (node) => deletedEntryFor(STATE.hidden, hiddenTurns, node);
    for (const node of ownedRows) setDeletedVisibility(node, !!hiddenFor(node));
    for (const host of document.querySelectorAll('[' + DELETE_ACTION_ATTR + ']')) {
      const row = host.ownerRow || host.closest(FLOW_SELECTOR);
      if (!rows.includes(row)) {
        const strip = host.closest('[' + DELETE_STRIP_ATTR + ']');
        row?.removeAttribute(DELETE_REGION_ATTR);
        for (const ownedStrip of row?.querySelectorAll?.('[' + DELETE_STRIP_ATTR + ']') || []) ownedStrip.removeAttribute(DELETE_STRIP_ATTR);
        host.remove();
        releaseDeleteStrip(strip);
      }
    }
    for (const [node, records] of projections) {
      if (rows.includes(node) && !running(node) && !hiddenFor(node)) continue;
      for (const record of records.values()) restoreProjection(record);
      projections.delete(node);
    }
    for (const node of pinnedRows) {
      if (rows.includes(node) && !hiddenFor(node) && entryFor(STATE.transcript, targetOf(node))) continue;
      for (const pin of node.querySelectorAll('[' + PENCIL_ATTR + ']')) { pin.cleanup?.(); pin.remove(); }
      pinnedRows.delete(node);
    }
    for (const node of rows) {
      const identity = targetOf(node);
      const hidden = hiddenFor(node);
      const entry = entryFor(STATE.transcript, identity);
      if (hidden) {
        placeDeleteAction(node, undefined);
        continue;
      }
      projectRow(node, running(node) ? undefined : entry);
      placeDeleteAction(node, entry);
      if (STATE.draft?.inline?.node === node) continue;
      // ONE PENCIL PER EDITABLE TARGET: a reply of [reasoning, text] gets two - the
      // answer and the thinking - a message with one target gets one, and a message that
      // offers none gets none. The markers are read back off the row itself, so a
      // re-decoration adds nothing and a pencil whose target is gone is removed.
      const offers = entry === undefined ? [] : pinTargets(entry);
      const wanted = offers.length > 2 ? [{ label: 'Message', chooser: true }] : offers;
      if (wanted.length) pinnedRows.add(node);
      const pinned = new Map();
      for (const pin of node.querySelectorAll('[' + PENCIL_ATTR + ']')) {
        const parsed = parseKey(pin.getAttribute('data-ctxkit-for'));
        const keep = entry !== undefined && parsed !== undefined && parsed.seq === Number(entry.seq)
          && wanted.some((target) => sameTarget(target, parsed));
        if (keep) pinned.set(keyOf(parsed.seq, parsed.at), pin);
        else { pin.cleanup?.(); pin.remove(); }
      }
      for (const target of wanted) {
        const key = keyOf(entry.seq, target.at);
        let pin = pinned.get(key);
        if (pin === undefined) {
          pin = addPencil(node, entry, target);
          pinned.set(key, pin);
        }
        placePencil(pin, node, entry, target);
      }
      if (!wanted.length) pinnedRows.delete(node);
    }
  };

  // The transcript changes under us: messages stream, sessions switch, nodes are
  // recycled. The SHAPE (which message keys are on screen) decides whether the
  // list has to be fetched again - a streamed token changes the text but not the
  // shape, so typing in a reply costs no requests.
  const syncSession = () => {
    const found = currentSessionId();
    if (found === STATE.sessionId) return;
    // Abort before changing the generation key, so no request for the departing session can
    // retain the scheduler lease or start its queued foreground continuation.
    load.abort();
    // Retained rows still belong to the departing session, even before their first decoration.
    if (STATE.sessionId !== '') {
      for (const node of flowRows()) if (!rowOwners.has(node)) rowOwners.set(node, STATE.sessionId);
    }
    restoreDeletedVisibility();
    const draft = STATE.draft;
    settleConfirmation();
    if (draft && draft.area.value !== draft.target.text) {
      drafts.set(STATE.sessionId, { seq: draft.entry.seq, id: draft.entry.id, at: draft.target.at,
        text: draft.area.value, expected: draft.target.text });
    }
    if (draft) finishDraft(draft);
    STATE.sessionId = found;
    STATE.epoch += 1;
    STATE.request += 1;
    STATE.draft = null;
    STATE.pending = null;
    STATE.entries = [];
    STATE.transcript = [];
    STATE.hidden = [];
    STATE.listed = false;
    clearList();
    sub.textContent = '';
    doctrine.replaceChildren();
    note.textContent = '';
    say(found ? 'Session changed. Unsaved drafts are kept separately for each session.'
      : 'Waiting for a conversation to load or be selected.');
    decorateTranscript();
  };
  let shape = '';
  const flowShape = () => STATE.sessionId + '|' + chatRows().map((node) => node.getAttribute('data-chat-flow-key')
    + ':' + node.getAttribute('data-chat-flow-kind') + ':' + running(node)).join('|');
  const watch = () => load(false);
  let queued = null;
  let forceRefresh = false;
  const schedule = (force = false) => {
    syncSession();
    forceRefresh ||= force;
    if (queued !== null) return;
    queued = window.setTimeout(() => {
      queued = null;
      const next = flowShape();
      const refresh = forceRefresh || next !== shape;
      forceRefresh = false;
      shape = next;
      decorateTranscript();
      if (refresh) void watch();
    }, 120);
  };
  // Attribute changes catch recycled identities and streaming completion. Ignore our
  // own insertions; shadow mutations never cross this observer boundary.
  const owned = (node) => node.nodeType === 1 && (node.hasAttribute(PENCIL_ATTR) || node.hasAttribute(DELETE_ACTION_ATTR) || node.hasAttribute('data-ctxkit-surface') || node.hasAttribute('data-ctxkit-projection') || node.hasAttribute('data-ctxkit-inline'));
  new MutationObserver((records) => {
    if (records.some((record) => record.type !== 'childList' || record.removedNodes.length > 0
      || [...record.addedNodes, ...record.removedNodes].some((node) => !owned(node)))) schedule();
  }).observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: ['data-chat-flow-key', 'data-chat-flow-kind', 'data-streaming', 'data-state', 'data-expanded', 'class', 'hidden'] });
  window.addEventListener('focus', () => schedule(STATE.open));
  window.addEventListener('dsh-context-kit:session', () => schedule(true));
  window.addEventListener('beforeunload', (event) => {
    if (drafts.size || (STATE.draft && (STATE.draft.save.disabled || STATE.draft.area.value !== STATE.draft.target.text))) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // The pencil knows WHICH BLOCK it was drawn for, so the row is opened on that target:
  // the picker is moved to it first, because opening the row reads the selection. A caller
  // holding the ATTRIBUTE may pass "<seq>:<at>" as one string - the same thing written
  // down - and the bare "<seq>" of the first release still means the default block.
  const targetKey = (seq, at) => {
    const written = typeof seq === 'string' ? parseKey(seq) : undefined;
    if (written !== undefined) return written;
    return { seq, at: Number.isInteger(at) ? at : undefined };
  };

  const focusRow = (seq, at) => {
    const wanted = targetKey(seq, at);
    let row = list.querySelector('li.row[data-seq="' + wanted.seq + '"]');
    if (!row) {
      const entry = STATE.transcript.find((entry) => entry.seq === wanted.seq);
      if (entry) { row = decorate(entry); list.prepend(row); }
    }
    if (row === null) {
      say('seq ' + wanted.seq + ' is not in the list any more; reload it.', 'err');
      return;
    }
    row.scrollIntoView({ block: 'center' });
    row.openEditor?.(wanted.at);
  };

  const focusInline = async (seq, at, returnFocus) => {
    const entry = STATE.transcript.find((entry) => entry.seq === seq);
    if (!entry || drafts.has(STATE.sessionId)) return false;
    const offers = pinTargets(entry);
    const target = Number.isInteger(at) ? offers.find((target) => target.at === at)
      : offers.find((target) => target.kind === 'text') || offers[0];
    if (!target) return false;
    const rows = chatRows().filter((node) => rowOwners.get(node) === STATE.sessionId && !running(node)
      && entryFor(STATE.transcript, targetOf(node)) === entry);
    if (rows.length !== 1) return false;
    const node = rows[0];
    const { targets, texts, thoughts, containers, thinks } = textLayout(node, entry);
    let source;
    let think = null;
    let temporary = false;
    if (entry.type === 'user/message') source = containers.length === 1 && texts.length === 1 && targets.length === 1 ? containers[0] : null;
    else if (target.kind === 'text') source = containers.length === texts.length ? containers[texts.indexOf(target)] : null;
    else {
      think = thinks.length === thoughts.length ? thinks[thoughts.indexOf(target)] : null;
      if (!think || think.closest('[hidden]') || think.checkVisibility?.() === false) return false;
      const bodies = [...think.querySelectorAll('[class]')].filter((part) => hasToken(part, 'thinkBody'));
      source = think.hasAttribute('data-expanded') && bodies.length === 1 ? bodies[0] : null;
      // A collapsed disclosure has no editable body. Use an owned surface without toggling React state.
      if (!think.hasAttribute('data-expanded')) {
        temporary = true;
        source = document.createElement('div');
        source.setAttribute('data-ctxkit-surface', '');
        source.style.cssText = 'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));padding:4px 0 4px 22px;color:inherit';
      }
    }
    if (!source || !temporary && source.closest('[data-chat-flow-key]') !== node
      || embeddedContent(source)) return false;
    if (!temporary && (!source.getClientRects().length || source.checkVisibility?.() === false)) return false;
    if (target.kind !== 'reasoning' || source.children.length === 0) {
      // Edit raw text in the native container; retain actual renderer nodes for cancellation.
      for (const [key, record] of projections.get(node) || []) {
        if (record.source !== source) continue;
        restoreProjection(record);
        projections.get(node).delete(key);
      }
      const host = document.createElement('div');
      host.setAttribute('data-ctxkit-inline', keyOf(entry.seq, target.at));
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = css.textContent
        + ':host{display:block;max-width:100%;min-width:0}'
        + 'li.row{list-style:none;margin:0;padding:0;border:0;background:transparent}'
        + '.meta,.row>.acts,textarea{display:none}.acts{gap:4px;margin:0;padding:4px;flex-wrap:wrap;justify-content:flex-end}'
        + '.acts button{box-sizing:border-box;font-size:12px;line-height:1.3;min-height:28px;padding:4px 10px}.acts .save:not(.accept),.acts .cancel{width:28px;height:28px;min-width:28px;min-height:28px;padding:6px}.acts .cancel{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#808080)}.acts .save:disabled:not(.accept){width:auto;min-width:0;padding:4px 10px}.acts .cancel:hover{background:transparent;color:var(--dsw-alias-label-primary,#eeeeee)}.restore:disabled{display:none}.why:not(.err){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}'
        + '.why.err{width:100%;max-height:min(160px,25dvh);overflow:auto;padding:8px;color:var(--dsw-alias-label-primary,#253044);border-left:2px solid #d67869;border-radius:4px}'
        + '@media(pointer:coarse){.acts button{min-height:44px;min-width:44px}.acts .save:not(.accept),.acts .cancel{width:44px;height:44px;min-width:44px;min-height:44px}}';
      const row = decorate(entry);
      const area = row.querySelector('textarea');
      const restore = row.querySelector('.restore');
      restore.textContent = 'Restore';
      restore.setAttribute('aria-label', 'Restore original ' + labelOf(target));
      restore.title = 'Restore original ' + labelOf(target);
      shadow.append(style, row);
      const original = [...source.childNodes];
      const scroll = source.scrollTop;
      const attrs = ['contenteditable', 'role', 'aria-label', 'aria-multiline', 'aria-readonly', 'aria-description', 'spellcheck'];
      const previous = attrs.map((name) => [name, source.getAttribute(name)]);
      const properties = ['outline', 'outline-offset', 'border-radius', 'white-space', 'overflow-wrap', 'height', 'max-height', 'min-height', 'overflow-y', 'overscroll-behavior', 'box-sizing', 'width', 'max-width', 'resize'];
      const styles = properties.map((name) => [name, source.style.getPropertyValue(name), source.style.getPropertyPriority(name)]);
      const bounds = (temporary ? think : source).getBoundingClientRect();
      const pin = node.querySelector('[' + PENCIL_ATTR + '][data-ctxkit-for="' + keyOf(entry.seq, target.at) + '"]');
      if (!pin) return false;
      placePencil(pin, node, entry, target);
      const anchorView = () => {
        const y = pin.getBoundingClientRect().bottom;
        const session = STATE.sessionId;
        let scroller = pin.parentElement;
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        scroller ||= document.scrollingElement;
        const scrollTop = scroller.scrollTop;
        return () => {
          if (session !== currentSessionId() || Math.abs(scroller.scrollTop - scrollTop) > 2) return;
          const current = pin.isConnected ? pin : [...node.querySelectorAll('[' + PENCIL_ATTR + ']')].find((part) => parseKey(part.getAttribute('data-ctxkit-for'))?.at === target.at);
          if (current && y > 0 && y < window.innerHeight) scroller.scrollTop += current.getBoundingClientRect().bottom - y;
        };
      };
      const restoreView = anchorView();
      const thinkStyle = temporary ? think.getAttribute('style') : null;
      if (temporary) {
        think.style.height = 'auto'; think.style.contain = 'none';
        think.append(source);
      }
      const pencil = pin.shadowRoot.querySelector('button');
      pencil.hidden = true;
      pin.setAttribute('data-editing', '');
      pin.append(host);
      const stop = (event) => event.stopPropagation();
      let autoHeight = '';
      let manualSize = false;
      const fit = () => {
        if (autoHeight && source.style.height !== autoHeight) manualSize = true;
        if (manualSize) return;
        const scroll = source.scrollTop;
        source.style.height = 'auto';
        const border = source.offsetHeight - source.clientHeight;
        source.style.height = Math.min(420, window.innerHeight * .45, source.scrollHeight + border) + 'px';
        autoHeight = source.style.height;
        source.scrollTop = scroll;
      };
      const input = () => {
        area.value = source.innerText.replace(/\\r/g, '');
        row.inline.html = source.innerHTML;
        fit();
      };
      const paste = (event) => {
        if (!source.isContentEditable || !event.clipboardData) return;
        event.preventDefault();
        event.stopPropagation();
        // Choose the literal clipboard text, not HTML-to-text conversion; retain native undo.
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/\\r\\n?/g, '\\n'));
        input();
      };
      row.inline = { host, node, source, hidden: [], inPlace: true, anchorView, think, expanded: think?.hasAttribute('data-expanded'),
        returnFocus: returnFocus || pencil,
        start: (text) => {
          source.replaceChildren(document.createTextNode(text));
          row.inline.html = source.innerHTML;
          source.contentEditable = 'plaintext-only';
          source.setAttribute('role', 'textbox');
          source.setAttribute('aria-label', target.label + ' text for seq ' + entry.seq);
          source.setAttribute('aria-multiline', 'true');
          source.setAttribute('aria-description', 'Ctrl or Cmd+Enter saves. Escape cancels.');
          source.spellcheck = false;
          source.style.setProperty('outline', '1px solid var(--dsw-alias-border-l1, #8793a64d)');
          source.style.setProperty('outline-offset', '3px');
          source.style.setProperty('border-radius', '4px');
          source.style.setProperty('white-space', 'pre-wrap');
          source.style.setProperty('overflow-wrap', 'anywhere');
          source.style.setProperty('box-sizing', 'border-box');
          source.style.setProperty('width', bounds.width + 'px');
          source.style.setProperty('max-width', '100%');
          source.style.setProperty('max-height', 'min(720px, 75dvh)');
          source.style.setProperty('min-height', '32px');
          source.style.setProperty('resize', 'vertical');
          source.style.setProperty('overflow-y', 'auto');
          source.style.setProperty('overscroll-behavior', 'contain');
          fit();
        },
        setReadOnly: (busy) => {
          source.contentEditable = busy ? 'false' : 'plaintext-only';
          source.setAttribute('aria-readonly', String(busy));
        },
        cleanup: () => {
          source.removeEventListener('input', input);
          source.removeEventListener('paste', paste);
          source.removeEventListener('keydown', row.editorKeydown);
          source.removeEventListener('click', stop);
          if (source.innerHTML === row.inline.html) source.replaceChildren(...original);
          for (const [name, value] of previous) {
            if (value === null) source.removeAttribute(name);
            else source.setAttribute(name, value);
          }
          for (const [name, value, priority] of styles) {
            if (value) source.style.setProperty(name, value, priority);
            else source.style.removeProperty(name);
          }
          source.scrollTop = scroll;
          if (temporary) {
            source.remove();
            if (thinkStyle === null) think.removeAttribute('style'); else think.setAttribute('style', thinkStyle);
          }
          pencil.hidden = false;
          pin.removeAttribute('data-editing');
        }
      };
      source.addEventListener('input', input);
      source.addEventListener('paste', paste);
      source.addEventListener('keydown', row.editorKeydown);
      source.addEventListener('click', stop);
      host.addEventListener('click', stop);
      host.addEventListener('keydown', stop);
      row.openEditor(target.at);
      restoreView();
      return true;
    }
    return false;
  };

  const openAt = (seq, at) => {
    syncSession();
    const wanted = targetKey(seq, at);
    const draft = STATE.draft;
    if (draft?.inline && draft.entry.seq === Number(wanted.seq)
      && (!Number.isInteger(wanted.at) || draft.target.at === wanted.at)) {
      draft.row.focusEditor();
      return;
    }
    const returnFocus = STATE.draft?.entry.seq === Number(seq) ? STATE.draft.inline?.returnFocus : undefined;
    if (!leaveDraft(() => openAt(seq, at))) return;
    const entry = STATE.transcript.find((entry) => entry.seq === wanted.seq);
    const identity = entry?.type === 'user/message' ? entry.originId : { turn: entry?.turn, step: entry?.step };
    // Open synchronously from the last Host-validated list. Saving retains the original expected
    // text and is revalidated by the Host, while a background refresh catches stale projections.
    if (STATE.listed && entry) {
      const sessionId = STATE.sessionId;
      const epoch = STATE.epoch;
      void focusInline(wanted.seq, wanted.at, returnFocus).then((opened) => {
        if (!isCurrent(sessionId, epoch)) return;
        if (opened) void load(false);
        else {
          STATE.pending = { ...wanted, inline: true, returnFocus, identity };
          void load(true);
        }
      });
      return;
    }
    STATE.pending = { ...wanted, inline: true, returnFocus, identity };
    void load(true);
  };

  const showPanel = () => {
    if (!STATE.open) {
      returnFocus = document.activeElement;
      while (returnFocus?.shadowRoot?.activeElement) returnFocus = returnFocus.shadowRoot.activeElement;
    }
    STATE.open = true;
    notice.hidden = true;
    wrap.classList.add('open');
    if (!wrap.open) { wrap.showModal(); el('header .x').focus(); }
  };
  const openPanel = () => {
    syncSession();
    if (generationRunning()) {
      showPanel();
      say(STOP_GENERATION, 'err');
      return;
    }
    if (STATE.draft?.inline && !leaveDraft(openPanel)) return;
    showPanel();
    if (!STATE.draft) clearList();
    void load(true);
  };

  const close = () => {
    if (!leaveDraft(close)) return;
    STATE.open = false;
    wrap.classList.remove('open');
    wrap.close();
    (returnFocus?.isConnected ? returnFocus : launch).focus();
  };
  launch.addEventListener('click', openPanel);
  el('header .x').addEventListener('click', close);
  el('.scrim').addEventListener('click', close);
  // Native modal isolation makes the rest of the page inert; wrap Tab within our controls.
  wrap.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  wrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...wrap.querySelectorAll('button, select, textarea')].filter((node) => !node.disabled && node.getClientRects().length > 0);
    const index = controls.indexOf(root.activeElement);
    const next = event.shiftKey ? index - 1 : index + 1;
    if (index === -1 || next < 0 || next >= controls.length) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  });
  syncSession();
  shape = flowShape();
  void watch();
}
`;
}
