// Functional test: real cordis + real SkillRegistry, fake webServer.
// Run: ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" test.mjs
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'

const modules = path.join(os.homedir(), '.dsh', 'profiles', 'node_modules')
register('data:text/javascript,' + encodeURIComponent(`
  import { pathToFileURL } from 'node:url'
  import path from 'node:path'
  const base = ${JSON.stringify(modules)}
  export async function resolve(spec, context, next) {
    if (spec.startsWith('@deepseek-ai/') && !context.parentURL?.includes('/node_modules/')) {
      return next(spec, { ...context, parentURL: pathToFileURL(path.join(base, '_')).href })
    }
    return next(spec, context)
  }`))

const { Context } = await import('@deepseek-ai/cordis')
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
const plugin = await import(pathToFileURL(path.resolve('index.js')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-skill-'))
const routes = new Map()
const ctx = new Context()
ctx.provide('webServer')
ctx.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
ctx.plugin(SkillRegistry)
await new Promise((r) => setTimeout(r, 50))

const skill = (n, d) => ({ name: n, description: d, source: 'runtime', content: 'body ' + n })
ctx.skills.register(skill('alpha-one', 'Does alpha things. More text here.'))
ctx.skills.register(skill('beta-two', 'Beta helper for testing purposes.'))

let changes = 0
ctx.on('skills/change', () => { changes++ })
// Simulate a preset's standing scope that contributes its own skill layer.
const { createScope } = await import('@deepseek-ai/dsh-scope')
const presetKey = { preset: 'standard' }
ctx.plugin({
  name: 'fake-preset',
  inject: ['skills'],
  apply(pctx) {
    const scoped = createScope(pctx, presetKey)
    scoped.ctx.skills.register(skill('gamma-preset', 'Preset-layer skill used for scope tests.'))
  },
})
ctx.provide('agentPresets')
ctx.agentPresets = { standingKeyFor: async () => presetKey, serviceFor: () => undefined }
await new Promise((r) => setTimeout(r, 50))

const fork = ctx.plugin(plugin, { stateFile: path.join(tmp, 'state.json'), summarize: false })
await new Promise((r) => setTimeout(r, 50))

async function call(route, method, body, url = route) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = url
  let status, payload
  const res = { writeHead: (s) => { status = s }, end: (t) => { payload = JSON.parse(t) } }
  await routes.get(route)(req, res)
  return { status, payload }
}
const assert = (cond, msg) => { if (!cond) { console.error('FAIL', msg); process.exitCode = 1 } else console.log('ok  ', msg) }

let r = await call('/dshx-skill-manager/skills', 'GET')
assert(r.status === 200 && r.payload.skills.length === 3, 'lists 3 skills incl. preset layer')
assert((await ctx.skills.list({ scope: presetKey })).some((s) => s.name === 'gamma-preset'), 'preset layer visible via scope')
await call('/dshx-skill-manager/toggle', 'POST', { name: 'gamma-preset', enabled: false })
assert(!(await ctx.skills.list({ scope: presetKey })).some((s) => s.name === 'gamma-preset'), 'preset-layer skill can be disabled')
assert((await ctx.skills.get('gamma-preset', { scope: presetKey })) === undefined, 'preset-layer get hidden')
await call('/dshx-skill-manager/toggle', 'POST', { name: 'gamma-preset', enabled: true })
assert(r.payload.skills.every((s) => s.enabled), 'all enabled initially')

r = await call('/dshx-skill-manager/toggle', 'POST', { name: 'beta-two', enabled: false })
assert(r.status === 200 && r.payload.enabled === false, 'toggle off')
assert((await ctx.skills.list()).map((s) => s.name).join() === 'alpha-one', 'registry list hides disabled')
assert((await ctx.skills.get('beta-two')) === undefined, 'registry get hides disabled')
assert((await ctx.skills.get('alpha-one'))?.content === 'body alpha-one', 'enabled still loads')
r = await call('/dshx-skill-manager/skills', 'GET')
assert(r.payload.skills.length === 3 && r.payload.skills.find((s) => s.name === 'beta-two').enabled === false, 'panel still shows disabled skill')
assert(changes > 0, 'skills/change emitted')
assert(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8')).disabled.includes('beta-two'), 'state persisted')

r = await call('/dshx-skill-manager/toggle', 'POST', { name: '../bad', enabled: false })
assert(r.status === 400, 'rejects bad name')

fork.dispose()
await new Promise((r) => setTimeout(r, 50))
assert((await ctx.skills.list()).length === 2, 'unload restores registry')
assert(routes.size === 0, 'unload removes routes')

assert(plugin.parseSummaryJson('```json\n{"a-b":"做某事"}\n```')['a-b'] === '做某事', 'parses fenced JSON')
fs.rmSync(tmp, { recursive: true, force: true })
