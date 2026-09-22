/**
 * The Memories settings page: one `settings.section` contribution.
 *
 * The section owns its whole surface — header, filters, entry list, draft
 * skills, and the tunables card — because a settings section's copy and data
 * both belong to the feature that registered it. Data arrives through the
 * Remote namespace the host registered (`ctx.remote.memories`), tunables through
 * this entry's own config form, so this page reads one store and one config and
 * never a private route.
 */

/** Every string the page renders, per locale. */
const SECTION_COPY = {
  zh: {
    lang: 'zh',
    label: '记忆',
    title: '记忆',
    intro: '跨会话记忆：全局库对所有项目生效，项目库只对同一个工作区生效。这里可以查看、搜索、新增和删除记忆。',
    store: '存储位置',
    global: '全局',
    project: '项目',
    unit: '条',
    search: '搜索记忆…',
    allScopes: '全部范围',
    allKinds: '全部类型',
    kindLabels: { preference: '偏好', failure: '失败教训', procedure: '流程', knowledge: '经验', fact: '事实' },
    empty: '没有匹配的记忆。',
    loading: '加载中…',
    forget: '删除',
    confirm: '删除这条记忆？',
    add: '新增记忆',
    cancel: '取消',
    save: '保存',
    titlePlaceholder: '标题：一行说清这条记忆',
    bodyPlaceholder: '正文：1-4 句话',
    tagsPlaceholder: '标签，逗号分隔（可选）',
    drafts: '待提升的 skill 草稿',
    promote: '提升到技能目录',
    discard: '丢弃',
    promoted: '已提升',
    tunables: '配置项',
    tabMemories: '记忆',
    tabConfig: '配置',
    tabDisputes: '待裁决',
    disputesTitle: '合并时需要你拍板的事',
    disputesIntro: '后台合并会自动执行可逆的改动（合并重复、收紧措辞、退役从没被读过的条目）。只有下面这些会伤到内容，才留给你决定——接受就按它改，驳回就原样保留，不动它过 72 小时会自动作废。',
    disputeRetire: '建议退役',
    disputeRewrite: '建议改写',
    disputeBefore: '现在是',
    disputeAfter: '改成',
    accept: '接受',
    reject: '保留原样',
    noDisputes: '没有待裁决的事项。',
    unavailable: '本部署没有把 memories 远程接口暴露给浏览器，只能编辑可调项。',
    uses: '使用',
    session: '来自会话',
    updated: '更新于',
    saved: '已保存。',
    removed: '已删除。',
    needTitle: '标题和正文都要填。',
  },
  en: {
    lang: 'en',
    label: 'Memories',
    title: 'Memories',
    intro: 'Cross-session memory: the global store applies to every project, the project store to one workspace. Inspect, search, add, and delete memories here.',
    store: 'Store',
    global: 'Global',
    project: 'Project',
    unit: 'memories',
    search: 'Search memories…',
    allScopes: 'All scopes',
    allKinds: 'All kinds',
    kindLabels: { preference: 'Preference', failure: 'Failure', procedure: 'Procedure', knowledge: 'Knowledge', fact: 'Fact' },
    empty: 'No memory matches.',
    loading: 'Loading…',
    forget: 'Delete',
    confirm: 'Delete this memory?',
    add: 'New memory',
    cancel: 'Cancel',
    save: 'Save',
    titlePlaceholder: 'Title: one line',
    bodyPlaceholder: 'Body: 1-4 sentences',
    tagsPlaceholder: 'Tags, comma separated (optional)',
    drafts: 'Staged skill drafts',
    promote: 'Promote to the skill root',
    discard: 'Discard',
    promoted: 'Promoted',
    tunables: 'Tunables',
    tabMemories: 'Memories',
    tabConfig: 'Configuration',
    tabDisputes: 'Needs review',
    disputesTitle: 'Decisions consolidation will not make on its own',
    disputesIntro: 'Background consolidation applies what is reversible by itself: folding duplicates, sharpening wording, retiring memories nothing ever read. The rows below would lose something — accept applies the change, reject keeps the memory as it is, and doing nothing expires the question after 72 hours.',
    disputeRetire: 'retire',
    disputeRewrite: 'rewrite',
    disputeBefore: 'now',
    disputeAfter: 'would become',
    accept: 'Accept',
    reject: 'Keep as is',
    noDisputes: 'Nothing needs your decision.',
    unavailable: 'This deployment does not expose the memories Remote API to the browser; only the tunables can be edited.',
    uses: 'used',
    session: 'from',
    updated: 'updated',
    saved: 'Saved.',
    removed: 'Deleted.',
    needTitle: 'A title and a body are both required.',
  },
}

/** Message text of an unknown thrown value. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Render one timestamp as a short local string. */
function whenText(ms) {
  return ms > 0 ? new Date(ms).toLocaleString() : '—'
}

/**
 * Build the section component.
 *
 * @param React - the shell's React instance.
 * @param Card - the tunables card component, reused verbatim.
 * @returns the settings section component.
 */
function createMemoriesSection(React, Card) {
  const h = React.createElement

  /** One entry row. */
  function EntryRow(props) {
    const copy = props.copy
    const entry = props.entry
    const badge = (text, extra) => h('span', { key: text, className: `dshm-badge${extra === true ? ' dshm-badge-global' : ''}` }, text)
    return h('li', { className: 'dshm-entry' }, [
      h('div', { key: 'head', className: 'dshm-entry-head' }, [
        h('h4', { key: 'title', className: 'dshm-entry-title' }, entry.title),
        badge(copy.kindLabels[entry.kind] ?? entry.kind),
        badge(entry.scope === 'global' ? copy.global : copy.project, entry.scope === 'global'),
      ]),
      h('p', { key: 'body', className: 'dshm-body' }, entry.body),
      h('div', { key: 'meta', className: 'dshm-meta' }, [
        h('span', { key: 'updated' }, `${copy.updated} ${whenText(entry.updatedAt)}`),
        h('span', { key: 'uses' }, `${copy.uses} ${entry.uses}`),
        entry.tags.length > 0 ? h('span', { key: 'tags' }, entry.tags.join(' · ')) : null,
        entry.sourceSession !== undefined && entry.sourceSession.length > 0
          ? h('span', { key: 'session' }, `${copy.session} ${entry.sourceSession}`)
          : null,
      ]),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'forget',
          type: 'button',
          className: 'dshm-btn',
          disabled: props.busy,
          onClick: () => props.onForget(entry),
        }, copy.forget),
      ]),
    ])
  }

  /** One staged draft row. */
  function DraftRow(props) {
    const copy = props.copy
    const draft = props.draft
    return h('li', { key: draft.name, className: 'dshm-entry' }, [
      h('div', { key: 'head', className: 'dshm-entry-head' }, [
        h('h4', { key: 'name', className: 'dshm-entry-title' }, draft.name),
        draft.promoted ? h('span', { key: 'state', className: 'dshm-badge dshm-badge-global' }, copy.promoted) : null,
      ]),
      h('p', { key: 'desc', className: 'dshm-body' }, draft.description || '—'),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'promote',
          type: 'button',
          className: 'dshm-btn dshm-btn-primary',
          disabled: props.busy,
          onClick: () => props.onPromote(draft),
        }, copy.promote),
        h('button', {
          key: 'discard',
          type: 'button',
          className: 'dshm-btn',
          disabled: props.busy,
          onClick: () => props.onDiscard(draft),
        }, copy.discard),
      ]),
    ])
  }

  return function MemoriesSection(props) {
    const copy = props.copy
    const api = props.api
    const [overview, setOverview] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [notice, setNotice] = React.useState(null)
    const [entries, setEntries] = React.useState([])
    const [total, setTotal] = React.useState(0)
    const [loading, setLoading] = React.useState(true)
    const [busy, setBusy] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const [settledQuery, setSettledQuery] = React.useState('')
    const [scope, setScope] = React.useState('all')
    const [kind, setKind] = React.useState('')
    const [project, setProject] = React.useState('')
    const [formOpen, setFormOpen] = React.useState(false)
    const [tab, setTab] = React.useState('memories')
    const [disputes, setDisputes] = React.useState([])
    const [draft, setDraft] = React.useState({ scope: 'global', kind: 'fact', title: '', body: '', tags: '' })

    const loadOverview = React.useCallback(async () => {
      if (api === undefined) return
      try {
        setOverview(await api.overview())
      } catch (failure) {
        setError(errorText(failure))
      }
    }, [api])

    const loadEntries = React.useCallback(async () => {
      if (api === undefined) return
      setLoading(true)
      try {
        const result = await api.list({
          project,
          scope: scope === 'all' ? '' : scope,
          query: settledQuery,
          kind,
          limit: 100,
        })
        setEntries(result?.entries ?? [])
        setTotal(result?.total ?? 0)
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setLoading(false)
      }
    }, [api, project, scope, kind, settledQuery])

    // Debounce typing so a search does not issue one call per keystroke.
    React.useEffect(() => {
      const timer = setTimeout(() => setSettledQuery(query), 250)
      return () => clearTimeout(timer)
    }, [query])

    // A decision waits for a person, so the count has to be visible without
    // opening the tab — otherwise it is a question nobody knows was asked.
    const loadDisputes = React.useCallback(async () => {
      if (api === undefined || typeof api.disputes !== 'function') return
      try {
        const result = await api.disputes()
        setDisputes(result?.disputes ?? [])
      } catch (failure) {
        setError(errorText(failure))
      }
    }, [api])

    React.useEffect(() => { void loadOverview() }, [loadOverview])
    React.useEffect(() => { void loadEntries() }, [loadEntries])
    React.useEffect(() => { void loadDisputes() }, [loadDisputes])

    // Preselect the newest project so the project filter has a subject.
    React.useEffect(() => {
      if (project !== '' || overview === null) return
      const first = overview.projects?.[0]
      if (first !== undefined) setProject(first.slug)
    }, [overview, project])

    const refresh = async () => {
      await Promise.all([loadOverview(), loadEntries(), loadDisputes()])
    }

    /** Accept or reject one waiting decision, then reload what it changed. */
    const onResolve = async (row, decision) => {
      if (api === undefined || typeof api.resolveDispute !== 'function') {
        setError(copy.unavailable)
        return
      }
      setBusy(true)
      setNotice(null)
      try {
        // One object keyed by the descriptor's own parameter names: the Remote
        // wrapper maps those fields onto the gateway's positional arguments, so
        // a positional call arrives as no arguments at all.
        setNotice(await api.resolveDispute({ id: row.id, decision }))
        await refresh()
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onForget = async (entry) => {
      if (api === undefined) return
      if (typeof window !== 'undefined' && !window.confirm(copy.confirm)) return
      setBusy(true)
      setNotice(null)
      try {
        await api.forget({ project, scope: entry.scope, id: entry.id })
        setNotice(copy.removed)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onPromote = async (staged) => {
      if (api === undefined) return
      setBusy(true)
      try {
        const result = await api.promoteSkill({ name: staged.name })
        setNotice(`${copy.promoted}: ${result.path}`)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onDiscard = async (staged) => {
      if (api === undefined) return
      setBusy(true)
      try {
        await api.discardSkill({ name: staged.name })
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onSubmit = async (event) => {
      event.preventDefault()
      if (api === undefined) return
      if (draft.title.trim().length === 0 || draft.body.trim().length === 0) {
        setError(copy.needTitle)
        return
      }
      setBusy(true)
      setError(null)
      try {
        await api.add({ ...draft, project })
        setDraft({ scope: draft.scope, kind: draft.kind, title: '', body: '', tags: '' })
        setFormOpen(false)
        setNotice(copy.saved)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const setDraftField = (field, value) => setDraft((previous) => ({ ...previous, [field]: value }))

    const kindOptions = (overview?.kinds ?? ['preference', 'failure', 'procedure', 'knowledge', 'fact']).map((value) =>
      h('option', { key: value, value }, copy.kindLabels[value] ?? value))

    // The host is the authority on shape, but a missing array must degrade to an
    // empty list rather than blank the whole page.
    const projects = overview?.projects ?? []
    const staged = overview?.drafts ?? []

    const head = h('div', { key: 'head', className: 'dshm-head' }, [
      h('h2', { key: 'title', className: 'dshm-title' }, copy.title),
    ])

    const stats = overview === null ? null : h('p', { key: 'stats', className: 'dshm-note' }, [
      `${copy.global} ${overview.globalCount ?? 0} ${copy.unit}`,
      ' · ',
      projects.map((row) => `${row.name} ${row.count}`).join(' · ') || `${copy.project} 0 ${copy.unit}`,
    ])

    const toolbar = h('div', { key: 'toolbar', className: 'dshm-toolbar' }, [
      h('input', {
        key: 'search',
        className: 'dshm-input dshm-grow',
        type: 'search',
        value: query,
        placeholder: copy.search,
        disabled: api === undefined,
        onChange: (event) => setQuery(event.target.value),
      }),
      h('select', {
        key: 'scope',
        className: 'dshm-select',
        value: scope,
        disabled: api === undefined,
        onChange: (event) => setScope(event.target.value),
      }, [
        h('option', { key: 'all', value: 'all' }, copy.allScopes),
        h('option', { key: 'global', value: 'global' }, copy.global),
        h('option', { key: 'project', value: 'project' }, copy.project),
      ]),
      h('select', {
        key: 'kind',
        className: 'dshm-select',
        value: kind,
        disabled: api === undefined,
        onChange: (event) => setKind(event.target.value),
      }, [h('option', { key: 'any', value: '' }, copy.allKinds), ...kindOptions]),
      h('select', {
        key: 'project',
        className: 'dshm-select',
        value: project,
        disabled: api === undefined || projects.length === 0,
        onChange: (event) => setProject(event.target.value),
      }, projects.map((row) => h('option', { key: row.slug, value: row.slug }, `${row.name} (${row.count})`))),
      h('button', {
        key: 'add',
        type: 'button',
        className: 'dshm-btn dshm-btn-primary',
        disabled: api === undefined,
        onClick: () => setFormOpen((open) => !open),
      }, copy.add),
    ])

    const form = formOpen ? h('form', { key: 'form', className: 'dshm-form', onSubmit }, [
      h('div', { key: 'row', className: 'dshm-form-row' }, [
        h('select', {
          key: 'scope',
          className: 'dshm-select',
          value: draft.scope,
          onChange: (event) => setDraftField('scope', event.target.value),
        }, [
          h('option', { key: 'global', value: 'global' }, copy.global),
          h('option', { key: 'project', value: 'project' }, copy.project),
        ]),
        h('select', {
          key: 'kind',
          className: 'dshm-select',
          value: draft.kind,
          onChange: (event) => setDraftField('kind', event.target.value),
        }, kindOptions),
      ]),
      h('input', {
        key: 'title',
        className: 'dshm-input',
        style: { width: '100%' },
        value: draft.title,
        placeholder: copy.titlePlaceholder,
        onChange: (event) => setDraftField('title', event.target.value),
      }),
      h('textarea', {
        key: 'body',
        className: 'dshm-area',
        value: draft.body,
        placeholder: copy.bodyPlaceholder,
        onChange: (event) => setDraftField('body', event.target.value),
      }),
      h('input', {
        key: 'tags',
        className: 'dshm-input',
        style: { width: '100%' },
        value: draft.tags,
        placeholder: copy.tagsPlaceholder,
        onChange: (event) => setDraftField('tags', event.target.value),
      }),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', { key: 'save', type: 'submit', className: 'dshm-btn dshm-btn-primary', disabled: busy }, copy.save),
        h('button', { key: 'cancel', type: 'button', className: 'dshm-btn', onClick: () => setFormOpen(false) }, copy.cancel),
      ]),
    ]) : null

    const list = loading && entries.length === 0
      ? h('p', { key: 'loading', className: 'dshm-empty' }, copy.loading)
      : entries.length === 0
        ? h('p', { key: 'empty', className: 'dshm-empty' }, copy.empty)
        : h('ul', { key: 'list', className: 'dshm-list' }, entries.map((entry) =>
          h(EntryRow, { key: `${entry.scope}:${entry.id}`, entry, copy, busy, onForget })))

    const drafts = staged.length > 0
      ? h('section', { key: 'drafts', className: 'dshm-card' }, [
        h('h3', { key: 'title', className: 'dshm-section-title' }, copy.drafts),
        h('ul', { key: 'list', className: 'dshm-list' }, staged.map((row) =>
          h(DraftRow, { key: row.name, draft: row, copy, busy, onPromote, onDiscard }))),
      ])
      : null

    const tabList = h('div', { key: 'tabs', className: 'dshm-tabs', role: 'tablist' }, [
      h('button', {
        key: 'memories',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'memories',
        className: `dshm-tab${tab === 'memories' ? ' dshm-tab-active' : ''}`,
        onClick: () => setTab('memories'),
      }, copy.tabMemories),
      h('button', {
        key: 'config',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'config',
        className: `dshm-tab${tab === 'config' ? ' dshm-tab-active' : ''}`,
        onClick: () => setTab('config'),
      }, copy.tabConfig),
      h('button', {
        key: 'disputes',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'disputes',
        className: `dshm-tab${tab === 'disputes' ? ' dshm-tab-active' : ''}${disputes.length > 0 ? ' dshm-tab-alert' : ''}`,
        onClick: () => setTab('disputes'),
      }, disputes.length > 0 ? `${copy.tabDisputes} (${disputes.length})` : copy.tabDisputes),
    ])

    // The two tabs keep the store's CONTENT and the plugin's SETTINGS apart: one
    // page, one place to look, and neither surface buries the other.
    const memoriesPanel = h('div', { key: 'panel-memories', role: 'tabpanel', className: 'dshm-panel' }, [
      api === undefined ? h('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable) : null,
      overview !== null && stats !== null ? stats : null,
      toolbar,
      form,
      h('p', { key: 'count', className: 'dshm-note' }, `${entries.length} / ${total} ${copy.unit}`),
      list,
      drafts,
      error !== null ? h('p', { key: 'error', className: 'dshm-status dshm-error' }, error) : null,
      notice !== null ? h('p', { key: 'notice', className: 'dshm-status dshm-ok' }, notice) : null,
    ])

    const configPanel = h('div', { key: 'panel-config', role: 'tabpanel', className: 'dshm-panel' }, [
      h(Card, {
        key: 'tunables',
        scope: props.scope,
        useSnapshot: props.useSnapshot,
        title: copy.tunables,
        intro: false,
        lang: copy.lang,
      }),
    ])

    // Only the decisions a pass refused to make alone. The panel says what the
    // memory says today and what the pass wants instead, because a rewrite is not
    // decidable from its title.
    const disputeRows = disputes.map((row) => h('li', { key: `${row.action}:${row.id}`, className: 'dshm-entry' }, [
      h('div', { key: 'head', className: 'dshm-entry-head' }, [
        h('h4', { key: 'title', className: 'dshm-entry-title' }, row.title),
        h('span', { key: 'action', className: 'dshm-badge dshm-badge-global' }, row.action === 'retire' ? copy.disputeRetire : copy.disputeRewrite),
      ]),
      h('p', { key: 'reason', className: 'dshm-note' }, row.reason),
      h('p', { key: 'before', className: 'dshm-body' }, `${copy.disputeBefore}: ${row.before}`),
      row.after ? h('p', { key: 'after', className: 'dshm-body' }, `${copy.disputeAfter}: ${row.after}`) : null,
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'accept',
          type: 'button',
          className: 'dshm-btn dshm-btn-primary',
          disabled: busy,
          onClick: () => onResolve(row, 'accept'),
        }, copy.accept),
        h('button', {
          key: 'reject',
          type: 'button',
          className: 'dshm-btn',
          disabled: busy,
          onClick: () => onResolve(row, 'reject'),
        }, copy.reject),
      ]),
    ]))
    const disputesPanel = h('div', { key: 'panel-disputes', role: 'tabpanel', className: 'dshm-panel' }, [
      h('h3', { key: 'title', className: 'dshm-section-title' }, copy.disputesTitle),
      h('p', { key: 'intro', className: 'dshm-note' }, copy.disputesIntro),
      api === undefined ? h('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable) : null,
      disputeRows.length > 0
        ? h('ul', { key: 'list', className: 'dshm-list' }, disputeRows)
        : h('p', { key: 'empty', className: 'dshm-note' }, copy.noDisputes),
      notice !== null ? h('p', { key: 'notice', className: 'dshm-status dshm-ok' }, notice) : null,
      error !== null ? h('p', { key: 'error', className: 'dshm-status dshm-error' }, error) : null,
    ])

    const children = [head]
    if (overview !== null) children.push(h('p', { key: 'store', className: 'dshm-path' }, `${copy.store}: ${overview.storePath}`))
    children.push(tabList)
    children.push(tab === 'config' ? configPanel : tab === 'disputes' ? disputesPanel : memoriesPanel)
    return h('div', { className: 'dshm-page' }, children)
  }
}
