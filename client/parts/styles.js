/**
 * Stylesheet shared by the settings card and the Memories settings page.
 *
 * Every value is a shell design token (`--dsw-alias-*`), so the surface follows
 * the active theme and light/dark switch without the plugin owning any palette.
 * The tag is injected once per document and identified by
 * `data-plugin-css`, which is what the HMR driver uses to retire a bundle's
 * owned styles.
 */

/** The stylesheet text. */
const CSS = [
  '.dshm-page{display:flex;flex-direction:column;gap:14px;max-width:760px}',
  '.dshm-card{display:flex;flex-direction:column;gap:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;padding:14px 16px;background:var(--dsw-alias-bg-module-platform);max-width:720px}',
  '.dshm-head{display:flex;align-items:baseline;gap:8px}',
  '.dshm-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;margin:0}',
  '.dshm-ns{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code)}',
  '.dshm-intro{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
  '.dshm-row{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
  '.dshm-row:first-of-type{border-top:none}',
  '.dshm-label{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
  '.dshm-label>span:first-child{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dshm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dshm-control{flex:none;display:flex;align-items:center;gap:8px}',
  '.dshm-input{box-sizing:border-box;width:150px;height:30px;font:inherit;font-size:13px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
  '.dshm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dshm-input:disabled{opacity:.6}',
  '.dshm-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}',
  '.dshm-reset{height:26px;padding:0 8px;font:inherit;font-size:12px;border-radius:13px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.dshm-reset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dshm-status{font-size:12px;line-height:18px;margin:0}',
  '.dshm-error{color:var(--dsw-alias-state-error-primary)}',
  '.dshm-ok{color:var(--dsw-alias-state-success-primary)}',
  '.dshm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
  '.dshm-path{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
  '.dshm-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  '.dshm-grow{flex:1;min-width:180px;width:auto}',
  '.dshm-select{height:30px;font:inherit;font-size:13px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
  '.dshm-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
  '.dshm-entry{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
  '.dshm-entry-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
  '.dshm-entry-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;margin:0;flex:1;min-width:120px}',
  '.dshm-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dshm-badge-global{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
  '.dshm-body{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;margin:0}',
  '.dshm-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;flex-wrap:wrap;gap:8px}',
  '.dshm-actions{display:flex;gap:6px;flex-wrap:wrap}',
  '.dshm-btn{height:26px;padding:0 10px;font:inherit;font-size:12px;border-radius:13px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dshm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dshm-btn:disabled{opacity:.5;cursor:default}',
  '.dshm-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
  '.dshm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
  '.dshm-form{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.dshm-form-row{display:flex;gap:8px;flex-wrap:wrap}',
  '.dshm-area{box-sizing:border-box;width:100%;min-height:64px;font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);resize:vertical}',
  '.dshm-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dshm-section-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;margin:0}',
  '.dshm-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:4px}',
  '.dshm-tab{height:28px;padding:0 12px;font:inherit;font-size:13px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.dshm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dshm-tab-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500}',
  // A tab that is waiting for a decision has to look like it: the point of the
  // disputed subset is that somebody notices it among everything else.
  '.dshm-tab-alert{color:var(--dsw-alias-label-primary);box-shadow:inset 0 -2px 0 0 var(--dsw-alias-brand-primary,#d97706)}',
  '.dshm-panel{display:flex;flex-direction:column;gap:12px}',
].join('\n')

/** Inject the stylesheet once per document. */
function ensureStyles() {
  if (typeof document === 'undefined') return
  const id = 'dsh-memories/settings.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-memories'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}
