// Pure routing policy, ported from pi-pignon: no `$`, the part worth testing.

import type { Decision, Effort, LogEntry, TurnOutcome } from '../types'

export type Tier = {
  id: string
  /** An alias (`haiku`, `sonnet`, `opus`) or a full model id. */
  model: string
  effort: Effort
  /** Whether the tier holds up in a long tool loop over the codebase. */
  canExplore: boolean
  /** What the decider reads to pick it. */
  criteria: string
}

/** Cheapest first: a tier's rank is its position. */
export const TIERS: readonly Tier[] = [
  {
    id: 'trivial',
    model: 'haiku',
    effort: 'low',
    canExplore: false,
    criteria:
      'mechanical edit, rename, one-line fix, single lookup, a question answered in a few lines',
  },
  {
    id: 'standard',
    model: 'sonnet',
    effort: 'medium',
    canExplore: true,
    criteria:
      'localized change across a few files, routine feature or test, explaining code, running and fixing a known command',
  },
  {
    id: 'hard',
    model: 'opus',
    effort: 'high',
    canExplore: true,
    criteria:
      'multi-step investigation, debugging an unclear failure, cross-cutting design or refactor, a plan with real trade-offs',
  },
]

/** Who judged the prompt: Haiku, or the local model on this machine. */
export type DeciderId = 'haiku' | 'laya'

/**
 * Haiku reports its own confidence, a guess; the local model reports a
 * calibrated probability, and its top one rarely passes 0.85. The local bars
 * are provisional: shadow mode shows where they belong.
 */
export const CONFIDENCE: Record<DeciderId, { minUpgrade: number; minDowngrade: number }> = {
  haiku: { minUpgrade: 0.5, minDowngrade: 0.85 },
  laya: { minUpgrade: 0.5, minDowngrade: 0.7 },
}

export const THRESHOLDS = {
  minPromptsBetweenSwitches: 2,
  /**
   * Past this much context, a downgrade is refused: a change of model or of
   * effort invalidates the cached messages, a full miss on all of the context.
   */
  cacheGuardTokens: 60_000,
  /** The same for an upgrade, which quality justifies more readily. */
  upgradeGuardTokens: 100_000,
  /** A trivial turn that makes this many requests was more than a trivial task. */
  longTurnSteps: 8,
}

export type PolicyInput = {
  decision: Decision | null
  /** Who made the decision; Haiku when left out. */
  decider?: DeciderId
  /** The tier in force, null while the session's own model runs. */
  current: string | null
  /** The session's own model id, as the engine resolved it. */
  sessionModel: string
  sessionEffort: Effort | undefined
  contextTokens: number
  promptsSinceSwitch: number
  /**
   * True when the cached prefix is already gone (a compaction, or an idle gap
   * past the cache TTL): a switch then costs nothing, so the guards and the
   * cooldown do not apply.
   */
  isCacheCold?: boolean
}

export type PolicyOutput = { target: string | null; reason: string }

/**
 * Whether to move the main loop to another tier.
 *
 * Upgrades are quality-driven: confidence gates them, and a higher cache
 * guard. Every other move must also clear the cooldown and the cache guard.
 * A change of model or of effort alone both miss the cache, so both are guarded,
 * unless the cache is cold already. Fail-open: a missing or unusable signal
 * keeps what runs.
 */
export function decide(input: PolicyInput): PolicyOutput {
  const { decision, current } = input
  const bar = CONFIDENCE[input.decider ?? 'haiku']
  const isCold = input.isCacheCold === true
  const tag = isCold ? ' (cache cold)' : ''
  if (!decision) return { target: null, reason: 'no decision' }
  if (decision.tier === 'same') return { target: null, reason: 'follow-up' }

  if (rankOf(decision.tier) < 0) return { target: null, reason: `unknown tier ${decision.tier}` }
  const rank = rankOf(effectiveTier(decision)!)
  const target = TIERS[rank]!

  const running = current === null ? undefined : TIERS[rankOf(current)]
  const runningModel = running?.model ?? input.sessionModel
  const runningEffort = running?.effort ?? input.sessionEffort
  const isSameModel = sameModel(runningModel, target.model)
  if (isSameModel && runningEffort === target.effort) {
    return { target: null, reason: 'already on target' }
  }

  const currentRank = running ? rankOf(running.id) : rankOfModel(input.sessionModel)
  const label = `${running?.id ?? short(input.sessionModel)} -> ${target.id}`

  if (currentRank >= 0 && rank > currentRank) {
    if (decision.confidence < bar.minUpgrade) {
      return { target: null, reason: `confidence ${decision.confidence.toFixed(2)} < upgrade threshold` }
    }
    if (!isCold && input.contextTokens > THRESHOLDS.upgradeGuardTokens) return cacheProtected(input.contextTokens)

    return { target: target.id, reason: `upgrade ${label}${tag}` }
  }

  if (decision.confidence < bar.minDowngrade) {
    return { target: null, reason: `confidence ${decision.confidence.toFixed(2)} < downgrade threshold` }
  }
  // Hysteresis, so the model does not flap on consecutive prompts; leaving
  // the session's model is not a switch back, so it skips the cooldown. A cold
  // cache skips it too: flapping costs nothing then.
  if (!isCold && current !== null && input.promptsSinceSwitch < THRESHOLDS.minPromptsBetweenSwitches) {
    return { target: null, reason: `cooldown: ${input.promptsSinceSwitch} prompt(s) since last switch` }
  }
  if (!isCold && input.contextTokens > THRESHOLDS.cacheGuardTokens) return cacheProtected(input.contextTokens)

  return { target: target.id, reason: `${isSameModel ? 'effort' : 'downgrade'} ${label}${tag}` }
}

function cacheProtected(contextTokens: number): PolicyOutput {
  return { target: null, reason: `context ${Math.round(contextTokens / 1000)}k: cache protected` }
}

/**
 * The tier a decision would run on: a prompt that must explore moves up from a
 * tier that cannot. Null for a follow-up or an unknown tier.
 */
export function effectiveTier(decision: Decision | null): string | null {
  if (!decision || decision.tier === 'same') return null
  let rank = rankOf(decision.tier)
  if (rank < 0) return null
  if (decision.explore && !TIERS[rank]!.canExplore) {
    const up = TIERS.findIndex((t, i) => i > rank && t.canExplore)
    if (up >= 0) rank = up
  }

  return TIERS[rank]!.id
}

export function tierOf(id: string | null): Tier | undefined {
  return id === null ? undefined : TIERS.find(t => t.id === id)
}

function rankOf(id: string): number {
  return TIERS.findIndex(t => t.id === id)
}

/** The first tier running this model, so an unrouted session has a rank. */
function rankOfModel(model: string): number {
  return TIERS.findIndex(t => sameModel(model, t.model))
}

/** `opus` and `claude-opus-5-5` name the same model; two full ids must match. */
function sameModel(a: string, b: string): boolean {
  if (a === b) return true
  const isAlias = (m: string) => !m.includes('-')
  return (isAlias(a) || isAlias(b)) && familyOf(a) !== undefined && familyOf(a) === familyOf(b)
}

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** The family an alias or a full id names, `haiku` for `claude-haiku-5-5`; undefined for a model of none. */
export function familyOf(model: string): Family | undefined {
  return /haiku|sonnet|opus|fable/.exec(model)?.[0] as Family | undefined
}

function short(model: string): string {
  return familyOf(model) ?? model
}

/**
 * Whether the tier fell short of the task: a trivial turn that ran a long tool
 * loop, or a turn that was switched and ended in an error or a refusal. The
 * quality signal the savings are weighed against. False until the turn has ended.
 */
export function isUnderRouted(entry: { tier: string | null; action: LogEntry['action']; turn?: TurnOutcome }): boolean {
  const turn = entry.turn
  if (!turn) return false
  if (entry.tier === TIERS[0]!.id && turn.steps >= THRESHOLDS.longTurnSteps) return true

  return entry.action === 'switched' && (turn.reason === 'error' || turn.reason === 'refusal')
}

/** The decider's reply, `{"tier":..,"explore":..,"confidence":..}`, or null. */
export function parseDecision(text: string): Decision | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    const tier = raw.tier
    if (typeof tier !== 'string' || (tier !== 'same' && rankOf(tier) < 0)) return null
    const confidence = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0
    return { tier, explore: raw.explore === true, confidence }
  } catch {
    return null
  }
}

/** Words of a reply that asks for no task of its own, in English and French. */
const ACKNOWLEDGEMENT = new Set(
  "yes y yep yeah ok okay sure go on ahead continue proceed do it thanks thank you great good looks lgtm please oui d'accord vas-y merci parfait super".split(
    ' ',
  ),
)

/**
 * Whether a prompt is only an acknowledgement ("yes", "go ahead", "vas-y"),
 * which keeps the current tier without asking any decider. A whitelist, not a
 * length rule: "refactor everything" is short and is a task.
 */
export function isFollowUp(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\- ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  return words.length > 0 && words.length <= 4 && words.every(w => ACKNOWLEDGEMENT.has(w))
}

/**
 * The local model's answer, a probability per tier, as a decision. Its
 * probability is the confidence: a measure, where Haiku reports a guess.
 * The model cannot say whether the agent must explore, so `explore` is false.
 */
export function decisionFromTiers(tiers: Record<string, number>): Decision | null {
  const usable = Object.entries(tiers).filter(
    ([tier, p]) => rankOf(tier) >= 0 && typeof p === 'number' && p >= 0 && p <= 1,
  )
  const best = usable.sort(([, a], [, b]) => b - a)[0]

  return best ? { tier: best[0], explore: false, confidence: best[1] } : null
}

export const DECIDER_SYSTEM = `You route a coding agent's next prompt to a model tier. Judge how hard the task is, not how long the prompt is.

Tiers, cheapest first:
${TIERS.map(t => `- ${t.id}: ${t.criteria}`).join('\n')}
- same: a follow-up with no task of its own ("yes", "go on", "do it", "thanks", a short correction of the last answer); keeps the current tier

explore is true when the agent must read or search the codebase before it can act.
confidence is how sure you are of the tier, from 0 to 1.

Answer with one JSON object and nothing else: {"tier": "...", "explore": true|false, "confidence": 0.0}`
