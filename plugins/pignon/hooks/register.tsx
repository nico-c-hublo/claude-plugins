import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Effort, LogEntry } from '../types'
import type { DeciderId } from './policy'
import { DECIDER_SYSTEM, THRESHOLDS, TIERS, decide, decisionFromTiers, isFollowUp, parseDecision, tierOf } from './policy'

type Mode = 'live' | 'shadow' | 'off'
const MODES: readonly Mode[] = ['live', 'shadow', 'off']

const current = atom({ plugin: 'pignon', key: 'current' } as const, null as string | null)
const promptsSinceSwitch = atom({ plugin: 'pignon', key: 'promptsSinceSwitch' } as const, 0)
const contextTokens = atom({ plugin: 'pignon', key: 'contextTokens' } as const, 0)
const base = atom({ plugin: 'pignon', key: 'base' } as const, null as string | null)
const isPinned = atom({ plugin: 'pignon', key: 'isPinned' } as const, false)
const log = atom({ plugin: 'pignon', key: 'log' } as const, [] as LogEntry[], { shape: 'log-3' })

const PANE = 'decisions'
// What the local model reads of a prompt; the pane shows as much.
const SENT_CHARS = 400

const DECIDER_MODEL = 'haiku'
const DECIDER_TIMEOUT_MS = 5_000
const PROMPT_CHARS = 4_000
// The daemon answers in about 10 ms; this is for one that is stuck.
const LOCAL_TIMEOUT_MS = 1_500

// Shadow until the person has watched a few decisions and says `/pignon live`.
async function modeOf($: EngineInterface): Promise<Mode> {
  const mode = await $.store.get('mode')
  return MODES.includes(mode as Mode) ? (mode as Mode) : 'shadow'
}

async function ask($: EngineInterface, text: string, tier: string | null): Promise<Decision | null> {
  const reply = await $.model.complete({
    model: DECIDER_MODEL,
    system: DECIDER_SYSTEM,
    prompt: `Current tier: ${tier ?? 'none'}\n\n<prompt>\n${text.slice(0, PROMPT_CHARS)}\n</prompt>`,
    maxTokens: 100,
    effort: 'low',
    timeoutMs: DECIDER_TIMEOUT_MS,
  })

  return reply.isAnswered ? parseDecision(reply.text) : null
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
  if (reply === undefined) return { cause: 'the connection failed' }
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

// `/pignon setup`: the Python environment from the hash-locked file, then the pinned model.
async function runSetup($: EngineInterface): Promise<string> {
  const uv = await $.process.run(['uv', '--version']).catch(() => null)
  if (uv === null || uv.exitCode !== 0) {
    return 'pignon needs uv to build its Python environment. Install it (https://docs.astral.sh/uv/getting-started/installation/), then run /pignon setup again.'
  }

  const home = await dataHome($)
  const daemon = `${$.plugin.root}/daemon`
  const steps = [
    ['mkdir', '-p', home],
    ['uv', 'venv', '--python', '3.13', `${home}/venv`],
    ['uv', 'pip', 'install', '--python', `${home}/venv/bin/python`, '--require-hashes', '--no-deps', '-r', `${daemon}/requirements.lock`],
    [`${home}/venv/bin/python`, '-m', 'pignon_decider.setup', '--dest', `${home}/model`],
  ]
  for (const argv of steps) {
    const step = await $.process.run(argv, { cwd: daemon, timeoutMs: 600_000 }).catch(error => ({
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    }))
    if (step.exitCode !== 0) {
      const reason = step.stderr.trim().split('\n').slice(-5).join('\n')

      return `pignon setup failed at \`${argv.slice(0, 3).join(' ')}\`:\n${reason}\nFix that, then run /pignon setup again.`
    }
  }

  return 'pignon: the local model is ready. Pick laya for "Who judges each prompt" in /config (the pignon row), then run /pignon: it should say "decider: laya (running)".'
}

async function launchDaemon(
  $: EngineInterface,
  onReady: (socketPath: string) => void,
  onGone: () => void,
): Promise<void> {
  const home = await dataHome($)
  const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  // A directory of its own, so the socket is private whatever the rest of the temp folder allows.
  const directory = `${temp}/pignon-${randomHex(4)}`
  await $.process.run(['mkdir', '-m', '700', directory])

  const daemon = $.process.spawn({
    argv: [`${home}/venv/bin/python`, '-m', 'pignon_decider', '--socket', `${directory}/s.sock`, '--model', `${home}/model`],
    cwd: `${$.plugin.root}/daemon`,
  })
  let isReady = false
  for await (const piece of daemon) {
    const pid = piece.stream === 'stdout' ? /^ready (\d+)/m.exec(piece.text)?.[1] : undefined
    if (pid === undefined) continue
    if (!(await holdsNoNetworkSocket($, pid))) {
      $.ui.toast('pignon: the local model holds a network socket, so it is stopped. Haiku decides.')
      break // leaving the loop kills the child
    }
    onReady(`${directory}/s.sock`)
    isReady = true
  }
  onGone()
  if (isReady) $.ui.toast('pignon: the local model stopped. Haiku decides until you restart the session.')
}

// The daemon's code is audited and its environment stripped; this checks the
// result on the running process. Unable to check counts as failing it.
async function holdsNoNetworkSocket($: EngineInterface, pid: string): Promise<boolean> {
  const sockets = await $.process.run(['/usr/sbin/lsof', '-a', '-p', pid, '-i', '-n', '-P']).catch(() => null)

  return sockets !== null && sockets.exitCode <= 1 && sockets.stdout.trim() === ''
}

// The text lines of an entry, as the pane draws them: what it measures with too.
function entryLines(entry: LogEntry): string[] {
  return [
    `${clockTime(entry.at)} ${entry.decider.padEnd(5)} ${entry.sent || entry.prompt}`,
    ...(entry.fallback ? [`laya unavailable: ${entry.fallback}`] : []),
    entry.tiers ? TIERS.map(tier => tierBar(entry, tier.id)).join('  ') : verdictLine(entry),
    outcomeLine(entry),
    entry.reason,
  ]
}

function tierBar(entry: LogEntry, id: string): string {
  const probability = entry.tiers?.[id] ?? 0

  return `${id} ${bar(probability)} ${probability.toFixed(2)}`
}

// Rows an entry takes at `columns` wide: each line wraps, and a gap follows.
function entryRows(entry: LogEntry, columns: number): number {
  return entryLines(entry).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 1)
}

// The newest entries that fit `rows`, leaving one row for the note on the rest.
function newestThatFit(entries: readonly LogEntry[], rows: number, columns: number): readonly LogEntry[] {
  const total = entries.reduce((sum, entry) => sum + entryRows(entry, columns), 0)
  if (total <= rows) return entries

  const fit: LogEntry[] = []
  let used = 1
  for (const entry of [...entries].reverse()) {
    used += entryRows(entry, columns)
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

async function route(
  $: EngineInterface,
  text: string,
  model: string,
  effort: Effort | undefined,
  mode: Mode,
  wantsLocal: boolean,
  socketPath: string | null,
) {
  const was = await read($, current)
  const startedAt = await $.clock.now()
  const contextSize = await read($, contextTokens)
  let decider: DeciderId = 'laya'
  // An acknowledgement needs no judge: it keeps the tier, whoever would have been asked.
  const isAcknowledgement = isFollowUp(text)
  let decision: Decision | null = isAcknowledgement ? { tier: 'same', explore: false, confidence: 1 } : null
  let local: LocalAnswer | null = null
  let fallback: string | undefined
  if (!decision && wantsLocal) {
    if (socketPath === null) {
      fallback = 'it is not running'
    } else {
      const asked = await askLocal($, socketPath, text, contextSize)
      if ('cause' in asked) fallback = asked.cause
      else local = asked
      decision = local?.decision ?? null
    }
  }
  if (!decision) {
    // No daemon, or it failed: Haiku, so a prompt is never left undecided.
    decider = 'haiku'
    decision = await ask($, text, was).catch(() => null)
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
  const entry: LogEntry = {
    at: startedAt,
    prompt: text.slice(0, 80).replace(/\s+/g, ' '),
    sent: isAcknowledgement ? '' : text.slice(0, SENT_CHARS),
    tiers: local?.tiers,
    daemonMs: local?.daemonMs,
    fallback,
    decider: source,
    decision,
    ms,
    action,
    tier: target ?? was,
    reason,
  }
  await update($, log, list => [...list, entry].slice(-50))

  const verdict = decision
    ? `${source} ${decision.tier}${decision.explore ? '/explore' : ''} p=${decision.confidence.toFixed(2)} · ${ms} ms`
    : `${source} no decision · ${ms} ms`
  const icon = action === 'switched' ? '⚡' : action === 'would switch' ? '👁' : '·'
  const outcome = action === 'kept' ? `kept ${describe(now)}` : `${action} to ${describe(target)}`
  $.ui.log(`pignon ${verdict}  ${icon} ${outcome} (${reason})`)
  $.ui.status(`pignon ${mode}: ${describe(now)}`)
}

export const register: Register = (on, options) => {
  const decider: DeciderId = options.decider === 'laya' ? 'laya' : 'haiku'
  // Set once the daemon says it is ready; routing asks Haiku until then.
  let socketPath: string | null = null
  // The prompt each main turn starts with, read by its first model request.
  const prompts = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pignon',
      description: 'Model router: status, live, shadow, off, unpin, log, watch, setup',
      argumentHint: '[live|shadow|off|unpin|log|watch|setup]',
      immediate: true,
    })
    if (decider === 'laya') void launchDaemon(
        $,
        path => (socketPath = path),
        () => (socketPath = null),
      )

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
    if (mode === 'off') return yield* next(e)

    // The request names the session's model until a hook rewrites it, so a
    // change here is the person's `/model` or `/effort`: theirs wins.
    const seen = `${e.model}|${e.effort ?? ''}`
    const known = await read($, base)
    await update($, base, () => seen)
    if (known !== null && known !== seen && !(await read($, isPinned))) {
      await update($, isPinned, () => true)
      await update($, current, () => null)
      $.ui.toast(`pignon paused: you picked ${e.model}. /pignon unpin to resume.`)
      $.ui.status('pignon pinned')
    }
    if (await read($, isPinned)) return yield* next(e)

    if (e.index === 0 && text !== undefined) {
      await route($, text, e.model, e.effort as Effort | undefined, mode, decider === 'laya', socketPath)
    }

    const tier = mode === 'live' ? tierOf(await read($, current)) : undefined
    const result = yield* next(tier ? { ...e, model: tier.model, effort: tier.effort } : e)
    if (result.usage) {
      const u = result.usage
      await update($, contextTokens, () => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, log)
    const list = newestThatFit(all, e.props.scroll.bodyRows, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>No decisions yet.</Text>}
        {list.length < all.length && (
          <Text dimColor>{`${all.length - list.length} earlier decision${all.length - list.length === 1 ? '' : 's'} not shown`}</Text>
        )}
        {list.map(entry => (
          <Box flexDirection="column" marginBottom={1}>
            <Text>{`${clockTime(entry.at)} ${entry.decider.padEnd(5)} ${entry.sent || entry.prompt}`}</Text>
            {entry.fallback && <Text dimColor>{`laya unavailable: ${entry.fallback}`}</Text>}
            {entry.tiers && (
              <Box gap={2}>
                {TIERS.map(tier => (
                  <Text>{tierBar(entry, tier.id)}</Text>
                ))}
              </Box>
            )}
            {!entry.tiers && <Text>{verdictLine(entry)}</Text>}
            <Text>{outcomeLine(entry)}</Text>
            <Text dimColor>{entry.reason}</Text>
          </Box>
        ))}
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
            return `${l.action.padEnd(12)} ${(l.decider ?? 'haiku').padEnd(6)} ${verdict.padEnd(24)} ${String(l.ms).padStart(5)} ms  ${l.reason}\n    “${l.prompt}”`
          })
          .join('\n'),
      }
    }

    const mode = await modeOf($)
    const table = TIERS.map(
      t => `  ${t.id.padEnd(9)} ${`${t.model}/${t.effort}`.padEnd(14)} ${t.canExplore ? '' : '(no exploration) '}${t.criteria}`,
    ).join('\n')
    const guard = `cache guard ${THRESHOLDS.cacheGuardTokens / 1000}k tokens, cooldown ${THRESHOLDS.minPromptsBetweenSwitches} prompts`

    return {
      text: [
        `pignon: ${mode}${(await read($, isPinned)) ? ', pinned by /model' : ''} · now on ${describe(await read($, current))}`,
        `decider: ${
          decider === 'haiku'
            ? 'haiku'
            : socketPath
              ? 'laya (running)'
              : 'laya (not running: Haiku decides; /pignon setup builds it)'
        }`,
        `context ${Math.round((await read($, contextTokens)) / 1000)}k · ${guard}`,
        table,
        'Commands: /pignon live | shadow | off | unpin | log | watch | setup',
      ].join('\n'),
    }
  })
}
