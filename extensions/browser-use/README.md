# browser-use

Minimal pi extension that enforces browser-only mode and routes `browser_*` tools through [`agent-browser`](https://github.com/vercel-labs/agent-browser).

## Requirements

Install `agent-browser` first:

```bash
npm install -g agent-browser
agent-browser install
```

The extension also works with `npx agent-browser`, but a global install is the simplest setup.

## Usage

```bash
pi -e ./extensions/browser-use/index.ts
```

The extension exposes multiple `browser_*` tools and blocks all non-browser tools for the session.

Start with `browser_goto`:

```json
{ "url": "https://example.com" }
```

Then call `browser_snapshot` to collect refs like `@e1`, and use those refs with the other browser tools.

## Tools

- navigation and session: `browser_goto`, `browser_navigation`, `browser_tabs`, `browser_close`
- page interaction: `browser_click`, `browser_type`, `browser_fill`, `browser_select`, `browser_check`, `browser_uncheck`, `browser_hover`, `browser_drag`, `browser_upload`, `browser_scroll`, `browser_wait`
- inspection and capture: `browser_snapshot`, `browser_screenshot`, `browser_pdf`
- keyboard and mouse: `browser_keyboard`, `browser_mouse`

## Notes

- `browser_snapshot` supports `interactive`, `urls`, `compact`, `depth`, and `selector`.
- `browser_screenshot` supports `annotate` and `full`.
- `browser_select` accepts either a single `value` or multiple `values`.
- `browser_upload` now targets a specific `ref` or selector and accepts `files`.
- Shared options expose agent-browser session and launch settings such as `session`, `sessionName`, `profile`, `provider`, `engine`, `cdp`, and `headers`.
