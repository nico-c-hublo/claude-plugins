# herdr-organize

A Claude Code mod that keeps a herdr workspace readable when you run several Claude Code sessions side by side:

- **Every session is named after its topic.** On your first message, Haiku suggests a short name; pick it, type your own, or skip. The name is set natively (the hook's `sessionTitle`), so nothing is typed into the pane.
- **A topic already worked on is not duplicated.** When another session carries the same name, the mod lists up to three of them: go to the live one (its herdr pane is focused), resume a closed one in a new tab of the workspace, or stay here under another name.
- **A single-tab workspace is labelled** `<directory> - <session name>`.

It runs entirely in the mod: no skill, no tokens spent by the main conversation, no permission prompts. Outside herdr (`HERDR_ENV` unset) it does nothing, and a session that already has a name is left alone.

## Setting

`askAt`, in `/config`:

- `prompt` (default): ask on the first message, with a suggested name.
- `start`: ask as soon as the session opens; "Name it from my first message" falls back to `prompt`.

## Install

At the prompt of a terminal session:

```
/plugin install herdr-organize --marketplace nico-c-hublo/herdr-organize
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install herdr-organize --marketplace nico-c-hublo/herdr-organize
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nico-c-hublo/herdr-organize`, then Add plugin.

## Requirements

- Claude Code with function-hook mods (built and tested on 2.1.311).
- herdr on the `PATH`, with sessions started inside it.
- `grep` on the `PATH` (used to find sessions by name in `~/.claude/projects`).
