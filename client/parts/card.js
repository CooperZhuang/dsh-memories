/**
 * The tunables card: one `settings.plugin.item` contribution keyed by the
 * `memories` settings namespace.
 *
 * Field descriptors, in render order. `kind` picks the control; `min`/`step`
 * bound the numeric inputs. Keep this list in sync with `MemoriesSettingsSchema`
 * — the host is the authority on what it accepts, and a field the schema does
 * not declare fails the save instead of being silently dropped.
 */

/** Settings namespace this card edits; must match the host registration. */
const NS = 'memories'

/** One row per tunable. */
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
  { field: 'minIdleHours', label: 'Minimum idle before mining (hours)', hint: 'A session must have been idle at least this long before it is mined. 0 disables the gate.', kind: 'number', min: 0, step: 1 },
  { field: 'maxAgeDays', label: 'Never mine sessions older than (days)', hint: 'Sessions whose last activity is older than this are never mined. 0 disables the gate.', kind: 'number', min: 0, step: 1 },
  { field: 'maxSessionsPerPass', label: 'Sessions per pass', hint: 'How many sessions one extraction pass may mine, newest first.', kind: 'number', min: 1, step: 1 },
  { field: 'consolidate', label: 'Consolidation pass', hint: 'After new memories land, merge and reconcile them through a restricted sub-agent.', kind: 'boolean' },
  { field: 'consolidateCooldownHours', label: 'Consolidation cooldown (hours)', hint: 'Minimum hours between consolidation passes; bounds background quota use.', kind: 'number', min: 0, step: 1 },
  { field: 'consolidateMaxEntries', label: 'Memories per consolidation', hint: 'How many memories one consolidation pass may consider.', kind: 'number', min: 1, step: 8 },
  { field: 'consolidateTimeoutMs', label: 'Consolidation timeout (ms)', hint: 'Timeout for one consolidation sub-agent run.', kind: 'number', min: 1000, step: 10000 },
  { field: 'extractProvider', label: 'Extraction provider', hint: "Provider route for extraction. Empty reuses the session's own logged route.", kind: 'text' },
  { field: 'extractModel', label: 'Extraction model', hint: "Model for extraction. Empty reuses the session's own logged route.", kind: 'text' },
  { field: 'enableTool', label: 'Memory tool', hint: 'Register the model-facing memory tool. Takes effect immediately.', kind: 'boolean' },
  { field: 'enableCommand', label: 'Slash command', hint: 'Register the /memories command. Takes effect immediately.', kind: 'boolean' },
]

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
 * Build the card component.
 *
 * `props.scope` is the bound settings scope and `props.useSnapshot` its
 * reactive hook, both supplied by the registration's inject face. The component
 * is reused verbatim inside the Memories settings page, so both surfaces edit
 * one namespace through one write path.
 *
 * @param React - the shell's React instance.
 * @returns the card component.
 */
function createMemoriesCard(React) {
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
        React.createElement('h3', { key: 'title', className: 'dshm-title' }, props.title ?? 'Memories'),
        React.createElement('span', { key: 'ns', className: 'dshm-ns' }, NS),
      ]),
    ]
    if (props.intro !== false) {
      children.push(React.createElement('p', { key: 'intro', className: 'dshm-intro' },
        'Cross-session memory: a project-scoped store shared by every session in this workspace, and a global store shared by every project.'))
    }
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
