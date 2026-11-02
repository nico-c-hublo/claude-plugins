import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Recap } from '../types'
import { detectHost, type Host } from './hosts'
import { isSafeId } from './registry'

// After each finished turn, Haiku reads the person's request and the final reply and writes where
// the session stands: Done / Needs you / Next. The recap is drawn above the prompt, so switching
// back to a pane shows it at once, and the host shows the "needs you" line beside the session
// (herdr's agent sidebar), so the next session to visit is picked without opening any.

type $ = EngineInterface

const recapAtom = atom({ plugin: 'session-shepherd', key: 'recap' } as const, null)
const lastPromptAtom = atom({ plugin: 'session-shepherd', key: 'lastPrompt' } as const, '')

const LIMIT = 80

const clip = (text: unknown) =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, LIMIT) : ''

const SYSTEM =
  'You write the status line of a coding-agent session for a developer who runs several sessions ' +
  'in parallel and switches between them. From their last request and the agent\'s final reply, ' +
  'answer with one JSON object and nothing else: {"done": "...", "needs": "...", "next": "..."}.\n' +
  '- done: what the agent did or found this turn, at most 70 characters.\n' +
  '- needs: the decision, answer or action the agent waits for from the developer, as a short ' +
  'imperative ("Pick: rebase or merge", "Review the PR diff"); "" when it waits on nothing.\n' +
  '- next: what is left once unblocked, at most 70 characters; "" when the task is finished.\n' +
  'Write in the language of the reply. No markdown, no trailing period.'

// Without Haiku: the reply's first line, and its last question as what it waits on.
export const fallbackRecap = (answer: string): Omit<Recap, 'at'> => {
  const lines = answer
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+|\*\*/g, '').trim())
    .filter(Boolean)
  const question = lines.findLast((line) => line.endsWith('?'))
  return { done: clip(lines[0]), needs: clip(question), next: '' }
}

// The head and the tail of a long reply: the summary opens it, the question closes it.
const excerpt = (text: string, size: number) =>
  text.length <= size ? text : `${text.slice(0, size / 2)}\n[…]\n${text.slice(-size / 2)}`

export async function summarize($: $, prompt: string, answer: string): Promise<Omit<Recap, 'at'>> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `Developer's request:\n${excerpt(prompt, 2000)}\n\nAgent's final reply:\n${excerpt(answer, 6000)}`,
      maxTokens: 200,
    })
    if (!reply.isAnswered) return fallbackRecap(answer)
    const parsed = JSON.parse(reply.text.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
    const recap = { done: clip(parsed?.done), needs: clip(parsed?.needs), next: clip(parsed?.next) }
    return recap.done || recap.needs ? recap : fallbackRecap(answer)
  } catch {
    return fallbackRecap(answer)
  }
}

// Kept per session on disk, so a resumed session shows where it stood.
async function file($: $, sessionId: string) {
  return `${await $.env.get('HOME')}/.claude/session-shepherd/recap/${sessionId}.json`
}

async function save($: $, sessionId: string, recap: Recap) {
  if (isSafeId(sessionId)) await $.fs.write(await file($, sessionId), JSON.stringify(recap))
}

async function load($: $, sessionId: string): Promise<Recap | null> {
  if (!isSafeId(sessionId)) return null
  try {
    return JSON.parse(await $.fs.read(await file($, sessionId)))
  } catch {
    return null
  }
}

// The line the host shows beside the session: what it waits on, else what it did.
const sidebar = (recap: Recap | null) =>
  recap?.needs ? { needs: recap.needs, done: '' } : { needs: '', done: recap?.done ?? '' }

const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / (24 * 60))}d ago`
}

// Every start, /clear and resume included: the session's own recap, or none.
export async function restoreRecap($: $, host: Host, sessionId: string) {
  const recap = await load($, sessionId)
  await update($, recapAtom, () => recap)
  await host.report?.(sidebar(recap))
}

// Bumped by every prompt, so a recap of an older turn that lands late is dropped.
let generation = 0

async function refresh($: $, turn: number, answer: string) {
  const host = await detectHost($)
  if (!host) return
  const summary = await summarize($, await read($, lastPromptAtom), answer)
  if (turn !== generation) return
  const recap: Recap = { ...summary, at: await $.clock.now() }
  await update($, recapAtom, () => recap)
  await save($, await $.session.id(), recap)
  await host.report?.(sidebar(recap))
}

export function registerRecap(on: On) {
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    generation++
    await update($, lastPromptAtom, () => e.text.slice(0, 4000))
    // Answered: the session no longer waits on the person.
    await (await detectHost($))?.report?.({ needs: '' })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Summarized off the turn's path, so the prompt comes back at once.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer' || !e.answer.trim()) return result
    const turn = generation
    const answer = e.answer
    $.clock.after(0, () => void refresh($, turn, answer).catch(() => {}))
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const recap = await read($, recapAtom)
    if (!recap || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const line = (label: string, text: string, color?: 'warning') => (
      <Text key={label} wrap="truncate-end">
        <Text bold color={color} dimColor={!color}>
          {label.padEnd(7)}
        </Text>
        {text}
      </Text>
    )
    return (
      <Box flexDirection="column">
        <Text dimColor>Where this session stands · {ago(now - recap.at)}</Text>
        {[
          recap.done && line('Done', recap.done),
          recap.needs && line('Needs', recap.needs, 'warning'),
          recap.next && line('Next', recap.next),
        ].filter(Boolean)}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
