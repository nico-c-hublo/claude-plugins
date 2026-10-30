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

/**
 * One line of the decision log. Metadata only: nothing of the prompt is kept but
 * its length, so the file can be shared or read in bulk without reading anyone's work.
 */
export type DecisionRecord = {
  v: 1
  /** Random per session: the file name carries it too. */
  session: string
  /** The entry id within the session, as `/pignon log` counts. */
  n: number
  /** When it was decided, in milliseconds since the epoch. */
  at: number
  /** The session's working directory. */
  project: string
  mode: 'live' | 'shadow'
  /** Who was chosen in the settings; `decider` is who answered. */
  chosen: 'haiku' | 'laya'
  /** How the local model ran; null when Haiku was chosen. */
  daemon: 'session' | 'shared' | null
  decider: 'haiku' | 'laya' | 'rule'
  /** Characters in the prompt. */
  promptChars: number
  /** The local model's probability for each tier, when it answered. */
  tiers?: Record<string, number>
  decision: Decision | null
  /** Haiku's opinion in shadow mode, once it has answered (or failed to). */
  second?: { decision: Decision | null; ms: number }
  /** Why the local model, though chosen, did not decide. */
  fallback?: string
  /** What the decision took, from the mod's clock. */
  ms: number
  daemonMs?: number
  action: 'switched' | 'would switch' | 'kept'
  /** The tier in force before and after. */
  was: string | null
  tier: string | null
  reason: string
  /** The session's own model. */
  model: string
  contextTokens: number
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
