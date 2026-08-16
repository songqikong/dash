// Ambient declarations for the DSH plugin API surface used by DASH.
//
// These mirror the subset of the official packages' own type definitions
// (@deepseek-ai/dsh-llm, @deepseek-ai/dsh-agent, @deepseek-ai/dsh-session,
// @deepseek-ai/cordis) that this TUI actually touches, so the TypeScript
// build stays self-contained — no dependency on the shared profiles
// node_modules at compile time. Keep in sync when touching those imports.

declare module '@deepseek-ai/dsh-llm' {
  export interface TextBlock { type: 'text'; text: string }
  export interface ReasoningBlock { type: 'reasoning'; text: string }
  export interface ImageBlock { type: 'image'; attachment: unknown }
  export interface ToolCallBlock { type: 'tool-call'; id: string; name: string; arguments: string }
  export interface ToolResultBlock { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
  export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

  export interface MessageSourceMap {
    user: { kind: 'user' }
    plugin: { kind: 'plugin'; plugin: string; form?: unknown }
    model: { kind: 'model'; provider: string; model: string }
    tool: { kind: 'tool'; callId: string }
  }
  export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

  export interface Message {
    readonly id: string
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: ContentBlock[]
    readonly source: MessageSource
  }
  export interface UserMessage extends Message { readonly role: 'user' }
  export interface AssistantMessage extends Message { readonly role: 'assistant' }

  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }

  export interface LlmFailure { message: string; code: string; status?: number }
  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted'; failure: LlmFailure }
    | { kind: 'error'; failure: LlmFailure }

  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: string }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'finish'; reason: FinishReason; replayState?: unknown }

  export interface LlmProviderInfo { id: string; name: string }
  export interface LlmModelInfo { id: string; name: string; description?: string }
  export interface LlmReasoningEffortInfo { id: string; name: string; description?: string }
  export interface LlmResolvedModelInfo extends LlmModelInfo {
    reasoning?: { efforts: LlmReasoningEffortInfo[] }
  }

  export interface GenerateOptions {
    provider: string
    model: string
    messages: Message[]
    system?: string
    maxTokens?: number
    reasoningEffort?: string
    signal?: AbortSignal
  }

  export interface LlmRuntime {
    listProviders(): LlmProviderInfo[]
    listModels(provider: string): Promise<LlmModelInfo[]>
    resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo>
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }

  export function createUserMessage(input: { content: ContentBlock[]; source: MessageSource }): UserMessage
}

declare module '@deepseek-ai/dsh-agent' {
  export interface ModelSelection {
    provider: string
    model: string
    reasoningEffort?: string
  }
  export interface ModelSelectionRef {
    current: ModelSelection | undefined
    assembled: ModelSelection | undefined
  }

  /** Couple one mutable selection to Agent-scoped prompt assembly and request routing. */
  export function installModelSelection(agentCtx: unknown, selection: ModelSelectionRef): () => void

  export interface AgentOptions { provider?: string; model?: string; maxTokens?: number }

  export interface Agent {
    readonly id: string
    readonly options: AgentOptions
    readonly session: import('@deepseek-ai/dsh-session').Session
    readonly status: 'idle' | 'running'
    cancel(cause: { kind: string }): void
    followup(message: import('@deepseek-ai/dsh-llm').UserMessage): void
    steer(message: import('@deepseek-ai/dsh-llm').UserMessage): void
    inject(message: import('@deepseek-ai/dsh-llm').UserMessage): void
    whenIdle(): Promise<void>
  }

  export type AgentSetup = (agentCtx: unknown) => unknown

  export interface CreateAgentOptions {
    sessionId: string
    meta?: { cwd?: string; parentSession?: string; seedLength?: number; origin?: string; delegationDepth?: number; agentPreset?: string }
    seed?: readonly import('@deepseek-ai/dsh-session').SessionEvent[]
    agentOptions?: AgentOptions
    setup?: AgentSetup
  }

  export interface ResumeAgentOptions {
    resumeSessionId: string
    agentOptions?: AgentOptions
    setup?: AgentSetup
  }

  export interface AgentHandle {
    agent: Agent
    dispose(): Promise<void>
  }

  export interface AgentRegistryService {
    create(options: CreateAgentOptions): Promise<AgentHandle>
    resume(options: ResumeAgentOptions): Promise<AgentHandle>
  }
}

declare module '@deepseek-ai/dsh-session' {
  import type { UserMessage, AssistantMessage, TokenUsage, StreamChunk, ContentBlock } from '@deepseek-ai/dsh-llm'

  export interface Session {
    readonly id: string
    readonly events: SessionEvent[]
  }

  export interface TurnEndReason {
    kind: string
    error?: { message?: string }
    failure?: { message?: string }
  }

  export interface RequestContext {
    provider: string
    model: string
    contextWindow?: number
  }

  export interface SessionEventMap {
    'turn/start': { turn: number }
    'turn/end': { turn: number; reason: TurnEndReason }
    'step/start': { turn: number; step: number }
    'step/end': { turn: number; step: number }
    'user/message': UserMessage
    'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
    'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
    'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
    'tool/result': { turn: number; step: number; callId?: string; message: { role: 'user'; content: ContentBlock[]; source: { kind: 'tool'; callId: string }; id: string }; error?: { name: string; code: string } }
    'request/context': RequestContext
    // plugin-merged extensions (dsh-session-title / dsh-compaction / dsh-agent-presets)
    'session/title': { title?: string }
    'compaction/start': Record<string, never>
    'compaction/end': Record<string, never>
    'agent-preset/selected': { agentPreset: string }
  }

  export type SessionEventType = keyof SessionEventMap

  /** Discriminated union over `type`; `switch (event.type)` narrows `event.data`. */
  export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
      type: K
      seq: number
      time: number
      data: SessionEventMap[K]
    }
  }[T]
}

declare module '@deepseek-ai/dsh-agent-presets' {
  export type PresetTrust = 'system' | 'user'

  /** One agent preset directory: a cordis composition plus optional metadata. */
  export interface AgentPreset {
    readonly id: string
    readonly trust: PresetTrust
    readonly path: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly broken?: string
  }

  export interface PresetRoot {
    path: string
    trust: PresetTrust
  }

  /** Scan every root in precedence order; an earlier root wins a duplicate id. */
  export function discoverPresets(roots: readonly PresetRoot[]): Promise<AgentPreset[]>

  /** Compose one agent from a preset; call from the agent factory's `setup(agentCtx)`. */
  export function mountPreset(agentCtx: unknown, preset: AgentPreset): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    get(name: string): any
    on(event: string, listener: (...args: any[]) => void): unknown
    agents: import('@deepseek-ai/dsh-agent').AgentRegistryService
  }
}
