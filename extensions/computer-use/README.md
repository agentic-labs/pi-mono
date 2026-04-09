# Computer Use Extension

Single-file pi extension for native computer-use workflows plus a lightweight Harbor installed-agent wrapper.

## Files

- `index.ts` - pi extension
- `../../integrations/harbor/pi_computer_use_agent.py` - Harbor installed-agent wrapper

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

## Harbor wrapper

The Harbor wrapper:

- installs pi
- installs the required X11 tooling
- reuses an existing `DISPLAY` session when present, otherwise starts `Xvfb`
- starts `openbox` only when it is not already running
- derives `PI_COMPUTER_USE_DISPLAY_WIDTH`, `PI_COMPUTER_USE_DISPLAY_HEIGHT`, and `PI_COMPUTER_USE_DISPLAY_NUMBER` from the active display unless you override them
- downloads this extension from raw GitHub into `~/.pi/agent/extensions/computer-use/index.ts`
- loads that staged extension explicitly with `-e`
- uses the `provider/model` Harbor passes to the agent
- forwards provider-specific credential env vars using the same provider mapping as Harbor's official `pi.py`
- launches pi with:
  - `--no-session`
  - `--no-tools`
  - `--extension "$EXT_PATH"`

Suggested import path:

```bash
harbor run -d "<dataset@version>" \
  --agent-import-path integrations.harbor:PiComputerUse
```

Optional override for the downloaded extension ref:

```bash
export PI_COMPUTER_USE_EXTENSION_REF=refs/heads/main
```

Use a commit SHA or another ref if you want to pin a specific extension version.

## Safety

Use only in an isolated VM or container.
