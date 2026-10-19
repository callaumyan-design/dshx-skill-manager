// Integration check: real SkillRegistry + real skill-filesystem provider mounted
// in a preset-like scope, exactly like the "standard" agent preset does.
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
    if (!spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('file:') && !spec.startsWith('data:') && !context.parentURL?.includes('/node_modules/')) {
      return next(spec, { ...context, parentURL: pathToFileURL(path.join(base, '_')).href })
    }
    return next(spec, context)
  }`))

const { Context } = await import('@deepseek-ai/cordis')
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')
const plugin = await import(pathToFileURL(path.resolve('index.js')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-skill-'))
const routes = new Map()
const ctx = new Context()
ctx.provide('webServer')
ctx.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
ctx.plugin(SkillRegistry)
await new Promise((r) => setTimeout(r, 50))

const presetKey = { preset: 'standard' }
ctx.plugin({
  name: 'fake-standard-preset',
  inject: ['skills'],
  apply(pctx) {
    const scoped = createScope(pctx, presetKey)
    scoped.ctx.plugin(fsProvider, { watch: false, dshHome: path.join(os.homedir(), '.dsh'), agentsHome: path.join(os.homedir(), '.agents') })
  },
})
ctx.provide('agentPresets')
ctx.agentPresets = { standingKeyFor: async () => presetKey, serviceFor: () => undefined }
ctx.plugin(plugin, { stateFile: path.join(tmp, 'state.json'), summarize: false })
await new Promise((r) => setTimeout(r, 300))

const req = Readable.from([])
req.method = 'GET'
req.url = '/dshx-skill-manager/skills?cwd=' + encodeURIComponent(process.env.SKILLS_CWD ?? process.cwd())
let payload
await routes.get('/dshx-skill-manager/skills')(req, { writeHead() {}, end: (t) => { payload = JSON.parse(t) } })
if (payload.error) { console.error('ERROR', payload.error); process.exit(1) }
console.log('count=' + payload.skills.length + ' complete=' + payload.complete)
for (const s of payload.skills) console.log(s.name.padEnd(28), s.source.padEnd(15), s.summary.slice(0, 60))
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
