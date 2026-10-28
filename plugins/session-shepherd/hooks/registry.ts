import type { EngineInterface } from 'claude-code'

// Where each live session runs, for hosts that cannot say which session runs in which pane.
// One file per session, written when it starts (or after /clear or a resume) and removed when it
// ends; `pid` lets a lookup ignore a session that died without ending, its file left behind.

type $ = EngineInterface

export type Location = { host: string; server: string; pane: string; pid: number | null }

const isSafeId = (sessionId: string) => /^[\w-]+$/.test(sessionId)

async function file($: $, sessionId: string) {
  return `${await $.env.get('HOME')}/.claude/session-shepherd/live/${sessionId}.json`
}

export async function record($: $, sessionId: string, location: Location) {
  if (isSafeId(sessionId)) await $.fs.write(await file($, sessionId), JSON.stringify(location))
}

export async function forget($: $, sessionId: string) {
  if (isSafeId(sessionId)) await $.process.run(['rm', '-f', await file($, sessionId)])
}

export async function lookup($: $, sessionId: string): Promise<Location | null> {
  if (!isSafeId(sessionId)) return null
  try {
    return JSON.parse(await $.fs.read(await file($, sessionId)))
  } catch {
    return null
  }
}

// This Claude Code process: the parent of the shell it starts.
export async function selfPid($: $) {
  const pid = Number((await $.process.run(['sh', '-c', 'echo $PPID'])).stdout.trim())
  return Number.isInteger(pid) && pid > 1 ? pid : null
}

export async function isRunning($: $, pid: number | null) {
  return pid === null || (await $.process.run(['kill', '-0', String(pid)])).exitCode === 0
}
