import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, On, ProcessSpawnRequest, TurnStepInput } from 'claude-code'

import type { DecisionRecord, LogEntry } from '../types'
import { decide, decisionFromTiers, isFollowUp, parseDecision } from '../hooks/policy'
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

// Stands for the engine beneath the mod: a decider that answers `reply`, and
// a model that records each request it is sent.
function engine(on: On, reply: string | (() => Promise<string>), sent: TurnStepInput[], mode = 'shadow') {
  const clock = mock.clock(on)
  const calls = { model: 0, clock }
  mock.store(on, { mode })
  on('command.register', () => ({ value: { command: 'pignon' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', async () => {
    calls.model++
    const text = typeof reply === 'string' ? reply : await reply()

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
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
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

    // Each Haiku-decided entry takes 5 rows; 11 rows hold a note and two of them.
    const props = { ...DECISIONS_PANE.props, scroll: { offset: 0, bodyRows: 11 } }
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
function sharedDaemon(on: On, init: { isUp: boolean; launchedPid?: number; launcherExit?: number; sockets?: string }) {
  const state = {
    isUp: init.isUp,
    pid: 4242,
    launches: [] as { argv: readonly string[]; cwd?: string; timeoutMs?: number }[],
    audits: [] as string[],
    sockets: init.sockets,
    decides: 0,
    fail: 0,
  }
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
  on('process.run', (_, e) => {
    if (e.argv[0] === '/usr/sbin/lsof') {
      state.audits.push(e.argv[3] ?? '')

      return { value: { exitCode: state.sockets ? 0 : 1, ...NO_OUTPUT, stdout: state.sockets ?? '' } }
    }
    state.launches.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    if ((init.launcherExit ?? 0) !== 0) return { value: { exitCode: init.launcherExit!, ...NO_OUTPUT, stdout: 'failed: RuntimeError\n' } }
    state.isUp = true
    state.pid = init.launchedPid ?? 5151

    return { value: { exitCode: 0, ...NO_OUTPUT, stdout: `ready ${state.pid}\n` } }
  })
  on('http.fetch', (_, e) => {
    if (!state.isUp) throw new Error('connection refused')
    if (e.url.endsWith('/health')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ status: 'ok', ready: true, pid: state.pid }) } }
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
    prompt: SECRET.slice(0, 80),
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
  mode: 'shadow' as const,
  chosen: 'laya' as const,
  daemon: 'shared' as const,
  promptChars: SECRET.length,
  was: null,
  model: OPUS,
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
  function disk(on: On, options: { failWrites?: boolean } = {}) {
    const seen = { writes: [] as { path: string; text: string }[], runs: [] as (readonly string[])[] }
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      seen.runs.push(e.argv)

      return { value: OK }
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: 'ready 4242\n' }
      await forever
      return { value: { code: 0, signal: null } }
    })
    on('http.fetch', () => ({ value: LAYA }))
    on('session.cwd', () => ({ value: '/work/api' }))
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

    expect(seen.runs).toContainEqual(['mkdir', '-p', '-m', '700', '/cfg/pignon/decisions'])
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

  test('removes logs older than 90 days when the session starts', RECORDING, async ($, on) => {
    engine(on, TRIVIAL, [], 'shadow')
    const seen = disk(on)

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
})
