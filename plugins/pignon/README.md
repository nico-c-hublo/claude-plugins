# pignon

A Claude Code mod that shifts to the right model for each prompt, the way a bike changes sprocket (*pignon*), so you don't spend all day on Opus at high effort. The routing policy descends from [pi-pignon](https://github.com/nico-c-hublo/pi-pignon).

- **A small decider judges each prompt.** On the first model request of a turn, Haiku (low effort) answers how hard the task is, whether it needs exploring the codebase, and how sure it is. Bare acknowledgements ("yes", "go ahead", "vas-y") keep the current tier without asking anyone. Or the judge is [a model on your Mac](#a-local-decider): then the prompt goes to Claude only.
- **Your session runs on the tier's model and effort.** Every main-loop request of the turn is sent with that tier's model and effort, tool steps included. Subagents keep their own settings.
- **Switching is cache-aware.** Upgrades need confidence ≥ 0.5; downgrades need ≥ 0.85 (≥ 0.7 for the local model, whose probabilities are lower and calibrated) and a 2-prompt cooldown. A change of model or of effort drops the prompt cache, so past 60k tokens of context a downgrade is refused, and past 100k an upgrade is too. When the cache is gone anyway, after a compaction or an idle gap longer than its lifetime, the guards and the cooldown are lifted for the next prompt (see [below](#when-the-cache-is-cold)).
- **It says what routing saves.** When a turn ends, its requests, its duration and its cost at list price go on its decision, against what the session model would have charged, and `/pignon stats` sums them with the turns where the tier fell short (see [below](#what-routing-costs-and-saves)).

| Tier | Model / effort | For |
| --- | --- | --- |
| trivial | haiku / low | mechanical edits, renames, single lookups (moves up to standard when it must explore) |
| standard | sonnet / medium | localized changes, routine features and tests, explaining code |
| hard | opus / high | multi-step investigations, unclear bugs, cross-cutting design |

The table and thresholds live in [`hooks/policy.ts`](hooks/policy.ts).

## Commands

| Command | What it does |
| --- | --- |
| `/pignon` | Mode, decider (and whether the local model runs), tier in force, context size and whether the cache is warm, this session's spend and savings, and the routing table |
| `/pignon shadow` | Decide and show, without switching (the default) |
| `/pignon live` | Apply the decisions |
| `/pignon off` | Stop routing |
| `/pignon unpin` | Route again after you picked a model with `/model` or `/effort` |
| `/pignon log` | The last decisions, numbered: who decided (`haiku`, `laya` or `rule`), confidence, latency and reason, and what the turn then did: steps, time, cost |
| `/pignon stats [days]` | Totals from the [decision log](#keeping-a-decision-log) across sessions and projects: agreement by confidence band and by project, latency, fallbacks, what was spent and saved, the turns where the tier fell short |
| `/pignon compare` | How often the local model and Haiku would run the same tier, and the prompts where they differ (see below); then each judge's score this session, as `/pignon stats` gives it |
| `/pignon mark low\|ok\|high [#n]` | Your verdict on the last judged prompt, or on prompt `#n` of `/pignon log`: the tier its line named was too low, right, or too high; or name the tier it deserved (`/pignon mark standard`). See [Scoring the judges](#scoring-the-judges) |
| `/pignon watch` | Open a pane that shows each decision as it is made (see below) |
| `/pignon setup` | Build the local decider (see below) |

Each routed prompt leaves a dim line in the transcript, e.g. `pignon trivial p=0.95 · 412 ms  👁 would switch to trivial · haiku/low (downgrade opus -> trivial)`, and the status line shows the tier in force. The mode is kept across sessions.

Picking a model or effort by hand (`/model`, `/effort`) pins it: pignon pauses until `/pignon unpin`.

### When the cache is cold

The cache guard exists because a switch drops the cached prefix and the next request pays for all of the context again. Two moments make the guard moot, and pignon lifts it, and the cooldown, for the next prompt:

- **After a compaction.** The conversation was rewritten, so nothing of it is cached. The context size is reset to what the compaction left.
- **After an idle gap longer than the cache's lifetime.** Claude Code asks for a one-hour cache on a Claude subscription within its plan's usage, and a five-minute one on an API key, Bedrock, Vertex or Foundry, or once the subscription is in overage; `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting and `ENABLE_PROMPT_CACHING_1H` override that, in this order. A mod can read the overrides but not the login or the overage, and the engine may also keep a cache alive on its own, so by default (*Prompt cache lifetime*, the `cacheTtl` option, on `auto`) pignon takes the override when there is one and otherwise assumes **an hour**: calling the cache cold while it is warm costs a full re-cache of the context, calling it warm while it is cold only forgoes a free switch. On an API key with no override set, choose `5m` (in `/config`, or `"cacheTtl": "5m"` in the same `pluginConfigs` block as `decider`) to get the free switches back; `1h` forces the long lifetime.

The confidence bars still apply. A switch made this way says so in its reason (`upgrade trivial -> hard (cache cold)`), and `/pignon` shows the cache's state and the lifetime it goes by: `cache warm (last request 30 s ago), ttl 1h (assumed)`, `cold (idle 12 min)` or `cold (compacted)`.

## Install

At the prompt of a terminal session:

```
/plugin install pignon --marketplace nico-c-hublo/claude-plugins
```

Then watch a few decisions in shadow mode and run `/pignon live` when they look right.

## Watching the decisions

`/pignon watch` opens a pane beside the chat that draws each decision the moment it is made: the time, who decided (`laya`, `haiku` or `rule`), the start of the prompt as the decider read it (the local model reads the first 400 characters), the local model's probability for each tier, how long it took (the mod's clock and the daemon's own), what was done about it, and why. When the local model was chosen but Haiku decided, the pane says why: not running, timed out, an HTTP error, a dropped connection, or an unusable answer. When the turn ends, one more line says what it did: `3 steps · 12 s · $0.012 (session model $0.090)`, in yellow with `under-routed` when the tier fell short (see [below](#what-routing-costs-and-saves)).

Under the newest judged prompt the pane offers your verdict on the tier its line named: `1: too low  2: right  3: too high`, only the ones that apply (nothing is below trivial), numbered in order. Click one, or focus the pane (ctrl+x tab) and press its digit; it does what `/pignon mark` does. With the [oracle](#the-oracle-opus-as-the-reference) on, Opus's answer shows under the decider's once the turn has ended (`opus agrees: …`, `opus differs: …`), and a prompt that the next one corrected says so.

Colour carries the same information at a glance: the first line takes the decider's colour, each tier is green (trivial), yellow (standard) or red (hard) with the tier the local model leans to in bold and the others dimmed, Haiku's second opinion is green when it agrees and yellow when it differs, and the outcome is green for a switch, yellow for a would-switch in shadow mode, and dim for a kept tier. The colours are theme keys, so they follow your theme.

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

## Scoring the judges

Agreement says whether two judges see a prompt the same way, not whether either is right. Three sources of labels say that, from free to paid. `/pignon stats` puts them in one table per judge (`laya`, `haiku`, the simulated [`hybrid`](#the-hybrid-simulated), `opus`), and by the judge's confidence, which is what the confidence bars should be tuned on; `/pignon compare` gives the session's share.

- **Outcomes, free and weak.** Once a turn has ended, a trivial verdict is flagged **too low** when the turn ran 8 or more requests, and a hard verdict **too high** when the turn answered in one or two requests, under 1,500 output tokens (thinking included) and within a minute; the minute keeps out a turn that handed the work to a subagent, whose requests the main loop does not count. Each rate is out of the verdicts it can flag, too low out of the trivial ones and too high out of the hard ones, so a judge that says standard a lot gains nothing by it. It holds whichever model ran the turn, so shadow mode measures it too; in live mode it measures the judge and the tier's model together (a Haiku turn that loops is flagged whichever was at fault). A prompt that opens by saying the last answer was wrong (`no, the other file`, `that's not it`, `wait, it still fails`, `revert that`, `non mais`, `pas ça`, `ça marche pas`, …) marks the turn before it as **corrected**, if that turn was routed. A bare `no`, a `no, that's fine` and a `revert commit abc` do not count: the first two answer a question, the last is a task. A judge is charged with a correction only when its tier is the one the turn ran on: in shadow mode, where the session's model ran, that is a judge that agreed with it. The stats also count corrections by that tier, so trivial turns can be set against the rest.
- **Your marks, exact and few.** `/pignon mark low`, `ok` or `high` labels the last judged prompt (`/pignon mark low #12` an earlier one, by its number in `/pignon log`): the tier its line named, `switched to`, `would switch to` or `kept`, was too low, right, or too high. In live mode that is the tier that ran, so a mark speaks of the answer you got, and a verdict a confidence bar or the cache guard set aside is scored against it like any other judge's. `low` on trivial accepts standard and hard, so a judge that said either is scored right; name the tier (`/pignon mark standard`) to be exact. The pane's buttons do the same. A few dozen marks over a week are enough to tell a judge that is right four times in five from one that is right half the time, and whether its confidence means anything: a 0.9 should be right more often than a 0.6. Mark prompts as they come, the ordinary ones too, not only those that surprise you, or the score measures your surprise. Marks reach `/pignon stats` only with the [decision log](#keeping-a-decision-log) on, so turn it on first.
- **The oracle, paid.** See below.

The judges read the first 4,000 characters of the prompt and the tier in force, without the codebase or the conversation; the local model reads only the first 400. A wrong verdict may come from the input as much as from the judge, and the oracle tells the two apart: for the local model the stats also give its agreement on the prompts it read whole (`within its 400 characters`), where its input was Opus's.

### The hybrid, simulated

Laya answers in about 10 ms and Haiku in about half a second; a hybrid would keep most of laya's speed and ask Haiku only where a wrong verdict costs most. The rule: laya decides, and its verdict stands when it keeps the tier or moves up, since a wrong upgrade only costs money. A move below the tier in force needs Haiku, who can also say that the task must explore the codebase, which laya cannot. The move then goes no lower than the more capable of the two verdicts, and does not happen without Haiku's answer.

It is not a decider yet: the stats simulate it. Wherever laya decided and Haiku answered beside it (laya chosen, shadow mode), the `hybrid` line scores what it would have said, on the same outcomes, marks and oracle as the others. If it beats laya and comes close to Haiku, it is worth running; if laya alone does as well, it would only add latency. What the simulation cannot say is how often the hybrid would ask Haiku: in shadow mode the session's model stays in force, so on Opus nearly every verdict is a move down. Only a live hybrid would show that.

### The oracle: Opus as the reference

Set *Score the judges against Opus* to `on` (the `oracle` option, in `/config` or `"oracle": "on"` in the same `pluginConfigs` block as `decider`), with the decision log on, or its answers are lost when the session ends (`/pignon` says so). In shadow mode, Opus at medium effort is then also asked about each judged prompt, with the same system prompt and input as Haiku. It is asked once the turn has ended, so it never competes with the turn for time or rate limit, and nothing is switched. Its verdict goes on the entry and the record, and the stats say how often each judge picks Opus's tier, overall and by confidence. If Haiku agrees with Opus nine times in ten, Haiku is a fair judge of this input and better routing needs more input, not a better judge; if it agrees six times in ten, the judge is the weak part.

It is off by default: each call costs, at list price, about a cent for a typical prompt and at most about nine cents if Opus used its whole 4,096-token allowance, so a hundred prompts a day come to around a dollar. The stats show what it actually cost (`oracle: opus asked 40 times, $0.31 at list price`). It goes to Claude, like every other judge. Live mode and acknowledgements never ask it, and a turn that never ends (the session closed first) is not asked about.

## Keeping a decision log

`/pignon compare` and the pane only see the current session, and forget it when it ends. To judge the local model over days and across projects, set *Keep a decision log* to `on` (the `record` option, in `/config` or `"record": "on"` in the same `pluginConfigs` block as `decider`). It is off by default.

Each decision then adds one JSON line to a file for the session in `$CLAUDE_CONFIG_DIR/pignon/decisions/` (`~/.claude/pignon/decisions/` by default), a folder only you can enter. **No word of a prompt is kept**, only its length. A line holds:

- when, and the session's working directory;
- who was chosen in the settings and who answered (`laya`, `haiku` or `rule`), and how the local model ran (`session` or `shared`);
- the local model's probability for each tier, its decision and confidence;
- Haiku's opinion, in shadow mode, once it has answered;
- Opus's opinion and what it cost, when the [oracle](#the-oracle-opus-as-the-reference) is on;
- how long each took, the fallback cause when the local model was chosen but Haiku decided;
- what was done (kept, would switch, switched), the tier before and after, the policy's reason, the session's model and the context size;
- once the turn has ended, how many requests it made, why it ended, how long it took, the API's token counts and the model that answered, and the cost below;
- whether the next prompt was a correction, and your mark (what you said, the tier it was taken against, the tiers it accepts), when there is one.

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

judges, scored on outcomes, your marks and the oracle:
  laya   380 verdicts · too low 9% of 80 trivial · too high 21% of 60 hard · corrected 4% of 150 that ran · right 74% of 31 marked · same as opus 71% of 40 (80% of 25 within its 400 characters)
         p < 0.50      too low 20% of 10 trivial · too high 30% of 10 hard · right 40% of 5 marked · same as opus 50% of 4
         0.50 to 0.70  ...
         0.70 to 0.85  ...
         p ≥ 0.85      too low 4% of 25 trivial · too high 10% of 20 hard · right 83% of 6 marked · same as opus 78% of 9
  haiku  321 verdicts · too low 5% of 60 trivial · too high 25% of 70 hard · corrected 3% of 140 that ran · right 82% of 28 marked · same as opus 85% of 40
         ...
  hybrid 301 verdicts · too low 4% of 45 trivial · too high 21% of 60 hard · corrected 3% of 120 that ran · right 80% of 27 marked · same as opus 82% of 38
         ...
  opus    40 verdicts · too low 0% of 8 trivial · too high 10% of 10 hard · corrected 2% of 30 that ran · right 90% of 10 marked
  hybrid: simulated, not run: laya's verdict, except that a move below the tier in force needs Haiku and goes no lower than the more capable of the two
  too low: a trivial verdict whose turn ran 8+ steps · too high: a hard verdict whose turn answered in 2 requests or fewer, under 1,500 output tokens and 60 s · corrected: the next prompt said the answer was wrong
  oracle: opus asked 40 times, $0.31 at list price
corrected, by the tier the turn ran on: 6 of 60 on trivial (10%) · 3 of 90 on standard (3%) · 9 of 230 on hard (4%)

cost (estimated at list price): 180 turns priced
  live:   spent $4.12 · $11.30 on the session model · saved $7.18 (64%)
  shadow: would have saved $3.40 of $9.90
  by tier: trivial 60 turns $0.30 · standard 90 turns $2.10 · hard 30 turns $1.72
under-routed: 7 trivial turns ran 8+ steps · 2 switched turns ended in an error or a refusal
```

The confidence bands are what the bars are tuned against: if a judge stays right (by your marks, or by Opus) below its downgrade bar, the bar is too strict; if it is no more often right at 0.9 than at 0.6, its confidence carries no information and a bar on it is noise. "Agree" means the two judges would run the same tier; see [Scoring the judges](#scoring-the-judges) for what each judge line counts.

### What routing costs and saves

When a turn ends, its token counts are priced three ways on the same numbers: on the model that answered, on the session's own model, and on the tier's model. Live mode reports what was spent and what the session model would have charged; shadow mode, where the turn ran on the session model, reports what the tier would have cost. The prices are the Claude API's list prices for Haiku 5.5, Sonnet 5.5 and Opus 5.5 ([`hooks/prices.ts`](hooks/prices.ts)); a model with no price there (Fable) leaves the turn unpriced. These are estimates: a cheaper model may spend more tokens on the same task, and a managed account's own prices are not visible to a mod.

The savings are weighed against one quality signal, **under-routed** turns: a prompt judged `trivial` whose turn made 8 or more model requests (a trivial task does not loop that long, whichever model ran it), and a turn that was switched and ended in an error or a refusal. The watch pane and `/pignon log` flag them, and `/pignon stats` counts them. Read them with the savings: a routing that saves a third and under-routes one prompt in fifty is a different proposition from one that under-routes one in five.

Files are rewritten whole on each decision (the engine has no append, and two sessions sharing a file would lose lines), capped at 3,000 decisions each. A file older than 90 days is deleted when a session starts with the log on; delete the folder to clear everything. The file also holds your project paths, so mind it when sharing.

## Limits

- Each new prompt waits for one decision before the turn starts: a Haiku call (5 s timeout) or the local model (about 10 ms, 1.5 s timeout). On failure the current model stays.
- Haiku's confidence is its own estimate. The local model's is a probability, but it is soft (top probabilities of 0.5 to 0.85 on clear prompts), the 0.7 downgrade bar is provisional, and the claimed 87% routing accuracy could not be reproduced: the training data is private. Compare the two in shadow mode on your own prompts, and [score them](#scoring-the-judges).
- The outcome flags and corrections are heuristics: a trivial task can loop on a flaky test, a hard question can have a short answer, and a correction can open with words the pattern does not know. Read them as rates over many turns, beside your marks and the oracle, not as verdicts on one.
- The local model cannot say whether a task needs exploring the codebase, so a trivial prompt that does is not moved up to standard.
- By default one local daemon runs per session, about 1.3 to 1.5 GB each (930 MiB resident): ten open sessions cost ten copies. Choose the [shared daemon](#one-daemon-for-all-sessions) to run one copy for all of them.
- `/model` keeps showing the session's model; the routed one is in the status line and the log.
- The costs are estimates at list price (see [above](#what-routing-costs-and-saves)): a cheaper model may use more tokens, a managed account may pay other prices, and the cache write is priced at the 5-minute premium.
- Whether the cache is still warm after an idle gap is inferred, not observed: the engine reads the real lifetime back from each response and may renew the cache itself, and tells neither to a mod. The default assumes an hour, the safe side (see [above](#when-the-cache-is-cold)).

## Requirements

- Claude Code with function-hook mods (built and tested on 2.1.314).
- For the local decider: an Apple silicon Mac on macOS 14 or later, and `uv`.

## Tests

`claude plugin test plugins/pignon` runs the mod's tests against a mocked engine. The daemon's own tests are standard-library `unittest` (`cd daemon && python3 -m unittest discover -s tests -t .`); the opt-in smoke test against the real model is described at the top of `daemon/tests/test_smoke_mlx.py`. The mod has been started in a live session (setup and the daemon launch worked), but its routing decisions on real prompts have not been reviewed yet.
