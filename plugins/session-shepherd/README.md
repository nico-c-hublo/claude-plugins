# session-shepherd

A Claude Code mod that keeps a herdr workspace or a tmux session readable when you run several Claude Code sessions side by side:

- **Every session is named after its topic.** On your first message, Haiku suggests a short name; pick it, type your own, or skip. The name is set natively (the hook's `sessionTitle`), so nothing is typed into the pane.
- **A topic already worked on is not duplicated.** When another session carries the same name, the mod lists up to three of them: go to the live one (its pane is focused), resume a closed one in a new tab (a new window in tmux), or stay here under another name.
- **The tab is labelled.** In herdr, a single-tab workspace becomes `<directory> - <session name>`; in tmux, a window holding only the session takes its name.
- **Each session says where it stands.** After every finished turn, Haiku reads your request and the final reply and writes a three-line recap: *Done*, *Needs* (what the session waits on from you) and *Next*. It is drawn above the prompt, so switching back to a pane shows where you left it without scrolling, and a resumed session shows it again. In herdr, the *Needs* line (else *Done*) also goes to the agent sidebar, so you can pick the next session to visit without opening any. A new prompt clears the *Needs* line.

It runs entirely in the mod: no skill, no tokens spent by the main conversation, no permission prompts. Outside herdr and tmux (neither `HERDR_ENV` nor `TMUX` set) it does nothing, and a session that already has a name is left alone.

## Settings

In `/config`:

- `askAt`
  - `prompt` (default): ask on the first message, with a suggested name.
  - `start`: ask as soon as the session opens; "Name it from my first message" falls back to `prompt`.
- `recap` (default on): the per-turn recap. One small Haiku call per finished turn of the main conversation (subagents' turns are not recapped).

## Showing the recap in herdr's sidebar

The mod reports two pane tokens, `$shepherd_needs` and `$shepherd_done`. herdr shows them only where a sidebar row names them: add this to `~/.config/herdr/config.toml`, then run `herdr server reload-config`.

```toml
[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  [{ token = "$shepherd_needs", fg = "#df8e1d", bold = true }],
  [{ token = "$shepherd_done", dim = true }],
]
```

Only one of the two is set at a time, so each session takes two rows. Recaps are kept in `~/.claude/session-shepherd/recap/<session id>.json`.

## Install

At the prompt of a terminal session:

```
/plugin install session-shepherd --marketplace nico-c-hublo/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-shepherd --marketplace nico-c-hublo/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nico-c-hublo/claude-plugins`, then Add plugin.

## Requirements

- Claude Code with function-hook mods (built and tested on 2.1.311).
- herdr or tmux on the `PATH`, with sessions started inside it. Under tmux, `claude` must be on the tmux server's `PATH` to resume a session in a new window.
- `grep` on the `PATH` (used to find sessions by name in `~/.claude/projects`).

## How a live session is found

herdr knows which Claude session runs in which pane. tmux does not, so under tmux each session writes where it runs (socket, pane, Claude's pid) to `~/.claude/session-shepherd/live/<session id>.json` when it starts, and removes it when it ends. A session counts as live while that pane exists and that process runs.
