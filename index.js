// DASH — Deepseek Agentic Service Harness (terminal edition).
//
// oh-my-pi TUI/CLI usage logic on the DeepSeek Harness agent kernel:
// the plugin creates a real DSH Agent through the official factory, drives
// turns through agent.followup / agent.cancel / agent.steer, renders the
// session/event firehose in a raw-ANSI full-screen TUI, and implements the
// oh-my-pi keybinding inventory (remappable via ~/.dash/keybindings.yml).
//
// Launch:  dsh --profile dash          (or the `dash` launcher script)

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { KeyParser, buildKeyMap, keyId, kittyPushRequest, DEFAULT_ACTION_KEYS, ACTIONS } from './keys.js'
import { Draft } from './editor.js'
import { renderMarkdown } from './markdown.js'
import { loadKeybindingsConfig, loadConfig, saveConfig, getCfg, setCfg, loadRules } from './config.js'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dash-tui'
export const inject = ['agents']
export function apply(ctx, config = {}) {
  const llm = ctx.get('llm')
  const adm = ctx.get('agentDefaultModel')
  const commands = ctx.get('commands')
  const planModeSvc = ctx.get('planMode')
  // note: session* services register asynchronously during concurrent row
  // activation, so they are fetched at use time, never at apply time.

  const keyMap = buildKeyMap(loadKeybindingsConfig())

  // ── terminal ────────────────────────────────────────────────────────────
  const out = process.stdout
  const tin = process.stdin
  let W = out.columns || 100
  let H = out.rows || 30
  let kittyMode = false

  function charWidth(ch) {
    const c = ch.codePointAt(0)
    if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) return 2
    return 1
  }
  function strWidth(s) {
    let w = 0
    for (const ch of s) w += charWidth(ch)
    return w
  }
  function wrapTo(s, width) {
    const lines = []
    let cur = ''
    let curW = 0
    for (const ch of s) {
      const w = charWidth(ch)
      if (curW + w > width) {
        lines.push(cur)
        cur = ''
        curW = 0
      }
      cur += ch
      curW += w
    }
    lines.push(cur)
    return lines
  }
  function truncate(s, width) {
    let cur = ''
    let w = 0
    for (const ch of s) {
      const cw = charWidth(ch)
      if (w + cw > width) return cur + '…'
      cur += ch
      w += cw
    }
    return cur
  }
  function padRight(s, width) {
    const w = strWidth(s)
    return w >= width ? s : s + ' '.repeat(width - w)
  }

  const cfg = loadConfig()

  // ── theme ────────────────────────────────────────────────────────────────
  const THEMES = {
    dark: { name: 'dark', fg: 254, dim: 245, accent: 78, green: 121, blue: 117, yellow: 222, amber: 229, red: 203, purple: 141, cyan: 81 },
    light: { name: 'light', fg: 237, dim: 244, accent: 29, green: 28, blue: 25, yellow: 130, amber: 94, red: 124, purple: 91, cyan: 30 },
  }
  let C = {}
  const fg256 = (n) => '\x1b[38;5;' + n + 'm'
  function applyTheme() {
    const t = THEMES[cfg.theme && cfg.theme.light ? 'light' : 'dark'] || THEMES.dark
    C.reset = '\x1b[0m'
    C.dim = fg256(t.dim)
    C.green = fg256(t.green)
    C.bright = fg256(t.accent)
    C.blue = fg256(t.blue)
    C.yellow = fg256(t.yellow)
    C.amber = fg256(t.amber)
    C.red = fg256(t.red)
    C.purple = fg256(t.purple)
    C.cyan = fg256(t.cyan)
    C.italic = '\x1b[3m'
    C.bold = '\x1b[1m'
    try { dirty = true } catch (e) { /* dirty declared later */ }
  }

  const SETTINGS_SCHEMA = [
    { key: 'theme.light', type: 'bool', desc: '浅色主题' },
    { key: 'activity.frames', type: 'enum', options: ['claude', 'dots', 'moon', 'arrows', 'line'], desc: 'spinner 帧预设' },
    { key: 'startup.quiet', type: 'bool', desc: '静默启动' },
  ]

  // ── state ───────────────────────────────────────────────────────────────
  let rows = []
  const draft = new Draft()
  let busy = false
  let streaming = null
  let usage = { in: 0, out: 0 }
  let displayModel = { provider: '', model: '' }
  let temporaryModel = null
  let scroll = 0
  let following = true
  let dirty = true
  applyTheme()
  let tick = 0
  let queue = []
  let history = []
  let helpOpen = false
  let exitConfirm = false
  let showReasoning = true
  let verboseTools = false
  let showTools = true
  let picker = null
  let histSearch = null
  let cmdMenu = null
  let pasteBuf = null
  let jumpChar = null
  let statusText = ''
  let statusColor = null
  let agent = null
  let handle = null
  let bootTries = 0
  let lastUserText = ''
  let lastTurnFailed = false
  let turnTools = 0
  let turnStartedAt = 0
  let sessionTitle = ''
  let rewind = null
  let lastEscAt = 0
  let activity = null // {phase, label, startedAt}

  // ── batch-5 features ─────────────────────────────────────────────────────
  let hub = null            // agent hub panel {entries, idx, view, detailId, steer, q}
  let hubEntries = []       // [{id, depth, label, mode, activity, hasChildren}]
  let rules = loadRules()   // TTSR rules
  let injectedRules = new Set()
  let streamText = ''       // accumulated text for TTSR matching
  let advisorEnabled = !!getCfg(cfg, 'advisor.enabled', false)
  let hubSteerText = ''

  // ── metrics (status line) ────────────────────────────────────────────────
  let contextWindow = 0
  let reasoningTotal = 0
  let cacheReadTotal = 0
  let tpsNow = 0
  let tpsSamples = []
  let tpsBuf = { chars: 0, start: 0 }
  let gitBranch = ''
  let gitCheckedAt = 0
  let currentRole = 'default'
  const ROLE_NAMES = ['default', 'smol', 'plan', 'task']
  const roles = { default: null, smol: null, plan: null, task: null }
  {
    const mr = cfg.modelRoles
    if (mr && typeof mr === 'object') {
      for (const name of ROLE_NAMES) {
        const v = mr[name]
        if (typeof v === 'string' && v.includes('/')) {
          const [p, m] = v.split(':')[0].split('/')
          const eff = v.includes(':') ? v.split(':')[1] : undefined
          if (p && m) roles[name] = { provider: p, model: m, reasoningEffort: eff }
        }
      }
    }
  }
  const SPINNERS = {
    claude: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    dots: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
    moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    line: ['─', '\\', '|', '/'],
  }
  const spinnerName = (cfg.activity && cfg.activity.frames) || 'claude'
  const spinner = SPINNERS[spinnerName] || SPINNERS.claude
  const thinkPhrases = ['嗯…让我捋捋', '想想怎么回', '组织一下语言', '分析中…', '深度思考中']
  const selection = { current: undefined, assembled: undefined }

  function setStatus(text, color) {
    statusText = text
    statusColor = color || null
    dirty = true
  }

  // ── agent ───────────────────────────────────────────────────────────────
  async function boot(isNew) {
    if (isNew) rows = []
    let provider = config.provider || process.env.DASH_PROVIDER
    let model = config.model || process.env.DASH_MODEL
    if (adm) {
      try {
        const s = adm.currentSelection()
        if (!provider && s.provider) provider = s.provider
        if (!model && s.model) model = s.model
      } catch (e) { /* ignore */ }
    }
    if (llm) {
      let provs = []
      try { provs = llm.listProviders() } catch (e) { /* ignore */ }
      if (!provider && provs.length) provider = provs[0].id
      if (provider && provs.some((p) => p.id === provider)) {
        try {
          const ms = await llm.listModels(provider)
          if (ms.length && (!model || !ms.some((m) => m.id === model))) model = ms[0].id
        } catch (e) { /* ignore */ }
      }
    }
    if (!provider || !model) {
      if (bootTries < 10) {
        bootTries++
        setTimeout(() => boot(isNew), 2000)
        return
      }
      rows.push({ kind: 'notice', text: '✗ no model configured — set DASH_PROVIDER / DASH_MODEL or patch agent-default-model' })
      dirty = true
      return
    }
    bootTries = 0
    const sessionId = 'dash-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    let created = false
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      try {
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: config.cwd || process.cwd() },
          agentOptions: { provider, model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, selection)
          },
        })
        created = true
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (msg.includes('agent factory')) {
          await sleep(1000)
          continue
        }
        throw e
      }
    }
    if (!created) throw new Error('agent factory never became available')
    agent = handle.agent
    selection.current = { provider, model }
    displayModel = { provider, model }
    usage = { in: 0, out: 0 }
    refreshGitBranch()
    rows.push({ kind: 'notice', text: 'DASH v0.2.0 — oh-my-pi usage · DSH kernel · ' + provider + '/' + model + ' · /help' })
    dirty = true
  }

  function textOf(blocks) {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) if (b && b.type === 'text') parts.push(b.text)
    return parts.join('\n')
  }
  function reasoningOf(blocks) {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) if (b && b.type === 'reasoning') parts.push(b.text)
    return parts.join('\n')
  }

  function onSessionEvent(session, event) {
    if (!agent || session.id !== agent.id) return
    const d = event.data || {}
    switch (event.type) {
      case 'turn/start':
        busy = true
        streaming = null
        turnTools = 0
        turnStartedAt = Date.now()
        activity = { phase: 'thinking', startedAt: Date.now() }
        break
      case 'user/message':
        if (d.source && d.source.kind === 'user') {
          rows.push({ kind: 'user', text: textOf(d.content), seq: event.seq, ts: event.time })
          dirty = true
        }
        break
      case 'assistant/chunk': {
        const c = d.chunk
        if (!streaming) {
          rows.push({ kind: 'assistant', text: '', reasoning: '', usage: null, streaming: true, error: null })
          streaming = { rowIdx: rows.length - 1 }
          activity = { phase: 'thinking', startedAt: Date.now() }
        }
        const row = rows[streaming.rowIdx]
        if (c.type === 'text-delta') {
          row.text += c.text
          streamText += c.text
          if (rules.length) checkRules()
          // TPS tracking
          const now = Date.now()
          if (!tpsBuf.start) tpsBuf = { chars: 0, start: now }
          tpsBuf.chars += c.text.length
          const elapsed = now - tpsBuf.start
          if (elapsed >= 400) {
            tpsNow = Math.round((tpsBuf.chars / elapsed) * 1000)
            tpsSamples.push(tpsNow)
            if (tpsSamples.length > 24) tpsSamples.shift()
            tpsBuf = { chars: 0, start: now }
          }
        } else if (c.type === 'reasoning-delta') {
          row.reasoning += c.text
        } else if (c.type === 'usage') {
          row.usage = c.usage
          reasoningTotal += c.usage.reasoningTokens || 0
          cacheReadTotal += c.usage.cacheReadTokens || 0
        } else if (c.type === 'finish' && c.reason && c.reason.kind === 'error') {
          row.error = (c.reason.failure && c.reason.failure.message) || 'model error'
        }
        dirty = true
        break
      }
      case 'assistant/message': {
        const m = d.message
        if (streaming && rows[streaming.rowIdx] && rows[streaming.rowIdx].streaming) {
          const row = rows[streaming.rowIdx]
          row.text = textOf(m.content) || row.text
          row.reasoning = reasoningOf(m.content) || row.reasoning
          row.usage = d.usage || row.usage
          if (row.usage) {
            usage.in += row.usage.inputTokens || 0
            usage.out += row.usage.outputTokens || 0
          }
          row.streaming = false
          row.meta = fmtMeta(event.time, turnStartedAt)
          if (row.usage) {
            reasoningTotal += row.usage.reasoningTokens || 0
            cacheReadTotal += row.usage.cacheReadTokens || 0
          }
        }
        streaming = null
        dirty = true
        break
      }
      case 'tool/call':
        rows.push({ kind: 'tool', callId: d.callId, name: d.name, args: d.arguments, status: 'running', summary: null, error: null })
        turnTools++
        activity = { phase: 'tool', label: d.name, startedAt: Date.now() }
        dirty = true
        break
      case 'tool/result': {
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]
          if (r.kind === 'tool' && r.callId === d.callId) {
            r.status = d.error ? 'error' : 'ok'
            r.error = d.error ? d.error.name : null
            const t = textOf(d.message && d.message.content)
            r.summary = t ? truncate(t.replace(/\s+/g, ' ').trim(), 140) : null
            break
          }
        }
        activity = { phase: 'thinking', startedAt: Date.now() }
        dirty = true
        break
      }
      case 'step/end':
        dirty = true
        break
      case 'turn/end': {
        const reason = d.reason || {}
        busy = false
        streaming = null
        // flush residual TPS sample
        if (tpsBuf.chars > 0) {
          const now = Date.now()
          const elapsed = now - tpsBuf.start
          if (elapsed > 0) {
            tpsNow = Math.round((tpsBuf.chars / elapsed) * 1000)
            tpsSamples.push(tpsNow)
            if (tpsSamples.length > 24) tpsSamples.shift()
          }
          tpsBuf = { chars: 0, start: 0 }
        }
        lastTurnFailed = reason.kind === 'error' || reason.kind === 'max-tokens' || reason.kind === 'failed'
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          rows.push({ kind: 'notice', text: '⏹ interrupted' })
        } else if (lastTurnFailed) {
          const msg = (reason.error && reason.error.message) || (reason.failure && reason.failure.message) || reason.kind
          rows.push({ kind: 'notice', text: '✗ turn ended: ' + msg })
        }
        activity = { phase: 'done', startedAt: turnStartedAt }
        dirty = true
        if (queue.length) {
          const next = queue.shift()
          setTimeout(() => submitDraftWith(next), 60)
        }
        if (!lastTurnFailed && getCfg(cfg, 'notify.turnEnd', true) !== false) {
          try { out.write('\x07') } catch (e) { /* ignore */ }
        }
        if (reason.kind === 'completed') advisorNote()
        break
      }
      case 'request/context':
        displayModel = { provider: d.provider, model: d.model }
        contextWindow = d.contextWindow || contextWindow
        dirty = true
        break
      case 'session/title':
        if (d.title) sessionTitle = d.title
        dirty = true
        break
      default:
        if (typeof event.type === 'string' && event.type.startsWith('compaction/')) {
          rows.push({ kind: 'notice', text: event.type === 'compaction/start' ? '🧹 上下文压缩中…' : '🧹 压缩完成' })
          dirty = true
        }
        break
    }
    if (following) scroll = 0
  }
  ctx.on('session/event', onSessionEvent)

  function fmtMeta(ts, turnStart) {
    const t = new Date(ts || Date.now())
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    const dur = turnStart ? Math.max(1, Math.round((ts - turnStart) / 1000)) : 0
    const model = displayModel.provider ? displayModel.provider + '/' + displayModel.model : ''
    return hh + ':' + mm + ':' + ss + (dur ? ' · ' + dur + 's' : '') + (model ? ' · ' + model : '')
  }

  // ── metrics helpers ──────────────────────────────────────────────────────
  function fmtTokens(v) {
    if (!v) return '0'
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
    return String(v)
  }

  function contextBar(width) {
    const total = usage.in + usage.out
    const cap = contextWindow || 1000000
    const pct = cap ? Math.min(100, (total / cap) * 100) : 0
    const W = Math.max(6, width)
    const segIn = Math.round((usage.in / cap) * W)
    const segThink = Math.round((reasoningTotal / cap) * W)
    const segOut = Math.round(((usage.out - reasoningTotal) / cap) * W)
    let s = ''
    let used = 0
    if (segIn > 0) { s += C.blue + '█'.repeat(Math.min(segIn, W)) + C.reset; used = segIn }
    if (segThink > 0 && used < W) { s += C.purple + '█'.repeat(Math.min(segThink, W - used)) + C.reset; used += Math.min(segThink, W - used) }
    if (segOut > 0 && used < W) { s += C.green + '█'.repeat(Math.min(segOut, W - used)) + C.reset; used += Math.min(segOut, W - used) }
    if (used < W) s += C.dim + '░'.repeat(W - used) + C.reset
    return '▏' + s + '▕ ' + C.dim + 'ctx ' + fmtTokens(total) + '/' + fmtTokens(cap) + ' ' + pct.toFixed(1) + '%' + C.reset
  }

  function sparkline() {
    if (!tpsSamples.length) return ''
    const max = Math.max(...tpsSamples, 1)
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
    let s = ''
    for (const v of tpsSamples.slice(-24)) {
      s += glyphs[Math.min(7, Math.floor((v / max) * 8))] || '▁'
    }
    return s
  }

  function refreshGitBranch() {
    const now = Date.now()
    if (now - gitCheckedAt < 30000) return
    gitCheckedAt = now
    try {
      execFile('git', ['branch', '--show-current'], { cwd: config.cwd || process.cwd(), timeout: 3000 }, (err, stdout) => {
        if (err) { gitBranch = ''; return }
        gitBranch = stdout.trim() || '(detached)'
        dirty = true
      })
    } catch (e) { /* ignore */ }
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function sendText(t) {
    const text = String(t).trim()
    if (!text) return
    if (text.charAt(0) === '/') { runCommand(text); return }
    if (!agent) { setStatus('✗ agent not ready', C.red); return }
    if (busy) {
      queue.push(text)
      draft.text = ''
      draft.cursor = 0
      setStatus('queued follow-up (' + queue.length + ')', C.yellow)
      return
    }
    history = [text].concat(history).slice(0, 200)
    lastUserText = text
    draft.text = ''
    draft.cursor = 0
    draft.undoStack = []
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    setStatus('')
    dirty = true
  }

  function submitDraft() {
    sendText(draft.text)
  }

  function submitDraftWith(text) {
    sendText(text)
  }

  function queueFollowUp() {
    const t = draft.text.trim()
    if (!t) { setStatus('empty prompt', C.yellow); return }
    if (busy) {
      queue.push(t)
      draft.text = ''
      draft.cursor = 0
      setStatus('queued follow-up (' + queue.length + ')', C.yellow)
    } else {
      sendText(t)
    }
  }

  function dequeue() {
    if (!queue.length) { setStatus('nothing queued', C.yellow); return }
    const t = queue.pop()
    draft.text = (draft.text ? draft.text + '\n' : '') + t
    draft.cursor = draft.text.length
    setStatus('dequeued')
  }

  function cancelRun() {
    if (agent && busy) {
      try { agent.cancel({ kind: 'user' }) } catch (e) { /* ignore */ }
      setStatus('stopping…', C.yellow)
    }
  }

  function clearScreen() {
    rows = []
    scroll = 0
    following = true
    setStatus('')
  }

  function setModel(provider, model) {
    if (!provider || !model) return
    selection.current = { provider, model }
    displayModel = { provider, model }
    setStatus('model → ' + provider + '/' + model, C.green)
    dirty = true
  }

  async function cycleModel(dir) {
    if (!agent || !llm) return
    const prov = displayModel.provider
    try {
      const ms = await llm.listModels(prov)
      if (!ms.length) { setStatus('no models for ' + prov, C.red); return }
      let idx = ms.findIndex((m) => m.id === displayModel.model)
      if (idx < 0) idx = 0
      const m = ms[(idx + dir + ms.length) % ms.length]
      setModel(prov, m.id)
    } catch (e) {
      setStatus('✗ ' + ((e && e.message) || e), C.red)
    }
  }

  async function cycleThinking() {
    if (!agent || !llm) return
    try {
      const info = await llm.resolveModelInfo(displayModel.provider, displayModel.model)
      const efforts = (info.reasoning && info.reasoning.efforts) || []
      if (!efforts.length) { setStatus('no thinking levels for this model', C.yellow); return }
      const cur = selection.current && selection.current.reasoningEffort
      let idx = cur ? efforts.findIndex((e) => e.id === cur) : -1
      const next = efforts[(idx + 1) % efforts.length]
      selection.current = { provider: displayModel.provider, model: displayModel.model, reasoningEffort: next.id }
      setStatus('thinking → ' + next.name, C.green)
    } catch (e) {
      setStatus('✗ ' + ((e && e.message) || e), C.red)
    }
  }

  function roleAssignment(name) {
    const r = roles[name]
    if (r) return r
    return displayModel.provider ? { provider: displayModel.provider, model: displayModel.model } : null
  }

  function applyRole(name) {
    const r = roleAssignment(name)
    if (!r) return
    currentRole = name
    const sel = { provider: r.provider, model: r.model }
    if (r.reasoningEffort) sel.reasoningEffort = r.reasoningEffort
    selection.current = sel
    displayModel = { provider: r.provider, model: r.model }
    setStatus('角色 → ' + name + ' · ' + r.provider + '/' + r.model, C.green)
    dirty = true
  }

  function persistRoles() {
    const out = {}
    for (const name of ROLE_NAMES) {
      const r = roles[name]
      if (r) out[name] = r.provider + '/' + r.model + (r.reasoningEffort ? ':' + r.reasoningEffort : '')
    }
    saveConfig({ ...cfg, modelRoles: out })
  }

  async function openPicker(temp) {
    if (!llm) return
    let providers = []
    try { providers = llm.listProviders() } catch (e) { /* ignore */ }
    if (!providers.length) { setStatus('✗ no providers', C.red); return }
    const cur = roleAssignment(currentRole) || displayModel
    let roleIdx = Math.max(0, ROLE_NAMES.indexOf(currentRole))
    let provIdx = providers.findIndex((p) => p.id === (cur && cur.provider))
    if (provIdx < 0) provIdx = 0
    picker = { roles: ROLE_NAMES, roleIdx, providers, provIdx, models: [], modelIdx: 0, focus: temp ? 'prov' : 'role', temp: !!temp }
    dirty = true
    loadPickerModels(provIdx, cur && cur.model)
  }

  function loadPickerModels(provIdx, preferModel) {
    if (!llm || !picker) return
    llm.listModels(picker.providers[provIdx].id).then((ms) => {
      if (!picker || picker.provIdx !== provIdx) return
      picker.models = ms || []
      picker.modelIdx = 0
      const pref = preferModel || (displayModel.model && picker.roles[picker.roleIdx] === currentRole ? displayModel.model : null)
      if (pref) {
        const i = picker.models.findIndex((m) => m.id === pref)
        if (i >= 0) picker.modelIdx = i
      }
      dirty = true
    }).catch(() => { /* ignore */ })
  }

  function pickerSelect() {
    const p = picker
    const prov = p.providers[p.provIdx]
    const m = p.models[p.modelIdx]
    if (!prov || !m) { picker = null; dirty = true; return }
    if (p.temp) {
      temporaryModel = { provider: prov.id, model: m.id }
      selection.current = { provider: prov.id, model: m.id }
      displayModel = { provider: prov.id, model: m.id }
      setStatus('temp model → ' + prov.id + '/' + m.id, C.green)
    } else {
      const roleName = p.roles[p.roleIdx]
      roles[roleName] = { provider: prov.id, model: m.id, reasoningEffort: roles[roleName] ? roles[roleName].reasoningEffort : undefined }
      persistRoles()
      currentRole = roleName
      selection.current = { provider: prov.id, model: m.id }
      if (roles[roleName].reasoningEffort) selection.current.reasoningEffort = roles[roleName].reasoningEffort
      displayModel = { provider: prov.id, model: m.id }
      setStatus('角色 ' + roleName + ' → ' + prov.id + '/' + m.id, C.green)
    }
    picker = null
    dirty = true
  }

  async function runCommand(line) {
    draft.text = ''
    draft.cursor = 0
    const parts = line.slice(1).split(/\s+/)
    const cmd = (parts[0] || '').toLowerCase()
    const arg = parts.slice(1).join(' ')
    if (cmd === 'help') { helpOpen = true; dirty = true; return }
    if (cmd === 'clear') { clearScreen(); return }
    if (cmd === 'models') { openPicker(false); return }
    if (cmd === 'new') { await newSession(); return }
    if (cmd === 'exit' || cmd === 'quit') { exitDash(0); return }
    if (cmd === 'model') {
      const i = arg.indexOf('/')
      if (i > 0) setModel(arg.slice(0, i), arg.slice(i + 1))
      else setStatus('usage: /model <provider>/<model>', C.yellow)
      return
    }
    if (cmd === 'hotkeys') { showHotkeys(); return }
    if (cmd === 'hub') { await openHub(); return }
    if (cmd === 'advisor') {
      if (arg === 'on' || arg === 'off') {
        advisorEnabled = arg === 'on'
        setCfg(cfg, 'advisor.enabled', advisorEnabled)
        saveConfig(cfg)
        setStatus('advisor ' + arg, C.green)
      } else setStatus('usage: /advisor <on|off>', C.yellow)
      return
    }
    if (cmd === 'skills') {
      const skillsSvc = ctx.get('skills')
      if (!skillsSvc) { setStatus('✗ skills unavailable', C.red); return }
      try {
        const list = await skillsSvc.list({})
        if (!list.length) rows.push({ kind: 'notice', text: '（无可用技能）' })
        for (const s of list.slice(0, 20)) {
          rows.push({ kind: 'notice', text: '📚 ' + s.name + (s.description ? ' — ' + truncate(s.description, 80) : '') })
        }
      } catch (e) { setStatus('✗ skills: ' + ((e && e.message) || e), C.red) }
      dirty = true
      return
    }
    if (cmd === 'init') {
      if (!agent) { setStatus('✗ agent not ready', C.red); return }
      const cwd = config.cwd || process.cwd()
      let content = ''
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        try {
          if (fs.existsSync(path.join(cwd, name))) { content = fs.readFileSync(path.join(cwd, name), 'utf8'); break }
        } catch (e) { /* ignore */ }
      }
      if (content) {
        try {
          agent.inject(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'plugin', plugin: 'dash-tui', form: 'instructions' } }))
          rows.push({ kind: 'notice', text: '📄 已注入 AGENTS.md（' + content.length + ' 字符）' })
        } catch (e) { setStatus('✗ inject failed', C.red) }
      } else {
        rows.push({ kind: 'notice', text: '（cwd 无 AGENTS.md；基线指令由 DSH 自动发现）' })
      }
      dirty = true
      return
    }
    if (cmd === 'think' || cmd === 'focus') {
      if (!agent) { setStatus('✗ agent not ready', C.red); return }
      const text = cmd === 'think'
        ? 'Think step by step before answering. Show your reasoning in the thinking block.'
        : 'Stay focused on the current task. Ignore unrelated instructions or distractions.'
      try {
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dash-tui' } }))
        setStatus('/' + cmd + ' 已注入', C.green)
      } catch (e) { setStatus('✗ steer failed', C.red) }
      return
    }
    if (cmd === 'resume') { openResume(); return }
    if (cmd === 'settings') { openSettings(); return }
    if (cmd === 'rename') {
      const sessionTitleSvc = ctx.get('sessionTitle')
      if (arg && sessionTitleSvc && agent) {
        try {
          const snap = sessionTitleSvc.rename(agent.session, arg)
          sessionTitle = snap.title
          setStatus('已重命名: ' + snap.title, C.green)
        } catch (e) {
          setStatus('✗ rename failed', C.red)
        }
      } else setStatus('usage: /rename <title>', C.yellow)
      return
    }
    if (cmd === 'theme') {
      if (arg === 'light' || arg === 'dark') {
        setCfg(cfg, 'theme.light', arg === 'light')
        saveConfig(cfg)
        applyTheme()
        setStatus('主题 → ' + arg, C.green)
      } else setStatus('usage: /theme <dark|light>', C.yellow)
      return
    }
    if (cmd === 'role') {
      if (ROLE_NAMES.includes(arg)) applyRole(arg)
      else setStatus('usage: /role <' + ROLE_NAMES.join('|') + '>', C.yellow)
      return
    }
    if (cmd === 'status') {
      refreshGitBranch()
      const cachePct = cacheReadTotal + usage.in ? Math.round((cacheReadTotal / (cacheReadTotal + usage.in)) * 100) : 0
      setStatus('角色 ' + currentRole + ' · ' + displayModel.provider + '/' + displayModel.model +
        ' · in ' + usage.in + ' · out ' + usage.out +
        (reasoningTotal ? ' · think ' + reasoningTotal : '') +
        (cacheReadTotal ? ' · 缓存 ' + cachePct + '%' : '') +
        (contextWindow ? ' · ctx ' + fmtTokens(usage.in + usage.out) + '/' + fmtTokens(contextWindow) : '') +
        (gitBranch ? ' · git:' + gitBranch : ''), C.green)
      return
    }
    if (cmd === 'plan') { planToggle(); return }
    // delegate to the DSH command registry (/plan /goal /compact …)
    if (commands && agent) {
      try {
        const res = await commands.execute(agent, line, AbortSignal.timeout(90000))
        if (res && res.output) rows.push({ kind: 'notice', text: truncate(String(res.output).replace(/\s+/g, ' ').trim(), 200) })
        dirty = true
        return
      } catch (e) { /* fall through */ }
    }
    setStatus('unknown command /' + cmd + ' — try /help', C.red)
  }

  function planToggle() {
    if (!planModeSvc || !agent) { setStatus('plan mode unavailable', C.yellow); return }
    const cur = planModeSvc.get(agent)
    const res = planModeSvc.set(agent, !(cur && cur.active))
    setStatus(res === 'committed' ? 'plan mode ON' : res === 'cancelled' ? 'plan mode OFF' : 'plan: ' + res, C.green)
  }

  async function newSession() {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    const old = handle
    handle = null
    agent = null
    rows = []
    scroll = 0
    queue = []
    usage = { in: 0, out: 0 }
    if (old) await old.dispose().catch(() => { /* ignore */ })
    await boot(true)
    setStatus('new session…', C.green)
  }

  function retry() {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    if (!lastTurnFailed || !lastUserText) { setStatus('nothing to retry', C.yellow); return }
    sendText(lastUserText)
  }

  // ── fuzzy + dialogs ─────────────────────────────────────────────────────
  function fuzzyScore(q, s) {
    const lq = q.toLowerCase()
    const ls = s.toLowerCase()
    let qi = 0
    let first = -1
    for (let i = 0; i < ls.length && qi < lq.length; i++) {
      if (ls[i] === lq[qi]) {
        if (first < 0) first = i
        qi++
      }
    }
    if (qi !== lq.length) return -1
    return first + lq.length
  }

  function openHistSearch() {
    histSearch = { q: draft.text, matches: [], idx: 0 }
    updateHistMatches()
    dirty = true
  }

  function updateHistMatches() {
    if (!histSearch) return
    const q = histSearch.q.trim()
    const scored = []
    for (const h of history) {
      if (!q) { scored.push({ text: h, score: 0 }); continue }
      const sc = fuzzyScore(q, h)
      if (sc >= 0) scored.push({ text: h, score: sc })
    }
    scored.sort((a, b) => a.score - b.score || b.text.length - a.text.length)
    histSearch.matches = scored.map((s) => s.text).slice(0, 100)
    histSearch.idx = Math.min(histSearch.idx, Math.max(0, histSearch.matches.length - 1))
  }

  const COMMAND_LIST = [
    ['/help', 'show keybindings'],
    ['/new', 'new session'],
    ['/resume', 'resume a saved session'],
    ['/clear', 'clear screen'],
    ['/models', 'model selector (roles)'],
    ['/role <name>', 'switch model role'],
    ['/hub', 'agent hub (Alt+A)'],
    ['/advisor <on|off>', 'second-model advisor'],
    ['/skills', 'list skills'],
    ['/init', 'inject AGENTS.md'],
    ['/think /focus', 'steer reasoning / focus'],
    ['/model <p>/<m>', 'set model'],
    ['/plan', 'toggle plan mode'],
    ['/goal', 'goal commands (registry)'],
    ['/compact', 'compact context (registry)'],
    ['/rename <t>', 'rename this session'],
    ['/settings', 'settings panel'],
    ['/theme <dark|light>', 'switch theme'],
    ['/status', 'session status'],
    ['/hotkeys', 'show active keybindings'],
    ['/exit', 'quit DASH'],
  ]

  function openCmdMenu() {
    cmdMenu = { q: '', matches: [], idx: 0 }
    updateMenuQ()
    dirty = true
  }

  function updateMenuQ() {
    if (!cmdMenu) return
    const after = draft.text.slice(1)
    const q = after.split(/\s+/)[0]
    cmdMenu.q = q
    updateMenuMatches()
  }

  function updateMenuMatches() {
    if (!cmdMenu) return
    const q = cmdMenu.q
    const scored = []
    for (const [name, desc] of COMMAND_LIST) {
      if (!q) { scored.push({ name, desc, score: 0 }); continue }
      const sc = fuzzyScore(q, name)
      if (sc >= 0) scored.push({ name, desc, score: sc })
    }
    scored.sort((a, b) => a.score - b.score)
    cmdMenu.matches = scored.slice(0, 40)
    cmdMenu.idx = Math.min(cmdMenu.idx, Math.max(0, cmdMenu.matches.length - 1))
  }

  function cmdMenuComplete() {
    const m = cmdMenu.matches[cmdMenu.idx]
    if (!m) return
    const cmdName = m.name.split(' ')[0]
    const rest = draft.text.slice(1).split(/\s+/).slice(1).join(' ')
    const full = '/' + cmdName + (rest ? ' ' + rest : '')
    draft.text = full
    draft.cursor = full.length
    cmdMenu = null
    dirty = true
  }

  function showHotkeys() {
    rows.push({ kind: 'notice', text: '— keybindings (remap in ~/.dash/keybindings.yml) —' })
    for (const [action, keys] of Object.entries(DEFAULT_ACTION_KEYS)) {
      const desc = (ACTIONS[action] && ACTIONS[action].desc) || ''
      rows.push({ kind: 'hotkey', action, keys: keys.join(' · '), desc })
    }
    dirty = true
  }

  // ── external editor ─────────────────────────────────────────────────────
  function externalEditor() {
    teardownScreen()
    const ok = draft.externalEdit()
    setupScreen()
    dirty = true
    setStatus(ok ? 'edited' : '✗ external editor failed', ok ? C.green : C.red)
  }

  // ── input dispatch ──────────────────────────────────────────────────────
  const parser = new KeyParser()
  let escTimer = null

  function armEscTimer() {
    if (escTimer) clearTimeout(escTimer)
    escTimer = setTimeout(() => {
      escTimer = null
      if (parser.partialEscape) {
        parser.dropPartial()
        onKeyEvent({ key: 'escape', char: null, ctrl: false, alt: false, shift: false, meta: false })
      }
    }, 50)
  }

  function onData(chunk) {
    if (escTimer) { clearTimeout(escTimer); escTimer = null }
    parser.feed(chunk)
    for (const ev of parser.poll()) onKeyEvent(ev)
    if (parser.partialEscape) armEscTimer()
  }

  function onKeyEvent(ev) {
    if (ev.key === 'paste-start') { pasteBuf = ''; return }
    if (ev.key === 'paste-end') {
      if (pasteBuf !== null) draft.insert(pasteBuf)
      pasteBuf = null
      dirty = true
      return
    }
    if (ev.key === 'kitty-response') {
      kittyMode = /^1/.test(ev.flags || '')
      return
    }
    if (pasteBuf !== null) {
      if (ev.char !== null) pasteBuf += ev.char
      return
    }
    if (helpOpen) {
      if (ev.key === 'escape' || ev.key === 'enter' || (ev.char === 'c' && ev.ctrl)) { helpOpen = false; dirty = true }
      return
    }
    if (hub) { hubKeys(ev); return }
    if (picker) { pickerKeys(ev); return }
    if (resumePick) { resumeKeys(ev); return }
    if (settingsPick) { settingsKeys(ev); return }
    if (fileMenu) { fileMenuKeys(ev); return }
    if (rewind) { rewindKeys(ev); return }
    if (histSearch) { histKeys(ev); return }
    if (cmdMenu) { menuKeys(ev); return }
    if (exitConfirm) {
      if (ev.char === 'y' || ev.char === 'Y') { exitDash(0); return }
      if (ev.char === 'n' || ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { exitConfirm = false; setStatus(''); return }
      return
    }
    if (jumpChar) {
      if (ev.char !== null && !ev.ctrl && !ev.alt) {
        draft.jumpToChar(ev.char, jumpChar)
        jumpChar = null
        dirty = true
        return
      }
      if (ev.key === 'escape') { jumpChar = null; setStatus(''); return }
      return
    }
    if (ev.char !== null && !ev.ctrl && !ev.alt && !ev.meta) {
      draft.insert(ev.char)
      dirty = true
      // oh-my-pi behavior: typing '/' at the prompt opens the command menu
      if (!cmdMenu && draft.text.startsWith('/') && draft.text.length === 1) openCmdMenu()
      return
    }
    // Ambiguous lone-Esc: alt+char with no binding while an overlay is open is
    // almost certainly Esc followed by a quick keystroke (legacy terminals
    // cannot disambiguate). Route it as Escape, then the char.
    if (ev.alt && ev.char && !ev.ctrl && !ev.meta) {
      const acts = keyMap.get(keyId(ev))
      if (!acts || !acts.length) {
        if (helpOpen || hub || picker || histSearch || cmdMenu || rewind || exitConfirm || jumpChar || resumePick || settingsPick || fileMenu) {
          onKeyEvent({ key: 'escape', char: null, ctrl: false, alt: false, shift: false, meta: false })
          onKeyEvent({ key: null, char: ev.char, ctrl: false, alt: false, shift: false, meta: false })
          return
        }
      }
    }
    const acts = keyMap.get(keyId(ev)) || []
    for (const a of acts) {
      if (handleAction(a, ev)) return
    }
  }

  function pickerKeys(ev) {
    const p = picker
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { picker = null; dirty = true; return }
    if (ev.key === 'tab') {
      p.focus = p.focus === 'role' ? 'prov' : p.focus === 'prov' ? 'model' : 'role'
      dirty = true
      return
    }
    if (ev.key === 'down' || ev.char === 'j') {
      if (p.focus === 'role') {
        p.roleIdx = (p.roleIdx + 1) % p.roles.length
        const a = roleAssignment(p.roles[p.roleIdx])
        if (a) {
          const i = p.providers.findIndex((pr) => pr.id === a.provider)
          if (i >= 0) { p.provIdx = i; p.models = []; p.modelIdx = 0; loadPickerModels(i, a.model) }
        }
      } else if (p.focus === 'prov') {
        p.provIdx = (p.provIdx + 1) % p.providers.length
        p.models = []
        p.modelIdx = 0
        loadPickerModels(p.provIdx)
      } else if (p.models.length) p.modelIdx = (p.modelIdx + 1) % p.models.length
      dirty = true
      return
    }
    if (ev.key === 'up' || ev.char === 'k') {
      if (p.focus === 'role') {
        p.roleIdx = (p.roleIdx - 1 + p.roles.length) % p.roles.length
        const a = roleAssignment(p.roles[p.roleIdx])
        if (a) {
          const i = p.providers.findIndex((pr) => pr.id === a.provider)
          if (i >= 0) { p.provIdx = i; p.models = []; p.modelIdx = 0; loadPickerModels(i, a.model) }
        }
      } else if (p.focus === 'prov') {
        p.provIdx = (p.provIdx - 1 + p.providers.length) % p.providers.length
        p.models = []
        p.modelIdx = 0
        loadPickerModels(p.provIdx)
      } else if (p.models.length) p.modelIdx = (p.modelIdx - 1 + p.models.length) % p.models.length
      dirty = true
      return
    }
    if (ev.key === 'enter') {
      if (p.focus === 'role') {
        const a = roleAssignment(p.roles[p.roleIdx])
        if (a) {
          const i = p.providers.findIndex((pr) => pr.id === a.provider)
          if (i >= 0) { p.provIdx = i; p.models = []; p.modelIdx = 0; loadPickerModels(i, a.model) }
        }
        p.focus = 'prov'
      } else if (p.focus === 'prov') {
        if (!p.models.length) loadPickerModels(p.provIdx)
        p.focus = 'model'
      } else pickerSelect()
      dirty = true
      return
    }
  }

  function histKeys(ev) {
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { histSearch = null; dirty = true; return }
    if (ev.key === 'enter') {
      const m = histSearch.matches[histSearch.idx]
      if (m) { draft.text = m; draft.cursor = m.length }
      histSearch = null
      dirty = true
      return
    }
    if (ev.key === 'up' && histSearch.matches.length) { histSearch.idx = Math.max(0, histSearch.idx - 1); dirty = true; return }
    if (ev.key === 'down' && histSearch.matches.length) { histSearch.idx = Math.min(histSearch.matches.length - 1, histSearch.idx + 1); dirty = true; return }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      histSearch.q += ev.char
      updateHistMatches()
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      histSearch.q = histSearch.q.slice(0, -1)
      updateHistMatches()
      dirty = true
      return
    }
  }

  function menuKeys(ev) {    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { cmdMenu = null; dirty = true; return }
    if (ev.key === 'enter') {
      // Enter submits the full line (omp behavior); Tab completes
      const t = draft.text
      cmdMenu = null
      sendText(t)
      return
    }
    if (ev.key === 'tab') { cmdMenuComplete(); return }
    if (ev.key === 'up' && cmdMenu.matches.length) { cmdMenu.idx = Math.max(0, cmdMenu.idx - 1); dirty = true; return }
    if (ev.key === 'down' && cmdMenu.matches.length) { cmdMenu.idx = Math.min(cmdMenu.matches.length - 1, cmdMenu.idx + 1); dirty = true; return }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      draft.insert(ev.char)
      updateMenuQ()
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      draft.delBack()
      updateMenuQ()
      dirty = true
      return
    }
  }

  // ── rewind (double-Esc time travel) ─────────────────────────────────────
  function openRewind() {
    const userRows = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.kind === 'user' && r.seq != null) userRows.push(r)
    }
    if (!userRows.length) { setStatus('没有可回滚的消息', C.yellow); return }
    rewind = { q: '', matches: userRows, idx: 0 }
    dirty = true
  }

  function rewindKeys(ev) {
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { rewind = null; dirty = true; return }
    if (ev.key === 'enter') {
      const m = rewind.matches[rewind.idx]
      if (m) rewindTo(m)
      return
    }
    if (ev.key === 'up' && rewind.matches.length) { rewind.idx = Math.max(0, rewind.idx - 1); dirty = true; return }
    if (ev.key === 'down' && rewind.matches.length) { rewind.idx = Math.min(rewind.matches.length - 1, rewind.idx + 1); dirty = true; return }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      rewind.q += ev.char
      rewind.matches = []
      for (const r of rows) {
        if (r.kind === 'user' && r.seq != null && (r.text.toLowerCase().includes(rewind.q.toLowerCase()) || !rewind.q)) {
          rewind.matches.push(r)
        }
      }
      rewind.matches.reverse()
      rewind.idx = Math.min(rewind.idx, Math.max(0, rewind.matches.length - 1))
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      rewind.q = rewind.q.slice(0, -1)
      rewind.matches = []
      for (const r of rows) {
        if (r.kind === 'user' && r.seq != null && (r.text.toLowerCase().includes(rewind.q.toLowerCase()) || !rewind.q)) {
          rewind.matches.push(r)
        }
      }
      rewind.matches.reverse()
      rewind.idx = Math.min(rewind.idx, Math.max(0, rewind.matches.length - 1))
      dirty = true
      return
    }
  }

  /** Replay a session event log into the transcript rows (rewind/resume). */
  function replayEvents(events) {
    rows = []
    for (const e of events) {
      const dd = e.data || {}
      if (e.type === 'user/message' && dd.source && dd.source.kind === 'user') rows.push({ kind: 'user', text: textOf(dd.content) })
      else if (e.type === 'assistant/message') {
        rows.push({ kind: 'assistant', text: textOf(dd.message && dd.message.content), reasoning: reasoningOf(dd.message && dd.message.content), usage: dd.usage, streaming: false, error: null, meta: 'replay' })
      } else if (e.type === 'tool/call') {
        rows.push({ kind: 'tool', callId: dd.callId, name: dd.name, args: dd.arguments, status: 'ok', summary: null, error: null })
      } else if (e.type === 'compaction/start') {
        rows.push({ kind: 'notice', text: '🧹 压缩' })
      }
    }
  }

  async function rewindTo(row) {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    if (!agent) return
    const events = agent.session.events
    // seed = everything before the turn that contains this user message
    let boundaryIdx = 0
    let foundTurn = false
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e.seq === row.seq) break
      if (e.type === 'turn/start') { foundTurn = true; boundaryIdx = i }
    }
    const seed = foundTurn ? events.slice(0, boundaryIdx) : []
    const old = handle
    const oldId = old ? old.agent.id : null
    handle = null
    agent = null
    const sessionId = 'dash-rewind-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: config.cwd || process.cwd(), parentSession: oldId, seedLength: seed.length },
        seed,
        agentOptions: { provider: displayModel.provider, model: displayModel.model },
        setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
      })
    } catch (e) {
      rows.push({ kind: 'notice', text: '✗ rewind failed: ' + ((e && e.message) || e) })
      dirty = true
      return
    }
    if (old) await old.dispose().catch(() => { /* ignore */ })
    agent = handle.agent
    // replay the seed history into the transcript
    replayEvents(seed)
    // the message goes back into the editor for edit-and-resend (omp behavior)
    draft.text = row.text
    draft.cursor = draft.text.length
    draft.undoStack = []
    rewind = null
    setStatus('已回滚到: ' + truncate(row.text, 40), C.green)
    dirty = true
  }

  // ── session resume (/resume) ─────────────────────────────────────────────
  let resumePick = null

  async function openResume() {
    const sessionPersistence = ctx.get('sessionPersistence')
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionPersistence) { setStatus('✗ session persistence unavailable', C.red); return }
    let headers = []
    try { headers = await sessionPersistence.list() } catch (e) {
      console.error('DASH debug list failed:', String(e && e.message || e))
    }
    console.error('DASH debug header count:', headers.length)
    // sort by artifact mtime desc; dash-* sessions first
    const withTime = []
    for (const h of headers) {
      let mtime = h.createdAt || 0
      try {
        const loc = sessionPersistence.locate(h)
        if (loc && loc.path) {
          const st = fs.statSync(loc.path)
          if (st.isDirectory()) {
            // jsonl backend keeps the log inside a dir; use its mtime
            mtime = st.mtimeMs
          } else mtime = st.mtimeMs
        }
      } catch (e) { /* keep createdAt */ }
      withTime.push({ header: h, mtime })
    }
    withTime.sort((a, b) => b.mtime - a.mtime)
    console.error('DASH debug sorted top:', withTime.slice(0, 10).map((w) => w.header.id.slice(0, 14) + '@' + new Date(w.mtime).toISOString().slice(11, 16)).join(' | '))
    const items = withTime.slice(0, 30).map((w) => ({ id: w.header.id, cwd: w.header.cwd, time: w.mtime, title: '' }))
    resumePick = { items, idx: 0, q: '', loading: true }
    dirty = true
    // fetch titles in parallel
    if (sessionQuery) {
      await Promise.all(items.map(async (it) => {
        try {
          const t = await sessionQuery.readTitle(it.id)
          if (t && t.title) it.title = t.title
        } catch (e) { /* ignore */ }
      }))
    }
    if (resumePick) { resumePick.loading = false; dirty = true }
  }

  function resumePickFiltered() {
    if (!resumePick) return []
    const q = resumePick.q.toLowerCase()
    return resumePick.items.filter((it) => !q || it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
  }

  function resumeKeys(ev) {
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { resumePick = null; dirty = true; return }
    const list = resumePickFiltered()
    if (ev.key === 'enter') {
      const it = list[resumePick.idx]
      if (it) resumeSession(it.id)
      return
    }
    if (ev.key === 'up' && list.length) { resumePick.idx = Math.max(0, resumePick.idx - 1); dirty = true; return }
    if (ev.key === 'down' && list.length) { resumePick.idx = Math.min(list.length - 1, resumePick.idx + 1); dirty = true; return }
    if (ev.char === 'd' && !ev.ctrl && list.length) {
      const it = list[resumePick.idx]
      if (it && it.id.startsWith('dash-')) {
        deleteSession(it.id)
      } else {
        setStatus('仅可删除 dash-* 会话', C.yellow)
      }
      return
    }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      resumePick.q += ev.char
      resumePick.idx = 0
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      resumePick.q = resumePick.q.slice(0, -1)
      resumePick.idx = 0
      dirty = true
      return
    }
  }

  async function deleteSession(id) {
    const sessionPersistence = ctx.get('sessionPersistence')
    if (!sessionPersistence) return
    try {
      const hs = await sessionPersistence.list()
      const h = hs.find((x) => x.id === id)
      if (h) {
        const loc = sessionPersistence.locate(h)
        if (loc && loc.path && fs.existsSync(loc.path)) {
          fs.rmSync(loc.path, { recursive: true, force: true })
          rows.push({ kind: 'notice', text: '🗑 已删除会话 ' + id })
        }
      }
    } catch (e) { /* ignore */ }
    openResume()
  }

  async function resumeSession(id) {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    resumePick = null
    const old = handle
    handle = null
    agent = null
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: displayModel.provider, model: displayModel.model },
        setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
      })
    } catch (e) {
      rows.push({ kind: 'notice', text: '✗ resume failed: ' + ((e && e.message) || e) })
      if (old) { handle = old; agent = old.agent }
      dirty = true
      return
    }
    if (old) await old.dispose().catch(() => { /* ignore */ })
    agent = handle.agent
    replayEvents(agent.session.events)
    sessionTitle = ''
    const sessionTitleSvc = ctx.get('sessionTitle')
    if (sessionTitleSvc) {
      try {
        const snap = sessionTitleSvc.get(agent.session)
        if (snap && snap.title) sessionTitle = snap.title
      } catch (e) { /* ignore */ }
    }
    usage = { in: 0, out: 0 }
    setStatus('已恢复会话 ' + id, C.green)
    dirty = true
  }

  // ── settings panel (/settings) ───────────────────────────────────────────
  let settingsPick = null

  function openSettings() {
    settingsPick = { idx: 0 }
    dirty = true
  }

  function settingsKeys(ev) {
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { settingsPick = null; dirty = true; return }
    if (ev.key === 'up') { settingsPick.idx = Math.max(0, settingsPick.idx - 1); dirty = true; return }
    if (ev.key === 'down') { settingsPick.idx = Math.min(SETTINGS_SCHEMA.length - 1, settingsPick.idx + 1); dirty = true; return }
    if (ev.key === 'enter' || (ev.char === ' ' && !ev.ctrl)) {
      const s = SETTINGS_SCHEMA[settingsPick.idx]
      if (!s) return
      let cur = getCfg(cfg, s.key)
      if (s.type === 'bool') {
        cur = !cur
        setCfg(cfg, s.key, cur)
        saveConfig(cfg)
        applyTheme()
        setStatus(s.key + ' → ' + cur, C.green)
      } else if (s.type === 'enum') {
        const i = s.options.indexOf(cur)
        const next = s.options[(i + 1) % s.options.length]
        setCfg(cfg, s.key, next)
        saveConfig(cfg)
        setStatus(s.key + ' → ' + next, C.green)
      }
      dirty = true
      return
    }
  }

  function settingsLines() {
    const lines = []
    lines.push(C.bright + '  ─ settings ─  (↑↓ 移动 · Enter 切换/循环 · Esc 关闭 · 写入 ~/.dash/config.yml)' + C.reset)
    lines.push('')
    SETTINGS_SCHEMA.forEach((s, i) => {
      const cur = getCfg(cfg, s.key)
      const val = s.type === 'bool' ? (cur ? 'on' : 'off') : (cur || s.options[0])
      const mark = settingsPick.idx === i ? C.green + '  › ' : '    '
      lines.push(mark + s.key + C.dim + '  ' + s.desc + C.reset + '  ' + (cur ? C.green : C.dim) + val + C.reset)
    })
    return lines
  }

  // ── @ file completion ────────────────────────────────────────────────────
  let fileMenu = null

  function openFileMenu() {
    // find the '@' token in the draft
    let at = -1
    for (let i = draft.cursor - 1; i >= 0; i--) {
      if (draft.text[i] === '@') { at = i; break }
      if (draft.text[i] === ' ' || draft.text[i] === '\n') break
    }
    if (at < 0) return false
    const prefix = draft.text.slice(at + 1, draft.cursor)
    const slash = prefix.lastIndexOf('/')
    const dir = slash >= 0 ? prefix.slice(0, slash + 1) : ''
    const base = slash >= 0 ? prefix.slice(slash + 1) : prefix
    let entries = []
    try {
      const cwd = config.cwd || process.cwd()
      entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })
        .filter((e) => e.name.startsWith(base) && !e.name.startsWith('.'))
        .map((e) => dir + e.name + (e.isDirectory() ? '/' : ''))
        .sort()
    } catch (e) { /* ignore */ }
    if (!entries.length) return false
    fileMenu = { dir, base, entries, idx: 0, at }
    dirty = true
    return true
  }

  function fileMenuKeys(ev) {
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { fileMenu = null; dirty = true; return }
    if (ev.key === 'up' && fileMenu.entries.length) { fileMenu.idx = Math.max(0, fileMenu.idx - 1); dirty = true; return }
    if (ev.key === 'down' && fileMenu.entries.length) { fileMenu.idx = Math.min(fileMenu.entries.length - 1, fileMenu.idx + 1); dirty = true; return }
    if (ev.key === 'enter' || ev.key === 'tab') {
      const e = fileMenu.entries[fileMenu.idx]
      if (e) {
        draft.text = draft.text.slice(0, fileMenu.at + 1) + e + draft.text.slice(draft.cursor)
        draft.cursor = fileMenu.at + 1 + e.length
      }
      fileMenu = null
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      // retract the '@' token and close
      const at = fileMenu.at
      draft.text = draft.text.slice(0, at) + draft.text.slice(draft.cursor)
      draft.cursor = at
      fileMenu = null
      dirty = true
      return
    }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      // refine filter by re-opening with the appended char
      draft.insert(ev.char)
      if (!openFileMenu()) { fileMenu = null }
      dirty = true
      return
    }
  }

  function fileMenuLines() {
    const lines = []
    lines.push(C.bright + '  ─ @ 文件补全: ' + C.reset + C.green + (fileMenu.dir + fileMenu.base) + C.reset + C.bright + ' ─ (↑↓ · Enter 插入 · Esc 取消)' + C.reset)
    lines.push('')
    fileMenu.entries.forEach((e, i) => {
      lines.push((i === fileMenu.idx ? C.green + '  › ' : '    ') + e + C.reset)
    })
    return lines
  }


  // ── agent hub (Alt+A) ───────────────────────────────────────────────────
  async function openHub() {
    const subs = ctx.get('subagents')
    if (!subs || !agent) { setStatus('✗ subagents unavailable', C.red); return }
    hubEntries = []
    try {
      const list = await subs.listDescendants(agent.id)
      for (const e of list) {
        if (e.kind === 'child') {
          hubEntries.push({ id: e.id, depth: e.depth || 0, label: e.label || e.id.slice(0, 12), mode: e.mode, activity: e.activity, hasChildren: e.hasChildren })
        }
      }
    } catch (e) {
      setStatus('✗ hub: ' + ((e && e.message) || e), C.red)
      return
    }
    hub = { idx: 0, view: 'list', detailId: null, q: '' }
    dirty = true
  }

  function hubFiltered() {
    if (!hub) return []
    const q = hub.q.toLowerCase()
    return hubEntries.filter((e) => !q || e.label.toLowerCase().includes(q) || e.id.includes(q))
  }

  function hubKeys(ev) {
    const list = hubFiltered()
    if (hub.view === 'detail') {
      if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { hub.view = 'list'; dirty = true; return }
      if (ev.char === 'x' && !ev.ctrl) {
        interruptChild(hub.detailId)
        return
      }
      if (ev.char === 's' && !ev.ctrl) {
        hubSteerText = ''
        hub.view = 'steer'
        dirty = true
        return
      }
      return
    }
    if (hub.view === 'steer') {
      if (ev.key === 'escape') { hub.view = 'detail'; dirty = true; return }
      if (ev.key === 'enter') {
        const t = hubSteerText.trim()
        if (t && hub.detailId) steerChild(hub.detailId, t)
        hub.view = 'detail'
        dirty = true
        return
      }
      if (ev.key === 'backspace') { hubSteerText = hubSteerText.slice(0, -1); dirty = true; return }
      if (ev.char !== null && !ev.ctrl && !ev.alt) { hubSteerText += ev.char; dirty = true; return }
      return
    }
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { hub = null; dirty = true; return }
    if (ev.key === 'enter') {
      const e = list[hub.idx]
      if (e) { hub.detailId = e.id; hub.view = 'detail'; dirty = true }
      return
    }
    if (ev.key === 'up' && list.length) { hub.idx = Math.max(0, hub.idx - 1); dirty = true; return }
    if (ev.key === 'down' && list.length) { hub.idx = Math.min(list.length - 1, hub.idx + 1); dirty = true; return }
    if (ev.char === 'x' && !ev.ctrl && list.length) {
      const e = list[hub.idx]
      if (e) interruptChild(e.id)
      return
    }
    if (ev.char !== null && !ev.ctrl && !ev.alt) {
      hub.q += ev.char
      hub.idx = 0
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      hub.q = hub.q.slice(0, -1)
      hub.idx = 0
      dirty = true
      return
    }
  }

  function interruptChild(id) {
    const subs = ctx.get('subagents')
    if (!subs || !agent) return
    try {
      subs.interrupt(id, { kind: 'ancestor', agent })
      rows.push({ kind: 'notice', text: '⏹ 已中断子代理 ' + id.slice(0, 12) })
    } catch (e) {
      setStatus('✗ interrupt: ' + ((e && e.message) || e), C.red)
    }
    dirty = true
  }

  async function steerChild(id, text) {
    const subs = ctx.get('subagents')
    if (!subs || !agent) return
    try {
      const source = { kind: 'user' }
      const msg = createUserMessage({ content: [{ type: 'text', text }], source })
      await subs.followup(agent, id, msg.content, { source, signal: AbortSignal.timeout(15000) })
      rows.push({ kind: 'notice', text: '✉ 已发送给 ' + id.slice(0, 12) + ': ' + truncate(text, 40) })
    } catch (e) {
      setStatus('✗ steer: ' + ((e && e.message) || e), C.red)
    }
    dirty = true
  }

  function hubLines() {
    const lines = []
    if (hub.view === 'detail') {
      lines.push(C.bright + '  ─ 子代理详情: ' + C.reset + C.green + (hub.detailId || '') + C.reset + C.bright + ' ─ (s 发送消息 · x 中断 · Esc 返回)' + C.reset)
      lines.push('')
      const list = hubFiltered()
      const e = list.find((x) => x.id === hub.detailId) || hubEntries.find((x) => x.id === hub.detailId)
      if (e) lines.push(C.dim + '    ' + e.label + ' · ' + e.mode + ' · ' + e.activity + C.reset)
      lines.push(C.dim + '    （最近消息见转录；s=发送 x=中断）' + C.reset)
      return lines
    }
    if (hub.view === 'steer') {
      lines.push(C.bright + '  ─ 发送消息给子代理: ' + C.reset + C.green + hubSteerText + '▌' + C.reset + C.bright + ' ─ (Enter 发送 · Esc 取消)' + C.reset)
      return lines
    }
    lines.push(C.bright + '  ─ Agent Hub: ' + C.reset + C.green + hub.q + C.reset + C.bright + ' ─ (j/k · Enter 详情 · x 中断 · Esc 关闭)' + C.reset)
    lines.push('')
    const list = hubFiltered()
    if (!list.length) {
      lines.push(C.dim + '    无子代理（用 subagent 工具产生）' + C.reset)
    } else {
      list.forEach((e, i) => {
        const indent = '  ' + '  '.repeat(Math.min(e.depth, 4))
        const mark = i === hub.idx ? C.green + '  › ' : '    '
        const status = e.activity === 'running' ? C.yellow + '● running' + C.reset : C.dim + '○ inactive' + C.reset
        lines.push(indent + mark + e.label + C.dim + '  ' + e.mode + (e.hasChildren ? ' · sub' : '') + C.reset + '  ' + status)
      })
    }
    return lines
  }

  // ── TTSR: time-traveling stream rules ────────────────────────────────────
  function checkRules() {
    if (!rules.length || !agent || !streamText) return
    for (const r of rules) {
      if (injectedRules.has(r.name)) continue
      if (r.re.test(streamText)) {
        injectedRules.add(r.name)
        rows.push({ kind: 'notice', text: '⚠ 注入规则: ' + r.name })
        try {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: r.message }], source: { kind: 'plugin', plugin: 'dash-tui' } }))
        } catch (e) { /* ignore */ }
        dirty = true
      }
    }
  }

  // ── advisor: second-model note on every completed turn ───────────────────
  function advisorNote() {
    if (!advisorEnabled || !llm || !agent) return
    // find last user + assistant texts
    let u = ''
    let a = ''
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!a && rows[i].kind === 'assistant' && !rows[i].streaming) a = rows[i].text
      else if (!u && rows[i].kind === 'user') u = rows[i].text
      if (u && a) break
    }
    if (!u || !a) return
    const system = 'You are the DASH advisor. Read the user prompt and the assistant reply, then give ONE concise note (under 60 words, Chinese or English) pointing out anything the assistant missed, got wrong, or could improve. Prefix with "advisor: ".'
    const messages = [
      { id: 'dash-adv-1', role: 'user', content: [{ type: 'text', text: 'PROMPT:\n' + u }], source: { kind: 'user' } },
      { id: 'dash-adv-2', role: 'assistant', content: [{ type: 'text', text: a }], source: { kind: 'model', provider: displayModel.provider, model: displayModel.model } },
    ]
    void (async () => {
      let text = ''
      try {
        const stream = llm.stream({ provider: displayModel.provider, model: displayModel.model, messages, system, maxTokens: 200 })
        for await (const c of stream) {
          if (c.type === 'text-delta') text += c.text
        }
      } catch (e) { /* ignore */ }
      if (text.trim()) {
        rows.push({ kind: 'notice', text: truncate(text.trim(), 300) })
        dirty = true
      }
    })()
  }

  function handleAction(action) {    switch (action) {
      case 'tui.editor.cursorUp': draft.moveUp(); dirty = true; return true
      case 'tui.editor.cursorDown': draft.moveDown(); dirty = true; return true
      case 'tui.editor.cursorLeft': draft.moveLeft(); dirty = true; return true
      case 'tui.editor.cursorRight': draft.moveRight(); dirty = true; return true
      case 'tui.editor.cursorWordLeft': draft.moveWordLeft(); dirty = true; return true
      case 'tui.editor.cursorWordRight': draft.moveWordRight(); dirty = true; return true
      case 'tui.editor.cursorLineStart': draft.lineStart(); dirty = true; return true
      case 'tui.editor.cursorLineEnd': draft.lineEnd(); dirty = true; return true
      case 'tui.editor.jumpForward': jumpChar = 1; setStatus('jump to char: (forward)'); return true
      case 'tui.editor.jumpBackward': jumpChar = -1; setStatus('jump to char: (backward)'); return true
      case 'tui.editor.pageUp': scrollBy(Math.max(1, H - 8)); return true
      case 'tui.editor.pageDown': scrollBy(-Math.max(1, H - 8)); return true
      case 'tui.editor.deleteCharBackward': draft.delBack(); dirty = true; return true
      case 'tui.editor.deleteCharForward':
        if (draft.cursor < draft.text.length) { draft.delFwd(); dirty = true; return true }
        return false
      case 'tui.editor.deleteWordBackward': draft.delWordBack(); dirty = true; return true
      case 'tui.editor.deleteWordForward': draft.delWordFwd(); dirty = true; return true
      case 'tui.editor.deleteToLineStart': draft.delToLineStart(); dirty = true; return true
      case 'tui.editor.deleteToLineEnd': draft.delToLineEnd(); dirty = true; return true
      case 'tui.editor.yank': draft.yank(); dirty = true; return true
      case 'tui.editor.yankPop': draft.yankPop(); dirty = true; return true
      case 'tui.editor.undo': draft.undo(); dirty = true; return true
      case 'tui.input.newLine': draft.insert('\n'); dirty = true; return true
      case 'tui.input.submit': submitDraft(); return true
      case 'tui.input.tab': {
        const before = draft.text.slice(0, draft.cursor)
        if (before.includes('@')) { openFileMenu() }
        else if (draft.text.trim().startsWith('/')) openCmdMenu()
        else setStatus('tab: 输入 / 开命令菜单，@ 开文件补全', C.yellow)
        return true
      }
      case 'app.interrupt': {
        if (busy) { cancelRun(); return true }
        const now = Date.now()
        if (lastEscAt && now - lastEscAt < 350) {
          lastEscAt = 0
          openRewind()
        } else {
          lastEscAt = now
          setStatus('再次按 Esc 进入时间回溯 (rewind)', C.yellow)
        }
        return true
      }
      case 'app.clear':
        if (busy) cancelRun()
        else clearScreen()
        return true
      case 'app.exit':
        if (draft.text.length) { draft.delFwd(); dirty = true }
        else { exitConfirm = true; setStatus('exit DASH? [y/n]', C.yellow) }
        return true
      case 'app.suspend': suspendDash(); return true
      case 'app.display.reset': setStatus(''); scroll = 0; following = true; dirty = true; return true
      case 'app.thinking.cycle': cycleThinking(); return true
      case 'app.thinking.toggle': showReasoning = !showReasoning; setStatus(showReasoning ? 'reasoning shown' : 'reasoning hidden', C.green); return true
      case 'app.model.cycleForward': cycleModel(1); return true
      case 'app.model.cycleBackward': cycleModel(-1); return true
      case 'app.model.select': openPicker(false); return true
      case 'app.model.selectTemporary': openPicker(true); return true
      case 'app.tools.expand': verboseTools = !verboseTools; setStatus(verboseTools ? 'verbose tool args' : 'tool args folded', C.green); return true
      case 'app.tools.toggleVisibility': showTools = !showTools; setStatus(showTools ? 'tools shown' : 'tools hidden', C.green); return true
      case 'app.editor.external': externalEditor(); return true
      case 'app.message.followUp': queueFollowUp(); return true
      case 'app.retry': retry(); return true
      case 'app.message.dequeue': dequeue(); return true
      case 'app.clipboard.pasteTextRaw': setStatus('clipboard unavailable in terminal', C.yellow); return true
      case 'app.clipboard.copyLine': setStatus('clipboard unavailable in terminal', C.yellow); return true
      case 'app.clipboard.copyPrompt': setStatus('clipboard unavailable in terminal', C.yellow); return true
      case 'app.agents.hub': openHub(); return true
      case 'app.plan.toggle': planToggle(); return true
      case 'app.history.search': openHistSearch(); return true
      case 'app.session.observe': setStatus('session observe: coming in a later iteration', C.yellow); return true
      default:
        return false
    }
  }

  function maxScroll() {
    const draftLines = wrapDraft(W - 4)
    const maxShown = Math.min(draftLines.length, 4)
    const vis = Math.max(3, H - 3 - maxShown)
    return Math.max(0, allLines().length - vis)
  }

  function scrollBy(n) {
    // scroll = lines scrolled UP from the bottom; pageUp adds, pageDown removes
    following = false
    scroll += n
    const max = maxScroll()
    if (scroll < 0) scroll = 0
    if (scroll > max) scroll = max
    if (scroll === 0) following = true
    dirty = true
  }

  // ── rendering ───────────────────────────────────────────────────────────
  function allLines() {
    const w = W - 6
    const lines = []
    for (const r of rows) {
      if (r.kind === 'user') {
        wrapTo(r.text, w).forEach((ln, i) => lines.push(C.blue + (i === 0 ? '┃ ' : '  ') + ln + C.reset))
      } else if (r.kind === 'assistant') {
        if (r.reasoning && showReasoning) {
          wrapTo('⟐ ' + r.reasoning, w).forEach((ln) => lines.push(C.dim + C.italic + '  ' + ln + C.reset))
        }
        const color = r.error ? C.red : C.green
        const md = r.text ? renderMarkdown(r.text, w) : []
        const wrapped = md.length ? md : ['']
        wrapped.forEach((ln, i) => lines.push(color + (i === 0 ? '● ' : '  ') + ln + C.reset))
        if (r.streaming) {
          lines[lines.length - 1] = lines[lines.length - 1].slice(0, -C.reset.length) + '▌' + C.reset
        }
        if (r.meta && !r.streaming) lines.push(C.dim + '  · ' + r.meta + C.reset)
        if (r.error) lines.push(C.red + '  ✗ ' + r.error + C.reset)
        if (r.usage) lines.push(C.dim + '  in ' + (r.usage.inputTokens || 0) + ' · out ' + (r.usage.outputTokens || 0) + C.reset)
      } else if (r.kind === 'tool') {
        if (!showTools) continue
        const icon = r.status === 'running' ? '⛭' : r.status === 'ok' ? '✓' : '✗'
        const color = r.status === 'running' ? C.yellow : r.status === 'ok' ? C.dim : C.red
        const args = verboseTools ? r.args : truncate(r.args.replace(/\s+/g, ' ').trim(), 100)
        lines.push(color + '  ' + icon + ' ' + r.name + ' ' + args + C.reset)
        if (r.status === 'ok' && r.summary) lines.push(C.dim + '    ' + r.summary + C.reset)
        if (r.status === 'error') lines.push(C.red + '    error: ' + r.error + C.reset)
      } else if (r.kind === 'hotkey') {
        lines.push(C.purple + '  ' + padRight(r.action, 30) + C.reset + C.dim + r.keys + C.reset + '  ' + r.desc)
      } else {
        wrapTo(r.text, w).forEach((ln) => lines.push(C.amber + ln + C.reset))
      }
      lines.push('')
    }
    return lines
  }

  function helpLines() {
    const keys = [
      ['Enter', 'send · queue while streaming'],
      ['Shift+Enter / Ctrl+J', 'newline'],
      ['Ctrl+Enter / Ctrl+Q', 'queue follow-up'],
      ['Esc · Esc Esc', 'interrupt · 时间回溯 rewind'],
      ['Ctrl+C', 'cancel / clear screen'],
      ['Ctrl+D', 'exit (confirm)'],
      ['Ctrl+Z', 'suspend'],
      ['Ctrl+P / Shift+Ctrl+P', 'cycle model'],
      ['Alt+M', 'model selector'],
      ['Alt+P', 'temporary model'],
      ['Alt+R', 'retry last failed turn'],
      ['Ctrl+R', 'history search'],
      ['Alt+Up / Shift+Up', 'dequeue follow-up'],
      ['Ctrl+N', 'new session'],
      ['Alt+Shift+P', 'toggle plan mode'],
      ['Ctrl+T', 'toggle reasoning'],
      ['Shift+Tab', 'cycle thinking level'],
      ['Ctrl+O', 'expand tool args'],
      ['Ctrl+Shift+O', 'toggle tool rows'],
      ['Ctrl+G', 'external editor'],
      ['Ctrl+L / Alt+L', 'display reset'],
      ['Alt+A', 'agent hub (/hub)'],
      ['Ctrl+]/Ctrl+Alt+]', 'jump to char'],
      ['Ctrl+U/K/W', 'delete to line start/end/word'],
      ['Ctrl+Y / Alt+Y', 'yank / yank-pop'],
      ['Ctrl+- / Ctrl+_', 'undo'],
      ['PgUp/PgDn', 'scroll (置顶提示词栏 + ↓N 未读)'],
      ['/help /new /resume /clear /models /plan', 'commands'],
      ['/goal /compact /rename /settings /theme', 'commands'],
      ['/role /hub /advisor /skills /init', 'commands'],
      ['/think /focus /status /hotkeys /exit', 'commands'],
      ['Tab (draft 含 @)', '@ 文件补全'],
    ]
    const lines = []
    lines.push(C.bright + '  DASH — oh-my-pi TUI usage · DSH kernel' + C.reset)
    lines.push('')
    for (const [k, v] of keys) {
      lines.push(C.purple + '  ' + padRight(k, 28) + C.reset + C.dim + v + C.reset)
    }
    lines.push('')
    lines.push(C.dim + '  Esc to close · keybindings remap: ~/.dash/keybindings.yml' + C.reset)
    return lines
  }

  function pickerLines() {
    const lines = []
    const p = picker
    lines.push(C.bright + '  ─ 模型选择器' + (p.temp ? ' (temporary)' : '') + ' ─  (Tab 切栏 · j/k 移动 · Enter 下钻/选中 · Esc 关闭)' + C.reset)
    lines.push('')
    lines.push(C.dim + '  角色' + (p.roles[p.roleIdx] === currentRole && !p.temp ? '  (当前)' : '') + C.reset)
    p.roles.forEach((name, i) => {
      const a = roleAssignment(name)
      const cur = name === currentRole && !p.temp ? C.dim + ' ◀' + C.reset : ''
      lines.push((p.focus === 'role' && i === p.roleIdx ? C.green + '  › ' : '    ') + name + (a ? C.dim + '  ' + a.provider + '/' + a.model + C.reset : '') + cur + C.reset)
    })
    lines.push('')
    lines.push(C.dim + '  providers' + C.reset)
    p.providers.forEach((pr, i) => {
      lines.push((p.focus === 'prov' && i === p.provIdx ? C.green + '  › ' : '    ') + pr.name + C.reset)
    })
    lines.push('')
    lines.push(C.dim + '  models' + C.reset)
    if (!p.models.length) lines.push(C.dim + '    loading…' + C.reset)
    p.models.forEach((m, i) => {
      const mark = p.focus === 'model' && i === p.modelIdx ? C.green + '  › ' : '    '
      const cur = m.id === displayModel.model ? C.dim + '  (current)' + C.reset : ''
      lines.push(mark + m.name + C.dim + '  ' + m.id + C.reset + cur)
    })
    return lines
  }

  function histLines() {
    const lines = []
    lines.push(C.bright + '  ─ history search: ' + C.reset + C.green + histSearch.q + C.reset + C.bright + ' ─ (↑↓ select · Enter restore · Esc close)' + C.reset)
    lines.push('')
    if (!histSearch.matches.length) {
      lines.push(C.dim + '    no matches' + C.reset)
    } else {
      histSearch.matches.forEach((m, i) => {
        lines.push((i === histSearch.idx ? C.green + '  › ' : '    ') + truncate(m, W - 12) + (i === histSearch.idx ? C.reset : C.dim + C.reset))
      })
    }
    return lines
  }

  function menuLines() {
    const lines = []
    lines.push(C.bright + '  ─ commands: ' + C.reset + C.green + cmdMenu.q + C.reset + C.bright + ' ─ (type to filter · ↑↓ · Enter/Tab complete · Esc close)' + C.reset)
    lines.push('')
    cmdMenu.matches.forEach((m, i) => {
      lines.push((i === cmdMenu.idx ? C.green + '  › ' : '    ') + m.name + C.dim + '  ' + m.desc + (i === cmdMenu.idx ? '' : '') + C.reset)
    })
    return lines
  }

  function resumeLines() {
    const lines = []
    lines.push(C.bright + '  ─ 恢复会话: ' + C.reset + C.green + resumePick.q + C.reset + C.bright + ' ─ (↑↓ 选择 · Enter 恢复 · d 删除(dash-*) · Esc 关闭)' + C.reset)
    lines.push('')
    if (resumePick.loading) {
      lines.push(C.dim + '    loading titles…' + C.reset)
    }
    const list = resumePickFiltered()
    if (!list.length) {
      lines.push(C.dim + '    no sessions' + C.reset)
    } else {
      list.forEach((it, i) => {
        const t = new Date(it.time)
        const ts = String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
        const title = it.title || it.id
        const mark = i === resumePick.idx ? C.green + '  › ' : '    '
        lines.push(mark + truncate(title, W - 34) + C.dim + '  ' + ts + (it.cwd ? '  ' + it.cwd.split('/').slice(-2).join('/') : '') + C.reset)
      })
    }
    return lines
  }

  function rewindLines() {
    const lines = []
    lines.push(C.bright + '  ⏪ 时间回溯: ' + C.reset + C.green + rewind.q + C.reset + C.bright + ' ─ (↑↓ 选择 · Enter 回滚重发 · Esc 取消)' + C.reset)
    lines.push('')
    if (!rewind.matches.length) {
      lines.push(C.dim + '    no matches' + C.reset)
    } else {
      rewind.matches.forEach((m, i) => {
        lines.push((i === rewind.idx ? C.green + '  › ' : '    ') + truncate(m.text, W - 12) + (i === rewind.idx ? C.reset : C.dim + C.reset))
      })
    }
    return lines
  }

  /** Wrap draft text into display lines with char ranges for cursor placement. */
  function wrapDraft(width) {
    const lines = []
    let cur = ''
    let curW = 0
    let start = 0
    for (let i = 0; i < draft.text.length; i++) {
      const ch = draft.text[i]
      if (ch === '\n') {
        lines.push({ text: cur, start, end: start + cur.length })
        cur = ''
        curW = 0
        start = i + 1
        continue
      }
      const w = charWidth(ch)
      if (curW + w > width) {
        lines.push({ text: cur, start, end: start + cur.length })
        cur = ch
        curW = w
        start = i
        continue
      }
      cur += ch
      curW += w
    }
    lines.push({ text: cur, start, end: start + cur.length })
    return lines
  }

  function buildFrame() {
    const frame = []
    const modelTxt = displayModel.provider ? displayModel.provider + '/' + displayModel.model : '—'
    const stateDot = busy ? C.yellow + '● streaming' + C.reset : C.green + '● idle' + C.reset
    const titleTxt = sessionTitle ? C.dim + ' · ' + truncate(sessionTitle, 32) + C.reset : ''
    frame.push(C.bright + ' DASH' + C.reset + C.dim + '  Deepseek Agentic Service Harness  ' + C.reset + C.purple + modelTxt + C.reset + titleTxt + '   ' + stateDot)

    // editor block (up to 4 wrapped lines)
    const draftLines = wrapDraft(W - 4)
    const maxShown = Math.min(draftLines.length, 4)
    const shown = draftLines.slice(-maxShown)
    const vis = Math.max(3, H - 3 - maxShown)

    let content = []
    let unread = 0
    if (helpOpen) content = helpLines()
    else if (hub) content = hubLines()
    else if (picker) content = pickerLines()
    else if (resumePick) content = resumeLines()
    else if (settingsPick) content = settingsLines()
    else if (fileMenu) content = fileMenuLines()
    else if (rewind) content = rewindLines()
    else if (histSearch) content = histLines()
    else if (cmdMenu) content = menuLines()
    else {
      const lines = allLines()
      const max = Math.max(0, lines.length - vis)
      if (scroll > max) scroll = max
      const start = lines.length - vis - scroll
      content = lines.slice(Math.max(0, start), Math.max(0, start) + vis)
      if (!following) unread = Math.max(0, lines.length - (Math.max(0, start) + vis))
      if (!following && lastUserText) {
        // sticky "current prompt" header while browsing the transcript
        const sticky = C.yellow + '▍' + C.reset + C.dim + ' 当前提示词: ' + C.reset + truncate(lastUserText, W - 18)
        content = [sticky].concat(content.slice(0, vis - 1))
      }
    }
    for (let i = 0; i < vis; i++) frame.push(content[i] || '')

    const prompt = exitConfirm ? C.yellow + ' exit DASH? [y/n]' + C.reset : ''
    if (prompt) {
      frame.push(prompt)
      frame.push('')
    } else {
      shown.forEach((ln, i) => {
        const prefix = i === 0 ? C.green + '❯ ' + C.reset : C.dim + '  ' + C.reset
        frame.push(prefix + ln.text + C.reset)
      })
      for (let i = shown.length; i < maxShown; i++) frame.push('')
    }

    // status line A: context bar + metrics
    const effortTxt = (selection.current && selection.current.reasoningEffort) || ''
    const cachePct = cacheReadTotal + usage.in ? Math.round((cacheReadTotal / (cacheReadTotal + usage.in)) * 100) : 0
    const tpsTxt = tpsNow ? C.dim + ' ' + sparkline() + ' ' + tpsNow + ' tok/s' + C.reset : ''
    const cacheTxt = cacheReadTotal ? C.dim + ' · 缓存 ' + cachePct + '%' + C.reset : ''
    const effortTxtFull = effortTxt ? C.dim + ' · 思考 ' + effortTxt + C.reset : ''
    frame.push(contextBar(Math.max(16, Math.min(28, W - 66))) + tpsTxt + cacheTxt + effortTxtFull)

    // status line B: activity + queue + status + git/cwd/title
    let act = ''
    if (busy) {
      const spin = spinner[tick % spinner.length]
      if (activity && activity.phase === 'tool') {
        const secs = Math.floor((Date.now() - activity.startedAt) / 1000)
        act = C.yellow + spin + ' ⛭ ' + activity.label + (secs >= 1 ? ' · ' + secs + 's' : '') + C.reset + '  '
      } else {
        const nav = modelNarration()
        if (nav) act = C.purple + spin + ' ⏵ ' + nav + C.reset + '  '
        else {
          const phrase = thinkPhrases[Math.floor(tick / 12) % thinkPhrases.length]
          act = C.purple + spin + ' ' + phrase + C.reset + '  '
        }
      }
    } else if (activity && activity.phase === 'done') {
      const secs = Math.max(1, Math.round((Date.now() - activity.startedAt) / 1000))
      act = C.green + '✓ ' + turnTools + ' tools · ' + secs + 's' + C.reset + '  '
    }
    const usageTxt = C.dim + 'in ' + usage.in + ' · out ' + usage.out + C.reset
    const queueTxt = queue.length ? C.yellow + 'queue ' + queue.length + C.reset + ' ' : ''
    const unreadTxt = unread > 0 ? C.yellow + '↓ ' + unread + ' 新消息 (PgDn)' + C.reset + ' ' : ''
    const statusTxt = statusText ? (statusColor || C.green) + statusText + C.reset : ''
    let rightTxt = ''
    const cwdShort = (config.cwd || process.cwd()).split('/').slice(-2).join('/')
    if (W >= 100) {
      const bits = []
      if (gitBranch) bits.push('git:' + gitBranch)
      bits.push(cwdShort)
      if (sessionTitle) bits.push(truncate(sessionTitle, 16))
      rightTxt = C.dim + '  ' + bits.join(' · ') + C.reset
    }
    const hintTxt = C.dim + '  /help' + C.reset
    frame.push(act + usageTxt + '  ' + queueTxt + unreadTxt + statusTxt + hintTxt + rightTxt)
    return frame
  }

  function modelNarration() {
    // ⏵ model self-narration: last non-empty line of live reasoning
    if (!streaming || !rows[streaming.rowIdx]) return null
    const rz = rows[streaming.rowIdx].reasoning
    if (!rz) return null
    const lines = rz.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t) return truncate(t, 32)
    }
    return null
  }

  let prevFrame = []
  function flush() {
    const frame = buildFrame()
    const outBuf = []
    for (let i = 0; i < frame.length; i++) {
      if (prevFrame[i] !== frame[i]) outBuf.push('\x1b[' + (i + 1) + ';1H\x1b[2K' + frame[i])
    }
    for (let i = frame.length; i < prevFrame.length; i++) outBuf.push('\x1b[' + (i + 1) + ';1H\x1b[2K')
    prevFrame = frame
    // editor cursor
    const draftLines = wrapDraft(W - 4)
    const maxShown = Math.min(draftLines.length, 4)
    const shown = draftLines.slice(-maxShown)
    let cursorRow = H - 1 - maxShown
    let cursorCol = 3
    for (let i = 0; i < shown.length; i++) {
      const ln = shown[i]
      if (draft.cursor >= ln.start && draft.cursor <= ln.end) {
        cursorRow = H - 1 - (maxShown - 1 - i)
        cursorCol = (i === 0 ? 3 : 2) + strWidth(ln.text.slice(0, draft.cursor - ln.start))
        break
      }
    }
    outBuf.push('\x1b[' + Math.max(1, cursorRow) + ';' + Math.max(1, cursorCol) + 'H')
    out.write(outBuf.join(''))
  }

  let drawTimer = setInterval(() => {
    tick++
    if (tick % 750 === 0) refreshGitBranch()
    if (dirty) {
      dirty = false
      flush()
    }
  }, 40)

  // ── lifecycle ───────────────────────────────────────────────────────────
  let cleaned = false
  function teardownScreen() {
    try { out.write('\x1b[?25h\x1b[?1049l\x1b[0m') } catch (e) { /* ignore */ }
  }
  function setupScreen() {
    try {
      tin.setRawMode(true)
      tin.resume()
      out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H' + kittyPushRequest())
    } catch (e) { /* ignore */ }
  }
  async function teardown() {
    if (cleaned) return
    cleaned = true
    clearInterval(drawTimer)
    if (escTimer) clearTimeout(escTimer)
    try {
      tin.setRawMode(false)
      tin.pause()
    } catch (e) { /* ignore */ }
    teardownScreen()
    if (handle) await handle.dispose().catch(() => { /* ignore */ })
  }
  async function exitDash(code) {
    await teardown()
    process.exit(code)
  }
  function suspendDash() {
    // leave the alternate screen, stop raw mode, then raise SIGTSTP
    clearInterval(drawTimer)
    try { tin.setRawMode(false) } catch (e) { /* ignore */ }
    teardownScreen()
    process.once('SIGCONT', () => {
      const t = setInterval(() => {
        tick++
        if (dirty) { dirty = false; flush() }
      }, 40)
      drawTimer = t
      setupScreen()
      dirty = true
    })
    try { process.kill(process.pid, 'SIGTSTP') } catch (e) { /* ignore */ }
  }
  process.on('exit', () => {
    try { out.write('\x1b[?25h\x1b[?1049l\x1b[0m') } catch (e) { /* ignore */ }
  })
  process.on('SIGTERM', () => exitDash(0))
  process.on('SIGHUP', () => exitDash(0))
  out.on('resize', () => {
    W = out.columns || 100
    H = out.rows || 30
    dirty = true
  })

  try {
    tin.setRawMode(true)
    tin.resume()
    tin.setEncoding('utf8')
    tin.on('data', onData)
  } catch (e) {
    console.error('DASH: cannot enter raw mode (not a TTY?)', e)
    return
  }
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H' + kittyPushRequest())
  dirty = true

  boot(false)

  return teardown
}
