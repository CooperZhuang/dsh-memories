/**
 * The tunables card, embedded at the foot of the Memories settings page.
 *
 * Field descriptors, in render order. `kind` picks the control; `min`/`step`
 * bound the numeric inputs. Every label and hint is bilingual (Chinese first,
 * English fallback) and resolves from the active locale, so the surface reads
 * naturally in the language the shell is already speaking. Keep this list in
 * sync with `MemoriesSettingsSchema` — the host is the authority on what it
 * accepts, and a field the schema does not declare fails the save instead of
 * being silently dropped.
 */

/** Settings namespace this card edits; must match the host registration. */
const NS = 'memories'

/** Per-locale chrome strings for the card frame. */
const CARD_COPY = {
  zh: {
    reset: '恢复默认',
    saved: '已保存。',
    unavailable: '这个部署没有把 memories 设置命名空间暴露给浏览器。',
    note: '改动立即生效，无需重启。存储位置是部署层配置。',
  },
  en: {
    reset: 'Reset',
    saved: 'Saved.',
    unavailable: 'This deployment does not expose the memories settings namespace to the browser.',
    note: 'Changes apply immediately; no restart is needed. The store location is a deployment setting.',
  },
}

/** One row per tunable; `label`/`hint` are the `{ zh, en }` pair. */
const FIELDS = [
  {
    field: 'maxSummaryBytes', kind: 'number', min: 0, step: 256,
    label: { zh: '摘要字节上限', en: 'Summary byte budget' },
    hint: { zh: '一次会话注入的记忆摘要最大字节数，0 表示关闭注入。', en: 'Bytes of memory summary injected once per conversation. 0 disables injection.' },
  },
  {
    field: 'maxSummaryEntries', kind: 'number', min: 1, step: 1,
    label: { zh: '每作用域摘要条数', en: 'Summary entries per scope' },
    hint: { zh: '摘要里每个作用域列出多少条记忆。', en: 'How many memories each scope lists in the summary.' },
  },
  {
    field: 'recallMode', kind: 'select',
    options: [
      { value: 'once', label: { zh: '仅一次', en: 'Once' } },
      { value: 'on-demand', label: { zh: '按需补充', en: 'On demand' } },
      { value: 'off', label: { zh: '关闭注入', en: 'Off' } },
    ],
    label: { zh: '记忆注入方式', en: 'Memory injection' },
    hint: { zh: 'once 只在会话开始时注入一次摘要；on-demand 额外在当前话题明显命中记忆时补一小块；off 完全关闭注入，只留记忆工具。', en: 'once injects the summary at the start of the conversation; on-demand also adds a small block when the current turn clearly matches a memory; off disables injection and leaves only the memory tool.' },
  },
  {
    field: 'recallMinScore', kind: 'number', min: 0, step: 5,
    label: { zh: '按需注入的相关度下限', en: 'Recall relevance floor' },
    hint: { zh: '补注需要达到的相关度分数；标题、别名或标签命中即可达到。0 表示只要沾边就补。', en: 'Relevance a memory must reach to be injected on demand; a title, key, or tag hit clears it. 0 accepts any match.' },
  },
  {
    field: 'recallMaxPerConversation', kind: 'number', min: 0, step: 1,
    label: { zh: '每会话补注次数上限', en: 'Recall deltas per conversation' },
    hint: { zh: '一个会话最多补注几次；0 关闭按需补注，只保留一次摘要。', en: 'Maximum on-demand blocks per conversation. 0 keeps only the once-per-conversation summary.' },
  },
  {
    field: 'maxEntriesPerScope', kind: 'number', min: 1, step: 1,
    label: { zh: '每作用域保留条数', en: 'Stored memories per scope' },
    hint: { zh: '超过后归档最久未使用的记忆（可用 /memories restore 取回）。', en: 'Past this cap the least recently used memories are archived; /memories restore brings one back.' },
  },
  {
    field: 'maxUnusedDays', kind: 'number', min: 0, step: 10,
    label: { zh: '无用记忆归档天数', en: 'Archive unused after (days)' },
    hint: { zh: '这么久没有被读到、没有被注入摘要、也不是新写的记忆会被归档（可恢复）。0 关闭归档；人手写的记忆永不归档。', en: 'Archive a memory that has not been read, surfaced, or written for this many days. Recoverable with /memories restore. 0 disables archival; memories a person wrote are never archived.' },
  },
  {
    field: 'dedupeSimilarity', kind: 'number', min: 0, step: 0.05,
    label: { zh: '近似重复合并阈值', en: 'Near-duplicate threshold' },
    hint: { zh: '标题与正文词重叠超过该比例时，新记忆视为改写并取代旧记忆（0–1）。0 只保留完全相同才合并的规则。', en: 'Share of title and body words two memories must share before the newer one supersedes the older (0-1). 0 keeps only the exact-match rule.' },
  },
  {
    field: 'sweepIntervalHours', kind: 'number', min: 0, step: 1,
    label: { zh: '定期整理间隔（小时）', en: 'Maintenance sweep interval (hours)' },
    hint: { zh: '每隔多久对所有工作区做一次归档整理；0 关闭定期整理（仍可用 /memories sweep 手动执行）。', en: 'How often to run retention across every workspace. 0 disables the periodic sweep; /memories sweep still runs it on demand.' },
  },
  {
    field: 'autoExtract', kind: 'boolean',
    label: { zh: '后台抽取', en: 'Background extraction' },
    hint: { zh: '会话空闲后从最近对话里抽取值得长期保留的事实。', en: 'Mine finished sessions for durable facts once they have been idle.' },
  },
  {
    field: 'autoExtractIdleMs', kind: 'number', min: 1000, step: 1000,
    label: { zh: '抽取前空闲时长（毫秒）', en: 'Idle before extraction (ms)' },
    hint: { zh: '会话需空闲多久才开始挖掘。', en: 'How long a session must stay idle before it is mined.' },
  },
  {
    field: 'extractWindowMessages', kind: 'number', min: 1, step: 1,
    label: { zh: '抽取窗口（条消息）', en: 'Extraction window (messages)' },
    hint: { zh: '一次抽取最多读最近多少条对话消息。', en: 'How many recent conversation messages one extraction reads.' },
  },
  {
    field: 'extractMaxInputChars', kind: 'number', min: 1, step: 1000,
    label: { zh: '抽取输入预算（字符）', en: 'Extraction input budget (chars)' },
    hint: { zh: '交给抽取器的对话文本字符上限。', en: 'Character budget for the transcript handed to the extractor.' },
  },
  {
    field: 'extractMaxOutputTokens', kind: 'number', min: 1, step: 128,
    label: { zh: '抽取输出 token 上限', en: 'Extraction output tokens' },
    hint: { zh: '一次抽取调用的输出 token 上限。', en: 'Output token cap for one extraction call.' },
  },
  {
    field: 'extractTimeoutMs', kind: 'number', min: 1000, step: 5000,
    label: { zh: '抽取超时（毫秒）', en: 'Extraction timeout (ms)' },
    hint: { zh: '一次抽取调用的超时时间。', en: 'Timeout for one extraction call.' },
  },
  {
    field: 'extractMaxMemories', kind: 'number', min: 1, step: 1,
    label: { zh: '每次抽取条数上限', en: 'Memories per extraction' },
    hint: { zh: '一次抽取最多写入多少条记忆。', en: 'Maximum memories one extraction pass may store.' },
  },
  {
    field: 'minIdleHours', kind: 'number', min: 0, step: 1,
    label: { zh: '挖掘前最短空闲（小时）', en: 'Minimum idle before mining (hours)' },
    hint: { zh: '会话至少要空闲这么久才会被挖掘，0 关闭该闸门。', en: 'A session must have been idle at least this long before it is mined. 0 disables the gate.' },
  },
  {
    field: 'maxAgeDays', kind: 'number', min: 0, step: 1,
    label: { zh: '超过天数不再挖掘（天）', en: 'Never mine sessions older than (days)' },
    hint: { zh: '最后活动早于该天数的会话永不挖掘，0 关闭该闸门。', en: 'Sessions whose last activity is older than this are never mined. 0 disables the gate.' },
  },
  {
    field: 'maxSessionsPerPass', kind: 'number', min: 1, step: 1,
    label: { zh: '每次挖掘的会话数', en: 'Sessions per pass' },
    hint: { zh: '一次抽取最多挖掘多少个会话，新的优先。', en: 'How many sessions one extraction pass may mine, newest first.' },
  },
  {
    field: 'consolidate', kind: 'boolean',
    label: { zh: '合并重整', en: 'Consolidation pass' },
    hint: { zh: '新记忆落盘后，用一个受限子代理合并、改写并相互协调。', en: 'After new memories land, merge and reconcile them through a restricted sub-agent.' },
  },
  {
    field: 'consolidateCooldownHours', kind: 'number', min: 0, step: 1,
    label: { zh: '合并冷却（小时）', en: 'Consolidation cooldown (hours)' },
    hint: { zh: '两次合并之间的最短小时数，约束后台额度消耗。', en: 'Minimum hours between consolidation passes; bounds background quota use.' },
  },
  {
    field: 'consolidateMaxEntries', kind: 'number', min: 1, step: 8,
    label: { zh: '每次合并条目上限', en: 'Memories per consolidation' },
    hint: { zh: '一次合并最多考虑多少条记忆。', en: 'How many memories one consolidation pass may consider.' },
  },
  {
    field: 'consolidateTimeoutMs', kind: 'number', min: 1000, step: 10000,
    label: { zh: '合并超时（毫秒）', en: 'Consolidation timeout (ms)' },
    hint: { zh: '一次合并子代理运行的超时时间。', en: 'Timeout for one consolidation sub-agent run.' },
  },
  {
    field: 'pauseOnQuotaError', kind: 'boolean',
    label: { zh: '额度紧张时暂停后台', en: 'Pause background work on quota errors' },
    hint: { zh: '提供方因限流或额度耗尽拒绝后，暂停后台抽取与合并，直到冷却结束。', en: 'After a rate-limit or exhausted-quota refusal, stop background extraction and consolidation until the cooldown elapses.' },
  },
  {
    field: 'quotaCooldownMinutes', kind: 'number', min: 0, step: 5,
    label: { zh: '额度冷却（分钟）', en: 'Quota cooldown (minutes)' },
    hint: { zh: '一次拒绝后等待多久；连续拒绝会翻倍。0 表示不暂停。', en: 'Wait after one refusal; doubles per consecutive refusal. 0 disables the pause.' },
  },
  {
    field: 'quotaCooldownMaxMinutes', kind: 'number', min: 0, step: 30,
    label: { zh: '额度冷却上限（分钟）', en: 'Quota cooldown ceiling (minutes)' },
    hint: { zh: '上面那个等待翻倍后的上限。', en: 'Upper bound as the wait doubles.' },
  },
  {
    field: 'extractProvider', kind: 'text',
    label: { zh: '抽取提供方', en: 'Extraction provider' },
    hint: { zh: '抽取用的提供方路由；留空则复用该会话已记录的请求路由。', en: "Provider route for extraction. Empty reuses the session's own logged route." },
  },
  {
    field: 'extractModel', kind: 'text',
    label: { zh: '抽取模型', en: 'Extraction model' },
    hint: { zh: '抽取用的模型；留空则复用该会话已记录的请求路由。', en: "Model for extraction. Empty reuses the session's own logged route." },
  },
  {
    field: 'consolidateProvider', kind: 'text',
    label: { zh: '合并提供方', en: 'Consolidation provider' },
    hint: { zh: '合并用的提供方路由；留空则先回退到抽取路由，再回退到会话路由。', en: 'Provider route for consolidation. Empty falls back to the extraction route, then the session route.' },
  },
  {
    field: 'consolidateModel', kind: 'text',
    label: { zh: '合并模型', en: 'Consolidation model' },
    hint: { zh: '合并用的模型；留空则先回退到抽取路由，再回退到会话路由。', en: 'Model for consolidation. Empty falls back to the extraction route, then the session route.' },
  },
  {
    field: 'enableTool', kind: 'boolean',
    label: { zh: '记忆工具', en: 'Memory tool' },
    hint: { zh: '是否注册面向模型的 memory 工具。立即生效。', en: 'Register the model-facing memory tool. Takes effect immediately.' },
  },
  {
    field: 'enableCommand', kind: 'boolean',
    label: { zh: '斜杠命令', en: 'Slash command' },
    hint: { zh: '是否注册 /memories 命令。立即生效。', en: 'Register the /memories command. Takes effect immediately.' },
  },
  {
    field: 'logLevel', kind: 'select',
    options: [
      { value: 'off', label: { zh: '不写日志', en: 'Off' } },
      { value: 'error', label: { zh: '仅错误', en: 'Errors' } },
      { value: 'warn', label: { zh: '错误 + 警告', en: 'Errors and warnings' } },
      { value: 'info', label: { zh: '再 + 每轮摘要（默认）', en: 'Plus pass summaries' } },
      { value: 'debug', label: { zh: '全部（含逐条决策）', en: 'Everything' } },
    ],
    label: { zh: '日志等级', en: 'Log level' },
    hint: { zh: '本插件日志文件的详细程度。默认 info：错误、警告，以及每轮抽取/合并摘要。debug 还会记录每条归档、补注、复审决策。文件路径见 /memories stats。', en: 'How much this plugin writes to its own log file. info keeps errors, warnings, and one line per pass; debug adds every retention, recall, and review decision. /memories stats prints the path.' },
  },
  {
    field: 'traceMaintenance', kind: 'boolean',
    label: { zh: '记录维护决策明细', en: 'Trace maintenance decisions' },
    hint: { zh: '把归档、按需补注、复审选择等决策提升到 info，默认等级就能看到；关闭时它们只在 debug 等级出现。', en: 'Log retention, recall, and selection decisions at info so a stock log level records them; off keeps them at debug.' },
  },
]

/** Whether the user layer carries an override for one field. */
function isOverridden(snapshot, field) {
  const user = snapshot.user
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field)
}

/** Pick one field's label/hint for the active locale. */
function fieldText(field, lang) {
  return {
    label: field.label[lang] ?? field.label.zh,
    hint: field.hint[lang] ?? field.hint.zh,
  }
}

/** Render one row: label + hint on the left, control on the right. */
function renderRow(React, field, snapshot, draft, onEdit, lang, copy) {
  const text = fieldText(field, lang)
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
  } else if (field.kind === 'select') {
    controls.push(React.createElement('select', {
      key: 'input',
      className: 'dshm-input',
      value: current === undefined || current === null ? '' : String(current),
      disabled,
      onChange: (event) => onEdit(field.field, event.target.value),
    }, (field.options ?? []).map((option) => React.createElement('option', {
      key: option.value,
      value: option.value,
    }, option.label[lang] ?? option.label.zh))))
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
      title: copy.reset,
      onClick: () => onEdit(field.field, undefined),
    }, copy.reset))
  }
  return React.createElement('div', { key: field.field, className: 'dshm-row' }, [
    React.createElement('div', { key: 'label', className: 'dshm-label' }, [
      React.createElement('span', { key: 'name' }, text.label),
      React.createElement('span', { key: 'hint', className: 'dshm-hint' }, text.hint),
    ]),
    React.createElement('div', { key: 'control', className: 'dshm-control' }, controls),
  ])
}

/**
 * Build the card component.
 *
 * `props.scope` is the bound settings scope and `props.useSnapshot` its
 * reactive hook, both supplied by the registration's inject face; `props.lang`
 * and `props.copy` pick the labels and chrome for the active locale. The
 * component is embedded at the foot of the Memories settings page, so it edits
 * one namespace through one write path regardless of where it is rendered.
 *
 * @param React - the shell's React instance.
 * @returns the card component.
 */
function createMemoriesCard(React) {
  return function MemoriesCard(props) {
    const scope = props.scope
    const snapshot = props.useSnapshot((value) => value)
    const lang = props.lang ?? 'zh'
    const copy = props.copy ?? CARD_COPY[lang]
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
        ? React.createElement('p', { key: 'status', className: 'dshm-status dshm-ok' }, copy.saved)
        : null

    const children = [
      React.createElement('div', { key: 'head', className: 'dshm-head' }, [
        React.createElement('h3', { key: 'title', className: 'dshm-title' }, props.title ?? NS),
        React.createElement('span', { key: 'ns', className: 'dshm-ns' }, NS),
      ]),
    ]
    if (props.intro !== false) {
      children.push(React.createElement('p', { key: 'intro', className: 'dshm-intro' },
        props.intro ?? '跨会话记忆：项目作用域由本工作区所有会话共享，全局作用域由所有项目共享。'))
    }
    if (snapshot.status === 'unavailable') {
      children.push(React.createElement('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable))
    }
    for (const field of FIELDS) children.push(renderRow(React, field, snapshot, pending[field.field], onEdit, lang, copy))
    if (statusLine !== null) children.push(statusLine)
    children.push(React.createElement('p', { key: 'note', className: 'dshm-note' }, copy.note))
    return React.createElement('section', { className: 'dshm-card' }, children)
  }
}
