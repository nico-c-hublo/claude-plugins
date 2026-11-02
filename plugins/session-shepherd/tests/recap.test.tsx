import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The recap in herdr, against a fake herdr and a fake Haiku: each finished turn becomes
// Done / Needs / Next, drawn above the prompt and reported to herdr's agent sidebar.

const HOME = '/home/u'
const IN_HERDR = { HOME, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_WORKSPACE_ID: 'w1' }
const RECAP_FILE = `${HOME}/.claude/session-shepherd/recap/self.json`

type World = { runs: string[][]; files: Map<string, string>; haiku: string | null }

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const setUp = (on: On, env: Record<string, string> = IN_HERDR): World => {
  const world: World = { runs: [], files: new Map(), haiku: null }
  mock.env(on, env)
  on('process.run', (_, e) => (world.runs.push([...e.argv]), ok('{}')))
  on('fs.write', (_, e) => (world.files.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.id', () => ({ value: 'self' }))
  on('model.complete', () => {
    if (world.haiku === null) throw new Error('offline')
    return { value: { isAnswered: true, text: world.haiku, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return world
}

const BAND = {
  plugin: 'session-shepherd',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const reports = (world: World) =>
  world.runs.filter((r) => r[0] === 'herdr' && r[2] === 'report-metadata').map((r) => r.filter((_, i) => i !== 7))

const turn = (answer: string) =>
  ({ answer, reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't1' }) as const

test('a finished turn is recapped above the prompt and in the herdr sidebar', async ($, on) => {
  const world = setUp(on)
  const clock = mock.clock(on, { now: 1_000 })
  world.haiku = '{"done": "Found the race in the login form", "needs": "Pick: debounce or lock", "next": "Write the fix and a test"}'

  await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'why does the login form lose its state?' })
  await $.turn.complete(turn('The form re-renders before the save lands. Debounce or lock?'))
  await clock.advance(0)

  expect(JSON.parse(world.files.get(RECAP_FILE)!)).toEqual({
    done: 'Found the race in the login form',
    needs: 'Pick: debounce or lock',
    next: 'Write the fix and a test',
    at: 1_000,
  })
  expect(reports(world).at(-1)).toEqual([
    'herdr', 'pane', 'report-metadata', 'w1:p2', '--source', 'session-shepherd', '--seq',
    '--token', 'shepherd_needs=Pick: debounce or lock', '--clear-token', 'shepherd_done',
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Needs/ }))?.text).toBe('Needs  Pick: debounce or lock')
    expect((await ui.find({ type: 'Text', text: /^Next/ }))?.text).toBe('Next   Write the fix and a test')
    await ui.unmount()
  }
})

test('without Haiku the reply\'s last question is what the session needs', async ($, on) => {
  const world = setUp(on)
  const clock = mock.clock(on)

  await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'tidy the README' })
  await $.turn.complete(turn('## Rewrote the install section\n\nShould I also drop the old badge?'))
  await clock.advance(0)

  const recap = JSON.parse(world.files.get(RECAP_FILE)!)
  expect(recap.done).toBe('Rewrote the install section')
  expect(recap.needs).toBe('Should I also drop the old badge?')
})

test('a new prompt clears the needs line, and a late recap of the older turn is dropped', async ($, on) => {
  const world = setUp(on)
  const clock = mock.clock(on)
  world.haiku = '{"done": "Listed the options", "needs": "Pick one", "next": ""}'

  await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'what are the options?' })
  await $.turn.complete(turn('A or B?'))
  await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'B' })
  await clock.advance(0)

  expect(world.files.has(RECAP_FILE)).toBe(false)
  expect(reports(world).at(-1)).toEqual([
    'herdr', 'pane', 'report-metadata', 'w1:p2', '--source', 'session-shepherd', '--seq',
    '--clear-token', 'shepherd_needs',
  ])
})

test('a resumed session shows its recap again, though not while a turn runs', async ($, on) => {
  const world = setUp(on)
  mock.clock(on)
  world.files.set(RECAP_FILE, JSON.stringify({ done: 'Did it', needs: '', next: '', at: 0 }))
  on('classic.SessionStart', () => ({}))
  // While a turn runs the band is left to the engine, which this hook stands for.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.classic.SessionStart({ source: 'resume', session_id: 'self' })
  expect(reports(world).at(-1)?.slice(7)).toEqual(['--clear-token', 'shepherd_needs', '--token', 'shepherd_done=Did it'])

  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await idle.find({ type: 'Text', text: /^Done/ }))?.text).toBe('Done   Did it')
  await idle.unmount()

  const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await working.find({ type: 'Text', text: /^Done/ })).toBeUndefined()
  await working.unmount()
})

test('outside herdr and tmux no recap is made', async ($, on) => {
  const world = setUp(on, { HOME })
  const clock = mock.clock(on)
  world.haiku = '{"done": "x", "needs": "y", "next": ""}'

  await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'hello' })
  await $.turn.complete(turn('Hi?'))
  await clock.advance(0)

  expect(world.runs).toEqual([])
  expect(world.files.size).toBe(0)
})
