# browser-use

Minimal pi extension that enforces browser-only mode and exposes a single Playwright-backed `browser` tool.

The tool is text-only: it observes Chromium through the raw CDP accessibility tree, filters it into compact refs, and performs actions against those refs. It does not use screenshots, vision, or model-predicted screen coordinates.

## Requirements

Install dependencies from the repository root:

```bash
npm install
```

If Playwright has not installed Chromium yet, run:

```bash
npx playwright install chromium
```

## Usage

```bash
pi -e ./extensions/browser-use/index.ts
```

The extension exposes a single `browser` tool and blocks all non-browser tools for the session.

Start with a `goto` action:

```json
{
  "actions": [
    { "type": "goto", "url": "https://example.com" },
    { "type": "snapshot" }
  ]
}
```

Each result includes a fresh accessibility tree with refs like `e1`. Refs are regenerated after every call, so use only refs from the latest result.

## Tools

The `browser` tool accepts an `actions` array with 1 to 7 actions:

- `goto`: navigate to a URL.
- `snapshot`: observe only.
- `click`: click a ref from the latest accessibility tree.
- `fill`: replace text in an editable ref.
- `press`: press a keyboard key, optionally after focusing a ref.
- `scroll`: scroll the page or a scrollable ref.
- `wait`: wait for milliseconds or a Playwright load state.

## Notes

- Observations come from CDP `Accessibility.getFullAXTree`, not Playwright AI snapshots.
- Actions target refs, not CSS selectors, role/name locators, screenshots, or coordinates.
- Set top-level `headed: true` on the first call to show the Chromium window.
