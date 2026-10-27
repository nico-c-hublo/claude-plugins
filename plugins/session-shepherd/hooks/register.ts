import type { EngineInterface, Register } from 'claude-code'

// Keeps the herdr workspace readable: every session carries its topic as its name, a topic
// already worked on can be picked up again instead of duplicated, and a single-tab workspace
// is labelled `<directory> - <session name>`.

type $ = EngineInterface

type Match = {
  sessionId: string
  name: string
  cwd: string | undefined
  lastActive: number
  livePane: string | null
}

// Where the person ended up: this session under `name`, another session, or unnamed (null).
type Outcome = { name: string } | { moved: string } | null

const HEADER = 'Session'
const SKIP = 'Skip'
const STAY = 'Stay here'
const FROM_FIRST_MESSAGE = 'Name it from my first message'

// Names collide when they match case-insensitively once every run of non-alphanumerics becomes "-".
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')

const basename = (path: string | undefined) => path?.split('/').filter(Boolean).at(-1) ?? '?'

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / (24 * 60))}d ago`
}

const inHerdr = async ($: $) => (await $.env.get('HERDR_ENV')) === '1'

const herdr = async ($: $, ...args: string[]): Promise<any> => {
  const { exitCode, stdout } = await $.process.run(['herdr', ...args])
  if (exitCode !== 0) return null
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

// The sessions whose name collides with `name`, newest first. A session's name is the last
// custom-title in its transcript (what /rename, --name and a hook's sessionTitle write).
const findSessions = async ($: $, name: string, selfId: string): Promise<Match[]> => {
  const projects = `${await $.env.get('HOME')}/.claude/projects`
  const { stdout } = await $.process.run(['grep', '-r', '--include=*.jsonl', '"type":"custom-title"', projects])
  const titles = new Map<string, { name: string; sessionId: string }>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(':{')
    if (at === -1) continue
    try {
      const { customTitle, sessionId } = JSON.parse(line.slice(at + 1))
      titles.set(line.slice(0, at), { name: customTitle, sessionId })
    } catch {}
  }

  const wanted = normalize(name)
  const livePanes = new Map<string, string>(
    ((await herdr($, 'agent', 'list'))?.result?.agents ?? [])
      .filter((a: any) => a.agent_session?.value)
      .map((a: any) => [a.agent_session.value, a.pane_id]),
  )
  const matches: Match[] = []
  for (const [path, title] of titles) {
    if (title.sessionId === selfId || normalize(title.name) !== wanted) continue
    const cwd = (await $.process.run(['grep', '-m1', '-o', '"cwd":"[^"]*"', path])).stdout.trim()
    matches.push({
      ...title,
      cwd: cwd ? JSON.parse(`{${cwd}}`).cwd : undefined,
      lastActive: (await $.fs.stat(path)).mtimeMs,
      livePane: livePanes.get(title.sessionId) ?? null,
    })
  }
  return matches.sort((a, b) => b.lastActive - a.lastActive)
}

const hasTitle = async ($: $, transcriptPath: string) =>
  (await $.process.run(['grep', '-q', '"type":"custom-title"', transcriptPath])).exitCode === 0

// A short session name drawn from the first message, by Haiku; the first words when that fails.
const suggestName = async ($: $, message: string) => {
  const fallback = message.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 40)
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system:
        'Name a coding session after its topic in 2 to 5 words, in the language of the message. ' +
        'Answer with the name alone: no quotes, no trailing punctuation.',
      prompt: message.slice(0, 4000),
      maxTokens: 30,
    })
    if (!reply.isAnswered) return fallback
    const name = (reply.text.split('\n')[0] ?? '').replace(/^["'`]+|["'`.]+$/g, '').trim()
    return name && name.length <= 60 ? name : fallback
  } catch {
    return fallback
  }
}

// Asks a question whose free-text "Other" is a name; null when skipped or dismissed.
const askName = async ($: $, question: string, suggestion: string) => {
  try {
    const answer = (await $.ui.ask(question, { header: HEADER, options: [suggestion, SKIP] })).trim()
    return answer && answer !== SKIP ? answer : null
  } catch {
    return null
  }
}

const agentName = (name: string) =>
  ('s-' + name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).replace(/-+$/, '').slice(0, 32)

const goTo = async ($: $, match: Match): Promise<Outcome> => {
  if (match.livePane) {
    await herdr($, 'agent', 'focus', match.livePane)
    return { moved: `Moved to the live session "${match.name}". Re-send your message there; this tab can be closed.` }
  }
  const workspace = (await $.env.get('HERDR_WORKSPACE_ID')) ?? ''
  const tab = await herdr($, 'tab', 'create', '--workspace', workspace, '--cwd', match.cwd ?? '.', '--focus')
  const pane = tab?.result?.root_pane?.pane_id
  if (!pane) return null
  const base = agentName(match.name)
  for (let i = 1; i <= 5; i++) {
    const agent = i === 1 ? base : `${base.slice(0, 29)}-${i}`
    if (await herdr($, 'agent', 'start', agent, '--kind', 'claude', '--pane', pane, '--', '--resume', match.sessionId)) {
      return { moved: `Resumed "${match.name}" in a new tab. Re-send your message there; this tab can be closed.` }
    }
  }
  return null
}

// Settles a free name for this session, or moves the person to an existing session of that name.
const settleName = async ($: $, first: string | null, selfId: string): Promise<Outcome> => {
  let name = first
  while (name) {
    const matches = (await findSessions($, name, selfId)).slice(0, 3)
    if (matches.length === 0) return { name }
    const labels = matches.map(
      (m, i) =>
        `${m.livePane ? 'Go to live' : 'Resume'} "${m.name}" · ${basename(m.cwd)} · ${ago(m.lastActive)}` +
        (i > 0 ? ` (${i + 1})` : ''),
    )
    let answer: string
    try {
      answer = await $.ui.ask(
        `A session named "${name}" already exists. Go back to it, or stay in this new session?`,
        { header: HEADER, options: [...labels, STAY] },
      )
    } catch {
      return null
    }
    const picked = matches[labels.indexOf(answer)]
    if (picked) return goTo($, picked)
    name =
      answer === STAY
        ? await askName($, `"${name}" is taken. What should this session be called instead?`, `${name} 2`)
        : answer.trim() || null
  }
  return null
}

const labelWorkspace = async ($: $, name: string, cwd: string) => {
  const workspace = await $.env.get('HERDR_WORKSPACE_ID')
  if (!workspace) return
  const info = await herdr($, 'workspace', 'get', workspace)
  if (info?.result?.workspace?.tab_count !== 1) return
  await herdr($, 'workspace', 'rename', workspace, `${basename(cwd)} - ${name}`)
}

export const register: Register = (on, options) => {
  // Set once this session was offered a name, so later prompts pass straight through.
  let isSettled = false

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (options.askAt !== 'start' || e.source !== 'startup' || !(await inHerdr($))) return result
    isSettled = true
    const answer = await askName(
      $,
      'What is the main topic of this session? It becomes the session name.',
      FROM_FIRST_MESSAGE,
    )
    if (answer === FROM_FIRST_MESSAGE) {
      isSettled = false
      return result
    }
    const outcome = await settleName($, answer, e.session_id)
    if (outcome && 'moved' in outcome) $.ui.toast(outcome.moved)
    if (!outcome || !('name' in outcome)) return result
    await labelWorkspace($, outcome.name, e.cwd)
    return { ...result, sessionTitle: outcome.name }
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (isSettled || !(await inHerdr($))) return next(e)
    isSettled = true
    if (await hasTitle($, e.transcript_path)) return next(e)
    const outcome = await settleName($, await askName(
      $,
      'What is the main topic of this session? It becomes the session name.',
      await suggestName($, e.prompt),
    ), e.session_id)
    if (outcome && 'moved' in outcome) return { block: outcome.moved }
    const result = await next(e)
    if (!outcome) return result
    await labelWorkspace($, outcome.name, e.cwd)
    return { ...result, sessionTitle: outcome.name }
  }).catch(($, e, next) => next(e))
}
