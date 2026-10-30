export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What the decider answered for one prompt. */
export type Decision = {
  /** A tier id, or `same` for a follow-up that should keep the current tier. */
  tier: string
  /** Whether the agent must read the codebase before it can act. */
  explore: boolean
  /** The decider's own confidence in `tier`, 0 to 1. */
  confidence: number
}

/** One routed prompt, as `/pignon log` lists it. */
export type LogEntry = {
  /** Counts up through the session, so a late answer finds its entry. */
  id: number
  /** When it was decided, in milliseconds since the epoch. */
  at: number
  prompt: string
  /** The start of the prompt as a decider read it; empty when a rule decided. */
  sent: string
  /** The local model's probability for each tier, when it answered. */
  tiers?: Record<string, number>
  /** How long the daemon says its own work took. */
  daemonMs?: number
  /** Why the local model, though chosen, did not decide and Haiku did. */
  fallback?: string
  /** Haiku's opinion on the same prompt, asked in shadow mode for comparison. */
  second?: { decision: Decision | null; ms: number; isPending?: boolean }
  /** Who decided: Haiku, the model on this Mac, or a rule (an acknowledgement). */
  decider: 'haiku' | 'laya' | 'rule'
  decision: Decision | null
  ms: number
  action: 'switched' | 'would switch' | 'kept'
  /** The tier in force after the decision, null for the session's own model. */
  tier: string | null
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    pignon: {
      /** The tier applied to the main loop, null while on the session's model. */
      current: string | null
      /** Prompts routed since the last switch, for the cooldown. */
      promptsSinceSwitch: number
      /** Tokens of context the last main request carried. */
      contextTokens: number
      /** The session's own model and effort, as `/model` and `/effort` set them. */
      base: string | null
      /** True once the person picked a model by hand: routing waits for unpin. */
      isPinned: boolean
      /** The id the next log entry takes. */
      nextId: number
      log: Shaped<LogEntry[]>
    }
  }
}
