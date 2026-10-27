import { isRunning, lookup, selfPid } from '../registry'
import type { $, Host } from './host'

// tmux does not know which Claude session runs in a pane: each session records its pane at start
// (registry.ts), and a lookup checks that both the pane and the Claude process are still there.

export async function tmux($: $): Promise<Host | null> {
  const tmuxEnv = await $.env.get('TMUX')
  const pane = await $.env.get('TMUX_PANE')
  if (!tmuxEnv || !pane) return null
  // TMUX is `<socket>,<server pid>,<session index>`: the socket names the server.
  const server = tmuxEnv.split(',')[0]!

  const run = (args: string[], at = server) => $.process.run(['tmux', '-S', at, ...args])

  const hasPane = async (at: string, id: string) => {
    const { exitCode, stdout } = await run(['display-message', '-p', '-t', id, '#{pane_id}'], at)
    return exitCode === 0 && stdout.trim() === id
  }

  return {
    name: 'tmux',

    locate: async () => ({ host: 'tmux', server, pane, pid: await selfPid($) }),

    live: async (sessionId) => {
      const at = await lookup($, sessionId)
      if (at?.host !== 'tmux' || !(await isRunning($, at.pid)) || !(await hasPane(at.server, at.pane))) return null
      return {
        where: at.server === server ? `tmux pane ${at.pane}` : `tmux pane ${at.pane} (server ${at.server})`,
        // This client can only be switched to a pane of its own server.
        focus: async () =>
          at.server === server &&
          (await run(['switch-client', '-t', at.pane, ';', 'select-window', '-t', at.pane, ';', 'select-pane', '-t', at.pane]))
            .exitCode === 0,
      }
    },

    // A new window right after this one; the shell stays once Claude exits, as in any window.
    resume: async ({ sessionId, name, cwd }) => {
      if (!/^[\w-]+$/.test(sessionId)) return false
      const args = ['new-window', '-a', '-t', pane, '-n', name]
      if (cwd) args.push('-c', cwd)
      args.push(`claude --resume ${sessionId}; exec "\${SHELL:-sh}"`)
      return (await run(args)).exitCode === 0
    },

    // A window holding only this session is named after it (which also stops tmux renaming it).
    label: async (name) => {
      const { stdout } = await run(['display-message', '-p', '-t', pane, '#{window_panes}'])
      if (stdout.trim() !== '1') return
      await run(['rename-window', '-t', pane, name])
    },
  }
}
