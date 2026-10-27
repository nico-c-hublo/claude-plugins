import type { $, Host } from './host'

// herdr knows which Claude session runs in which pane, so nothing is recorded for it.

const basename = (path: string | undefined) => path?.split('/').filter(Boolean).at(-1) ?? '?'

const agentName = (name: string) =>
  ('s-' + name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).replace(/-+$/, '').slice(0, 32)

export async function herdr($: $): Promise<Host | null> {
  if ((await $.env.get('HERDR_ENV')) !== '1') return null

  const run = async (...args: string[]): Promise<any> => {
    const { exitCode, stdout } = await $.process.run(['herdr', ...args])
    if (exitCode !== 0) return null
    try {
      return JSON.parse(stdout)
    } catch {
      return null
    }
  }

  // Listed once per host, however many sessions are looked up.
  let panes: Promise<Map<string, string>> | undefined
  const livePanes = () =>
    (panes ??= run('agent', 'list').then(
      (list) =>
        new Map<string, string>(
          (list?.result?.agents ?? [])
            .filter((a: any) => a.agent_session?.value)
            .map((a: any) => [a.agent_session.value, a.pane_id]),
        ),
    ))

  return {
    name: 'herdr',

    live: async (sessionId) => {
      const pane = (await livePanes()).get(sessionId)
      if (!pane) return null
      return { where: `herdr pane ${pane}`, focus: async () => (await run('agent', 'focus', pane)) !== null }
    },

    resume: async ({ sessionId, name, cwd }) => {
      const workspace = (await $.env.get('HERDR_WORKSPACE_ID')) ?? ''
      const tab = await run('tab', 'create', '--workspace', workspace, '--cwd', cwd ?? '.', '--focus')
      const pane = tab?.result?.root_pane?.pane_id
      if (!pane) return false
      const base = agentName(name)
      for (let i = 1; i <= 5; i++) {
        const agent = i === 1 ? base : `${base.slice(0, 29)}-${i}`
        if (await run('agent', 'start', agent, '--kind', 'claude', '--pane', pane, '--', '--resume', sessionId)) {
          return true
        }
      }
      return false
    },

    // A single-tab workspace is labelled `<directory> - <session name>`.
    label: async (name, cwd) => {
      const workspace = await $.env.get('HERDR_WORKSPACE_ID')
      if (!workspace) return
      const info = await run('workspace', 'get', workspace)
      if (info?.result?.workspace?.tab_count !== 1) return
      await run('workspace', 'rename', workspace, `${basename(cwd)} - ${name}`)
    },
  }
}
