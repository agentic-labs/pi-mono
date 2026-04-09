import json
import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PiComputerUse(BaseInstalledAgent):
    _OUTPUT_FILENAME = "pi-computer-use.jsonl"
    _EXTENSION_PATHS = (
        "./extensions/computer-use/index.ts",
        "/workspace/extensions/computer-use/index.ts",
    )

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]

    @staticmethod
    def name() -> str:
        return "pi-computer-use"

    def get_version_command(self) -> str | None:
        return '. "$HOME/.nvm/nvm.sh"; pi --version'

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y "
                "curl scrot xdotool xvfb openbox x11-apps xauth"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export NVM_DIR="$HOME/.nvm"; '
                "if [ ! -s \"$NVM_DIR/nvm.sh\" ]; then "
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; "
                "fi; "
                '. "$NVM_DIR/nvm.sh"; '
                "nvm install 22; "
                "npm install -g "
                f"@mariozechner/pi-coding-agent{version_spec}; "
                "pi --version"
            ),
        )

    def _resolve_model(self) -> tuple[str, str]:
        if self.model_name:
            if "/" not in self.model_name:
                raise ValueError("Model name must be in the format provider/model_name")
            provider, model_id = self.model_name.split("/", 1)
            if provider == "openai":
                return "openai", model_id
            if provider in {"anthropic", "anthropic-computer"}:
                return "anthropic-computer", model_id
            raise ValueError(
                f"Unsupported computer-use provider '{provider}'. "
                "Use openai or anthropic/anthropic-computer."
            )

        if os.environ.get("OPENAI_API_KEY"):
            return "openai", "gpt-5.4"
        if os.environ.get("ANTHROPIC_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"):
            return "anthropic-computer", "claude-sonnet-4-5"
        raise ValueError("No supported API credentials found for openai or anthropic computer use.")

    def _build_env(self, provider: str) -> dict[str, str]:
        env = {
            "PI_COMPUTER_USE_ENABLED": "1",
            "PI_COMPUTER_USE_DISPLAY": ":99",
            "PI_COMPUTER_USE_DISPLAY_NUMBER": "99",
            "PI_COMPUTER_USE_DISPLAY_WIDTH": "1440",
            "PI_COMPUTER_USE_DISPLAY_HEIGHT": "900",
            "PI_COMPUTER_USE_REQUIRE_OPT_IN": "1",
        }
        if provider == "openai":
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY is required for openai.")
            env["OPENAI_API_KEY"] = api_key
            return env

        oauth_token = os.environ.get("ANTHROPIC_OAUTH_TOKEN")
        api_key = oauth_token or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN is required for anthropic-computer.")
        env["ANTHROPIC_API_KEY"] = api_key
        if oauth_token:
            env["ANTHROPIC_OAUTH_TOKEN"] = oauth_token
        return env

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model_id = self._resolve_model()
        env = self._build_env(provider)
        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags = f"{cli_flags} "

        escaped_instruction = shlex.quote(instruction)
        output_file = f"/logs/agent/{self._OUTPUT_FILENAME}"

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export NVM_DIR="$HOME/.nvm"; '
                '. "$NVM_DIR/nvm.sh"; '
                "EXT_PATH=''; "
                f"for candidate in {' '.join(shlex.quote(path) for path in self._EXTENSION_PATHS)}; do "
                'if [ -f "$candidate" ]; then EXT_PATH="$candidate"; break; fi; '
                "done; "
                'if [ -z "$EXT_PATH" ]; then echo "computer-use extension not found" >&2; exit 1; fi; '
                "Xvfb :99 -screen 0 1440x900x24 >/tmp/pi-computer-use-xvfb.log 2>&1 & "
                "XVFB_PID=$!; "
                "openbox >/tmp/pi-computer-use-openbox.log 2>&1 & "
                "OPENBOX_PID=$!; "
                "trap 'kill $OPENBOX_PID $XVFB_PID 2>/dev/null || true' EXIT; "
                "sleep 1; "
                f"pi --print --mode json --no-tools "
                f'--extension "$EXT_PATH" '
                f"--provider {shlex.quote(provider)} --model {shlex.quote(model_id)} "
                f"{cli_flags}"
                f"{escaped_instruction} "
                f"2>&1 </dev/null | stdbuf -oL tee {shlex.quote(output_file)}"
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cost = 0.0

        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if event.get("type") != "message_end":
                continue

            message = event.get("message") or {}
            if message.get("role") != "assistant":
                continue

            usage = message.get("usage") or {}
            total_input_tokens += int(usage.get("input", 0))
            total_output_tokens += int(usage.get("output", 0))
            total_cache_read_tokens += int(usage.get("cacheRead", 0))
            cost = usage.get("cost") or {}
            total_cost += float(cost.get("total", 0.0) or 0.0)

        context.n_input_tokens = total_input_tokens + total_cache_read_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
