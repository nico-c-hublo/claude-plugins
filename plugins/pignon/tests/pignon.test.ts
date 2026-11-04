import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, On, ProcessSpawnRequest, TurnStepInput, TurnUsage } from 'claude-code'

import type { DecisionRecord, LogEntry, TurnOutcome } from '../types'
import { acceptedTiers, decide, decisionFromTiers, hybridDecision, isCorrection, isFollowUp, isUnderRouted, parseDecision, verdictSignal } from '../hooks/policy'
import { priceOf, turnCost, usd } from '../hooks/prices'
import { parseRecords, recordOf, serialize, summarize } from '../hooks/record'

const OPUS = 'claude-opus-5-5'
const base = {
  current: null,
  sessionModel: OPUS,
  sessionEffort: 'high' as const,
  contextTokens: 10_000,
  promptsSinceSwitch: 5,
}

describe('policy', () => {
  test('leaves Opus for Haiku on a confident trivial prompt', async () => {
    const out = decide({ ...base, decision: { tier: 'trivial', explore: false, confidence: 0.9 } })
    expect(out.target).toBe('trivial')
  })

  test('a trivial prompt that needs exploring goes to standard', async () => {
    const out = decide({ ...base, decision: { tier: 'trivial', explore: true, confidence: 0.9 } })
    expect(out.target).toBe('standard')
  })

  test('an unsure downgrade keeps the model', async () => {
    const out = decide({ ...base, decision: { tier: 'trivial', explore: false, confidence: 0.6 } })
    expect(out.target).toBe(null)
  })

  test('an upgrade only needs moderate confidence, and ignores the cooldown', async () => {
    const out = decide({
      ...base,
      current: 'trivial',
      promptsSinceSwitch: 0,
      decision: { tier: 'hard', explore: true, confidence: 0.55 },
    })
    expect(out.target).toBe('hard')
  })

  test('a model switch past the cache guard is refused', async () => {
    const out = decide({
      ...base,
      contextTokens: 120_000,
      decision: { tier: 'standard', explore: true, confidence: 0.95 },
    })
    expect(out.target).toBe(null)
    expect(out.reason).toContain('cache protected')
  })

  test('an effort change alone is a cache miss too, so the guard holds it', async () => {
    const hard = { tier: 'hard', explore: true, confidence: 0.95 }
    const settings = { ...base, sessionEffort: 'xhigh' as const, decision: hard }

    expect(decide({ ...settings, contextTokens: 120_000 }).reason).toContain('cache protected')
    expect(decide({ ...settings, contextTokens: 10_000 }).target).toBe('hard')
  })

  test('a hard prompt on Opus at high lowers the effort to medium, as a downgrade would', async () => {
    const hard = (confidence: number) => ({ tier: 'hard', explore: true, confidence })

    const sure = decide({ ...base, decision: hard(0.9) })
    expect(sure.target).toBe('hard')
    expect(sure.reason).toContain('effort')
    expect(decide({ ...base, decision: hard(0.6) }).target).toBe(null)
    expect(decide({ ...base, sessionEffort: 'medium', decision: hard(0.9) }).reason).toBe('already on target')
  })

  test("lowering Opus's effort is held by the downgrade's cache guard, at 60k, not the upgrade's", async () => {
    const hard = { tier: 'hard', explore: true, confidence: 0.95 }

    expect(decide({ ...base, contextTokens: 50_000, decision: hard }).target).toBe('hard')
    const warm = decide({ ...base, contextTokens: 70_000, decision: hard })
    expect(warm.target).toBe(null)
    expect(warm.reason).toContain('cache protected')
    const cold = decide({ ...base, contextTokens: 70_000, decision: hard, isCacheCold: true })
    expect(cold.target).toBe('hard')
    expect(cold.reason).toContain('cache cold')
  })

  test("lowering Opus's effort skips the cooldown: leaving the session's own settings is not a switch back", async () => {
    const hard = { tier: 'hard', explore: true, confidence: 0.95 }

    expect(decide({ ...base, promptsSinceSwitch: 0, decision: hard }).target).toBe('hard')
    // Once routed to hard, the tier already runs Opus at medium.
    expect(decide({ ...base, current: 'hard', promptsSinceSwitch: 0, decision: hard }).reason).toBe('already on target')
  })

  test('an upgrade is guarded past 100k tokens, not before', async () => {
    const hard = { tier: 'hard', explore: true, confidence: 0.95 }
    const sonnet = { ...base, current: 'standard', decision: hard }

    expect(decide({ ...sonnet, contextTokens: 90_000 }).target).toBe('hard')
    const out = decide({ ...sonnet, contextTokens: 110_000 })
    expect(out.target).toBe(null)
    expect(out.reason).toContain('cache protected')
  })

  test('the cooldown holds a downgrade right after a switch', async () => {
    const out = decide({
      ...base,
      current: 'hard',
      promptsSinceSwitch: 1,
      decision: { tier: 'standard', explore: true, confidence: 0.95 },
    })
    expect(out.reason).toContain('cooldown')
  })

  test("the local model's probabilities clear lower bars than Haiku's own guess", async () => {
    const trivial = { tier: 'trivial', explore: false, confidence: 0.75 }

    expect(decide({ ...base, decision: trivial }).target).toBe(null)
    expect(decide({ ...base, decider: 'laya', decision: trivial }).target).toBe('trivial')
    expect(decide({ ...base, decider: 'laya', decision: { ...trivial, confidence: 0.65 } }).target).toBe(null)
  })

  test('a follow-up keeps the tier', async () => {
    const out = decide({ ...base, current: 'standard', decision: { tier: 'same', explore: false, confidence: 1 } })
    expect(out.target).toBe(null)
  })

  test('the decider reply parses, and junk does not', async () => {
    expect(parseDecision('```json\n{"tier":"hard","explore":true,"confidence":0.8}\n```')).toEqual({
      tier: 'hard',
      explore: true,
      confidence: 0.8,
    })
    expect(parseDecision('{"tier":"galactic"}')).toBe(null)
    expect(parseDecision('no idea')).toBe(null)
  })
})

describe('policy: follow-ups', () => {
  test('a bare acknowledgement is a follow-up, in English or French', async () => {
    for (const text of ['yes', 'Yes!', 'ok', 'go on', 'continue', 'do it', 'thanks', 'thank you', 'looks good', 'LGTM', 'yes, go ahead', 'oui', 'vas-y', 'merci', 'ok, continue please']) {
      expect(isFollowUp(text), text).toBe(true)
    }
  })

  test('anything with a task of its own is not', async () => {
    for (const text of ['', 'refactor everything', 'rename foo to bar', 'yes but rename foo to bar in utils', 'ok now design a migration', 'fix it']) {
      expect(isFollowUp(text), text).toBe(false)
    }
  })
})

describe('policy: the local model\'s answer', () => {
  test('the likeliest tier is the decision, and its probability the confidence', async () => {
    expect(decisionFromTiers({ trivial: 0.1, standard: 0.2, hard: 0.7 })).toEqual({
      tier: 'hard',
      explore: false,
      confidence: 0.7,
    })
  })

  test('unknown tiers and junk values are ignored, and nothing usable is no decision', async () => {
    expect(decisionFromTiers({})).toBe(null)
    expect(decisionFromTiers({ galactic: 1 })).toBe(null)
    expect(decisionFromTiers({ hard: 'high' as unknown as number })).toBe(null)
    expect(decisionFromTiers({ hard: Number.NaN })).toBe(null)
    expect(decisionFromTiers({ hard: 1.5 })).toBe(null)
    expect(decisionFromTiers({ galactic: 0.9, standard: 0.4 })).toEqual({
      tier: 'standard',
      explore: false,
      confidence: 0.4,
    })
  })
})

// What a judge was asked: which model, at what effort.
type Asked = { model: string; effort?: unknown; maxTokens?: number }

// Stands for the engine beneath the mod: a decider that answers `reply`, and
// a model that records each request it is sent and answers with `usage`.
function engine(on: On, reply: string | ((asked: Asked) => Promise<string>), sent: TurnStepInput[], mode = 'shadow', options: { usage?: TurnUsage; now?: number } = {}) {
  const clock = mock.clock(on, { now: options.now ?? 0 })
  const calls = { model: 0, clock, asked: [] as Asked[] }
  mock.store(on, { mode })
  on('command.register', () => ({ value: { command: 'pignon' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', async (_, e) => {
    calls.model++
    const asked = { model: e.model, effort: e.effort, maxTokens: e.maxTokens }
    calls.asked.push(asked)
    const text = typeof reply === 'string' ? reply : await reply(asked)

    return {
      value: {
        isAnswered: true as const,
        text,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.step', async function* (_, e) {
    sent.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: options.usage ?? null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return calls
}

const TRIVIAL = '{"tier":"trivial","explore":false,"confidence":0.95}'

describe('routing', () => {
  test('in live mode, a trivial prompt runs on Haiku at low effort', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, TRIVIAL, sent, 'live')

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'rename foo to bar in utils.ts' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    // A later tool step of the same turn stays on the routed model.
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: OPUS, effort: 'high', messageCount: 3 }));

    expect(sent.map(e => `${e.model}/${e.effort}`)).toEqual(['haiku/low', 'haiku/low'])
  })

  test('in shadow mode, nothing is rewritten', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, TRIVIAL, sent)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'rename foo to bar in utils.ts' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(sent[0]?.model).toBe(OPUS)
  })

  test('a /model change by hand pins routing until unpin', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, TRIVIAL, sent, 'live')

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    await $.turn.start({ turnId: 't2', text: 'rename bar' })
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3 }));

    expect(sent[1]?.model).toBe('claude-sonnet-5-5')
  })

  test('a subagent request is left alone', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, TRIVIAL, sent, 'live')

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'rename foo', agentId: 'a1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1, agentId: 'a1' }));

    expect(sent[0]?.model).toBe(OPUS)
  })
})

// The daemon is a child the mod starts and keeps for the session. `forever` is
// how a child that is still running looks to the loop that reads it.
const forever = new Promise<never>(() => {})
declare function setTimeout(callback: () => void, ms: number): unknown
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const LOCAL = { options: { decider: 'laya' } }

describe('the local decider: its daemon', () => {
  test('is launched from the mod folder, in a private socket directory', LOCAL, async ($, on) => {
    const runs: (readonly string[])[] = []
    const spawned: ProcessSpawnRequest[] = []
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp/' })
    on('process.run', (_, e) => {
      runs.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* (_, e) {
      spawned.push(e)
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    const directory = runs[0]?.[3] ?? ''
    expect(runs[0]).toEqual(['mkdir', '-m', '700', expect.stringMatching(/^\/var\/tmp\/pignon-[0-9a-f]{8}$/)])
    expect(spawned[0]?.argv).toEqual([
      '/cfg/pignon/venv/bin/python',
      '-m',
      'pignon_decider',
      '--socket',
      `${directory}/s.sock`,
      '--model',
      '/cfg/pignon/model',
    ])
    expect(spawned[0]?.cwd).toMatch(/\/pignon\/daemon$/)
  })

  test('a ready daemon decides over its socket, and Haiku is not asked', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    const fetched: { url: string; init?: HttpInit }[] = []
    const runs: (readonly string[])[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      runs.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', (_, e) => {
      fetched.push(e)
      const tiers = { trivial: 0.9, standard: 0.07, hard: 0.03 }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers, tier: 'trivial', model: 'x', latencyMs: 9 }) } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo to bar in utils.ts' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(fetched).toHaveLength(1)
    expect(fetched[0]?.url).toEndWith('/decide')
    expect(fetched[0]?.init?.method).toBe('POST')
    expect(fetched[0]?.init?.socketPath).toBe(`${runs[0]?.[3]}/s.sock`)
    expect(JSON.parse(fetched[0]?.init?.body ?? '{}')).toEqual({ prompt: 'rename foo to bar in utils.ts' })
    expect(calls.model).toBe(0)
    expect(sent.map(e => `${e.model}/${e.effort}`)).toEqual(['haiku/low'])
  })

  test('Haiku decides when the daemon answers badly, drops the connection or says nothing usable', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    const failures = [
      { status: 500, ok: false, headers: {}, text: '{"error":"scoring failed"}' },
      null,
      { status: 200, ok: true, headers: {}, text: '{"tiers":{}}' },
    ]
    let attempt = 0
    on('http.fetch', () => {
      const failure = failures[attempt++]
      if (failure === null) throw new Error('connection reset')
      return { value: failure! }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    for (const [i, text] of ['rename foo', 'rename bar', 'rename baz'].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }

    expect(attempt).toBe(3)
    expect(calls.model).toBe(3)
    expect(sent.map(e => `${e.model}/${e.effort}`)).toEqual(['haiku/low', 'haiku/low', 'haiku/low'])
  })

  test('a daemon holding a network socket is killed and never asked', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    const runs: (readonly string[])[] = []
    let lsofTimeoutMs: number | undefined
    let fetched = 0
    let isKilled = false
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      runs.push(e.argv)
      if (e.argv[0] === '/usr/sbin/lsof') lsofTimeoutMs = e.init?.timeoutMs
      const sockets = e.argv[0] === '/usr/sbin/lsof' ? 'Python 4242 me 3u IPv4 0x1 0t0 TCP 10.0.0.2:51234->93.184.216.34:443 (ESTABLISHED)\n' : ''
      return { value: { exitCode: 0, stdout: sockets, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* () {
      try {
        yield { stream: 'stdout' as const, text: 'ready 4242\n' }
        await forever
        return { value: { code: 0, signal: null } }
      } finally {
        isKilled = true
      }
    })
    on('http.fetch', () => {
      fetched++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(runs.map(argv => argv.join(' '))).toContain('/usr/sbin/lsof -a -p 4242 -i -n -P')
    expect(lsofTimeoutMs).toBeLessThanOrEqual(5_000)
    expect(isKilled).toBe(true)
    expect(fetched).toBe(0)
    expect(calls.model).toBe(1)
  })

  test('a session daemon that starts to hold a network socket is no longer asked', LOCAL, async ($, on) => {
    const sockets = { held: '' }
    const toasts: string[] = []
    let fetched = 0
    const calls = engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('process.run', (_, e) => {
      const stdout = e.argv[0] === '/usr/sbin/lsof' ? sockets.held : ''
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => {
      fetched++
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers: TIERS_TRIVIAL, latencyMs: 9 }) } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo')
    await calls.clock.advance(5 * 60_000 - 1)
    sockets.held = 'Python 4242 me 3u IPv4 0x1 0t0 TCP 10.0.0.2:51234->93.184.216.34:443 (ESTABLISHED)\n'
    await prompt($, 't2', 'rename bar')
    expect(fetched).toBe(2)
    expect(toasts).toEqual([])

    await calls.clock.advance(1)
    await prompt($, 't3', 'rename baz')

    expect(fetched).toBe(2)
    expect(calls.model).toBe(1)
    expect(toasts).toEqual([expect.stringContaining('holds a network socket')])
  })

  test('the toast for a daemon that cannot be checked does not say it holds a network socket', LOCAL, async ($, on) => {
    const lsof = { exitCode: 1, stdout: '' }
    const toasts: string[] = []
    const calls = engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('process.run', (_, e) => {
      const answer = e.argv[0] === '/usr/sbin/lsof' ? lsof : { exitCode: 0, stdout: '' }
      return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers: TIERS_TRIVIAL, latencyMs: 9 }) } }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't0', 'rename foo')
    await calls.clock.advance(6 * 60_000)
    lsof.exitCode = 2
    await prompt($, 't1', 'rename foo')

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('could not be checked')
    expect(toasts[0]).not.toContain('holds a network socket')
  })

  test('an acknowledgement keeps the tier and asks neither the daemon nor Haiku', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    let fetched = 0
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => {
      fetched++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'yes, go ahead' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(fetched).toBe(0)
    expect(calls.model).toBe(0)
    expect(sent.map(e => e.model)).toEqual([OPUS])
  })

  test('a daemon that never answers does not hold the prompt', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', async () => {
      await forever
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    const stepping = (async () => {
      for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    })()
    await calls.clock.advance(2_000)
    await stepping

    expect(calls.model).toBe(1)
    expect(sent.map(e => `${e.model}/${e.effort}`)).toEqual(['haiku/low'])
  })

  test('the log says who decided each prompt', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => {
      const tiers = { trivial: 0.9, standard: 0.07, hard: 0.03 }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers }) } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    for (const [i, text] of ['rename foo to bar', 'yes, go ahead'].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }
    const { text = '' } = await $.command.run({
      command: 'pignon',
      args: 'log',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    const [first, , second] = text.split('\n')
    expect(first).toContain('laya')
    expect(second).toContain('rule')
  })

  test('once the daemon has exited, it is not asked again', LOCAL, async ($, on) => {
    const sent: TurnStepInput[] = []
    let fetched = 0
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      return { value: { code: 1, signal: null } } // it crashes after announcing itself
    })
    on('http.fetch', () => {
      fetched++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(fetched).toBe(0)
    expect(calls.model).toBe(1)
  })

  test('a spawn the engine refuses leaves Haiku deciding, and nothing unhandled', LOCAL, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'shadow')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: OK }))
    on('process.spawn', async function* () {
      throw new Error('spawn refused')
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'rename foo to bar')

    expect(calls.asked.map(a => a.model)).toEqual(['haiku'])
    expect((await $.command.run({ command: 'pignon', args: '', ...COMMAND })).text).toContain('laya (not running')
  })

  test('a daemon whose sockets cannot be checked is refused, not trusted', LOCAL, async ($, on) => {
    let fetched = 0
    const calls = engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      const exitCode = e.argv[0] === '/usr/sbin/lsof' ? 2 : 0
      return { value: { exitCode, stdout: '', stderr: 'lsof: unknown', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => {
      fetched++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect(fetched).toBe(0)
    expect(calls.model).toBe(1)
  })
})

type Run = { argv: readonly string[]; cwd?: string; timeoutMs?: number }
const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const LOCK = 'numpy==2.0.0 --hash=sha256:aa\n'

// Plays `/pignon setup` against a host whose commands `answer` as given and whose disk holds `stamp`
// (the lock the environment was built from) next to the plugin's own lock.
async function setup($: Engine, on: On, answer: (argv: readonly string[]) => Partial<typeof OK>, stamp = '') {
  const runs: Run[] = []
  const writes: { path: string; text: string }[] = []
  engine(on, TRIVIAL, [], 'shadow')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('/requirements.lock') ? LOCK : String(e.path).endsWith('/venv.lock') ? stamp : '' }))
  on('fs.write', (_, e) => {
    writes.push({ path: String(e.path), text: String(e.text) })

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    return { value: { ...OK, ...answer(e.argv) } }
  })
  const { text = '' } = await $.command.run({
    command: 'pignon',
    args: 'setup',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  return { runs, text, writes }
}

describe('/pignon status shows the decider', () => {
  async function status($: Engine) {
    const { text = '' } = await $.command.run({
      command: 'pignon',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    return text
  }

  test('the local model is running once its daemon is ready', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: OK }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(await status($)).toContain('decider: laya (running)')
  })

  test('says so when the local model is chosen but not running', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: OK }))
    on('process.spawn', async function* () {
      yield { stream: 'stderr' as const, text: 'No such file: /cfg/pignon/venv/bin/python\n' }
      return { value: { code: 127, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(await status($)).toContain('decider: laya (not running: Haiku decides; /pignon setup builds it)')
  })

  test('is Haiku by default', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect(await status($)).toContain('decider: haiku')
  })
})

describe('/pignon setup', () => {
  test('without uv, says how to get it and runs nothing else', async ($, on) => {
    const { runs, text } = await setup($, on, argv => (argv[0] === 'uv' ? { exitCode: 127, stderr: 'not found' } : {}))

    expect(runs.map(r => r.argv.join(' '))).toEqual(['uv --version'])
    expect(text).toContain('uv')
    expect(text).toContain('https://docs.astral.sh/uv')
  })

  test('builds the hash-locked environment, then downloads the pinned model', async ($, on) => {
    const { runs, text, writes } = await setup($, on, () => ({}))

    const root = (runs[4]?.cwd ?? '').replace(/\/daemon$/, '')
    expect(runs.map(r => r.argv.join(' '))).toEqual([
      'uv --version',
      'mkdir -p /cfg/pignon',
      'uv venv --clear --python 3.13 /cfg/pignon/venv',
      `uv pip install --python /cfg/pignon/venv/bin/python --require-hashes --no-deps --only-binary :all: -r ${root}/daemon/requirements.lock`,
      '/cfg/pignon/venv/bin/python -m pignon_decider.setup --dest /cfg/pignon/model',
    ])
    expect(runs[4]?.cwd).toBe(`${root}/daemon`)
    expect(runs.slice(2).every(r => (r.timeoutMs ?? 0) >= 300_000)).toBe(true)
    expect(writes.map(w => w.text)).toEqual(['', LOCK])
    expect(text).toContain('ready')
  })

  test('keeps an environment built from this lock, and only fetches the model', async ($, on) => {
    const { runs, text, writes } = await setup($, on, () => ({}), LOCK)

    expect(runs.map(r => (r.argv[2] === '-c' ? '<environment check>' : r.argv.join(' ')))).toEqual([
      'uv --version',
      'mkdir -p /cfg/pignon',
      '<environment check>',
      '/cfg/pignon/venv/bin/python -m pignon_decider.setup --dest /cfg/pignon/model',
    ])
    expect(writes).toEqual([])
    expect(text).toContain('ready')
  })

  test('rebuilds when the lock changed since the environment was built', async ($, on) => {
    const { runs } = await setup($, on, () => ({}), 'numpy==1.0.0\n')

    expect(runs.map(r => r.argv.slice(0, 2).join(' '))).toContain('uv venv')
  })

  test('rebuilds when the environment no longer runs', async ($, on) => {
    const { runs } = await setup($, on, argv => (argv[2] === '-c' ? { exitCode: 1 } : {}), LOCK)

    expect(runs.map(r => r.argv.slice(0, 2).join(' '))).toContain('uv venv')
  })

  test('checks that the packages are there, not only that the interpreter runs', async ($, on) => {
    const { runs } = await setup($, on, () => ({}), LOCK)

    const check = runs.find(r => r.argv[2] === '-c')?.argv[3] ?? ''
    for (const name of ['laya_mlx', 'mlx', 'numpy', 'tokenizers']) expect(check).toContain(`"${name}"`)
  })

  test('runs the package check isolated, so the working directory cannot stand in for a package', async ($, on) => {
    const { runs } = await setup($, on, () => ({}), LOCK)

    expect(runs.find(r => r.argv[2] === '-c')?.argv[1]).toBe('-I')
  })

  test('a rebuild that fails leaves the environment marked as unbuilt', async ($, on) => {
    const { writes } = await setup($, on, argv => (argv[1] === 'pip' ? { exitCode: 1, stderr: 'boom' } : {}), 'numpy==1.0.0\n')

    expect(writes.map(w => w.text)).toEqual([''])
  })

  test('stops at the first failing step and says which one and why', async ($, on) => {
    const { runs, text } = await setup($, on, argv =>
      argv[1] === 'pip' ? { exitCode: 1, stderr: 'error: hash mismatch for numpy' } : {},
    )

    expect(runs).toHaveLength(4)
    expect(text).toContain('uv pip install')
    expect(text).toContain('hash mismatch for numpy')
    expect(text).not.toContain('ready')
  })
})

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

describe('/pignon watch', () => {
  test('opens the decisions pane', async ($, on) => {
    const opened: { id: string; title?: string }[] = []
    engine(on, TRIVIAL, [], 'shadow')
    on('ui.open', (_, e) => {
      opened.push(e)
      return { value: { isPlaced: true } }
    })

    const { text = '' } = await $.command.run({ command: 'pignon', args: 'watch', ...COMMAND })

    expect(opened).toEqual([expect.objectContaining({ id: 'decisions', title: 'pignon' })])
    expect(text).toContain('pane')
  })

  test('says why when the surface cannot draw it', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is too narrow' } }))

    const { text = '' } = await $.command.run({ command: 'pignon', args: 'watch', ...COMMAND })

    expect(text).toBe('pignon decisions pane is open but not drawn: the terminal is too narrow. Widen the window or run /pignon watch again.')
  })
})

// A daemon that comes up ready and answers every request with `reply()`.
function withDaemon(on: On, reply: () => { status: number; ok: boolean; headers: Record<string, string>; text: string }) {
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
  on('process.run', () => ({ value: OK }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'ready 4242\n' }
    await forever
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', () => ({ value: reply() }))
}

const SURFACES = ['terminal', 'desktop'] as const
const DECISIONS_PANE = {
  plugin: 'pignon',
  component: 'Pane',
  requestId: 'decisions',
  props: {
    title: 'pignon',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

describe('the decisions pane', () => {
  test('says so before any decision, on every surface', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...DECISIONS_PANE, surface })

      expect((await ui.find({ type: 'Text' }))?.text).toBe('No decisions yet.')
      await ui.unmount()
    }
  })

  test('shows what was sent to the local model and what it answered, on every surface', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    withDaemon(on, () => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 },
        tier: 'trivial',
        model: 'laya-conductor',
        latencyMs: 9,
      }),
    }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo to bar in utils.ts' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...DECISIONS_PANE, surface })

      expect((await ui.find({ type: 'Text', text: /rename foo/ }))?.text).toMatch(/^\d{2}:\d{2}:\d{2} laya +rename foo to bar in utils\.ts$/)
      expect((await ui.find({ type: 'Text', text: /^trivial/ }))?.text).toMatch(/^trivial [█░]+ 0\.90$/)
      expect((await ui.find({ type: 'Text', text: /^standard/ }))?.text).toMatch(/^standard [█░]+ 0\.07$/)
      expect((await ui.find({ type: 'Text', text: /^hard/ }))?.text).toMatch(/^hard [█░]+ 0\.03$/)
      expect((await ui.find({ type: 'Text', text: /daemon/ }))?.text).toBe('0 ms (daemon 9 ms) · switched to trivial · haiku/low')
      await ui.unmount()
    }
  })

  test('colours each line by who decided, the tier and the outcome', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    withDaemon(on, () => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 }, tier: 'trivial', latencyMs: 9 }),
    }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo to bar in utils.ts' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /laya +rename/ }))?.props.color).toBe('suggestion')
    // The tier the local model leans to stands out; the others recede.
    const trivial = (await ui.find({ type: 'Text', text: /^trivial/ }))?.props
    const hard = (await ui.find({ type: 'Text', text: /^hard/ }))?.props
    expect(trivial).toMatchObject({ color: 'success', dimColor: false })
    expect(hard).toMatchObject({ color: 'error', dimColor: true })
    expect((await ui.find({ type: 'Text', text: /daemon/ }))?.props.color).toBe('success')
    await ui.unmount()
  })

  test('says why the local model did not decide when Haiku did', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    const failures = [
      () => ({ status: 500, ok: false, headers: {}, text: '{"error":"scoring failed"}' }),
      () => {
        throw new Error('connection reset')
      },
      () => ({ status: 200, ok: true, headers: {}, text: '{"tiers":{}}' }),
    ]
    let attempt = 0
    withDaemon(on, () => failures[attempt++]!())

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    for (const [i, text] of ['first prompt', 'second prompt', 'third prompt'].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...DECISIONS_PANE, surface })

      expect((await ui.find({ type: 'Text', text: /HTTP 500/ }))?.text).toBe('laya unavailable: it answered HTTP 500')
      expect((await ui.find({ type: 'Text', text: /connection/ }))?.text).toBe('laya unavailable: the connection failed')
      expect((await ui.find({ type: 'Text', text: /usable/ }))?.text).toBe('laya unavailable: it answered nothing usable')
      await ui.unmount()
    }
  })

  test('says when the local model is not running at all', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: OK }))
    on('process.spawn', async function* () {
      return { value: { code: 127, signal: null } } // it never starts
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /unavailable/ }))?.text).toBe('laya unavailable: it is not running')
    await ui.unmount()
  })

  test('draws a decision the moment it is made, in a pane already open', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    withDaemon(on, () => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ tiers: { trivial: 0.2, standard: 0.7, hard: 0.1 }, latencyMs: 8 }),
    }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('No decisions yet.')

    await $.turn.start({ turnId: 't1', text: 'add a pagination parameter' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 1 }));

    expect((await ui.find({ type: 'Text', text: /pagination/ }))?.text).toMatch(/laya +add a pagination parameter$/)
    expect((await ui.find({ type: 'Text', text: /No decisions yet/ }))).toBeUndefined()
    await ui.unmount()
  })

  test('shows what Haiku decided, and when a rule kept the tier', async ($, on) => {
    engine(on, '{"tier":"hard","explore":true,"confidence":0.8}', [], 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (const [i, text] of ['investigate the flaky deploy', 'yes, go ahead'].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /investigate/ }))?.text).toMatch(/haiku +investigate the flaky deploy$/)
    expect((await ui.find({ type: 'Text', text: /decided/ }))?.text).toBe('decided hard/explore p=0.80')
    expect((await ui.find({ type: 'Text', text: /rule +yes, go ahead$/ }))?.text).toMatch(/rule +yes, go ahead$/)
    expect((await ui.find({ type: 'Text', text: /acknowledgement/ }))?.text).toBe('an acknowledgement: the tier is kept')
    await ui.unmount()
  })

  test('shows the newest decisions that fit the pane, and counts the rest', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (const [i, text] of ['one one', 'two two', 'three three', 'four four'].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }

    // Each Haiku-decided entry takes 5 rows, the newest one more for its mark
    // buttons; 12 rows hold a note and two of them.
    const props = { ...DECISIONS_PANE.props, scroll: { offset: 0, bodyRows: 12 } }
    const ui = await $.ui.mount({ ...DECISIONS_PANE, props, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /earlier/ }))?.text).toBe('2 earlier decisions not shown')
    expect(await ui.find({ type: 'Text', text: /one one/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /two two/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /three three/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /four four/ })).toBeDefined()
    await ui.unmount()
  })

  test('counts the rows a long prompt wraps over when it picks what fits', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (const [i, text] of [`alpha ${'a'.repeat(194)}`, `omega ${'b'.repeat(194)}`].entries()) {
      await $.turn.start({ turnId: `t${i}`, text })
      for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
    }

    // At 40 columns the prompt alone takes 6 rows, so an entry is over 10 and 11 rows hold one.
    const props = { ...DECISIONS_PANE.props, bodyColumns: 40, scroll: { offset: 0, bodyRows: 11 } }
    const ui = await $.ui.mount({ ...DECISIONS_PANE, props, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /earlier/ }))?.text).toBe('1 earlier decision not shown')
    expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /omega/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the second opinion (shadow mode, local model chosen)', () => {
  const LAYA_SAYS_TRIVIAL = () => ({
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 }, latencyMs: 9 }),
  })
  const HAIKU_SAYS_STANDARD = '{"tier":"standard","explore":false,"confidence":0.8}'

  async function turn($: Engine, id: string, text: string) {
    await $.turn.start({ turnId: id, text })
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
  }

  test('Haiku is asked, and the turn does not wait for it', LOCAL, async ($, on) => {
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const calls = engine(on, async () => (await held, HAIKU_SAYS_STANDARD), [], 'shadow')
    withDaemon(on, LAYA_SAYS_TRIVIAL)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await turn($, 't1', 'rename foo to bar') // returns although Haiku has not answered

    expect(calls.model).toBe(1)
    release()
    await settle()
  })

  test('is not asked in live mode', LOCAL, async ($, on) => {
    const calls = engine(on, HAIKU_SAYS_STANDARD, [], 'live')
    withDaemon(on, LAYA_SAYS_TRIVIAL)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await turn($, 't1', 'rename foo to bar')
    await settle()

    expect(calls.model).toBe(0)
  })

  test('is not asked for an acknowledgement, nor when Haiku already decided', LOCAL, async ($, on) => {
    const calls = engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    withDaemon(on, () => ({ status: 500, ok: false, headers: {}, text: '{}' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await turn($, 't1', 'yes, go ahead') // a rule decides
    await turn($, 't2', 'rename foo to bar') // the daemon fails, so Haiku is the decider
    await settle()

    expect(calls.model).toBe(1) // Haiku's own decision for t2, and no second opinion
  })

  test('the pane shows Haiku agreeing, differing, or giving no answer', LOCAL, async ($, on) => {
    const opinions = [
      '{"tier":"trivial","explore":false,"confidence":0.9}',
      '{"tier":"trivial","explore":true,"confidence":0.8}', // it would run on standard
      'no idea',
    ]
    let asked = 0
    engine(on, async () => opinions[asked++]!, [], 'shadow')
    withDaemon(on, LAYA_SAYS_TRIVIAL)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    for (const [i, text] of ['rename foo', 'rename bar', 'rename baz'].entries()) await turn($, `t${i}`, text)
    await settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...DECISIONS_PANE, surface })

      expect((await ui.find({ type: 'Text', text: /agrees/ }))?.text).toBe('haiku agrees: trivial p=0.90 · 0 ms')
      expect((await ui.find({ type: 'Text', text: /differs/ }))?.text).toBe('haiku differs: trivial/explore p=0.80 · 0 ms')
      expect((await ui.find({ type: 'Text', text: /no answer/ }))?.text).toBe('haiku: no answer')
      await ui.unmount()
    }
  })

  test('the pane says Haiku is still thinking, then shows its answer in place', LOCAL, async ($, on) => {
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    engine(on, async () => (await held, HAIKU_SAYS_STANDARD), [], 'shadow')
    withDaemon(on, LAYA_SAYS_TRIVIAL)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await turn($, 't1', 'rename foo to bar')

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^haiku/ }))?.text).toBe('haiku: asking...')

    release()
    await settle()

    expect((await ui.find({ type: 'Text', text: /^haiku/ }))?.text).toBe('haiku differs: standard p=0.80 · 0 ms')
    await ui.unmount()
  })

  async function compare($: Engine) {
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'compare', ...COMMAND })

    return text
  }

  test('/pignon compare totals the agreement and lists the differences', LOCAL, async ($, on) => {
    const opinions = [
      '{"tier":"trivial","explore":false,"confidence":0.9}',
      '{"tier":"trivial","explore":true,"confidence":0.8}',
      'no idea',
    ]
    let asked = 0
    engine(on, async () => opinions[asked++]!, [], 'shadow')
    withDaemon(on, LAYA_SAYS_TRIVIAL)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    for (const [i, text] of ['rename foo', 'rename bar', 'rename baz'].entries()) await turn($, `t${i}`, text)
    await settle()

    const text = await compare($)

    expect(text).toContain('2 compared: 1 agree (50%), 1 differ.')
    expect(text).toContain('Haiku gave no answer for 1.')
    expect(text).toContain('trivial → trivial/explore  “rename bar”')
    expect(text).not.toContain('rename foo')
  })

  test('/pignon compare says what it needs when there is nothing to compare', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')

    const text = await compare($)

    expect(text).toContain('No comparisons yet')
    expect(text).toContain('laya')
    expect(text).toContain('shadow')
  })
})

// The shared daemon: one process for every session, started detached through
// `process.run` (a spawned child would end with the session), found by its socket.
const SHARED = { options: { decider: 'laya', daemon: 'shared' } }
const NO_OUTPUT = { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const TIERS_TRIVIAL = { trivial: 0.9, standard: 0.07, hard: 0.03 }

// A shared daemon as the engine sees it: `isUp` says whether anything listens on its
// socket, the launcher brings it up as `launchedPid`, and `listening` records each call.
// A process as `ps -xo pid=,etime=,rss=,command=` lists it.
const psLine = (pid: number, socket: string, etime = '25:48', rssKb = 951_000) =>
  `${String(pid).padStart(6)} ${etime.padStart(11)} ${String(rssKb).padStart(7)} /cfg/pignon/venv/bin/python -m pignon_decider --socket ${socket} --model /cfg/pignon/model --shared`

// FNV-1a, as the mod names a run directory after the mod folder it serves.
function runOf(folder: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < folder.length; i++) hash = Math.imul(hash ^ folder.charCodeAt(i), 0x01000193)

  return `run-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

// `onLaunch` runs as the launcher starts: another session's command, a clock that moves.
function sharedDaemon(
  on: On,
  init: {
    isUp: boolean
    launchedPid?: number
    launcherExit?: number
    sockets?: string
    files?: string[]
    health?: Record<string, unknown>
    onLaunch?: () => Promise<void> | void
  },
) {
  const state = {
    isUp: init.isUp,
    pid: 4242,
    launches: [] as { argv: readonly string[]; cwd?: string; timeoutMs?: number }[],
    audits: [] as string[],
    sockets: init.sockets,
    decides: 0,
    fail: 0,
    // The socket the mod asked on: this version's.
    socket: '',
    // Other daemons `ps` lists besides this version's: other versions, other config dirs.
    others: [] as { pid: number; line: string }[],
    killed: [] as number[],
    // Daemons that outlive SIGTERM.
    stubborn: new Set<number>(),
    removed: [] as string[],
    files: new Set(init.files ?? []),
    runs: [] as string[],
    // Run directories whose lock a daemon holds without being in `ps` yet: one starting.
    held: new Set<string>(),
    // The mod folder's siblings: the other versions in the plugin cache.
    siblings: [] as string[],
  }
  // A live daemon holds its run directory's lock.
  const liveDirs = () =>
    new Set([...(state.isUp && state.socket ? [state.socket] : []), ...state.others.map(o => /--socket (\S+)/.exec(o.line)?.[1] ?? '')].map(s => s.replace(/\/s\.sock$/, '')))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
  on('fs.exists', (_, e) => ({ value: state.files.has(e.path) }))
  on('fs.write', (_, e) => {
    state.files.add(e.path)
    return { value: undefined }
  })
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', (_, e) => ({ value: (e.path === '/cfg/pignon' ? state.runs : state.siblings).map(dir) }))
  on('process.run', async (_, e) => {
    const [command, ...rest] = e.argv
    if (command === '/bin/ps') {
      const lines = [...(state.isUp && state.socket ? [psLine(state.pid, state.socket)] : []), ...state.others.map(o => o.line)]

      return { value: { exitCode: 0, ...NO_OUTPUT, stdout: `${lines.join('\n')}\n` } }
    }
    if (command === '/bin/kill') {
      const pids = rest.slice(1).map(Number)
      state.killed.push(...pids)
      if (pids.includes(state.pid)) state.isUp = false
      state.others = state.others.filter(o => !pids.includes(o.pid) || state.stubborn.has(o.pid))

      return { value: OK }
    }
    // `lockf -s -t 0 <dir>/lock /bin/rm -f <files>`: the files and the lock go, unless the lock is held.
    if (command === '/usr/bin/lockf') {
      const lock = rest[3] ?? ''
      const runDir = lock.replace(/\/lock$/, '')
      if (state.held.has(runDir) || liveDirs().has(runDir)) return { value: { ...OK, exitCode: 75 } }
      for (const path of [...rest.slice(6), lock]) {
        state.files.delete(path)
        state.removed.push(path)
      }

      return { value: OK }
    }
    if (command === '/bin/rm' || command === '/bin/rmdir') {
      for (const path of rest.filter(arg => !arg.startsWith('-'))) {
        state.files.delete(path)
        state.removed.push(path)
      }

      return { value: OK }
    }
    if (e.argv[0] === '/usr/sbin/lsof') {
      state.audits.push(e.argv[3] ?? '')

      return { value: { exitCode: state.sockets ? 0 : 1, ...NO_OUTPUT, stdout: state.sockets ?? '' } }
    }
    state.launches.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    await init.onLaunch?.()
    if ((init.launcherExit ?? 0) !== 0) return { value: { exitCode: init.launcherExit!, ...NO_OUTPUT, stdout: 'failed: RuntimeError\n' } }
    state.isUp = true
    state.pid = init.launchedPid ?? 5151

    return { value: { exitCode: 0, ...NO_OUTPUT, stdout: `ready ${state.pid}\n` } }
  })
  on('http.fetch', (_, e) => {
    state.socket = e.init?.socketPath ?? state.socket
    if (!state.isUp) throw new Error('connection refused')
    if (e.url.endsWith('/health')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ status: 'ok', ready: true, pid: state.pid, ...init.health }) } }
    }
    if (state.fail > 0) {
      state.fail--
      state.isUp = false
      throw new Error('connection reset')
    }
    state.decides++

    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers: TIERS_TRIVIAL, tier: 'trivial', model: 'x', latencyMs: 9 }) },
    }
  })

  return state
}

async function prompt($: Engine, id: string, text: string) {
  await $.turn.start({ turnId: id, text })
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: OPUS, effort: 'high', messageCount: 1 }));
}

describe('the local decider: a shared daemon', () => {
  test('is started detached through run when nothing answers, and never spawned as a child', SHARED, async ($, on) => {
    const sent: TurnStepInput[] = []
    const spawned: ProcessSpawnRequest[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    const daemon = sharedDaemon(on, { isUp: false })
    on('process.spawn', async function* (_, e) {
      spawned.push(e)
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo to bar in utils.ts')

    const socket = daemon.launches[0]?.argv[4] ?? ''
    expect(daemon.launches[0]?.argv).toEqual([
      '/cfg/pignon/venv/bin/python',
      '-m',
      'pignon_decider',
      '--socket',
      socket,
      '--model',
      '/cfg/pignon/model',
      '--shared',
      // The daemon reads the stop itself, so one written during the launch holds.
      '--stop-file',
      '/cfg/pignon/shared-stopped',
    ])
    expect(socket).toMatch(/^\/cfg\/pignon\/run-[0-9a-f]{8}\/s\.sock$/)
    expect(daemon.launches[0]?.cwd).toMatch(/\/pignon\/daemon$/)
    // The launcher waits for the model to load, so the call's timeout must outlast it.
    expect(daemon.launches[0]?.timeoutMs).toBeGreaterThanOrEqual(120_000)
    expect(spawned).toEqual([])
    expect(daemon.decides).toBe(1)
    expect(calls.model).toBe(0)
  })

  test('joins a daemon that is already running, and launches nothing', SHARED, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo to bar in utils.ts')

    expect(daemon.launches).toEqual([])
    expect(daemon.decides).toBe(1)
    expect(calls.model).toBe(0)
    expect(sent.map(e => `${e.model}/${e.effort}`)).toEqual(['haiku/low'])
  })

  test('checks the sockets of the process it reached, by the pid it announced', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(daemon.audits).toEqual(['4242'])
  })

  test('looks at the sockets again when the last look is old, and stops using a daemon that now holds one', SHARED, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo')
    await calls.clock.advance(60_000)
    await prompt($, 't2', 'rename bar')
    expect(daemon.audits).toEqual(['4242']) // a minute later: not looked at again

    await calls.clock.advance(5 * 60_000)
    daemon.sockets = 'Python 4242 me 3u IPv4 0x1 0t0 TCP 10.0.0.2:51234->93.184.216.34:443 (ESTABLISHED)\n'
    await prompt($, 't3', 'rename baz')
    await prompt($, 't4', 'rename qux')

    expect(daemon.audits).toEqual(['4242', '4242'])
    expect(daemon.decides).toBe(2) // t1 and t2 only
    expect(calls.model).toBe(2) // Haiku decided t3 and t4
  })

  test('a daemon that is still clean after a while keeps serving', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(6 * 60_000)
    await prompt($, 't1', 'rename foo')
    await calls.clock.advance(6 * 60_000)
    await prompt($, 't2', 'rename bar')

    expect(daemon.audits).toEqual(['4242', '4242', '4242'])
    expect(daemon.decides).toBe(2)
    expect(calls.model).toBe(0)
  })

  test('a daemon holding a network socket is not used, and Haiku decides', SHARED, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    const daemon = sharedDaemon(on, { isUp: true, sockets: 'Python 4242 me 3u IPv4 0x1 0t0 TCP 10.0.0.2:51234->93.184.216.34:443 (ESTABLISHED)\n' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo to bar in utils.ts')

    expect(daemon.decides).toBe(0)
    expect(calls.model).toBe(1)
  })

  test('starts a new daemon after the old one left, and Haiku decides meanwhile', SHARED, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, TRIVIAL, sent, 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    daemon.fail = 1 // the daemon left after its idle time: the next request finds nothing
    await prompt($, 't1', 'rename foo')
    await settle()
    await prompt($, 't2', 'rename bar')

    expect(calls.model).toBe(1) // the first prompt only
    expect(daemon.launches).toHaveLength(1)
    expect(daemon.decides).toBe(1) // the second prompt, on the new daemon
    expect(daemon.audits).toEqual(['4242', '5151']) // each process is checked
  })

  test('a launcher that fails leaves Haiku deciding, and is not retried on every prompt', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, launcherExit: 1 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo')
    await prompt($, 't2', 'rename bar')

    expect(daemon.launches).toHaveLength(1)
    expect(daemon.decides).toBe(0)
    expect(calls.model).toBe(2)
  })

  test('/pignon says the daemon is shared', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const { text = '' } = await $.command.run({
      command: 'pignon',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    expect(text).toContain('decider: laya (running) · shared daemon')
  })

  test('the status line says where the local model stands, from session start', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    sharedDaemon(on, { isUp: true })
    const shown: (string | undefined)[] = []
    on('ui.status', (_, e) => {
      shown.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo to bar in utils.ts')

    expect(shown.slice(0, 3)).toEqual(['pignon live · laya starting', 'pignon live · laya starting', 'pignon live · laya up'])
    expect(shown.at(-1)).toBe('pignon live: trivial · haiku/low · laya up')
  })

  test('the status line says when the local model is down and Haiku decides', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    sharedDaemon(on, { isUp: false, launcherExit: 1 })
    const shown: (string | undefined)[] = []
    on('ui.status', (_, e) => {
      shown.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(shown.at(-1)).toBe('pignon live · laya down → haiku')
  })

  test('a launcher that failed is tried again on a prompt a minute later', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, launcherExit: 1 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(61_000)
    await prompt($, 't1', 'rename foo')
    await settle()

    expect(daemon.launches).toHaveLength(2)
  })

  test('a launcher that failed is not tried again before a minute has passed', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, launcherExit: 1 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(59_000)
    await prompt($, 't1', 'rename foo')
    await settle()
    const early = daemon.launches.length
    await calls.clock.advance(1_000)
    await prompt($, 't2', 'rename bar')
    await settle()

    expect(early).toBe(1)
    expect(daemon.launches).toHaveLength(2)
  })

  test('the minute runs from when a failed launch ended, not from when it began', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    // A launcher the test lets fail once its two minutes have passed.
    let fail = () => {}
    const daemon = sharedDaemon(on, {
      isUp: false,
      launcherExit: 1,
      onLaunch: () =>
        new Promise<void>(resolve => {
          fail = resolve
        }),
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(130_000)
    fail()
    await settle()
    await prompt($, 't1', 'rename foo')
    await settle()
    const right = daemon.launches.length
    await calls.clock.advance(60_000)
    await prompt($, 't2', 'rename bar')
    await settle()
    fail()
    await settle()

    expect(right).toBe(1)
    expect(daemon.launches).toHaveLength(2)
  })

  test('a stop written while the daemon is launching holds: stopped, not down, and nothing launched again', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const toasts: string[] = []
    const shown: (string | undefined)[] = []
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', (_, e) => {
      shown.push(e.text)
      return { value: undefined }
    })
    // Another session runs /pignon daemon stop meanwhile; the daemon reads the file and answers `stopped`.
    const daemon = sharedDaemon(on, {
      isUp: false,
      launcherExit: 1,
      onLaunch: () => {
        daemon.files.add('/cfg/pignon/shared-stopped')
      },
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(10 * 60_000)
    await prompt($, 't1', 'rename foo')
    await settle()

    expect(toasts.filter(text => text.includes('did not start'))).toEqual([])
    expect(shown).toContain('pignon live · laya stopped → haiku')
    expect(daemon.launches).toHaveLength(1)
    expect(calls.model).toBe(1)
  })

  test('a stop by hand holds at session start: nothing is launched or asked, and Haiku decides', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, files: ['/cfg/pignon/shared-stopped'] })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await calls.clock.advance(10 * 60_000)
    await prompt($, 't1', 'rename foo')
    await settle()
    const { text = '' } = await $.command.run({ command: 'pignon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(daemon.launches).toEqual([])
    expect(daemon.audits).toEqual([])
    expect(calls.model).toBe(1)
    expect(text).toContain('decider: laya (stopped by /pignon daemon stop: Haiku decides until /pignon daemon start)')
  })

  test('/pignon daemon stop stops every version of this config dir, and no prompt starts one again', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })
    daemon.others = [
      { pid: 3131, line: psLine(3131, '/cfg/pignon/run-0badc0de/s.sock') },
      // Another config dir's daemon, and something else that runs python: not ours.
      { pid: 7070, line: psLine(7070, '/cfg-other/pignon/run-0badc0de/s.sock') },
      { pid: 8080, line: '  8080       01:00   1000 /usr/bin/python3 -m http.server' },
    ]
    daemon.runs = ['run-0badc0de', 'run-deadbeef']

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const mine = daemon.socket.split('/')[3] ?? ''
    daemon.runs.push(mine)
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'daemon stop', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await calls.clock.advance(10 * 60_000)
    await prompt($, 't1', 'rename foo')
    await settle()

    expect(daemon.killed.sort()).toEqual([3131, 4242])
    expect(daemon.files.has('/cfg/pignon/shared-stopped')).toBe(true)
    expect(text).toContain('Stopped 2 shared daemons, about 1857 MiB freed.')
    // The other versions' leftovers go; this version's directory stays.
    expect(daemon.removed).toContain('/cfg/pignon/run-0badc0de')
    expect(daemon.removed).toContain('/cfg/pignon/run-deadbeef')
    expect(daemon.removed).not.toContain(`/cfg/pignon/${mine}`)
    expect(daemon.launches).toEqual([])
    expect(calls.model).toBe(1)
  })

  test('a session whose daemon was stopped elsewhere finds the stop when its connection drops', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    // Another session ran /pignon daemon stop.
    daemon.files.add('/cfg/pignon/shared-stopped')
    daemon.isUp = false
    await prompt($, 't1', 'rename foo')
    await settle()
    await prompt($, 't2', 'rename bar')
    await settle()

    expect(daemon.launches).toEqual([])
    expect(calls.model).toBe(2)
  })

  test('/pignon daemon start lifts the stop and starts the daemon; other sessions join on their next prompt', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, files: ['/cfg/pignon/shared-stopped'] })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'daemon start', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await prompt($, 't1', 'rename foo')

    expect(daemon.files.has('/cfg/pignon/shared-stopped')).toBe(false)
    expect(daemon.launches).toHaveLength(1)
    expect(text).toContain('The shared daemon is up (pid 5151)')
    expect(daemon.decides).toBe(1)
    expect(calls.model).toBe(0)
  })

  test('a session stopped by hand joins once another session started the daemon again', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, files: ['/cfg/pignon/shared-stopped'] })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    // Another session ran /pignon daemon start.
    daemon.files.delete('/cfg/pignon/shared-stopped')
    daemon.isUp = true
    await prompt($, 't1', 'rename foo')
    await settle()
    await prompt($, 't2', 'rename bar')

    expect(calls.model).toBe(1) // the first prompt only
    expect(daemon.decides).toBe(1)
    expect(daemon.launches).toEqual([])
  })

  test('/pignon daemon restart stops the daemons, then starts this version', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'daemon restart', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(daemon.killed).toEqual([4242])
    expect(daemon.launches).toHaveLength(1)
    expect(daemon.files.has('/cfg/pignon/shared-stopped')).toBe(false)
    expect(text).toContain('The shared daemon is up (pid 5151)')
  })

  test('/pignon daemon lists the shared daemons, the idle time of this version and the others to stop', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true, health: { version: '0.1.7', uptimeSeconds: 1548, idleSeconds: 180, idleLimitSeconds: 1800 } })
    daemon.others = [{ pid: 3131, line: psLine(3131, '/cfg/pignon/run-0badc0de/s.sock', '1:02:03', 948_000) }]

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'daemon', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(text).toContain('This session: laya, shared daemon, up (pid 4242).')
    expect(text).toContain('pid 4242 · 0.1.7 (this version) · up 26 min · last prompt 3 min ago, leaves in 27 min · 929 MiB')
    expect(text).toContain('pid 3131 · unknown version (another mod folder: its sessions use it until they restart) · up 1 h 2 min · leaves after 30 min without a prompt · 926 MiB')
    expect(text).toContain('Commands: /pignon daemon stop | start | restart')
  })

  test('/pignon daemon names each mod folder\'s version, and tells this version in another folder from an older one', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: false, health: { version: '0.1.7' } })
    // This mod's manifest; nothing else is read.
    on('fs.read', (_, e) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? '{"name":"pignon","version":"0.1.7"}' : '' }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    // The mod folder, as the launch ran from it; its siblings are the cache's other versions.
    const root = (daemon.launches[0]?.cwd ?? '').replace(/\/daemon$/, '')
    const parent = root.replace(/\/[^/]+$/, '')
    daemon.siblings = ['0.1.6', '0.1.7', 'notes']
    daemon.others = [
      { pid: 3131, line: psLine(3131, `/cfg/pignon/${runOf(`${parent}/0.1.6`)}/s.sock`) },
      { pid: 3232, line: psLine(3232, `/cfg/pignon/${runOf(`${parent}/0.1.7`)}/s.sock`) },
    ]
    const { text = '' } = await $.command.run({ command: 'pignon', args: 'daemon', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(text).toContain('pid 5151 · 0.1.7 (this version) ·')
    expect(text).toContain('pid 3131 · 0.1.6 (another version: its sessions use it until they restart) ·')
    expect(text).toContain('pid 3232 · 0.1.7 (this version from another mod folder: its sessions use it) ·')
  })

  test('/pignon daemon stop leaves a run directory whose lock is held: a daemon starting there after the ps', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })
    daemon.runs = ['run-0badc0de', 'run-deadbeef']
    // An older session relaunches its daemon in run-0badc0de after the stop's ps.
    daemon.held.add('/cfg/pignon/run-0badc0de')

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await $.command.run({ command: 'pignon', args: 'daemon stop', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(daemon.removed.filter(path => path.startsWith('/cfg/pignon/run-0badc0de'))).toEqual([])
    expect(daemon.removed).toEqual([
      '/cfg/pignon/run-deadbeef/daemon.log',
      '/cfg/pignon/run-deadbeef/s.sock',
      '/cfg/pignon/run-deadbeef/lock',
      '/cfg/pignon/run-deadbeef',
    ])
  })

  test('/pignon daemon restart starts this version even when an old daemon outlives the signal', SHARED, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live')
    const daemon = sharedDaemon(on, { isUp: true })
    daemon.others = [{ pid: 3131, line: psLine(3131, '/cfg/pignon/run-0badc0de/s.sock') }]
    daemon.stubborn.add(3131)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    let isDone = false
    const restarted = $.command
      .run({ command: 'pignon', args: 'daemon restart', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
      .finally(() => {
        isDone = true
      })
    // The stop waits up to 5 s for the signalled daemons, on the mocked clock.
    for (let i = 0; i < 100 && !isDone; i++) {
      await settle()
      await calls.clock.advance(200)
    }
    const { text = '' } = await restarted

    expect(text).toContain('Still running after 5 s: pid 3131.')
    expect(text).toContain('The shared daemon is up (pid 5151)')
    expect(daemon.files.has('/cfg/pignon/shared-stopped')).toBe(false)
  })

  test('the status line says pinned from session start when routing is pinned', SHARED, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    sharedDaemon(on, { isUp: true })
    const shown: (string | undefined)[] = []
    on('ui.status', (_, e) => {
      shown.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    await prompt($, 't1', 'rename foo')
    await $.turn.start({ turnId: 't2', text: 'rename bar' })
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3 }));
    shown.length = 0
    // A new session start in the same process, as /clear makes.
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(shown[0]).toBe('pignon pinned · laya up')
    expect(shown.filter(text => text?.startsWith('pignon live'))).toEqual([])
  })

  test('stop and start say they act on the shared daemon when the session runs its own', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    const runs: (readonly string[])[] = []
    on('process.run', (_, e) => {
      runs.push(e.argv)
      return { value: OK }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()
    const before = runs.length
    const texts: string[] = []
    for (const action of ['stop', 'start', 'restart']) {
      const { text = '' } = await $.command.run({ command: 'pignon', args: `daemon ${action}`, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
      texts.push(text)
    }

    expect(texts).toEqual(
      ['stop', 'start', 'restart'].map(
        action =>
          `/pignon daemon ${action} acts on the shared daemon, and this session runs its own copy, which stops with it. Set "How the local model runs" to shared in /config to use one.`,
      ),
    )
    // Nothing signalled, launched, written or removed.
    expect(runs.slice(before)).toEqual([])
  })

  test('a per-session daemon whose folder cannot be made shows down, not starting', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    const spawned: ProcessSpawnRequest[] = []
    const shown: (string | undefined)[] = []
    on('process.run', () => {
      throw new Error('mkdir refused')
    })
    on('process.spawn', async function* (_, e) {
      spawned.push(e)
      return { value: { code: 0, signal: null } }
    })
    on('ui.status', (_, e) => {
      shown.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(spawned).toEqual([])
    expect(shown.at(-1)).toBe('pignon live · laya down → haiku')
  })

  test('the per-session daemon stays the default when laya is chosen', LOCAL, async ($, on) => {
    const spawned: ProcessSpawnRequest[] = []
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: { exitCode: 0, ...NO_OUTPUT } }))
    on('process.spawn', async function* (_, e) {
      spawned.push(e)
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.argv).not.toContain('--shared')
  })
})

// The decision log: metadata only, one file per session, summed by /pignon stats.
const RECORDING = { options: { decider: 'laya', record: 'on' } }
const SECRET = 'rename SECRETWORD to bar in utils.ts'

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 0,
    at: Date.UTC(2026, 9, 30, 12, 0, 0),
    mode: 'shadow',
    model: OPUS,
    was: null,
    prompt: SECRET.slice(0, 80),
    promptChars: SECRET.length,
    sent: SECRET,
    tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 },
    daemonMs: 9,
    second: { decision: { tier: 'trivial', explore: false, confidence: 0.8 }, ms: 700 },
    decider: 'laya',
    decision: { tier: 'trivial', explore: false, confidence: 0.9 },
    ms: 14,
    action: 'would switch',
    tier: 'trivial',
    reason: 'downgrade trivial',
    ...over,
  }
}

const CONTEXT = {
  session: 'ab12cd34',
  project: '/work/api',
  chosen: 'laya' as const,
  daemon: 'shared' as const,
  contextTokens: 12_000,
}

describe('the decision log: a record', () => {
  test('keeps no word of the prompt, only its length', async () => {
    const line = serialize([recordOf(entry(), CONTEXT)])

    expect(line).not.toContain('SECRETWORD')
    expect(line).not.toContain('utils.ts')
    expect(JSON.parse(line).promptChars).toBe(SECRET.length)
  })

  test('leaves out a second opinion still pending, and a long reason is cut', async () => {
    const pending = recordOf(entry({ second: { decision: null, ms: 0, isPending: true }, reason: 'x'.repeat(500) }), CONTEXT)

    expect(pending.second).toBeUndefined()
    expect(pending.reason).toHaveLength(80)
  })

  test('reading skips a half-written line and a record of another version', async () => {
    const good = serialize([recordOf(entry(), CONTEXT)])
    const text = `${good}{"v":1,"at":\n{"v":2,"at":1}\nnot json\n${good}`

    expect(parseRecords(text)).toHaveLength(2)
  })
})

describe('the decision log: the summary', () => {
  const at = (n: number) => Date.UTC(2026, 9, 30, 12, n, 0)
  const rec = (n: number, laya: number, haiku: string | null, project = '/work/api'): DecisionRecord =>
    recordOf(
      entry({
        id: n,
        at: at(n),
        decision: { tier: 'trivial', explore: false, confidence: laya },
        second: { decision: haiku ? { tier: haiku, explore: false, confidence: 0.8 } : null, ms: 600 },
      }),
      { ...CONTEXT, project },
    )

  test('says what to do when nothing is recorded', async () => {
    expect(summarize([], 0)).toContain('"record" to "on"')
  })

  test('counts agreement by confidence band, so the downgrade bar can be tuned', async () => {
    const records = [
      rec(1, 0.6, 'standard'),
      rec(2, 0.6, 'trivial'),
      rec(3, 0.75, 'trivial'),
      rec(4, 0.9, 'trivial'),
      rec(5, 0.9, 'trivial'),
      rec(6, 0.9, null),
    ]

    const text = summarize(records, 2)

    expect(text).toContain('6 decisions in 2 sessions, 2026-10-30 to 2026-10-30')
    expect(text).toContain('5 compared · 4 agree (80%) · 1 differ · haiku gave no answer for 1')
    expect(text).toMatch(/0\.50 to 0\.70\s+50% agree \(n=2\)/)
    expect(text).toMatch(/0\.70 to 0\.85\s+100% agree \(n=1\)/)
    expect(text).toMatch(/p ≥ 0\.85\s+100% agree \(n=2\)/)
    expect(text).toContain('differences (laya → haiku): trivial → standard 1')
  })

  test('splits agreement by project, and reports latency and fallbacks', async () => {
    const records = [
      rec(1, 0.9, 'trivial', '/work/api'),
      rec(2, 0.9, 'standard', '/work/web'),
      recordOf(entry({ id: 3, at: at(3), decider: 'haiku', tiers: undefined, second: undefined, fallback: 'it is not running', daemonMs: undefined }), CONTEXT),
    ]

    const text = summarize(records, 1)

    expect(text).toMatch(/work\/api\s+100% agree \(n=1\)/)
    expect(text).toMatch(/work\/web\s+0% agree \(n=1\)/)
    expect(text).toContain('latency: laya p50 14 ms')
    expect(text).toContain('fell back to haiku: it is not running 1')
  })
})

describe('the decision log: in a session', () => {
  const HAIKU_SAYS_STANDARD = '{"tier":"standard","explore":false,"confidence":0.8}'
  const LAYA = {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 }, latencyMs: 9 }),
  }

  // The engine below the mod: a daemon that answers, a disk that records what is written.
  function disk(on: On, options: { failWrites?: boolean; folders?: string[]; failsPrivate?: boolean } = {}) {
    const seen = { writes: [] as { path: string; text: string }[], runs: [] as (readonly string[])[] }
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      seen.runs.push(e.argv)

      return { value: options.failsPrivate && e.argv[0] === 'install' ? { ...OK, exitCode: 1 } : OK }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => ({ value: LAYA }))
    on('session.cwd', () => ({ value: '/work/api' }))
    on('fs.exists', (_, e) => ({ value: (options.folders ?? []).includes(e.path) }))
    on('fs.write', (_, e) => {
      if (options.failWrites) throw new Error('disk full')
      seen.writes.push(e)

      return { value: undefined }
    })

    return seen
  }

  const last = (seen: { writes: { text: string }[] }) => parseRecords(seen.writes.at(-1)?.text ?? '')

  test('writes nothing unless it was asked to', LOCAL, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()

    expect(seen.writes).toEqual([])
    expect(seen.runs.some(argv => argv.join(' ').includes('/decisions'))).toBe(false)
  })

  test('one line per decision, in a private folder, without the prompt', RECORDING, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()
    await prompt($, 't2', 'add a test for the parser')
    await settle()

    expect(seen.runs).toContainEqual(['install', '-d', '-m', '700', '/cfg/pignon/decisions'])
    const paths = new Set(seen.writes.map(w => w.path))
    expect(paths.size).toBe(1) // one file for the session, rewritten as it grows
    expect([...paths][0]).toMatch(/^\/cfg\/pignon\/decisions\/\d{8}T\d{6}-[0-9a-f]{8}\.jsonl$/)
    const records = last(seen)
    expect(records.map(r => r.n)).toEqual([0, 1])
    expect(records[0]).toMatchObject({ decider: 'laya', chosen: 'laya', daemon: 'session', project: '/work/api', mode: 'shadow', promptChars: SECRET.length })
    expect(seen.writes.every(w => !w.text.includes('SECRETWORD') && !w.text.includes('parser'))).toBe(true)
  })

  test("Haiku's opinion is added to the record once it has answered", RECORDING, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()

    expect(parseRecords(seen.writes[0]?.text ?? '')[0]?.second).toBeUndefined()
    expect(last(seen)[0]?.second?.decision).toEqual({ tier: 'standard', explore: false, confidence: 0.8 })
  })

  test('says who was chosen and how the model ran', { options: { record: 'on' } }, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', SECRET)
    await settle()

    expect(last(seen)[0]).toMatchObject({ chosen: 'haiku', daemon: null, decider: 'haiku', mode: 'live' })
  })

  test('removes logs older than 90 days when the session starts, with the log on or off', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    const seen = disk(on, { folders: ['/cfg/pignon/decisions'] })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(seen.runs).toContainEqual(['find', '/cfg/pignon/decisions', '-name', '*.jsonl', '-mtime', '+90', '-delete'])
  })

  test('a disk that fails costs no prompt', RECORDING, async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, HAIKU_SAYS_STANDARD, sent, 'live')
    disk(on, { failWrites: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await prompt($, 't2', 'add a test')
    await settle()

    expect(sent).toHaveLength(2)
  })

  test('/pignon stats sums the session files', RECORDING, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    disk(on)
    const files = {
      '/cfg/pignon/decisions/a.jsonl': serialize([recordOf(entry(), CONTEXT)]),
      '/cfg/pignon/decisions/b.jsonl': serialize([recordOf(entry({ id: 1, second: { decision: { tier: 'hard', explore: false, confidence: 0.7 }, ms: 500 } }), CONTEXT)]),
    }
    on('fs.list', () => ({
      value: Object.keys(files).map((path, i) => ({ name: path.split('/').pop()!, kind: 'file' as const, size: 1, mtimeMs: i, isLink: false })),
    }))
    on('fs.read', (_, e) => ({ value: files[e.path as keyof typeof files] ?? '' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const { text = '' } = await $.command.run({
      command: 'pignon',
      args: 'stats',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    expect(text).toContain('2 decisions in 2 sessions')
    expect(text).toContain('2 compared · 1 agree (50%) · 1 differ')
  })

  test('/pignon stats says how to start when there is no folder yet', RECORDING, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    disk(on)
    on('fs.list', () => {
      throw new Error('ENOENT')
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const { text = '' } = await $.command.run({
      command: 'pignon',
      args: 'stats',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    expect(text).toContain('No decisions recorded yet')
  })

  // The corpus: the prompts themselves, kept apart from the log, for training a local judge.
  const CORPUS = { options: { decider: 'laya', record: 'on', corpus: 'on' } }
  const corpusWrites = (seen: { writes: { path: string; text: string }[] }) => seen.writes.filter(w => w.path.includes('/corpus/'))

  test('keeps no prompt unless asked to', RECORDING, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()

    expect(corpusWrites(seen)).toEqual([])
    expect(seen.runs.some(argv => argv.join(' ').includes('/corpus'))).toBe(false)
  })

  test('keeps each judged prompt in its own file, in a private folder, under the key of its record', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()
    await prompt($, 't2', 'add a test for the parser')
    await settle()

    expect(seen.runs).toContainEqual(['install', '-d', '-m', '700', '/cfg/pignon/corpus'])
    const kept = corpusWrites(seen)
    expect(kept).toHaveLength(2)
    const records = last({ writes: seen.writes.filter(w => w.path.includes('/decisions/')) })
    for (const [i, write] of kept.entries()) {
      const item = JSON.parse(write.text)
      expect(write.path).toBe(`/cfg/pignon/corpus/${records[i]!.session}-${records[i]!.n}.json`)
      expect(item).toMatchObject({ v: 1, session: records[i]!.session, n: records[i]!.n, at: records[i]!.at })
    }
    expect(JSON.parse(kept[0]!.text).text).toBe(SECRET)
    expect(JSON.parse(kept[1]!.text).text).toBe('add a test for the parser')
    // The log itself still holds no word of a prompt.
    expect(seen.writes.filter(w => w.path.includes('/decisions/')).every(w => !w.text.includes('SECRETWORD'))).toBe(true)
  })

  test('keeps no acknowledgement, and cuts a long prompt', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'x'.repeat(40_000))
    await settle()
    await prompt($, 't2', 'yes')
    await settle()

    const kept = corpusWrites(seen)
    expect(kept).toHaveLength(1)
    expect(JSON.parse(kept[0]!.text)).toMatchObject({ text: 'x'.repeat(32_000), chars: 40_000 })
  })

  test('removes kept prompts older than 90 days when the session starts, with the corpus on or off', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    const seen = disk(on, { folders: ['/cfg/pignon/corpus'] })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    expect(seen.runs).toContainEqual(['find', '/cfg/pignon/corpus', '-name', '*.json', '-mtime', '+90', '-delete'])
  })

  test('a /clear starts new keys, so no prompt of the last conversation is overwritten', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'first conversation')
    await settle()
    // A /clear: the session ends, the process goes on, and no session.start fires.
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await prompt($, 't2', 'second conversation')
    await settle()

    const kept = corpusWrites(seen)
    expect(kept).toHaveLength(2)
    expect(new Set(kept.map(w => w.path)).size).toBe(2)
    const [first, second] = kept.map(w => JSON.parse(w.text))
    expect(first.session).not.toBe(second.session)
    // Each conversation's records go to a file of their own, under the same key as its prompts.
    const logs = [...new Set(seen.writes.filter(w => w.path.includes('/decisions/')).map(w => w.path))]
    expect(logs).toHaveLength(2)
    expect(logs[1]).toContain(second.session)
  })

  test('keeps no prompt that was not routed: pignon off, the model pinned, or a subagent', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await $.turn.start({ turnId: 'a', text: 'a subagent task', agentId: 'a1' })
    for await (const _ of $.turn.step({ turnId: 'a', index: 0, model: OPUS, effort: 'high', messageCount: 1, agentId: 'a1' }));
    await prompt($, 't1', 'routed')
    // Picking another model pins routing: the prompts after it are not judged.
    await $.turn.start({ turnId: 't2', text: 'pinned' })
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3 }));
    await settle()

    expect(corpusWrites(seen).map(w => JSON.parse(w.text).text)).toEqual(['routed'])
  })

  test('keeps nothing while pignon is off', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'off')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()

    expect(corpusWrites(seen)).toEqual([])
  })

  test('never cuts a long prompt in the middle of a character', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    // The emoji's two halves sit at 31,999 and 32,000: the cut falls between them.
    await prompt($, 't1', 'x'.repeat(31_999) + '😀' + 'y'.repeat(100))
    await settle()

    const { text } = JSON.parse(corpusWrites(seen)[0]!.text)
    expect(text).toBe('x'.repeat(31_999))
  })

  test('a corpus folder made private on every prompt, not only when it is created', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'one')
    await settle()
    await prompt($, 't2', 'two')
    await settle()

    const made = seen.runs.filter(argv => argv.join(' ') === 'install -d -m 700 /cfg/pignon/corpus')
    expect(made).toHaveLength(2)
  })

  test('a folder that cannot be made private keeps no prompt', CORPUS, async ($, on) => {
    engine(on, HAIKU_SAYS_STANDARD, [], 'shadow')
    const seen = disk(on, { failsPrivate: true })
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await settle()

    expect(corpusWrites(seen)).toEqual([])
    expect(toasts).toContain('pignon: a prompt could not be kept in the corpus.')
  })

  test('a disk that fails costs no prompt', CORPUS, async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, HAIKU_SAYS_STANDARD, sent, 'live')
    disk(on, { failWrites: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', SECRET)
    await prompt($, 't2', 'add a test')
    await settle()

    expect(sent).toHaveLength(2)
  })

  const LABELS: [options: Record<string, string>, mode: string, says: string | null][] = [
    [{ corpus: 'on' }, 'shadow', 'the log is off, so the kept prompts get no labels'],
    [{ corpus: 'on', record: 'on' }, 'shadow', 'the oracle is off, so the kept prompts get no labels'],
    [{ corpus: 'on', record: 'on', oracle: 'on' }, 'live', 'the oracle only runs in shadow mode, so the kept prompts get no labels'],
    [{ corpus: 'on', record: 'on', oracle: 'on' }, 'shadow', null],
  ]
  for (const [options, mode, says] of LABELS) {
    test(`/pignon says the corpus is on, and whether its prompts get labels: ${JSON.stringify(options)} in ${mode}`, { options: { decider: 'laya', ...options } }, async ($, on) => {
      engine(on, HAIKU_SAYS_STANDARD, [], mode)
      disk(on)
      await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

      const { text = '' } = await $.command.run({
        command: 'pignon',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })

      expect(text).toContain('corpus: on (0 prompts kept this session')
      if (says) expect(text).toContain(says)
      else expect(text).not.toContain('no labels')
    })
  }
})

// The cost and the under-routing signal, in dollars at list price.
describe('prices', () => {
  const million = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }

  test('each family has a price, by alias or full id, and an unknown model has none', async () => {
    expect(priceOf(million, 'haiku')).toBe(0.1)
    expect(priceOf(million, 'claude-sonnet-5-5')).toBe(2)
    expect(priceOf(million, 'claude-opus-5-5')).toBe(4)
    expect(priceOf({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, 'opus')).toBe(20)
    expect(priceOf({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, 'opus')).toBe(5.2)
    expect(priceOf(million, 'claude-fable-5-1')).toBe(null)
    expect(priceOf(million, 'gpt-9')).toBe(null)
  })

  test('a turn is priced on the model that answered, on the session model and on the tier', async () => {
    const usage = { ...million, model: 'claude-haiku-5-5' }

    expect(turnCost(usage, OPUS, 'trivial')).toEqual({ actual: 0.1, onSessionModel: 4, onTier: 0.1 })
    expect(turnCost({ ...million, model: OPUS }, OPUS, 'trivial')).toEqual({ actual: 4, onSessionModel: 4, onTier: 0.1 })
    expect(turnCost(usage, OPUS, null)).toEqual({ actual: 0.1, onSessionModel: 4, onTier: 4 })
    expect(turnCost(usage, 'claude-fable-5-1', 'trivial')).toBe(null)
  })

  test('dollars are written to the cent, or to the tenth of a cent under a dollar', async () => {
    expect(usd(0.0123)).toBe('$0.012')
    expect(usd(4.126)).toBe('$4.13')
  })
})

describe('policy: a cold cache', () => {
  const standard = { tier: 'standard', explore: true, confidence: 0.95 }
  const hard = { tier: 'hard', explore: true, confidence: 0.95 }

  test('lifts both guards: a downgrade past 60k and an upgrade past 100k go through, and say why', async () => {
    const down = decide({ ...base, contextTokens: 120_000, decision: standard, isCacheCold: true })
    expect(down.target).toBe('standard')
    expect(down.reason).toContain('cache cold')

    const up = decide({ ...base, current: 'standard', contextTokens: 110_000, decision: hard, isCacheCold: true })
    expect(up.target).toBe('hard')
    expect(up.reason).toContain('cache cold')
  })

  test('lifts the cooldown', async () => {
    expect(decide({ ...base, current: 'hard', promptsSinceSwitch: 1, decision: standard, isCacheCold: true }).target).toBe('standard')
  })

  test('keeps the confidence bars', async () => {
    expect(decide({ ...base, decision: { tier: 'trivial', explore: false, confidence: 0.6 }, isCacheCold: true }).target).toBe(null)
  })

  test('a warm cache is the default', async () => {
    expect(decide({ ...base, contextTokens: 120_000, decision: standard }).reason).toContain('cache protected')
  })
})

describe('policy: under-routing', () => {
  const turn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({ steps: 3, reason: 'answer', durationMs: 1_000, ...over })

  test('a trivial turn that ran a long tool loop, however it was decided', async () => {
    expect(isUnderRouted({ tier: 'trivial', action: 'switched', turn: turn({ steps: 8 }) })).toBe(true)
    expect(isUnderRouted({ tier: 'trivial', action: 'would switch', turn: turn({ steps: 12 }) })).toBe(true)
    expect(isUnderRouted({ tier: 'trivial', action: 'switched', turn: turn({ steps: 7 }) })).toBe(false)
    expect(isUnderRouted({ tier: 'standard', action: 'switched', turn: turn({ steps: 30 }) })).toBe(false)
  })

  test('a switched turn that ended in an error or a refusal, not an unrouted one', async () => {
    expect(isUnderRouted({ tier: 'standard', action: 'switched', turn: turn({ reason: 'error' }) })).toBe(true)
    expect(isUnderRouted({ tier: 'standard', action: 'switched', turn: turn({ reason: 'refusal' }) })).toBe(true)
    expect(isUnderRouted({ tier: 'standard', action: 'switched', turn: turn({ reason: 'aborted' }) })).toBe(false)
    expect(isUnderRouted({ tier: null, action: 'kept', turn: turn({ reason: 'error' }) })).toBe(false)
    expect(isUnderRouted({ tier: 'trivial', action: 'switched' })).toBe(false)
  })
})

// What each routed turn cost: filled in on its entry when the turn ends.
const MILLION_IN: TurnUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }

async function complete($: Engine, turnId: string, over: Partial<{ durationMs: number; usage: TurnUsage; agentId: string; reason: 'answer' | 'aborted' | 'error' }> = {}) {
  const { reason = 'answer', ...rest } = over
  await $.turn.complete({ turnId, answer: 'done', durationMs: 12_000, isAborted: false, reason, usage: MILLION_IN, ...rest })
}

async function logText($: Engine): Promise<string> {
  const { text = '' } = await $.command.run({ command: 'pignon', args: 'log', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  return text
}

describe("a turn's end", () => {
  test('adds its steps, its time and its cost against the session model to the entry', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo')
    for (const index of [1, 2]) for await (const _ of $.turn.step({ turnId: 't1', index, model: OPUS, effort: 'high', messageCount: 3 }));
    expect(await logText($)).not.toContain('steps')
    await complete($, 't1')

    expect(await logText($)).toContain('3 steps · 12 s · $0.100 (session model $4.00)')
  })

  test('in shadow mode, says what the tier would have cost', async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo')
    await complete($, 't1', { usage: { ...MILLION_IN, model: OPUS } })

    expect(await logText($)).toContain('1 step · 12 s · $4.00 (would be $0.100 on trivial)')
  })

  test('says how the turn ended when it was not an answer, and leaves out a cost it cannot price', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo')
    await complete($, 't1', { reason: 'error', usage: { ...MILLION_IN, model: 'claude-fable-5-1' } })

    expect(await logText($)).toContain('1 step · 12 s · error · under-routed')
  })

  test("a subagent's end, or an unrouted turn's, changes nothing", async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo')
    await complete($, 't1', { agentId: 'a1' })
    await complete($, 't9')

    expect(await logText($)).not.toContain('steps')
  })

  // A session on Opus that keeps its log: every write, and the records last written.
  function recording(on: On, mode: 'live' | 'shadow') {
    engine(on, TRIVIAL, [], mode)
    const writes: { path: string; text: string }[] = []
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', () => ({ value: OK }))
    on('session.cwd', () => ({ value: '/work/api' }))
    on('fs.write', (_, e) => {
      writes.push(e)

      return { value: undefined }
    })

    return { writes, last: () => parseRecords(writes.at(-1)?.text ?? '') }
  }

  test('goes on the record too, when the log is kept', { options: { record: 'on' } }, async ($, on) => {
    const { writes, last } = recording(on, 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', SECRET)
    await settle()
    expect(last()[0]?.turn).toBeUndefined()
    await complete($, 't1')
    await settle()

    expect(last()[0]?.turn).toMatchObject({ steps: 1, reason: 'answer', durationMs: 12_000, effort: 'low', cost: { actual: 0.1, onSessionModel: 4, onTier: 0.1 } })
    expect(writes.every(w => !w.text.includes('SECRETWORD'))).toBe(true)
  })

  test("keeps the effort the turn ran at: the session's own in shadow mode", { options: { record: 'on' } }, async ($, on) => {
    const { last } = recording(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo')
    await complete($, 't1')
    await settle()

    expect(last().map(r => r.turn?.effort)).toEqual(['high'])
  })

  test('keeps null for the effort when the requests named none', { options: { record: 'on' } }, async ($, on) => {
    const { last } = recording(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await $.turn.start({ turnId: 't1', text: 'rename foo' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 1 }));
    await complete($, 't1')
    await settle()

    expect(last().map(r => r.turn?.effort)).toEqual([null])
  })

  test('the pane draws it, in warning colour when the tier fell short', LOCAL, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    withDaemon(on, () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers: { trivial: 0.9, standard: 0.07, hard: 0.03 }, latencyMs: 9 }) }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'rename foo to bar in utils.ts')
    for (let index = 1; index < 8; index++) for await (const _ of $.turn.step({ turnId: 't1', index, model: OPUS, effort: 'high', messageCount: 3 }));
    await complete($, 't1')

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    const line = await ui.find({ type: 'Text', text: /steps/ })
    expect(line?.text).toBe('8 steps · 12 s · $0.100 (session model $4.00) · under-routed')
    expect(line?.props.color).toBe('warning')
    await ui.unmount()
  })

  test('/pignon sums the session', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const status = async () => (await $.command.run({ command: 'pignon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''

    expect(await status()).toContain('this session: no turn priced yet')
    await prompt($, 't1', 'rename foo')
    await complete($, 't1')

    expect(await status()).toContain('this session: spent $0.100 · saved $3.90')
  })
})

describe('the decision log: the cost', () => {
  const cost = { actual: 0.1, onSessionModel: 4, onTier: 0.1 }
  const ended = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({ steps: 2, reason: 'answer', durationMs: 5_000, cost, ...over })

  test('sums what was spent and saved live, and what shadow mode would have saved', async () => {
    const records = [
      recordOf(entry({ id: 1, action: 'switched', turn: ended(), mode: 'live' }), CONTEXT),
      recordOf(entry({ id: 2, action: 'switched', turn: ended({ steps: 9 }), mode: 'live' }), CONTEXT),
      recordOf(entry({ id: 3, turn: ended({ cost: { actual: 4, onSessionModel: 4, onTier: 0.1 } }) }), CONTEXT),
      recordOf(entry({ id: 4, turn: ended({ cost: undefined }) }), CONTEXT),
    ]

    const text = summarize(records, 1)

    expect(text).toContain('cost (estimated at list price): 3 turns priced')
    expect(text).toContain('live:   spent $0.200 · $8.00 on the session model · saved $7.80 (98%)')
    expect(text).toContain('shadow: would have saved $3.90 of $4.00')
    expect(text).toContain('by tier: trivial 3 turns $0.300')
    expect(text).toContain('under-routed: 1 trivial turn ran 8+ steps')
  })

  test('counts switched turns that ended badly, and says nothing when no turn has ended', async () => {
    const text = summarize([recordOf(entry({ action: 'switched', tier: 'standard', turn: ended({ reason: 'error' }), mode: 'live' }), CONTEXT)], 1)
    expect(text).toContain('under-routed: 1 switched turn ended in an error or a refusal')

    const aborted = summarize([recordOf(entry({ action: 'switched', tier: 'trivial', turn: ended({ steps: 9, reason: 'aborted' }), mode: 'live' }), CONTEXT)], 1)
    expect(aborted).toContain('under-routed: 1 trivial turn ran 8+ steps')
    expect(aborted).not.toContain('error or a refusal')

    const none = summarize([recordOf(entry(), CONTEXT)], 1)
    expect(none).not.toContain('cost')
    expect(none).not.toContain('under-routed')
  })
})

describe('the decision log: turns by effort', () => {
  const cost = { actual: 0.1, onSessionModel: 4, onTier: 0.1 }
  const short = { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, model: OPUS }
  const ended = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({ steps: 2, reason: 'answer', durationMs: 5_000, usage: short, cost, ...over })
  const hard = { tier: 'hard', explore: true, confidence: 0.9 }

  test("splits the turns by the effort they ran at, the old records apart, and counts the deciding judge's hard verdicts", async () => {
    const records = [
      recordOf(entry({ id: 1, decision: hard, turn: ended({ effort: 'medium' }) }), CONTEXT),
      recordOf(entry({ id: 2, decision: hard, turn: ended({ effort: 'medium', steps: 6 }), corrected: true }), CONTEXT),
      recordOf(entry({ id: 3, turn: ended({ effort: 'medium', cost: undefined }) }), CONTEXT),
      recordOf(entry({ id: 4, decision: hard, turn: ended({ effort: 'high', steps: 6 }) }), CONTEXT),
      recordOf(entry({ id: 5, turn: ended({ effort: null }) }), CONTEXT),
      recordOf(entry({ id: 6, turn: ended({ cost: { ...cost, actual: 2 } }) }), CONTEXT),
    ]

    const text = summarize(records, 1)

    expect(text).toContain("turns, by the effort they ran at (too high counts the deciding judge's hard verdicts):")
    expect(text).toContain('  medium   3 turns · corrected 33% of 3 · too high 50% of 2 hard · $0.200 spent on 2 priced')
    expect(text).toContain('  high     1 turn · corrected 0% of 1 · too high 0% of 1 hard · $0.100 spent')
    expect(text).toContain('  default  1 turn · corrected 0% of 1 · $0.100 spent')
    expect(text).toContain('  not kept 1 turn · corrected 0% of 1 · $2.00 spent')
    expect(text).toContain("default: the requests named no effort, so the model's own ran · not kept: recorded before the effort was kept (0.1.10)")
    expect(text).not.toContain('  low ')
  })

  test('says nothing when no turn has ended, and leaves out the notes it does not need', async () => {
    expect(summarize([recordOf(entry(), CONTEXT)], 1)).not.toContain('by the effort')

    const text = summarize([recordOf(entry({ turn: ended({ effort: 'low' }) }), CONTEXT)], 1)
    expect(text).toContain('  low      1 turn · corrected 0% of 1 · $0.100 spent')
    expect(text).not.toContain('not kept')
    expect(text).not.toContain('default:')
  })
})

// The cache guard, lifted when the cache is cold anyway.
describe('a cold cache', () => {
  const HARD = '{"tier":"hard","explore":true,"confidence":0.9}'
  // A step answered over 150k tokens of context, past both guards.
  const BIG: TurnUsage = { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
  const NOON = Date.UTC(2026, 9, 30, 12, 0, 0)
  // A compaction leaves at least one message.
  const KEPT = { role: 'user' as const, text: 'summary', toolUses: [] }

  // Trivial first, then hard on every prompt after: the upgrade the guard holds.
  function replies() {
    const queue = [TRIVIAL]
    return () => Promise.resolve(queue.shift() ?? HARD)
  }

  async function guarded($: Engine, sent: TurnStepInput[]) {
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await prompt($, 't1', 'rename foo')
    await prompt($, 't2', 'find why the build fails')
    expect(sent.map(e => e.model)).toEqual(['haiku', 'haiku'])
  }

  test('after a compaction, the next prompt may switch past the guard', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, replies(), sent, 'live', { usage: BIG, now: NOON })
    on('session.compact', () => ({ messages: [KEPT], tokensBefore: 150_000, tokensAfter: 20_000 }))
    await guarded($, sent)

    await $.session.compact({ trigger: 'manual', messages: [KEPT] })
    await prompt($, 't3', 'find why the build fails')

    expect(sent[2]?.model).toBe('opus')
    expect(await logText($)).toContain('(cache cold)')
  })

  test('a precomputed or a skipped compaction lifts nothing', async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, replies(), sent, 'live', { usage: BIG, now: NOON })
    let answer: { messages: (typeof KEPT)[]; tokensAfter: number } | { skip: string } = { messages: [KEPT], tokensAfter: 20_000 }
    on('session.compact', () => answer)
    await guarded($, sent)

    await $.session.compact({ trigger: 'precompute', messages: [KEPT] })
    await prompt($, 't3', 'find why the build fails')
    answer = { skip: 'off' }
    await $.session.compact({ trigger: 'auto', messages: [KEPT] })
    await prompt($, 't4', 'find why the build fails')

    expect(sent.slice(2).map(e => e.model)).toEqual(['haiku', 'haiku'])
  })

  test("a subagent's compaction lifts nothing", async ($, on) => {
    const sent: TurnStepInput[] = []
    engine(on, replies(), sent, 'live', { usage: BIG, now: NOON })
    on('session.compact', () => ({ messages: [KEPT], tokensAfter: 20_000 }))
    await guarded($, sent)

    await $.session.compact({ trigger: 'auto', messages: [KEPT], agentId: 'a1' })
    await prompt($, 't3', 'find why the build fails')

    expect(sent[2]?.model).toBe('haiku')
  })

  test('an idle gap past the 5-minute TTL lifts the guard, and every request warms the cache again', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, replies(), sent, 'live', { usage: BIG, now: NOON })
    await guarded($, sent)

    // Just under the TTL since the last request: still warm, and this request restarts the clock.
    await calls.clock.advance(5 * 60_000 - 1)
    await prompt($, 't3', 'find why the build fails')
    expect(sent[2]?.model).toBe('haiku')
    await calls.clock.advance(5 * 60_000 - 1)
    await prompt($, 't4', 'find why the build fails')
    expect(sent[3]?.model).toBe('haiku')
    await calls.clock.advance(5 * 60_000 + 1)
    await prompt($, 't5', 'find why the build fails')
    expect(sent[4]?.model).toBe('opus')
    expect(await logText($)).toContain('(cache cold)')
  })

  test('with nothing set, the one-hour cache is assumed: five minutes idle is not cold but an hour is', async ($, on) => {
    const sent: TurnStepInput[] = []
    const calls = engine(on, replies(), sent, 'live', { usage: BIG, now: NOON })
    await guarded($, sent)

    await calls.clock.advance(6 * 60_000)
    await prompt($, 't3', 'find why the build fails')
    expect(sent[2]?.model).toBe('haiku')
    await calls.clock.advance(61 * 60_000)
    await prompt($, 't4', 'find why the build fails')
    expect(sent[3]?.model).toBe('opus')
  })

  // The lifetime as `/pignon` reports it, with where it was read.
  async function ttlOf($: Engine): Promise<string> {
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const { text = '' } = await $.command.run({ command: 'pignon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    return /ttl ([^·]+) ·/.exec(text)?.[1]?.trim() ?? text
  }

  test('reads the lifetime where the engine reads it: the env var, else the setting, else the 1h switch', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', ENABLE_PROMPT_CACHING_1H: '1' })
    on('settings.read', () => ({ value: { promptCacheTtl: '1h' } }))

    expect(await ttlOf($)).toBe('5m (CLAUDE_CODE_PROMPT_CACHE_TTL)')
  })

  test('the setting, then ENABLE_PROMPT_CACHING_1H, then the assumption', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    let settings: Record<string, unknown> = { promptCacheTtl: '5m' }
    let env: Record<string, string> = {}
    on('settings.read', () => ({ value: settings }))
    on('env.get', (_, e) => ({ value: env[e.name] }))

    expect(await ttlOf($)).toBe('5m (promptCacheTtl setting)')
    settings = {}
    env = { ENABLE_PROMPT_CACHING_1H: '1' }
    expect(await ttlOf($)).toBe('1h (ENABLE_PROMPT_CACHING_1H)')
    env = {}
    expect(await ttlOf($)).toBe('1h (assumed)')
  })

  test('FORCE_PROMPT_CACHING_5M beats them all, and the option beats the engine', { options: { cacheTtl: '1h' } }, async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })

    expect(await ttlOf($)).toBe('1h (option)')
  })

  test('FORCE_PROMPT_CACHING_5M beats the env var and the setting', async ($, on) => {
    engine(on, TRIVIAL, [], 'live')
    mock.env(on, { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
    on('settings.read', () => ({ value: { promptCacheTtl: '1h' } }))

    expect(await ttlOf($)).toBe('5m (FORCE_PROMPT_CACHING_5M)')
  })

  test('/pignon says whether the cache is warm, cold or not yet written', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const calls = engine(on, TRIVIAL, [], 'live', { usage: BIG, now: NOON })
    on('session.compact', () => ({ messages: [KEPT], tokensAfter: 20_000 }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const status = async () => (await $.command.run({ command: 'pignon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''

    expect(await status()).toContain('context 0k · cache no request yet, ttl 5m (option)')
    await prompt($, 't1', 'rename foo')
    await calls.clock.advance(30_000)
    expect(await status()).toContain('context 151k · cache warm (last request 30 s ago), ttl 5m (option)')
    await calls.clock.advance(12 * 60_000 - 30_000)
    expect(await status()).toContain('cache cold (idle 12 min)')
    await $.session.compact({ trigger: 'manual', messages: [KEPT] })
    expect(await status()).toContain('context 20k · cache cold (compacted)')
  })
})

describe('policy: corrections', () => {
  test('a prompt that says the last answer was wrong, in English or French', async () => {
    for (const text of [
      'no, the other file',
      'nope, revert that',
      "no that's not it",
      'not that one, the parser',
      'wrong file',
      "that's wrong, use the v2 API",
      'That’s not what I asked',
      "it doesn't work",
      "doesn't work",
      'it still fails with the same error',
      'still broken',
      'you misunderstood: I meant the tests',
      'revert it',
      'undo the last change',
      "wait, that's wrong",
      'hmm no, the other one',
      'non, pas comme ça',
      'pas ça, l’autre fonction',
      "non mais c'est pas ça",
      "c'est faux",
      'ça marche pas',
      'ça ne marche toujours pas',
      'ça ne fonctionne plus',
      'toujours pas',
      'tu as mal compris',
      'annule ça',
    ]) {
      expect(isCorrection(text), text).toBe(true)
    }
  })

  test('a bare no, a no that agrees, and a task that opens with a negative word are not', async () => {
    for (const text of [
      '',
      'no',
      'No.',
      'non',
      "no, that's fine",
      'no thanks',
      'No, go ahead',
      'non, pas besoin',
      'no tests cover the parser, add some',
      'No problem. Now rename foo to bar',
      'nothing happens when I click save',
      'notify the user on failure',
      'wrongly typed fields in the form: fix them',
      'revert commit abc123 on main',
      'undo history for the editor: implement it',
      'annule la commande 42 dans la base',
      'ça marche, merci',
      'pastel colours for the theme',
      'yes, go ahead',
      'fix the failing test',
    ]) {
      expect(isCorrection(text), text).toBe(false)
    }
  })
})

describe('policy: what an outcome says of a verdict', () => {
  const turn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
    steps: 1,
    reason: 'answer',
    durationMs: 1_000,
    usage: { input: 1_000, output: 400, cacheRead: 0, cacheWrite: 0, model: OPUS },
    ...over,
  })
  const verdict = (tier: string, explore = false) => ({ tier, explore, confidence: 0.8 })

  test('a trivial verdict whose turn ran a long tool loop was too low', async () => {
    expect(verdictSignal(verdict('trivial'), turn({ steps: 8 }))).toBe('too low')
    expect(verdictSignal(verdict('trivial'), turn({ steps: 7 }))).toBe(null)
    // trivial/explore runs on standard: a long loop there says nothing
    expect(verdictSignal(verdict('trivial', true), turn({ steps: 12 }))).toBe(null)
  })

  test('a hard verdict whose turn answered in a request or two, briefly and quickly, was too high', async () => {
    expect(verdictSignal(verdict('hard'), turn())).toBe('too high')
    expect(verdictSignal(verdict('hard'), turn({ steps: 2 }))).toBe('too high')
    expect(verdictSignal(verdict('hard'), turn({ steps: 3 }))).toBe(null)
    expect(verdictSignal(verdict('hard'), turn({ usage: { input: 1, output: 1_500, cacheRead: 0, cacheWrite: 0, model: OPUS } }))).toBe(null)
    expect(verdictSignal(verdict('hard'), turn({ reason: 'aborted' }))).toBe(null)
    expect(verdictSignal(verdict('hard'), turn({ usage: undefined }))).toBe(null)
    // two requests over minutes: the work went to a subagent, which the main loop does not count
    expect(verdictSignal(verdict('hard'), turn({ steps: 2, durationMs: 180_000 }))).toBe(null)
  })

  test('says nothing of a standard verdict, a follow-up, or a turn still running', async () => {
    expect(verdictSignal(verdict('standard'), turn({ steps: 30 }))).toBe(null)
    expect(verdictSignal(verdict('standard'), turn())).toBe(null)
    expect(verdictSignal(verdict('same'), turn({ steps: 30 }))).toBe(null)
    expect(verdictSignal(verdict('trivial'), undefined)).toBe(null)
    expect(verdictSignal(null, turn({ steps: 30 }))).toBe(null)
  })
})

describe('policy: what a mark accepts', () => {
  test('relative to the tier the line named, or a tier by name', async () => {
    expect(acceptedTiers('ok', 'standard')).toEqual(['standard'])
    expect(acceptedTiers('low', 'trivial')).toEqual(['standard', 'hard'])
    expect(acceptedTiers('high', 'hard')).toEqual(['trivial', 'standard'])
    expect(acceptedTiers('hard', 'trivial')).toEqual(['hard'])
    expect(acceptedTiers('trivial', null)).toEqual(['trivial'])
  })

  test('nothing above the top, below the bottom, without a reference, or for an unknown word', async () => {
    expect(acceptedTiers('low', 'hard')).toBe(null)
    expect(acceptedTiers('high', 'trivial')).toBe(null)
    expect(acceptedTiers('ok', null)).toBe(null)
    expect(acceptedTiers('meh', 'standard')).toBe(null)
    expect(acceptedTiers('toString', 'standard')).toBe(null)
  })
})

describe('policy: the hybrid judge', () => {
  const say = (tier: string, confidence = 0.8, explore = false) => ({ tier, explore, confidence })

  test("laya's verdict stands when it keeps the tier or moves up, whatever Haiku says", async () => {
    expect(hybridDecision(say('hard', 0.6), say('trivial'), 'hard')).toEqual(say('hard', 0.6))
    expect(hybridDecision(say('hard', 0.6), null, 'trivial')).toEqual(say('hard', 0.6))
    expect(hybridDecision(say('standard', 0.7), say('trivial'), 'trivial')).toEqual(say('standard', 0.7))
  })

  test('a downgrade goes no lower than the more capable of the two verdicts', async () => {
    expect(hybridDecision(say('trivial', 0.9), say('trivial'), 'hard')).toEqual(say('trivial', 0.9))
    expect(hybridDecision(say('trivial', 0.9), say('standard'), 'hard')).toEqual(say('standard', 0.9))
    expect(hybridDecision(say('standard', 0.9), say('hard'), 'hard')).toEqual(say('hard', 0.9))
    // Haiku saying trivial but explore runs on standard
    expect(hybridDecision(say('trivial', 0.9), say('trivial', 0.8, true), 'hard')).toEqual(say('standard', 0.9))
  })

  test('a downgrade Haiku contests by asking for more goes to what Haiku asked', async () => {
    expect(hybridDecision(say('trivial', 0.9), say('hard'), 'standard')).toEqual(say('hard', 0.9))
  })

  test('no downgrade without an answer from Haiku', async () => {
    expect(hybridDecision(say('trivial', 0.9), null, 'hard')).toEqual(say('hard', 0.9))
  })

  test("laya's verdict on a model of no tier, and nothing without laya's verdict", async () => {
    expect(hybridDecision(say('trivial', 0.9), say('hard'), null)).toEqual(say('trivial', 0.9))
    expect(hybridDecision(null, say('hard'), 'hard')).toBe(null)
    expect(hybridDecision(say('same', 1), say('hard'), 'hard')).toBe(null)
  })
})

describe('the decision log: judging the judges', () => {
  const ended = (steps: number, output = 400): TurnOutcome => ({
    steps,
    reason: 'answer',
    durationMs: 1_000,
    usage: { input: 1_000, output, cacheRead: 0, cacheWrite: 0, model: OPUS },
  })
  const opinion = (tier: string, confidence = 0.8) => ({ tier, explore: false, confidence })

  test('a record keeps the oracle once it has answered, the correction and the mark', async () => {
    const mark = { said: 'low', of: 'trivial', accepted: ['standard', 'hard'] }
    const done = recordOf(entry({ oracle: { decision: opinion('hard'), ms: 2_000, cost: 0.004 }, corrected: true, mark }), CONTEXT)
    expect(done).toMatchObject({ oracle: { decision: opinion('hard'), ms: 2_000, cost: 0.004 }, corrected: true, mark })

    const pending = recordOf(entry({ oracle: { decision: null, ms: 0, isPending: true } }), CONTEXT)
    expect(pending.oracle).toBeUndefined()
    expect(pending.corrected).toBeUndefined()
    expect(pending.mark).toBeUndefined()
  })

  test('scores each judge where a tally can say something, then by its confidence', async () => {
    // In shadow mode on Opus, every turn ran on hard.
    const records = [
      // laya trivial and the turn looped: too low; you marked trivial too low; haiku and opus said standard
      recordOf(
        entry({
          id: 1,
          decision: opinion('trivial', 0.9),
          second: { decision: opinion('standard'), ms: 600 },
          oracle: { decision: opinion('standard'), ms: 2_000, cost: 0.01 },
          turn: ended(9),
          mark: { said: 'low', of: 'trivial', accepted: ['standard', 'hard'] },
        }),
        CONTEXT,
      ),
      // laya hard, one short request: too high; the next prompt corrected it; opus said hard too, haiku trivial
      recordOf(
        entry({ id: 2, decision: opinion('hard', 0.6), second: { decision: opinion('trivial'), ms: 600 }, oracle: { decision: opinion('hard'), ms: 2_000, cost: 0.01 }, turn: ended(1), corrected: true }),
        CONTEXT,
      ),
      // laya standard, you said ok; no oracle
      recordOf(entry({ id: 3, decision: opinion('standard', 0.75), second: { decision: opinion('standard'), ms: 600 }, turn: ended(4), mark: { said: 'ok', of: 'standard', accepted: ['standard'] } }), CONTEXT),
    ]

    const text = summarize(records, 1)

    expect(text).toContain('judges, scored on outcomes, your marks and the oracle:')
    // a standard verdict counts in neither flag: each is out of the verdicts it can flag
    expect(text).toContain('laya   3 verdicts · too low 100% of 1 trivial · too high 100% of 1 hard · corrected 100% of 1 that ran · right 50% of 2 marked · same as opus 50% of 2')
    expect(text).toContain('haiku  3 verdicts · too low 0% of 1 trivial · right 100% of 2 marked · same as opus 50% of 2')
    expect(text).toContain('opus   2 verdicts · too high 100% of 1 hard · corrected 100% of 1 that ran · right 100% of 1 marked')
    expect(text).toMatch(/0\.50 to 0\.70\s+too high 100% of 1 hard · corrected 100% of 1 that ran · same as opus 100% of 1/)
    expect(text).toMatch(/0\.70 to 0\.85\s+right 100% of 1 marked/)
    expect(text).toMatch(/p ≥ 0\.85\s+too low 100% of 1 trivial · right 0% of 1 marked · same as opus 0% of 1/)
    expect(text).toContain('oracle: opus asked 2 times, $0.020 at list price')
  })

  test('simulates the hybrid wherever laya decided and Haiku answered beside it, and scores it like the others', async () => {
    // shadow mode on Opus: the tier in force is hard
    const both = (id: number, laya: string, haiku: string | null, oracle?: string) =>
      recordOf(
        entry({
          id,
          decision: opinion(laya, 0.9),
          second: haiku === null ? undefined : { decision: opinion(haiku), ms: 600 },
          ...(oracle && { oracle: { decision: opinion(oracle), ms: 1 } }),
        }),
        CONTEXT,
      )
    const records = [
      both(1, 'trivial', 'trivial', 'trivial'), // confirmed: trivial
      both(2, 'trivial', 'standard', 'standard'), // Haiku holds it at standard
      both(3, 'hard', 'trivial', 'hard'), // no downgrade proposed: hard
      both(4, 'trivial', null), // Haiku not asked: no hybrid verdict
    ]

    const text = summarize(records, 1)

    expect(text).toContain('laya   4 verdicts · same as opus 67% of 3')
    expect(text).toContain('hybrid 3 verdicts · same as opus 100% of 3')
    expect(text).toContain('hybrid: simulated, not run')
  })

  test('the hybrid is measured against the tier that was in force, in live mode', async () => {
    // on trivial, laya's standard is an upgrade: laya's verdict stands, though Haiku said trivial
    const record = recordOf(
      entry({ mode: 'live', was: 'trivial', decision: opinion('standard', 0.7), second: { decision: opinion('trivial'), ms: 1 }, oracle: { decision: opinion('standard'), ms: 1 } }),
      CONTEXT,
    )

    expect(summarize([record], 1)).toContain('hybrid 1 verdict · same as opus 100% of 1')
  })

  test("splits the local model's agreement with opus by whether it read the whole prompt", async () => {
    const records = [
      recordOf(entry({ id: 1, decision: opinion('trivial'), oracle: { decision: opinion('trivial'), ms: 1 } }), CONTEXT),
      recordOf(entry({ id: 2, decision: opinion('trivial'), oracle: { decision: opinion('hard'), ms: 1 }, promptChars: 1_200 }), CONTEXT),
    ]

    expect(summarize(records, 1)).toContain('laya   2 verdicts · same as opus 50% of 2 (100% of 1 within its 400 characters)')
  })

  test('counts corrections by the tier the turn ran on: the session model in shadow mode', async () => {
    const records = [
      recordOf(entry({ id: 1, turn: ended(3), corrected: true, mode: 'live' }), CONTEXT),
      recordOf(entry({ id: 2, turn: ended(3), mode: 'live' }), CONTEXT),
      recordOf(entry({ id: 3, turn: ended(3), corrected: true }), CONTEXT),
      recordOf(entry({ id: 4, turn: ended(3) }), CONTEXT),
      recordOf(entry({ id: 5, turn: ended(3) }), CONTEXT),
    ]

    expect(summarize(records, 1)).toContain('corrected, by the tier the turn ran on: 1 of 2 on trivial (50%) · 1 of 3 on hard (33%)')
  })

  test('leaves out the line by tier when nothing was corrected', async () => {
    expect(summarize([recordOf(entry({ turn: ended(3) }), CONTEXT)], 1)).not.toContain('corrected, by the tier')
  })
})

describe('in a session: corrections, marks and the oracle', () => {
  const opus = (tier: string) => `{"tier":"${tier}","explore":false,"confidence":0.9}`
  // Haiku answers `haiku`; Opus answers `oracle`.
  function judges(on: On, mode: string, oracle = 'hard', haiku = TRIVIAL) {
    return engine(on, async asked => (asked.model === 'opus' ? opus(oracle) : haiku), [], mode)
  }
  const ORACLE = { options: { oracle: 'on' } }
  const command = async ($: Engine, args: string) => (await $.command.run({ command: 'pignon', args, ...COMMAND })).text ?? ''

  test('the oracle is Opus, asked once the turn has ended, so it never competes with it', ORACLE, async ($, on) => {
    const calls = judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })

    await prompt($, 't1', 'rename foo to bar')
    await settle()
    expect(calls.asked.map(a => a.model)).toEqual(['haiku'])
    expect((await ui.find({ type: 'Text', text: /^opus/ }))?.text).toBe('opus: asked when the turn ends')

    await complete($, 't1')
    await settle()
    expect(calls.asked.map(a => `${a.model}/${a.effort}`)).toEqual(['haiku/low', 'opus/medium'])
    expect((await ui.find({ type: 'Text', text: /^opus/ }))?.text).toBe('opus differs: hard p=0.90 · 0 ms')
    await ui.unmount()
  })

  test('the oracle is not asked in live mode, nor for an acknowledgement', ORACLE, async ($, on) => {
    const calls = judges(on, 'live')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo to bar')
    await complete($, 't1')
    await command($, 'shadow')
    await prompt($, 't2', 'yes, go ahead')
    await complete($, 't2')
    await settle()

    expect(calls.asked.map(a => a.model)).toEqual(['haiku'])
  })

  test('is off by default', async ($, on) => {
    const calls = judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo to bar')
    await complete($, 't1')
    await settle()

    expect(calls.asked.map(a => a.model)).toEqual(['haiku'])
    expect(await command($, '')).toContain('oracle: off')
  })

  test('/pignon says when the oracle answers are lost because the log is off', ORACLE, async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect(await command($, '')).toContain('oracle: on (Opus judges each prompt once its turn ends); the log is off, so its answers are lost when the session ends')
  })

  test('/pignon compare scores each judge as the stats do, this session', { options: { oracle: 'on', decider: 'laya' } }, async ($, on) => {
    judges(on, 'shadow', 'trivial')
    withDaemon(on, () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ tiers: { trivial: 0.2, standard: 0.7, hard: 0.1 } }) }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await settle()

    await prompt($, 't1', 'rename foo to bar')
    await complete($, 't1')
    await settle()
    await command($, 'mark trivial')
    const text = await command($, 'compare')

    // laya said standard, haiku and opus trivial, and you named trivial
    expect(text).toContain('Judges this session:')
    expect(text).toContain('laya   right 0% of 1 marked · same as opus 0% of 1')
    expect(text).toContain('haiku  too low 0% of 1 trivial · right 100% of 1 marked · same as opus 100% of 1')
    expect(text).toContain('opus   too low 0% of 1 trivial · right 100% of 1 marked')
  })

  test('a correction marks the turn before it as suspect, in the log and the pane', async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo to bar')
    await prompt($, 't2', 'no, the other foo')
    await prompt($, 't3', 'now add a test')
    await settle()

    const log = await command($, 'log')
    expect(log.match(/the next prompt was a correction/g)).toHaveLength(1)
    expect(log).toMatch(/rename foo to bar”\n {4}the next prompt was a correction/)
    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /correction/ }))?.props.color).toBe('warning')
    await ui.unmount()
  })

  test('a correction after a prompt that was not routed marks nothing older', async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo to bar')
    await command($, 'off')
    await prompt($, 't2', 'add a test for the parser') // not routed: no entry
    await command($, 'shadow')
    await prompt($, 't3', "that's wrong")
    await settle()

    expect(await command($, 'log')).not.toContain('correction')
  })

  test('/pignon mark labels the newest judged prompt, past an acknowledgement, or one by its number', async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await prompt($, 't1', 'rename foo to bar')
    await prompt($, 't2', 'thanks')
    await prompt($, 't3', 'add a test for the parser')

    expect(await command($, 'mark low #0')).toBe(
      'Marked #0 “rename foo to bar” (haiku said trivial, would switch to trivial): the right tier is standard or hard. The decision log is off, so the mark counts in /pignon compare for this session only; turn the log on to count marks in /pignon stats.',
    )
    expect(await command($, 'log')).toContain('you marked trivial too low · the judge said trivial')
    expect(await command($, 'mark high 0')).toBe('Nothing is below trivial: mark it ok, or name the right tier.')
    expect(await command($, 'mark ok 1')).toBe('No judged prompt #1 in /pignon log.') // the acknowledgement
    expect(await command($, 'mark ok')).toContain('Marked #2 “add a test for the parser”')
    expect(await command($, 'log')).toContain('you marked trivial right · the judge was right')
  })

  test('in live mode a mark is taken against the tier that ran, not a verdict the bars set aside', async ($, on) => {
    judges(on, 'live', 'hard', '{"tier":"trivial","explore":false,"confidence":0.6}') // under the downgrade bar
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await prompt($, 't1', 'rename foo to bar')

    expect(await command($, 'mark ok')).toContain('(kept hard, haiku said trivial): the right tier is hard.')
    expect(await command($, 'log')).toContain('you marked hard right · the judge said trivial')
  })

  test('/pignon mark says how to use it, and when there is nothing to mark', async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect(await command($, 'mark ok')).toBe('Nothing to mark yet: no prompt has been judged in this session.')
    await prompt($, 't1', 'rename foo to bar')
    expect(await command($, 'mark')).toBe(
      "/pignon mark low|ok|high|trivial|standard|hard [#n]: too low, right, too high, or the tier it deserved; #n is a prompt's number in /pignon log. Without a number it labels the last judged prompt, #0 “rename foo to bar” (haiku said trivial, would switch to trivial).",
    )
    expect(await command($, 'mark meh')).toContain('/pignon mark low|ok|high')
    expect(await command($, 'log')).toMatch(/^#0 {4}would switch/)
  })

  test('the pane offers the marks that apply under the newest judged prompt, and a press marks it', async ($, on) => {
    judges(on, 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await prompt($, 't1', 'rename foo to bar')
    await prompt($, 't2', 'add a test for the parser')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...DECISIONS_PANE, surface })
      expect(await ui.find({ key: 'mark-low' })).toBeDefined()
      expect(await ui.find({ key: 'mark-ok' })).toBeDefined()
      expect(await ui.find({ key: 'mark-high' })).toBeUndefined() // nothing is below trivial
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    await ui.press({ key: 'mark-low' })
    await settle()

    expect((await ui.find({ type: 'Text', text: /marked/ }))?.text).toBe('you marked trivial too low · the judge said trivial')
    expect(await ui.find({ key: 'mark-low' })).toBeUndefined()
    expect(await command($, 'log')).toMatch(/add a test for the parser”\n {4}you marked trivial too low/)
    await ui.unmount()
  })

  test('a judge that gave no verdict is marked against the tier that ran', async ($, on) => {
    engine(on, 'no idea', [], 'shadow')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await prompt($, 't1', 'rename foo to bar')

    const ui = await $.ui.mount({ ...DECISIONS_PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'mark-low' })).toBeUndefined() // the session ran on Opus: nothing is above hard
    await ui.press({ key: 'mark-high' })
    await settle()

    expect((await ui.find({ type: 'Text', text: /marked/ }))?.text).toBe('you marked hard too high · the judge said nothing')
    await ui.unmount()
  })

  test('the oracle, the correction and the mark go on the records', { options: { oracle: 'on', record: 'on' } }, async ($, on) => {
    judges(on, 'shadow')
    const writes: string[] = []
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
    on('process.run', () => ({ value: OK }))
    on('session.cwd', () => ({ value: '/work/api' }))
    on('fs.write', (_, e) => {
      writes.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await prompt($, 't1', 'rename foo to bar')
    await complete($, 't1')
    await settle()
    await command($, 'mark hard')
    await prompt($, 't2', "that's wrong")
    await settle()

    const [first, second] = parseRecords(writes.at(-1) ?? '')
    expect(first).toMatchObject({
      corrected: true,
      mark: { said: 'hard', of: null, accepted: ['hard'] },
      oracle: { decision: { tier: 'hard', explore: false, confidence: 0.9 } },
    })
    expect(Math.round((first?.oracle?.cost ?? 0) * 1_000_000)).toBe(4 + 20) // a token in and out at Opus's price
    expect(second?.corrected).toBeUndefined()
  })
})
