# Computer Use Extension

Single-file pi extension for native computer-use workflows plus a lightweight Harbor installed-agent wrapper.

## Files

- `index.ts` - pi extension
- `../../integrations/harbor/pi_computer_use_agent.py` - Harbor installed-agent wrapper

## What it does

- Registers a `computer` tool that drives an isolated Linux/X11 desktop with:
  - `scrot`
  - `xdotool`
- Registers `openai-computer` for OpenAI native computer use
- Registers `anthropic-computer` while reusing pi's existing Anthropic provider path
- Forces computer-only mode by:
  - activating only the `computer` tool on session start
  - blocking non-`computer` tool calls at runtime

## Required environment

The extension expects:

- `PI_COMPUTER_USE_ENABLED=1`
- an X11 display via `DISPLAY` or `PI_COMPUTER_USE_DISPLAY`

Optional tuning:

- `PI_COMPUTER_USE_DISPLAY`
- `PI_COMPUTER_USE_DISPLAY_NUMBER`
- `PI_COMPUTER_USE_DISPLAY_WIDTH`
- `PI_COMPUTER_USE_DISPLAY_HEIGHT`
- `PI_COMPUTER_USE_ACTION_DELAY_MS`
- `PI_COMPUTER_USE_CLICK_DELAY_MS`
- `PI_COMPUTER_USE_TYPING_DELAY_MS`
- `PI_COMPUTER_USE_REQUIRE_OPT_IN`
- `PI_COMPUTER_USE_OPT_IN_ENV_VAR`

## Local usage

OpenAI:

```bash
OPENAI_API_KEY=... \
PI_COMPUTER_USE_ENABLED=1 \
DISPLAY=:99 \
pi --print --mode json --no-tools \
  -e ./extensions/computer-use/index.ts \
  --provider openai-computer --model gpt-5.4 \
  "Open Firefox and take a screenshot."
```

Anthropic:

```bash
ANTHROPIC_API_KEY=... \
PI_COMPUTER_USE_ENABLED=1 \
DISPLAY=:99 \
pi --print --mode json --no-tools \
  -e ./extensions/computer-use/index.ts \
  --provider anthropic-computer --model claude-sonnet-4-5 \
  "Open Firefox and take a screenshot."
```

## Harbor wrapper

The Harbor wrapper:

- installs pi
- installs the required X11 tooling
- starts `Xvfb`
- loads this extension explicitly with `-e`
- launches pi with:
  - `--no-tools`
  - `--extension "$EXT_PATH"`

Suggested import path:

```bash
harbor run -d "<dataset@version>" \
  --agent-import-path integrations.harbor:PiComputerUse
```

## Safety

Use only in an isolated VM or container. The extension intentionally refuses to run until the opt-in env var is set.
