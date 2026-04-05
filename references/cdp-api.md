# CDP Proxy API

## Basics

- proxy base URL: `http://127.0.0.1:3456`
- start check: `node ~/.codex/skills/web-access/scripts/check-deps.mjs`
- direct proxy start: `node ~/.codex/skills/web-access/scripts/cdp-proxy.mjs`
- the proxy auto-discovers Chrome's debugging port and prefers the full `webSocketDebuggerUrl` from `/json/version`

## Endpoints

### Health

```bash
curl -s http://127.0.0.1:3456/health
```

Returns proxy health, connection state, and detected Chrome port.

### List tabs

```bash
curl -s http://127.0.0.1:3456/targets
```

### Create a background tab

```bash
curl -s "http://127.0.0.1:3456/new?url=https://example.com"
```

### Close a tab

```bash
curl -s "http://127.0.0.1:3456/close?target=TARGET_ID"
```

### Navigate

```bash
curl -s "http://127.0.0.1:3456/navigate?target=TARGET_ID&url=https://example.com"
```

### Go back

```bash
curl -s "http://127.0.0.1:3456/back?target=TARGET_ID"
```

### Page info

```bash
curl -s "http://127.0.0.1:3456/info?target=TARGET_ID"
```

### Evaluate JavaScript

```bash
curl -s -X POST "http://127.0.0.1:3456/eval?target=TARGET_ID" -d "document.title"
```

Use `/eval` to:

- inspect DOM state
- extract structured values
- control `<video>` elements
- trigger page-side interactions that are easier in JavaScript than raw CDP events

### DOM click

```bash
curl -s -X POST "http://127.0.0.1:3456/click?target=TARGET_ID" -d "button.submit"
```

### Real mouse click

```bash
curl -s -X POST "http://127.0.0.1:3456/clickAt?target=TARGET_ID" -d "button.upload"
```

Use `/clickAt` when the page requires a real mouse gesture or a file-picker trigger.

### Upload files

```bash
curl -s -X POST "http://127.0.0.1:3456/setFiles?target=TARGET_ID" \
  -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'
```

### Scroll

```bash
curl -s "http://127.0.0.1:3456/scroll?target=TARGET_ID&y=3000"
curl -s "http://127.0.0.1:3456/scroll?target=TARGET_ID&direction=bottom"
```

### Screenshot

```bash
curl -s "http://127.0.0.1:3456/screenshot?target=TARGET_ID&file=/tmp/shot.png"
```

## Extraction guidance

- Return serializable values from `/eval`; do not try to return raw DOM nodes.
- Use `JSON.stringify(...)` when returning larger nested data structures.
- Prefer extracting media URLs from DOM attributes before falling back to screenshots.
- Re-check the DOM after scrolling when lazy loading is involved.

## Common errors

| Error | Meaning | Action |
|---|---|---|
| `Chrome not connected` | Chrome debugging is unavailable | Run `check-deps.mjs` and fix Chrome debugging first |
| `attach failed` | target ID is stale or closed | Refresh `/targets` and retry |
| `CDP command timeout` | page is blocked or unresponsive | retry, inspect DOM state, or reduce the page action |
| proxy starts but fails to connect | Chrome port exists but the websocket path changed | ensure `/json/version` is reachable and restart the proxy |
