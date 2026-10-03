// The revisioned client registry updates this module without restarting the host.
window.__ModuleLoader__.load({
  id: 'dsh-context-kit-runtime-4',
  factory(require) {
    return {
      inject: ['sessions'],
      apply(ctx) {
        if (typeof ctx.inject === 'function') ctx.inject(['configForms', 'slots'], settingsCtx => {
          const React = require('react');
          const h = React.createElement;
          const namespace = 'context-kit-bundle';
          const plugins = [
            { section: 'dcp', key: 'dcp', title: 'DCP', timing: 'Applies to the next step',
              description: 'Prune redundant context and compress selected ranges. Native automatic compaction remains available.',
              fields: [['enabled', 'Enable DCP'], ['manualMode', 'Manual mode'], ['automaticStrategies', 'Keep automatic pruning in manual mode']] },
            { section: 'contextMode', key: 'context-mode', title: 'Context Mode', timing: 'Restart required',
              description: 'Run tools with bounded output and a searchable knowledge base isolated by project.',
              fields: [['enabled', 'Enable Context Mode'], ['routingGuard', 'Guide large outputs into Context Mode'], ['guidance', 'Include usage guidance'], ['restrictPathsToWorkspace', 'Restrict file paths to workspace']] },
            { section: 'historyEditor', key: 'history-editor', title: 'History Editor', timing: 'Applies immediately',
              description: 'Edit messages in place. Independent of DCP and the selected agent preset.',
              fields: [['enabled', 'Enable history editing'], ['requireIdle', 'Require an idle conversation']] }
          ];
          const promptLabels = [
            ['system', 'System guidance', 'Included with the system instructions. Protected-tool and manual-mode rules are added automatically.'],
            ['turnNudge', 'Context reminder', 'A gentle reminder between the lower and upper context thresholds.'],
            ['contextLimitNudge', 'Context-limit reminder', 'Used at the upper threshold. Current token counts and compressed-block references are added automatically.'],
            ['iterationNudge', 'Long-run reminder', 'Used after many assistant steps without a new user message, even below the lower threshold.'],
            ['compressRange', 'Compress ranges', 'Instructions for the range-mode compress tool. Its required input format is appended automatically.'],
            ['compressMessage', 'Compress messages', 'Instructions for experimental message mode. Used only when that mode is selected.']
          ];
          const scope = settingsCtx.configForms.get(namespace);
          const subscribe = listener => scope.subscribe(listener);
          const snapshot = () => scope.getSnapshot();
          const cards = [];
          for (const spec of plugins) {
            function SettingsCard() {
              const view = React.useSyncExternalStore(subscribe, snapshot);
              const [draft, setDraft] = React.useState(null);
              const [busy, setBusy] = React.useState(false);
              const [notice, setNotice] = React.useState('');
              const [expanded, setExpanded] = React.useState(false);
              const [dcpInfo, setDcpInfo] = React.useState(null);
              const [promptName, setPromptName] = React.useState('system');
              const [promptDrafts, setPromptDrafts] = React.useState({});
              React.useEffect(() => {
                if (spec.key !== 'dcp' || !expanded || view.status !== 'ready') return;
                if (!view.value?.[spec.section]?.prompts) { setDcpInfo({ outdated: true }); return; }
                const controller = new AbortController();
                fetch('/ctxkit.dcp/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
                  body: JSON.stringify({ type: 'client-request', rpcId: 'dcp-settings', method: 'prompts', payload: {} }) })
                  .then(response => { if (!response.ok) throw new Error('DCP settings unavailable'); return response.json(); })
                  .then(data => { if (!data.result?.ok || !data.result.value?.liveSettings) throw new Error('DCP settings unavailable'); setDcpInfo(data.result.value); })
                  .catch(error => { if (error.name !== 'AbortError') setDcpInfo({ error: true }); });
                return () => controller.abort();
              }, [expanded, view.status, view.revision]);
              const published = view.value?.[spec.section] ?? {};
              const text = draft?.text ?? JSON.stringify(published, null, 2);
              let value;
              try { value = JSON.parse(text); } catch { value = null; }
              const manual = value?.manualMode && typeof value.manualMode === 'object' ? value.manualMode : null;
              const writable = view.status === 'ready' && view.writable && !busy && (spec.key !== 'dcp' || dcpInfo?.liveSettings === true);
              const edit = next => {
                setNotice('');
                setDraft({ text: next, revision: draft?.revision ?? view.revision, base: draft?.base ?? published });
              };
              const validObject = value && typeof value === 'object' && !Array.isArray(value);
              const read = path => path.split('.').reduce((node, key) => node?.[key], value);
              const change = (path, next) => {
                if (!validObject) return;
                const copy = JSON.parse(text), keys = path.split('.');
                let node = copy;
                for (const key of keys.slice(0, -1)) {
                  if (node[key] == null) node[key] = {};
                  if (typeof node[key] !== 'object' || Array.isArray(node[key])) { setNotice('Fix the invalid Advanced configuration before editing this field.'); return; }
                  node = node[key];
                }
                node[keys[keys.length - 1]] = next;
                edit(JSON.stringify(copy, null, 2));
              };
              const field = (path, label, hint, type = 'checkbox', choices = []) => {
                const current = read(path), disabled = !writable || !validObject;
                const common = { 'aria-label': label, disabled };
                let control;
                if (type === 'checkbox') control = h('input', { ...common, type, checked: current === true, onChange: event => change(path, event.target.checked) });
                else if (type === 'select') control = h('select', { ...common, value: current ?? choices[0]?.[0], onChange: event => change(path, event.target.value) },
                  ...choices.map(([key, title]) => h('option', { key, value: key }, title)));
                else if (type === 'threshold') {
                  const percent = typeof current === 'string' && current.endsWith('%');
                  const amount = percent ? current.slice(0, -1) : current ?? '';
                  control = h('div', { className: 'ctxkit-limit' },
                    h('input', { ...common, type: 'number', min: 0, max: percent ? 100 : undefined, step: 1, value: amount,
                      onChange: event => change(path, percent ? event.target.value + '%' : event.target.value === '' ? '' : Number(event.target.value)) }),
                    h('select', { 'aria-label': label + ' unit', disabled, value: percent ? '%' : 'tokens',
                      onChange: event => change(path, event.target.value === '%' ? amount + '%' : amount === '' ? '' : Number(amount)) },
                      h('option', { value: 'tokens' }, 'Tokens'), h('option', { value: '%' }, '% of window')));
                } else control = h('input', { ...common, type: 'number', min: type === 'count0' ? 0 : 1, step: 1, value: current ?? '',
                  onChange: event => change(path, event.target.value === '' ? '' : Number(event.target.value)) });
                return h('div', { key: path, className: 'ctxkit-setting' + (type === 'checkbox' ? ' toggle' : '') },
                  h('div', null, h('span', { className: 'ctxkit-field-title' }, label), h('small', null, hint)), control);
              };
              const group = (label, hint, controls, open = false) => h('details', { className: 'ctxkit-settings-group', open },
                h('summary', null, label), h('p', { className: 'ctxkit-settings-help' }, hint), ...controls);
              const save = async () => {
                if (!draft || !writable) return;
                if (!value || Array.isArray(value) || typeof value !== 'object') {
                  setNotice('Enter a JSON object. Your draft has not been saved.'); return;
                }
                const keys = new Set([...Object.keys(draft.base), ...Object.keys(value)]);
                if ([...keys].some(key => !Object.hasOwn(draft.base, key))) {
                  setNotice('Unknown setting. Use the fields shown in this configuration.'); return;
                }
                const ops = [...keys].filter(key => JSON.stringify(value[key]) !== JSON.stringify(draft.base[key]))
                  .map(key => Object.hasOwn(value, key) ? { op: 'set', path: [spec.section, key], value: value[key] }
                    : { op: 'unset', path: [spec.section, key] });
                setBusy(true); setNotice('');
                try {
                  const accepted = await scope.mutate(ops, draft.revision);
                  if (!accepted) throw new Error('Settings changed elsewhere or the server refused the values. Your draft is kept; cancel to reload current settings.');
                  setDraft(null);
                  setPromptDrafts({});
                  setNotice(spec.key === 'dcp' ? 'Saved. Applies to the next step; an in-flight request is unchanged.'
                    : spec.key === 'history-editor' ? 'Saved. Changes are active.' : 'Saved. Restart DSH to apply these changes.');
                } catch (error) { setNotice(error.message || 'Could not save. Your draft is kept.'); }
                finally { setBusy(false); }
              };
              return h('li', { className: 'ctxkit-settings-card', 'data-plugin-settings': spec.key, 'aria-label': spec.title },
                h('style', null, `
                  .ctxkit-settings-card{list-style:none;padding:0;min-width:0;border:.5px solid var(--dsw-alias-border-l4,#80808050);background:var(--dsw-alias-bg-layer-3,transparent);border-radius:16px;font:inherit;color:inherit}
                  .ctxkit-settings-card label{display:flex;align-items:center;gap:10px;margin:12px 0}
                  .ctxkit-settings-card input[type=checkbox]{flex:none;width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary,#507de3)}
                  .ctxkit-settings-card input:not([type=checkbox]),.ctxkit-settings-card select{box-sizing:border-box;width:100%;min-width:0;min-height:36px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l4,#80808050);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#202126);color:inherit;font:inherit}
                  .ctxkit-settings-card small{opacity:.7}
                  .ctxkit-settings-card summary{cursor:pointer;padding:8px 0}
                  .ctxkit-settings-card textarea{box-sizing:border-box;width:100%;min-height:140px;max-height:420px;resize:vertical;padding:12px;border:1px solid var(--dsw-alias-border-l4,#80808050);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#202126);color:inherit;font:13px/1.5 monospace}
                  .ctxkit-settings-card footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
                  .ctxkit-settings-card button{min-height:32px;border:1px solid var(--dsw-alias-border-l4,#80808050);border-radius:8px;padding:5px 12px;background:transparent;color:inherit;cursor:pointer}
                  .ctxkit-settings-card button:disabled{opacity:.45;cursor:default}
                  .ctxkit-settings-card button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#507de3);outline-offset:2px}
                  .ctxkit-settings-card .primary{background:var(--dsw-alias-brand-primary,#396bc8);color:white;border-color:transparent}
                  .ctxkit-settings-card [role=status]{margin-top:10px;overflow-wrap:anywhere}
                  .ctxkit-settings-card .ctxkit-settings-header{display:flex;align-items:center;justify-content:space-between;gap:12px;appearance:none;width:100%;padding:14px 16px;border:0;background:transparent;color:inherit;text-align:left;font:inherit;border-radius:12px}
                  .ctxkit-settings-title{display:block;color:var(--dsw-alias-label-primary,inherit);font-size:15px;font-weight:600;line-height:1.4}
                  .ctxkit-settings-description{display:block;margin-top:4px;color:var(--dsw-alias-label-secondary,inherit);font-size:14px}
                  .ctxkit-settings-header svg{flex:none;transition:transform .16s}
                  .ctxkit-settings-header[aria-expanded=true] svg{transform:rotate(180deg)}
                  .ctxkit-settings-body{padding:0 16px 16px}
                  .ctxkit-settings-group{border-top:1px solid var(--dsw-alias-border-l4,#80808050);margin-top:16px;padding-top:6px}
                  .ctxkit-settings-group>summary{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
                  .ctxkit-settings-help{font-size:13px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.5;margin:6px 0 12px;overflow-wrap:anywhere}
                  .ctxkit-setting{display:grid;gap:8px;margin:18px 0;min-width:0}.ctxkit-setting.toggle{grid-template-columns:minmax(0,1fr) auto;align-items:start}
                  .ctxkit-field-title{display:block;margin-bottom:3px}.ctxkit-setting small{display:block;line-height:1.45;overflow-wrap:anywhere}
                  .ctxkit-limit{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
                  .ctxkit-settings-body .ctxkit-prompt{min-height:220px;max-height:440px;white-space:pre-wrap}
                  @media(pointer:coarse){.ctxkit-settings-card button,.ctxkit-settings-card select,.ctxkit-settings-card input:not([type=checkbox]){min-height:44px}.ctxkit-settings-card textarea,.ctxkit-settings-card input{font-size:16px}}
                  @media(max-width:600px){
                    [role=dialog]:has(>nav):has(.ctxkit-settings-card){flex-direction:column}
                    [role=dialog]:has(.ctxkit-settings-card)>nav{width:auto;flex-direction:row;flex-wrap:wrap;gap:4px;padding:12px}
                    [role=dialog]:has(.ctxkit-settings-card)>nav>:not(button){flex-basis:100%}
                    [role=dialog]:has(.ctxkit-settings-card)>nav+div{min-height:0;min-width:0}
                  }
                `),
                h('button', { type: 'button', className: 'ctxkit-settings-header', 'aria-expanded': expanded,
                  'aria-label': (expanded ? 'Hide settings: ' : 'Show settings: ') + spec.title, onClick: () => setExpanded(!expanded) },
                  h('span', null, h('span', { className: 'ctxkit-settings-title' }, spec.title + (draft ? ' (unsaved)' : '')),
                    h('span', { className: 'ctxkit-settings-description' }, spec.description)),
                  h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true }, h('path', { d: 'm3 5 4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }))),
                h('div', { className: 'ctxkit-settings-body', hidden: !expanded },
                h('small', null, spec.key === 'dcp' && dcpInfo?.outdated ? 'Server update required once' : spec.timing),
                spec.key === 'dcp' && h('p', { className: 'ctxkit-settings-help' }, dcpInfo?.outdated
                  ? 'This server still has the older DCP module. Load the updated plugin or restart DSH once. Subsequent settings changes will not require a restart.'
                  : dcpInfo?.error ? 'Could not load DCP settings. Reopen this card to retry; your draft is kept.'
                  : 'Changes are used from the next assistant step. They do not rewrite a request already sent to the provider.'),
                ...spec.fields.map(([key, label]) => h('label', { key },
                  h('input', { type: 'checkbox', 'aria-label': label, checked: (manual && key === 'manualMode' ? manual.enabled
                    : manual && key === 'automaticStrategies' ? manual.automaticStrategies : value?.[key]) === true,
                    disabled: !writable || !value || typeof value !== 'object' || Array.isArray(value),
                    onChange: event => edit(JSON.stringify(manual && ['manualMode', 'automaticStrategies'].includes(key)
                      ? { ...value, manualMode: { ...manual, [key === 'manualMode' ? 'enabled' : key]: event.target.checked } }
                      : { ...value, [key]: event.target.checked }, null, 2)) }), h('span', null, label,
                      spec.key === 'dcp' && h('small', { style: { display: 'block' } }, key === 'enabled'
                        ? 'Controls DCP only. Context Mode, History Editor and native automatic compaction are separate.'
                        : key === 'manualMode' ? 'Stop automatic compression reminders; request a pass with /dcp compress.'
                        : 'Keep duplicate/error cleanup running while manual mode is on.')))),
                spec.key === 'dcp' && group('When to remind', 'These are soft thresholds, not a model context-window limit and not forced compression. Per-model overrides in Advanced take priority.', [
                  field('compress.minContextLimit', 'Reminder threshold', 'Below this, context reminders are quiet. The long-run reminder is a separate trigger.', 'threshold'),
                  field('compress.maxContextLimit', 'Context-limit threshold', 'At or above this, DCP uses the more urgent context-limit prompt.', 'threshold'),
                  field('compress.nudgeFrequency', 'Critical reminder every', 'Number of context checks between urgent reminders, normally one check per assistant step. Identical consecutive reminders are suppressed.', 'count'),
                  field('compress.iterationNudgeThreshold', 'Long-run reminder after', 'Assistant steps since the last user message. This trigger can fire even below the reminder threshold.', 'count'),
                  field('compress.summaryBuffer', 'Add summary allowance', 'Raise the upper threshold by the estimated size of active compressed summaries.')
                ], true),
                spec.key === 'dcp' && group('Cleanup and protection', 'Automatic cleanup does not call a model. Protection keeps selected content out of lossy summaries.', [
                  field('strategies.deduplication.enabled', 'Deduplicate tool results', 'Prune older repeated tool calls with the same arguments; retain the latest result.'),
                  field('strategies.purgeErrors.enabled', 'Clean up failed tool inputs', 'Prune stale inputs of failed tool calls after the configured number of turns.'),
                  field('strategies.purgeErrors.turns', 'Failed-input retention', 'User turns to retain failed inputs before cleanup.', 'count0'),
                  field('turnProtection.enabled', 'Protect recent turns', 'Keep recent turns out of automatic cleanup.'),
                  field('turnProtection.turns', 'Recent turns to keep', 'Number of recent user turns protected when the switch above is enabled.', 'count0'),
                  field('compress.protectUserMessages', 'Protect user messages', 'Carry your text verbatim into summaries. Large pasted prompts will keep using context.'),
                  field('experimental.allowSubAgents', 'Allow DCP in subagents', 'Give each subagent its own compress tool for managing only that delegated context. It cannot compress the parent conversation.'),
                  field('compress.protectTags', 'Keep protected sections', 'Carry text wrapped in <protect>...</protect> verbatim into summaries.'),
                  field('compress.mode', 'Compression mode', 'Range mode is recommended. Message mode compresses individual messages and is experimental.', 'select', [['range', 'Ranges'], ['message', 'Messages (experimental)']]),
                  field('pruneNotification', 'Cleanup notifications', 'How much detail to show about deterministic cleanup.', 'select', [['off', 'Off'], ['minimal', 'Short'], ['detailed', 'Detailed']]),
                  field('compress.showCompression', 'Show compression summaries', 'Include the compressed content in the chat notification.')
                ]),
                spec.key === 'dcp' && group('Prompts', 'Edit plain text, not JSON. Empty overrides use the bundled prompt, or an enabled legacy prompt file. Required tool format and block references remain automatic.', [
                  h('select', { key: 'choose', 'aria-label': 'DCP prompt', value: promptName, onChange: event => setPromptName(event.target.value) },
                    ...promptLabels.map(([key, label]) => h('option', { key, value: key }, label))),
                  h('p', { key: 'help', className: 'ctxkit-settings-help' }, promptLabels.find(([key]) => key === promptName)?.[2]),
                  h('textarea', { key: 'text', className: 'ctxkit-prompt', 'aria-label': 'DCP prompt text', spellCheck: false,
                    value: Object.hasOwn(promptDrafts, promptName) ? promptDrafts[promptName] : read('prompts.' + promptName) || dcpInfo?.defaults?.[promptName] || '', disabled: !writable || !validObject,
                    onChange: event => { setPromptDrafts({ ...promptDrafts, [promptName]: event.target.value }); change('prompts.' + promptName, event.target.value); } }),
                  h('button', { key: 'reset', type: 'button', disabled: !writable || !read('prompts.' + promptName),
                    onClick: () => { const next = { ...promptDrafts }; delete next[promptName]; setPromptDrafts(next); change('prompts.' + promptName, ''); } }, 'Use default prompt'),
                  h('p', { key: 'source', className: 'ctxkit-settings-help' }, read('prompts.' + promptName) ? 'Custom prompt. Save applies it with the other settings.' : 'Default prompt. Editing creates an override; resetting is also saved with the other settings.')
                ]),
                h('details', null, h('summary', null, 'Advanced configuration'),
                  h('textarea', { 'aria-label': spec.title + ' configuration JSON', value: text, spellCheck: false,
                    disabled: !writable, onChange: event => { setPromptDrafts({}); edit(event.target.value); } })),
                h('footer', null,
                  h('button', { type: 'button', className: 'primary', disabled: !writable || !draft, onClick: save }, busy ? 'Saving...' : 'Save'),
                  h('button', { type: 'button', disabled: busy || !draft, onClick: () => { setDraft(null); setPromptDrafts({}); setNotice(''); } }, 'Cancel')),
                h('div', { role: 'status', 'aria-live': 'polite' }, view.status !== 'ready' ? 'Plugin settings are not available in this profile.' : !view.writable ? 'Settings are read-only.' : notice)));
            }
            cards.push([spec, SettingsCard]);
          }
          settingsCtx.slots.inject('settings.plugins.tab', () => settingsCtx.slots.register({
            name: 'settings.plugins.tab', id: 'context-kit', order: 20, label: 'Context Kit'
          }, function ContextKitSettings() {
            return h('section', { style: { maxWidth: 760 } },
              h('h2', null, 'Context Kit'),
              h('p', { className: 'ctxkit-settings-help' }, 'DCP, bounded-output tools and history editing.'),
              h('ul', { style: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0 } },
                ...cards.map(([spec, Card]) => h(Card, { key: spec.key }))));
          }));
        });
        if (typeof ctx.inject === 'function') ctx.inject(['slots'], viewCtx => {
          const React = require('react'), h = React.createElement;
          function ContextReadout({ useProjection, sessionId }) {
            const pressure = useProjection('contextPressure');
            const breakdown = useProjection('contextBreakdown');
            const [openedFor, setOpenedFor] = React.useState(null);
            const [position, setPosition] = React.useState({ left: 8, bottom: 8 });
            const root = React.useRef(null);
            const open = openedFor !== null && openedFor === sessionId;
            const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
            const used = count(pressure?.projectedTokens) ?? count(pressure?.pressureTokens);
            const limit = count(pressure?.contextWindow) || undefined;
            const compact = value => value === undefined ? 'unknown' : value >= 1000000
              ? Math.round(value / 100000) / 10 + 'M' : value >= 1000 ? Math.round(value / 100) / 10 + 'K' : String(Math.round(value));
            const percent = used !== undefined && limit !== undefined ? Math.round(used / limit * 100) : undefined;
            React.useEffect(() => { setOpenedFor(null); }, [sessionId]);
            React.useEffect(() => {
              if (!open) return;
              const outside = event => { if (!root.current?.contains(event.target)) setOpenedFor(null); };
              const escape = event => { if (event.key === 'Escape') { setOpenedFor(null); root.current?.querySelector('button')?.focus({ preventScroll: true }); } };
              // Streaming scrolls the conversation; keep the details anchored, not dismissed.
              const moved = () => {
                const rect = root.current?.querySelector('button')?.getBoundingClientRect();
                if (!rect) return;
                const left = Math.max(8, Math.min(rect.left, window.innerWidth - 288));
                const bottom = Math.max(8, window.innerHeight - rect.top + 8);
                setPosition(previous => previous.left === left && previous.bottom === bottom ? previous : { left, bottom });
              };
              document.addEventListener('pointerdown', outside);
              document.addEventListener('keydown', escape);
              window.addEventListener('resize', moved);
              document.addEventListener('scroll', moved, true);
              return () => {
                document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
                window.removeEventListener('resize', moved); document.removeEventListener('scroll', moved, true);
              };
            }, [open]);
            return h('span', { ref: root, className: 'ctxkit-context' },
              h('style', null, `
                .ctxkit-context{display:inline-flex;flex:none;align-items:center;color:var(--dsw-alias-label-secondary,inherit)}
                .ctxkit-context>button{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l3,#80808050);border-radius:8px;background:transparent;color:inherit;padding:4px 7px;min-height:28px;font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;font-variant-numeric:tabular-nums}
                .ctxkit-context>button:hover{background:var(--dsw-alias-interactive-bg-hover,#80808020)}
                .ctxkit-context button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#507de3);outline-offset:2px}
                .ctxkit-context-panel{position:fixed;z-index:110;box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 24px);overflow:auto;padding:14px;border:1px solid var(--studio-line,var(--dsw-alias-border-l1,#80808050));border-radius:10px;background:var(--studio-panel,var(--dsw-specific-menu,#252936));box-shadow:0 8px 30px #0004;color:var(--studio-ink,var(--dsw-alias-label-primary,inherit));font-size:12px;line-height:1.6;font-family:inherit}
                .ctxkit-context-panel header{font-weight:600;font-size:14px}.ctxkit-context-panel dl{margin:8px 0}.ctxkit-context-panel dl>div{display:flex;justify-content:space-between;gap:12px}.ctxkit-context-panel dd{margin:0;font-variant-numeric:tabular-nums}.ctxkit-context-panel p{margin:8px 0 0;color:var(--dsw-alias-label-secondary,inherit)}
                .ctxkit-context-panel meter{display:block;width:100%;height:8px;margin:8px 0}
                .uV2eYG_trailing:has(.ctxkit-context){flex-wrap:wrap}
                .uV2eYG_trailing:has(.ctxkit-context)>.JObwrW_root{display:none}
                @media(max-width:600px){.ctxkit-context-label{display:none}}
                @media(pointer:coarse){.ctxkit-context>button{min-height:44px}}
              `),
              h('button', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': open,
                'aria-label': used === undefined ? 'Context tokens: waiting for usage data' : 'Context tokens: approximately ' + Math.round(used) + (limit ? ' of ' + limit : ', limit unknown'),
                title: 'Context tokens. Click for details.', onClick: event => {
                  const rect = event?.currentTarget?.getBoundingClientRect();
                  if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), bottom: Math.max(8, window.innerHeight - rect.top + 8) });
                  setOpenedFor(open ? null : sessionId);
                } }, h('span', { className: 'ctxkit-context-label' }, 'Context'), used === undefined ? 'waiting' : compact(used) + ' tok'),
              open && h('section', { role: 'dialog', 'aria-label': 'Context tokens', className: 'ctxkit-context-panel', style: position },
                h('header', null, 'Context tokens'),
                h('dl', null, ...[['Estimated used', used], ['Context limit', limit], ['Remaining', used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined]]
                  .map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value === undefined ? 'Not reported' : Math.round(value).toLocaleString('en-US'))))),
                percent !== undefined && h('div', null, percent + '% used', h('meter', { min: 0, max: 100, value: Math.min(100, percent), 'aria-label': 'Context used' })),
                used === undefined && h('p', null, 'Waiting for usage data from this conversation. It usually arrives after the first model response.'),
                limit === undefined && h('p', null, 'The model has not reported a context limit yet.'),
                breakdown && h('div', null, h('p', null, 'Approximate composition'), h('dl', null,
                  ...[['System prompt', 'systemTokens'], ['Tools', 'toolsTokens'], ['Messages', 'messageTokens']].map(([label, key]) => h('div', { key }, h('dt', null, label), h('dd', null, compact(count(breakdown[key]))))))),
                h('p', null, 'Uses the current conversation token estimate, not cumulative billing usage.')));
          }
          viewCtx.slots.inject('conversation.input.right', () => viewCtx.slots.register({
            name: 'conversation.input.right', id: 'context-kit-token-meter', inject: sessionId => ({ sessionId })
          }, ContextReadout));
        });
        ctx.effect(() => {
          const list = ctx.sessions.list;
          let current;
          let initialized = false;
          const read = () => current;
          const notify = () => window.dispatchEvent(new Event('dsh-context-kit:session'));
          const update = () => {
            const selected = list.getSnapshot()?.current;
            const sessionId = typeof selected === 'string' ? selected : selected?.sessionId;
            const next = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
            if (initialized && current === next) return;
            initialized = true;
            current = next;
            notify();
          };
          // Subscribe before the initial read: no selection can fall between the two.
          window.__DSH_CONTEXT_KIT_SESSION__ = read;
          const unsubscribe = list.subscribe(update);
          update();
          return () => {
            unsubscribe();
            if (window.__DSH_CONTEXT_KIT_SESSION__ !== read) return;
            delete window.__DSH_CONTEXT_KIT_SESSION__;
            notify();
          };
        });
        // Older running hosts retain the panel script captured at import time.
        // Reuse their verified anchors and controls; never replace an active editor.
        if (typeof document !== 'undefined') ctx.effect(() => {
          let active = true;
          let queued = false;
          const copies = new Map();
          const codeCopies = new Map();
          const codeStyle = document.createElement('style');
          // Preserve loader identities, native title nodes and detail actions.
          const pluginNames = new Map();
          const nameStyle = document.createElement('style');
          nameStyle.textContent = '[data-ctxkit-plugin-name]{font-size:0!important}[data-ctxkit-plugin-name]::before{content:attr(data-ctxkit-plugin-name);font-size:var(--ctxkit-plugin-font,13px)}';
          const place = () => {
            queued = false;
            if (!active) return;
            for (const [row, record] of pluginNames) if (!row.isConnected || row.dataset.pluginModule !== record.module || row.dataset.pluginEntry !== record.id || !row.contains(record.title)) {
              record.restore(); pluginNames.delete(row);
            }
            for (const [id, file, label] of [['context-kit-dcp', 'dcp-plugin', 'DCP'], ['context-kit-context-mode', 'context-mode-plugin', 'Context Mode'], ['context-kit-history-editor', 'editor-plugin', 'History Editor'], ['context-kit-bundle', 'runtime-4/host-entry', 'Context Kit']]) {
              for (const row of document.querySelectorAll('[data-plugin-entry="include:' + id + '"]')) {
                const entryId = row.dataset.pluginEntry;
                const module = row.dataset.pluginModule ?? '';
                const normalized = module.replace(/\\/g, '/');
                const matches = file === 'runtime-4/host-entry'
                  ? normalized.endsWith('/runtime-4/host-entry.js') || normalized.endsWith('/dsh-context-kit-runtime-4/host-entry.js')
                  : normalized.endsWith('/dsh-context-kit/lib/' + file + '.js');
                if (!matches) continue;
                const button = row.querySelector(':scope > button');
                const title = button?.querySelector('strong[title]');
                if (!title || title.title !== module) continue;
                if (!pluginNames.has(row)) {
                  const font = title.style.getPropertyValue('--ctxkit-plugin-font');
                  const record = { id: entryId, module, title, originalAria: button.getAttribute('aria-label'), lastAria: null, restore: () => {
                    title.removeAttribute('data-ctxkit-plugin-name');
                    if (font) title.style.setProperty('--ctxkit-plugin-font', font); else title.style.removeProperty('--ctxkit-plugin-font');
                    if (button.getAttribute('aria-label') === record.lastAria) {
                      if (record.originalAria === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', record.originalAria);
                    }
                  } };
                  title.style.setProperty('--ctxkit-plugin-font', getComputedStyle(title).fontSize);
                  title.setAttribute('data-ctxkit-plugin-name', label);
                  pluginNames.set(row, record);
                }
                const record = pluginNames.get(row), aria = button.getAttribute('aria-label');
                if (aria !== record.lastAria) {
                  record.originalAria = aria;
                  const at = aria?.indexOf(', ' + entryId + ', ');
                  if (at >= 0) { record.lastAria = label + aria.slice(at); button.setAttribute('aria-label', record.lastAria); }
                }
              }
            }
            if (pluginNames.size && !nameStyle.isConnected) document.head.append(nameStyle);
            for (const pin of document.querySelectorAll('[data-ctxkit-pencil]')) {
              const label = pin.shadowRoot?.querySelector('button')?.textContent.trim();
              if (!['Message', 'Answer', 'Thinking'].includes(label)) continue;
              const anchor = pin.anchor;
              const row = pin.closest('[data-chat-flow-key]');
              if (!row || !anchor?.isConnected || anchor === row || anchor.contains(row)
                || anchor.closest('[data-chat-flow-key]') !== row
                || row.closest('[data-trajectory-scroll]')) continue;
              pin.cleanup?.();
              pin.cleanup = null;
              if (!pin.shadowRoot.querySelector('[data-bottom-actions]')) {
                const style = document.createElement('style');
                style.setAttribute('data-bottom-actions', '');
                style.textContent = ':host { position: relative !important; inset: auto !important; margin: 6px 0 0 !important; align-self: flex-start; opacity: 1 !important; }';
                pin.shadowRoot.append(style);
              }
              if (anchor.nextElementSibling !== pin) anchor.after(pin);
            }
            for (const [host, observer] of copies) if (!host.isConnected) {
              observer.disconnect(); copies.delete(host);
            }
            const native = document.querySelector('button.xzv4MW_action[aria-label="Copy"] svg');
            const artwork = native ? native.cloneNode(true) : document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            artwork.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            artwork.setAttribute('viewBox', '0 0 16 16');
            artwork.setAttribute('aria-hidden', 'true'); artwork.setAttribute('focusable', 'false');
            if (!native) artwork.innerHTML = '<path d="M5 5h8v8H5zM3 10H2V2h8v1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
            // Native code buttons are React-owned: hide the label with CSS, not DOM edits.
            for (const [button, record] of codeCopies) if (!button.isConnected) {
              record.restore(); codeCopies.delete(button);
            }
            for (const button of document.querySelectorAll('.md-code-block [data-code-block-banner] button')) {
              if (!button.matches('[class*="_copyButton_"], [class$="_copyButton"]') || button.childElementCount
                || button.closest('[data-trajectory-scroll]') || !button.closest('[data-chat-flow-key]')) continue;
              const message = button.textContent.trim();
              if (!codeCopies.has(button)) {
                const title = button.getAttribute('title');
                const record = { last: message, restore: () => {
                  if (button.title === record.last) {
                    if (title === null) button.removeAttribute('title'); else button.title = title;
                  }
                  button.removeAttribute('data-ctxkit-code-copy');
                } };
                codeCopies.set(button, record);
              }
              codeCopies.get(button).last = message;
              button.title = message;
              button.setAttribute('data-ctxkit-code-copy', message);
            }
            if (codeCopies.size && !codeStyle.isConnected) {
              const mask = 'url("data:image/svg+xml,' + encodeURIComponent(artwork.outerHTML) + '")';
              codeStyle.textContent = 'button[data-ctxkit-code-copy]{font-size:0!important;line-height:0!important;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;box-sizing:border-box;border:0;border-radius:28px;background:transparent;cursor:pointer}'
                + 'button[data-ctxkit-code-copy]::before{content:"";width:16px;height:16px;background:currentColor;mask:' + mask + ' center/contain no-repeat}'
                + 'button[data-ctxkit-code-copy]:hover{background:var(--dsw-alias-interactive-bg-hover,#7e879a20)}'
                + 'button[data-ctxkit-code-copy="Copied"]::before{mask:none;clip-path:polygon(12% 49%,39% 75%,91% 19%,98% 26%,39% 89%,5% 56%);color:var(--dsw-alias-success,#438361)}'
                + '@media(pointer:coarse){button[data-ctxkit-code-copy]{width:44px;height:44px}}';
              document.head.append(codeStyle);
            }
            // Keep the panel's copy handler and feedback, including on cached hosts.
            for (const host of document.querySelectorAll('[data-ctxkit-projection]')) {
              const shadow = host.shadowRoot;
              if (!shadow || copies.has(host) || host.closest('[data-trajectory-scroll]')) continue;
              if (!shadow.querySelector('[data-copy-icons]')) {
                const style = document.createElement('style');
                style.setAttribute('data-copy-icons', '');
                style.textContent = '.ctxkit-copy{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;width:28px;height:28px;padding:6px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#89909c)}'
                  + '.ctxkit-copy:hover{background:var(--dsw-alias-interactive-bg-hover,#7e879a20);color:var(--dsw-alias-label-secondary,#aeb7c5)}'
                  + '.ctxkit-copy svg{width:16px;height:16px;flex-shrink:0}.ctxkit-copy[data-copy-state="copied"]{color:var(--dsw-alias-success,#438361)}.ctxkit-copy[data-copy-state="error"]{color:var(--dsw-alias-danger,#ce5b5b)}'
                  + '.copy-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'
                  + '@media(pointer:coarse){.ctxkit-copy{width:44px;height:44px}}';
                shadow.append(style);
              }
              const update = () => {
                for (const button of shadow.querySelectorAll('button[aria-label^="Copy effective "]')) {
                  if (button.querySelector('.copy-label')) continue;
                  const message = button.textContent.trim();
                  const state = message === 'Copied' ? 'copied' : message.startsWith('Copy failed') ? 'error' : 'ready';
                  button.classList.add('ctxkit-copy'); button.dataset.copyState = state;
                  button.title = state === 'ready' ? button.getAttribute('aria-label') : message;
                  const icon = artwork.cloneNode(true);
                  if (state !== 'ready') icon.innerHTML = state === 'copied'
                    ? '<path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
                    : '<path d="M8 3v6m0 3v1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
                  const label = document.createElement('span');
                  label.className = 'copy-label'; label.textContent = message;
                  button.replaceChildren(icon, label);
                }
              };
              const observer = new MutationObserver(update);
              observer.observe(shadow, { childList: true, subtree: true, characterData: true });
              copies.set(host, observer); update();
            }
          };
          const observer = new MutationObserver(() => {
            if (!queued) { queued = true; queueMicrotask(place); }
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['data-ctxkit-for', 'data-editing', 'data-plugin-entry', 'data-plugin-module', 'aria-label'] });
          place();
          return () => {
            active = false; observer.disconnect();
            for (const copy of copies.values()) copy.disconnect();
            copies.clear();
            for (const record of codeCopies.values()) record.restore();
            codeCopies.clear(); codeStyle.remove();
            for (const record of pluginNames.values()) record.restore();
            pluginNames.clear(); nameStyle.remove();
          };
        });
      }
    };
  }
});
