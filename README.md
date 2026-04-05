# web-access for Codex

This branch adds a Codex-native port of the upstream repository while preserving the existing browser-proxy workflow.

- upstream repository: `https://github.com/eze-is/web-access`
- Codex install path: `~/.codex/skills/web-access`

## What is preserved

- local Chrome CDP proxy
- authenticated browsing through the user's Chrome session
- site-pattern knowledge files
- browser-side extraction workflows
- parallel browser research guidance for independent targets

## Codex-specific changes

- `SKILL.md` is rewritten for Codex skill triggering and tool routing
- shell examples use `~/.codex/skills/web-access/...`
- the CDP proxy now resolves Chrome's full `webSocketDebuggerUrl` through `/json/version` when needed
- `agents/openai.yaml` is added for Codex UI metadata

## Start the proxy

```bash
node ~/.codex/skills/web-access/scripts/check-deps.mjs
```

## Key scripts

- `scripts/check-deps.mjs`
- `scripts/cdp-proxy.mjs`
- `scripts/match-site.mjs`
- `scripts/list-site-patterns.mjs`

## References

- `SKILL.md`
- `references/cdp-api.md`
- `references/site-patterns/`
