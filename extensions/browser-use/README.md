# browser-use

Minimal pi extension that enforces browser-only mode and routes browser actions through [`playwright-cli`](https://playwright.dev/docs/getting-started-cli#core-commands).

## Requirements

Install Playwright CLI first:

```bash
npm install -g @playwright/cli@latest
```

## Usage

```bash
pi -e ./extensions/browser-use/index.ts
```

The extension exposes a single `browser` tool and blocks all non-browser tools for the session.

Tool calls use flat top-level arguments:

```json
{ "command": "goto", "url": "https://example.com" }
```

Do not nest command parameters under `args`.

## Supported commands

- page interaction: `open`, `goto`, `click`, `type`, `fill`, `select`, `check`, `uncheck`, `hover`, `drag`, `upload`, `close`
- inspection and capture: `snapshot`, `screenshot`, `pdf`
- navigation and tabs: `go-back`, `go-forward`, `reload`, `tab-list`, `tab-new`, `tab-select`, `tab-close`
- keyboard and mouse: `press`, `keydown`, `keyup`, `mousemove`, `mousedown`, `mouseup`, `mousewheel`
