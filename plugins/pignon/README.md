# pignon

A Claude Code mod that shifts to the right model for each prompt, the way a bike changes sprocket (*pignon*), so you don't spend all day on Opus at high effort. The routing policy descends from [pi-pignon](https://github.com/nico-c-hublo/pi-pignon).

- **A small decider judges each prompt.** On the first model request of a turn, Haiku (low effort) answers how hard the task is, whether it needs exploring the codebase, and how sure it is. Bare acknowledgements ("yes", "go ahead", "vas-y") keep the current tier without asking anyone. Or the judge is [a model on your Mac](#a-local-decider): then the prompt goes to Claude only.
- **Your session runs on the tier's model and effort.** Every main-loop request of the turn is sent with that tier's model and effort, tool steps included. Subagents keep their own settings.
- **Switching is cache-aware.** Upgrades need confidence ≥ 0.5; downgrades need ≥ 0.85 (≥ 0.7 for the local model, whose probabilities are lower and calibrated) and a 2-prompt cooldown. A model switch drops the prompt cache, so past 60k tokens of context only effort changes go through.

| Tier | Model / effort | For |
| --- | --- | --- |
| trivial | haiku / low | mechanical edits, renames, single lookups (moves up to standard when it must explore) |
| standard | sonnet / medium | localized changes, routine features and tests, explaining code |
| hard | opus / high | multi-step investigations, unclear bugs, cross-cutting design |

The table and thresholds live in [`hooks/policy.ts`](hooks/policy.ts).

## Commands

| Command | What it does |
| --- | --- |
| `/pignon` | Mode, decider (and whether the local model runs), tier in force, context size and the routing table |
| `/pignon shadow` | Decide and show, without switching (the default) |
| `/pignon live` | Apply the decisions |
| `/pignon off` | Stop routing |
| `/pignon unpin` | Route again after you picked a model with `/model` or `/effort` |
| `/pignon log` | The last decisions: who decided (`haiku`, `laya` or `rule`), confidence, latency and reason |
| `/pignon stats [days]` | Totals from the [decision log](#keeping-a-decision-log) across sessions and projects: agreement by confidence band and by project, latency, fallbacks |
| `/pignon compare` | How often the local model and Haiku would run the same tier, and the prompts where they differ (see below) |
| `/pignon watch` | Open a pane that shows each decision as it is made (see below) |
| `/pignon setup` | Build the local decider (see below) |

Each routed prompt leaves a dim line in the transcript, e.g. `pignon trivial p=0.95 · 412 ms  👁 would switch to trivial · haiku/low (downgrade opus -> trivial)`, and the status line shows the tier in force. The mode is kept across sessions.

Picking a model or effort by hand (`/model`, `/effort`) pins it: pignon pauses until `/pignon unpin`.

## Install

At the prompt of a terminal session:

```
/plugin install pignon --marketplace nico-c-hublo/claude-plugins
```

Then watch a few decisions in shadow mode and run `/pignon live` when they look right.

## Watching the decisions

`/pignon watch` opens a pane beside the chat that draws each decision the moment it is made: the time, who decided (`laya`, `haiku` or `rule`), the start of the prompt as the decider read it (the local model reads the first 400 characters), the local model's probability for each tier, how long it took (the mod's clock and the daemon's own), what was done about it, and why. When the local model was chosen but Haiku decided, the pane says why: not running, timed out, an HTTP error, a dropped connection, or an unusable answer.

The pane keeps the last 50 decisions in the session's memory (nothing is written to disk unless you turn on [the decision log](#keeping-a-decision-log)) and shows the newest ones that fit, noting how many older ones are hidden. It shows prompt text on your screen, no more than the transcript does, so mind it when sharing your screen. A pane opened by a command is placed at any width; if the surface cannot draw it, the command says why.

## Comparing the two judges

With `laya` chosen and the mode on `shadow` (the default), pignon also asks Haiku about every prompt the local model decided, in the background: the turn does not wait for it, and nothing is switched in shadow mode. The pane shows Haiku's answer under the local model's (`haiku agrees: …`, `haiku differs: …`, `haiku: no answer`, or `haiku: asking...` while it thinks). `/pignon compare` totals it:

```
2 compared: 1 agree (50%), 1 differ. Haiku gave no answer for 1.
Differences (laya → haiku):
  trivial → trivial/explore  “rename bar”
```

"Agree" means the two would run the same tier: a prompt Haiku says is trivial but must explore the codebase would run on standard, so it differs from a local model's plain trivial. With no ground truth, the disagreements are the data: read them and decide which judge was right, which is also how the 0.7 downgrade bar gets tuned.

The cost is one small Haiku call per decided prompt, in shadow mode only. Live mode asks the chosen judge alone, and acknowledgements and prompts Haiku already decided are not compared. The prompt goes to Claude either way, and nowhere else.

## A local decider

For work where a prompt must not go anywhere but to Claude, a small classifier ([laya-conductor](https://huggingface.co/mvilacad/laya-conductor), 421M parameters, Apache 2.0) can judge the prompts instead of Haiku. It runs on your Mac with MLX; about 10 ms per prompt. A copy of the model takes about 930 MiB resident, and macOS charges about 1.3 to 1.5 GB for it (Activity Monitor's figure). By default each session runs its own copy; [a shared daemon](#one-daemon-for-all-sessions) serves every session from one.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/).
2. Run `/pignon setup` once. It builds a Python 3.13 environment from [`daemon/requirements.lock`](daemon/requirements.lock) (every file hash-checked) and downloads the pinned model (about 850 MB, SHA-256 checked) into `$CLAUDE_CONFIG_DIR/pignon/` (`~/.claude/pignon/` by default). These are the only steps that use the network, and no prompt is involved. Running it again rebuilds the environment only when the lock changed (or the environment no longer runs); otherwise it keeps it, so a running decider is not pulled out from under the session.
3. Pick `laya` for *Who judges each prompt*: in `/config` (the pignon row), or in `settings.json`:

   ```json
   { "pluginConfigs": { "pignon": { "options": { "decider": "laya" } } } }
   ```

   The key is `pignon`, or `pignon@inline` under `--plugin-dir`. Then run `/pignon`: it should say `decider: laya (running)`. If it does not, restart the session. Run setup and the session under the same `CLAUDE_CONFIG_DIR`, since the environment and model live there.

What happens then: at session start the mod launches a small daemon (`daemon/pignon_decider/`) as a child process, bound to a Unix socket in a private (`0700`) directory; the mod reaches it over that socket, so there is no TCP port and no proxy in the path. The daemon runs offline (it drops Hub tokens and proxy variables and sets `HF_HUB_OFFLINE=1`), loads only the model whose hashes are pinned in [`checkpoint.py`](daemon/pignon_decider/checkpoint.py), and exits with the session. When it announces itself the mod runs `lsof` on it and stops it if it holds any network socket, or if that cannot be checked. Whenever the daemon is missing, slow (1.5 s), failing or stopped, Haiku decides.

What this does not do: no operating-system rule blocks the daemon's network access (`sandbox-exec` is deprecated), so the guarantee rests on the audit of `laya-mlx` 0.6.0, the stripped environment and the socket check. The compiled dependencies (`mlx`, `tokenizers`, `numpy`) were not audited.

### One daemon for all sessions

Set *How the local model runs* to `shared` (the `daemon` option, beside `decider` in `/config`, or `"daemon": "shared"` in the same `settings.json` block). The first session to need the model starts one daemon; every other session on the Mac uses it. It leaves by itself after 30 minutes without a prompt, so nothing keeps running when you stop working.

- **Started detached.** A child the mod spawns ends with the session, so a shared daemon starts itself through `process.run`: it double-forks, calls `setsid`, closes its standard streams and prints `ready PID` once the model answers (about a second with the model cached). Its errors go to `daemon.log` beside its socket, which holds class names only, never a prompt.
- **One socket, one lock.** The socket lives in `$CLAUDE_CONFIG_DIR/pignon/run-<hash of the mod folder>/`, a directory only you can enter (the daemon refuses one that is not yours or is open to others). A lock held for the daemon's life means two sessions starting at the same moment load the model once. A new version of the mod gets its own directory and daemon; the old one leaves when idle.
- **Checked by every session.** The first time a session reaches a given process, the mod runs `lsof` on the pid the daemon reports and does not use a process that holds a network socket, or whose sockets cannot be checked.
- **Idle means one slow prompt.** After the daemon has left, the next prompt finds no connection, Haiku decides that one, and the mod starts the daemon again in the background for the prompts after it.
- **What it changes in the guarantees above.** Several sessions share one process, and it outlives the one that started it. Prompts still reach only that process over its Unix socket, and the daemon keeps nothing of them. `pkill -f pignon_decider` stops it by hand.

## Keeping a decision log

`/pignon compare` and the pane only see the current session, and forget it when it ends. To judge the local model over days and across projects, set *Keep a decision log* to `on` (the `record` option, in `/config` or `"record": "on"` in the same `pluginConfigs` block as `decider`). It is off by default.

Each decision then adds one JSON line to a file for the session in `$CLAUDE_CONFIG_DIR/pignon/decisions/` (`~/.claude/pignon/decisions/` by default), a folder only you can enter. **No word of a prompt is kept**, only its length. A line holds:

- when, and the session's working directory;
- who was chosen in the settings and who answered (`laya`, `haiku` or `rule`), and how the local model ran (`session` or `shared`);
- the local model's probability for each tier, its decision and confidence;
- Haiku's opinion, in shadow mode, once it has answered;
- how long each took, the fallback cause when the local model was chosen but Haiku decided;
- what was done (kept, would switch, switched), the tier before and after, the policy's reason, the session's model and the context size.

`/pignon stats` sums the newest 200 session files (`/pignon stats 7` keeps the last 7 days). The numbers below only show the format:

```
412 decisions in 9 sessions, 2026-10-30 to 2026-11-12
decided by: laya 380 · haiku 20 · rule 12

laya vs haiku: 301 compared · 268 agree (89%) · 33 differ · haiku gave no answer for 14
  p < 0.50        52% agree (n=21)
  0.50 to 0.70    61% agree (n=41)
  0.70 to 0.85    88% agree (n=120)
  p ≥ 0.85        97% agree (n=119)
  differences (laya → haiku): trivial → standard 12 · standard → hard 9
  by project:
    work/api                        92% agree (n=120)
```

The confidence bands are what the 0.7 downgrade bar is tuned against: if agreement stays high below it, the bar is too strict. With no ground truth, "agree" means the two judges would run the same tier, and the disagreements are the data.

Files are rewritten whole on each decision (the engine has no append, and two sessions sharing a file would lose lines), capped at 3,000 decisions each. A file older than 90 days is deleted when a session starts with the log on; delete the folder to clear everything. The file also holds your project paths, so mind it when sharing.

## Limits

- Each new prompt waits for one decision before the turn starts: a Haiku call (5 s timeout) or the local model (about 10 ms, 1.5 s timeout). On failure the current model stays.
- Haiku's confidence is its own estimate. The local model's is a probability, but it is soft (top probabilities of 0.5 to 0.85 on clear prompts), the 0.7 downgrade bar is provisional, and the claimed 87% routing accuracy could not be reproduced: the training data is private. Compare the two in shadow mode on your own prompts.
- The local model cannot say whether a task needs exploring the codebase, so a trivial prompt that does is not moved up to standard.
- By default one local daemon runs per session, about 1.3 to 1.5 GB each (930 MiB resident): ten open sessions cost ten copies. Choose the [shared daemon](#one-daemon-for-all-sessions) to run one copy for all of them.
- `/model` keeps showing the session's model; the routed one is in the status line and the log.

## Requirements

- Claude Code with function-hook mods (built and tested on 2.1.314).
- For the local decider: an Apple silicon Mac on macOS 14 or later, and `uv`.

## Tests

`claude plugin test plugins/pignon` runs the mod's tests against a mocked engine. The daemon's own tests are standard-library `unittest` (`cd daemon && python3 -m unittest discover -s tests -t .`); the opt-in smoke test against the real model is described at the top of `daemon/tests/test_smoke_mlx.py`. The mod has been started in a live session (setup and the daemon launch worked), but its routing decisions on real prompts have not been reviewed yet.
