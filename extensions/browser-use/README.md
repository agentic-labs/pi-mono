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

The extension exposes multiple `browser_*` tools and blocks all non-browser tools for the session.

Start a new session with `browser_open`:

```json
{ "url": "https://example.com" }
```

Then use the other `browser_*` tools against that session.

## Tools

- page/session: `browser_open`, `browser_goto`, `browser_close`
- page interaction: `browser_click`, `browser_type`, `browser_fill`, `browser_select`, `browser_check`, `browser_uncheck`, `browser_hover`, `browser_drag`, `browser_upload`
- inspection and capture: `browser_snapshot`, `browser_screenshot`, `browser_pdf`
- navigation and tabs: `browser_navigation`, `browser_tabs`
- keyboard and mouse: `browser_keyboard`, `browser_mouse`
