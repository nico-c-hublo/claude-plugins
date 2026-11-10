# Sensitive patterns for textscan.pl and history.pl: Perl regexes, matched case-insensitively.
# Each line is one alternative (lines are joined with |); blank lines and # lines are skipped.
# A hit is a lead to read, not a verdict.

# Network: URLs (minus the SVG/XML namespace URIs), clients, raw sockets, DNS, exfil hosts
https?://(?!www\.w3\.org/(?:2000/svg|1999/xlink|1999/xhtml|XML/1998/namespace|2000/xmlns/)(?![\w./?#%=&-]))
fetch\(|XMLHttpRequest|WebSocket|axios|requests\.(?:get|post|put|request|Session)|httpx|aiohttp|urllib|http\.client|\bsocket\b|net\.connect
(?:require\(|from)\s*["'](?:node:)?(?:https?|http2|net|dgram|dns|tls)["']
\bdns\.(?:resolve|lookup)|nslookup|\bdig \+|gethostbyname|getaddrinfo
\b(?!127\.|0\.0\.0\.0)\d{1,3}(?:\.\d{1,3}){3}\b
webhook\.site|discord(?:app)?\.com/api/webhooks|api\.telegram\.org|ngrok|pastebin|requestbin|pipedream|interact\.sh|\boast\.|burpcollaborator
\bcurl\b|\bwget\b|/dev/tcp|\bnc -

# Execution, in-process and through a shell, in JS, Python, Go, Rust and on Windows/macOS
child_process|execSync|spawnSync|subprocess|os\.system|os\.popen|\beval\(|new Function|Function\(|\bexec\(
exec\.Command|Command::new|process::Command
__import__|importlib|pickle\.loads?\b|marshal\.loads|\bctypes\b
require\((?!\s*["'][^"'+]*["']\s*\))|\bimport\((?!\s*["'][^"'+]*["']\s*\))
(?:globalThis|\bglobal|\bwindow|\bprocess)\s*\[
osascript|powershell|\bpwsh\b|Invoke-(?:WebRequest|RestMethod|Expression)|certutil|mshta|rundll32
\| *(?:ba)?sh\b|chmod \+x|!`[^`]+`

# Variables that load code into another process, or redirect the Claude API
NODE_OPTIONS|LD_PRELOAD|DYLD_[A-Z_]+|PYTHONSTARTUP|BASH_ENV|ANTHROPIC_(?:BASE_URL|AUTH_TOKEN|CUSTOM_HEADERS)|OTEL_EXPORTER
bypassPermissions|dangerously-?skip-?permissions|enableAllProjectMcpServers

# Obfuscation: encodings and escape runs
atob\(|btoa\(|fromCharCode|base64|(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u[0-9a-fA-F]{4}){4,}|(?:\\u\{[0-9a-fA-F]+\}){4,}

# Reach: credentials, secrets, the environment, the home directory, other tools' configs
\.ssh\b|id_rsa|\.aws\b|\.npmrc|\.netrc|\.kube|\.gnupg|\.docker/config|keychain|find-generic-password|cookies?\.sqlite|Login Data
process\.env|os\.environ|getenv|homedir|expanduser|Path\.home
(?-i:[A-Z_]TOKEN\b|[a-z]Token\b)|\btoken\b|secret|passw|api[_-]?key
\.claude(?:\.json|/settings)

# Persistence
crontab|LaunchAgents|LaunchDaemons|launchctl|systemd|\.bashrc|\.zshrc|\.profile

# Text aimed at an agent
ignore (?:all |any )?(?:previous|prior|above) instructions|do not (?:tell|inform|mention|show|reveal)|without (?:asking|telling|notifying)|\b(?:secretly|covertly)\b
(?:upload|send|post|exfiltrate|transmit|forward)\w*\s+(?:the\s+|all\s+|every\s+|its\s+|their\s+)?(?:repo(?:sitory)?|files?|codebase|conversation|transcript|history|secrets|credentials|keys|tokens|prompts?)\b
