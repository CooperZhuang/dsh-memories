/**
 * `dsh-memories` browser half.
 *
 * Shipped as the package's `./client` bundle: the DSH client module system
 * loads it as a `window.__ModuleLoader__.load({ id, factory })` script, calls
 * `factory(require)`, and mounts the exported plugin (`apply` + `inject`) into
 * the browser Cordis tree.
 *
 * It contributes one surface, the **Memories page** (`settings.section`): it
 * lists, searches, adds, and deletes memories through the Remote namespace the
 * host registers, and it embeds the tunables card at its foot. The card is not
 * also registered under `settings.plugin.item` — everything about this plugin
 * lives on its own page, not in the crowded host-plugin configuration list.
 *
 * Written as plain CJS with `createElement` instead of JSX so the package needs
 * no bundler: the bundle only requires modules the browser already provides
 * (`react`) and reaches every service through Cordis. The parts live in
 * `client/parts/`; `scripts/build-client.mjs` concatenates them in order and
 * injects the host's own wire table.
 */

/** Copy for the active locale. */
function sectionCopy(ctx) {
  const locale = ctx.get('locale')
  const active = typeof locale?.getLocale === 'function' ? locale.getLocale().active : undefined
  const isZh = typeof active === 'string' && active.length > 0
    ? active.startsWith('zh')
    : typeof navigator !== 'undefined' && String(navigator.language ?? '').startsWith('zh')
  return SECTION_COPY[isZh ? 'zh' : 'en']
}

/**
 * Create the browser-half plugin from the bundle's `require`.
 * @param require - the module system's synchronous require.
 * @returns the plugin's `apply` and `inject`.
 */
function createPlugin(require) {
  const React = require('react')
  const Card = createMemoriesCard(React)
  const Section = createMemoriesSection(React, Card)

  const apply = async (ctx) => {
    ensureStyles()
    const scope = ctx.settingsScope.bind({ namespace: NS })
    ctx.effect(() => () => { void scope.dispose() }, 'dsh-memories: settings scope')
    const useSnapshot = (select) => {
      const [value, setValue] = React.useState(() => select(scope.getSnapshot()))
      React.useEffect(() => scope.subscribe(() => setValue(select(scope.getSnapshot()))), [scope])
      return value
    }

    // The page is useless without the host API, but the tunables card is not, so
    // a missing gateway degrades this surface instead of failing the plugin.
    let api
    try {
      api = await mountMemoriesRemote(ctx)
    } catch (failure) {
      ctx.logger?.warn?.('dsh-memories: remote mount failed: %o', failure)
    }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'memories',
      order: 25,
      label: () => sectionCopy(ctx).label,
      inject: () => ({ api, scope, useSnapshot, copy: sectionCopy(ctx) }),
    }, Section))
  }

  return { apply, inject: ['slots', 'settingsScope'] }
}
