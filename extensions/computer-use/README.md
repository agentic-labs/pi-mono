# Computer Use Extension

Single-file pi extension for native computer-use workflows plus a lightweight Harbor installed-agent wrapper.

## Files

- `index.ts` - pi extension

## What it does

- Registers a `computer` tool that drives an isolated Linux/X11 desktop with:
  - `scrot`
  - `xdotool`
- Uses built-in `openai` with the local `computer` custom-tool harness
- Uses built-in `anthropic` with the same local `computer` custom-tool harness
- Forces computer-only mode by:
  - activating only the `computer` tool on session start
  - blocking non-`computer` tool calls at runtime

## Required environment

The extension expects an X11 display via `DISPLAY` or `PI_COMPUTER_USE_DISPLAY`.

Optional tuning:

- `PI_COMPUTER_USE_DISPLAY`
- `PI_COMPUTER_USE_DISPLAY_NUMBER`
- `PI_COMPUTER_USE_DISPLAY_WIDTH`
- `PI_COMPUTER_USE_DISPLAY_HEIGHT`
- `PI_COMPUTER_USE_ACTION_DELAY_MS`
- `PI_COMPUTER_USE_CLICK_DELAY_MS`
- `PI_COMPUTER_USE_TYPING_DELAY_MS`

## Local usage

OpenAI:

```bash
OPENAI_API_KEY=... \
DISPLAY=:99 \
pi --print --mode json --no-tools \
  -e ./extensions/computer-use/index.ts \
  --provider openai --model gpt-5.4 \
  "Open Firefox and take a screenshot."
```

Anthropic:

```bash
ANTHROPIC_API_KEY=... \
DISPLAY=:99 \
pi --print --mode json --no-tools \
  -e ./extensions/computer-use/index.ts \
  --provider anthropic --model claude-sonnet-4-6 \
  "Open Firefox and take a screenshot."
```

## Safety

Use only in an isolated VM or container. Linux only.