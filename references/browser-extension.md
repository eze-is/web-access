# Browser Extension Backend

`web-access` now includes an optional browser-extension backend for Chrome / Edge.
It is meant to avoid Chrome remote-debugging authorization prompts during normal
use.

## Model

- The extension is a Manifest V3 service worker under `extension/`.
- The local daemon is `scripts/webext-proxy.mjs`.
- The extension connects outward to `ws://127.0.0.1:3457/ext`.
- The daemon exposes a CDP-proxy-like HTTP API on `http://127.0.0.1:3457`.
- Browser control is performed through extension APIs, mainly `chrome.debugger`
  and `chrome.tabs`.

This follows the same broad architecture as OpenCLI's Browser Bridge: one-time
extension installation, then local daemon communication. It does not require
Chrome's `chrome://inspect/#remote-debugging` toggle.

## One-Time Setup

Start the daemon and check extension connectivity:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-webext.mjs"
```

If the extension is not connected, load it once:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select `${CLAUDE_SKILL_DIR}/extension`.
5. Re-run `node "${CLAUDE_SKILL_DIR}/scripts/check-webext.mjs"`.

After this one-time browser permission, future `web-access` browser operations
can use the extension backend without the remote-debugging authorization prompt.

## API

The extension backend mirrors the common CDP proxy endpoints:

```bash
curl -s http://127.0.0.1:3457/health
curl -s http://127.0.0.1:3457/targets
curl -s -X POST --data-raw 'https://example.com' http://127.0.0.1:3457/new
curl -s -X POST --data-raw 'https://example.com' "http://127.0.0.1:3457/navigate?target=ID"
curl -s -X POST "http://127.0.0.1:3457/eval?target=ID" -d 'document.title'
curl -s -X POST "http://127.0.0.1:3457/click?target=ID" -d 'button.submit'
curl -s -X POST "http://127.0.0.1:3457/clickAt?target=ID" -d 'button.upload'
curl -s -X POST "http://127.0.0.1:3457/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["C:\\path\\file.png"]}'
curl -s "http://127.0.0.1:3457/scroll?target=ID&direction=bottom"
curl -s "http://127.0.0.1:3457/screenshot?target=ID&file=C:\\temp\\shot.png"
curl -s "http://127.0.0.1:3457/close?target=ID"
```

For URL-carrying endpoints, use POST body. This avoids truncating URLs that
contain `?`, `&`, or `#`.

## Capability Notes

Extension backend supports the common web-access browser actions:

- create / navigate / close tabs
- evaluate JavaScript
- click by selector
- dispatch mouse clicks at element centers
- set files on file inputs
- scroll
- screenshot

It is not a complete replacement for raw CDP in every edge case. Keep CDP proxy
as fallback when the extension backend cannot attach to a tab, a page is not
debuggable, or a workflow needs an unsupported CDP method.

## Security Notes

- The daemon binds only to `127.0.0.1`.
- The extension connects only to `127.0.0.1:3457`.
- The daemon rejects HTTP requests with ordinary web page `Origin` headers and
  only accepts WebSocket bridge connections from extension origins such as
  `chrome-extension://...`.
- The extension asks for `debugger` permission, which is powerful. Install it
  only from this local skill directory you control.
- Do not expose the daemon port beyond localhost.
