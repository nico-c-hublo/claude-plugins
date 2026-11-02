// What a turn cost, and what it would have cost on another model: estimates at
// list price, so the stats can say what routing saves. No `$`, testable alone.

import type { TurnOutcome } from '../types'
import { familyOf, tierOf } from './policy'
import type { Family } from './policy'

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * US dollars per million tokens on the Claude API, as the claude-api reference
 * listed them on 2026-10-06 for Haiku 5.5, Sonnet 5.5 and Opus 5.5. A cache
 * write is priced at the 5-minute premium (1.25x input); the 1-hour one is 2x.
 * Haiku's rate past 100k tokens of prompt ($0.50/$2.50) is ignored. A managed
 * account's own prices are not visible to a mod, so these are estimates.
 */
export const USD_PER_MTOK: Partial<Record<Family, Price>> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
}

type Usage = NonNullable<TurnOutcome['usage']>

/** What `usage` costs on `model` (an alias or a full id), or null for a model with no price here. */
export function priceOf(usage: Omit<Usage, 'model'>, model: string): number | null {
  const family = familyOf(model)
  const price = family === undefined ? undefined : USD_PER_MTOK[family]
  if (!price) return null

  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000
}

export type TurnCost = {
  /** What the turn cost on the model that answered. */
  actual: number
  /** The same tokens on the session's own model. */
  onSessionModel: number
  /** The same tokens on the tier's model (the session's when no tier was in force). */
  onTier: number
}

/**
 * The turn's cost three ways, on the same token counts: the model may spend more
 * or fewer tokens than another would, so it is an estimate. Null when any of the
 * three models has no price.
 */
export function turnCost(usage: Usage, sessionModel: string, tier: string | null): TurnCost | null {
  const actual = priceOf(usage, usage.model)
  const onSessionModel = priceOf(usage, sessionModel)
  const onTier = priceOf(usage, tierOf(tier)?.model ?? sessionModel)
  if (actual === null || onSessionModel === null || onTier === null) return null

  return { actual, onSessionModel, onTier }
}

/** `$0.012` under a dollar, `$4.12` above. */
export function usd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 3 : 2)}`
}
