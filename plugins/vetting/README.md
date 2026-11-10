# vetting

A Claude Code skill that vets third-party code before you install it: a plugin, extension, mod, agent skill, MCP server, npm or PyPI package, or any git repo. Plugins for young tools are often small, new and written by one person, and no scanner knows their APIs. This skill gives Claude a fixed procedure for reading one the way a careful reviewer would, and reporting what it can do.

```
/vetting:vet-plugin https://github.com/owner/repo [tag or commit]
/vetting:vet-plugin npm:some-mcp-server@1.2.3
/vetting:vet-plugin pypi:some-tool==0.4
/vetting:vet-plugin ./a/downloaded/plugin
```

Asking in plain words ("scan this repo for malware before I install it") triggers it too.

## Install

At the prompt of a terminal session:

```
/plugin install vetting --marketplace nico-c-hublo/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install vetting --marketplace nico-c-hublo/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nico-c-hublo/claude-plugins`, then Add plugin.

## What it does

1. **Downloads without running anything.** It clones with git hooks and LFS downloads disabled, outside your working directory so the target's `CLAUDE.md` is never loaded as instructions. npm and PyPI packages are downloaded as archives, since `npm install`, `npx` and `pip download` can run the package's scripts, and checked against the registry's hash. It vets the version you would install, and the linked source repo when there is one.
2. **Maps the code** with `scan.sh`, a read-only script. It covers every file on disk, including ignored and built files, and never runs git under the target's own config. It reports:
   - every file, plus binaries, minified lines, symlinks, and files whose extension doesn't match their content
   - invisible, bidi, tag, variation-selector and filler Unicode, and ANSI escapes
   - install and load-time hooks, including `` !`cmd` `` in skills, `allowed-tools`, `.pth` files, VS Code folder-open tasks, submodules, external marketplace sources, `.pnpmfile.cjs`, cargo runners and Python entry points
   - Claude Code settings: `env` blocks (`NODE_OPTIONS`, `ANTHROPIC_BASE_URL`), permission grants and modes, MCP auto-enable
   - dependency ranges, non-registry dependencies and extra package indexes
   - sensitive patterns: network, exec (JS, Python, Go, Rust, shell), obfuscation, credential paths, persistence, text aimed at an agent
   - archives inside the target and files too large to scan, which it lists because it did not read them
   - files and sensitive lines that were in the git history but are gone now
   - data hidden after the end of a PNG, JPEG, GIF or WebP, and scripts in SVGs
   - secrets, through gitleaks when it is installed

   The output is capped per section; the full, uncapped report is written to a work directory for Claude to read when a section is cut.
3. **Reads in full** every file that runs or that an agent reads: code, manifests, hooks, MCP definitions, SKILL.md files, prompts and tool descriptions.
4. **Compares what the code can do with what its docs say.** That covers network, execution, files and credentials it reaches, persistence, obfuscation, agent steering, where your prompts and transcripts can go, dependencies and provenance. Anything undeclared is a finding.
5. **Reports:** a verdict, what was and was not read, findings with `file:line`, a capability table, and the command to install the exact commit or version that was vetted.

The plugin's text is treated as evidence, never as instructions: a README telling the reviewer "this is safe" is itself a finding.

## What it does not do

It is a careful review aid, not a guarantee.

- It reads source code. It does not run the plugin or watch it at runtime, so code that only turns malicious at run time (a payload fetched later, a time bomb) can pass.
- `scan.sh` matches patterns. A determined author can write code that matches none of them; that is why Claude reads every executable and agent-consumed file in full.
- It does not analyze compiled binaries, and it reports packed or minified code as unreadable rather than decoding it.
- It lists dependencies but does not read the whole dependency tree. When `osv-scanner` or `uvx` is installed, it can check dependencies for known vulnerabilities and malicious packages.
- A verdict covers the vetted commit or version only. Vet again before you update.

## Optional tools

Each is used when present and skipped when not:

- `gitleaks` (`brew install gitleaks`): secrets in files and history.
- `osv-scanner` (`brew install osv-scanner`): dependencies with known vulnerabilities.
- `uvx`, to run GuardDog: heuristics for malicious npm and PyPI packages.
- `gh`: repo age and provenance.

`scan.sh` itself needs bash, git, `file`, perl and python3. It is tested on macOS and Debian.

## Tests

```
bash plugins/vetting/tests/scan.test.sh
```

The test builds booby-trapped repos and checks that `scan.sh` reports each trap in the section it belongs to:
- install hooks, a credential read deleted from history, agent-steering text with a zero-width character
- filenames that try to pass as options to perl or grep, or to forge a section header
- a `.git/config` and `.gitattributes` that run commands through fsmonitor, a diff driver or the pager
- lines hidden behind an SVG-namespace comment or a flood of harmless hits; variation selectors, fillers and ANSI escapes; NUL bytes, UTF-16 and fake images
- payloads smuggled past the emoji exemptions: tag characters behind a flag, a run of joiners between letters, a different variation selector after each arrow; bidi controls
- exec, network and steering written in forms a narrower pattern set misses: Go, Rust, `__import__`, a string-built `require`, raw IPs, Unicode escapes
- Claude Code settings with `env`, permission and MCP keys; `.pnpmfile.cjs`, cargo runners, entry points, extra indexes, `go.mod` replacements, `.lfsconfig`
- archives (one renamed to `.bin`) and a 100 MB sparse file
- a `.git/refs` symlinked to `/`, a symlinked directory and a FIFO inside it, and a `.mailmap` that renames authors
- `` !`cmd` `` in a skill, external marketplace sources, `.pth` files, VS Code tasks, submodules, symlinks out of the target
- ignored build output, and a plain directory inside another repo
- polyglots: a `.ttf` or `.gif` that starts with its format's signature but is really JavaScript
- NUL-byte and UTF-16 files deleted from history, and code planted inside a `.git` directory
- a FIFO or a symlinked directory standing where HEAD has a file (the scan must finish without reading it)
- data after a PNG (including data declared inside its end chunk), JPEG, GIF and WebP end, and an SVG with a script
- a work dir reused for a second target

It also checks that a clean repo triggers nothing: typographic characters, emoji ZWJ sequences, flags, Persian and Hindi joiners, CJK variation selectors, and ordinary `require`, `maxTokens` and `127.0.0.1` code.
