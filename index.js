// dshx-skill-manager — host half.
//
// Lists every skill the harness registry currently resolves, lets the user
// switch individual skills off, and keeps a short Chinese summary per skill.
//
// Endpoints (behind the Web GUI's own auth):
//   GET  /dshx-skill-manager/skills?cwd=<dir>   catalog + switches + summaries
//   POST /dshx-skill-manager/toggle             { name, enabled }
//   POST /dshx-skill-manager/summarize          { cwd?, force? }
//
// How a switch works: the plugin wraps the registry's `snapshot()` and `get()`
// for its own lifetime. A disabled skill is filtered out of every consumer's
// view — the model-facing catalog (which republishes on the next step), the
// `skill` tool, and user `/skill` invocation. Skill files are never modified,
// and unloading this plugin restores the registry exactly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dshx-skill-manager'
export const inject = ['webServer', 'skills']

export const Config = z.object({
  summarize: z.boolean().default(true).description('Generate short Chinese summaries with the default model.'),
  summaryMaxChars: z.natural().min(10).default(60).description('Target maximum length of one summary.'),
  stateFile: z.string().default('').description('State file; empty uses $DSH_HOME/dshx-skill-manager/state.json.'),
})

const BASE = '/dshx-skill-manager'
const MAX_BODY = 8192
const LLM_TIMEOUT_MS = 120000
const BATCH = 15
const ORIGINAL = Symbol.for('cordis.original')

function errorText(error) {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** Small stable hash so a cached summary is dropped when the description changes. */
function hashText(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/** First sentence of a description, trimmed — used until an AI summary exists. */
function fallbackSummary(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim()
  const match = text.match(/^(.{20,}?[.。!！?？])(\s|$)/)
  const first = match ? match[1] : text
  return first.length > 140 ? first.slice(0, 137) + '…' : first
}

function stateFilePath(config) {
  if (config.stateFile) return config.stateFile
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dshx-skill-manager', 'state.json')
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((n) => typeof n === 'string') : [],
      summaries: raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {},
    }
  } catch {
    return { disabled: [], summaries: {} }
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function lowestEffort(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const ids = efforts.map((e) => e?.id).filter((id) => typeof id === 'string')
  for (const id of ['none', 'minimal', 'low', 'medium', 'high']) if (ids.includes(id)) return id
  return ids[0]
}

/** Pull the first JSON object out of a model reply, tolerating code fences. */
export function parseSummaryJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model reply contains no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1))
  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    summarize: rawConfig.summarize !== false,
    summaryMaxChars: Number.isInteger(rawConfig.summaryMaxChars) ? rawConfig.summaryMaxChars : 60,
    stateFile: typeof rawConfig.stateFile === 'string' ? rawConfig.stateFile : '',
  }
  const file = stateFilePath(config)
  const state = loadState(file)
  const disabled = new Set(state.disabled)
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger

  // ---- registry filter -------------------------------------------------
  // Agent presets may compose their own SkillRegistry instance (behind an
  // isolate realm) besides the host one, so every instance we can reach is
  // wrapped. `list()` delegates to `snapshot()`, so two methods cover all reads.
  const UNFILTERED = Symbol('dshx-skill-manager.unfiltered')
  const patched = new Map()

  function unwrap(service) {
    try { return service?.[ORIGINAL] ?? service } catch { return service }
  }

  function notifyChange() {
    try { ctx.emit('skills/change') } catch (error) { logger?.warn?.('skills/change emit failed: %s', errorText(error)) }
  }

  function patchRegistry(service) {
    const registry = unwrap(service)
    if (!registry || typeof registry.snapshot !== 'function' || patched.has(registry)) return
    const hadSnapshot = Object.hasOwn(registry, 'snapshot')
    const hadGet = Object.hasOwn(registry, 'get')
    const prevSnapshot = registry.snapshot
    const prevGet = registry.get
    registry[UNFILTERED] = (options) => prevSnapshot.call(registry, options)
    registry.snapshot = async function (options) {
      const result = await prevSnapshot.call(this, options)
      if (disabled.size === 0) return result
      return { ...result, skills: result.skills.filter((skill) => !disabled.has(skill.name)) }
    }
    registry.get = async function (skillName, options) {
      if (disabled.has(skillName)) return undefined
      return prevGet.call(this, skillName, options)
    }
    patched.set(registry, () => {
      if (hadSnapshot) registry.snapshot = prevSnapshot
      else delete registry.snapshot
      if (hadGet) registry.get = prevGet
      else delete registry.get
      delete registry[UNFILTERED]
    })
  }

  /** Wrap registries composed by presets of live agents; cheap and idempotent. */
  function discoverRegistries() {
    const agents = ctx.get('agents')
    const presets = ctx.get('agentPresets')
    if (!agents || !presets?.serviceFor) return
    let list = []
    try { list = typeof agents.list === 'function' ? agents.list() : [...(agents.values?.() ?? [])] } catch { list = [] }
    for (const agent of list) {
      try { patchRegistry(presets.serviceFor(agent, 'skills')) } catch { /* agent without a preset registry */ }
    }
  }

  ctx.effect(() => {
    patchRegistry(ctx.skills)
    discoverRegistries()
    notifyChange()
    return () => {
      for (const restore of patched.values()) restore()
      patched.clear()
      notifyChange()
    }
  }, 'dshx-skill-manager registry filter')

  // New agents may bring a preset registry instance with them.
  ctx.on('skills/change', () => { discoverRegistries() })

  /** Unfiltered catalog for this panel: global layer + default preset layer. */
  let lastDebug = {}

  // Agents seen running a step: the exact scope objects the `skill` tool reads with.
  const seenAgents = new Map()
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const id = agent?.session?.header?.id
    if (id) {
      seenAgents.delete(id)
      seenAgents.set(id, new WeakRef(agent))
      if (seenAgents.size > 32) seenAgents.delete(seenAgents.keys().next().value)
    }
    return next()
  })

  function liveAgents() {
    const list = []
    const agents = ctx.get('agents')
    if (agents) {
      try { list.push(...(typeof agents.list === 'function' ? agents.list() : [...(agents.values?.() ?? [])])) } catch { /* ignore */ }
    }
    for (const ref of [...seenAgents.values()].reverse()) {
      const agent = ref.deref()
      if (agent && !list.includes(agent)) list.push(agent)
    }
    return list
  }

  async function fullSnapshot(cwd) {
    const debug = { presets: false, standingKey: false, agents: 0, scopes: [], errors: [] }
    const presets = ctx.get('agentPresets')
    debug.presets = presets !== undefined
    let scope
    let registry = unwrap(ctx.skills)
    if (presets?.standingKeyFor) {
      try { scope = await presets.standingKeyFor(); debug.standingKey = scope !== undefined } catch (error) { debug.errors.push('standingKeyFor: ' + errorText(error)) }
    }
    discoverRegistries()
    const read = registry[UNFILTERED] ?? ((o) => registry.snapshot(o))
    const names = new Set()
    const skills = []
    let complete = true
    const merge = (result, label) => {
      debug.scopes.push(label + ':' + result.skills.length)
      complete = complete && result.complete
      for (const s of result.skills) if (!names.has(s.name)) { names.add(s.name); skills.push(s) }
    }
    const scopes = []
    if (scope) scopes.push(['standing', scope])
    // Each live agent sees its preset layer — read through it exactly like the `skill` tool does.
    const agents = liveAgents()
    debug.agents = agents.length
    for (const agent of agents) {
      const agentCwd = agent?.session?.header?.cwd
      if (cwd && agentCwd && String(agentCwd).toLowerCase() !== String(cwd).toLowerCase()) continue
      scopes.push(['agent', agent])
      if (scopes.length >= 6) break
    }
    scopes.push(['global', undefined])
    for (const [label, key] of scopes) {
      try {
        merge(await read({ ...(cwd ? { cwd } : {}), ...(key ? { scope: key } : {}) }), label)
      } catch (error) { debug.errors.push(label + ': ' + errorText(error)) }
    }
    lastDebug = debug
    for (const other of patched.keys()) {
      if (other === registry) continue
      try {
        const extra = await other[UNFILTERED]({ ...(cwd ? { cwd } : {}) })
        complete = complete && extra.complete
        for (const s of extra.skills) if (!names.has(s.name)) { names.add(s.name); skills.push(s) }
      } catch { /* ignore an unreadable preset registry */ }
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { skills, complete }
  }

  // ---- workspaces ------------------------------------------------------
  async function knownWorkspaces() {
    const result = []
    const seen = new Set()
    const push = (dir) => {
      if (typeof dir !== 'string' || !dir || seen.has(dir.toLowerCase())) return
      seen.add(dir.toLowerCase())
      result.push(dir)
    }
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      try {
        const sessions = await query.listSessions()
        const sorted = [...sessions].filter((r) => r && r.header).sort((a, b) =>
          (b.live === true) - (a.live === true) || (b.header.createdAt || 0) - (a.header.createdAt || 0))
        for (const record of sorted) {
          push(record.header.cwd)
          if (result.length >= 12) break
        }
      } catch (error) {
        logger?.warn?.('listSessions failed: %s', errorText(error))
      }
    }
    push(process.cwd())
    return result
  }

  function describe(skill) {
    const cached = state.summaries[skill.name]
    const hash = hashText(skill.description + '\n' + (skill.whenToUse || ''))
    const fresh = cached && cached.hash === hash ? cached.text : undefined
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      source: skill.source,
      provider: skill.provider,
      path: skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined,
      modelInvocable: skill.invocation?.modelInvocable !== false,
      userInvocable: skill.invocation?.userInvocable !== false,
      enabled: !disabled.has(skill.name),
      summary: fresh ?? fallbackSummary(skill.description),
      summaryKind: fresh ? 'ai' : 'excerpt',
      hash,
    }
  }

  // ---- AI summaries ----------------------------------------------------
  let summarizing = null

  async function summarizeBatch(llm, selection, items) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      let info
      try { info = await llm.resolveModelInfo(selection.provider, selection.model, controller.signal) } catch { info = undefined }
      const effort = lowestEffort(info)
      const maxTokens = Math.min(4096, Number(info?.maxOutputTokens) || 4096)
      const listing = items.map((s) => ({ name: s.name, description: s.description.slice(0, 1200), whenToUse: s.whenToUse?.slice(0, 400) }))
      const prompt = 'Below is a JSON list of agent skills. For EACH skill, write one plain Simplified-Chinese sentence '
        + `(at most ${config.summaryMaxChars} Chinese characters) telling a user what the skill does. `
        + 'Return ONLY a JSON object mapping each exact skill name to its summary, no markdown.\n\n'
        + JSON.stringify(listing)
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        system: 'You write concise Chinese one-line summaries of software tool descriptions. Output JSON only.',
        messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: name } })],
        maxTokens,
        signal: controller.signal,
      })) assembler.push(chunk)
      const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text || '').join('')
      if (assembler.finish?.kind !== 'stop' && !text.includes('}')) {
        throw new Error('model finished with ' + (assembler.finish?.kind || 'no result'))
      }
      return parseSummaryJson(text)
    } finally {
      clearTimeout(timer)
    }
  }

  async function summarize(cwd, force) {
    if (!config.summarize) throw new Error('AI 概述已在配置中关闭')
    const llm = ctx.get('llm')
    const defaults = ctx.get('agentDefaultModel')
    if (llm === undefined) throw new Error('LLM 服务不可用')
    const selection = defaults?.currentSelection?.()
    if (!selection?.provider || !selection?.model) throw new Error('没有可用的默认模型')
    const { skills } = await fullSnapshot(cwd)
    const pending = skills.map(describe).filter((s) => force || s.summaryKind !== 'ai')
    let done = 0
    const errors = []
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH)
      try {
        const result = await summarizeBatch(llm, selection, batch)
        for (const item of batch) {
          const text = result[item.name]
          if (typeof text === 'string') {
            state.summaries[item.name] = { hash: item.hash, text: text.slice(0, config.summaryMaxChars * 3) }
            done += 1
          }
        }
        saveState(file, { disabled: [...disabled], summaries: state.summaries })
      } catch (error) {
        errors.push(errorText(error))
      }
    }
    return { requested: pending.length, done, errors, model: selection.provider + '/' + selection.model }
  }

  // ---- routes ----------------------------------------------------------
  function sender(res) {
    return (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/skills',
    handler: async (req, res) => {
      const send = sender(res)
      if ((req.method ?? 'GET') !== 'GET') return send(405, { error: 'method not allowed' })
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const workspaces = await knownWorkspaces()
        const cwd = url.searchParams.get('cwd') || workspaces[0] || undefined
        const snapshot = await fullSnapshot(cwd)
        const described = snapshot.skills.map(describe)
        // Fill missing summaries in the background so newly seen skills get one automatically.
        if (config.summarize && summarizing === null && described.some((s) => s.summaryKind !== 'ai')) {
          summarizing = summarize(cwd, false)
            .catch((error) => { logger?.warn?.('auto summarize failed: %s', errorText(error)) })
            .finally(() => { summarizing = null })
        }
        const skills = described.map(({ hash, ...rest }) => rest)
        return send(200, {
          cwd,
          workspaces,
          complete: snapshot.complete,
          skills,
          summarizing: summarizing !== null,
          summarizeEnabled: config.summarize,
          debug: lastDebug,
          version: '1.0.3',
          at: Date.now(),
        })
      } catch (error) {
        return send(500, { error: errorText(error) })
      }
    },
  }), 'dshx-skill-manager-list')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/toggle',
    handler: async (req, res) => {
      const send = sender(res)
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (typeof body.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.name)) return send(400, { error: 'invalid skill name' })
        if (typeof body.enabled !== 'boolean') return send(400, { error: 'enabled must be boolean' })
        if (body.enabled) disabled.delete(body.name)
        else disabled.add(body.name)
        saveState(file, { disabled: [...disabled], summaries: state.summaries })
        notifyChange()
        return send(200, { name: body.name, enabled: !disabled.has(body.name), disabled: [...disabled] })
      } catch (error) {
        return send(400, { error: errorText(error) })
      }
    },
  }), 'dshx-skill-manager-toggle')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/summarize',
    handler: async (req, res) => {
      const send = sender(res)
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (summarizing === null) {
          summarizing = summarize(typeof body.cwd === 'string' ? body.cwd : undefined, body.force === true)
            .finally(() => { summarizing = null })
        }
        return send(200, await summarizing)
      } catch (error) {
        return send(500, { error: errorText(error) })
      }
    },
  }), 'dshx-skill-manager-summarize')
}
