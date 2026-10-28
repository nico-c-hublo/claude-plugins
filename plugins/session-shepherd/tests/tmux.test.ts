import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The mod in tmux, against a fake tmux, a fake transcript holding one session named "Fix login",
// and a fake file system for the live-session records.

const HOME = '/home/u'
const SERVER = '/tmp/tmux-501/default'
const RECORDS = `${HOME}/.claude/session-shepherd/live`
const TRANSCRIPT = `${HOME}/.claude/projects/app/abc.jsonl`

type World = { runs: string[][]; files: Map<string, string>; deadPids: Set<string> }

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const IN_TMUX = { HOME, TMUX: `${SERVER},123,0`, TMUX_PANE: '%5' }

const setUp = (on: On, answers: (question: string, labels: string[]) => string, env: Record<string, string> = IN_TMUX): World => {
  const world: World = { runs: [], files: new Map(), deadPids: new Set() }
  mock.env(on, env)
  // The engine's own part of each event, beneath the mod.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))

  on('process.run', (_, e) => {
    const argv = [...e.argv]
    world.runs.push(argv)
    const [cmd, ...args] = argv
    if (cmd === 'sh') return ok('4242\n')
    if (cmd === 'kill') return world.deadPids.has(args[1]!) ? fail() : ok()
    if (cmd === 'rm') return ok()
    if (cmd === 'grep' && args[0] === '-r') {
      return ok(`${TRANSCRIPT}:{"type":"custom-title","customTitle":"Fix login","sessionId":"abc"}\n`)
    }
    if (cmd === 'grep' && args[0] === '-m1') return ok('"cwd":"/work/app"\n')
    if (cmd === 'grep' && args[0] === '-q') return fail()
    if (cmd === 'tmux') {
      const sub = args.slice(2)
      if (sub[0] === 'display-message' && sub.at(-1) === '#{pane_id}') return ok(`${sub[3]}\n`)
      if (sub[0] === 'display-message' && sub.at(-1) === '#{window_panes}') return ok('1\n')
      return ok()
    }
    return fail()
  })
  on('fs.write', (_, e) => (world.files.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: Date.now(), isLink: false } }))
  // Haiku unreachable: the suggestion falls back to the prompt's first words.
  on('model.complete', () => {
    throw new Error('offline')
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const [q] = e.questions
    return { result: { questions: e.questions, answers: { [q!.question]: answers(q!.question, q!.options.map((o) => o.label)) } } }
  })
  return world
}

const tmuxRuns = (world: World) => world.runs.filter((r) => r[0] === 'tmux').map((r) => r.slice(3))

const prompt = { prompt: 'the login form loses its state', session_id: 'self', transcript_path: '/t/self.jsonl', cwd: '/work/app' }

test('a session records its tmux pane at start and forgets it at the end', async ($, on) => {
  const world = setUp(on, () => 'Skip')
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.classic.SessionStart({ source: 'startup', session_id: 'self' })
  expect(JSON.parse(world.files.get(`${RECORDS}/self.json`)!)).toEqual({ host: 'tmux', server: SERVER, pane: '%5', pid: 4242 })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'self', resume: { id: 'self' } })
  expect(world.runs).toContainEqual(['rm', '-f', `${RECORDS}/self.json`])
})

test('a free name becomes the session title and the window name', async ($, on) => {
  const world = setUp(on, () => 'Form state')
  const result = await $.classic.UserPromptSubmit(prompt)
  expect(result.sessionTitle).toBe('Form state')
  expect(tmuxRuns(world)).toContainEqual(['rename-window', '-t', '%5', 'Form state'])
})

test('a live session of the same name is focused, and the prompt held back', async ($, on) => {
  const world = setUp(on, (question, labels) => (question.startsWith('What') ? 'fix  LOGIN' : labels[0]!))
  world.files.set(`${RECORDS}/abc.json`, JSON.stringify({ host: 'tmux', server: SERVER, pane: '%3', pid: 4242 }))

  const result = await $.classic.UserPromptSubmit(prompt)
  expect(tmuxRuns(world)).toContainEqual(['switch-client', '-t', '%3', ';', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'])
  expect(result.block).toMatch(/Moved to the live session "Fix login"/)
})

test('a session whose Claude process is gone is resumed in a new window', async ($, on) => {
  let labels: string[] = []
  const world = setUp(on, (question, offered) => {
    if (question.startsWith('What')) return 'Fix login'
    labels = offered
    return offered[0]!
  })
  world.files.set(`${RECORDS}/abc.json`, JSON.stringify({ host: 'tmux', server: SERVER, pane: '%3', pid: 999 }))
  world.deadPids.add('999')

  const result = await $.classic.UserPromptSubmit(prompt)
  expect(labels[0]).toMatch(/^Resume "Fix login" · app · /)
  expect(tmuxRuns(world)).toContainEqual([
    'new-window', '-a', '-t', '%5', '-n', 'Fix login', '-c', '/work/app', 'claude --resume abc; exec "${SHELL:-sh}"',
  ])
  expect(result.block).toMatch(/Resumed "Fix login" in a new tab/)
})

test('outside herdr and tmux nothing happens', async ($, on) => {
  const world = setUp(on, () => 'Form state', { HOME })
  await $.classic.UserPromptSubmit(prompt)
  expect(world.runs).toEqual([])
})
