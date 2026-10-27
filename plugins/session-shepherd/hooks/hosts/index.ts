import { herdr } from './herdr'
import type { $, Host } from './host'
import { tmux } from './tmux'

export type { Host, Live } from './host'

// herdr first: it knows its agents, while tmux only knows panes. The environment cannot tell
// which of the two is nested in the other, as each inherits the other's variables.
export async function detectHost($: $): Promise<Host | null> {
  return (await herdr($)) ?? (await tmux($))
}
