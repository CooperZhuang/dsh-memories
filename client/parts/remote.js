/**
 * Browser half of the Host→browser Remote seam.
 *
 * The host registers one Typert contribution (`src/remote.ts`); the browser
 * mounts the matching descriptor list and then calls the methods as
 * `ctx.remote.memories.*`. `REMOTE_INVOCATION_DATA` is injected verbatim into
 * this bundle by `scripts/build-client.mjs` from the host's own table, so the
 * two halves cannot drift.
 *
 * The gateway refuses any descriptor whose codec is not `strict`, so each codec
 * here carries the contract (mode + type symbol) with a permissive parser:
 * validation is the host's job, at the boundary where the value actually
 * arrives, and keeping it there means no schema library ships to the browser.
 */

/** npm package owning the Remote methods. */
const REMOTE_PACKAGE = 'dsh-memories'
/** Wire namespace, and the service key the gateway installs it under. */
const REMOTE_NAMESPACE = 'memories'
/** Full Cordis key of the namespace service. */
const REMOTE_SERVICE_KEY = `remote.${REMOTE_NAMESPACE}`

/** Build the browser-side codec for one shape. */
function clientCodec(shape) {
  return {
    mode: 'strict',
    typeSymbol: `${REMOTE_PACKAGE}#${shape}`,
    schema: { parse: (value) => value },
  }
}

/** Expand the injected wire table into a client Remote contribution. */
function clientContribution() {
  return {
    package: REMOTE_PACKAGE,
    descriptors: REMOTE_INVOCATION_DATA.map((invocation) => ({
      id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${invocation.method}`,
      service: REMOTE_NAMESPACE,
      namespace: REMOTE_NAMESPACE,
      method: invocation.method,
      invocation: { kind: 'direct' },
      parameters: invocation.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.wire,
        source: 'json',
        codec: clientCodec(parameter.shape),
        ...(parameter.optional === true ? { acceptsUndefined: true } : {}),
      })),
      result: clientCodec(invocation.result),
    })),
  }
}

/**
 * Unwrap one RemoteResult.
 *
 * Every namespace method resolves to a result envelope rather than the business
 * value, and its error branch is a real `Error` instance, so rethrowing it keeps
 * the host's message and code instead of hiding the cause behind a wrapper.
 *
 * @param endpoint - method name, for the diagnostic.
 * @param result - the envelope the gateway returned.
 * @returns the business value.
 */
function unwrapRemote(endpoint, result) {
  if (result === null || typeof result !== 'object') {
    throw new Error(`dsh-memories: ${endpoint} returned no result`)
  }
  if (result.ok === true) return result.value
  const failure = result.error
  if (failure instanceof Error) throw failure
  throw new Error(typeof failure?.message === 'string' ? failure.message : `dsh-memories: ${endpoint} failed`)
}

/**
 * Mount the contribution and resolve the namespace service.
 *
 * The gateway is reached with `ctx.get()` rather than `ctx.remote`: this plugin
 * does not declare the service in `inject`, because a deployment without a
 * gateway must still get the tunables card, and `get` reads the service store
 * without the inject requirement.
 *
 * @param ctx - the browser plugin context.
 * @returns the remote API with unwrapped results, or `undefined` when this
 *   deployment composes no gateway.
 */
async function mountMemoriesRemote(ctx) {
  const remote = ctx.get('remote') ?? ctx.remote
  if (remote === undefined || typeof remote.$mount !== 'function') return undefined
  const dispose = await remote.$mount(clientContribution())
  ctx.effect(() => () => { void dispose() }, 'dsh-memories: remote contribution')
  const namespace = ctx.get(REMOTE_SERVICE_KEY)
  if (namespace === undefined) return undefined
  const api = {}
  for (const invocation of REMOTE_INVOCATION_DATA) {
    api[invocation.method] = async (args) => {
      // The gateway takes one positional value per descriptor parameter and
      // rejects any other count, so the call is mapped by the descriptor's own
      // order. A missing optional value arrives as `undefined`, which the
      // gateway omits from the wire fields and the host's `acceptsUndefined`
      // descriptor allows.
      const supplied = args ?? {}
      const values = invocation.parameters.map((parameter) => supplied[parameter.name])
      const result = await namespace[invocation.method](...values)
      return unwrapRemote(invocation.method, result)
    }
  }
  return api
}
