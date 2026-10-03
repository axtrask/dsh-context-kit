export const workspaceCss = `
.studio-launch-run { --studio-accent:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,#aac48b);--studio-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--studio-ink:var(--dsw-alias-label-primary) }
.studio-launch-run { display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:1px solid var(--studio-line);border-radius:7px;background:color-mix(in srgb,var(--studio-accent) 8%,transparent);color:var(--studio-ink);font:inherit;font-size:12px;cursor:pointer }
.studio-workspace { --studio-accent:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,#aac48b);--studio-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--studio-soft-line:var(--dsw-alias-border-l1);--studio-panel:var(--dsw-alias-bg-layer-1);--studio-muted:var(--dsw-alias-label-secondary);--studio-ink:var(--dsw-alias-label-primary);display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--studio-ink);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5 }
.studio-workspace *, .studio-workspace *::before, .studio-workspace *::after { box-sizing:border-box }
.studio-workspace [hidden] { display:none!important }
.studio-workspace button,.studio-workspace input,.studio-workspace select { font:inherit;color:inherit }
.studio-workspace button { cursor:pointer;border:1px solid var(--studio-line);border-radius:6px;background:transparent;padding:4px 8px }
.studio-workspace :is(button,input,select,summary,[tabindex]):focus-visible,.studio-launch-run:focus-visible { outline:2px solid var(--studio-accent);outline-offset:2px }
.studio-workspace button:disabled,.studio-launch-run:disabled { opacity:.45;cursor:not-allowed }
.studio-workspace button:hover:not(:disabled) { background:color-mix(in srgb,var(--studio-accent) 8%,transparent) }
.studio-workspace-tabs { display:flex;gap:14px;flex:none;min-height:36px;padding:0 14px;border-bottom:1px solid var(--studio-line) }
.studio-workspace-tabs button { border:0;border-radius:0;padding:8px 2px;font-size:12px;color:var(--studio-muted);position:relative }
.studio-workspace-tabs button[aria-selected=true] { color:var(--studio-accent) }
.studio-workspace-tabs button[aria-selected=true]::after { content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--studio-accent) }
.studio-run-page { flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:10px 12px 8px;gap:10px }
.studio-run-summary { display:flex;flex-wrap:wrap;align-items:center;gap:5px 16px;flex:none;min-height:26px;font-size:11px }
.studio-run-status { display:inline-flex;align-items:center;gap:7px;font-weight:600;text-transform:capitalize;font-size:13px }
.studio-run-status i,.studio-step-dot { width:6px;height:6px;border-radius:50%;background:var(--studio-accent);display:inline-block;flex:none }
.studio-run-status[data-state=running] i,.studio-run-row[data-state=running] .studio-step-dot { animation:studio-pulse 1.4s ease-in-out infinite }
.studio-run-clock { color:var(--studio-muted);white-space:nowrap }
.studio-run-clock :is(time,span) { color:var(--studio-ink);font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;margin-left:4px }
.studio-run-summary .studio-stop { margin-left:auto;font-size:11px;padding:3px 9px }
.studio-run-toolbar { display:flex;gap:8px;align-items:center;flex:none }
.studio-run-toolbar :is(select,input) { min-width:0;background:var(--dsw-alias-bg-base);border:1px solid var(--studio-line);border-radius:6px;padding:5px 7px;font-size:11px;height:30px }
.studio-run-toolbar select { max-width:145px }
.studio-run-toolbar input { flex:1;width:50px }
.studio-run-grid { display:flex;flex-direction:column;gap:10px;min-height:0;flex:1 }
.studio-run-timeline { flex:0 1 43%;min-height:90px;overflow:auto;scrollbar-width:thin;overscroll-behavior:contain }
.studio-run-timeline ol { padding:0;margin:0;list-style:none }
.studio-run-row { margin:2px 0;padding-left:calc(var(--studio-depth,0) * 12px) }
.studio-run-row>button { width:100%;min-width:0;display:flex;align-items:center;gap:10px;text-align:left;padding:9px;border-color:transparent;border-radius:8px }
.studio-run-row>button[aria-pressed=true] { background:color-mix(in srgb,var(--studio-accent) 9%,transparent);border-color:var(--studio-line) }
.studio-run-row[data-state=error] .studio-step-dot { background:var(--dsw-alias-state-error-primary) }
.studio-run-row[data-state=unsettled] .studio-step-dot,.studio-run-row[data-state=stopped] .studio-step-dot { background:var(--studio-muted) }
.studio-step-main { display:block;min-width:0;flex:1 }
.studio-step-title { display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:500 }
.studio-step-meta { display:flex;flex-wrap:wrap;gap:3px 10px;color:var(--studio-muted);font:10px/1.5 var(--ds-font-family-code);margin-top:3px }
.studio-step-state { margin-left:auto }
.studio-run-monitor { display:grid;grid-template-rows:auto minmax(70px,1fr);flex:1;min-height:160px;min-width:0;border:1px solid var(--studio-line);border-radius:10px;overflow:hidden;background:var(--studio-panel) }
.studio-run-monitor[data-split-output] { grid-template-rows:auto minmax(70px,1.1fr) auto minmax(65px,.9fr) }
.studio-monitor-heading,.studio-answer-heading { display:flex;align-items:center;gap:12px;min-width:0;padding:9px 12px;border-bottom:1px solid var(--studio-line);font-size:11px }
.studio-monitor-heading strong { flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500 }
.studio-monitor-heading>span { font:10px var(--ds-font-family-code);color:var(--studio-accent) }
.studio-monitor-heading>span[data-state=error] { color:var(--dsw-alias-state-error-primary) }
.studio-answer-heading { border-top:1px solid var(--studio-line);text-transform:uppercase;font-size:10px;letter-spacing:.08em;color:var(--studio-muted) }
.studio-answer-heading span { margin-left:auto;text-transform:none;letter-spacing:0 }
.studio-output-scroll,.studio-answer-scroll { overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;min-height:0;padding:12px }
.studio-output-scroll { font-family:var(--dsw-font-family);font-size:13px }
.studio-answer-scroll { font-size:14px;line-height:1.7 }
.studio-text { white-space:pre-wrap;overflow-wrap:anywhere }
.studio-prose { white-space:normal;font:var(--dsh-content-font-size,13px)/1.7 var(--dsw-font-family);min-width:0 }
.studio-prose :is(p,li) { font:inherit }
.studio-prose :is(pre,code) { font-family:var(--ds-font-family-code) }
.studio-prose pre { max-width:100%;overflow:auto }
.studio-prose :is(h1,h2,h3) { font-size:calc(var(--dsh-content-font-size,13px) + 2px);line-height:1.4;margin-block:1em .5em }
.studio-prose > div > :first-child { margin-top:0 }
.studio-prose > div > :last-child { margin-bottom:0 }
.studio-selected-meta { display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--studio-soft-line);font:11px/1.5 var(--dsw-font-family) }
.studio-selected-meta dt { color:var(--studio-muted) }
.studio-selected-meta dd { margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums }
.studio-text[data-streaming=true]::after { content:'';display:inline-block;width:5px;height:1em;background:var(--studio-accent);vertical-align:-.15em;margin-left:3px;animation:studio-pulse 1s ease-in-out infinite }
.studio-stream-tail { animation:studio-ink 200ms ease-out both }
.studio-text-more { display:block;margin-bottom:8px;font-size:11px!important }
.studio-step-input { margin-bottom:10px;color:var(--studio-muted) }
.studio-step-input summary { cursor:pointer;font-size:11px;padding:3px 0 }
.studio-step-input pre { margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.65 var(--ds-font-family-code) }
.studio-workspace-note { font-size:10px;line-height:1.5;color:var(--studio-muted);margin:0;flex:none;overflow-wrap:anywhere }
.studio-workspace-empty { color:var(--studio-muted);font:12px/1.7 var(--dsw-font-family);padding:10px 3px;white-space:normal }
.studio-workspace-error { padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);border-bottom:1px solid var(--studio-line);flex:none }
.studio-changes-page,.studio-context-page { overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;min-height:0;flex:1;padding:16px }
.studio-change { border:1px solid var(--studio-line);border-radius:8px;margin-top:12px;overflow:hidden }
.studio-change summary { cursor:pointer;padding:10px 12px;display:flex;align-items:center;gap:10px;font-family:var(--ds-font-family-code);font-size:12px;overflow-wrap:anywhere }
.studio-change summary span { flex:1;min-width:0;overflow-wrap:anywhere }
.studio-change summary small { color:var(--studio-accent);flex:none;font-size:10px }
.studio-change[open] summary { border-bottom:1px solid var(--studio-line) }
.studio-change-actions { display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:8px 12px;font-size:11px;color:var(--studio-muted) }
.studio-change-preview { min-width:0;max-width:100% }
.studio-change-preview .studio-change-actions button { min-height:32px }
@media(pointer:coarse) { .studio-change-preview .studio-change-actions button { min-height:44px;min-width:44px } }
.studio-change-before,.studio-change-after { padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--ds-font-family-code) }
.studio-change-before { background:color-mix(in srgb,#c17c72 7%,transparent) }
.studio-change-after { background:color-mix(in srgb,var(--studio-accent) 8%,transparent) }
.studio-change :is(small) { display:block;margin-bottom:5px;color:var(--studio-muted) }
.studio-patch { overflow:auto;margin:0;padding:12px;font:12px/1.7 var(--ds-font-family-code);max-height:50vh }
.studio-context-primary { display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:10px 0 16px }
.studio-context-primary>span,.studio-context-primary>small { color:var(--studio-muted);font-size:12px }
.studio-context-primary strong { font:500 40px/1.4 var(--ds-font-family-code);letter-spacing:-.04em }
.studio-context-meter { height:5px;background:var(--studio-line);border-radius:5px;overflow:hidden;margin-bottom:24px }
.studio-context-meter span { display:block;height:100%;background:var(--studio-accent) }
.studio-context-meter [data-overflow] { background:var(--dsw-alias-state-error-primary) }
.studio-context-values { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 20px;font-size:12px;margin:0 0 24px }
.studio-context-values dt { color:var(--studio-muted);text-transform:capitalize }
.studio-context-values dd { margin:0;font-family:var(--ds-font-family-code) }
.studio-context-page h3 { font-size:12px;font-weight:500;margin:24px 0 14px }
.studio-workspace[data-fullscreen] .studio-run-page { padding:10px 20px 8px }
.studio-workspace[data-fullscreen] .studio-workspace-tabs { padding-inline:20px }
@media (min-width:760px) {
  .studio-workspace[data-fullscreen] .studio-run-grid { display:grid;grid-template-columns:minmax(240px,.85fr) minmax(0,1.3fr);gap:22px }
  .studio-workspace[data-fullscreen] .studio-run-timeline { min-height:0 }
  .studio-workspace[data-fullscreen] .studio-run-monitor { min-height:0 }
  .studio-workspace[data-fullscreen] .studio-run-toolbar input { max-width:400px }
  .studio-workspace[data-fullscreen] :is(.studio-changes-page,.studio-context-page) { padding:24px max(24px,calc((100% - 1000px)/2)) }
}
@media (max-width:600px) {
  .studio-workspace[data-fullscreen] .studio-run-page { padding:8px 10px }
  .studio-workspace[data-fullscreen] .studio-workspace-tabs { padding-inline:10px }
  .studio-run-summary { gap:4px 10px }
  .studio-run-toolbar input { font-size:16px }
  .studio-run-clock { font-size:10px }
}
@media (max-height:480px) {
  .studio-run-page { overflow:auto }
  .studio-run-grid { flex:none;min-height:300px }
}
@keyframes studio-ink { from { opacity:.25 } to { opacity:1 } }
@media (prefers-reduced-motion:reduce) {
  .studio-workspace .studio-stream-tail,.studio-workspace .studio-text::after,.studio-workspace .studio-run-status i,.studio-workspace .studio-step-dot { animation:none!important }
}
`
