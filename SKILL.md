---
name: web-access
description: End-to-end web research and browser automation through Codex web tools, curl, and a local Chrome CDP proxy. Use when Codex needs to search the web, inspect or extract webpage content, access dynamic or authenticated sites, operate a real browser tab, reuse site-specific patterns, capture media, or coordinate parallel browser research across independent targets when the user explicitly asks for delegation or parallel work.
metadata:
  author: eze-is
  version: "2.4.1-codex"
---

# Web Access for Codex

Use this skill as a Codex-native port of the upstream `eze-is/web-access` repository.
Preserve the upstream behavior and decision logic, but adapt the execution model to Codex:

- Codex reads `SKILL.md` first.
- Codex does not auto-run bundled `.mjs` files.
- Run bundled scripts explicitly through the shell when the workflow calls for them.

## Required startup for CDP work

Before any real-browser task, run:

```bash
node ~/.codex/skills/web-access/scripts/check-deps.mjs
```

Use the script output as the source of truth.

- If it prints `proxy: ready`, proceed with CDP calls.
- If it says Chrome is not connected, fix Chrome remote debugging first.
- If it says the proxy is connecting, wait for it to report ready before issuing browser actions.

Keep using the user's real Chrome instance whenever possible so existing login state remains available.

## Automation risk notice

Before automating social or authenticated platforms, state this warning plainly:

`Some sites detect browser automation aggressively. Account restrictions are still possible even with safeguards. Continuing means accepting that risk.`

## Tool routing in Codex

Choose the lightest tool that can reliably reach the goal.

| Situation | Use |
|---|---|
| Public discovery, current information, search result exploration | Codex `web` search/open |
| Known URL, mostly static page, raw HTML or JSON-LD needed | shell `curl` |
| Article-like pages where markdown conversion saves tokens | Jina or other text reduction layer if helpful |
| Dynamic rendering, anti-bot barriers, login state, uploads, real clicks, scrolling, screenshots | local CDP proxy |

Do not default to CDP when simpler tools can prove the answer.
Do not stay on static tools after repeated failure against a dynamic or protected site.

## Browser philosophy

Operate toward the goal, not toward a fixed script.

1. Define success first.
2. Pick the shortest path that can actually reach the content.
3. Use every page result as evidence.
4. Change approach quickly when the current route is blocked.
5. Stop once the task is actually complete.

Treat the browser as a real environment, not as a screenshot machine.

## Recommended Codex workflow

### 1. Check for site-specific knowledge

Before doing CDP work for a known site, try to match existing site patterns:

```bash
node ~/.codex/skills/web-access/scripts/match-site.mjs "<task or domain>"
```

To list recorded site patterns:

```bash
node ~/.codex/skills/web-access/scripts/list-site-patterns.mjs
```

If a matching pattern exists, read it before browsing.

### 2. Use Codex web tools first when they are sufficient

For public pages:

- use Codex web search/open for discovery and verification
- prefer first-party sources over summaries
- move to `curl` when raw HTML or structured metadata matters

### 3. Enter CDP mode only when needed

Once CDP is required, interact with the proxy at `http://127.0.0.1:3456`.

Common flow:

```bash
curl -s "http://127.0.0.1:3456/targets"
curl -s "http://127.0.0.1:3456/new?url=https://example.com"
curl -s -X POST "http://127.0.0.1:3456/eval?target=ID" -d "document.title"
curl -s "http://127.0.0.1:3456/close?target=ID"
```

Read [references/cdp-api.md](./references/cdp-api.md) when you need endpoint details or extraction patterns.

## CDP operating rules

- Create your own background tab with `/new`; do not hijack existing user tabs unless the user explicitly asks.
- Use `/eval` as the main way to inspect DOM state, extract structured data, and perform targeted interactions.
- Use `/click` for straightforward DOM clicks.
- Use `/clickAt` when the page needs a real mouse gesture.
- Use `/setFiles` for file uploads.
- Use `/scroll` to trigger lazy loading before extracting image or media URLs.
- Use `/screenshot` when visual confirmation is genuinely necessary.
- Close only the tabs you created.
- Leave the proxy running after the task; avoid forcing the user to re-authorize Chrome.

## Login judgment

Do not ask for login preemptively.

1. Open the page.
2. Try to obtain the target content.
3. Only if the target content is unavailable and login would likely unblock it, ask the user to log in within Chrome.
4. After login, refresh and continue. Do not restart the proxy.

Phrase the login request concretely, for example:

`The target content is not accessible without login on <site>. Please log in in your Chrome window, then I will continue.`

## Media extraction

Prefer direct DOM extraction over screenshots.

- For images: extract `src`, `srcset`, or linked asset URLs through `/eval`.
- For videos: inspect the `<video>` element, jump to timestamps with `/eval`, then use `/screenshot` for frame capture when needed.
- Use full-page screenshots only when the content truly lives in layout or styling rather than in accessible DOM/media URLs.

## Parallel research in Codex

Use sub-agents only when the user explicitly asks for delegation or parallel work.

When parallelization is allowed:

- split only independent targets
- tell each sub-agent to use `$web-access`
- describe the goal, not the exact tool sequence
- let each sub-agent create and close its own tab through the shared proxy

Good delegation wording:

`Use $web-access to investigate this site and return the key findings plus source URLs.`

Avoid wording that over-constrains the method, such as "search X with tool Y first", unless the method is itself the point of the task.

## Site-pattern maintenance

Store durable, verified site knowledge in `references/site-patterns/<domain>.md`.
Write facts, not guesses.

Use this format:

```markdown
---
domain: example.com
aliases: [Example]
updated: 2026-04-05
---

## Platform traits
Verified facts about rendering, login, anti-bot behavior, and navigation.

## Effective patterns
Verified URL patterns, selectors, and working interaction strategies.

## Known traps
Verified failure modes and why they fail.
```

After a successful browser session that revealed reusable facts, update the relevant site-pattern file.

## Verification standard

Do not claim completion without evidence.

Validate with one or more of:

- proxy JSON output
- extracted DOM values
- navigation state from `/info`
- screenshots when necessary
- first-party source pages opened through Codex web tools

## References

- [references/cdp-api.md](./references/cdp-api.md): detailed CDP endpoints and examples
- `references/site-patterns/<domain>.md`: domain-specific knowledge
- [scripts/check-deps.mjs](./scripts/check-deps.mjs): environment check and proxy readiness
- [scripts/cdp-proxy.mjs](./scripts/cdp-proxy.mjs): local CDP proxy
- [scripts/match-site.mjs](./scripts/match-site.mjs): site-pattern matcher
- [scripts/list-site-patterns.mjs](./scripts/list-site-patterns.mjs): site-pattern inventory
