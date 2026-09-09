/**
 * Wrap the hand-written browser half into the DSH client bundle contract.
 *
 * The client module system executes a plugin bundle as a plain script that
 * REGISTERS a lazy CJS factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * So the bundle needs no bundler: this script wraps `client/index.js` verbatim
 * (CJS, no JSX, only modules the browser static table already provides) in that
 * registration. Run by `pnpm build` after `tsc`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'client', 'index.js')
const target = join(root, 'lib', 'client.js')
const body = readFileSync(source, 'utf8')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-memories",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body.split('\n').map((line) => (line.length > 0 ? `    ${line}` : line)).join('\n')}
    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    return module.exports;
  }
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bundle)
console.log(`client bundle -> ${target} (${bundle.length} bytes)`)
