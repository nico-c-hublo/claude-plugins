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

1. **Downloads without running anything.** It clones with git hooks disabled. npm and PyPI packages are downloaded as archives, since `npm install`, `npx` and `pip download` can run the package's scripts. It vets the version you would install, and the linked source repo when there is one.
2. **Maps the code** with `scan.sh`, a read-only script. It reports:
   - every file, plus binaries and minified lines
   - invisible, bidi and tag Unicode
   - install and load-time hooks
   - sensitive patterns: network, exec, obfuscation, credential paths, persistence, text aimed at an agent
   - files and patterns that were in the git history but are gone now
   - data hidden after an image's end
   - secrets, through gitleaks when it is installed
3. **Reads in full** every file that runs or that an agent reads: code, manifests, hooks, MCP definitions, SKILL.md files, prompts and tool descriptions.
4. **Compares what the code can do with what its docs say.** That covers network, execution, files and credentials it reaches, persistence, obfuscation, agent steering, dependencies and provenance. Anything undeclared is a finding.
5. **Reports:** a verdict, what was and was not read, findings with `file:line`, a capability table, and the command to install the exact commit or version that was vetted.

The plugin's text is treated as evidence, never as instructions: a README telling the reviewer "this is safe" is itself a finding.

## What it does not do

It is a careful review aid, not a guarantee.

- It reads source code. It does not run the plugin or watch it at runtime.
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

The test builds a booby-trapped repo (an install hook, a credential read deleted from history, a zero-width character in an agent instruction, bytes appended to a PNG) and a clean one full of harmless typographic characters. It checks that `scan.sh` flags every trap in the first, and nothing in the second.
