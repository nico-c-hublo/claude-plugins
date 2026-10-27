import type { EngineInterface, Register } from 'claude-code'
import { detectHost, type Host, type Live } from './hosts'
import { forget, record } from './registry'

// Keeps a multiplexer (herdr, tmux) readable: every session carries its topic as its name, a
// topic already worked on can be picked up again instead of duplicated, and the tab or workspace
// holding only this session is labelled after it. What differs per multiplexer is in hosts/.

type $ = EngineInterface

type Match = {
  sessionId: string
  name: string
  cwd: string | undefined
  lastActive: number
  live: Live | null
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

// The sessions whose name collides with `name`, newest first. A session's name is the last
// custom-title in its transcript (what /rename, --name and a hook's sessionTitle write).
const findSessions = async ($: $, host: Host, name: string, selfId: string): Promise<Match[]> => {
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
  const matches: Match[] = []
  for (const [path, title] of titles) {
    if (title.sessionId === selfId || normalize(title.name) !== wanted) continue
    const cwd = (await $.process.run(['grep', '-m1', '-o', '"cwd":"[^"]*"', path])).stdout.trim()
    matches.push({
      ...title,
      cwd: cwd ? JSON.parse(`{${cwd}}`).cwd : undefined,
      lastActive: (await $.fs.stat(path)).mtimeMs,
      live: await host.live(title.sessionId),
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

const goTo = async (host: Host, match: Match): Promise<Outcome> => {
  if (match.live) {
    if (await match.live.focus()) {
      return { moved: `Moved to the live session "${match.name}". Re-send your message there; this tab can be closed.` }
    }
    return { moved: `"${match.name}" is still open in ${match.live.where}. Re-send your message there; this tab can be closed.` }
  }
  if (!(await host.resume(match))) return null
  return { moved: `Resumed "${match.name}" in a new tab. Re-send your message there; this tab can be closed.` }
}

// Settles a free name for this session, or moves the person to an existing session of that name.
const settleName = async ($: $, host: Host, first: string | null, selfId: string): Promise<Outcome> => {
  let name = first
  while (name) {
    const matches = (await findSessions($, host, name, selfId)).slice(0, 3)
    if (matches.length === 0) return { name }
    const labels = matches.map(
      (m, i) =>
        `${m.live ? 'Go to live' : 'Resume'} "${m.name}" · ${basename(m.cwd)} · ${ago(m.lastActive)}` +
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
    if (picked) return goTo(host, picked)
    name =
      answer === STAY
        ? await askName($, `"${name}" is taken. What should this session be called instead?`, `${name} 2`)
        : answer.trim() || null
  }
  return null
}

export const register: Register = (on, options) => {
  // Set once this session was offered a name, so later prompts pass straight through.
  let isSettled = false

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const host = await detectHost($)
    if (!host) return result
    // Every start, /clear and resume included: each runs under a session id of its own.
    const location = await host.locate?.()
    if (location) await record($, e.session_id, location)

    if (options.askAt !== 'start' || e.source !== 'startup') return result
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
    const outcome = await settleName($, host, answer, e.session_id)
    if (outcome && 'moved' in outcome) $.ui.toast(outcome.moved)
    if (!outcome || !('name' in outcome)) return result
    await host.label(outcome.name, e.cwd)
    return { ...result, sessionTitle: outcome.name }
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (isSettled) return next(e)
    const host = await detectHost($)
    if (!host) return next(e)
    isSettled = true
    if (await hasTitle($, e.transcript_path)) return next(e)
    const outcome = await settleName($, host, await askName(
      $,
      'What is the main topic of this session? It becomes the session name.',
      await suggestName($, e.prompt),
    ), e.session_id)
    if (outcome && 'moved' in outcome) return { block: outcome.moved }
    const result = await next(e)
    if (!outcome) return result
    await host.label(outcome.name, e.cwd)
    return { ...result, sessionTitle: outcome.name }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if ((await detectHost($))?.locate) await forget($, e.sessionId)
    return next(e)
  }).catch(($, e, next) => next(e))
}
