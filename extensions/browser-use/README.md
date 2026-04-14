# browser-use

Minimal pi extension that enforces browser-only mode and routes a single `browser` tool through [`agent-browser`](https://github.com/vercel-labs/agent-browser).

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

The extension exposes a single `browser` tool and blocks all non-browser tools for the session.

Start with a `goto` step:

```json
{
  "steps": [
    { "type": "goto", "url": "https://example.com" },
    { "type": "snapshot", "interactive": true }
  ]
}
```

Use `snapshot` steps to collect refs like `@e1` when you need them, and batch short predictable flows into one call.

## Tools

The `browser` tool accepts a `steps` array. Supported step types are:

- navigation and session: `goto`, `navigation`, `tabs`, `close`
- page interaction: `click`, `type`, `fill`, `select`, `check`, `uncheck`, `hover`, `drag`, `upload`, `scroll`, `wait`
- inspection and capture: `snapshot`, `screenshot`, `pdf`
- keyboard and mouse: `keyboard`, `mouse`

## Notes

- `snapshot` supports `interactive`, `urls`, `compact`, `depth`, and `selector`.
- `screenshot` supports `annotate` and `full`.
- `select` accepts either a single `value` or multiple `values`.
- `upload` targets a specific `ref` or selector and accepts `files`.
- Shared options such as `session`, `sessionName`, `profile`, `provider`, `engine`, `cdp`, and `headers` live at the top level of the `browser` tool call and apply to every step in the sequence.
