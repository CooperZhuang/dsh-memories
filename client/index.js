/**
 * `dsh-memories` browser half.
 *
 * Shipped as the package's `./client` bundle: the DSH client module system
 * loads it as a `window.__ModuleLoader__.load({ id, factory })` script, calls
 * `factory(require)`, and mounts the exported plugin (`apply` + `inject`) into
 * the browser Cordis tree.
 *
 * It contributes one card to the Settings shell's Plugins tab, keyed by the
 * `memories` settings namespace. The card binds that namespace through
 * `ctx.settingsScope` — the settings domain's own browser transport — so reads
 * and writes ride the shared describe mirror and revision-fenced write path
 * every shipped settings page uses, with no bespoke HTTP route.
 *
 * Written as plain CJS with `createElement` instead of JSX so the package needs
 * no bundler: the bundle only requires modules the browser already provides
 * (`react`, `@deepseek-ai/dsh-client-ui-slots`) plus the settings domain
 * package, which is a graph row.
 */

/** Settings namespace this card edits; must match the host registration. */
const NS = 'memories'

/**
 * Field descriptors, in render order. `kind` picks the control; `min`/`step`
 * bound the numeric inputs.
 */
const FIELDS = [
  { field: 'maxSummaryBytes', label: 'Summary byte budget', hint: 'Bytes of memory summary injected per turn. 0 disables injection.', kind: 'number', min: 0, step: 256 },
  { field: 'maxSummaryEntries', label: 'Summary entries per scope', hint: 'How many memories each scope lists in the summary.', kind: 'number', min: 1, step: 1 },
  { field: 'maxEntriesPerScope', label: 'Stored memories per scope', hint: 'Past this cap the least recently used memories are deleted.', kind: 'number', min: 1, step: 1 },
  { field: 'autoExtract', label: 'Background extraction', hint: 'Mine finished sessions for durable facts once they have been idle.', kind: 'boolean' },
  { field: 'autoExtractIdleMs', label: 'Idle before extraction (ms)', hint: 'How long a session must stay idle before it is mined.', kind: 'number', min: 1000, step: 1000 },
  { field: 'extractWindowMessages', label: 'Extraction window (messages)', hint: 'How many recent conversation messages one extraction reads.', kind: 'number', min: 1, step: 1 },
  { field: 'extractMaxInputChars', label: 'Extraction input budget (chars)', hint: 'Character budget for the transcript handed to the extractor.', kind: 'number', min: 1, step: 1000 },
  { field: 'extractMaxOutputTokens', label: 'Extraction output tokens', hint: 'Output token cap for one extraction call.', kind: 'number', min: 1, step: 128 },
  { field: 'extractTimeoutMs', label: 'Extraction timeout (ms)', hint: 'Timeout for one extraction call.', kind: 'number', min: 1000, step: 5000 },
  { field: 'extractMaxMemories', label: 'Memories per extraction', hint: 'Maximum memories one extraction pass may store.', kind: 'number', min: 1, step: 1 },
  { field: 'extractProvider', label: 'Extraction provider', hint: "Provider route for extraction. Empty reuses the session's own logged route.", kind: 'text' },
  { field: 'extractModel', label: 'Extraction model', hint: "Model for extraction. Empty reuses the session's own logged route.", kind: 'text' },
  { field: 'enableTool', label: 'Memory tool', hint: 'Register the model-facing memory tool. Takes effect immediately.', kind: 'boolean' },
  { field: 'enableCommand', label: 'Slash command', hint: 'Register the /memories command. Takes effect immediately.', kind: 'boolean' },
]

/** Styles built once, using the shell's design tokens so the card matches. */
const CSS = [
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
].join('\n')

/** Inject the card's stylesheet once per document. */
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

/** Whether the user layer carries an override for one field. */
function isOverridden(snapshot, field) {
  const user = snapshot.user
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field)
}

/** Render one row: label + hint on the left, control on the right. */
function renderRow(React, field, snapshot, draft, onEdit) {
  const current = draft !== undefined ? draft : snapshot.value === undefined ? undefined : snapshot.value[field.field]
  const disabled = snapshot.writable !== true || snapshot.status !== 'ready'
  const controls = []
  if (field.kind === 'boolean') {
    controls.push(React.createElement('input', {
      key: 'input',
      className: 'dshm-check',
      type: 'checkbox',
      checked: current === true,
      disabled,
      onChange: (event) => onEdit(field.field, event.target.checked),
    }))
  } else {
    controls.push(React.createElement('input', {
      key: 'input',
      className: 'dshm-input',
      type: field.kind === 'number' ? 'number' : 'text',
      value: current === undefined || current === null ? '' : String(current),
      min: field.min,
      step: field.step,
      disabled,
      onChange: (event) => onEdit(field.field, event.target.value),
    }))
  }
  if (!disabled && isOverridden(snapshot, field.field)) {
    controls.push(React.createElement('button', {
      key: 'reset',
      className: 'dshm-reset',
      type: 'button',
      title: 'Reset to the default',
      onClick: () => onEdit(field.field, undefined),
    }, 'Reset'))
  }
  return React.createElement('div', { key: field.field, className: 'dshm-row' }, [
    React.createElement('div', { key: 'label', className: 'dshm-label' }, [
      React.createElement('span', { key: 'name' }, field.label),
      React.createElement('span', { key: 'hint', className: 'dshm-hint' }, field.hint),
    ]),
    React.createElement('div', { key: 'control', className: 'dshm-control' }, controls),
  ])
}

/**
 * The card component.
 *
 * `props.scope` is the bound settings scope and `props.useSnapshot` its
 * reactive hook, both supplied by the registration's inject face.
 */
function createCard(React) {
  return function MemoriesCard(props) {
    const scope = props.scope
    const snapshot = props.useSnapshot((value) => value)
    const [error, setError] = React.useState(null)
    const [saved, setSaved] = React.useState(false)
    const [pending, setPending] = React.useState({})

    const settle = (field) => {
      setPending((previous) => {
        const next = { ...previous }
        delete next[field]
        return next
      })
    }

    const onEdit = (field, value) => {
      setError(null)
      setSaved(false)
      setPending((previous) => ({ ...previous, [field]: value }))
      const operation = value === undefined ? scope.unset(field) : scope.set(field, value)
      Promise.resolve(operation).then(
        () => { settle(field); setSaved(true) },
        (failure) => { settle(field); setError(failure instanceof Error ? failure.message : String(failure)) },
      )
    }

    const statusLine = error !== null
      ? React.createElement('p', { key: 'status', className: 'dshm-status dshm-error' }, error)
      : saved
        ? React.createElement('p', { key: 'status', className: 'dshm-status dshm-ok' }, 'Saved.')
        : null

    const children = [
      React.createElement('div', { key: 'head', className: 'dshm-head' }, [
        React.createElement('h3', { key: 'title', className: 'dshm-title' }, 'Memories'),
        React.createElement('span', { key: 'ns', className: 'dshm-ns' }, NS),
      ]),
      React.createElement('p', { key: 'intro', className: 'dshm-intro' },
        'Cross-session memory: a project-scoped store shared by every session in this workspace, and a global store shared by every project.'),
    ]
    if (snapshot.status === 'unavailable') {
      children.push(React.createElement('p', { key: 'unavailable', className: 'dshm-status dshm-error' },
        'This deployment does not expose the memories settings namespace to the browser.'))
    }
    for (const field of FIELDS) children.push(renderRow(React, field, snapshot, pending[field.field], onEdit))
    if (statusLine !== null) children.push(statusLine)
    children.push(React.createElement('p', { key: 'note', className: 'dshm-note' },
      'Changes apply immediately; no restart is needed. The store location is a deployment setting.'))
    return React.createElement('section', { className: 'dshm-card' }, children)
  }
}

/**
 * Create the browser-half plugin from the bundle's `require`.
 * @param require - the module system's synchronous require.
 * @returns the plugin's `apply` and `inject`.
 */
function createPlugin(require) {
  const React = require('react')
  const Card = createCard(React)

  const apply = (ctx) => {
    ensureStyles()
    const scope = ctx.settingsScope.bind({ namespace: NS })
    ctx.effect(() => () => { void scope.dispose() }, 'dsh-memories: settings scope')
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      inject: () => ({
        scope,
        useSnapshot: (select) => {
          const [value, setValue] = React.useState(() => select(scope.getSnapshot()))
          React.useEffect(() => scope.subscribe(() => setValue(select(scope.getSnapshot()))), [scope])
          return value
        },
      }),
    }, Card))
  }

  return { apply, inject: ['slots', 'settingsScope'] }
}
