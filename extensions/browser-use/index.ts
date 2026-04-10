import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { runBrowserTool, type DriverState } from "./driver.js";
import { BrowserToolParamsSchema, type BrowserToolParams } from "./types.js";

const EXTENSION_NAME = "browser-use";
const BROWSER_TOOL_NAME = "browser";
const DEFAULT_BROWSER_PROMPT_SNIPPET =
	"`browser`: control a browser via playwright-cli core commands. Use this instead of shell tools for websites and web apps.";
const DEFAULT_BROWSER_GUIDELINES = [
	"Use only the browser tool for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"When the page state is unclear, call snapshot before interacting so you have fresh element refs.",
	"Prefer direct browser commands like fill, select, check, and press over indirect workarounds.",
	"Use screenshot only when an actual image is needed. Prefer text snapshots when they are sufficient.",
];

function shouldBlockTool(event: ToolCallEvent): boolean {
	return event.toolName !== BROWSER_TOOL_NAME;
}

function prepareArguments(args: unknown): BrowserToolParams {
	if (!args || typeof args !== "object") {
		return args as BrowserToolParams;
	}
	const input = args as Record<string, unknown>;
	if (input.args !== undefined) {
		return input as BrowserToolParams;
	}
	return { ...input, args: {} } as BrowserToolParams;
}

export default function registerBrowserUseExtension(pi: ExtensionAPI): void {
	const state: DriverState = {};

	const browserTool = defineTool({
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description:
			"Control a browser via playwright-cli core commands. Supports navigation, page interaction, snapshots, screenshots, tabs, and keyboard or mouse input.",
		promptSnippet: DEFAULT_BROWSER_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_BROWSER_GUIDELINES,
		parameters: BrowserToolParamsSchema,
		prepareArguments,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runBrowserTool(pi, state, ctx, toolCallId, params);
		},
	});

	pi.registerTool(browserTool);

	pi.on("session_start", () => {
		pi.setActiveTools([BROWSER_TOOL_NAME]);
	});

	pi.on("tool_call", async (event) => {
		if (!shouldBlockTool(event)) {
			return;
		}
		return {
			block: true,
			reason: `${EXTENSION_NAME} enforces browser-only mode. ${event.toolName} is disabled.`,
		};
	});
}
