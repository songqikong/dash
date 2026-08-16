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
import { discoverPresets, mountPreset } from '@deepseek-ai/dsh-agent-presets'
import { KeyParser, buildKeyMap, keyId, kittyPushRequest, DEFAULT_ACTION_KEYS, ACTIONS } from './keys.js'
import { Draft } from './editor.js'
import { renderMarkdown } from './markdown.js'
import { loadKeybindingsConfig, loadConfig, saveConfig, getCfg, setCfg, loadRules, DASH_HOME, loadDshSettings, saveDshSettings } from './config.js'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type { LlmRuntime, TokenUsage, ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { KeyEvent } from './keys.js'
import type { TtsrRule } from './config.js'

// ── DSH service contracts (subset used by this plugin) ────────────────────
interface AgentDefaultModelService {
  currentSelection(): { provider?: string; model?: string }
}
interface CommandsService {
  execute(agent: Agent, command: string, signal: AbortSignal): Promise<{ output?: unknown } | null | undefined>
}
interface PlanModeService {
  get(agent: Agent): { active?: boolean } | undefined
  set(agent: Agent, active: boolean): string
}
interface SkillsService {
  list(options?: object): Promise<Array<{ name: string; description?: string }>>
}
interface SessionHeaderInfo {
  id: string
  createdAt?: number
  cwd?: string
}
interface SessionPersistenceService {
  list(): Promise<SessionHeaderInfo[]>
  locate(header: SessionHeaderInfo): { path?: string } | undefined
}
interface SessionQueryService {
  readTitle(id: string): Promise<{ title?: string } | null | undefined>
}
interface SessionTitleService {
  rename(session: Session, title: string): { title: string }
  get(session: Session): { title?: string } | undefined
}
interface SubagentEntry {
  kind: string
  id: string
  depth: number
  label: string
  mode: string
  activity: string
  hasChildren: boolean
}
interface SubagentsService {
  listDescendants(agentId: string): Promise<SubagentEntry[]>
  interrupt(id: string, options: { kind: string; agent: Agent }): unknown
  followup(agent: Agent, id: string, content: ContentBlock[], options: { source?: MessageSource; signal?: AbortSignal }): Promise<unknown>
}

// ── transcript rows ────────────────────────────────────────────────────────
interface UserRow {
  kind: 'user'
  text: string
  seq?: number
  ts?: number
}
interface AssistantRow {
  kind: 'assistant'
  text: string
  reasoning: string
  usage: TokenUsage | null
  streaming: boolean
  error: string | null
  meta?: string
}
interface ToolRow {
  kind: 'tool'
  callId: string
  name: string
  args: string
  status: 'running' | 'ok' | 'error'
  summary: string | null
  error: string | null
}
interface NoticeRow {
  kind: 'notice'
  text: string
}
interface HotkeyRow {
  kind: 'hotkey'
  action: string
  keys: string
  desc: string
}
type Row = UserRow | AssistantRow | ToolRow | NoticeRow | HotkeyRow

interface DraftLine {
  text: string
  start: number
  end: number
}

interface Activity {
  phase: string
  label?: string
  startedAt: number
}

interface Role {
  provider: string
  model: string
  reasoningEffort?: string
}

interface PickerState {
  roles: string[]
  roleIdx: number
  providers: Array<{ id: string; name: string }>
  provIdx: number
  models: Array<{ id: string; name: string }>
  modelIdx: number
  focus: 'role' | 'prov' | 'model'
  temp: boolean
}

interface HistSearchState {
  q: string
  matches: string[]
  idx: number
}

interface CmdMenuMatch {
  name: string
  desc: string
  score: number
}
interface CmdMenuState {
  q: string
  matches: CmdMenuMatch[]
  idx: number
  mode: 'cmd' | 'args' // 'args' = completing an argument of /cmd (zsh-style)
  cmd: string          // command being completed, without the leading '/'
  picked: string[]     // already-typed argument values
  argIdx: number       // index of the argument token under completion
  modelsCache: Array<{ id: string; name: string }> // async model list for /models
  modelsProv: string
}

interface ResumeItem {
  id: string
  cwd?: string
  time: number
  title: string
}
interface ResumePickState {
  items: ResumeItem[]
  idx: number
  q: string
  loading: boolean
}

interface SettingsPickState {
  tab: number
  query: string
  idx: number
  sectionFocus: boolean
  listRows: number
}

/** One settings row: either a section heading or a selectable setting. */
type SettingsRow =
  | { kind: 'heading'; name: string; tab: number }
  | { kind: 'item'; item: SettingDef; tab: number }

interface SettingDef {
  id: string
  label: string
  desc: string
  values: string[]
  current: () => string
  apply: (value: string) => void
  changed: () => boolean
}

interface SettingGroup {
  name: string
  items: SettingDef[]
}

interface SettingsTabDef {
  id: string
  label: string
  groups: SettingGroup[]
}

interface FileMenuState {
  dir: string
  base: string
  entries: string[]
  idx: number
  at: number
}

interface RewindState {
  q: string
  matches: UserRow[]
  idx: number
}

interface HubEntry {
  id: string
  depth: number
  label: string
  mode: string
  activity: string
  hasChildren: boolean
}
interface HubState {
  idx: number
  view: 'list' | 'detail' | 'steer'
  detailId: string | null
  q: string
}

interface Colors {
  reset: string
  dim: string
  green: string
  bright: string
  blue: string
  yellow: string
  amber: string
  red: string
  purple: string
  cyan: string
  italic: string
  bold: string
}

export const name = 'dash-tui'
export const inject: string[] = ['agents']

/** UI strings; the active language is `lang` in ~/.dash/config.yml (default en). */
const STRINGS: Record<string, { en: string; zh: string }> = {
  // status / notices
  'role.label': { en: 'role', zh: '角色' },
  'theme.set': { en: 'theme → ', zh: '主题 → ' },
  'status.cache': { en: 'cache', zh: '缓存' },
  'status.unread': { en: ' new (PgDn)', zh: ' 新消息 (PgDn)' },
  'sticky.prompt': { en: 'current prompt: ', zh: '当前提示词: ' },
  'todo.title': { en: 'todo', zh: '待办' },
  'trace.title': { en: 'event trace', zh: '事件轨迹' },
  'trace.events': { en: 'events', zh: '个事件' },
  'status.generating': { en: 'generating…', zh: '生成中…' },
  'boot.mountFailed': { en: 'mount failed', zh: '装载失败' },
  'ctx.compacting': { en: '🧹 compacting context…', zh: '🧹 上下文压缩中…' },
  'ctx.compacted': { en: '🧹 compaction complete', zh: '🧹 压缩完成' },
  'ctx.compactedShort': { en: '🧹 compacted', zh: '🧹 压缩' },
  'rename.done': { en: 'renamed: ', zh: '已重命名: ' },
  'init.injected': { en: 'Injected', zh: '已注入' },
  'init.chars': { en: 'chars', zh: '字符' },
  'init.none': { en: '(no AGENTS.md in cwd — baseline instructions come from DSH)', zh: '（cwd 无 AGENTS.md；基线指令由 DSH 自动发现）' },
  'init.steered': { en: 'steered', zh: '已注入' },
  'skills.none': { en: '(no skills available)', zh: '（无可用技能）' },
  'cmd.preset': { en: 'agent preset (standard/PTC/minimal/cordis)', zh: 'agent preset (标准/PTC/极简/创造)' },
  'rewind.none': { en: 'no messages to rewind', zh: '没有可回滚的消息' },
  'rewind.to': { en: 'rewound to: ', zh: '已回滚到: ' },
  'resume.deleteOnlyDash': { en: 'only dash-* sessions can be deleted', zh: '仅可删除 dash-* 会话' },
  'resume.deleted': { en: '🗑 deleted session ', zh: '🗑 已删除会话 ' },
  'resume.done': { en: 'resumed session ', zh: '已恢复会话 ' },
  'preset.deferred': { en: ' (takes effect after /new — this session already has messages)', zh: '（当前会话已有对话，/new 后生效）' },
  'common.current': { en: '(current)', zh: '（当前）' },
  'tab.hint': { en: 'tab: / opens commands, @ opens file completion', zh: 'tab: 输入 / 开命令菜单，@ 开文件补全' },
  'esc.again': { en: 'press Esc again for rewind (time travel)', zh: '再次按 Esc 进入时间回溯 (rewind)' },
  'ttsr.injected': { en: '⚠ rule injected: ', zh: '⚠ 注入规则: ' },
  'hub.interrupted': { en: '⏹ interrupted subagent ', zh: '⏹ 已中断子代理 ' },
  'hub.sent': { en: '✉ sent to ', zh: '✉ 已发送给 ' },
  'hub.empty': { en: '    no subagents (spawn them with the subagent tool)', zh: '    无子代理（用 subagent 工具产生）' },
  // overlays
  'preset.title': { en: 'session mode (agent preset)', zh: '会话模式 (agent preset)' },
  'preset.hint': { en: '↑↓ select · Enter apply · Esc close', zh: '↑↓ 选择 · Enter 应用 · Esc 关闭' },
  'filemenu.title': { en: '@ file completion', zh: '@ 文件补全' },
  'filemenu.hint': { en: '↑↓ · Enter insert · Esc cancel', zh: '↑↓ · Enter 插入 · Esc 取消' },
  'hub.detail': { en: 'subagent detail', zh: '子代理详情' },
  'hub.title': { en: 'Agent Hub', zh: 'Agent Hub' },
  'hub.detailHint': { en: 's send · x interrupt · Esc back', zh: 's 发送消息 · x 中断 · Esc 返回' },
  'hub.detailNote': { en: '    (recent messages in the transcript; s=send x=interrupt)', zh: '    （最近消息见转录；s=发送 x=中断）' },
  'hub.steer': { en: 'send message to subagent', zh: '发送消息给子代理' },
  'hub.steerHint': { en: 'Enter send · Esc cancel', zh: 'Enter 发送 · Esc 取消' },
  'hub.hint': { en: 'j/k · Enter detail · x interrupt · Esc close', zh: 'j/k · Enter 详情 · x 中断 · Esc 关闭' },
  'picker.title': { en: 'model selector', zh: '模型选择器' },
  'picker.hint': { en: 'Tab switch · j/k move · Enter drill/select · Esc close', zh: 'Tab 切栏 · j/k 移动 · Enter 下钻/选中 · Esc 关闭' },
  'picker.roles': { en: 'roles', zh: '角色' },
  'resume.title': { en: 'resume session', zh: '恢复会话' },
  'resume.hint': { en: '↑↓ select · Enter resume · d delete(dash-*) · Esc close', zh: '↑↓ 选择 · Enter 恢复 · d 删除(dash-*) · Esc 关闭' },
  'rewind.title': { en: 'rewind', zh: '时间回溯' },
  'rewind.hint': { en: '↑↓ select · Enter rewind & resend · Esc cancel', zh: '↑↓ 选择 · Enter 回滚重发 · Esc 取消' },
  'settings.title': { en: '─ settings ─  (saved to ~/.dash/config.yml)', zh: '─ settings ─  (写入 ~/.dash/config.yml)' },
  // splash
  'splash.tip': { en: 'Tip: /help for keys · /settings panel · /preset modes · double-Esc rewind', zh: 'Tip: /help 查看快捷键 · /settings 设置面板 · /preset 切换模式 · 双击 Esc 时间回溯' },
  'splash.tip1': { en: '/ commands · @ files', zh: '/ 命令菜单 · @ 文件补全' },
  'splash.tip2': { en: 'double-Esc rewind · Alt+M models', zh: 'Esc Esc 时间回溯 · Alt+M 模型' },
  'splash.tip3': { en: 'Ctrl+R history · Ctrl+G editor', zh: 'Ctrl+R 历史 · Ctrl+G 外部编辑器' },
  'splash.loading': { en: 'Loading…', zh: '加载中…' },
  'splash.noSessions': { en: '(no recent sessions)', zh: '（无历史会话）' },
  // help
  'help.esc': { en: 'interrupt · double-Esc rewind', zh: 'interrupt · 时间回溯 rewind' },
  'help.scroll': { en: 'scroll (sticky prompt + ↓N unread)', zh: 'scroll (置顶提示词栏 + ↓N 未读)' },
  'help.wheel': { en: 'wheel: scroll · move selection in lists', zh: '滚轮：滚动历史 · 列表中移动选择' },
  'help.wheelKey': { en: 'Mouse wheel', zh: '滚轮' },
  'help.at': { en: '@ file completion', zh: '@ 文件补全' },
  'help.atKey': { en: 'Tab (draft with @)', zh: 'Tab (draft 含 @)' },
  // settings defs
  'settings.group.theme': { en: 'Theme', zh: '主题' },
  'settings.group.display': { en: 'Display', zh: '显示' },
  'settings.group.thinking': { en: 'Thinking', zh: '思考' },
  'settings.group.advisor': { en: 'Advisor', zh: '顾问' },
  'settings.group.input': { en: 'Input', zh: '输入' },
  'settings.group.notify': { en: 'Notifications', zh: '通知' },
  'settings.group.startup': { en: 'Startup', zh: '启动' },
  'settings.lang.label': { en: 'Language', zh: '语言' },
  'settings.lang.desc': { en: 'Interface language (en/zh)', zh: '界面语言（en/zh）' },
  'settings.theme.label': { en: 'Theme', zh: '主题' },
  'settings.theme.desc': { en: 'Light/dark theme (saved to ~/.dash/config.yml)', zh: '浅色/深色主题（写入 ~/.dash/config.yml）' },
  'settings.colorblind.label': { en: 'Colorblind mode', zh: '色盲模式' },
  'settings.colorblind.desc': { en: 'Use blue instead of green for accents', zh: '用蓝色替代绿色作为强调色' },
  'settings.spinner.label': { en: 'Spinner preset', zh: 'spinner 帧' },
  'settings.spinner.desc': { en: 'Busy-indicator animation preset', zh: '忙碌指示器动画预设' },
  'settings.thinking.label': { en: 'Default thinking', zh: '默认思考深度' },
  'settings.thinking.desc': { en: 'Thinking level for new sessions (Shift+Tab cycles)', zh: '新会话的思考级别（Shift+Tab 可循环）' },
  'settings.hideThinking.label': { en: 'Hide thinking', zh: '隐藏思考块' },
  'settings.hideThinking.desc': { en: "Don't expand thinking while streaming (Ctrl+T toggles)", zh: '流式输出时不展开思考（Ctrl+T 切换）' },
  'settings.advisor.label': { en: 'Advisor notes', zh: 'advisor 点评' },
  'settings.advisor.desc': { en: 'Second model reviews every completed turn (/advisor)', zh: '每回合结束后由第二模型给出简短点评（/advisor）' },
  'settings.dblEsc.label': { en: 'Double-Esc', zh: '双击 Esc' },
  'settings.dblEsc.desc': { en: 'Idle double-Esc behavior (tree=fork-replay rewind, none=off)', zh: '空闲时双击 Esc 的行为（tree=时间回溯 fork 重放，none=禁用）' },
  'settings.followup.label': { en: 'Queue delivery', zh: '排队投递' },
  'settings.followup.desc': { en: 'How queued messages are delivered while streaming (all=merge into one)', zh: '流式期间排队消息的投递方式（all=合并为一条）' },
  'settings.bell.label': { en: 'Turn-end bell', zh: '回合结束铃' },
  'settings.bell.desc': { en: 'Ring the terminal bell when a turn ends', zh: '回合结束时终端响铃提醒' },
  'settings.busyEnter.label': { en: 'Enter while busy', zh: '流式中回车' },
  'settings.busyEnter.desc': { en: 'queue: follow-ups queue up · steer: send immediately, interrupting the current turn', zh: 'queue: 排队为后续消息 · steer: 立即发送并打断当前回合' },
  'settings.permission.label': { en: 'Permission preset', zh: '权限预设' },
  'settings.permission.desc': { en: 'Default sandbox/approval preset for new sessions (read-only · workspace-write · danger-full-access)', zh: '新会话默认沙箱/审批预设（只读 · 工作区写入 · 完全访问）' },
  'settings.shellTimeout.label': { en: 'Shell timeout', zh: '命令超时' },
  'settings.shellTimeout.desc': { en: 'Shell tool command timeout in milliseconds', zh: 'shell 工具命令超时（毫秒）' },
  'settings.shellOutput.label': { en: 'Shell output cap', zh: '命令输出上限' },
  'settings.shellOutput.desc': { en: 'Max output bytes per stream for the shell tool', zh: 'shell 工具单次输出字节上限' },
  'settings.parallel.label': { en: 'Parallel tool calls', zh: '并行工具调用' },
  'settings.parallel.desc': { en: 'Max parallel tool calls in the agent loop', zh: 'agent 循环最大并行工具数' },
  'settings.webSearchUses.label': { en: 'Web search uses', zh: '联网搜索次数' },
  'settings.webSearchUses.desc': { en: 'Max searches per web-search request', zh: '单次联网搜索请求的最大搜索次数' },
  'settings.group.general': { en: 'General', zh: '通用' },
  'settings.group.plugins': { en: 'Plugins', zh: '插件' },
  'settings.group.providers': { en: 'Providers', zh: '提供商' },
  'settings.defaultModel.label': { en: 'Default model', zh: '默认模型' },
  'settings.defaultModel.desc': { en: 'Current provider/model selection — Enter opens the model picker', zh: '当前提供商/模型选择 — 回车打开模型选择器' },
  'settings.defaultModel.hint': { en: 'choose a model', zh: '选择模型' },
  'settings.provider.desc': { en: 'Provider route from llm-pi-ai (settings.yaml) — Enter opens the model picker', zh: 'llm-pi-ai 提供商路由（settings.yaml）— 回车打开模型选择器' },
  'settings.autoResume.label': { en: 'Auto-resume', zh: '自动恢复' },
  'settings.autoResume.desc': { en: 'Resume the most recent dash-* session on startup', zh: '启动时自动恢复最近的 dash-* 会话' },
  'settings.preset.label': { en: 'Session mode', zh: '会话模式' },
  'settings.preset.desc': { en: 'Agent preset: standard / PTC / minimal / cordis (minimal = bash + str_replace_editor only)', zh: 'agent preset：standard 标准 / code PTC / minimal 极简 / cordis 创造（minimal 仅 bash + str_replace_editor 双工具）' },
  // relative time
  'time.justNow': { en: 'just now', zh: '刚刚' },
  'time.minAgo': { en: 'min ago', zh: '分钟前' },
  'time.hrAgo': { en: 'hr ago', zh: '小时前' },
  'time.dAgo': { en: 'd ago', zh: '天前' },
}

export interface DashConfig {
  provider?: string
  model?: string
  cwd?: string
}

/** Stringify an unknown thrown value the way the JS original did (message when present). */
function emsg(e: unknown): string {
  return String((e && (e as { message?: unknown }).message) || e)
}

export function apply(ctx: Context, config: DashConfig = {}): (() => Promise<void>) | undefined {
  let lang: 'en' | 'zh' = getCfg(loadConfig(), 'lang', 'en') === 'zh' ? 'zh' : 'en'
  const tr = (key: string): string => (STRINGS[key] && STRINGS[key][lang]) || key
  const cfg = loadConfig()
  const llm: LlmRuntime | undefined = ctx.get('llm')
  const adm: AgentDefaultModelService | undefined = ctx.get('agentDefaultModel')
  const commands: CommandsService | undefined = ctx.get('commands')
  const planModeSvc: PlanModeService | undefined = ctx.get('planMode')
  // note: session* services register asynchronously during concurrent row
  // activation, so they are fetched at use time, never at apply time.

  const keyMap: Map<string, string[]> = buildKeyMap(loadKeybindingsConfig())

  // ── terminal ────────────────────────────────────────────────────────────
  const out = process.stdout
  const tin = process.stdin
  let W = out.columns || 100
  let H = out.rows || 30
  let kittyMode = false

  function charWidth(ch: string): number {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) return 2
    return 1
  }
  function strWidth(s: string): number {
    let w = 0
    for (const ch of s) w += charWidth(ch)
    return w
  }
  function wrapTo(s: string, width: number): string[] {
    const lines: string[] = []
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
  function truncate(s: string, width: number): string {
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
  /** Truncate by visible width while preserving ANSI SGR sequences verbatim. */
  function truncateAnsi(s: string, width: number): string {
    let out = ''
    let w = 0
    let i = 0
    while (i < s.length) {
      if (s[i] === '\x1b') {
        const m = s.slice(i).match(/^\x1b\[[0-9;]*m/)
        if (m) { out += m[0]; i += m[0].length; continue }
      }
      const cw = charWidth(s[i])
      if (w + cw > width) return out + '…'
      out += s[i]
      w += cw
      i++
    }
    return out
  }
  function padRight(s: string, width: number): string {
    const w = strWidth(s)
    return w >= width ? s : s + ' '.repeat(width - w)
  }

  // ── theme ────────────────────────────────────────────────────────────────
  const THEMES: Record<string, { name: string; fg: number; dim: number; accent: number; green: number; blue: number; yellow: number; amber: number; red: number; purple: number; cyan: number }> = {
    dark: { name: 'dark', fg: 254, dim: 245, accent: 78, green: 121, blue: 117, yellow: 222, amber: 229, red: 203, purple: 141, cyan: 81 },
    light: { name: 'light', fg: 237, dim: 244, accent: 29, green: 28, blue: 25, yellow: 130, amber: 94, red: 124, purple: 91, cyan: 30 },
  }
  let C: Colors = { reset: '', dim: '', green: '', bright: '', blue: '', yellow: '', amber: '', red: '', purple: '', cyan: '', italic: '', bold: '' }
  const fg256 = (n: number) => '\x1b[38;5;' + n + 'm'
  function applyTheme(): void {
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
    if (cfg.colorBlindMode) { const g = C.green; C.green = C.blue; C.blue = g }
    try { dirty = true } catch (e) { /* dirty declared later */ }
  }

  // ── state ───────────────────────────────────────────────────────────────
  let rows: Row[] = []
  const draft = new Draft()
  let busy = false
  let streaming: { rowIdx: number } | null = null
  let usage: { in: number; out: number } = { in: 0, out: 0 }
  let displayModel: { provider: string; model: string } = { provider: '', model: '' }
  let temporaryModel: { provider: string; model: string } | null = null
  let scroll = 0
  let following = true
  let dirty = true
  applyTheme()
  let tick = 0
  let queue: string[] = []
  let history: string[] = []
  let helpOpen = false
  let exitConfirm = false
  let showReasoning = true
  let verboseTools = false
  let showTools = true
  let picker: PickerState | null = null
  let histSearch: HistSearchState | null = null
  let cmdMenu: CmdMenuState | null = null
  let pasteBuf: string | null = null
  let jumpChar: number | null = null
  let statusText = ''
  let statusColor: string | null = null
  let agent: Agent | null = null
  let handle: AgentHandle | null = null
  let bootTries = 0
  let lastUserText = ''
  let lastTurnFailed = false
  let turnTools = 0
  let sendAt = 0 // when the last followup was sent — stuck-loading guard
  let turnStartedAt = 0
  let sessionStartAt = 0
  let sessionTitle = ''
  let todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = []
  let rewind: RewindState | null = null
  let trace: { ev: SessionEvent[]; scroll: number } | null = null
  let lastEscAt = 0
  let activity: Activity | null = null // {phase, label, startedAt}

  // ── batch-5 features ─────────────────────────────────────────────────────
  let hub: HubState | null = null          // agent hub panel {entries, idx, view, detailId, steer, q}
  let hubEntries: HubEntry[] = []          // [{id, depth, label, mode, activity, hasChildren}]
  let rules: TtsrRule[] = loadRules()      // TTSR rules
  let injectedRules = new Set<string>()
  let streamText = ''                      // accumulated text for TTSR matching
  let advisorEnabled = !!getCfg(cfg, 'advisor.enabled', false)
  let hubSteerText = ''

  // ── agent presets (standard / code / minimal / cordis) ──────────────────
  let presetId: string | null = getCfg(cfg, 'preset.id', null) || null
  let presets: AgentPreset[] = []
  let presetsLoaded = false
  let presetPick: { items: AgentPreset[]; idx: number; q: string } | null = null
  let followUpAll = getCfg(cfg, 'followUpMode', 'one-at-a-time') === 'all'
  let rewindEnabled = getCfg(cfg, 'doubleEscapeAction', 'tree') !== 'none'

  // ── metrics (status line) ────────────────────────────────────────────────
  let contextWindow = 0
  let reasoningTotal = 0
  let cacheReadTotal = 0
  let tpsNow = 0
  let tpsSamples: number[] = []
  let tpsBuf: { chars: number; start: number } = { chars: 0, start: 0 }
  let gitBranch = ''
  let gitCheckedAt = 0
  let currentRole = 'default'
  const ROLE_NAMES: string[] = ['default', 'smol', 'plan', 'task']
  const roles: Record<string, Role | null> = { default: null, smol: null, plan: null, task: null }
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
  const SPINNERS: Record<string, string[]> = {
    claude: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    dots: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
    moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    line: ['─', '\\', '|', '/'],
  }
  const spinnerName = (cfg.activity && cfg.activity.frames) || 'claude'
  let spinner = SPINNERS[spinnerName] || SPINNERS.claude
  const thinkPhrases = (): string[] => (lang === 'zh'
    ? ['嗯…让我捋捋', '想想怎么回', '组织一下语言', '分析中…', '深度思考中']
    : ['Hmm…', 'Thinking…', 'Reasoning…', 'Working on it…', 'Deep thinking…'])
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }

  function setStatus(text: string, color?: string | null): void {
    statusText = text
    statusColor = color || null
    dirty = true
  }

  // ── agent ───────────────────────────────────────────────────────────────
  async function boot(isNew: boolean, resumeId?: string): Promise<void> {
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
      let provs: Array<{ id: string; name: string }> = []
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
        setTimeout(() => boot(isNew, resumeId), 2000)
        return
      }
      rows.push({ kind: 'notice', text: '✗ no model configured — set DASH_PROVIDER / DASH_MODEL or patch agent-default-model' })
      dirty = true
      return
    }
    bootTries = 0
    busyEnterMode = String(getCfg(dshSettings(), 'ui-conversation.busyEnter', 'queue') || 'queue')
    // agent preset for this session (standard / code / minimal / cordis)
    await ensurePresets()
    const preset = await currentPreset()
    const setup = async (agentCtx: unknown): Promise<void> => {
      installModelSelection(agentCtx, selection)
      if (preset) {
        try {
          await mountPreset(agentCtx, preset)
        } catch (e) {
          rows.push({ kind: 'notice', text: '✗ preset ' + preset.id + ' ' + tr('boot.mountFailed') + ': ' + emsg(e) })
        }
      }
    }
    if (resumeId) {
      try {
        handle = await ctx.agents.resume({
          resumeSessionId: resumeId,
          agentOptions: { provider, model },
          setup,
        })
      } catch (e) {
        rows.push({ kind: 'notice', text: '✗ auto-resume failed: ' + emsg(e) })
        await boot(false)
        return
      }
      agent = handle.agent
      replayEvents(agent.session.events)
      usage = { in: 0, out: 0 }
      sessionTitle = ''
      const sessionTitleSvc: SessionTitleService | undefined = ctx.get('sessionTitle')
      if (sessionTitleSvc) {
        try {
          const snap = sessionTitleSvc.get(agent.session)
          if (snap && snap.title) sessionTitle = snap.title
        } catch (e) { /* ignore */ }
      }
      refreshGitBranch()
      dirty = true
      return
    }
    const sessionId = 'dash-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let created = false
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      try {
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: config.cwd || process.cwd(), agentPreset: preset ? preset.id : undefined },
          agentOptions: { provider, model },
          setup,
        })
        created = true
      } catch (e) {
        const msg = emsg(e)
        if (msg.includes('agent factory')) {
          await sleep(1000)
          continue
        }
        throw e
      }
    }
    if (!created || !handle) throw new Error('agent factory never became available')
    agent = handle.agent
    loadWelcomeSessions(true)
    sessionStartAt = Date.now()
    selection.current = { provider, model }
    const dtl = getCfg(cfg, 'defaultThinkingLevel', 'auto')
    if (dtl && dtl !== 'auto' && llm) {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const efforts = (info.reasoning && info.reasoning.efforts) || []
        if (efforts.some((e) => e.id === dtl)) selection.current = { provider, model, reasoningEffort: dtl }
      } catch (e) { /* ignore */ }
    }
    displayModel = { provider, model }
    usage = { in: 0, out: 0 }
    refreshGitBranch()
    dirty = true
  }

  function textOf(blocks: ContentBlock[] | null | undefined): string {
    if (!Array.isArray(blocks)) return ''
    const parts: string[] = []
    for (const b of blocks) if (b && b.type === 'text') parts.push(b.text)
    return parts.join('\n')
  }
  function reasoningOf(blocks: ContentBlock[] | null | undefined): string {
    if (!Array.isArray(blocks)) return ''
    const parts: string[] = []
    for (const b of blocks) if (b && b.type === 'reasoning') parts.push(b.text)
    return parts.join('\n')
  }

  function onSessionEvent(session: Session, event: SessionEvent): void {
    if (!agent || session.id !== agent.id) return
    switch (event.type) {
      case 'turn/start':
        busy = true
        sendAt = 0
        streaming = null
        turnTools = 0
        turnStartedAt = Date.now()
        activity = { phase: 'thinking', startedAt: Date.now() }
        break
      case 'user/message':
        if (event.data.source && event.data.source.kind === 'user') {
          rows.push({ kind: 'user', text: textOf(event.data.content), seq: event.seq, ts: event.time })
          dirty = true
        }
        break
      case 'assistant/chunk': {
        const c = event.data.chunk
        if (!streaming) {
          rows.push({ kind: 'assistant', text: '', reasoning: '', usage: null, streaming: true, error: null })
          streaming = { rowIdx: rows.length - 1 }
          activity = { phase: 'thinking', startedAt: Date.now() }
        }
        const row = rows[streaming.rowIdx] as AssistantRow
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
        const m = event.data.message
        const streamRow = streaming ? rows[streaming.rowIdx] : null
        if (streamRow && streamRow.kind === 'assistant' && streamRow.streaming) {
          streamRow.text = textOf(m.content) || streamRow.text
          streamRow.reasoning = reasoningOf(m.content) || streamRow.reasoning
          streamRow.usage = event.data.usage || streamRow.usage
          if (streamRow.usage) {
            usage.in += streamRow.usage.inputTokens || 0
            usage.out += streamRow.usage.outputTokens || 0
          }
          streamRow.streaming = false
          streamRow.meta = fmtMeta(event.time, turnStartedAt)
          if (streamRow.usage) {
            reasoningTotal += streamRow.usage.reasoningTokens || 0
            cacheReadTotal += streamRow.usage.cacheReadTokens || 0
          }
        }
        streaming = null
        dirty = true
        break
      }
      case 'tool/call':
        rows.push({ kind: 'tool', callId: event.data.callId, name: event.data.name, args: event.data.arguments, status: 'running', summary: null, error: null })
        turnTools++
        activity = { phase: 'tool', label: event.data.name, startedAt: Date.now() }
        dirty = true
        break
      case 'tool/result': {
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]
          if (r.kind === 'tool' && r.callId === event.data.callId) {
            r.status = event.data.error ? 'error' : 'ok'
            r.error = event.data.error ? event.data.error.name : null
            const t = textOf(event.data.message && event.data.message.content)
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
        const reason = event.data.reason
        busy = false
        sendAt = 0
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
          if (followUpAll) {
            const batch = queue.splice(0).join('\n')
            setTimeout(() => submitDraftWith(batch), 60)
          } else {
            const next = queue.shift()!
            setTimeout(() => submitDraftWith(next), 60)
          }
        }
        if (!lastTurnFailed && getCfg(cfg, 'notify.turnEnd', true) !== false) {
          try { out.write('\x07') } catch (e) { /* ignore */ }
        }
        if (reason.kind === 'completed') advisorNote()
        break
      }
      case 'request/context':
        displayModel = { provider: event.data.provider, model: event.data.model }
        contextWindow = event.data.contextWindow || contextWindow
        dirty = true
        break
      case 'session/title':
        if (event.data.title) sessionTitle = event.data.title
        dirty = true
        break
      case 'todo/write':
        todos = event.data.todos || []
        dirty = true
        break
      default:
        if (typeof event.type === 'string' && event.type.startsWith('compaction/')) {
          rows.push({ kind: 'notice', text: event.type === 'compaction/start' ? tr('ctx.compacting') : tr('ctx.compacted') })
          dirty = true
        }
        break
    }
    if (following) scroll = 0
  }
  ctx.on('session/event', onSessionEvent)

  function fmtMeta(ts: number, turnStart: number): string {
    const t = new Date(ts || Date.now())
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    const dur = turnStart ? Math.max(1, Math.round((ts - turnStart) / 1000)) : 0
    const model = displayModel.provider ? displayModel.provider + '/' + displayModel.model : ''
    return hh + ':' + mm + ':' + ss + (dur ? ' · ' + dur + 's' : '') + (model ? ' · ' + model : '')
  }

  // ── metrics helpers ──────────────────────────────────────────────────────
  function fmtTokens(v: number): string {
    if (!v) return '0'
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
    return String(v)
  }

  function sparkline(): string {
    if (!tpsSamples.length) return ''
    const max = Math.max(...tpsSamples, 1)
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
    let s = ''
    for (const v of tpsSamples.slice(-24)) {
      s += glyphs[Math.min(7, Math.floor((v / max) * 8))] || '▁'
    }
    return s
  }

  function refreshGitBranch(): void {
    const now = Date.now()
    if (now - gitCheckedAt < 30000) return
    gitCheckedAt = now
    try {
      execFile('git', ['branch', '--show-current'], { cwd: config.cwd || process.cwd(), timeout: 3000 }, (err, stdout) => {
        if (err) { gitBranch = ''; return }
        gitBranch = String(stdout).trim() || '(detached)'
        dirty = true
      })
    } catch (e) { /* ignore */ }
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function sendText(t: string): void {
    const text = String(t).trim()
    if (!text) return
    if (text.charAt(0) === '/') { runCommand(text); return }
    if (!agent) { setStatus('✗ agent not ready', C.red); return }
    if (busy) {
      if (busyEnterMode === 'steer' && agent) {
        // ui-conversation.busyEnter = steer: send immediately, interrupting the current turn
        try {
          agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dash-tui' } }))
          draft.text = ''
          draft.cursor = 0
          setStatus('steered', C.green)
          return
        } catch (e) { /* fall through to queue */ }
      }
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
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    } catch (e) {
      setStatus('✗ send failed: ' + emsg(e), C.red)
      return
    }
    // show the loading indicator immediately, before the first session event
    busy = true
    sendAt = Date.now()
    activity = { phase: 'thinking', startedAt: Date.now() }
    setStatus('')
    dirty = true
  }

  function submitDraft(): void {
    sendText(draft.text)
  }

  function submitDraftWith(text: string): void {
    sendText(text)
  }

  function queueFollowUp(): void {
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

  function dequeue(): void {
    if (!queue.length) { setStatus('nothing queued', C.yellow); return }
    const t = queue.pop()!
    draft.text = (draft.text ? draft.text + '\n' : '') + t
    draft.cursor = draft.text.length
    setStatus('dequeued')
  }

  function cancelRun(): void {
    if (agent && busy) {
      try { agent.cancel({ kind: 'user' }) } catch (e) { /* ignore */ }
      setStatus('stopping…', C.yellow)
    }
  }

  function clearScreen(): void {
    rows = []
    scroll = 0
    following = true
    setStatus('')
  }

  function setModel(provider: string, model: string): void {
    if (!provider || !model) return
    selection.current = { provider, model }
    displayModel = { provider, model }
    setStatus('model → ' + provider + '/' + model, C.green)
    dirty = true
  }

  async function cycleModel(dir: number): Promise<void> {
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
      setStatus('✗ ' + emsg(e), C.red)
    }
  }

  async function cycleThinking(): Promise<void> {
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
      setStatus('✗ ' + emsg(e), C.red)
    }
  }

  function roleAssignment(name: string): Role | null {
    const r = roles[name]
    if (r) return r
    return displayModel.provider ? { provider: displayModel.provider, model: displayModel.model } : null
  }

  function applyRole(name: string): void {
    const r = roleAssignment(name)
    if (!r) return
    currentRole = name
    const sel: ModelSelection = { provider: r.provider, model: r.model }
    if (r.reasoningEffort) sel.reasoningEffort = r.reasoningEffort
    selection.current = sel
    displayModel = { provider: r.provider, model: r.model }
    setStatus(tr('role.label') + ' → ' + name + ' · ' + r.provider + '/' + r.model, C.green)
    dirty = true
  }

  function persistRoles(): void {
    const out: Record<string, string> = {}
    for (const name of ROLE_NAMES) {
      const r = roles[name]
      if (r) out[name] = r.provider + '/' + r.model + (r.reasoningEffort ? ':' + r.reasoningEffort : '')
    }
    saveConfig({ ...cfg, modelRoles: out })
  }

  async function openPicker(temp: boolean): Promise<void> {
    if (!llm) return
    let providers: Array<{ id: string; name: string }> = []
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

  function loadPickerModels(provIdx: number, preferModel?: string): void {
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

  function pickerSelect(): void {
    const p = picker
    if (!p) return
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
      const prev = roles[roleName]
      const sel: ModelSelection = { provider: prov.id, model: m.id, reasoningEffort: prev ? prev.reasoningEffort : undefined }
      roles[roleName] = sel
      persistRoles()
      currentRole = roleName
      selection.current = sel
      displayModel = { provider: prov.id, model: m.id }
      setStatus(tr('role.label') + ' ' + roleName + ' → ' + prov.id + '/' + m.id, C.green)
    }
    picker = null
    dirty = true
  }

  async function runCommand(line: string): Promise<void> {
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
    if (cmd === 'preset') { await openPresetPicker(); return }
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
      const skillsSvc: SkillsService | undefined = ctx.get('skills')
      if (!skillsSvc) { setStatus('✗ skills unavailable', C.red); return }
      try {
        const list = await skillsSvc.list({})
        if (!list.length) rows.push({ kind: 'notice', text: tr('skills.none') })
        for (const s of list.slice(0, 20)) {
          rows.push({ kind: 'notice', text: '📚 ' + s.name + (s.description ? ' — ' + truncate(s.description, 80) : '') })
        }
      } catch (e) { setStatus('✗ skills: ' + emsg(e), C.red) }
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
          rows.push({ kind: 'notice', text: '📄 ' + tr('init.injected') + ' AGENTS.md (' + content.length + ' ' + tr('init.chars') + ')' })
        } catch (e) { setStatus('✗ inject failed', C.red) }
      } else {
        rows.push({ kind: 'notice', text: tr('init.none') })
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
        setStatus('/' + cmd + ' ' + tr('init.steered'), C.green)
      } catch (e) { setStatus('✗ steer failed', C.red) }
      return
    }
    if (cmd === 'resume') { openResume(); return }
    if (cmd === 'settings') { openSettings(); return }
    if (cmd === 'rename') {
      const sessionTitleSvc: SessionTitleService | undefined = ctx.get('sessionTitle')
      if (arg && sessionTitleSvc && agent) {
        try {
          const snap = sessionTitleSvc.rename(agent.session, arg)
          sessionTitle = snap.title
          setStatus(tr('rename.done') + snap.title, C.green)
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
        setStatus(tr('theme.set') + arg, C.green)
      } else setStatus('usage: /theme <dark|light>', C.yellow)
      return
    }
    if (cmd === 'role') {
      if (ROLE_NAMES.includes(arg)) applyRole(arg)
      else setStatus('usage: /role <' + ROLE_NAMES.join('|') + '>', C.yellow)
      return
    }
    if (cmd === 'lang') {
      if (arg === 'en' || arg === 'zh') {
        lang = arg
        setCfg(cfg, 'lang', lang)
        saveConfig(cfg)
        setStatus('lang → ' + lang, C.green)
      } else setStatus('usage: /lang <en|zh>', C.yellow)
      return
    }
    if (cmd === 'status') {
      refreshGitBranch()
      const cachePct = cacheReadTotal + usage.in ? Math.round((cacheReadTotal / (cacheReadTotal + usage.in)) * 100) : 0
      setStatus(tr('role.label') + ' ' + currentRole + ' · ' + displayModel.provider + '/' + displayModel.model +
        ' · in ' + usage.in + ' · out ' + usage.out +
        (reasoningTotal ? ' · think ' + reasoningTotal : '') +
        (cacheReadTotal ? ' · ' + tr('status.cache') + ' ' + cachePct + '%' : '') +
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

  function planToggle(): void {
    if (!planModeSvc || !agent) { setStatus('plan mode unavailable', C.yellow); return }
    const cur = planModeSvc.get(agent)
    const res = planModeSvc.set(agent, !(cur && cur.active))
    setStatus(res === 'committed' ? 'plan mode ON' : res === 'cancelled' ? 'plan mode OFF' : 'plan: ' + res, C.green)
  }

  async function newSession(): Promise<void> {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    const old = handle
    handle = null
    agent = null
    busy = false
    activity = null
    rows = []
    scroll = 0
    queue = []
    usage = { in: 0, out: 0 }
    if (old) await old.dispose().catch(() => { /* ignore */ })
    await boot(true)
    setStatus('new session…', C.green)
  }

  function retry(): void {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    if (!lastTurnFailed || !lastUserText) { setStatus('nothing to retry', C.yellow); return }
    sendText(lastUserText)
  }

  // ── fuzzy + dialogs ─────────────────────────────────────────────────────
  function fuzzyScore(q: string, s: string): number {
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

  function openHistSearch(): void {
    histSearch = { q: draft.text, matches: [], idx: 0 }
    updateHistMatches()
    dirty = true
  }

  function updateHistMatches(): void {
    if (!histSearch) return
    const q = histSearch.q.trim()
    const scored: Array<{ text: string; score: number }> = []
    for (const h of history) {
      if (!q) { scored.push({ text: h, score: 0 }); continue }
      const sc = fuzzyScore(q, h)
      if (sc >= 0) scored.push({ text: h, score: sc })
    }
    scored.sort((a, b) => a.score - b.score || b.text.length - a.text.length)
    histSearch.matches = scored.map((s) => s.text).slice(0, 100)
    histSearch.idx = Math.min(histSearch.idx, Math.max(0, histSearch.matches.length - 1))
  }

  const COMMAND_LIST: Array<[string, string]> = [
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
    ['/preset', tr('cmd.preset')],
    ['/plan', 'toggle plan mode'],
    ['/goal', 'goal commands (registry)'],
    ['/compact', 'compact context (registry)'],
    ['/rename <t>', 'rename this session'],
    ['/settings', 'settings panel'],
    ['/theme <dark|light>', 'switch theme'],
    ['/lang <en|zh>', 'switch UI language'],
    ['/status', 'session status'],
    ['/hotkeys', 'show active keybindings'],
    ['/exit', 'quit DASH'],
  ]

  function openCmdMenu(): void {
    cmdMenu = { q: '', matches: [], idx: 0, mode: 'cmd', cmd: '', picked: [], argIdx: 0, modelsCache: [], modelsProv: '' }
    void ensurePresets().then(() => { if (cmdMenu && cmdMenu.mode === 'args' && cmdMenu.cmd === 'preset') { updateMenuMatches(); dirty = true } })
    updateMenuQ()
    dirty = true
  }

  function updateMenuQ(): void {
    if (!cmdMenu) return
    const toks = draft.text.slice(1).split(/\s+/)
    const cmd = toks[0] || ''
    if (toks.length <= 1 || !cmd) {
      // still typing the command word itself
      cmdMenu.mode = 'cmd'
      cmdMenu.cmd = ''
      cmdMenu.q = cmd
      updateMenuMatches()
      return
    }
    // completing an argument of /cmd
    cmdMenu.mode = 'args'
    cmdMenu.cmd = cmd
    cmdMenu.argIdx = toks.length - 2
    cmdMenu.picked = toks.slice(1, -1)
    cmdMenu.q = toks[toks.length - 1]
    if (cmd === 'models' && cmdMenu.argIdx === 1 && cmdMenu.picked[0] && cmdMenu.picked[0] !== cmdMenu.modelsProv) {
      cmdMenu.modelsProv = cmdMenu.picked[0]
      cmdMenu.modelsCache = []
      loadMenuModels(cmdMenu.picked[0])
    }
    updateMenuMatches()
  }

  function cmdHasArgCandidates(cmd: string): boolean {
    return cmd === 'models' || cmd === 'lang' || cmd === 'theme' || cmd === 'role' || cmd === 'advisor' || cmd === 'preset'
  }

  /** Synchronous argument candidates for the command currently being completed. */
  function menuArgCandidates(): Array<[string, string]> {
    const m = cmdMenu
    if (!m || !m.cmd) return []
    if (m.cmd === 'models') {
      if (m.argIdx === 0) {
        try { return llm ? llm.listProviders().map((p) => [p.id, p.name || p.id] as [string, string]) : [] } catch (e) { return [] }
      }
      if (m.argIdx === 1) return m.modelsCache.map((x) => [x.id, x.name || x.id] as [string, string])
      return []
    }
    if (m.cmd === 'lang') return [['en', 'English'], ['zh', '中文']]
    if (m.cmd === 'theme') return [['dark', 'dark'], ['light', 'light']]
    if (m.cmd === 'role') return ROLE_NAMES.map((r) => [r, ''])
    if (m.cmd === 'advisor') return [['on', ''], ['off', '']]
    if (m.cmd === 'preset') return presets.map((p) => [p.id, p.name || ''])
    return []
  }

  function loadMenuModels(provId: string): void {
    if (!llm) return
    llm.listModels(provId).then((ms) => {
      if (cmdMenu && cmdMenu.cmd === 'models' && cmdMenu.modelsProv === provId) {
        cmdMenu.modelsCache = ms || []
        updateMenuQ()
        dirty = true
      }
    }).catch(() => { /* ignore */ })
  }

  function updateMenuMatches(): void {
    if (!cmdMenu) return
    const q = cmdMenu.q
    const scored: CmdMenuMatch[] = []
    const src = cmdMenu.mode === 'args' ? menuArgCandidates() : COMMAND_LIST
    for (const [name, desc] of src) {
      if (!q) { scored.push({ name, desc, score: 0 }); continue }
      const sc = fuzzyScore(q, name)
      if (sc >= 0) scored.push({ name, desc, score: sc })
    }
    scored.sort((a, b) => a.score - b.score)
    cmdMenu.matches = scored.slice(0, 40)
    cmdMenu.idx = Math.min(cmdMenu.idx, Math.max(0, cmdMenu.matches.length - 1))
  }

  /** Fill the selected candidate into the draft; for nested args (provider → model) stay open. */
  function acceptArg(m: CmdMenuMatch): void {
    const cm = cmdMenu
    if (!cm) return
    const toks = draft.text.slice(1).split(/\s+/)
    const prefix = '/' + toks.slice(0, -1).join(' ')
    draft.text = prefix + ' ' + m.name + ' '
    draft.cursor = draft.text.length
    if (cm.cmd === 'models' && cm.argIdx === 0) {
      // provider picked — reopen at the model level (list loads async)
      updateMenuQ()
      dirty = true
      return
    }
    cmdMenu = null
    dirty = true
  }

  function cmdMenuComplete(): void {
    if (!cmdMenu) return
    const m = cmdMenu.matches[cmdMenu.idx]
    if (!m) return
    if (cmdMenu.mode === 'args') { acceptArg(m); return }
    const cmdName = m.name.split(' ')[0].slice(1)
    const rest = draft.text.slice(1).split(/\s+/).slice(1).join(' ')
    draft.text = '/' + cmdName + (cmdHasArgCandidates(cmdName) ? ' ' : rest ? ' ' + rest : '')
    draft.cursor = draft.text.length
    if (cmdHasArgCandidates(cmdName)) {
      updateMenuQ() // enter argument completion mode
    } else {
      cmdMenu = null
    }
    dirty = true
  }

  function showHotkeys(): void {
    rows.push({ kind: 'notice', text: '— keybindings (remap in ~/.dash/keybindings.yml) —' })
    for (const [action, keys] of Object.entries(DEFAULT_ACTION_KEYS)) {
      const desc = (ACTIONS[action] && ACTIONS[action].desc) || ''
      rows.push({ kind: 'hotkey', action, keys: keys.join(' · '), desc })
    }
    dirty = true
  }

  // ── external editor ─────────────────────────────────────────────────────
  function externalEditor(): void {
    teardownScreen()
    const ok = draft.externalEdit()
    setupScreen()
    dirty = true
    setStatus(ok ? 'edited' : '✗ external editor failed', ok ? C.green : C.red)
  }

  // ── input dispatch ──────────────────────────────────────────────────────
  const parser = new KeyParser()
  let escTimer: ReturnType<typeof setTimeout> | null = null

  function armEscTimer(): void {
    if (escTimer) clearTimeout(escTimer)
    escTimer = setTimeout(() => {
      escTimer = null
      if (parser.partialEscape) {
        parser.dropPartial()
        onKeyEvent({ key: 'escape', char: null, ctrl: false, alt: false, shift: false, meta: false })
      }
    }, 50)
  }

  function onData(chunk: string): void {
    if (escTimer) { clearTimeout(escTimer); escTimer = null }
    parser.feed(chunk)
    for (const ev of parser.poll()) onKeyEvent(ev)
    if (parser.partialEscape) armEscTimer()
  }

  /** Wheel routing: open overlays move their selection; the transcript scrolls. */
  function wheelScroll(delta: number): void {
    if (settingsPick) {
      settingsPick.sectionFocus = false
      settingsMove(delta)
      dirty = true
      return
    }
    const ev: KeyEvent = { key: delta > 0 ? 'down' : 'up', char: null, ctrl: false, alt: false, shift: false, meta: false }
    if (hub) { hubKeys(ev); return }
    if (picker) { pickerKeys(ev); return }
    if (resumePick) { resumeKeys(ev); return }
    if (presetPick) { presetKeys(ev); return }
    if (fileMenu) { fileMenuKeys(ev); return }
    if (rewind) { rewindKeys(ev); return }
    if (trace) { traceKeys(ev); return }
    if (histSearch) { histKeys(ev); return }
    if (cmdMenu) { menuKeys(ev); return }
    scrollBy(delta * 3)
  }

  function onKeyEvent(ev: KeyEvent): void {    if (ev.key === 'paste-start') { pasteBuf = ''; return }
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
    // SGR mouse: wheel up/down scrolls the transcript or moves overlay selection
    if (ev.key === 'mouse') {
      if (!ev.pressed || ev.button == null) return
      const base = ev.button & 67   // wheel/button code, modifier bits (4/8/16/32) stripped
      const mods = ev.button & 60   // shift/meta/ctrl/alt
      if (base === 64 && !mods) wheelScroll(1)
      else if (base === 65 && !mods) wheelScroll(-1)
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
    if (presetPick) { presetKeys(ev); return }
    if (fileMenu) { fileMenuKeys(ev); return }
    if (rewind) { rewindKeys(ev); return }
    if (trace) { traceKeys(ev); return }
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
      // oh-my-pi behavior: a leading '/' (typed, pasted or batch-fed) opens the command menu
      if (!cmdMenu && draft.text.startsWith('/')) openCmdMenu()
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

  function pickerKeys(ev: KeyEvent): void {
    const p = picker
    if (!p) return
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

  function histKeys(ev: KeyEvent): void {
    if (!histSearch) return
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

  function menuKeys(ev: KeyEvent): void {
    if (!cmdMenu) return
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { cmdMenu = null; dirty = true; return }
    if (ev.key === 'enter') {
      const m = cmdMenu.matches[cmdMenu.idx]
      if (cmdMenu.mode === 'cmd' && m) {
        // Enter runs the highlighted command directly (omp /-menu behavior)
        const cmdName = m.name.split(' ')[0].slice(1)
        const rest = draft.text.slice(1).split(/\s+/).slice(1).join(' ')
        const line = '/' + cmdName + (rest ? ' ' + rest : '')
        cmdMenu = null
        sendText(line)
        return
      }
      if (cmdMenu.mode === 'args' && m) { acceptArg(m); return }
      // nothing highlighted — submit the full line
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
  function openRewind(): void {
    const userRows: UserRow[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.kind === 'user' && r.seq != null) userRows.push(r)
    }
    if (!userRows.length) { setStatus(tr('rewind.none'), C.yellow); return }
    rewind = { q: '', matches: userRows, idx: 0 }
    dirty = true
  }

  function rewindKeys(ev: KeyEvent): void {
    if (!rewind) return
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
  function replayEvents(events: SessionEvent[]): void {
    rows = []
    for (const e of events) {
      if (e.type === 'user/message' && e.data.source && e.data.source.kind === 'user') rows.push({ kind: 'user', text: textOf(e.data.content) })
      else if (e.type === 'assistant/message') {
        rows.push({ kind: 'assistant', text: textOf(e.data.message.content), reasoning: reasoningOf(e.data.message.content), usage: e.data.usage ?? null, streaming: false, error: null, meta: 'replay' })
      } else if (e.type === 'tool/call') {
        rows.push({ kind: 'tool', callId: e.data.callId, name: e.data.name, args: e.data.arguments, status: 'ok', summary: null, error: null })
      } else if (e.type === 'compaction/start') {
        rows.push({ kind: 'notice', text: tr('ctx.compactedShort') })
      }
    }
  }

  async function rewindTo(row: UserRow): Promise<void> {
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
    const preset = await currentPreset()
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: config.cwd || process.cwd(), parentSession: oldId ?? undefined, seedLength: seed.length, agentPreset: preset ? preset.id : undefined },
        seed,
        agentOptions: { provider: displayModel.provider, model: displayModel.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, selection)
          if (preset) {
            try { await mountPreset(agentCtx, preset) } catch (e) { /* keep rewinding without it */ }
          }
        },
      })
    } catch (e) {
      rows.push({ kind: 'notice', text: '✗ rewind failed: ' + emsg(e) })
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
    setStatus(tr('rewind.to') + truncate(row.text, 40), C.green)
    dirty = true
  }

  // ── session resume (/resume) ─────────────────────────────────────────────
  let resumePick: ResumePickState | null = null

  async function openResume(): Promise<void> {
    const sessionPersistence: SessionPersistenceService | undefined = ctx.get('sessionPersistence')
    const sessionQuery: SessionQueryService | undefined = ctx.get('sessionQuery')
    if (!sessionPersistence) { setStatus('✗ session persistence unavailable', C.red); return }
    let headers: SessionHeaderInfo[] = []
    try { headers = await sessionPersistence.list() } catch (e) {
      console.error('DASH debug list failed:', emsg(e))
    }
    console.error('DASH debug header count:', headers.length)
    // sort by artifact mtime desc; dash-* sessions first
    const withTime: Array<{ header: SessionHeaderInfo; mtime: number }> = []
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
    const items: ResumeItem[] = withTime.slice(0, 30).map((w) => ({ id: w.header.id, cwd: w.header.cwd, time: w.mtime, title: '' }))
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

  function resumePickFiltered(): ResumeItem[] {
    if (!resumePick) return []
    const q = resumePick.q.toLowerCase()
    return resumePick.items.filter((it) => !q || it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
  }

  function resumeKeys(ev: KeyEvent): void {
    if (!resumePick) return
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
        setStatus(tr('resume.deleteOnlyDash'), C.yellow)
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

  async function deleteSession(id: string): Promise<void> {
    const sessionPersistence: SessionPersistenceService | undefined = ctx.get('sessionPersistence')
    if (!sessionPersistence) return
    try {
      const hs = await sessionPersistence.list()
      const h = hs.find((x) => x.id === id)
      if (h) {
        const loc = sessionPersistence.locate(h)
        if (loc && loc.path && fs.existsSync(loc.path)) {
          fs.rmSync(loc.path, { recursive: true, force: true })
          rows.push({ kind: 'notice', text: tr('resume.deleted') + id })
        }
      }
    } catch (e) { /* ignore */ }
    openResume()
  }

  async function resumeSession(id: string): Promise<void> {
    if (busy) { setStatus('busy — stop first', C.yellow); return }
    resumePick = null
    activity = null
    const old = handle
    handle = null
    agent = null
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: displayModel.provider, model: displayModel.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, selection)
          const preset = await currentPreset()
          if (preset) {
            try { await mountPreset(agentCtx, preset) } catch (e) { /* keep resuming without it */ }
          }
        },
      })
    } catch (e) {
      rows.push({ kind: 'notice', text: '✗ resume failed: ' + emsg(e) })
      if (old) { handle = old; agent = old.agent }
      dirty = true
      return
    }
    if (old) await old.dispose().catch(() => { /* ignore */ })
    agent = handle.agent
    replayEvents(agent.session.events)
    sessionTitle = ''
    const sessionTitleSvc: SessionTitleService | undefined = ctx.get('sessionTitle')
    if (sessionTitleSvc) {
      try {
        const snap = sessionTitleSvc.get(agent.session)
        if (snap && snap.title) sessionTitle = snap.title
      } catch (e) { /* ignore */ }
    }
    usage = { in: 0, out: 0 }
    sessionStartAt = Date.now()
    setStatus(tr('resume.done') + id, C.green)
    dirty = true
  }

  // ── agent presets (standard / code / minimal / cordis) ──────────────────
  function presetRoots(): Array<{ path: string; trust: 'system' | 'user' }> {
    const roots: Array<{ path: string; trust: 'system' | 'user' }> = []
    try {
      const req = createRequire(import.meta.url)
      const pkg = req.resolve('@deepseek-ai/dsh/package.json')
      roots.push({ path: path.join(path.dirname(pkg), 'config', 'agent-presets'), trust: 'system' })
    } catch (e) { /* shipped presets unavailable */ }
    roots.push({ path: path.join(DASH_HOME, '.agent-presets'), trust: 'user' })
    return roots
  }

  async function ensurePresets(): Promise<void> {
    if (presetsLoaded) return
    presetsLoaded = true
    try {
      presets = await discoverPresets(presetRoots())
    } catch (e) { presets = [] }
  }

  async function currentPreset(): Promise<AgentPreset | null> {
    await ensurePresets()
    return presets.find((p) => p.id === (presetId || 'standard')) || presets.find((p) => p.id === 'standard') || presets[0] || null
  }

  async function openPresetPicker(): Promise<void> {
    await ensurePresets()
    if (!presets.length) { setStatus('✗ agent presets unavailable', C.red); return }
    presetPick = { items: presets, idx: 0, q: '' }
    dirty = true
  }

  function presetPickFiltered(): AgentPreset[] {
    if (!presetPick) return []
    const q = presetPick.q.toLowerCase()
    return presetPick.items.filter((p) => !q || (p.name || '').toLowerCase().includes(q) || p.id.includes(q) || (p.description || '').toLowerCase().includes(q))
  }

  function presetKeys(ev: KeyEvent): void {
    if (!presetPick) return
    const list = presetPickFiltered()
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { presetPick = null; dirty = true; return }
    if (ev.key === 'enter') {
      const p = list[presetPick.idx]
      if (p) applyPreset(p.id)
      presetPick = null
      dirty = true
      return
    }
    if (ev.key === 'up' && list.length) { presetPick.idx = Math.max(0, presetPick.idx - 1); dirty = true; return }
    if (ev.key === 'down' && list.length) { presetPick.idx = Math.min(list.length - 1, presetPick.idx + 1); dirty = true; return }
    if (ev.char !== null && !ev.ctrl && !ev.alt) { presetPick.q += ev.char; presetPick.idx = 0; dirty = true; return }
    if (ev.key === 'backspace') { presetPick.q = presetPick.q.slice(0, -1); presetPick.idx = 0; dirty = true; return }
  }

  function presetLines(): string[] {
    if (!presetPick) return []
    const lines: string[] = []
    lines.push(C.bright + '  ─ ' + tr('preset.title') + ': ' + C.reset + C.green + presetPick.q + C.reset + C.bright + ' ─ (' + tr('preset.hint') + ')' + C.reset)
    lines.push('')
    const list = presetPickFiltered()
    const idx = presetPick.idx
    if (!list.length) {
      lines.push(C.dim + '    no presets' + C.reset)
    } else {
      list.forEach((p, i) => {
        const cur = (presetId || 'standard') === p.id ? C.dim + '  ' + tr('common.current') + C.reset : ''
        const mark = i === idx ? C.green + '  › ' : '    '
        lines.push(mark + C.bright + (p.name || p.id) + C.reset + C.dim + '  ' + p.id + C.reset + cur)
        if (p.description) lines.push(C.dim + '      ' + p.description + C.reset)
      })
    }
    return lines
  }

  /** Session has no user turn yet: preset switches apply immediately. */
  function sessionBlank(): boolean {
    return !rows.some((r) => r.kind === 'user' && r.seq != null)
  }

  function applyPreset(id: string): void {
    const blank = sessionBlank()
    presetId = id
    setCfg(cfg, 'preset.id', id)
    saveConfig(cfg)
    if (blank && agent && !busy) {
      const old = handle
      handle = null
      agent = null
      rows = []
      scroll = 0
      queue = []
      usage = { in: 0, out: 0 }
      void (async () => {
        if (old) await old.dispose().catch(() => { /* ignore */ })
        await boot(true)
      })()
      setStatus('preset → ' + id, C.green)
    } else {
      setStatus(blank ? 'preset → ' + id : 'preset → ' + id + tr('preset.deferred'), blank ? C.green : C.yellow)
    }
    dirty = true
  }

  // ── settings panel (/settings, omp-style SettingsList) ──────────────────
  let settingsPick: SettingsPickState | null = null
  let dshSettingsCache: any = null
  let busyEnterMode = 'queue'

  /** Cached view of the official $DSH_HOME/settings.yaml (cleared on panel open). */
  function dshSettings(): any {
    if (!dshSettingsCache) dshSettingsCache = loadDshSettings()
    return dshSettingsCache
  }

  function saveDsh(ds: any): void {
    saveDshSettings(ds)
    dshSettingsCache = null
  }

  function openSettings(): void {
    dshSettingsCache = null
    settingsPick = { tab: 0, query: '', idx: 0, sectionFocus: false, listRows: 10 }
    settingsFirstItem()
    dirty = true
  }

  const BOOL_VALS = ['off', 'on']

  /** Providers from the official llm-pi-ai namespace in $DSH_HOME/settings.yaml. */
  function dshProviders(): Array<{ id: string; name: string; baseURL: string; models: number }> {
    const ds = dshSettings()
    const provs = getCfg(ds, 'llm-pi-ai.providers', null)
    if (!provs || typeof provs !== 'object') return []
    const out: Array<{ id: string; name: string; baseURL: string; models: number }> = []
    for (const [id, v] of Object.entries(provs)) {
      const p = (v || {}) as Record<string, unknown>
      out.push({
        id,
        name: String(p.displayName || p.name || id),
        baseURL: String(p.baseURL || ''),
        models: Array.isArray(p.models) ? p.models.length : 0,
      })
    }
    return out
  }

  function buildSettingsTabs(): SettingsTabDef[] {
    const def = (id: string, label: string, desc: string, values: string[], current: () => string, apply: (v: string) => void, changed: () => boolean): SettingDef =>
      ({ id, label, desc, values, current, apply, changed })
    const presetVals = presets.length ? presets.map((p) => p.id) : ['standard', 'code', 'minimal', 'cordis']
    return [
      {
        id: 'appearance',
        label: 'appearance',
        groups: [
          {
            name: tr('settings.group.theme'),
            items: [
              def('theme.light', tr('settings.theme.label'), tr('settings.theme.desc'), ['dark', 'light'],
                () => (getCfg(cfg, 'theme.light', false) ? 'light' : 'dark'),
                (v) => { setCfg(cfg, 'theme.light', v === 'light'); saveConfig(cfg); applyTheme() },
                () => !!getCfg(cfg, 'theme.light', false)),
              def('colorBlindMode', tr('settings.colorblind.label'), tr('settings.colorblind.desc'), BOOL_VALS,
                () => (cfg.colorBlindMode ? 'on' : 'off'),
                (v) => { setCfg(cfg, 'colorBlindMode', v === 'on'); saveConfig(cfg); applyTheme() },
                () => !!cfg.colorBlindMode),
            ],
          },
          {
            name: tr('settings.group.display'),
            items: [
              def('activity.frames', tr('settings.spinner.label'), tr('settings.spinner.desc'), ['claude', 'dots', 'moon', 'arrows', 'line'],
                () => (cfg.activity && cfg.activity.frames) || 'claude',
                (v) => { setCfg(cfg, 'activity.frames', v); saveConfig(cfg); spinner = SPINNERS[v] || SPINNERS.claude },
                () => !!(cfg.activity && cfg.activity.frames)),
              def('lang', tr('settings.lang.label'), tr('settings.lang.desc'), ['en', 'zh'],
                () => lang,
                (v) => { lang = v === 'zh' ? 'zh' : 'en'; setCfg(cfg, 'lang', lang); saveConfig(cfg) },
                () => lang !== 'en'),
            ],
          },
        ],
      },
      {
        id: 'model',
        label: 'model',
        groups: [
          {
            name: tr('settings.group.thinking'),
            items: [
              def('defaultThinkingLevel', tr('settings.thinking.label'), tr('settings.thinking.desc'), ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                () => String(getCfg(cfg, 'defaultThinkingLevel', 'auto') || 'auto'),
                (v) => {
                  setCfg(cfg, 'defaultThinkingLevel', v)
                  saveConfig(cfg)
                  if (selection.current) {
                    if (v === 'auto') delete selection.current.reasoningEffort
                    else selection.current.reasoningEffort = v
                  }
                },
                () => !!getCfg(cfg, 'defaultThinkingLevel', null)),
              def('hideThinkingBlock', tr('settings.hideThinking.label'), tr('settings.hideThinking.desc'), BOOL_VALS,
                () => (showReasoning ? 'off' : 'on'),
                (v) => { setCfg(cfg, 'hideThinkingBlock', v === 'on'); saveConfig(cfg); showReasoning = v === 'off' },
                () => !!getCfg(cfg, 'hideThinkingBlock', false)),
            ],
          },
          {
            name: tr('settings.group.advisor'),
            items: [
              def('advisor.enabled', tr('settings.advisor.label'), tr('settings.advisor.desc'), BOOL_VALS,
                () => (advisorEnabled ? 'on' : 'off'),
                (v) => { advisorEnabled = v === 'on'; setCfg(cfg, 'advisor.enabled', advisorEnabled); saveConfig(cfg) },
                () => advisorEnabled),
            ],
          },
          {
            name: tr('settings.group.providers'),
            items: [
              def('agent-default-model', tr('settings.defaultModel.label'), tr('settings.defaultModel.desc'), [''],
                () => (displayModel.provider ? displayModel.provider + '/' + displayModel.model : '—'),
                () => { void openPicker(false); setStatus(tr('settings.defaultModel.hint'), C.green) },
                () => false),
              ...dshProviders().map((pr) => def('llm-pi-ai.providers.' + pr.id, pr.name, tr('settings.provider.desc') + ' ' + pr.id + (pr.baseURL ? ' · ' + pr.baseURL : ''), [''],
                () => pr.models + ' models' + (pr.baseURL ? ' · ' + truncate(pr.baseURL, 22) : ''),
                () => { void openPicker(false); setStatus(pr.id + ' — ' + tr('settings.defaultModel.hint'), C.green) },
                () => false)),
            ],
          },
        ],
      },
      {
        id: 'interaction',
        label: 'interaction',
        groups: [
          {
            name: tr('settings.group.input'),
            items: [
              def('doubleEscapeAction', tr('settings.dblEsc.label'), tr('settings.dblEsc.desc'), ['tree', 'branch', 'none'],
                () => String(getCfg(cfg, 'doubleEscapeAction', 'tree') || 'tree'),
                (v) => { rewindEnabled = v !== 'none'; setCfg(cfg, 'doubleEscapeAction', v); saveConfig(cfg) },
                () => !!getCfg(cfg, 'doubleEscapeAction', null)),
              def('followUpMode', tr('settings.followup.label'), tr('settings.followup.desc'), ['one-at-a-time', 'all'],
                () => (followUpAll ? 'all' : 'one-at-a-time'),
                (v) => { followUpAll = v === 'all'; setCfg(cfg, 'followUpMode', v); saveConfig(cfg) },
                () => !!getCfg(cfg, 'followUpMode', null)),
            ],
          },
          {
            name: tr('settings.group.notify'),
            items: [
              def('notify.turnEnd', tr('settings.bell.label'), tr('settings.bell.desc'), BOOL_VALS,
                () => (getCfg(cfg, 'notify.turnEnd', true) === false ? 'off' : 'on'),
                (v) => { setCfg(cfg, 'notify.turnEnd', v === 'on'); saveConfig(cfg) },
                () => getCfg(cfg, 'notify.turnEnd', true) === false),
            ],
          },
          {
            name: tr('settings.group.startup'),
            items: [
              def('autoResume', tr('settings.autoResume.label'), tr('settings.autoResume.desc'), BOOL_VALS,
                () => (getCfg(cfg, 'autoResume', false) ? 'on' : 'off'),
                (v) => { setCfg(cfg, 'autoResume', v === 'on'); saveConfig(cfg) },
                () => !!getCfg(cfg, 'autoResume', false)),
            ],
          },
        ],
      },
      {
        id: 'session',
        label: 'session',
        groups: [
          {
            name: tr('settings.group.general'),
            items: [
              def('ui-conversation.busyEnter', tr('settings.busyEnter.label'), tr('settings.busyEnter.desc'), ['queue', 'steer'],
                () => busyEnterMode,
                (v) => {
                  busyEnterMode = v === 'steer' ? 'steer' : 'queue'
                  const ds = dshSettings()
                  setCfg(ds, 'ui-conversation.busyEnter', busyEnterMode)
                  saveDsh(ds)
                },
                () => busyEnterMode !== 'queue'),
              def('permission.defaultPreset', tr('settings.permission.label'), tr('settings.permission.desc'), ['read-only', 'workspace-write', 'danger-full-access'],
                () => String(getCfg(dshSettings(), 'permission.defaultPreset', 'workspace-write') || 'workspace-write'),
                (v) => {
                  const ds = dshSettings()
                  setCfg(ds, 'permission.defaultPreset', v)
                  saveDsh(ds)
                },
                () => !!getCfg(dshSettings(), 'permission.defaultPreset', null)),
            ],
          },
          {
            name: 'Agent',
            items: [
              def('preset.id', tr('settings.preset.label'), tr('settings.preset.desc'), presetVals,
                () => {
                  const cur = presetId || 'standard'
                  const p = presets.find((x) => x.id === cur)
                  return p ? (p.name || p.id) : cur
                },
                (v) => applyPreset(v),
                () => !!presetId),
            ],
          },
        ],
      },
      {
        id: 'plugins',
        label: 'plugins',
        groups: [
          {
            name: tr('settings.group.plugins'),
            items: [
              def('shell.timeoutMs', tr('settings.shellTimeout.label'), tr('settings.shellTimeout.desc'), ['60000', '120000', '300000', '600000'],
                () => String(getCfg(dshSettings(), 'shell.timeoutMs', 120000)),
                (v) => { const ds = dshSettings(); setCfg(ds, 'shell.timeoutMs', Number(v)); saveDsh(ds) },
                () => !!getCfg(dshSettings(), 'shell.timeoutMs', null)),
              def('shell.maxOutputBytes', tr('settings.shellOutput.label'), tr('settings.shellOutput.desc'), ['32768', '64000', '131072', '262144'],
                () => String(getCfg(dshSettings(), 'shell.maxOutputBytes', 64000)),
                (v) => { const ds = dshSettings(); setCfg(ds, 'shell.maxOutputBytes', Number(v)); saveDsh(ds) },
                () => !!getCfg(dshSettings(), 'shell.maxOutputBytes', null)),
              def('agent-loop.maxParallelToolCalls', tr('settings.parallel.label'), tr('settings.parallel.desc'), ['1', '4', '10', '20'],
                () => String(getCfg(dshSettings(), 'agent-loop.maxParallelToolCalls', 10)),
                (v) => { const ds = dshSettings(); setCfg(ds, 'agent-loop.maxParallelToolCalls', Number(v)); saveDsh(ds) },
                () => !!getCfg(dshSettings(), 'agent-loop.maxParallelToolCalls', null)),
              def('web-search-deepseek.maxUses', tr('settings.webSearchUses.label'), tr('settings.webSearchUses.desc'), ['1', '3', '5', '10'],
                () => String(getCfg(dshSettings(), 'web-search-deepseek.maxUses', 5)),
                (v) => { const ds = dshSettings(); setCfg(ds, 'web-search-deepseek.maxUses', Number(v)); saveDsh(ds) },
                () => !!getCfg(dshSettings(), 'web-search-deepseek.maxUses', null)),
            ],
          },
        ],
      },
    ]
  }

  /** Flat rows for the current view: per-tab with headings, or cross-tab search hits. */
  function settingsRows(): SettingsRow[] {
    const s = settingsPick
    if (!s) return []
    const tabs = buildSettingsTabs()
    if (s.query.trim()) {
      const q = s.query.toLowerCase()
      const rows: SettingsRow[] = []
      for (let ti = 0; ti < tabs.length; ti++) {
        for (const g of tabs[ti].groups) {
          for (const it of g.items) {
            const hay = (it.label + ' ' + it.id + ' ' + it.current() + ' ' + it.desc + ' ' + it.values.join(' ')).toLowerCase()
            if (hay.includes(q) || fuzzyScore(q, hay) >= 0) rows.push({ kind: 'item', item: it, tab: ti })
          }
        }
      }
      return rows
    }
    const t = tabs[Math.min(s.tab, tabs.length - 1)]
    const rows: SettingsRow[] = []
    for (const g of t.groups) {
      rows.push({ kind: 'heading', name: g.name, tab: s.tab })
      for (const it of g.items) rows.push({ kind: 'item', item: it, tab: s.tab })
    }
    return rows
  }

  function settingsFirstItem(): void {
    // selection never parks on a heading outside section-focus mode
    const s = settingsPick
    const rows = settingsRows()
    if (!s || s.sectionFocus || !rows.length) return
    if (rows[s.idx].kind === 'heading') {
      const next = rows.findIndex((r) => r.kind === 'item')
      if (next >= 0) s.idx = next
    }
  }

  function settingsMove(delta: number): void {
    const s = settingsPick
    const rows = settingsRows()
    if (!s || !rows.length) return
    let i = s.idx
    for (let step = 0; step < rows.length * 2; step++) {
      i = (i + delta + rows.length) % rows.length
      if (rows[i].kind === 'item') { s.idx = i; return }
    }
  }

  function settingsJumpSection(delta: number): void {
    const s = settingsPick
    const rows = settingsRows()
    if (!s || !rows.length) return
    const heads: number[] = []
    rows.forEach((r, i) => { if (r.kind === 'heading') heads.push(i) })
    if (heads.length < 2) {
      s.idx = Math.max(0, Math.min(s.idx + delta * Math.max(1, s.listRows), rows.length - 1))
      if (rows[s.idx].kind === 'heading') settingsMove(delta)
      return
    }
    let cur = 0
    for (let h = 0; h < heads.length; h++) if (heads[h] <= s.idx) cur = h
    const next = (cur + delta + heads.length) % heads.length
    s.idx = Math.min(heads[next] + 1, rows.length - 1)
    if (rows[s.idx].kind === 'heading') s.idx = Math.min(heads[next] + 2, rows.length - 1)
  }

  function settingsActivate(): void {
    const s = settingsPick
    const rows = settingsRows()
    if (!s || !rows.length) return
    const r = rows[Math.min(s.idx, rows.length - 1)]
    if (!r || r.kind === 'heading') return
    const item = r.item
    const i = item.values.indexOf(item.current())
    const next = item.values[(i + 1) % item.values.length]
    item.apply(next)
    dirty = true
  }

  function settingsKeys(ev: KeyEvent): void {
    const s = settingsPick
    if (!s) return
    const tabs = buildSettingsTabs()
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) {
      if (s.query) { s.query = ''; s.idx = 0; s.sectionFocus = false; dirty = true; return }
      if (s.sectionFocus) { s.sectionFocus = false; dirty = true; return }
      settingsPick = null
      dirty = true
      return
    }
    if (ev.key === 'backspace') {
      if (s.query) { s.query = s.query.slice(0, -1); s.idx = 0; s.sectionFocus = false; dirty = true }
      return
    }
    if (ev.char !== null && !ev.ctrl && !ev.alt && !ev.meta && !(ev.char === ' ' && !s.query)) {
      s.query += ev.char
      s.idx = 0
      s.sectionFocus = false
      dirty = true
      return
    }
    if (ev.key === 'enter' || (ev.char === ' ' && !ev.ctrl)) {
      if (s.sectionFocus) { s.sectionFocus = false; dirty = true }
      else settingsActivate()
      return
    }
    if (ev.key === 'up') { if (s.sectionFocus) settingsJumpSection(-1); else settingsMove(-1); dirty = true; return }
    if (ev.key === 'down') { if (s.sectionFocus) settingsJumpSection(1); else settingsMove(1); dirty = true; return }
    if (ev.key === 'pageup') { settingsJumpSection(-1); dirty = true; return }
    if (ev.key === 'pagedown') { settingsJumpSection(1); dirty = true; return }
    if (ev.key === 'tab') {
      const rows = settingsRows()
      if (s.query) {
        const curTab = rows[s.idx] && rows[s.idx].kind === 'item' ? rows[s.idx].tab : -1
        for (let t = curTab + 1; t < curTab + 1 + tabs.length; t++) {
          const hit = rows.findIndex((r) => r.kind === 'item' && r.tab === t % tabs.length)
          if (hit >= 0) { s.idx = hit; break }
        }
      } else if (buildSettingsTabs()[Math.min(s.tab, tabs.length - 1)].groups.length >= 2) {
        s.sectionFocus = !s.sectionFocus
        if (s.sectionFocus) {
          // park the cursor on the active section's heading
          const rr = settingsRows()
          let h = -1
          for (let i = 0; i <= Math.min(s.idx, rr.length - 1); i++) if (rr[i].kind === 'heading') h = i
          if (h >= 0) s.idx = h
        }
      } else {
        s.tab = (s.tab + 1) % tabs.length
        s.idx = 0
        s.sectionFocus = false
        settingsFirstItem()
      }
      dirty = true
      return
    }
    if (ev.key === 'left' || ev.key === 'right') {
      s.tab = (s.tab + (ev.key === 'left' ? -1 : 1) + tabs.length) % tabs.length
      s.idx = 0
      s.sectionFocus = false
      settingsFirstItem()
      dirty = true
      return
    }
  }

  function settingsLines(): string[] {
    const s = settingsPick
    if (!s) return []
    const tabs = buildSettingsTabs()
    const t = tabs[Math.min(s.tab, tabs.length - 1)]
    const rows = settingsRows()
    const avail = Math.max(8, H - 7)
    const banner = s.query ? 1 : 0
    const listRows = Math.max(3, avail - 2 - banner - 4 - 2 - (s.query ? 0 : 1))
    s.listRows = listRows
    const lines: string[] = []
    // title
    lines.push(C.bright + '  ─ ' + tr('settings.title') + C.reset)
    // tab bar
    lines.push('  ' + tabs.map((tb, i) => (i === s.tab ? C.green + tb.label + C.reset : C.dim + tb.label + C.reset)).join(' · '))
    // search banner
    if (banner) {
      const count = rows.length === 1 ? '1 match' : rows.length + ' matches'
      lines.push(C.dim + '  🔍 ' + C.reset + C.bold + s.query + C.reset + C.dim + ' ' + count + C.reset)
    }
    // split sidebar layout when 2+ sections and the pane can fit
    const split = !s.query && t.groups.length >= 2 && W - 12 - 2 >= 60
    let sidebarWidth = 0
    const maxLabel = Math.min(30, rows.reduce((m, r) => (r.kind === 'item' ? Math.max(m, strWidth(r.item.label)) : m), 0))
    const selRow = rows[Math.min(s.idx, rows.length - 1)]
    const selId = selRow && selRow.kind === 'item' ? selRow.item.id : null
    const activeGroup = selId ? t.groups.findIndex((g) => g.items.some((it) => it.id === selId)) : -1
    const start = rows.length > listRows ? Math.max(0, Math.min(s.idx - Math.floor(listRows / 2), rows.length - listRows)) : 0
    const visible = rows.slice(start, start + listRows)
    const listLines: string[] = []
    if (split) {
      let nameW = 0
      for (const g of t.groups) nameW = Math.max(nameW, strWidth(g.name))
      sidebarWidth = Math.min(22, nameW) + 4
    }
    for (const r of visible) {
      const i = rows.indexOf(r)
      const sel = i === s.idx
      if (r.kind === 'heading') {
        const gi = t.groups.findIndex((g) => g.name === r.name)
        const activeH = gi === activeGroup
        listLines.push((sel && s.sectionFocus ? C.green + '  › ' : '  ') + (activeH ? C.bright : C.dim) + r.name + C.reset)
        continue
      }
      const it = r.item
      const changed = it.changed()
      const rowW = split ? W - 6 - sidebarWidth - 2 : W - 6 // list column width, cursor included
      const vtxt = truncate(it.current(), Math.max(4, rowW - 4 - maxLabel))
      const mid = Math.max(1, rowW - 4 - maxLabel - strWidth(vtxt))
      const inActive = split && activeGroup >= 0 && !!t.groups[activeGroup] && t.groups[activeGroup].items.some((x) => x.id === it.id)
      if (split && !inActive && !sel) {
        // de-emphasized rows outside the active section render as plain text
        listLines.push(C.dim + (sel ? '  › ' : '    ') + it.label + ' '.repeat(Math.max(0, maxLabel - strWidth(it.label)) + mid) + vtxt + C.reset)
      } else {
        listLines.push((sel ? C.green + '  › ' : '    ') + C.bright + it.label + ' '.repeat(Math.max(0, maxLabel - strWidth(it.label)) + mid) + C.reset + (changed ? C.yellow : sel ? C.green : C.dim) + vtxt + C.reset)
      }
    }
    while (listLines.length < listRows) listLines.push('')
    if (split) {
      const side: string[] = []
      t.groups.forEach((g, gi) => {
        const label = truncate(g.name, sidebarWidth - 4)
        const activeS = gi === activeGroup
        const prefix = (s.sectionFocus && activeS ? C.green + '  › ' : '  ') + (activeS ? C.bright : C.dim) + label + C.reset
        side.push(prefix + ' '.repeat(Math.max(0, sidebarWidth - 2 - strWidth(label))))
      })
      const sep = C.dim + '│ ' + C.reset
      const height = Math.max(listLines.length, side.length)
      for (let i = 0; i < height; i++) {
        const left = side[i] || ' '.repeat(sidebarWidth)
        lines.push(truncateAnsi(left + sep + (listLines[i] || ''), W - 6))
      }
    } else {
      lines.push(...listLines)
    }
    // description area: 1 blank + exactly 3 rows
    lines.push('')
    const desc: string[] = []
    if (selRow && selRow.kind === 'item' && selRow.item.desc) {
      const wrapped = wrapTo(selRow.item.desc, W - 10)
      for (const ln of wrapped.slice(0, 3)) desc.push(C.dim + '  ' + ln + C.reset)
      if (wrapped.length > 3) desc[2] = C.dim + '  ' + truncate(wrapped[2], W - 12) + '…' + C.reset
    }
    while (desc.length < 3) desc.push('')
    lines.push(...desc)
    // search status / hint
    if (!s.query && rows.length > s.listRows) lines.push(C.dim + '  Type to search' + C.reset)
    lines.push('')
    const hint = s.query
      ? 'Enter to change · Tab to jump tabs · Esc to exit search'
      : s.sectionFocus
        ? '↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · Esc to close'
        : 'Enter/Space to change · ' + (t.groups.length >= 2 ? 'Tab to jump sections · ' : 'Tab to switch tabs · ') + 'Type to search · Esc to close'
    lines.push(C.dim + '  ' + hint + C.reset)
    while (lines.length < avail) lines.push('')
    return lines
  }

  // ── welcome splash (omp-style startup screen) ───────────────────────────
  let welcomeSessions: Array<{ id: string; time: number }> | null = null
  let welcomeTitles: Record<string, string> = {}

  function welcomeVisible(): boolean {
    // welcome screen only while the transcript is empty (or holds just the boot banner)
    return rows.length === 0 || (rows.length === 1 && rows[0].kind === 'notice')
  }

  function relTime(ts: number): string {
    const d = Date.now() - ts
    if (d < 60000) return tr('time.justNow')
    if (d < 3600000) return Math.floor(d / 60000) + ' ' + tr('time.minAgo')
    if (d < 86400000) return Math.floor(d / 3600000) + ' ' + tr('time.hrAgo')
    return Math.floor(d / 86400000) + ' ' + tr('time.dAgo')
  }

  function loadWelcomeSessions(force = false): void {
    if (welcomeSessions && !force) return
    welcomeSessions = null
    const sp: SessionPersistenceService | undefined = ctx.get('sessionPersistence')
    const sq: SessionQueryService | undefined = ctx.get('sessionQuery')
    void (async () => {
      try {
        if (!sp) { welcomeSessions = []; return }
        const headers = await sp.list()
        const withTime: Array<{ id: string; time: number }> = []
        for (const h of headers) {
          if (!h.id.startsWith('dash-')) continue
          let t = h.createdAt || 0
          try {
            const loc = sp.locate(h)
            if (loc && loc.path) t = fs.statSync(loc.path).mtimeMs
          } catch (e) { /* keep createdAt */ }
          withTime.push({ id: h.id, time: t })
        }
        withTime.sort((a, b) => b.time - a.time)
        welcomeSessions = withTime.slice(0, 4)
        if (sq) {
          await Promise.all(welcomeSessions.map(async (s) => {
            try {
              const t = await sq.readTitle(s.id)
              if (t && t.title) welcomeTitles[s.id] = t.title
            } catch (e) { /* ignore */ }
          }))
        }
        dirty = true
      } catch (e) { welcomeSessions = [] }
    })()
  }

  // heavy block DASH wordmark (ANSI Shadow style)
  const DASH_LOGO = [
    '  ██████╗   █████╗ ███████╗██╗  ██╗',
    '  ██╔══██╗ ██╔══██╗██╔════╝██║  ██║',
    ' ██║  ██║ ███████║███████╗███████║',
    '██║  ██║ ██╔══██║╚════██║██╔══██║',
    '██████╔╝██║  ██║███████║██║  ██║',
    '╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝',
  ]
  const ansiRe = /\x1b\[[0-9;]*m/g
  const plainW = (s: string) => strWidth(s.replace(ansiRe, ''))

  /** Display name of the active agent preset (splash + status line A). */
  function presetDisplayName(): string {
    const cur = presetId || 'standard'
    const p = presets.find((x) => x.id === cur)
    if (lang === 'zh') return p ? (p.name || p.id) : cur
    return { standard: 'Standard', code: 'PTC', minimal: 'Minimal', cordis: 'Cordis' }[cur] || cur
  }

  function splashLines(): string[] {
    const lines: string[] = []
    const boxW = Math.max(64, W - 2)
    const inner = boxW - 2
    const D = C.dim
    const center = (s: string) => {
      const w = plainW(s)
      const pad = Math.max(0, Math.floor((inner - w) / 2))
      return ' '.repeat(pad) + s + ' '.repeat(Math.max(0, inner - w - pad))
    }
    const row = (content: string) => D + '│' + C.reset + center(content) + D + '│' + C.reset
    const divider = row(D + '─'.repeat(inner) + C.reset)
    // single centered column: DASH wordmark + model · tips · preset · sessions
    lines.push(D + '┌───' + 'DASH v0.0.1' + '─'.repeat(Math.max(0, inner - 'DASH v0.0.1'.length - 3)) + '┐' + C.reset)
    lines.push(row(''))
    for (const lg of DASH_LOGO) lines.push(row(C.yellow + lg + C.reset))
    lines.push(row(''))
    const modelTxt = displayModel.model ? displayModel.model : '—'
    lines.push(row(C.bright + truncate(modelTxt, 40) + C.reset))
    lines.push(row(D + (displayModel.provider || '') + C.reset))
    lines.push(row(''))
    lines.push(divider)
    lines.push(row(D + 'Tips' + C.reset))
    for (const t of [tr('splash.tip1'), tr('splash.tip2'), tr('splash.tip3'), tr('splash.tip')]) lines.push(row(D + t + C.reset))
    lines.push(divider)
    lines.push(row(D + 'Agent preset' + C.reset))
    lines.push(row(C.green + presetDisplayName() + C.dim + ' (' + (presetId || 'standard') + ')' + C.reset))
    lines.push(divider)
    lines.push(row(D + 'Recent sessions' + C.reset))
    if (!welcomeSessions) {
      lines.push(row(D + tr('splash.loading') + C.reset))
    } else {
      const list = welcomeSessions.filter((s) => s.id !== (agent && agent.id)).slice(0, 4)
      if (!list.length) lines.push(row(D + tr('splash.noSessions') + C.reset))
      else for (const s of list) {
        const t = welcomeTitles[s.id] || s.id.slice(0, 24)
        lines.push(row(C.bright + '• ' + truncate(t, Math.max(8, inner - 20)) + C.reset + D + ' (' + relTime(s.time) + ')' + C.reset))
      }
    }
    lines.push(row(''))
    lines.push(D + '└' + '─'.repeat(Math.max(1, inner)) + '┘' + C.reset)
    return lines
  }

  // ── @ file completion ────────────────────────────────────────────────────
  let fileMenu: FileMenuState | null = null

  function openFileMenu(): boolean {
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
    let entries: string[] = []
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

  function fileMenuKeys(ev: KeyEvent): void {
    if (!fileMenu) return
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

  function fileMenuLines(): string[] {
    if (!fileMenu) return []
    const idx = fileMenu.idx
    const lines: string[] = []
    lines.push(C.bright + '  ─ ' + tr('filemenu.title') + ': ' + C.reset + C.green + (fileMenu.dir + fileMenu.base) + C.reset + C.bright + ' ─ (' + tr('filemenu.hint') + ')' + C.reset)
    lines.push('')
    fileMenu.entries.forEach((e, i) => {
      lines.push((i === idx ? C.green + '  › ' : '    ') + (i === idx ? C.green : C.bright) + e + C.reset)
    })
    return lines
  }

  // ── agent hub (Alt+A) ───────────────────────────────────────────────────
  async function openHub(): Promise<void> {
    const subs: SubagentsService | undefined = ctx.get('subagents')
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
      setStatus('✗ hub: ' + emsg(e), C.red)
      return
    }
    hub = { idx: 0, view: 'list', detailId: null, q: '' }
    dirty = true
  }

  function hubFiltered(): HubEntry[] {
    if (!hub) return []
    const q = hub.q.toLowerCase()
    return hubEntries.filter((e) => !q || e.label.toLowerCase().includes(q) || e.id.includes(q))
  }

  function hubKeys(ev: KeyEvent): void {
    if (!hub) return
    const list = hubFiltered()
    if (hub.view === 'detail') {
      if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { hub.view = 'list'; dirty = true; return }
      if (ev.char === 'x' && !ev.ctrl) {
        interruptChild(hub.detailId!)
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

  function interruptChild(id: string): void {
    const subs: SubagentsService | undefined = ctx.get('subagents')
    if (!subs || !agent) return
    try {
      subs.interrupt(id, { kind: 'ancestor', agent })
      rows.push({ kind: 'notice', text: tr('hub.interrupted') + id.slice(0, 12) })
    } catch (e) {
      setStatus('✗ interrupt: ' + emsg(e), C.red)
    }
    dirty = true
  }

  async function steerChild(id: string, text: string): Promise<void> {
    const subs: SubagentsService | undefined = ctx.get('subagents')
    if (!subs || !agent) return
    try {
      const source: MessageSource = { kind: 'user' }
      const msg = createUserMessage({ content: [{ type: 'text', text }], source })
      await subs.followup(agent, id, msg.content, { source, signal: AbortSignal.timeout(15000) })
      rows.push({ kind: 'notice', text: tr('hub.sent') + id.slice(0, 12) + ': ' + truncate(text, 40) })
    } catch (e) {
      setStatus('✗ steer: ' + emsg(e), C.red)
    }
    dirty = true
  }

  function hubLines(): string[] {
    if (!hub) return []
    const lines: string[] = []
    if (hub.view === 'detail') {
      lines.push(C.bright + '  ─ ' + tr('hub.detail') + ': ' + C.reset + C.green + (hub.detailId || '') + C.reset + C.bright + ' ─ (' + tr('hub.detailHint') + ')' + C.reset)
      lines.push('')
      const list = hubFiltered()
      const detailId = hub.detailId
      const e = list.find((x) => x.id === detailId) || hubEntries.find((x) => x.id === detailId)
      if (e) lines.push(C.dim + '    ' + e.label + ' · ' + e.mode + ' · ' + e.activity + C.reset)
      lines.push(C.dim + tr('hub.detailNote') + C.reset)
      return lines
    }
    if (hub.view === 'steer') {
      lines.push(C.bright + '  ─ ' + tr('hub.steer') + ': ' + C.reset + C.green + hubSteerText + '▌' + C.reset + C.bright + ' ─ (' + tr('hub.steerHint') + ')' + C.reset)
      return lines
    }
    lines.push(C.bright + '  ─ ' + tr('hub.title') + ': ' + C.reset + C.green + hub.q + C.reset + C.bright + ' ─ (' + tr('hub.hint') + ')' + C.reset)
    lines.push('')
    const list = hubFiltered()
    if (!list.length) {
      lines.push(C.dim + tr('hub.empty') + C.reset)
    } else {
      const idx = hub.idx
      list.forEach((e, i) => {
        const indent = '  ' + '  '.repeat(Math.min(e.depth, 4))
        const mark = i === idx ? C.green + '  › ' : '    '
        const status = e.activity === 'running' ? C.yellow + '● running' + C.reset : C.dim + '○ inactive' + C.reset
        lines.push(indent + mark + C.bright + e.label + C.reset + C.dim + '  ' + e.mode + (e.hasChildren ? ' · sub' : '') + C.reset + '  ' + status)
      })
    }
    return lines
  }

  // ── TTSR: time-traveling stream rules ────────────────────────────────────
  function checkRules(): void {
    if (!rules.length || !agent || !streamText) return
    for (const r of rules) {
      if (injectedRules.has(r.name)) continue
      if (r.re.test(streamText)) {
        injectedRules.add(r.name)
        rows.push({ kind: 'notice', text: tr('ttsr.injected') + r.name })
        try {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: r.message }], source: { kind: 'plugin', plugin: 'dash-tui' } }))
        } catch (e) { /* ignore */ }
        dirty = true
      }
    }
  }

  // ── advisor: second-model note on every completed turn ───────────────────
  function advisorNote(): void {
    if (!advisorEnabled || !llm || !agent) return
    // find last user + assistant texts
    let u = ''
    let a = ''
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (!a && r.kind === 'assistant' && !r.streaming) a = r.text
      else if (!u && r.kind === 'user') u = r.text
      if (u && a) break
    }
    if (!u || !a) return
    const system = 'You are the DASH advisor. Read the user prompt and the assistant reply, then give ONE concise note (under 60 words, in ' + (lang === 'zh' ? 'Chinese' : 'English') + ') pointing out anything the assistant missed, got wrong, or could improve. Prefix with "advisor: ".'
    const messages: Message[] = [
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

  function handleAction(action: string, ev: KeyEvent): boolean {
    switch (action) {
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
        else setStatus(tr('tab.hint'), C.yellow)
        return true
      }
      case 'app.interrupt': {
        if (busy) { cancelRun(); return true }
        if (!rewindEnabled) return true
        const now = Date.now()
        if (lastEscAt && now - lastEscAt < 350) {
          lastEscAt = 0
          openRewind()
        } else {
          lastEscAt = now
          setStatus(tr('esc.again'), C.yellow)
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
      case 'app.trace': openTrace(); return true
      case 'app.plan.toggle': planToggle(); return true
      case 'app.history.search': openHistSearch(); return true
      case 'app.session.observe': setStatus('session observe: coming in a later iteration', C.yellow); return true
      default:
        return false
    }
  }

  function maxScroll(): number {
    const draftLines = wrapDraft(W - 4)
    const maxShown = Math.min(draftLines.length, 4)
    const vis = Math.max(3, H - 3 - maxShown)
    return Math.max(0, allLines().length - vis)
  }

  function scrollBy(n: number): void {
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
  function allLines(): string[] {
    const w = W - 6
    const lines: string[] = []
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
        lines.push(C.purple + '  ' + padRight(r.action, 30) + C.reset + C.dim + r.keys + C.reset + C.dim + '  ' + r.desc + C.reset)
      } else {
        wrapTo(r.text, w).forEach((ln) => lines.push(C.amber + ln + C.reset))
      }
      lines.push('')
    }
    return lines
  }

  function helpLines(): string[] {
    const keys: Array<[string, string]> = [
      ['Enter', 'send · queue while streaming'],
      ['Shift+Enter / Ctrl+J', 'newline'],
      ['Ctrl+Enter / Ctrl+Q', 'queue follow-up'],
      ['Esc · Esc Esc', tr('help.esc')],
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
      ['PgUp/PgDn', tr('help.scroll')],
      [tr('help.wheelKey'), tr('help.wheel')],
      ['/help /new /resume /clear /models /plan', 'commands'],
      ['/goal /compact /rename /settings /theme', 'commands'],
      ['/role /hub /advisor /skills /init', 'commands'],
      ['/think /focus /status /hotkeys /exit', 'commands'],
      ['/preset /settings', 'agent preset · settings panel'],
      [tr('help.atKey'), tr('help.at')],
    ]
    const lines: string[] = []
    lines.push(C.bright + '  DASH — oh-my-pi TUI usage · DSH kernel' + C.reset)
    lines.push('')
    for (const [k, v] of keys) {
      lines.push(C.purple + '  ' + padRight(k, 28) + C.reset + C.dim + v + C.reset)
    }
    lines.push('')
    lines.push(C.dim + '  Esc to close · keybindings remap: ~/.dash/keybindings.yml' + C.reset)
    return lines
  }

  function pickerLines(): string[] {
    if (!picker) return []
    const lines: string[] = []
    const p = picker
    lines.push(C.bright + '  ─ ' + tr('picker.title') + (p.temp ? ' (temporary)' : '') + ' ─  (' + tr('picker.hint') + ')' + C.reset)
    lines.push('')
    lines.push(C.dim + '  ' + tr('picker.roles') + (p.roles[p.roleIdx] === currentRole && !p.temp ? '  ' + tr('common.current') : '') + C.reset)
    p.roles.forEach((name, i) => {
      const a = roleAssignment(name)
      const cur = name === currentRole && !p.temp ? C.dim + ' ◀' + C.reset : ''
      lines.push((p.focus === 'role' && i === p.roleIdx ? C.green + '  › ' : '    ') + C.bright + name + C.reset + (a ? C.dim + '  ' + a.provider + '/' + a.model + C.reset : '') + cur)
    })
    lines.push('')
    lines.push(C.dim + '  providers' + C.reset)
    p.providers.forEach((pr, i) => {
      lines.push((p.focus === 'prov' && i === p.provIdx ? C.green + '  › ' : '    ') + C.bright + pr.name + C.reset)
    })
    lines.push('')
    lines.push(C.dim + '  models' + C.reset)
    if (!p.models.length) lines.push(C.dim + '    loading…' + C.reset)
    p.models.forEach((m, i) => {
      const mark = p.focus === 'model' && i === p.modelIdx ? C.green + '  › ' : '    '
      const cur = m.id === displayModel.model ? C.dim + '  (current)' + C.reset : ''
      lines.push(mark + C.bright + m.name + C.reset + C.dim + '  ' + m.id + C.reset + cur)
    })
    return lines
  }

  function histLines(): string[] {
    if (!histSearch) return []
    const idx = histSearch.idx
    const lines: string[] = []
    lines.push(C.bright + '  ─ history search: ' + C.reset + C.green + histSearch.q + C.reset + C.bright + ' ─ (↑↓ select · Enter restore · Esc close)' + C.reset)
    lines.push('')
    if (!histSearch.matches.length) {
      lines.push(C.dim + '    no matches' + C.reset)
    } else {
      histSearch.matches.forEach((m, i) => {
        lines.push((i === idx ? C.green + '  › ' : '    ') + (i === idx ? C.green : C.bright) + truncate(m, W - 12) + C.reset)
      })
    }
    return lines
  }

  function menuLines(): string[] {
    if (!cmdMenu) return []
    const idx = cmdMenu.idx
    const lines: string[] = []
    if (cmdMenu.mode === 'args') {
      const path = '/' + cmdMenu.cmd + (cmdMenu.picked.length ? ' ' + cmdMenu.picked.join(' ') + ' ' : ' ')
      lines.push(C.bright + '  ─ ' + path + '…: ' + C.reset + C.green + cmdMenu.q + C.reset + C.bright + ' ─ (↑↓ · Enter/Tab accept · Esc close)' + C.reset)
    } else {
      lines.push(C.bright + '  ─ commands: ' + C.reset + C.green + cmdMenu.q + C.reset + C.bright + ' ─ (type to filter · ↑↓ · Enter run · Tab complete · Esc close)' + C.reset)
    }
    lines.push('')
    if (!cmdMenu.matches.length) {
      lines.push(C.dim + (cmdMenu.mode === 'args' && cmdMenu.cmd === 'models' && cmdMenu.argIdx === 1 ? '    loading models…' : '    no matches') + C.reset)
    }
    cmdMenu.matches.forEach((m, i) => {
      lines.push((i === idx ? C.green + '  › ' : '    ') + (i === idx ? C.green : C.bright) + m.name + C.reset + C.dim + '  ' + m.desc + C.reset)
    })
    return lines
  }

  /** Extract plain text from content blocks (text blocks only). */
  function blockText(c: ContentBlock[] | null | undefined): string {
    if (!c) return ''
    return c.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n')
  }

  /** Color-coded event trace (Ctrl+Tab), mirroring the web UI's timeline. */
  function traceLines(): string[] {
    const t = trace
    if (!t) return []
    const lines: string[] = []
    lines.push(C.bright + '  ─ ' + tr('trace.title') + C.reset + C.dim + ' · ' + t.ev.length + ' ' + tr('trace.events') + C.reset + C.bright + ' ─ (↑↓ · PgUp/PgDn · Esc close)' + C.reset)
    lines.push('')
    if (!t.ev.length) {
      lines.push(C.dim + '    no events' + C.reset)
      return lines
    }
    const names = new Map<string, string>()
    for (const e of t.ev) if (e.type === 'tool/call') names.set(e.data.callId, e.data.name)
    const rendered: string[] = []
    for (const ev of t.ev) rendered.push(traceLine(ev, names))
    const maxLines = Math.max(4, H - 7)
    const start = Math.max(0, rendered.length - maxLines - t.scroll)
    const end = Math.max(0, rendered.length - t.scroll)
    return lines.concat(rendered.slice(start, Math.max(start, end)))
  }

  function traceLine(ev: SessionEvent, names: Map<string, string>): string {
    const d = new Date(ev.time)
    const T = C.dim + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + C.reset + ' '
    const w = W - 14
    switch (ev.type) {
      case 'turn/start': return T + C.purple + '● turn ' + ev.data.turn + ' start' + C.reset
      case 'turn/end': {
        const bad = ev.data.reason.kind === 'error' || ev.data.reason.kind === 'max-tokens' || ev.data.reason.kind === 'failed'
        return T + (bad ? C.red : C.green) + '● turn ' + ev.data.turn + ' end · ' + ev.data.reason.kind + C.reset
      }
      case 'user/message': return T + C.blue + '┃ ' + C.reset + truncate(blockText(ev.data.content).replace(/\n/g, ' '), w)
      case 'assistant/message': {
        const txt = blockText(ev.data.message.content).replace(/\n/g, ' ') || '[tool calls]'
        return T + C.green + '◉ ' + C.reset + truncate(txt, w)
      }
      case 'tool/call': return T + C.yellow + '⛭ ' + ev.data.name + C.reset + C.dim + ' ' + truncate(ev.data.arguments.replace(/\s+/g, ' '), 48) + C.reset
      case 'tool/result': {
        if (ev.data.error) {
          return T + C.red + '✗ ' + (names.get(ev.data.callId || '') || 'tool') + C.reset + C.dim + ' ' + truncate(ev.data.error.code, 60) + C.reset
        }
        const txt = blockText(ev.data.message.content).replace(/\n/g, ' ')
        return T + C.green + '✓ ' + (names.get(ev.data.callId || '') || 'tool') + C.reset + C.dim + ' ' + truncate(txt, 60) + C.reset
      }
      case 'step/start': return T + C.dim + '▸ step ' + ev.data.step + ' · turn ' + ev.data.turn + C.reset
      case 'todo/write': {
        const parts = ev.data.todos.map((td) =>
          (td.status === 'completed' ? C.green + '✓' : td.status === 'in_progress' ? C.yellow + '⏳' : C.dim + '○') + C.reset +
          (td.status === 'in_progress' ? C.yellow : C.dim) + ' ' + td.content + C.reset)
        return T + C.cyan + '◐ todo' + C.reset + ' ' + truncate(parts.join(' · '), w + 8)
      }
      case 'request/context': return T + C.purple + '⚙ ' + ev.data.provider + '/' + ev.data.model + C.reset + (ev.data.contextWindow ? C.dim + ' · ctx ' + fmtTokens(ev.data.contextWindow) + C.reset : '')
      case 'session/title': return T + C.cyan + '🏷 ' + (ev.data.title || '') + C.reset
      case 'compaction/start': return T + C.amber + '🧹 compaction start' + C.reset
      case 'compaction/end': return T + C.amber + '🧹 compaction end' + C.reset
      default: return T + C.dim + String(ev.type) + C.reset
    }
  }

  function openTrace(): void {
    if (!agent || !agent.session) { setStatus('no session yet', C.yellow); return }
    trace = { ev: agent.session.events, scroll: 0 }
    dirty = true
  }

  function traceKeys(ev: KeyEvent): void {
    if (!trace) return
    if (ev.key === 'escape' || (ev.char === 'c' && ev.ctrl)) { trace = null; dirty = true; return }
    if (ev.key === 'up') { trace.scroll += 1; dirty = true; return }
    if (ev.key === 'down') { trace.scroll = Math.max(0, trace.scroll - 1); dirty = true; return }
    if (ev.key === 'pageup') { trace.scroll += 10; dirty = true; return }
    if (ev.key === 'pagedown') { trace.scroll = Math.max(0, trace.scroll - 10); dirty = true; return }
    if (ev.key === 'home') { trace.scroll = 1e9; dirty = true; return }
    if (ev.key === 'end') { trace.scroll = 0; dirty = true; return }
  }

  function resumeLines(): string[] {
    if (!resumePick) return []
    const idx = resumePick.idx
    const lines: string[] = []
    lines.push(C.bright + '  ─ ' + tr('resume.title') + ': ' + C.reset + C.green + resumePick.q + C.reset + C.bright + ' ─ (' + tr('resume.hint') + ')' + C.reset)
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
        const mark = i === idx ? C.green + '  › ' : '    '
        lines.push(mark + C.bright + truncate(title, W - 34) + C.reset + C.dim + '  ' + ts + (it.cwd ? '  ' + it.cwd.split('/').slice(-2).join('/') : '') + C.reset)
      })
    }
    return lines
  }

  function rewindLines(): string[] {
    if (!rewind) return []
    const idx = rewind.idx
    const lines: string[] = []
    lines.push(C.bright + '  ⏪ ' + tr('rewind.title') + ': ' + C.reset + C.green + rewind.q + C.reset + C.bright + ' ─ (' + tr('rewind.hint') + ')' + C.reset)
    lines.push('')
    if (!rewind.matches.length) {
      lines.push(C.dim + '    no matches' + C.reset)
    } else {
      rewind.matches.forEach((m, i) => {
        lines.push((i === idx ? C.green + '  › ' : '    ') + (i === idx ? C.green : C.bright) + truncate(m.text, W - 12) + C.reset)
      })
    }
    return lines
  }

  /** Wrap draft text into display lines with char ranges for cursor placement. */
  function wrapDraft(width: number): DraftLine[] {
    const lines: DraftLine[] = []
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

  function buildFrame(): string[] {
    const frame: string[] = []

    // editor block (up to 4 wrapped lines)
    const draftLines = wrapDraft(W - 4)
    const maxShown = Math.min(draftLines.length, 4)
    const shown = draftLines.slice(-maxShown)
    const vis = Math.max(3, H - 3 - maxShown)

    let content: string[] = []
    let unread = 0
    if (helpOpen) content = helpLines()
    else if (hub) content = hubLines()
    else if (picker) content = pickerLines()
    else if (resumePick) content = resumeLines()
    else if (settingsPick) content = settingsLines()
    else if (presetPick) content = presetLines()
    else if (fileMenu) content = fileMenuLines()
    else if (rewind) content = rewindLines()
    else if (trace) content = traceLines()
    else if (histSearch) content = histLines()
    else if (cmdMenu) content = menuLines()
    else if (welcomeVisible()) content = splashLines()
    else {
      const lines = allLines()
      const max = Math.max(0, lines.length - vis)
      if (scroll > max) scroll = max
      const start = lines.length - vis - scroll
      content = lines.slice(Math.max(0, start), Math.max(0, start) + vis)
      if (!following) unread = Math.max(0, lines.length - (Math.max(0, start) + vis))
      if (!following && lastUserText) {
        // sticky "current prompt" header while browsing the transcript
        const sticky = C.yellow + '▍' + C.reset + C.dim + ' ' + tr('sticky.prompt') + C.reset + truncate(lastUserText, W - 18)
        content = [sticky].concat(content.slice(0, vis - 1))
      }
      // omp-style pinned todo list: once the agent writes one it stays on
      // top of the transcript, never buried by new messages
      if (todos.length) {
        const block: string[] = [C.yellow + '▍' + C.reset + C.dim + ' ' + tr('todo.title') + C.reset]
        const shown = todos.slice(0, 4)
        for (const t of shown) {
          const ic = t.status === 'completed' ? C.green + '✓' : t.status === 'in_progress' ? C.yellow + '⏳' : C.dim + '○'
          const tc = t.status === 'in_progress' ? C.yellow : C.dim
          block.push('  ' + ic + C.reset + tc + ' ' + truncate(t.content, W - 10) + C.reset)
        }
        if (todos.length > 4) block.push(C.dim + '  +' + (todos.length - 4) + ' more' + C.reset)
        content = block.concat(content.slice(0, Math.max(0, vis - block.length)))
      }
      // loading indicator where the reply will appear
      if (busy && following) {
        const spin = spinner[tick % spinner.length]
        const load = C.yellow + spin + C.reset + C.dim + ' ' + tr('status.generating') + C.reset
        content = content.slice(0, Math.max(0, vis - 1)).concat([load])
      }
    }
    for (let i = 0; i < vis; i++) frame.push(content[i] || '')

    // status line A: model · effort · tokens · tps · cache · elapsed
    // (omp-style segments; the input sits below it, status line C above the bottom edge)
    const effortTxt = (selection.current && selection.current.reasoningEffort) || ''
    const cachePct = cacheReadTotal + usage.in ? Math.round((cacheReadTotal / (cacheReadTotal + usage.in)) * 100) : 0
    const tpsTxt = tpsNow ? C.dim + ' ' + sparkline() + ' ' + tpsNow + ' tok/s' + C.reset : ''
    const cacheTxt = cacheReadTotal ? C.dim + ' · ' + tr('status.cache') + ' ' + cachePct + '%' + C.reset : ''
    const effortTxtFull = effortTxt ? C.dim + ' · ◉ ' + effortTxt + C.reset : ''
    const elapsed = sessionStartAt ? Math.max(0, Math.floor((Date.now() - sessionStartAt) / 1000)) : 0
    const presetTxt = W >= 100 ? C.dim + ' · ' + C.reset + C.cyan + truncate(presetDisplayName(), 14) + C.reset : ''
    const elapsedTxt = C.dim + '⏱ ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') + C.reset
    // activity + queue + status: dim secondary line above the status bar
    let act = ''
    if (busy) {
      const spin = spinner[tick % spinner.length]
      if (activity && activity.phase === 'tool') {
        const secs = Math.floor((Date.now() - activity.startedAt) / 1000)
        act = C.yellow + spin + ' ⛭ ' + (activity.label ?? '') + (secs >= 1 ? ' · ' + secs + 's' : '') + C.reset
      } else {
        const nav = modelNarration()
        if (nav) act = C.purple + spin + ' ⏵ ' + nav + C.reset
        else {
          const phrases = thinkPhrases()
          const phrase = phrases[Math.floor(tick / 12) % phrases.length]
          act = C.purple + spin + ' ' + phrase + C.reset
        }
      }
    } else if (activity && activity.phase === 'done') {
      const secs = Math.max(1, Math.round((Date.now() - activity.startedAt) / 1000))
      act = C.green + '✓ ' + turnTools + ' tools · ' + secs + 's' + C.reset
    }
    const queueTxt = queue.length ? 'queue ' + queue.length : ''
    const unreadTxt = unread > 0 ? '↓ ' + unread + tr('status.unread') : ''
    const statusTxt = statusText ? (statusColor || C.green) + statusText + C.reset : ''
    // context-window indicator: usage/total + 10-cell bar
    let ctxTxt = ''
    if (contextWindow > 0) {
      const used = usage.in + usage.out
      const pct = Math.min(1, used / contextWindow)
      const filled = Math.round(pct * 10)
      ctxTxt = C.dim + 'ctx ' + C.reset + fmtTokens(used) + C.dim + '/' + fmtTokens(contextWindow) + C.reset + ' ' + C.purple + '█'.repeat(filled) + '░'.repeat(10 - filled) + C.reset
    }
    const cwdShort = (config.cwd || process.cwd()).split('/').slice(-2).join('/')
    const infoBits: string[] = []
    if (act) infoBits.push(act) // loading indicator first, far left
    if (usage.in || usage.out) infoBits.push('in ' + fmtTokens(usage.in) + ' · out ' + fmtTokens(usage.out))
    if (tpsNow) infoBits.push(sparkline() + ' ' + tpsNow + ' tok/s')
    if (cacheReadTotal) infoBits.push(tr('status.cache') + ' ' + cachePct + '%')
    if (queueTxt) infoBits.push(queueTxt)
    if (unreadTxt) infoBits.push(unreadTxt)
    if (statusTxt) infoBits.push(statusTxt)
    if (W >= 100) {
      const bits: string[] = []
      if (gitBranch) bits.push('git:' + gitBranch)
      if (sessionTitle) bits.push(truncate(sessionTitle, 16))
      if (bits.length) infoBits.push(C.dim + bits.join(' · ') + C.reset)
    }
    // secondary line: everything except the status-bar essentials, dimmed
    frame.push((infoBits.length ? C.dim : '') + ' ' + infoBits.join(C.dim + ' · ' + C.reset) + C.reset)
    // status bar (pure-black background): model · preset · effort  |  ctx · elapsed
    const left = C.bright + '⬢ ' + C.reset + C.purple + (displayModel.provider ? displayModel.provider + '/' + displayModel.model : '—') + C.reset + presetTxt + effortTxtFull
    const rightSegs: string[] = []
    if (contextWindow > 0) rightSegs.push(ctxTxt)
    if (sessionStartAt) rightSegs.push(elapsedTxt)
    const right = rightSegs.join(C.dim + ' · ' + C.reset)
    const gap = Math.max(2, W - plainW(left) - plainW(right))
    const BLACK = '\x1b[48;5;0m'
    const bar = (left + ' '.repeat(gap) + right + ' '.repeat(Math.max(0, W - plainW(left) - gap - plainW(right))))
    frame.push(BLACK + bar.split(C.reset).join(C.reset + BLACK) + C.reset)

    // prompt / draft — the bottom rows belong to the input (opencode style)
    const prompt = exitConfirm ? C.yellow + ' exit DASH? [y/n]' + C.reset : ''
    if (prompt) {
      frame.push(prompt)
      for (let i = 1; i < maxShown; i++) frame.push('')
    } else {
      shown.forEach((ln, i) => {
        const prefix = i === 0 ? C.green + '❯ ' + C.reset : C.dim + '  ' + C.reset
        frame.push(prefix + ln.text + C.reset)
      })
      for (let i = shown.length; i < maxShown; i++) frame.push('')
    }
    return frame
  }

  function modelNarration(): string | null {
    // ⏵ model self-narration: last non-empty line of live reasoning
    if (!streaming || !rows[streaming.rowIdx]) return null
    const r = rows[streaming.rowIdx]
    if (r.kind !== 'assistant') return null
    const rz = r.reasoning
    if (!rz) return null
    const lines = rz.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t) return truncate(t, 32)
    }
    return null
  }

  let prevFrame: string[] = []
  function flush(): void {
    const frame = buildFrame()
    const outBuf: string[] = []
    for (let i = 0; i < frame.length; i++) {
      if (prevFrame[i] !== frame[i]) outBuf.push('\x1b[' + (i + 1) + ';1H\x1b[2K' + frame[i])
    }
    for (let i = frame.length; i < prevFrame.length; i++) outBuf.push('\x1b[' + (i + 1) + ';1H\x1b[2K')
    prevFrame = frame
    // editor cursor (input block sits at the very bottom, status bar above it)
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
    // blinking white block cursor at the editor position (self-drawn; the
    // hardware cursor stays hidden). Reverse-video the character under the
    // cursor so the terminal renders a white rectangle.
    const blinkOn = Math.floor(tick / 12) % 2 === 0
    let curCh = ' '
    for (const ln of shown) {
      if (draft.cursor >= ln.start && draft.cursor <= ln.end) {
        const i = draft.cursor - ln.start
        curCh = i < ln.text.length ? ln.text[i] : ' '
        break
      }
    }
    outBuf.push('\x1b[' + Math.max(1, cursorRow) + ';' + Math.max(1, cursorCol) + 'H' + (blinkOn ? '\x1b[7m' + curCh + '\x1b[0m' : curCh))
    out.write(outBuf.join(''))
  }

  let drawTimer = setInterval(() => {
    tick++
    if (tick % 750 === 0) refreshGitBranch()
    // stuck-loading guard: no turn/start within 90s of a send (agent hung or died)
    if (busy && sendAt && !streaming && Date.now() - sendAt > 90000) {
      busy = false
      activity = null
      sendAt = 0
      setStatus('✗ no response from agent', C.red)
      dirty = true
    }
    // blink driver: redraw every ~480ms so the block cursor flickers
    if (tick % 12 === 0) dirty = true
    if (dirty) {
      dirty = false
      flush()
    }
  }, 40)

  // ── lifecycle ───────────────────────────────────────────────────────────
  let cleaned = false
  function teardownScreen(): void {
    try { out.write('\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[0m') } catch (e) { /* ignore */ }
  }
  function setupScreen(): void {
    try {
      tin.setRawMode(true)
      tin.resume()
      out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h' + kittyPushRequest())
    } catch (e) { /* ignore */ }
  }
  async function teardown(): Promise<void> {
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
  async function exitDash(code: number): Promise<void> {
    await teardown()
    process.exit(code)
  }
  function suspendDash(): void {
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
    try { out.write('\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[0m') } catch (e) { /* ignore */ }
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
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h' + kittyPushRequest())
  dirty = true
  loadWelcomeSessions()

  if (getCfg(cfg, 'autoResume', false)) {
    void (async () => {
      const sp: SessionPersistenceService | undefined = ctx.get('sessionPersistence')
      if (sp) {
        try {
          const headers = await sp.list()
          const dash = headers.filter((h) => h.id.startsWith('dash-'))
          if (dash.length) {
            let best = dash[0]
            let bestT = -1
            for (const h of dash) {
              try {
                const loc = sp.locate(h)
                if (loc && loc.path) {
                  const st = fs.statSync(loc.path)
                  if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = h }
                }
              } catch (e) { /* keep createdAt ordering */ }
            }
            await boot(false, best.id)
            return
          }
        } catch (e) { /* fall through to a fresh session */ }
      }
      await boot(false)
    })()
  } else {
    boot(false)
  }

  return teardown
}
