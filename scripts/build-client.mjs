/**
 * Wrap the hand-written browser half into the DSH client bundle contract.
 *
 * The client module system executes a plugin bundle as a plain script that
 * REGISTERS a lazy CJS factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * So the bundle needs no bundler: this script concatenates `client/parts/*.js`
 * (sorted) and then `client/index.js`, which defines the `createPlugin` the
 * wrapper calls, and wraps the result in that registration. Run by
 * `pnpm build` after `tsc`.
 *
 * The host's wire table is injected as a literal: `src/remote.ts` owns the
 * Remote contract, the browser must agree with it byte for byte, and the
 * compiled host module is the one place it is written.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_INVOCATION_DATA } from '../lib/remote.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const partsDir = join(root, 'client', 'parts')
const target = join(root, 'lib', 'client.js')

const parts = readdirSync(partsDir).filter((name) => name.endsWith('.js')).sort()
  .map((name) => ({ name, body: readFileSync(join(partsDir, name), 'utf8') }))
parts.push({ name: 'index.js', body: readFileSync(join(root, 'client', 'index.js'), 'utf8') })

const indent = (text) => text.split('\n').map((line) => (line.length > 0 ? `    ${line}` : line)).join('\n')
const banner = (name) => `    // ---- client/${name} ----`
const body = [
  `    const REMOTE_INVOCATION_DATA = ${JSON.stringify(REMOTE_INVOCATION_DATA)};`,
  ...parts.map((part) => `${banner(part.name)}\n${indent(part.body)}`),
].join('\n')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-memories",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    return module.exports;
  }
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bundle)
console.log(`client bundle -> ${target} (${bundle.length} bytes, ${parts.length} parts)`)
