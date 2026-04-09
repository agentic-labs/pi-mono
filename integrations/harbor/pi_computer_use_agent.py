import json
import os
import shlex

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PiComputerUse(BaseInstalledAgent):
    _OUTPUT_FILENAME = "pi.txt"
    _INSTALLED_EXTENSION_DIR = "$HOME/.pi/agent/extensions/computer-use"
    _INSTALLED_EXTENSION_PATH = "$HOME/.pi/agent/extensions/computer-use/index.ts"
    _EXTENSION_REF_ENV = "PI_COMPUTER_USE_EXTENSION_REF"
    _DEFAULT_EXTENSION_REF = "refs/heads/main"

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
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
                'export NVM_DIR="$HOME/.nvm" && '
                '\\. "$NVM_DIR/nvm.sh" || true && '
                "command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } && "
                "nvm install 22 && npm -v && "
                f"npm install -g @mariozechner/pi-coding-agent{version_spec} && "
                "pi --version"
            ),
        )

    def _build_register_skills_command(self) -> str | None:
        if not self.skills_dir:
            return None
        return (
            f"mkdir -p $HOME/.agents/skills && "
            f"cp -r {shlex.quote(self.skills_dir)}/* "
            f"$HOME/.agents/skills/ 2>/dev/null || true"
        )

    def _build_sync_extension_command(self) -> str:
        extension_ref = os.environ.get(
            self._EXTENSION_REF_ENV, self._DEFAULT_EXTENSION_REF
        )
        extension_url = (
            "https://raw.githubusercontent.com/agentic-labs/pi-mono/"
            f"{extension_ref}/extensions/computer-use/index.ts"
        )
        return (
            f'mkdir -p "{self._INSTALLED_EXTENSION_DIR}" && '
            f'curl -fsSL {shlex.quote(extension_url)} '
            f'-o "{self._INSTALLED_EXTENSION_PATH}"'
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, _ = self.model_name.split("/", 1)

        env: dict[str, str] = {
            "PI_COMPUTER_USE_DISPLAY": ":99",
            "PI_COMPUTER_USE_DISPLAY_NUMBER": "99",
            "PI_COMPUTER_USE_DISPLAY_WIDTH": "1440",
            "PI_COMPUTER_USE_DISPLAY_HEIGHT": "900",
        }
        keys: list[str] = []

        if provider == "amazon-bedrock":
            keys.extend(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"])
        elif provider == "anthropic":
            keys.extend(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
        elif provider == "github-copilot":
            keys.append("GITHUB_TOKEN")
        elif provider == "google":
            keys.extend(
                [
                    "GEMINI_API_KEY",
                    "GOOGLE_GENERATIVE_AI_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    "GOOGLE_CLOUD_PROJECT",
                    "GOOGLE_CLOUD_LOCATION",
                    "GOOGLE_GENAI_USE_VERTEXAI",
                    "GOOGLE_API_KEY",
                ]
            )
        elif provider == "groq":
            keys.append("GROQ_API_KEY")
        elif provider == "huggingface":
            keys.append("HF_TOKEN")
        elif provider == "mistral":
            keys.append("MISTRAL_API_KEY")
        elif provider == "openai":
            keys.append("OPENAI_API_KEY")
        elif provider == "openrouter":
            keys.append("OPENROUTER_API_KEY")
        elif provider == "xai":
            keys.append("XAI_API_KEY")
        else:
            raise ValueError(
                f"Unknown provider '{provider}'. If you believe this provider "
                "should be supported, please contact the maintainers."
            )

        for key in keys:
            val = os.environ.get(key)
            if val:
                env[key] = val

        model_args = (
            f"--provider {provider} --model {self.model_name.split('/', 1)[1]} "
        )

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        output_file = f"/logs/agent/{self._OUTPUT_FILENAME}"
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        await self.exec_as_agent(environment, command=self._build_sync_extension_command())

        await self.exec_as_agent(
            environment,
            command=(
                f". ~/.nvm/nvm.sh; "
                'export DISPLAY="${PI_COMPUTER_USE_DISPLAY:-:99}"; '
                "STARTED_XVFB=0; "
                "STARTED_OPENBOX=0; "
                "if ! xdotool getdisplaygeometry >/dev/null 2>&1; then "
                'Xvfb "$DISPLAY" -screen 0 1440x900x24 >/tmp/pi-computer-use-xvfb.log 2>&1 & '
                "XVFB_PID=$!; "
                "STARTED_XVFB=1; "
                "sleep 1; "
                "fi; "
                'if ! xdotool getdisplaygeometry >/dev/null 2>&1; then echo "Failed to initialize X display $DISPLAY" >&2; exit 1; fi; '
                "if ! pgrep -x openbox >/dev/null 2>&1; then "
                "openbox >/tmp/pi-computer-use-openbox.log 2>&1 & "
                "OPENBOX_PID=$!; "
                "STARTED_OPENBOX=1; "
                "sleep 1; "
                "fi; "
                'cleanup() { '
                'if [ "${STARTED_OPENBOX:-0}" = "1" ]; then kill "$OPENBOX_PID" 2>/dev/null || true; fi; '
                'if [ "${STARTED_XVFB:-0}" = "1" ]; then kill "$XVFB_PID" 2>/dev/null || true; fi; '
                "}; "
                "trap cleanup EXIT; "
                f"pi --print --mode json --no-session --no-tools "
                f'--extension "{self._INSTALLED_EXTENSION_PATH}" '
                f"{model_args}"
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
