import type { EngineInterface } from 'claude-code'
import type { Location } from '../registry'

// What the mod needs from the multiplexer or terminal app the session runs in.

export type $ = EngineInterface

// A session running now, and how to bring its pane forward.
export type Live = { where: string; focus: () => Promise<boolean> }

export type Session = { sessionId: string; name: string; cwd: string | undefined }

export type Host = {
  name: string
  // This session's place, recorded so other sessions can find it; absent when the host itself
  // knows which session runs in which pane.
  locate?: () => Promise<Location | null>
  live: (sessionId: string) => Promise<Live | null>
  // Opens a tab beside this session running `claude --resume` on `session`.
  resume: (session: Session) => Promise<boolean>
  label: (name: string, cwd: string) => Promise<void>
}
