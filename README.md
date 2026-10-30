# claude-plugins

Claude Code plugins (mods and skills) by nico-c-hublo, published as one marketplace. Each plugin lives in its own folder under `plugins/`, with a README of its own.

| Plugin | What it does |
| --- | --- |
| [session-shepherd](plugins/session-shepherd) | Names each session after its topic, offers to go back to a session of the same name, and labels the herdr workspace or tmux window. |
| [pignon](plugins/pignon) | Routes each prompt to the right Claude model and effort level (Haiku, Sonnet or Opus), with a cache-aware switching policy. |

## Install

At the prompt of a terminal session, with the plugin's name:

```
/plugin install <plugin> --marketplace nico-c-hublo/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Once the marketplace is added, `/plugin` lists every plugin in it.

From a shell:

```
claude plugin install <plugin> --marketplace nico-c-hublo/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nico-c-hublo/claude-plugins`, then Add plugin.

## Working on a plugin

Add your clone as a local marketplace once, and install from it:

```
claude plugin marketplace add <path to this clone>
claude plugin install <plugin>@nico-c
```

A plugin installed this way is read from the clone itself: edit it, run `/reload-plugins`, and the session runs the new code, with no reinstall or version bump.

Check a plugin from its folder:

```
claude plugin validate plugins/<plugin>
claude plugin test plugins/<plugin>
```
