# Files an agent reads: one regex, read by textscan.pl (Perl) and inspect.py (Python), so
# keep to syntax both accept. Matched against ./-prefixed paths. Everything under skills/
# and hooks/ counts: an agent reads a skill's supporting files on demand, and hooks run.
(^|/)(SKILL\.md|CLAUDE\.md|AGENTS\.md|GEMINI\.md|CONVENTIONS\.md|copilot-instructions\.md|\.cursorrules|\.windsurfrules|\.clinerules[^/]*|\.goosehints|(skills|commands|agents|output-styles|prompts|hooks|\.claude|\.claude-plugin|\.cursor|\.windsurf|\.clinerules|\.roo|\.kiro|\.amazonq|\.junie|\.github/instructions|\.github/prompts)/.+)$
