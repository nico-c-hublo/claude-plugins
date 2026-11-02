import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, DecisionRecord, Effort, LogEntry, Mark, OracleOpinion, TurnOutcome } from '../types'
import type { DeciderId } from './policy'
import { KEEP_DAYS, MAX_RECORDS, parseRecords, recordOf, scoreByJudge, scoreCells, serialize, settled, summarize } from './record'
import {
  DECIDER_SYSTEM,
  LOCAL_PROMPT_CHARS,
  MARKS,
  THRESHOLDS,
  TIERS,
  acceptedTiers,
  decide,
  decisionFromTiers,
  effectiveTier,
  isAccepted,
  isCorrection,
  isFollowUp,
  isMarkWord,
  isUnderRouted,
  markLabel,
  parseDecision,
  shownTier,
  tierOf,
} from './policy'
import { priceOf, turnCost, usd } from './prices'

type Mode = 'live' | 'shadow' | 'off'
const MODES: readonly Mode[] = ['live', 'shadow', 'off']

const current = atom({ plugin: 'pignon', key: 'current' } as const, null as string | null)
const promptsSinceSwitch = atom({ plugin: 'pignon', key: 'promptsSinceSwitch' } as const, 0)
const contextTokens = atom({ plugin: 'pignon', key: 'contextTokens' } as const, 0)
const base = atom({ plugin: 'pignon', key: 'base' } as const, null as string | null)
const isPinned = atom({ plugin: 'pignon', key: 'isPinned' } as const, false)
const log = atom({ plugin: 'pignon', key: 'log' } as const, [] as LogEntry[], { shape: 'log-5' })
const nextId = atom({ plugin: 'pignon', key: 'nextId' } as const, 0)
const lastRequestAt = atom({ plugin: 'pignon', key: 'lastRequestAt' } as const, 0)
const isCompacted = atom({ plugin: 'pignon', key: 'isCompacted' } as const, false)

const PANE = 'decisions'

// A judge reads the same blind input: the system prompt, the tier in force, the start of the prompt.
type Judge = { model: string; effort: Effort; maxTokens: number; timeoutMs: number }
const HAIKU: Judge = { model: 'haiku', effort: 'low', maxTokens: 100, timeoutMs: 5_000 }
// The reference the others are scored against, in shadow mode when the oracle is
// on: the strongest model, asked once the turn has ended so it never competes with
// it. Medium effort, and room enough that thinking does not eat the answer.
const ORACLE: Judge = { model: 'opus', effort: 'medium', maxTokens: 4_096, timeoutMs: 60_000 }
const PROMPT_CHARS = 4_000
// The daemon answers in about 10 ms; this is for one that is stuck.
const LOCAL_TIMEOUT_MS = 1_500
const CONNECTION_FAILED = 'the connection failed'
// The launcher returns once the model has loaded, and gives up after 120 s itself.
const LAUNCH_TIMEOUT_MS = 130_000
// A daemon is looked at again this often: a process that was clean at its start may not stay so.
const AUDIT_EVERY_MS = 5 * 60_000
// lsof takes tens of milliseconds; one that hangs would stall every prompt, and counts as a failed check.
const LSOF_TIMEOUT_MS = 2_000

// How long the API keeps a cached prefix without a request: past it, a switch costs nothing.
type CacheTtl = '5m' | '1h'
const CACHE_TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// The main conversation's cache lifetime, read where the engine reads it and in
// its order: FORCE_PROMPT_CACHING_5M, the env var, the setting, then
// ENABLE_PROMPT_CACHING_1H. Past those the engine's default depends on the login
// (an hour on a subscription within its plan, five minutes on an API key or a
// cloud provider, five again once in overage) and it may renew the cache itself,
// none of which a mod can see. The guess is then an hour: a cache called cold
// while warm costs a re-cache of the context; one called warm while cold only
// forgoes a free switch.
async function resolveCacheTtl($: EngineInterface, option: unknown): Promise<{ ttl: CacheTtl; source: string }> {
  if (option === '5m' || option === '1h') return { ttl: option, source: 'option' }
  const isOn = (value: string | undefined) => value !== undefined && value !== '' && value !== '0' && value !== 'false'
  // Each read on its own: one that fails (an unset variable in a mocked engine) must not hide the rest.
  const unset = () => undefined
  if (isOn(await $.env.get('FORCE_PROMPT_CACHING_5M').catch(unset))) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  const env = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(unset)
  if (env === '5m' || env === '1h') return { ttl: env, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const setting = await $.settings.read({ key: 'promptCacheTtl' }).catch(unset)
  if (setting === '5m' || setting === '1h') return { ttl: setting, source: 'promptCacheTtl setting' }
  if (isOn(await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(unset))) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }

  return { ttl: '1h', source: 'assumed' }
}

// Shadow until the person has watched a few decisions and says `/pignon live`.
async function modeOf($: EngineInterface): Promise<Mode> {
  const mode = await $.store.get('mode')
  return MODES.includes(mode as Mode) ? (mode as Mode) : 'shadow'
}

// A judge's verdict on the prompt, and what asking cost at list price.
async function askJudge($: EngineInterface, judge: Judge, text: string, tier: string | null): Promise<{ decision: Decision | null; cost?: number }> {
  const reply = await $.model.complete({
    model: judge.model,
    system: DECIDER_SYSTEM,
    prompt: `Current tier: ${tier ?? 'none'}\n\n<prompt>\n${text.slice(0, PROMPT_CHARS)}\n</prompt>`,
    maxTokens: judge.maxTokens,
    effort: judge.effort,
    timeoutMs: judge.timeoutMs,
  })
  const usage = reply.usage
  const cost = usage
    ? priceOf(
        { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens },
        judge.model,
      )
    : null

  return { decision: reply.isAnswered ? parseDecision(reply.text) : null, ...(cost !== null && { cost }) }
}

// What lands on an entry after its decision (Haiku's and the oracle's opinions,
// the turn's end, a correction, your mark), and on its record when the log is kept.
type Amendment = Partial<Pick<LogEntry, 'second' | 'oracle' | 'turn' | 'corrected' | 'mark'>>

async function amendEntry($: EngineInterface, id: number, fields: Amendment, isRecording: boolean): Promise<void> {
  await update($, log, list => list.map(entry => (entry.id === id ? { ...entry, ...fields } : entry)))
  if (isRecording) await amendRecord($, id, fields)
}

// Haiku's opinion on a prompt the local model decided, for comparison. Shadow
// mode switches nothing, so no turn waits for it: it fills in the entry later.
async function secondOpinion(
  $: EngineInterface,
  id: number,
  text: string,
  tier: string | null,
  isRecording: boolean,
): Promise<void> {
  const startedAt = await $.clock.now()
  const decision = await askJudge($, HAIKU, text, tier).then(answer => answer.decision, () => null)
  const ms = Math.round((await $.clock.now()) - startedAt)

  await amendEntry($, id, { second: { decision, ms } }, isRecording)
}

// Opus's opinion on a judged prompt, the reference the judges are scored against.
// Asked when its turn has ended, in the background: shadow mode switches nothing.
async function oracleOpinion(
  $: EngineInterface,
  id: number,
  text: string,
  tier: string | null,
  isRecording: boolean,
): Promise<void> {
  const startedAt = await $.clock.now()
  const answer = await askJudge($, ORACLE, text, tier).catch(() => ({ decision: null }) as { decision: null; cost?: number })
  const oracle: OracleOpinion = {
    decision: answer.decision,
    ms: Math.round((await $.clock.now()) - startedAt),
    ...(answer.cost !== undefined && { cost: answer.cost }),
  }

  await amendEntry($, id, { oracle }, isRecording)
}

// The entry a mark applies to: the newest a judge decided (an acknowledgement has no verdict to mark).
function markable(entries: readonly LogEntry[]): LogEntry | undefined {
  return entries.findLast(entry => entry.decider !== 'rule')
}

// What a decision's line said, the reference a relative mark is taken against:
// `kept hard (laya said trivial)`.
function shownLine(entry: LogEntry): string {
  const shown = shownTier(entry) ?? 'the session model'
  const said = effectiveTier(entry.decision)
  const outcome = entry.action === 'kept' ? `kept ${shown}` : `${entry.action} to ${shown}`

  return said === null || said === shown ? `${entry.decider} said ${said ?? 'nothing'}, ${outcome}` : `${outcome}, ${entry.decider} said ${said}`
}

// Your verdict on entry `id`: which tiers would have been right. A relative mark
// is taken against the tier the decision's line named, which ran in live mode,
// not against a verdict a bar or the cache guard set aside. Says what was marked, or why not.
async function markEntry($: EngineInterface, id: number, said: string, isRecording: boolean): Promise<string> {
  const entry = (await read($, log)).find(item => item.id === id)
  if (!entry) return 'That decision is no longer in the log.'
  const of = shownTier(entry)
  const accepted = acceptedTiers(said, of)
  if (!accepted) {
    return of === null
      ? `“${entry.prompt}” ran on a model of no tier: name the right tier (/pignon mark ${TIERS.map(t => t.id).join('|')}).`
      : `Nothing is ${said === 'low' ? 'above' : 'below'} ${of}: mark it ok, or name the right tier.`
  }
  const mark: Mark = { said, of: isMarkWord(said) ? of : null, accepted }
  await amendEntry($, id, { mark }, isRecording)

  return (
    `Marked #${id} “${entry.prompt}” (${shownLine(entry)}): the right tier is ${accepted.join(' or ')}.` +
    (isRecording ? '' : ' The decision log is off, so the mark counts in /pignon compare for this session only; turn the log on to count marks in /pignon stats.')
  )
}

// What the local model's daemon answered, or why there is no answer.
type LocalAnswer = { decision: Decision; tiers: Record<string, number>; daemonMs: number | undefined }
type LocalFailure = { cause: string }

// The local model's daemon, over its Unix socket: a path no proxy and no other
// user can reach, so the prompt goes nowhere else.
async function askLocal(
  $: EngineInterface,
  socketPath: string,
  text: string,
  contextSize: number,
): Promise<LocalAnswer | LocalFailure> {
  const prompt = text.slice(0, PROMPT_CHARS)
  const answer = $.http.fetch('http://pignon/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(contextSize > 0 ? { prompt, contextTokens: contextSize } : { prompt }),
    socketPath,
  })
  // `fetch` has no timeout of its own, and the turn waits on this.
  const reply = await Promise.race([answer, $.clock.sleep(LOCAL_TIMEOUT_MS).then(() => null)]).catch(() => undefined)
  if (reply === undefined) return { cause: CONNECTION_FAILED }
  if (reply === null) return { cause: `it timed out after ${LOCAL_TIMEOUT_MS / 1000} s` }
  if (!reply.ok) return { cause: `it answered HTTP ${reply.status}` }

  try {
    const body = JSON.parse(reply.text) as { tiers: Record<string, number>; latencyMs?: number }
    const decision = decisionFromTiers(body.tiers)
    if (decision) return { decision, tiers: body.tiers, daemonMs: body.latencyMs }
  } catch {
    // falls through: an answer that is not JSON is as unusable as an empty one
  }

  return { cause: 'it answered nothing usable' }
}

// The pid of the daemon answering on `socketPath`, or null when none does.
async function healthPid($: EngineInterface, socketPath: string): Promise<number | null> {
  const answer = $.http.fetch('http://pignon/health', { socketPath })
  const reply = await Promise.race([answer, $.clock.sleep(LOCAL_TIMEOUT_MS).then(() => null)]).catch(() => null)
  if (!reply?.ok) return null

  try {
    const { pid } = JSON.parse(reply.text) as { pid?: unknown }

    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

// FNV-1a, enough to tell mod folders apart in a directory name.
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)

  return (hash >>> 0).toString(16).padStart(8, '0')
}

// The shared daemon's socket, in a directory per mod folder: a new version of the
// mod starts a daemon of its own, and the old one leaves when it has been idle.
async function sharedSocket($: EngineInterface): Promise<string> {
  return `${await dataHome($)}/run-${shortHash($.plugin.root)}/s.sock`
}

// What a session knows of the local model's daemon.
type LocalDaemon = {
  // Set once the daemon answers; routing asks Haiku until then.
  socketPath: string | null
  isStarting: boolean
  // The process whose sockets were last checked, and when; a new one is checked again.
  auditedPid: number | null
  auditedAt: number
}

// Looks at the daemon's sockets again when the last look is old, and stops using
// it if it now holds a network one. Run before a prompt reaches it.
async function auditAgain($: EngineInterface, daemon: LocalDaemon): Promise<void> {
  if (daemon.socketPath === null || daemon.auditedPid === null) return
  const now = await $.clock.now()
  // A clock set back would otherwise skip the audit until it caught up.
  const age = now - daemon.auditedAt
  if (age >= 0 && age < AUDIT_EVERY_MS) return

  const problem = await socketProblem($, String(daemon.auditedPid))
  if (problem === null) {
    daemon.auditedAt = now

    return
  }
  $.ui.toast(`pignon: the local model (pid ${daemon.auditedPid}) ${problem}, so it is not used. Haiku decides.`)
  daemon.socketPath = null
  daemon.auditedPid = null
}

// Reaches the shared daemon, starting it when nothing answers. It never throws:
// when it cannot, Haiku decides until the next try, which a lost connection triggers.
async function connectShared($: EngineInterface, daemon: LocalDaemon): Promise<void> {
  if (daemon.isStarting) return
  daemon.isStarting = true
  try {
    const path = await sharedSocket($)
    let pid = await healthPid($, path)
    if (pid === null) {
      const home = await dataHome($)
      const launched = await $.process
        .run([`${home}/venv/bin/python`, '-m', 'pignon_decider', '--socket', path, '--model', `${home}/model`, '--shared'], {
          cwd: `${$.plugin.root}/daemon`,
          timeoutMs: LAUNCH_TIMEOUT_MS,
        })
        .catch(() => null)
      if (launched === null || launched.exitCode !== 0) {
        const said = launched ? ` (${launched.stdout.trim() || 'no answer'})` : ''
        $.ui.toast(`pignon: the shared local model did not start${said}. Haiku decides. /pignon setup builds it.`)

        return
      }
      pid = await healthPid($, path)
    }
    if (pid === null) return

    const now = await $.clock.now()
    if (pid !== daemon.auditedPid || now - daemon.auditedAt >= AUDIT_EVERY_MS) {
      const problem = await socketProblem($, String(pid))
      if (problem !== null) {
        $.ui.toast(`pignon: the shared local model (pid ${pid}) ${problem}, so it is not used. Haiku decides.`)

        return
      }
      daemon.auditedPid = pid
      daemon.auditedAt = now
    }
    daemon.socketPath = path
  } finally {
    daemon.isStarting = false
  }
}

// The decision log (see record.ts): one file per session, rewritten whole, since
// the engine's fs has no append and two sessions on one file would lose lines.
const kept: DecisionRecord[] = []
let keptFile: string | null = null
let session: string | null = null
let flushing: Promise<void> = Promise.resolve()
let hasFailedToWrite = false

function sessionId(): string {
  session ??= randomHex(4)

  return session
}

async function decisionsDir($: EngineInterface): Promise<string> {
  return `${await dataHome($)}/decisions`
}

// Never throws: a log that cannot be written must not cost a prompt.
async function writeKept($: EngineInterface): Promise<void> {
  try {
    if (keptFile === null) {
      const dir = await decisionsDir($)
      await $.process.run(['mkdir', '-p', '-m', '700', dir])
      const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').slice(0, 15)
      keptFile = `${dir}/${stamp}-${sessionId()}.jsonl`
    }
    await $.fs.write(keptFile, serialize(kept))
  } catch {
    if (!hasFailedToWrite) $.ui.toast('pignon: the decision log could not be written.')
    hasFailedToWrite = true
  }
}

function keep($: EngineInterface, change: (list: DecisionRecord[]) => void): Promise<void> {
  change(kept)
  if (kept.length > MAX_RECORDS) kept.splice(0, kept.length - MAX_RECORDS)
  flushing = flushing.then(() => writeKept($))

  return flushing
}

async function recordDecision($: EngineInterface, record: DecisionRecord): Promise<void> {
  await keep($, list => {
    list.push(record)
  })
}

// What lands after the decision (Haiku's and the oracle's opinions, the turn's
// end, a correction, your mark) fills in the record already kept.
async function amendRecord($: EngineInterface, id: number, fields: Amendment): Promise<void> {
  const { second, oracle, ...rest } = fields
  await keep($, list => {
    const record = list.find(r => r.session === sessionId() && r.n === id)
    if (!record) return
    // A pending opinion is not kept: the record waits for the answer.
    Object.assign(record, rest, settled(second) && { second: settled(second) }, settled(oracle) && { oracle: settled(oracle) })
  })
}

// A routed turn still running: which entry it is, how many requests it has made
// and the session's model, for the cost comparison when it ends.
type RunningTurn = {
  id: number
  steps: number
  model: string
  /** What the oracle is asked once the turn has ended, when it is on. */
  oracle?: OracleInput
}

// The turn has ended: what it did goes on its entry, and on the record when kept.
async function finishTurn(
  $: EngineInterface,
  turn: RunningTurn,
  e: { reason: TurnOutcome['reason']; durationMs: number; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string } },
  isRecording: boolean,
): Promise<void> {
  const entry = (await read($, log)).find(item => item.id === turn.id)
  if (!entry) return
  const u = e.usage
  const usage = u
    ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, model: u.model }
    : undefined
  const cost = usage ? turnCost(usage, turn.model, entry.tier) : null
  const outcome: TurnOutcome = {
    steps: turn.steps,
    reason: e.reason,
    durationMs: e.durationMs,
    ...(usage && { usage }),
    ...(cost && { cost }),
  }
  await amendEntry($, turn.id, { turn: outcome }, isRecording)
  if (turn.oracle) void oracleOpinion($, turn.id, turn.oracle.text, turn.oracle.tier, isRecording)
}

async function pruneLog($: EngineInterface): Promise<void> {
  const dir = await decisionsDir($)
  await $.process.run(['find', dir, '-name', '*.jsonl', '-mtime', `+${KEEP_DAYS}`, '-delete']).catch(() => null)
}

// `/pignon stats [days]`: the newest 200 session files, summed.
async function statsReport($: EngineInterface, daysArg: string): Promise<string> {
  const days = Number.parseInt(daysArg, 10)
  const dir = await decisionsDir($)
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200)
  const since = days > 0 ? (await $.clock.now()) - days * 86_400_000 : 0
  const records: DecisionRecord[] = []
  let sessions = 0
  for (const file of files) {
    const text = (await $.fs.read(`${dir}/${file.name}`).catch(() => '')) as string
    const mine = parseRecords(text).filter(r => r.at >= since)
    if (mine.length > 0) sessions++
    records.push(...mine)
  }

  return summarize(records, sessions)
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Starts the local model's daemon and keeps it for the session: the child
// lives while this loop reads it, and ends with the module.
// Where the environment and the model live: beside the person's other Claude files.
async function dataHome($: EngineInterface): Promise<string> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`

  return `${config}/pignon`
}

// Exits non-zero unless the interpreter runs and finds the packages the daemon imports, without importing them (that would start Metal).
// Run with -I, so a folder in the working directory named like a package cannot stand in for it.
const ENVIRONMENT_CHECK =
  'import importlib.util, sys; sys.exit(any(importlib.util.find_spec(name) is None for name in ("laya_mlx", "mlx", "numpy", "tokenizers")))'

// `/pignon setup`: the Python environment from the hash-locked file, then the pinned model.
async function runSetup($: EngineInterface): Promise<string> {
  const uv = await $.process.run(['uv', '--version']).catch(() => null)
  if (uv === null || uv.exitCode !== 0) {
    return 'pignon needs uv to build its Python environment. Install it (https://docs.astral.sh/uv/getting-started/installation/), then run /pignon setup again.'
  }

  const home = await dataHome($)
  const daemon = `${$.plugin.root}/daemon`
  const python = `${home}/venv/bin/python`
  const run = async (argv: string[]): Promise<string | null> => {
    const step = await $.process.run(argv, { cwd: daemon, timeoutMs: 600_000 }).catch(error => ({
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    }))
    if (step.exitCode === 0) return null
    const reason = step.stderr.trim().split('\n').slice(-5).join('\n')

    return `pignon setup failed at \`${argv.slice(0, 3).join(' ')}\`:\n${reason}\nFix that, then run /pignon setup again.`
  }

  const made = await run(['mkdir', '-p', home])
  if (made !== null) return made

  // The lock the venv was built from. Rebuilding for nothing, or under a running daemon, is what it avoids.
  const lock = (await $.fs.read(`${daemon}/requirements.lock`).catch(() => '')) as string
  const built = `${home}/venv.lock`
  const isCurrent =
    lock !== '' &&
    ((await $.fs.read(built).catch(() => '')) as string) === lock &&
    (await $.process.run([python, '-I', '-c', ENVIRONMENT_CHECK]).catch(() => null))?.exitCode === 0
  if (!isCurrent) {
    // Emptied first, so a rebuild that stops halfway is redone next time.
    await $.fs.write(built, '')
    const failure =
      (await run(['uv', 'venv', '--clear', '--python', '3.13', `${home}/venv`])) ??
      (await run(['uv', 'pip', 'install', '--python', python, '--require-hashes', '--no-deps', '--only-binary', ':all:', '-r', `${daemon}/requirements.lock`]))
    if (failure !== null) return failure
    await $.fs.write(built, lock)
  }

  const downloaded = await run([python, '-m', 'pignon_decider.setup', '--dest', `${home}/model`])
  if (downloaded !== null) return downloaded

  return 'pignon: the local model is ready. Pick laya for "Who judges each prompt" in /config (the pignon row), then run /pignon: it should say "decider: laya (running)".'
}

async function launchDaemon($: EngineInterface, daemon: LocalDaemon): Promise<void> {
  const home = await dataHome($)
  const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  // A directory of its own, so the socket is private whatever the rest of the temp folder allows.
  const directory = `${temp}/pignon-${randomHex(4)}`
  await $.process.run(['mkdir', '-m', '700', directory])

  const child = $.process.spawn({
    argv: [`${home}/venv/bin/python`, '-m', 'pignon_decider', '--socket', `${directory}/s.sock`, '--model', `${home}/model`],
    cwd: `${$.plugin.root}/daemon`,
  })
  let isReady = false
  try {
    for await (const piece of child) {
      const pid = piece.stream === 'stdout' ? /^ready (\d+)/m.exec(piece.text)?.[1] : undefined
      if (pid === undefined) continue
      const problem = await socketProblem($, pid)
      if (problem !== null) {
        $.ui.toast(`pignon: the local model ${problem}, so it is stopped. Haiku decides.`)
        break // leaving the loop kills the child
      }
      daemon.auditedPid = Number(pid)
      daemon.auditedAt = await $.clock.now()
      daemon.socketPath = `${directory}/s.sock`
      isReady = true
    }
  } finally {
    // However the child ended, even by a stream that failed, it is not asked again.
    daemon.socketPath = null
    daemon.auditedPid = null
    if (isReady) $.ui.toast('pignon: the local model stopped. Haiku decides until you restart the session.')
  }
}

// The daemon's code is audited and its environment stripped; this checks the
// result on the running process. Null when it holds no network socket, else why
// it is refused. Unable to check counts as failing it, and says so: an lsof that
// failed is not a leak.
async function socketProblem($: EngineInterface, pid: string): Promise<string | null> {
  const sockets = await $.process.run(['/usr/sbin/lsof', '-a', '-p', pid, '-i', '-n', '-P'], { timeoutMs: LSOF_TIMEOUT_MS }).catch(() => null)
  if (sockets === null || sockets.exitCode > 1) return 'could not be checked for network sockets'

  return sockets.stdout.trim() === '' ? null : 'holds a network socket'
}

// The text lines of an entry, as the pane draws them: what it measures with too.
function entryLines(entry: LogEntry): string[] {
  return [
    `${clockTime(entry.at)} ${entry.decider.padEnd(5)} ${entry.sent || entry.prompt}`,
    ...(entry.fallback ? [`laya unavailable: ${entry.fallback}`] : []),
    entry.tiers ? TIERS.map(tier => tierBar(entry, tier.id)).join('  ') : verdictLine(entry),
    ...(secondLine(entry) ? [secondLine(entry)!] : []),
    ...(oracleLine(entry) ? [oracleLine(entry)!] : []),
    outcomeLine(entry),
    entry.reason,
    ...(turnLine(entry) ? [turnLine(entry)!] : []),
    ...(judgedLine(entry) ? [judgedLine(entry)!] : []),
  ]
}

// The verdict's labels: the correction that followed it, your mark and whether
// the judge's tier is one it accepts ("you marked hard right · the judge said trivial").
function judgedLine(entry: LogEntry): string | undefined {
  const mark = entry.mark
  const parts = [
    ...(entry.corrected ? ['the next prompt was a correction'] : []),
    ...(mark ? [`you marked ${mark.of === null ? `${mark.said} as the right tier` : `${mark.of} ${markLabel(mark.said)}`}`] : []),
    ...(mark ? [isAccepted(mark, entry.decision) ? 'the judge was right' : `the judge said ${effectiveTier(entry.decision) ?? 'nothing'}`] : []),
  ]

  return parts.length > 0 ? parts.join(' · ') : undefined
}

// A second judge's opinion on the prompt, against the judge that decided: Haiku's
// beside the local model, Opus's when the oracle is on.
type Opinion = { decision: Decision | null; ms: number; isPending?: boolean }

function opinionLine(judge: string, opinion: Opinion | undefined, entry: LogEntry, pending = 'asking...'): string | undefined {
  if (!opinion) return undefined
  if (opinion.isPending) return `${judge}: ${pending}`
  const d = opinion.decision
  if (!d) return `${judge}: no answer`

  return `${judge} ${sameTier(d, entry.decision) ? 'agrees' : 'differs'}: ${d.tier}${d.explore ? '/explore' : ''} p=${d.confidence.toFixed(2)} · ${opinion.ms} ms`
}

// Green when it agrees, yellow when it differs, dim while it has not answered.
function opinionColor(opinion: Opinion | undefined, entry: LogEntry): string {
  if (!opinion?.decision) return 'inactive'

  return sameTier(opinion.decision, entry.decision) ? 'success' : 'warning'
}

// Whether two judges would run the same tier.
function sameTier(a: Decision | null, b: Decision | null): boolean {
  const tier = effectiveTier(a)

  return tier !== null && tier === effectiveTier(b)
}

const secondLine = (entry: LogEntry) => opinionLine('haiku', entry.second, entry)
const oracleLine = (entry: LogEntry) => opinionLine('opus', entry.oracle, entry, 'asked when the turn ends')

// What the turn did once it ended: its requests, its time, what it cost against
// the session model (or would have, in shadow mode), and whether the tier held.
function turnLine(entry: LogEntry): string | undefined {
  const turn = entry.turn
  if (!turn) return undefined
  const cost = turn.cost
  const money = !cost
    ? ''
    : entry.action === 'switched'
      ? ` · ${usd(cost.actual)} (session model ${usd(cost.onSessionModel)})`
      : entry.action === 'would switch'
        ? ` · ${usd(cost.actual)} (would be ${usd(cost.onTier)} on ${entry.tier})`
        : ` · ${usd(cost.actual)}`
  const ended = turn.reason === 'answer' ? '' : ` · ${turn.reason}`

  return `${turn.steps} step${turn.steps === 1 ? '' : 's'} · ${Math.round(turn.durationMs / 1000)} s${money}${ended}${isUnderRouted(entry) ? ' · under-routed' : ''}`
}

// This session's spend and savings, from the entries whose turn was priced.
function sessionSavings(entries: readonly LogEntry[], mode: Mode): string {
  const priced = entries.filter(entry => entry.turn?.cost)
  if (priced.length === 0) return 'this session: no turn priced yet'
  const total = (pick: (cost: NonNullable<TurnOutcome['cost']>) => number) => priced.reduce((sum, entry) => sum + pick(entry.turn!.cost!), 0)
  if (mode === 'live') return `this session: spent ${usd(total(c => c.actual))} · saved ${usd(total(c => c.onSessionModel - c.actual))} (estimated at list price)`

  return `this session: would have saved ${usd(total(c => c.onSessionModel - c.onTier))} of ${usd(total(c => c.onSessionModel))} (estimated at list price)`
}

// Whether Haiku would run the same tier as the judge that decided.
const agrees = (entry: LogEntry) => sameTier(entry.second?.decision ?? null, entry.decision)

// `/pignon compare`: how often the two judges would run the same tier and where
// they differ, then how each fares against the oracle and your marks.
function compareReport(entries: readonly LogEntry[]): string {
  const sections = [judgesReport(entries), referenceReport(entries)].filter(section => section !== '')
  if (sections.length === 0) {
    return 'No comparisons yet. Choose laya as the decider, stay in shadow mode (/pignon shadow) and send a few prompts: Haiku is then asked for a second opinion on each. With the oracle on, Opus is asked too; /pignon mark adds your own verdict.'
  }

  return sections.join('\n')
}

// Each judge on the outcomes, the oracle and your marks, this session: the line
// /pignon stats prints for it across sessions.
function referenceReport(entries: readonly LogEntry[]): string {
  const lines = scoreByJudge(entries).flatMap(({ judge, score }) => {
    const cells = scoreCells(judge, score)
    return cells.length === 0 ? [] : [`  ${judge.padEnd(6)} ${cells.join(' · ')}`]
  })

  return lines.length === 0 ? '' : ['Judges this session:', ...lines].join('\n')
}

function judgesReport(entries: readonly LogEntry[]): string {
  const asked = entries.filter(entry => entry.second)
  if (asked.length === 0) return ''
  const answered = asked.filter(entry => entry.second?.decision)
  const differ = answered.filter(entry => !agrees(entry))
  const noAnswer = asked.filter(entry => !entry.second?.isPending && !entry.second?.decision).length
  const pending = asked.filter(entry => entry.second?.isPending).length
  const share = answered.length === 0 ? 0 : Math.round(((answered.length - differ.length) / answered.length) * 100)
  const summary =
    `${answered.length} compared: ${answered.length - differ.length} agree (${share}%), ${differ.length} differ.` +
    (noAnswer > 0 ? ` Haiku gave no answer for ${noAnswer}.` : '') +
    (pending > 0 ? ` ${pending} still pending.` : '')
  if (differ.length === 0) return summary

  const lines = differ.slice(-15).map(entry => {
    const opinion = entry.second?.decision
    return `  ${entry.decision?.tier} → ${opinion?.tier}${opinion?.explore ? '/explore' : ''}  “${entry.prompt}”`
  })

  return [summary, 'Differences (laya → haiku):', ...lines].join('\n')
}

// The pane's colours are theme keys, so they follow the person's theme.
const DECIDER_COLOR: Record<LogEntry['decider'], string> = { laya: 'suggestion', haiku: 'claude', rule: 'inactive' }
const TIER_COLOR: Record<string, string> = { trivial: 'success', standard: 'warning', hard: 'error' }
const ACTION_COLOR: Record<LogEntry['action'], string> = { switched: 'success', 'would switch': 'warning', kept: 'inactive' }

// The tier the local model gave the most probability.
function leadingTier(entry: LogEntry): string | undefined {
  return Object.entries(entry.tiers ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0]
}

function tierBar(entry: LogEntry, id: string): string {
  const probability = entry.tiers?.[id] ?? 0

  return `${id} ${bar(probability)} ${probability.toFixed(2)}`
}

// The pane's mark buttons, under the newest judged entry until it is marked: the
// relative marks that apply to the tier its line named, or the tiers by name when none did.
function markButtons(entry: LogEntry): { said: string; hotkey: string; label: string }[] {
  const of = shownTier(entry)
  const choices = of === null ? TIERS.map(t => t.id) : Object.keys(MARKS).filter(said => acceptedTiers(said, of) !== null)

  return choices.map((said, i) => ({ said, hotkey: String(i + 1), label: markLabel(said) }))
}

function hasMarkButtons(entry: LogEntry, entries: readonly LogEntry[]): boolean {
  return !entry.mark && entry.id === markable(entries)?.id
}

// Rows an entry takes at `columns` wide: each line wraps, a row of mark buttons may follow, then a gap.
function entryRows(entry: LogEntry, columns: number, entries: readonly LogEntry[]): number {
  const buttons = hasMarkButtons(entry, entries) ? 1 : 0

  return entryLines(entry).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 1 + buttons)
}

// The newest entries that fit `rows`, leaving one row for the note on the rest.
function newestThatFit(entries: readonly LogEntry[], rows: number, columns: number): readonly LogEntry[] {
  const total = entries.reduce((sum, entry) => sum + entryRows(entry, columns, entries), 0)
  if (total <= rows) return entries

  const fit: LogEntry[] = []
  let used = 1
  for (const entry of [...entries].reverse()) {
    used += entryRows(entry, columns, entries)
    if (used > rows && fit.length > 0) break
    fit.unshift(entry)
  }

  return fit
}

function clockTime(ms: number): string {
  const at = new Date(ms)

  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function bar(probability: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, probability)) * 8)

  return '█'.repeat(filled) + '░'.repeat(8 - filled)
}

// What a decider with no probabilities said: Haiku's guess, or the rule's keep.
function verdictLine(entry: LogEntry): string {
  if (entry.decider === 'rule') return 'an acknowledgement: the tier is kept'
  const d = entry.decision

  return d ? `decided ${d.tier}${d.explore ? '/explore' : ''} p=${d.confidence.toFixed(2)}` : 'no decision'
}

function outcomeLine(entry: LogEntry): string {
  const daemon = entry.daemonMs === undefined ? '' : ` (daemon ${entry.daemonMs} ms)`
  const outcome = entry.action === 'kept' ? 'kept' : `${entry.action} to`

  return `${entry.ms} ms${daemon} · ${outcome} ${describe(entry.tier)}`
}

function describe(id: string | null): string {
  const tier = tierOf(id)
  return tier ? `${tier.id} · ${tier.model}/${tier.effort}` : 'session model'
}

// What the oracle reads: the prompt and the tier in force, as the judges did.
type OracleInput = { text: string; tier: string | null }

// What a session was set up with, for each prompt it routes.
type Settings = {
  wantsLocal: boolean
  daemon: LocalDaemon
  isShared: boolean
  isRecording: boolean
  cacheTtlMs: number
  hasOracle: boolean
}

async function route(
  $: EngineInterface,
  text: string,
  model: string,
  effort: Effort | undefined,
  mode: Mode,
  { wantsLocal, daemon, isShared, isRecording, cacheTtlMs, hasOracle }: Settings,
): Promise<{ id: number; oracle?: OracleInput }> {
  const was = await read($, current)
  const startedAt = await $.clock.now()
  const contextSize = await read($, contextTokens)
  // A compaction dropped the cached prefix, or the TTL has: the guards are moot.
  const lastAt = await read($, lastRequestAt)
  const isCacheCold = (await read($, isCompacted)) || (lastAt > 0 && startedAt - lastAt > cacheTtlMs)
  let decider: DeciderId = 'laya'
  // An acknowledgement needs no judge: it keeps the tier, whoever would have been asked.
  const isAcknowledgement = isFollowUp(text)
  let decision: Decision | null = isAcknowledgement ? { tier: 'same', explore: false, confidence: 1 } : null
  let local: LocalAnswer | null = null
  let fallback: string | undefined
  if (!decision && wantsLocal) {
    await auditAgain($, daemon)
    if (daemon.socketPath === null) {
      fallback = daemon.isStarting ? 'it is starting' : 'it is not running'
    } else {
      const asked = await askLocal($, daemon.socketPath, text, contextSize)
      if ('cause' in asked) {
        fallback = asked.cause
        // A shared daemon leaves when idle: start it again for the next prompt.
        if (asked.cause === CONNECTION_FAILED && isShared) {
          daemon.socketPath = null
          void connectShared($, daemon)
        }
      } else local = asked
      decision = local?.decision ?? null
    }
  }
  if (!decision) {
    // No daemon, or it failed: Haiku, so a prompt is never left undecided.
    decider = 'haiku'
    decision = await askJudge($, HAIKU, text, was).then(answer => answer.decision, () => null)
  }
  const ms = Math.round((await $.clock.now()) - startedAt)

  const { target, reason } = decide({
    decision,
    current: was,
    sessionModel: model,
    sessionEffort: effort,
    decider,
    contextTokens: contextSize,
    promptsSinceSwitch: await read($, promptsSinceSwitch),
    isCacheCold,
  })
  const isLive = mode === 'live'
  const action = target === null ? 'kept' : isLive ? 'switched' : 'would switch'

  if (target !== null && isLive) {
    await update($, current, () => target)
    await update($, promptsSinceSwitch, () => 0)
  } else {
    await update($, promptsSinceSwitch, n => n + 1)
  }
  const now = isLive && target !== null ? target : was
  const source = isAcknowledgement ? 'rule' : decider
  const asksOracle = mode === 'shadow' && hasOracle && !isAcknowledgement
  const id = await read($, nextId)
  await update($, nextId, n => n + 1)
  const entry: LogEntry = {
    id,
    at: startedAt,
    mode: isLive ? 'live' : 'shadow',
    model,
    prompt: text.slice(0, 80).replace(/\s+/g, ' '),
    promptChars: text.length,
    sent: isAcknowledgement ? '' : text.slice(0, LOCAL_PROMPT_CHARS),
    tiers: local?.tiers,
    daemonMs: local?.daemonMs,
    fallback,
    second: mode === 'shadow' && local ? { decision: null, ms: 0, isPending: true } : undefined,
    oracle: asksOracle ? { decision: null, ms: 0, isPending: true } : undefined,
    decider: source,
    decision,
    ms,
    action,
    tier: target ?? was,
    reason,
  }
  await update($, log, list => [...list, entry].slice(-50))
  if (isRecording) {
    const context = {
      session: sessionId(),
      project: await $.session.cwd(),
      chosen: wantsLocal ? ('laya' as const) : ('haiku' as const),
      daemon: wantsLocal ? (isShared ? ('shared' as const) : ('session' as const)) : null,
      was,
      contextTokens: contextSize,
    }
    void recordDecision($, recordOf(entry, context))
  }
  if (mode === 'shadow' && local) void secondOpinion($, id, text, was, isRecording)

  const verdict = decision
    ? `${source} ${decision.tier}${decision.explore ? '/explore' : ''} p=${decision.confidence.toFixed(2)} · ${ms} ms`
    : `${source} no decision · ${ms} ms`
  const icon = action === 'switched' ? '⚡' : action === 'would switch' ? '👁' : '·'
  const outcome = action === 'kept' ? `kept ${describe(now)}` : `${action} to ${describe(target)}`
  $.ui.log(`pignon ${verdict}  ${icon} ${outcome} (${reason})`)
  $.ui.status(`pignon ${mode}: ${describe(now)}`)

  return { id, ...(asksOracle && { oracle: { text, tier: was } }) }
}

// Whether the person picked a model or effort by hand: the request names the
// session's model until a hook rewrites it, so a change here is theirs, and wins.
async function hasPinned($: EngineInterface, e: { model: string; effort?: unknown }): Promise<boolean> {
  const seen = `${e.model}|${e.effort ?? ''}`
  const known = await read($, base)
  await update($, base, () => seen)
  if (known !== null && known !== seen && !(await read($, isPinned))) {
    await update($, isPinned, () => true)
    await update($, current, () => null)
    $.ui.toast(`pignon paused: you picked ${e.model}. /pignon unpin to resume.`)
    $.ui.status('pignon pinned')
  }

  return read($, isPinned)
}

export const register: Register = (on, options) => {
  const decider: DeciderId = options.decider === 'laya' ? 'laya' : 'haiku'
  const daemon: LocalDaemon = { socketPath: null, isStarting: false, auditedPid: null, auditedAt: 0 }
  // The prompt each main turn starts with, read by its first model request.
  const prompts = new Map<string, string>()
  const isShared = decider === 'laya' && options.daemon === 'shared'
  const isRecording = options.record === 'on'
  const hasOracle = options.oracle === 'on'
  // Resolved at session start; the conservative guess until then.
  let cache: { ttl: CacheTtl; source: string } = { ttl: '1h', source: 'assumed' }
  // The routed turns still running, by turn id, until `turn.complete`.
  const turns = new Map<string, RunningTurn>()
  // The entry of the last main-loop prompt, null when it was not routed (off,
  // pinned): the turn a correction speaks of, which must not fall on an older prompt.
  let lastEntryId: number | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pignon',
      description: 'Model router: status, live, shadow, off, unpin, log, compare, mark, stats, watch, setup',
      argumentHint: '[live|shadow|off|unpin|log|compare|mark|stats|watch|setup]',
      immediate: true,
    })
    cache = await resolveCacheTtl($, options.cacheTtl).catch(() => cache)
    if (isRecording) void pruneLog($)
    if (isShared) void connectShared($, daemon)
    // A launch that fails (no folder, a spawn refused) leaves the socket unset: Haiku decides.
    else if (decider === 'laya') void launchDaemon($, daemon).catch(() => undefined)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined && e.text.trim() !== '') prompts.set(e.turnId, e.text)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const mode = await modeOf($)
    const text = prompts.get(e.turnId)
    prompts.delete(e.turnId)

    const isNewPrompt = e.index === 0 && text !== undefined
    if (isNewPrompt) {
      // Off the prompt's path: the record's rewrite must not hold the turn.
      if (lastEntryId !== null && isCorrection(text)) void amendEntry($, lastEntryId, { corrected: true }, isRecording)
      lastEntryId = null
    }

    let request = e
    if (mode !== 'off' && !(await hasPinned($, e))) {
      if (isNewPrompt) {
        const routed = await route($, text, e.model, e.effort as Effort | undefined, mode, {
          wantsLocal: decider === 'laya',
          daemon,
          isShared,
          isRecording,
          cacheTtlMs: CACHE_TTL_MS[cache.ttl],
          hasOracle,
        })
        lastEntryId = routed.id
        turns.set(e.turnId, { id: routed.id, steps: 1, model: e.model, ...(routed.oracle && { oracle: routed.oracle }) })
      } else {
        const running = turns.get(e.turnId)
        if (running) running.steps = Math.max(running.steps, e.index + 1)
      }
      const tier = mode === 'live' ? tierOf(await read($, current)) : undefined
      if (tier) request = { ...e, model: tier.model, effort: tier.effort }
    }

    const result = yield* next(request)
    if (result.usage) {
      const u = result.usage
      const now = await $.clock.now()
      await update($, contextTokens, () => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      // A request went out on whatever runs now: its prefix is cached from here.
      await update($, lastRequestAt, () => now)
      await update($, isCompacted, () => false)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const running = turns.get(e.turnId)
      turns.delete(e.turnId)
      if (running) await finishTurn($, running, e, isRecording).catch(() => undefined)
    }

    return next(e)
  })

  // Compacting drops the cached prefix: the next decision may switch freely.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, contextTokens, () => result.tokensAfter ?? 0)
      await update($, isCompacted, () => true)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, log)
    const list = newestThatFit(all, e.props.scroll.bodyRows, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>No decisions yet.</Text>}
        {list.length < all.length && (
          <Text dimColor>{`${all.length - list.length} earlier decision${all.length - list.length === 1 ? '' : 's'} not shown`}</Text>
        )}
        {list.map(entry => {
          const leading = leadingTier(entry)

          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={DECIDER_COLOR[entry.decider]} weight="semibold">{`${clockTime(entry.at)} ${entry.decider.padEnd(5)} ${entry.sent || entry.prompt}`}</Text>
              {entry.fallback && <Text color="warning">{`laya unavailable: ${entry.fallback}`}</Text>}
              {entry.tiers && (
                <Box gap={2}>
                  {TIERS.map(tier => (
                    <Text color={TIER_COLOR[tier.id]} dimColor={tier.id !== leading} weight={tier.id === leading ? 'semibold' : 'regular'}>
                      {tierBar(entry, tier.id)}
                    </Text>
                  ))}
                </Box>
              )}
              {!entry.tiers && <Text color={TIER_COLOR[effectiveTier(entry.decision) ?? '']}>{verdictLine(entry)}</Text>}
              {secondLine(entry) && <Text color={opinionColor(entry.second, entry)}>{secondLine(entry)}</Text>}
              {oracleLine(entry) && <Text color={opinionColor(entry.oracle, entry)}>{oracleLine(entry)}</Text>}
              <Text color={ACTION_COLOR[entry.action]}>{outcomeLine(entry)}</Text>
              <Text dimColor>{entry.reason}</Text>
              {turnLine(entry) && <Text color={isUnderRouted(entry) ? 'warning' : 'inactive'}>{turnLine(entry)}</Text>}
              {judgedLine(entry) && <Text color={entry.corrected || (entry.mark && !isAccepted(entry.mark, entry.decision)) ? 'warning' : 'success'}>{judgedLine(entry)}</Text>}
              {hasMarkButtons(entry, all) && (
                <Box gap={2}>
                  {markButtons(entry).map(button => (
                    <Button key={`mark-${button.said}`} hotkey={button.hotkey} plain dimColor onPress={() => void markEntry($, entry.id, button.said, isRecording)}>
                      {button.label}
                    </Button>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('command.run', { command: 'pignon' }, async ($, e) => {
    const arg = e.args.trim()

    if (MODES.includes(arg as Mode)) {
      await $.store.set('mode', arg)
      if (arg !== 'live') await update($, current, () => null)
      $.ui.status(arg === 'off' ? undefined : `pignon ${arg}`)

      return { text: `pignon is ${arg}.` }
    }

    if (arg === 'compare') return { text: compareReport(await read($, log)) }

    if (arg === 'mark' || arg.startsWith('mark ')) {
      const [said = '', which] = arg.slice(4).trim().split(/\s+/)
      const entries = await read($, log)
      const number = which === undefined ? undefined : Number.parseInt(which.replace(/^#/, ''), 10)
      const target = number === undefined ? markable(entries) : entries.find(entry => entry.id === number && entry.decider !== 'rule')
      const words = [...Object.keys(MARKS), ...TIERS.map(t => t.id)]
      if (!words.includes(said)) {
        const about = target ? ` Without a number it labels the last judged prompt, #${target.id} “${target.prompt}” (${shownLine(target)}).` : ''

        return { text: `/pignon mark ${words.join('|')} [#n]: too low, right, too high, or the tier it deserved; #n is a prompt's number in /pignon log.${about}` }
      }
      if (!target) {
        return { text: number === undefined ? 'Nothing to mark yet: no prompt has been judged in this session.' : `No judged prompt #${which?.replace(/^#/, '')} in /pignon log.` }
      }

      return { text: await markEntry($, target.id, said, isRecording) }
    }

    if (arg === 'stats' || arg.startsWith('stats ')) return { text: await statsReport($, arg.slice(5).trim()) }

    if (arg === 'watch') {
      const opened = await $.ui.open({ id: PANE, title: 'pignon' })

      return {
        text: opened.isPlaced
          ? 'pignon decisions pane opened.'
          : `pignon decisions pane is open but not drawn: ${opened.reason}. Widen the window or run /pignon watch again.`,
      }
    }

    if (arg === 'setup') {
      $.ui.status('pignon: setting up the local model...')
      try {
        return { text: await runSetup($) }
      } finally {
        $.ui.status(undefined)
      }
    }

    if (arg === 'unpin') {
      await update($, isPinned, () => false)
      await update($, base, () => null)

      return { text: 'pignon routes again from the next prompt.' }
    }

    if (arg === 'log') {
      const list = await read($, log)
      if (list.length === 0) return { text: 'No routed prompts yet.' }

      return {
        text: list
          .slice(-15)
          .map(l => {
            const d = l.decision
            const verdict = d ? `${d.tier}${d.explore ? '/explore' : ''} p=${d.confidence.toFixed(2)}` : 'none'
            const turn = turnLine(l)
            const judged = judgedLine(l)
            return `#${String(l.id).padEnd(4)} ${l.action.padEnd(12)} ${(l.decider ?? 'haiku').padEnd(6)} ${verdict.padEnd(24)} ${String(l.ms).padStart(5)} ms  ${l.reason}\n    “${l.prompt}”${turn ? `\n    ${turn}` : ''}${judged ? `\n    ${judged}` : ''}`
          })
          .join('\n'),
      }
    }

    const mode = await modeOf($)
    const table = TIERS.map(
      t => `  ${t.id.padEnd(9)} ${`${t.model}/${t.effort}`.padEnd(14)} ${t.canExplore ? '' : '(no exploration) '}${t.criteria}`,
    ).join('\n')
    const guard = `cache guard ${THRESHOLDS.cacheGuardTokens / 1000}k tokens (${THRESHOLDS.upgradeGuardTokens / 1000}k for upgrades), cooldown ${THRESHOLDS.minPromptsBetweenSwitches} prompts`
    const lastAt = await read($, lastRequestAt)
    const idleMs = (await $.clock.now()) - lastAt
    const cacheState = (await read($, isCompacted))
      ? 'cold (compacted)'
      : lastAt === 0
        ? 'no request yet'
        : idleMs > CACHE_TTL_MS[cache.ttl]
          ? `cold (idle ${Math.round(idleMs / 60_000)} min)`
          : `warm (last request ${Math.round(idleMs / 1000)} s ago)`

    return {
      text: [
        `pignon: ${mode}${(await read($, isPinned)) ? ', pinned by /model' : ''} · now on ${describe(await read($, current))}`,
        `decider: ${
          decider === 'haiku'
            ? 'haiku'
            : daemon.socketPath
              ? `laya (running)${isShared ? ' · shared daemon' : ''}`
              : daemon.isStarting
                ? 'laya (starting: Haiku decides until the model has loaded)'
                : 'laya (not running: Haiku decides; /pignon setup builds it)'
        }`,
        `context ${Math.round((await read($, contextTokens)) / 1000)}k · cache ${cacheState}, ttl ${cache.ttl} (${cache.source}) · ${guard}`,
        sessionSavings(await read($, log), mode),
        table,
        `decision log: ${isRecording ? `on (${kept.length} this session; /pignon stats sums them)` : 'off'} · oracle: ${hasOracle ? `${mode === 'shadow' ? 'on (Opus judges each prompt once its turn ends)' : 'on, idle outside shadow mode'}${isRecording ? '' : '; the log is off, so its answers are lost when the session ends'}` : 'off'}`,
        'Commands: /pignon live | shadow | off | unpin | log | compare | mark | stats | watch | setup',
      ].join('\n'),
    }
  })
}
