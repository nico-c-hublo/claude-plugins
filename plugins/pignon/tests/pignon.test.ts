import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, On, ProcessSpawnRequest, TurnStepInput } from 'claude-code'

import { decide, decisionFromTiers, isFollowUp, parseDecision } from '../hooks/policy'

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
    let fetched = 0
    let isKilled = false
    const calls = engine(on, TRIVIAL, sent, 'live')
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
    on('process.run', (_, e) => {
      runs.push(e.argv)
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
    expect(isKilled).toBe(true)
    expect(fetched).toBe(0)
    expect(calls.model).toBe(1)
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

// Plays `/pignon setup` against a host whose commands `answer` as given.
async function setup($: Engine, on: On, answer: (argv: readonly string[]) => Partial<typeof OK>) {
  const runs: Run[] = []
  engine(on, TRIVIAL, [], 'shadow')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', TMPDIR: '/var/tmp' })
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

  return { runs, text }
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
    const { runs, text } = await setup($, on, () => ({}))

    const root = (runs[4]?.cwd ?? '').replace(/\/daemon$/, '')
    expect(runs.map(r => r.argv.join(' '))).toEqual([
      'uv --version',
      'mkdir -p /cfg/pignon',
      'uv venv --python 3.13 /cfg/pignon/venv',
      `uv pip install --python /cfg/pignon/venv/bin/python --require-hashes --no-deps -r ${root}/daemon/requirements.lock`,
      '/cfg/pignon/venv/bin/python -m pignon_decider.setup --dest /cfg/pignon/model',
    ])
    expect(runs[4]?.cwd).toBe(`${root}/daemon`)
    expect(runs.slice(2).every(r => (r.timeoutMs ?? 0) >= 300_000)).toBe(true)
    expect(text).toContain('ready')
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
