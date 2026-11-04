import type { Decision, DecisionRecord, Effort, LogEntry, Mark, TurnOutcome } from '../types'
import { LOCAL_PROMPT_CHARS, THRESHOLDS, TIERS, effectiveTier, failedAfterSwitch, hybridDecision, isAccepted, ranLongOnTrivial, ranOn, tierOfModel, verdictSignal } from './policy'
import { usd } from './prices'

// A session file holds this many records at most; the oldest go first.
export const MAX_RECORDS = 3_000
export const KEEP_DAYS = 90
const REASON_CHARS = 80

/** What a record holds beyond its log entry: the session, the settings, the state before the decision. */
export type RecordContext = {
  session: string
  project: string
  chosen: 'haiku' | 'laya'
  daemon: 'session' | 'shared' | null
  contextTokens: number
}

/** A judge's opinion once it has answered, without the flag that it is still asked; undefined while it is. */
export function settled<T extends { isPending?: boolean }>(opinion: T | undefined): Omit<T, 'isPending'> | undefined {
  if (!opinion || opinion.isPending) return undefined
  const { isPending: _, ...answered } = opinion

  return answered
}

// What a log entry leaves in the file: everything but the words of the prompt.
export function recordOf(entry: LogEntry, context: RecordContext): DecisionRecord {
  const second = settled(entry.second)
  const oracle = settled(entry.oracle)

  return {
    v: 1,
    session: context.session,
    n: entry.id,
    at: entry.at,
    project: context.project,
    mode: entry.mode,
    chosen: context.chosen,
    daemon: context.daemon,
    decider: entry.decider,
    promptChars: entry.promptChars,
    ...(entry.tiers && { tiers: entry.tiers }),
    decision: entry.decision,
    ...(second && { second }),
    ...(oracle && { oracle }),
    ...(entry.corrected && { corrected: entry.corrected }),
    ...(entry.mark && { mark: entry.mark }),
    ...(entry.fallback && { fallback: entry.fallback }),
    ms: entry.ms,
    ...(entry.daemonMs !== undefined && { daemonMs: entry.daemonMs }),
    action: entry.action,
    was: entry.was,
    tier: entry.tier,
    reason: entry.reason.slice(0, REASON_CHARS),
    model: entry.model,
    contextTokens: context.contextTokens,
    ...(entry.turn && { turn: entry.turn }),
  }
}

export function serialize(records: readonly DecisionRecord[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

// Lines that are not a record of this version are skipped: a file may come from
// a newer mod, or have been cut short.
export function parseRecords(text: string): DecisionRecord[] {
  const records: DecisionRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as DecisionRecord
      if (record.v === 1 && typeof record.at === 'number') records.push(record)
    } catch {
      // a half-written line
    }
  }

  return records
}

function agrees(record: DecisionRecord): boolean {
  const opinion = effectiveTier(record.second?.decision ?? null)

  return opinion !== null && opinion === effectiveTier(record.decision)
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

export function share(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`
}

// The last two folders of a path: enough to tell projects apart on one line.
function shortProject(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/') || path
}

const BANDS = [
  { label: 'p < 0.50', from: 0, to: 0.5 },
  { label: '0.50 to 0.70', from: 0.5, to: 0.7 },
  { label: '0.70 to 0.85', from: 0.7, to: 0.85 },
  { label: 'p ≥ 0.85', from: 0.85, to: Number.POSITIVE_INFINITY },
]

// How often the judges agree, by the local model's confidence and by project,
// and what each costs in time. The numbers the 0.7 downgrade bar is tuned on.
export function summarize(records: readonly DecisionRecord[], sessions: number): string {
  if (records.length === 0) return 'No decisions recorded yet. Set "record" to "on" in the pignon settings, then send a few prompts.'

  const first = new Date(Math.min(...records.map(r => r.at))).toISOString().slice(0, 10)
  const last = new Date(Math.max(...records.map(r => r.at))).toISOString().slice(0, 10)
  const by = (decider: string) => records.filter(r => r.decider === decider)
  const lines = [
    `${records.length} decisions in ${sessions} session${sessions === 1 ? '' : 's'}, ${first} to ${last}`,
    `decided by: laya ${by('laya').length} · haiku ${by('haiku').length} · rule ${by('rule').length}`,
  ]

  const compared = records.filter(r => r.decider === 'laya' && r.second?.decision)
  const agreed = compared.filter(agrees)
  const asked = records.filter(r => r.decider === 'laya' && r.second)
  if (asked.length > 0) {
    lines.push(
      '',
      `laya vs haiku: ${compared.length} compared · ${agreed.length} agree (${share(agreed.length, compared.length)}) · ${compared.length - agreed.length} differ · haiku gave no answer for ${asked.length - compared.length}`,
    )
    for (const band of BANDS) {
      const inBand = compared.filter(r => (r.decision?.confidence ?? 0) >= band.from && (r.decision?.confidence ?? 0) < band.to)
      if (inBand.length > 0) lines.push(`  ${band.label.padEnd(13)} ${share(inBand.filter(agrees).length, inBand.length).padStart(4)} agree (n=${inBand.length})`)
    }

    const moves = new Map<string, number>()
    for (const r of compared.filter(r => !agrees(r))) {
      const key = `${effectiveTier(r.decision)} → ${effectiveTier(r.second?.decision ?? null)}`
      moves.set(key, (moves.get(key) ?? 0) + 1)
    }
    if (moves.size > 0) {
      const top = [...moves].sort((a, b) => b[1] - a[1]).slice(0, 6)
      lines.push(`  differences (laya → haiku): ${top.map(([key, n]) => `${key} ${n}`).join(' · ')}`)
    }

    const projects = new Map<string, DecisionRecord[]>()
    for (const r of compared) projects.set(r.project, [...(projects.get(r.project) ?? []), r])
    const ranked = [...projects].sort((a, b) => b[1].length - a[1].length).slice(0, 8)
    if (ranked.length > 1) {
      lines.push('  by project:')
      for (const [project, list] of ranked) lines.push(`    ${shortProject(project).padEnd(32)} ${share(list.filter(agrees).length, list.length).padStart(4)} agree (n=${list.length})`)
    }
  }

  const laya = by('laya')
  if (laya.length > 0) {
    const daemon = laya.flatMap(r => (r.daemonMs === undefined ? [] : [r.daemonMs]))
    lines.push(
      '',
      `latency: laya p50 ${percentile(laya.map(r => r.ms), 0.5)} ms, p95 ${percentile(laya.map(r => r.ms), 0.95)} ms` +
        (daemon.length > 0 ? ` (the daemon itself p50 ${percentile(daemon, 0.5)} ms)` : '') +
        (asked.length > 0 ? ` · haiku p50 ${percentile(asked.map(r => r.second!.ms), 0.5)} ms, p95 ${percentile(asked.map(r => r.second!.ms), 0.95)} ms` : ''),
    )
  }

  const fallbacks = new Map<string, number>()
  for (const r of records) if (r.fallback) fallbacks.set(r.fallback, (fallbacks.get(r.fallback) ?? 0) + 1)
  if (fallbacks.size > 0) {
    lines.push(`fell back to haiku: ${[...fallbacks].sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause} ${n}`).join(' · ')}`)
  }

  const live = records.filter(r => r.mode === 'live')
  if (live.length > 0) {
    lines.push(`live: switched ${live.filter(r => r.action === 'switched').length} of ${live.length}`)
  }

  lines.push(...judgeLines(records))
  lines.push(...costLines(records))
  lines.push(...effortLines(records))

  return lines.join('\n')
}

/** Who judged: the two deciders, the hybrid simulated from them, the oracle. */
export type JudgeId = 'laya' | 'haiku' | 'hybrid' | 'opus'
const JUDGES: readonly JudgeId[] = ['laya', 'haiku', 'hybrid', 'opus']

/** What a prompt's judges said and what came of it: a record on disk, or a log entry of this session. */
export type Judged = {
  decider: DecisionRecord['decider']
  decision: Decision | null
  second?: { decision: Decision | null; isPending?: boolean }
  oracle?: { decision: Decision | null }
  mark?: Mark
  turn?: TurnOutcome
  corrected?: true
  mode: 'live' | 'shadow'
  /** The tier in force after the decision, or the one it would switch to in shadow mode. */
  tier: string | null
  /** The session's own model. */
  model: string
  /** The tier in force before the decision, null for the session's own model. */
  was: string | null
  promptChars: number
}

// One judge's opinion on one prompt: the decider's, Haiku's second opinion, the
// hybrid's, or the oracle's. Haiku is one judge whether it decided or was asked.
// The hybrid is simulated wherever laya decided and Haiku answered beside it (in
// shadow mode): what it would have said, from their two verdicts.
type Verdict = { judge: JudgeId; decision: Decision; tier: string; of: Judged }

export function verdictsOf(items: readonly Judged[]): Verdict[] {
  const verdicts: Verdict[] = []
  const add = (judge: JudgeId, decision: Decision | null | undefined, of: Judged) => {
    const tier = effectiveTier(decision ?? null)
    if (decision && tier !== null) verdicts.push({ judge, decision, tier, of })
  }
  for (const item of items) {
    if (item.decider === 'laya' || item.decider === 'haiku') add(item.decider, item.decision, item)
    add('haiku', item.second?.decision, item)
    if (item.decider === 'laya' && item.second && !item.second.isPending) {
      add('hybrid', hybridDecision(item.decision, item.second.decision, item.was ?? tierOfModel(item.model)), item)
    }
    add('opus', item.oracle?.decision, item)
  }

  return verdicts
}

/** A part and its whole: `3 of 4`. */
export type Tally = { part: number; whole: number }

/**
 * How a judge's verdicts fare. Each tally counts only the verdicts it can say
 * something about: too low among trivial verdicts, too high among hard ones,
 * corrected among those whose tier is the one the turn ran on.
 */
export type Score = {
  verdicts: number
  /** Trivial verdicts whose turn has ended, and of them those whose turn ran a long loop. */
  tooLow: Tally
  /** Hard verdicts whose turn has ended, and of them those whose turn was short. */
  tooHigh: Tally
  /** Verdicts whose tier ran, and of them those the next prompt corrected. */
  corrected: Tally
  /** Verdicts on a prompt you marked, and of them those on a tier you accepted. */
  right: Tally
  /** Verdicts on a prompt the oracle answered, and of them those on its tier; never the oracle's own. */
  asOracle: Tally
  /** The same on prompts the local model read whole: its input then was the oracle's. */
  asOracleSameInput: Tally
}

function tally<T>(list: readonly T[], isPart: (item: T) => boolean): Tally {
  return { part: list.filter(isPart).length, whole: list.length }
}

export function scoreOf(verdicts: readonly Verdict[]): Score {
  const ended = verdicts.filter(v => v.of.turn)
  const vsOracle = verdicts.flatMap(v => {
    const reference = v.judge === 'opus' ? null : effectiveTier(v.of.oracle?.decision ?? null)
    return reference === null ? [] : [{ ...v, reference }]
  })
  const marked = verdicts.flatMap(v => (v.of.mark ? [{ ...v, mark: v.of.mark }] : []))

  return {
    verdicts: verdicts.length,
    tooLow: tally(ended.filter(v => v.tier === TIERS[0]!.id), v => verdictSignal(v.decision, v.of.turn) === 'too low'),
    tooHigh: tally(ended.filter(v => v.tier === TIERS.at(-1)!.id), v => verdictSignal(v.decision, v.of.turn) === 'too high'),
    corrected: tally(ended.filter(v => v.tier === ranOn(v.of)), v => v.of.corrected === true),
    right: tally(marked, v => isAccepted(v.mark, v.decision)),
    asOracle: tally(vsOracle, v => v.tier === v.reference),
    asOracleSameInput: tally(vsOracle.filter(v => v.of.promptChars <= LOCAL_PROMPT_CHARS), v => v.tier === v.reference),
  }
}

/** Each judge that gave a verdict, with its score. */
export function scoreByJudge(items: readonly Judged[]): { judge: JudgeId; verdicts: Verdict[]; score: Score }[] {
  const verdicts = verdictsOf(items)

  return JUDGES.flatMap(judge => {
    const mine = verdicts.filter(v => v.judge === judge)
    return mine.length === 0 ? [] : [{ judge, verdicts: mine, score: scoreOf(mine) }]
  })
}

const cell = (label: string, t: Tally, of = '') => (t.whole === 0 ? [] : [`${label} ${share(t.part, t.whole)} of ${t.whole}${of}`])

/**
 * A judge's score on one line: what `/pignon stats` prints per judge and per
 * confidence band, and `/pignon compare` for the session. Tallies with nothing
 * to count are left out.
 */
export function scoreCells(judge: JudgeId, s: Score): string[] {
  const sameInput =
    judge === 'laya' && s.asOracleSameInput.whole > 0 && s.asOracleSameInput.whole < s.asOracle.whole
      ? ` (${share(s.asOracleSameInput.part, s.asOracleSameInput.whole)} of ${s.asOracleSameInput.whole} within its ${LOCAL_PROMPT_CHARS} characters)`
      : ''

  return [
    ...cell('too low', s.tooLow, ' trivial'),
    ...cell('too high', s.tooHigh, ' hard'),
    ...cell('corrected', s.corrected, ' that ran'),
    ...cell('right', s.right, ' marked'),
    ...cell('same as opus', s.asOracle, sameInput),
  ]
}

// What the judges' verdicts are worth: the outcome signals (free, weak), your
// marks (exact, few), and agreement with the oracle (Opus on the same input), by
// judge and by its confidence. The table the bars are tuned on.
function judgeLines(records: readonly DecisionRecord[]): string[] {
  const lines: string[] = []
  const scores = scoreByJudge(records)
  for (const { judge, verdicts, score } of scores) {
    lines.push(`  ${judge.padEnd(6)} ${[`${score.verdicts} verdict${score.verdicts === 1 ? '' : 's'}`, ...scoreCells(judge, score)].join(' · ')}`)
    for (const band of BANDS) {
      const inBand = verdicts.filter(v => v.decision.confidence >= band.from && v.decision.confidence < band.to)
      const cells = inBand.length === 0 ? [] : scoreCells(judge, scoreOf(inBand))
      if (cells.length > 0) lines.push(`         ${band.label.padEnd(13)} ${cells.join(' · ')}`)
    }
  }
  if (lines.length === 0) return []

  const oracleCost = sum(records.flatMap(r => (r.oracle?.cost === undefined ? [] : [r.oracle.cost])))
  const asked = records.filter(r => r.oracle).length

  return [
    '',
    'judges, scored on outcomes, your marks and the oracle:',
    ...lines,
    ...(scores.some(s => s.judge === 'hybrid')
      ? [`  hybrid: simulated, not run: laya's verdict, except that a move below the tier in force needs Haiku and goes no lower than the more capable of the two`]
      : []),
    `  too low: a trivial verdict whose turn ran ${THRESHOLDS.longTurnSteps}+ steps · too high: a hard verdict whose turn answered in ${THRESHOLDS.shortTurnSteps} requests or fewer, under ${THRESHOLDS.shortTurnOutputTokens.toLocaleString('en-US')} output tokens and ${THRESHOLDS.shortTurnMs / 1000} s · corrected: the next prompt said the answer was wrong`,
    ...(asked > 0 ? [`  oracle: opus asked ${asked} time${asked === 1 ? '' : 's'}, ${usd(oracleCost)} at list price`] : []),
    ...correctionLines(records),
  ]
}

// How often the next prompt was a correction, by the tier the turn ran on: in
// shadow mode the session's model ran, whatever the verdict, which makes it the baseline.
function correctionLines(records: readonly DecisionRecord[]): string[] {
  const ended = records.filter(r => r.turn)
  if (!ended.some(r => r.corrected)) return []
  const parts = [...TIERS.map(t => t.id), null].flatMap(tier => {
    const mine = ended.filter(r => ranOn(r) === tier)
    if (mine.length === 0) return []
    const corrected = mine.filter(r => r.corrected).length

    return [`${corrected} of ${mine.length} on ${tier ?? 'a model of no tier'} (${share(corrected, mine.length)})`]
  })

  return [`corrected, by the tier the turn ran on: ${parts.join(' · ')}`]
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

// What the routed turns cost against what the session model would have, and
// how often a tier fell short: the savings and the price paid for them.
function costLines(records: readonly DecisionRecord[]): string[] {
  const lines: string[] = []
  const priced = records.filter(r => r.turn?.cost)
  if (priced.length > 0) {
    lines.push('', `cost (estimated at list price): ${priced.length} turn${priced.length === 1 ? '' : 's'} priced`)
    const live = priced.filter(r => r.mode === 'live')
    if (live.length > 0) {
      const spent = sum(live.map(r => r.turn!.cost!.actual))
      const onSessionModel = sum(live.map(r => r.turn!.cost!.onSessionModel))
      lines.push(`  live:   spent ${usd(spent)} · ${usd(onSessionModel)} on the session model · saved ${usd(onSessionModel - spent)} (${share(onSessionModel - spent, onSessionModel)})`)
    }
    const shadow = priced.filter(r => r.mode === 'shadow')
    if (shadow.length > 0) {
      const onSessionModel = sum(shadow.map(r => r.turn!.cost!.onSessionModel))
      const onTier = sum(shadow.map(r => r.turn!.cost!.onTier))
      lines.push(`  shadow: would have saved ${usd(onSessionModel - onTier)} of ${usd(onSessionModel)}`)
    }
    const byTier = [...TIERS.map(t => t.id), null].flatMap(tier => {
      const mine = priced.filter(r => r.tier === tier)
      return mine.length === 0 ? [] : [`${tier ?? 'session model'} ${mine.length} turn${mine.length === 1 ? '' : 's'} ${usd(sum(mine.map(r => r.turn!.cost!.onTier)))}`]
    })
    lines.push(`  by tier: ${byTier.join(' · ')}`)
  }

  const ended = records.filter(r => r.turn)
  const long = ended.filter(ranLongOnTrivial)
  const failed = ended.filter(failedAfterSwitch)
  const parts = [
    ...(long.length > 0 ? [`${long.length} trivial turn${long.length === 1 ? '' : 's'} ran ${THRESHOLDS.longTurnSteps}+ steps`] : []),
    ...(failed.length > 0 ? [`${failed.length} switched turn${failed.length === 1 ? '' : 's'} ended in an error or a refusal`] : []),
  ]
  if (parts.length > 0) lines.push(`under-routed: ${parts.join(' · ')}`)

  return lines
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The turns again, by the effort their first request went out with: a tier's
// effort can change between releases (hard went from high to medium in 0.1.10),
// and a turn at a lower effort answers shorter, so the outcomes of two efforts
// do not add up. Records written before the effort was kept stand apart.
function effortLines(records: readonly DecisionRecord[]): string[] {
  const ended = records.filter(r => r.turn)
  if (ended.length === 0) return []
  const groups: { label: string; mine: DecisionRecord[] }[] = [
    ...EFFORTS.map(effort => ({ label: effort, mine: ended.filter(r => r.turn!.effort === effort) })),
    { label: 'default', mine: ended.filter(r => r.turn!.effort === null) },
    { label: 'not kept', mine: ended.filter(r => r.turn!.effort === undefined) },
  ].filter(g => g.mine.length > 0)

  const lines = groups.map(({ label, mine }) => {
    const hard = mine.filter(r => effectiveTier(r.decision) === TIERS.at(-1)!.id)
    const priced = mine.filter(r => r.turn!.cost)
    const spent = priced.length === 0 ? [] : [`${usd(sum(priced.map(r => r.turn!.cost!.actual)))} spent${priced.length < mine.length ? ` on ${priced.length} priced` : ''}`]
    const cells = [
      `${mine.length} turn${mine.length === 1 ? '' : 's'}`,
      ...cell('corrected', tally(mine, r => r.corrected === true)),
      ...cell('too high', tally(hard, r => verdictSignal(r.decision, r.turn) === 'too high'), ' hard'),
      ...spent,
    ]

    return `  ${label.padEnd(8)} ${cells.join(' · ')}`
  })
  const notes = [
    ...(groups.some(g => g.label === 'default') ? ["default: the requests named no effort, so the model's own ran"] : []),
    ...(groups.some(g => g.label === 'not kept') ? ['not kept: recorded before the effort was kept (0.1.10)'] : []),
  ]

  return [
    '',
    "turns, by the effort they ran at (too high counts the deciding judge's hard verdicts):",
    ...lines,
    ...(notes.length > 0 ? [`  ${notes.join(' · ')}`] : []),
  ]
}
