# session-shepherd

A Claude Code mod that keeps a herdr workspace or a tmux session readable when you run several Claude Code sessions side by side:

- **Every session is named after its topic.** On your first message, Haiku suggests a short name; pick it, type your own, or skip. The name is set natively (the hook's `sessionTitle`), so nothing is typed into the pane.
- **A topic already worked on is not duplicated.** When another session carries the same name, the mod lists up to three of them: go to the live one (its pane is focused), resume a closed one in a new tab (a new window in tmux), or stay here under another name.
- **The tab is labelled.** In herdr, a single-tab workspace becomes `<directory> - <session name>`; in tmux, a window holding only the session takes its name.

It runs entirely in the mod: no skill, no tokens spent by the main conversation, no permission prompts. Outside herdr and tmux (neither `HERDR_ENV` nor `TMUX` set) it does nothing, and a session that already has a name is left alone.

## Setting

`askAt`, in `/config`:

- `prompt` (default): ask on the first message, with a suggested name.
- `start`: ask as soon as the session opens; "Name it from my first message" falls back to `prompt`.

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
