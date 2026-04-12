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
const EXTENSION_PREFIX = "pi-browser-use";
const BROWSER_TOOL_NAMES = {
	open: "browser_open",
	goto: "browser_goto",
	click: "browser_click",
	type: "browser_type",
	fill: "browser_fill",
	select: "browser_select",
	check: "browser_check",
	uncheck: "browser_uncheck",
	hover: "browser_hover",
	drag: "browser_drag",
	upload: "browser_upload",
	close: "browser_close",
	snapshot: "browser_snapshot",
	screenshot: "browser_screenshot",
	pdf: "browser_pdf",
	navigation: "browser_navigation",
	tabs: "browser_tabs",
	keyboard: "browser_keyboard",
	mouse: "browser_mouse",
} as const;
const ACTIVE_BROWSER_TOOL_NAMES = Object.values(BROWSER_TOOL_NAMES);
const OUTPUT_DIR = join(tmpdir(), EXTENSION_PREFIX);
const SNAPSHOT_PATH_PATTERN = /\[Snapshot\]\(([^)]+)\)/;
const DEFAULT_BROWSER_GUIDELINES = [
	"Use only the `browser_*` tools for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"Start a fresh browser session with `browser_open`. It can optionally take a URL.",
	"When the page state is unclear, call `browser_snapshot` before interacting so you have fresh element refs.",
	"Prefer direct browser commands like fill, select, check, and press over indirect workarounds.",
	"Use `browser_screenshot` only when an actual image is needed. Prefer text snapshots when they are sufficient.",
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
const BrowserCommandSchema = StringEnum(BrowserCommandNames, {
	description: "Browser command to run. Use flat top-level companion fields like `url`, `ref`, `text`, and `value`.",
});
const BrowserNavigationActionSchema = StringEnum(["back", "forward", "reload"] as const, {
	description: "Navigation action to perform on the current page.",
});
const BrowserTabsActionSchema = StringEnum(["list", "new", "select", "close"] as const, {
	description: "Tab action to perform.",
});
const BrowserKeyboardActionSchema = StringEnum(["press", "down", "up"] as const, {
	description: "Keyboard action to perform.",
});
const BrowserMouseActionSchema = StringEnum(["move", "down", "up", "wheel"] as const, {
	description: "Mouse action to perform.",
});

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

function toolSchema<TProperties extends Record<string, TSchema>>(properties: TProperties) {
	return Type.Object(
		{
			...properties,
			...SharedCommandFields,
		},
		{ additionalProperties: false },
	);
}

const BrowserToolParamsSchema = Type.Object(
	{
		command: BrowserCommandSchema,
		url: Type.Optional(Type.String({ description: "URL. Required for `goto`. Optional for `open` and `tab-new`." })),
		ref: Type.Optional(
			Type.String({
				description:
					"Element ref, CSS selector, or role selector. Required for `click`, `fill`, `select`, `check`, `uncheck`, and `hover`. Optional for `screenshot`.",
			}),
		),
		button: Type.Optional(MouseButtonSchema),
		text: Type.Optional(Type.String({ description: "Text. Required for `type` and `fill`." })),
		value: Type.Optional(Type.String({ description: "Option value. Required for `select`." })),
		startRef: Type.Optional(Type.String({ description: "Source element ref or selector. Required for `drag`." })),
		endRef: Type.Optional(Type.String({ description: "Target element ref or selector. Required for `drag`." })),
		file: Type.Optional(Type.String({ description: "File path. Required for `upload`." })),
		index: Type.Optional(Type.Number({ description: "Tab index. Required for `tab-select`. Optional for `tab-close`." })),
		key: Type.Optional(Type.String({ description: "Keyboard key. Required for `press`, `keydown`, and `keyup`." })),
		x: Type.Optional(Type.Number({ description: "X coordinate. Required for `mousemove`." })),
		y: Type.Optional(Type.Number({ description: "Y coordinate. Required for `mousemove`." })),
		dx: Type.Optional(Type.Number({ description: "Horizontal wheel delta. Required for `mousewheel`." })),
		dy: Type.Optional(Type.Number({ description: "Vertical wheel delta. Required for `mousewheel`." })),
		...SharedCommandFields,
	},
	{ additionalProperties: false },
);

type BrowserToolParams = Static<typeof BrowserToolParamsSchema>;
type BrowserSharedParams = {
	session?: string;
	headed?: boolean;
	persistent?: boolean;
	browser?: Static<typeof BrowserNameSchema>;
};

function shouldBlockTool(event: ToolCallEvent): boolean {
	return !ACTIVE_BROWSER_TOOL_NAMES.includes(event.toolName as (typeof ACTIVE_BROWSER_TOOL_NAMES)[number]);
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

function requireStringField(
	params: BrowserToolParams,
	command: BrowserCommandName,
	field: "url" | "ref" | "text" | "value" | "startRef" | "endRef" | "file" | "key",
): string {
	const value = params[field];
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new Error(`browser ${command} requires \`${field}\`.`);
}

function requireNumberField(
	params: BrowserToolParams,
	command: BrowserCommandName,
	field: "index" | "x" | "y" | "dx" | "dy",
): number {
	const value = params[field];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	throw new Error(`browser ${command} requires \`${field}\`.`);
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
		case "goto": {
			const url = requireStringField(params, "goto", "url");
			argv.push("goto", url);
			return { argv, summary: describeCommand("goto", [url]) };
		}
		case "click": {
			const ref = requireStringField(params, "click", "ref");
			argv.push("click", ref);
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("click", [ref]) };
		}
		case "type": {
			const text = requireStringField(params, "type", "text");
			argv.push("type", text);
			return { argv, summary: describeCommand("type", [`"${text}"`]) };
		}
		case "fill": {
			const ref = requireStringField(params, "fill", "ref");
			const text = requireStringField(params, "fill", "text");
			argv.push("fill", ref, text);
			return { argv, summary: describeCommand("fill", [ref]) };
		}
		case "select": {
			const ref = requireStringField(params, "select", "ref");
			const value = requireStringField(params, "select", "value");
			argv.push("select", ref, value);
			return { argv, summary: describeCommand("select", [ref, `=${value}`]) };
		}
		case "check": {
			const ref = requireStringField(params, "check", "ref");
			argv.push("check", ref);
			return { argv, summary: describeCommand("check", [ref]) };
		}
		case "uncheck": {
			const ref = requireStringField(params, "uncheck", "ref");
			argv.push("uncheck", ref);
			return { argv, summary: describeCommand("uncheck", [ref]) };
		}
		case "hover": {
			const ref = requireStringField(params, "hover", "ref");
			argv.push("hover", ref);
			return { argv, summary: describeCommand("hover", [ref]) };
		}
		case "drag": {
			const startRef = requireStringField(params, "drag", "startRef");
			const endRef = requireStringField(params, "drag", "endRef");
			argv.push("drag", startRef, endRef);
			return { argv, summary: describeCommand("drag", [startRef, "->", endRef]) };
		}
		case "upload": {
			const file = requireStringField(params, "upload", "file");
			argv.push("upload", file);
			return { argv, summary: describeCommand("upload", [file]) };
		}
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
		case "tab-select": {
			const index = requireNumberField(params, "tab-select", "index");
			argv.push("tab-select", String(index));
			return { argv, summary: describeCommand("tab-select", [String(index)]) };
		}
		case "tab-close":
			argv.push("tab-close");
			if (params.index !== undefined) argv.push(String(params.index));
			return { argv, summary: describeCommand("tab-close", params.index !== undefined ? [String(params.index)] : []) };
		case "press": {
			const key = requireStringField(params, "press", "key");
			argv.push("press", key);
			return { argv, summary: describeCommand("press", [key]) };
		}
		case "keydown": {
			const key = requireStringField(params, "keydown", "key");
			argv.push("keydown", key);
			return { argv, summary: describeCommand("keydown", [key]) };
		}
		case "keyup": {
			const key = requireStringField(params, "keyup", "key");
			argv.push("keyup", key);
			return { argv, summary: describeCommand("keyup", [key]) };
		}
		case "mousemove": {
			const x = requireNumberField(params, "mousemove", "x");
			const y = requireNumberField(params, "mousemove", "y");
			argv.push("mousemove", String(x), String(y));
			return { argv, summary: describeCommand("mousemove", [String(x), String(y)]) };
		}
		case "mousedown":
			argv.push("mousedown");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mousedown", params.button ? [params.button] : []) };
		case "mouseup":
			argv.push("mouseup");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mouseup", params.button ? [params.button] : []) };
		case "mousewheel": {
			const dx = requireNumberField(params, "mousewheel", "dx");
			const dy = requireNumberField(params, "mousewheel", "dy");
			argv.push("mousewheel", String(dx), String(dy));
			return { argv, summary: describeCommand("mousewheel", [String(dx), String(dy)]) };
		}
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

function getSharedParams(params: BrowserSharedParams): BrowserSharedParams {
	return {
		session: params.session,
		headed: params.headed,
		persistent: params.persistent,
		browser: params.browser,
	};
}

function registerBrowserTool<TParams extends TSchema>(
	pi: ExtensionAPI,
	state: DriverState,
	config: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: TParams;
		toBrowserParams: (params: Static<TParams>) => BrowserToolParams;
	},
): void {
	pi.registerTool({
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet ?? config.description,
		promptGuidelines: DEFAULT_BROWSER_GUIDELINES,
		parameters: config.parameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runBrowserTool(pi, state, ctx, toolCallId, config.toBrowserParams(params));
		},
	});
}

export default function registerBrowserUseExtension(pi: ExtensionAPI): void {
	const state: DriverState = {};

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.open,
		label: "Browser Open",
		description: "Open a browser session. Optionally navigate to a URL immediately.",
		parameters: toolSchema({
			url: Type.Optional(Type.String({ description: "Optional URL to open immediately." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "open",
			url: params.url,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.goto,
		label: "Browser Goto",
		description: "Navigate the current browser tab to a URL.",
		parameters: toolSchema({
			url: Type.String({ description: "URL to navigate to." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "goto",
			url: params.url,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.click,
		label: "Browser Click",
		description: "Click an element by ref or selector.",
		parameters: toolSchema({
			ref: Type.String({ description: "Element ref, CSS selector, or role selector." }),
			button: Type.Optional(MouseButtonSchema),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "click",
			ref: params.ref,
			button: params.button,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.type,
		label: "Browser Type",
		description: "Type text into the focused editable element.",
		parameters: toolSchema({
			text: Type.String({ description: "Text to type." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "type",
			text: params.text,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.fill,
		label: "Browser Fill",
		description: "Fill an input or editable element with replacement text.",
		parameters: toolSchema({
			ref: Type.String({ description: "Element ref or selector to fill." }),
			text: Type.String({ description: "Replacement text." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "fill",
			ref: params.ref,
			text: params.text,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.select,
		label: "Browser Select",
		description: "Select an option in a dropdown.",
		parameters: toolSchema({
			ref: Type.String({ description: "Select element ref or selector." }),
			value: Type.String({ description: "Option value to select." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "select",
			ref: params.ref,
			value: params.value,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.check,
		label: "Browser Check",
		description: "Check a checkbox or radio button.",
		parameters: toolSchema({
			ref: Type.String({ description: "Checkbox or radio ref or selector." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "check",
			ref: params.ref,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.uncheck,
		label: "Browser Uncheck",
		description: "Uncheck a checkbox.",
		parameters: toolSchema({
			ref: Type.String({ description: "Checkbox ref or selector." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "uncheck",
			ref: params.ref,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.hover,
		label: "Browser Hover",
		description: "Hover over an element.",
		parameters: toolSchema({
			ref: Type.String({ description: "Element ref or selector to hover." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "hover",
			ref: params.ref,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.drag,
		label: "Browser Drag",
		description: "Drag from one element to another.",
		parameters: toolSchema({
			startRef: Type.String({ description: "Source element ref or selector." }),
			endRef: Type.String({ description: "Target element ref or selector." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "drag",
			startRef: params.startRef,
			endRef: params.endRef,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.upload,
		label: "Browser Upload",
		description: "Upload a file using the focused file picker.",
		parameters: toolSchema({
			file: Type.String({ description: "File path to upload." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "upload",
			file: params.file,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.close,
		label: "Browser Close",
		description: "Close the browser session.",
		parameters: toolSchema({}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "close",
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.snapshot,
		label: "Browser Snapshot",
		description: "Capture a text snapshot of the current page.",
		parameters: toolSchema({}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "snapshot",
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.screenshot,
		label: "Browser Screenshot",
		description: "Capture a screenshot of the current page or an element.",
		parameters: toolSchema({
			ref: Type.Optional(Type.String({ description: "Optional element ref or selector for element screenshot." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "screenshot",
			ref: params.ref,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.pdf,
		label: "Browser PDF",
		description: "Save the current page as a PDF.",
		parameters: toolSchema({}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "pdf",
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.navigation,
		label: "Browser Navigation",
		description: "Go back, go forward, or reload the current page.",
		parameters: toolSchema({
			action: BrowserNavigationActionSchema,
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: params.action === "back" ? "go-back" : params.action === "forward" ? "go-forward" : "reload",
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.tabs,
		label: "Browser Tabs",
		description: "List, create, select, or close browser tabs.",
		parameters: toolSchema({
			action: BrowserTabsActionSchema,
			url: Type.Optional(Type.String({ description: "Optional URL for `new`." })),
			index: Type.Optional(Type.Number({ description: "Tab index for `select`. Optional for `close`." })),
		}),
		toBrowserParams: (params) => {
			const shared = getSharedParams(params);
			switch (params.action) {
				case "list":
					return { ...shared, command: "tab-list" };
				case "new":
					return { ...shared, command: "tab-new", url: params.url };
				case "select":
					if (params.index === undefined) {
						throw new Error("browser_tabs with action `select` requires `index`.");
					}
					return { ...shared, command: "tab-select", index: params.index };
				case "close":
					return { ...shared, command: "tab-close", index: params.index };
			}
		},
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.keyboard,
		label: "Browser Keyboard",
		description: "Press, hold down, or release a keyboard key.",
		parameters: toolSchema({
			action: BrowserKeyboardActionSchema,
			key: Type.String({ description: "Keyboard key name, such as Enter or ArrowDown." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: params.action === "press" ? "press" : params.action === "down" ? "keydown" : "keyup",
			key: params.key,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.mouse,
		label: "Browser Mouse",
		description: "Move the mouse, press or release a button, or scroll the wheel.",
		parameters: toolSchema({
			action: BrowserMouseActionSchema,
			x: Type.Optional(Type.Number({ description: "X coordinate for `move`." })),
			y: Type.Optional(Type.Number({ description: "Y coordinate for `move`." })),
			button: Type.Optional(MouseButtonSchema),
			dx: Type.Optional(Type.Number({ description: "Horizontal wheel delta for `wheel`." })),
			dy: Type.Optional(Type.Number({ description: "Vertical wheel delta for `wheel`." })),
		}),
		toBrowserParams: (params) => {
			const shared = getSharedParams(params);
			switch (params.action) {
				case "move":
					if (params.x === undefined || params.y === undefined) {
						throw new Error("browser_mouse with action `move` requires `x` and `y`.");
					}
					return { ...shared, command: "mousemove", x: params.x, y: params.y };
				case "down":
					return { ...shared, command: "mousedown", button: params.button };
				case "up":
					return { ...shared, command: "mouseup", button: params.button };
				case "wheel":
					if (params.dx === undefined || params.dy === undefined) {
						throw new Error("browser_mouse with action `wheel` requires `dx` and `dy`.");
					}
					return { ...shared, command: "mousewheel", dx: params.dx, dy: params.dy };
			}
		},
	});

	pi.on("session_start", () => {
		pi.setActiveTools(ACTIVE_BROWSER_TOOL_NAMES);
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
