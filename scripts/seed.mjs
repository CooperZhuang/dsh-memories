/**
 * Seed the real `$DSH_HOME/memories` store with one entry per scope, using the
 * plugin's own storage code so the files are exactly what the runtime writes.
 *
 * Usage: node scripts/seed.mjs
 */
import { MemoriesRuntime } from '../lib/index.js'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const memoriesDir = `${resolveDshHome()}/memories`
const ctx = { get: () => undefined, logger: { info: () => undefined, warn: () => undefined, debug: () => undefined } }
const runtime = new MemoriesRuntime(ctx, { memoriesDir, autoExtract: false })
const cwd = process.cwd()
const session = { id: 'seed', header: { version: 0, id: 'seed', createdAt: 0, cwd, isSeeded: false } }

const globalResult = await runtime.write(session, {
  scope: 'global',
  title: 'Prefer pnpm over npm',
  body: 'The user standardizes on pnpm for every JavaScript project; never run `npm install`.',
  tags: ['tooling', 'packages'],
}, 'user')

const projectResult = await runtime.write(session, {
  scope: 'project',
  title: 'dsh-memories plugin layout',
  body: 'TypeScript sources live in src/ and compile to lib/ with `npx tsc -p tsconfig.json`; tests are src/test/*.test.ts run through node --test on the compiled output.',
  tags: ['build', 'layout'],
}, 'user')

console.log('store:', memoriesDir)
console.log('global:', globalResult.action, globalResult.entry.id)
console.log('project:', projectResult.action, projectResult.entry.id)
console.log('summary:\n' + (await runtime.summary(session, false))?.text)
