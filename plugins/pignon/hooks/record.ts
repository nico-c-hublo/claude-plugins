import type { DecisionRecord, LogEntry } from '../types'
import { effectiveTier } from './policy'

// A session file holds this many records at most; the oldest go first.
export const MAX_RECORDS = 3_000
export const KEEP_DAYS = 90
const REASON_CHARS = 80

export type RecordContext = {
  session: string
  project: string
  mode: 'live' | 'shadow'
  chosen: 'haiku' | 'laya'
  daemon: 'session' | 'shared' | null
  promptChars: number
  was: string | null
  model: string
  contextTokens: number
}

// What a log entry leaves in the file: everything but the words of the prompt.
export function recordOf(entry: LogEntry, context: RecordContext): DecisionRecord {
  const second = entry.second && !entry.second.isPending ? { decision: entry.second.decision, ms: entry.second.ms } : undefined

  return {
    v: 1,
    session: context.session,
    n: entry.id,
    at: entry.at,
    project: context.project,
    mode: context.mode,
    chosen: context.chosen,
    daemon: context.daemon,
    decider: entry.decider,
    promptChars: context.promptChars,
    ...(entry.tiers && { tiers: entry.tiers }),
    decision: entry.decision,
    ...(second && { second }),
    ...(entry.fallback && { fallback: entry.fallback }),
    ms: entry.ms,
    ...(entry.daemonMs !== undefined && { daemonMs: entry.daemonMs }),
    action: entry.action,
    was: context.was,
    tier: entry.tier,
    reason: entry.reason.slice(0, REASON_CHARS),
    model: context.model,
    contextTokens: context.contextTokens,
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

function share(part: number, whole: number): string {
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

  return lines.join('\n')
}
