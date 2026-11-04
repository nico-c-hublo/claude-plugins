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

/** What a routed turn did once it ended: how many requests, why it stopped, what the API counted. */
export type TurnOutcome = {
  /** Model requests the main loop made for the turn. */
  steps: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  durationMs: number
  /**
   * The effort the turn's first request was sent with, after any tier rewrote it:
   * null when it named none (the model's default). Absent on records written
   * before it was kept.
   */
  effort?: Effort | null
  /** The API's counts summed over the turn, and the model that answered; absent when nothing counted. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }
  /** `usage` priced at list price when the turn ended, on the model that answered, on the session's and on the tier's; absent when one has no price. */
  cost?: { actual: number; onSessionModel: number; onTier: number }
}

/**
 * Your verdict on a decision, from `/pignon mark` or the pane: which tiers would
 * have been right. A judge is scored right when the tier it would run is one of them.
 */
export type Mark = {
  /** What you said: `low` (too low), `ok`, `high` (too high), or a tier by name. */
  said: string
  /** The tier a relative mark was taken against: the one the decision's line named, which ran in live mode. */
  of: string | null
  /** The tiers it accepts: `ok` that one, `low` every tier above it, `high` every one below, a name itself. */
  accepted: string[]
}

/** The reference judge's opinion, asked in shadow mode when the oracle is on. */
export type OracleOpinion = {
  decision: Decision | null
  ms: number
  /** What the call cost at list price; absent when it was not answered. */
  cost?: number
}

/** One routed prompt, as `/pignon log` lists it. */
export type LogEntry = {
  /** Counts up through the session, so a late answer finds its entry. */
  id: number
  /** When it was decided, in milliseconds since the epoch. */
  at: number
  /** The mode it was decided in: in live mode the tier ran, in shadow mode the session's model did. */
  mode: 'live' | 'shadow'
  /** The session's own model. */
  model: string
  /** The tier in force before the decision, null for the session's own model. */
  was: string | null
  prompt: string
  /** Characters in the prompt: the local model reads the first 400 of them. */
  promptChars: number
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
  /** Opus's opinion on the same prompt, asked in shadow mode when the oracle is on. */
  oracle?: OracleOpinion & { isPending?: boolean }
  /** True once the next prompt read as a correction of this turn's answer ("no, ...", "pas ça"). */
  corrected?: true
  /** Your verdict, from `/pignon mark` or the pane. */
  mark?: Mark
  /** Who decided: Haiku, the model on this Mac, or a rule (an acknowledgement). */
  decider: 'haiku' | 'laya' | 'rule'
  decision: Decision | null
  ms: number
  action: 'switched' | 'would switch' | 'kept'
  /** The tier in force after the decision, null for the session's own model. */
  tier: string | null
  reason: string
  /** Filled in when the turn ends. */
  turn?: TurnOutcome
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
  /** Opus's opinion when the oracle is on, once it has answered (or failed to). */
  oracle?: OracleOpinion
  /** Added when the next prompt read as a correction of this turn's answer. */
  corrected?: true
  /** Added when you marked the decision. */
  mark?: Mark
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
  /** Added once the turn has ended. */
  turn?: TurnOutcome
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
      /** When the last main-loop request was answered, so an idle gap past the cache TTL is known; 0 before the first. */
      lastRequestAt: number
      /** True from a compaction until the next request: the cached prefix is gone. */
      isCompacted: boolean
      log: Shaped<LogEntry[]>
    }
  }
}
