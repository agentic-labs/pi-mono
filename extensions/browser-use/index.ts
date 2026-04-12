import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	StringEnum,
	type ImageContent,
	type TextContent,
} from "@mariozechner/pi-ai";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "browser-use";
const BROWSER_TOOL_NAME = "browser";
const EXTENSION_PREFIX = "pi-browser-use";
const OUTPUT_DIR = join(tmpdir(), EXTENSION_PREFIX);
const SNAPSHOT_PATH_PATTERN = /\[Snapshot\]\(([^)]+)\)/;
const DEFAULT_BROWSER_PROMPT_SNIPPET =
	"`browser`: control a browser via playwright-cli core commands. Use this instead of shell tools for websites and web apps.";
const DEFAULT_BROWSER_GUIDELINES = [
	'Call `browser` with flat top-level fields like `{ command: "goto", url: "https://example.com" }`.',
	"Do not nest command parameters under `args`.",
	"Use only the browser tool for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"When the page state is unclear, call snapshot before interacting so you have fresh element refs.",
	"Prefer direct browser commands like fill, select, check, and press over indirect workarounds.",
	"Use screenshot only when an actual image is needed. Prefer text snapshots when they are sufficient.",
];

const BrowserNameSchema = StringEnum(["chrome", "firefox", "webkit", "msedge"] as const, {
	description: "Browser engine for playwright-cli.",
});
const MouseButtonSchema = StringEnum(["left", "right", "middle"] as const, {
	description: "Mouse button to use for click and mouse commands.",
});
const BrowserCommandNames = [
	"open",
	"goto",
	"click",
	"type",
	"fill",
	"select",
	"check",
	"uncheck",
	"hover",
	"drag",
	"upload",
	"close",
	"snapshot",
	"screenshot",
	"pdf",
	"go-back",
	"go-forward",
	"reload",
	"tab-list",
	"tab-new",
	"tab-select",
	"tab-close",
	"press",
	"keydown",
	"keyup",
	"mousemove",
	"mousedown",
	"mouseup",
	"mousewheel",
] as const;

type BrowserCommandName = (typeof BrowserCommandNames)[number];

interface BrowserToolDetails {
	command: BrowserCommandName;
	sessionName: string;
	invocation: string[];
	summary: string;
	stdout?: string;
	stderr?: string;
	outputPath?: string;
	snapshotPath?: string;
}

interface ResolvedCli {
	command: string;
	baseArgs: string[];
}

interface DriverState {
	activeToolCallId?: string;
	resolvedCli?: ResolvedCli;
}

interface PreparedCommand {
	argv: string[];
	summary: string;
	outputPath?: string;
}

interface CliOutput {
	stdout: string;
	stderr: string;
	snapshotPath?: string;
}

const SharedCommandFields = {
	session: Type.Optional(
		Type.String({
			description: "Optional playwright-cli session name. Defaults to a workspace-derived session name.",
			minLength: 1,
		}),
	),
	headed: Type.Optional(Type.Boolean({ description: "Launch the browser in headed mode." })),
	persistent: Type.Optional(Type.Boolean({ description: "Persist browser profile data to disk for the session." })),
	browser: Type.Optional(BrowserNameSchema),
} as const;

function commandSchema<TName extends BrowserCommandName, TProperties extends Record<string, TSchema>>(
	name: TName,
	properties: TProperties,
) {
	return Type.Object(
		{
			command: Type.Literal(name),
			...properties,
			...SharedCommandFields,
		},
		{ additionalProperties: false },
	);
}

const BrowserToolParamsSchema = Type.Union([
	commandSchema("open", {
		url: Type.Optional(Type.String({ description: "Optional URL to open immediately." })),
	}),
	commandSchema("goto", {
		url: Type.String({ description: "URL to navigate to." }),
	}),
	commandSchema(
		"click",
		{
			ref: Type.String({ description: "Element ref, CSS selector, or role selector." }),
			button: Type.Optional(MouseButtonSchema),
		},
	),
	commandSchema("type", {
		text: Type.String({ description: "Text to type into the focused editable element." }),
	}),
	commandSchema(
		"fill",
		{
			ref: Type.String({ description: "Element ref or selector to fill." }),
			text: Type.String({ description: "Replacement text." }),
		},
	),
	commandSchema(
		"select",
		{
			ref: Type.String({ description: "Element ref or selector for the select element." }),
			value: Type.String({ description: "Option value to select." }),
		},
	),
	commandSchema("check", {
		ref: Type.String({ description: "Checkbox or radio ref/selector." }),
	}),
	commandSchema("uncheck", {
		ref: Type.String({ description: "Checkbox ref/selector." }),
	}),
	commandSchema("hover", {
		ref: Type.String({ description: "Element ref or selector to hover." }),
	}),
	commandSchema(
		"drag",
		{
			startRef: Type.String({ description: "Source element ref or selector." }),
			endRef: Type.String({ description: "Target element ref or selector." }),
		},
	),
	commandSchema("upload", {
		file: Type.String({ description: "File path to upload." }),
	}),
	commandSchema("close", {}),
	commandSchema("snapshot", {}),
	commandSchema(
		"screenshot",
		{ ref: Type.Optional(Type.String({ description: "Optional element ref or selector for element screenshot." })) },
	),
	commandSchema("pdf", {}),
	commandSchema("go-back", {}),
	commandSchema("go-forward", {}),
	commandSchema("reload", {}),
	commandSchema("tab-list", {}),
	commandSchema("tab-new", {
		url: Type.Optional(Type.String({ description: "Optional URL for the new tab." })),
	}),
	commandSchema("tab-select", {
		index: Type.Number({ description: "Tab index to activate." }),
	}),
	commandSchema(
		"tab-close",
		{ index: Type.Optional(Type.Number({ description: "Optional tab index to close. Defaults to the active tab." })) },
	),
	commandSchema("press", {
		key: Type.String({ description: "Keyboard key name, such as Enter or ArrowDown." }),
	}),
	commandSchema("keydown", {
		key: Type.String({ description: "Keyboard key name to press down." }),
	}),
	commandSchema("keyup", {
		key: Type.String({ description: "Keyboard key name to release." }),
	}),
	commandSchema(
		"mousemove",
		{
			x: Type.Number({ description: "X coordinate in CSS pixels." }),
			y: Type.Number({ description: "Y coordinate in CSS pixels." }),
		},
	),
	commandSchema("mousedown", { button: Type.Optional(MouseButtonSchema) }),
	commandSchema("mouseup", { button: Type.Optional(MouseButtonSchema) }),
	commandSchema(
		"mousewheel",
		{
			dx: Type.Number({ description: "Horizontal wheel delta." }),
			dy: Type.Number({ description: "Vertical wheel delta." }),
		},
	),
]);

type BrowserToolParams = Static<typeof BrowserToolParamsSchema>;

function shouldBlockTool(event: ToolCallEvent): boolean {
	return event.toolName !== BROWSER_TOOL_NAME;
}

function sanitizeSessionName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

function getSessionName(ctx: ExtensionContext, params: BrowserToolParams): string {
	if (params.session) {
		return params.session;
	}
	const derived = sanitizeSessionName(ctx.cwd);
	return derived ? `${EXTENSION_PREFIX}-${derived}` : `${EXTENSION_PREFIX}-workspace`;
}

function outputPath(toolCallId: string, extension: "png" | "yml"): string {
	return join(OUTPUT_DIR, `${toolCallId}.${extension}`);
}

function describeCommand(command: BrowserCommandName, details: string[] = []): string {
	return details.length > 0 ? `${command} ${details.join(" ")}` : command;
}

function buildCommand(params: BrowserToolParams, sessionName: string, toolCallId: string): PreparedCommand {
	const argv = [`-s=${sessionName}`];
	const browser = params.browser ?? "firefox";
	argv.push(`--browser=${browser}`);
	if (params.headed) argv.push("--headed");
	if (params.persistent) argv.push("--persistent");

	switch (params.command) {
		case "open":
			argv.push("open");
			if (params.url) argv.push(params.url);
			return { argv, summary: describeCommand("open", params.url ? [params.url] : []) };
		case "goto":
			argv.push("goto", params.url);
			return { argv, summary: describeCommand("goto", [params.url]) };
		case "click":
			argv.push("click", params.ref);
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("click", [params.ref]) };
		case "type":
			argv.push("type", params.text);
			return { argv, summary: describeCommand("type", [`"${params.text}"`]) };
		case "fill":
			argv.push("fill", params.ref, params.text);
			return { argv, summary: describeCommand("fill", [params.ref]) };
		case "select":
			argv.push("select", params.ref, params.value);
			return { argv, summary: describeCommand("select", [params.ref, `=${params.value}`]) };
		case "check":
			argv.push("check", params.ref);
			return { argv, summary: describeCommand("check", [params.ref]) };
		case "uncheck":
			argv.push("uncheck", params.ref);
			return { argv, summary: describeCommand("uncheck", [params.ref]) };
		case "hover":
			argv.push("hover", params.ref);
			return { argv, summary: describeCommand("hover", [params.ref]) };
		case "drag":
			argv.push("drag", params.startRef, params.endRef);
			return { argv, summary: describeCommand("drag", [params.startRef, "->", params.endRef]) };
		case "upload":
			argv.push("upload", params.file);
			return { argv, summary: describeCommand("upload", [params.file]) };
		case "close":
			argv.push("close");
			return { argv, summary: describeCommand("close") };
		case "snapshot": {
			const path = outputPath(toolCallId, "yml");
			argv.push("snapshot", `--filename=${path}`);
			return { argv, summary: describeCommand("snapshot"), outputPath: path };
		}
		case "screenshot": {
			const path = outputPath(toolCallId, "png");
			argv.push("screenshot");
			if (params.ref) argv.push(params.ref);
			argv.push(`--filename=${path}`);
			return { argv, summary: describeCommand("screenshot", params.ref ? [params.ref] : []), outputPath: path };
		}
		case "pdf":
			argv.push("pdf");
			return { argv, summary: describeCommand("pdf") };
		case "go-back":
			argv.push("go-back");
			return { argv, summary: describeCommand("go-back") };
		case "go-forward":
			argv.push("go-forward");
			return { argv, summary: describeCommand("go-forward") };
		case "reload":
			argv.push("reload");
			return { argv, summary: describeCommand("reload") };
		case "tab-list":
			argv.push("tab-list");
			return { argv, summary: describeCommand("tab-list") };
		case "tab-new":
			argv.push("tab-new");
			if (params.url) argv.push(params.url);
			return { argv, summary: describeCommand("tab-new", params.url ? [params.url] : []) };
		case "tab-select":
			argv.push("tab-select", String(params.index));
			return { argv, summary: describeCommand("tab-select", [String(params.index)]) };
		case "tab-close":
			argv.push("tab-close");
			if (params.index !== undefined) argv.push(String(params.index));
			return { argv, summary: describeCommand("tab-close", params.index !== undefined ? [String(params.index)] : []) };
		case "press":
			argv.push("press", params.key);
			return { argv, summary: describeCommand("press", [params.key]) };
		case "keydown":
			argv.push("keydown", params.key);
			return { argv, summary: describeCommand("keydown", [params.key]) };
		case "keyup":
			argv.push("keyup", params.key);
			return { argv, summary: describeCommand("keyup", [params.key]) };
		case "mousemove":
			argv.push("mousemove", String(params.x), String(params.y));
			return { argv, summary: describeCommand("mousemove", [String(params.x), String(params.y)]) };
		case "mousedown":
			argv.push("mousedown");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mousedown", params.button ? [params.button] : []) };
		case "mouseup":
			argv.push("mouseup");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mouseup", params.button ? [params.button] : []) };
		case "mousewheel":
			argv.push("mousewheel", String(params.dx), String(params.dy));
			return { argv, summary: describeCommand("mousewheel", [String(params.dx), String(params.dy)]) };
	}
}

function truncateOutput(label: string, text: string): string | undefined {
	if (!text.trim()) {
		return undefined;
	}
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let content = truncation.content.trim();
	if (!truncation.truncated) {
		return content;
	}
	content += `\n\n[${label} truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	return content;
}

function truncateSnapshot(text: string): string {
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return truncation.content.trim();
	}
	let content = truncation.content.trim();
	content += `\n\n[Snapshot truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	return content;
}

async function resolveCli(pi: ExtensionAPI, state: DriverState, ctx: ExtensionContext): Promise<ResolvedCli> {
	if (state.resolvedCli) {
		return state.resolvedCli;
	}
	const result = await pi.exec(
		"bash",
		[
			"-lc",
			"if command -v playwright-cli >/dev/null 2>&1; then printf 'playwright-cli'; elif command -v npx >/dev/null 2>&1; then printf 'npx'; else exit 1; fi",
		],
		{ cwd: ctx.cwd, signal: ctx.signal, timeout: 5000 },
	);
	if (result.code !== 0) {
		throw new Error("playwright-cli is not installed. Install it with npm install -g @playwright/cli@latest.");
	}
	const command = result.stdout.trim();
	state.resolvedCli =
		command === "playwright-cli" ? { command, baseArgs: [] } : { command: "npx", baseArgs: ["-y", "@playwright/cli"] };
	return state.resolvedCli;
}

async function execCli(pi: ExtensionAPI, state: DriverState, ctx: ExtensionContext, argv: string[]): Promise<CliOutput> {
	const cli = await resolveCli(pi, state, ctx);
	const result = await pi.exec(cli.command, [...cli.baseArgs, ...argv], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 120000,
	});
	if (result.code !== 0) {
		const stderr = truncateOutput("stderr", result.stderr);
		const stdout = truncateOutput("stdout", result.stdout);
		throw new Error([stderr, stdout].filter(Boolean).join("\n\n") || "playwright-cli failed");
	}
	const match = result.stdout.match(SNAPSHOT_PATH_PATTERN);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		snapshotPath: match ? resolve(ctx.cwd, match[1]) : undefined,
	};
}

async function readImage(path: string): Promise<ImageContent> {
	const data = await readFile(path, { encoding: "base64" });
	return { type: "image", mimeType: "image/png", data };
}

function formatContent(summary: string, stdout?: string, stderr?: string, snapshot?: string): TextContent {
	const sections = [summary];
	if (stdout) sections.push(`Output:\n${stdout}`);
	if (stderr) sections.push(`Warnings:\n${stderr}`);
	if (snapshot) sections.push(`Snapshot:\n${snapshot}`);
	return { type: "text", text: sections.join("\n\n") };
}

async function runBrowserTool(
	pi: ExtensionAPI,
	state: DriverState,
	ctx: ExtensionContext,
	toolCallId: string,
	params: BrowserToolParams,
): Promise<{ content: (TextContent | ImageContent)[]; details: BrowserToolDetails }> {
	if (state.activeToolCallId && state.activeToolCallId !== toolCallId) {
		throw new Error("Browser tool does not allow parallel execution.");
	}
	state.activeToolCallId = toolCallId;
	try {
		await mkdir(OUTPUT_DIR, { recursive: true });
		const sessionName = getSessionName(ctx, params);
		const prepared = buildCommand(params, sessionName, toolCallId);
		const output = await execCli(pi, state, ctx, prepared.argv);
		const stdout = truncateOutput("stdout", output.stdout);
		const stderr = truncateOutput("stderr", output.stderr);
		let snapshotText: string | undefined;
		let image: ImageContent | undefined;
		let snapshotPath = output.snapshotPath;
		if (params.command === "snapshot" && prepared.outputPath) {
			snapshotPath = prepared.outputPath;
			snapshotText = truncateSnapshot(await readFile(prepared.outputPath, "utf8"));
		}
		if (params.command === "screenshot" && prepared.outputPath) {
			image = await readImage(prepared.outputPath);
		}
		const details: BrowserToolDetails = {
			command: params.command,
			sessionName,
			invocation: prepared.argv,
			summary: prepared.summary,
			stdout,
			stderr,
			outputPath: prepared.outputPath,
			snapshotPath,
		};
		const content: (TextContent | ImageContent)[] = [formatContent(prepared.summary, stdout, stderr, snapshotText)];
		if (image) content.push(image);
		return { content, details };
	} finally {
		if (state.activeToolCallId === toolCallId) {
			state.activeToolCallId = undefined;
		}
	}
}

export default function registerBrowserUseExtension(pi: ExtensionAPI): void {
	const state: DriverState = {};

	pi.registerTool({
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description:
			'Control a browser via playwright-cli core commands using flat top-level arguments like { command: "goto", url: "https://example.com" }.',
		promptSnippet: DEFAULT_BROWSER_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_BROWSER_GUIDELINES,
		parameters: BrowserToolParamsSchema,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runBrowserTool(pi, state, ctx, toolCallId, params);
		},
	});

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
