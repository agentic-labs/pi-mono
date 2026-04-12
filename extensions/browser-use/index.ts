import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
	scroll: "browser_scroll",
	wait: "browser_wait",
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
const DEFAULT_BROWSER_GUIDELINES = [
	"Use only the `browser_*` tools for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"Start with `browser_goto`, then call `browser_snapshot` to collect fresh refs like `@e1` before acting.",
	"Prefer ref-based interactions from `browser_snapshot`; fall back to selectors only when a ref is unavailable.",
	"After actions that may change the page, call `browser_wait` or take a fresh `browser_snapshot` before the next structural action.",
	"Use `browser_screenshot` only when visual context is needed. Set `annotate: true` when you want image labels that line up with refs.",
];

const BrowserProviderSchema = StringEnum(["ios", "browserbase", "kernel", "browseruse", "browserless", "agentcore"] as const, {
	description: "Optional agent-browser provider.",
});
const BrowserEngineSchema = StringEnum(["chrome", "lightpanda"] as const, {
	description: "Optional agent-browser engine.",
});
const MouseButtonSchema = StringEnum(["left", "right", "middle"] as const, {
	description: "Mouse button to use for mouse commands.",
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
const BrowserScrollDirectionSchema = StringEnum(["up", "down", "left", "right"] as const, {
	description: "Scroll direction.",
});
const BrowserWaitLoadStateSchema = StringEnum(["load", "domcontentloaded", "networkidle"] as const, {
	description: "Page load state to wait for.",
});
const BrowserWaitStateSchema = StringEnum(["visible", "hidden", "attached", "detached"] as const, {
	description: "Element state to wait for when `target` is used.",
});

const BrowserCommandNames = [
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
	"scroll",
	"wait",
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

interface AgentBrowserResponse {
	success?: boolean;
	data?: unknown;
	error?: unknown;
	warning?: unknown;
}

interface CliOutput {
	stdout: string;
	stderr: string;
	response?: AgentBrowserResponse;
}

const SharedCommandFields = {
	session: Type.Optional(
		Type.String({
			description: "Optional agent-browser session name. Defaults to a workspace-derived session name.",
			minLength: 1,
		}),
	),
	headed: Type.Optional(Type.Boolean({ description: "Whether to show the browser window." })),
	provider: Type.Optional(BrowserProviderSchema),
	engine: Type.Optional(BrowserEngineSchema),
	sessionName: Type.Optional(
		Type.String({
			description: "Optional persisted state name for agent-browser `--session-name`.",
			minLength: 1,
		}),
	),
	profile: Type.Optional(
		Type.String({
			description: "Optional Chrome profile name or persistent profile path for agent-browser `--profile`.",
			minLength: 1,
		}),
	),
	state: Type.Optional(
		Type.String({
			description: "Optional storage state JSON path for agent-browser `--state`.",
			minLength: 1,
		}),
	),
	autoConnect: Type.Optional(Type.Boolean({ description: "Whether to auto-connect to a running Chrome instance." })),
	cdp: Type.Optional(
		Type.String({
			description: "Optional Chrome DevTools Protocol port or WebSocket URL.",
			minLength: 1,
		}),
	),
	device: Type.Optional(
		Type.String({
			description: "Optional device name, typically for the iOS provider.",
			minLength: 1,
		}),
	),
	allowFileAccess: Type.Optional(Type.Boolean({ description: "Whether to allow `file://` pages to access local files." })),
	ignoreHttpsErrors: Type.Optional(Type.Boolean({ description: "Whether to ignore HTTPS certificate errors." })),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional HTTP headers to send for the navigated origin.",
		}),
	),
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

type BrowserSharedParams = {
	session?: string;
	headed?: boolean;
	provider?: Static<typeof BrowserProviderSchema>;
	engine?: Static<typeof BrowserEngineSchema>;
	sessionName?: string;
	profile?: string;
	state?: string;
	autoConnect?: boolean;
	cdp?: string;
	device?: string;
	allowFileAccess?: boolean;
	ignoreHttpsErrors?: boolean;
	headers?: Record<string, string>;
};

type BrowserToolParams = BrowserSharedParams & {
	command: BrowserCommandName;
	url?: string;
	ref?: string;
	text?: string;
	value?: string;
	values?: string[];
	startRef?: string;
	endRef?: string;
	files?: string[];
	index?: number;
	key?: string;
	x?: number;
	y?: number;
	dx?: number;
	dy?: number;
	button?: Static<typeof MouseButtonSchema>;
	direction?: Static<typeof BrowserScrollDirectionSchema>;
	amount?: number;
	selector?: string;
	target?: string;
	ms?: number;
	urlPattern?: string;
	loadState?: Static<typeof BrowserWaitLoadStateSchema>;
	expression?: string;
	waitState?: Static<typeof BrowserWaitStateSchema>;
	downloadPath?: string;
	timeout?: number;
	interactive?: boolean;
	urls?: boolean;
	compact?: boolean;
	depth?: number;
	annotate?: boolean;
	full?: boolean;
	insertText?: boolean;
	newTab?: boolean;
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

function outputDir(cwd: string): string {
	return join(cwd, ".agent-browser", EXTENSION_PREFIX);
}

function outputPath(cwd: string, toolCallId: string, extension: "png" | "pdf"): string {
	return join(outputDir(cwd), `${toolCallId}.${extension}`);
}

function describeCommand(command: BrowserCommandName, details: string[] = []): string {
	const parts = details.filter((detail) => detail.length > 0);
	return parts.length > 0 ? `${command} ${parts.join(" ")}` : command;
}

function requireStringField(
	params: BrowserToolParams,
	command: BrowserCommandName,
	field: "url" | "ref" | "text" | "value" | "startRef" | "endRef" | "key" | "selector" | "target" | "urlPattern" | "expression" | "downloadPath",
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
	field: "index" | "x" | "y" | "dx" | "dy" | "amount" | "ms" | "timeout" | "depth",
): number {
	const value = params[field];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	throw new Error(`browser ${command} requires \`${field}\`.`);
}

function requireStringArrayField(params: BrowserToolParams, command: BrowserCommandName, field: "files" | "values"): string[] {
	const value = params[field];
	if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)) {
		return value;
	}
	throw new Error(`browser ${command} requires \`${field}\`.`);
}

function summarizeValue(value: string, maxLength = 48): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return JSON.stringify(compact);
	}
	return JSON.stringify(`${compact.slice(0, maxLength - 3)}...`);
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

function pushBooleanFlag(argv: string[], flag: string, value: boolean | undefined): void {
	if (value === undefined) {
		return;
	}
	argv.push(flag);
	if (!value) {
		argv.push("false");
	}
}

function buildSharedArgs(params: BrowserSharedParams, sessionName: string): string[] {
	const argv = ["--session", sessionName];
	pushBooleanFlag(argv, "--headed", params.headed);
	if (params.provider) argv.push("--provider", params.provider);
	if (params.engine) argv.push("--engine", params.engine);
	if (params.sessionName) argv.push("--session-name", params.sessionName);
	if (params.profile) argv.push("--profile", params.profile);
	if (params.state) argv.push("--state", params.state);
	pushBooleanFlag(argv, "--auto-connect", params.autoConnect);
	if (params.cdp) argv.push("--cdp", params.cdp);
	if (params.device) argv.push("--device", params.device);
	pushBooleanFlag(argv, "--allow-file-access", params.allowFileAccess);
	pushBooleanFlag(argv, "--ignore-https-errors", params.ignoreHttpsErrors);
	if (params.headers && Object.keys(params.headers).length > 0) {
		argv.push("--headers", JSON.stringify(params.headers));
	}
	return argv;
}

function getSelectValues(params: BrowserToolParams): string[] {
	if (Array.isArray(params.values) && params.values.length > 0) {
		return requireStringArrayField(params, "select", "values");
	}
	if (typeof params.value === "string" && params.value.length > 0) {
		return [params.value];
	}
	throw new Error("browser select requires `value` or `values`.");
}

function buildWaitCommand(params: BrowserToolParams): PreparedCommand {
	const modes = [
		params.ms !== undefined ? "ms" : undefined,
		typeof params.target === "string" && params.target.length > 0 ? "target" : undefined,
		typeof params.text === "string" && params.text.length > 0 ? "text" : undefined,
		typeof params.urlPattern === "string" && params.urlPattern.length > 0 ? "urlPattern" : undefined,
		params.loadState ? "loadState" : undefined,
		typeof params.expression === "string" && params.expression.length > 0 ? "expression" : undefined,
		typeof params.downloadPath === "string" && params.downloadPath.length > 0 ? "downloadPath" : undefined,
	].filter(Boolean);
	if (modes.length !== 1) {
		throw new Error(
			"browser wait requires exactly one of `ms`, `target`, `text`, `urlPattern`, `loadState`, `expression`, or `downloadPath`.",
		);
	}
	if (params.waitState && !params.target) {
		throw new Error("browser wait only accepts `waitState` when `target` is provided.");
	}
	if (params.timeout !== undefined && !params.downloadPath) {
		throw new Error("browser wait only accepts `timeout` when `downloadPath` is provided.");
	}
	if (params.ms !== undefined) {
		const ms = requireNumberField(params, "wait", "ms");
		return { argv: ["wait", String(ms)], summary: describeCommand("wait", [`${ms}ms`]) };
	}
	if (params.target) {
		const target = requireStringField(params, "wait", "target");
		const argv = ["wait", target];
		if (params.waitState) {
			argv.push("--state", params.waitState);
		}
		return {
			argv,
			summary: describeCommand("wait", [target, params.waitState ? `state=${params.waitState}` : ""]),
		};
	}
	if (params.text) {
		const text = requireStringField(params, "wait", "text");
		return {
			argv: ["wait", "--text", text],
			summary: describeCommand("wait", [`text=${summarizeValue(text)}`]),
		};
	}
	if (params.urlPattern) {
		const urlPattern = requireStringField(params, "wait", "urlPattern");
		return {
			argv: ["wait", "--url", urlPattern],
			summary: describeCommand("wait", [`url=${summarizeValue(urlPattern)}`]),
		};
	}
	if (params.loadState) {
		return {
			argv: ["wait", "--load", params.loadState],
			summary: describeCommand("wait", [`load=${params.loadState}`]),
		};
	}
	if (params.expression) {
		requireStringField(params, "wait", "expression");
		return {
			argv: ["wait", "--fn", params.expression],
			summary: describeCommand("wait", ["fn"]),
		};
	}
	const downloadPath = requireStringField(params, "wait", "downloadPath");
	const argv = ["wait", "--download", downloadPath];
	if (params.timeout !== undefined) {
		argv.push("--timeout", String(requireNumberField(params, "wait", "timeout")));
	}
	return {
		argv,
		summary: describeCommand("wait", ["download"]),
	};
}

function buildCommand(params: BrowserToolParams, sessionName: string, toolCallId: string, cwd: string): PreparedCommand {
	const argv = buildSharedArgs(params, sessionName);

	switch (params.command) {
		case "goto": {
			const url = requireStringField(params, "goto", "url");
			argv.push("open", url);
			return { argv, summary: describeCommand("goto", [summarizeValue(url, 72)]) };
		}
		case "click": {
			const ref = requireStringField(params, "click", "ref");
			argv.push("click", ref);
			if (params.newTab) argv.push("--new-tab");
			return { argv, summary: describeCommand("click", [ref]) };
		}
		case "type": {
			const text = requireStringField(params, "type", "text");
			argv.push("keyboard", params.insertText ? "inserttext" : "type", text);
			return {
				argv,
				summary: describeCommand("type", [params.insertText ? "inserttext" : "", `${text.length} chars`]),
			};
		}
		case "fill": {
			const ref = requireStringField(params, "fill", "ref");
			const text = requireStringField(params, "fill", "text");
			argv.push("fill", ref, text);
			return { argv, summary: describeCommand("fill", [ref, `${text.length} chars`]) };
		}
		case "select": {
			const ref = requireStringField(params, "select", "ref");
			const values = getSelectValues(params);
			argv.push("select", ref, ...values);
			return {
				argv,
				summary: describeCommand("select", [ref, values.length === 1 ? summarizeValue(values[0]) : `${values.length} values`]),
			};
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
			const ref = requireStringField(params, "upload", "ref");
			const files = requireStringArrayField(params, "upload", "files");
			argv.push("upload", ref, ...files);
			return { argv, summary: describeCommand("upload", [ref, `${files.length} file${files.length === 1 ? "" : "s"}`]) };
		}
		case "scroll": {
			const direction = params.direction ?? "down";
			argv.push("scroll", direction);
			if (params.amount !== undefined) {
				argv.push(String(requireNumberField(params, "scroll", "amount")));
			}
			if (params.selector) {
				argv.push("--selector", params.selector);
			}
			return {
				argv,
				summary: describeCommand("scroll", [direction, params.amount !== undefined ? String(params.amount) : ""]),
			};
		}
		case "wait": {
			const waitCommand = buildWaitCommand(params);
			return {
				argv: [...argv, ...waitCommand.argv],
				summary: waitCommand.summary,
			};
		}
		case "close":
			argv.push("close");
			return { argv, summary: describeCommand("close") };
		case "snapshot": {
			argv.push("snapshot");
			if (params.interactive) argv.push("--interactive");
			if (params.urls) argv.push("--urls");
			if (params.compact) argv.push("--compact");
			if (params.depth !== undefined) argv.push("--depth", String(requireNumberField(params, "snapshot", "depth")));
			if (params.selector) argv.push("--selector", params.selector);
			return { argv, summary: describeCommand("snapshot", [params.interactive ? "interactive" : ""]) };
		}
		case "screenshot": {
			const path = outputPath(cwd, toolCallId, "png");
			argv.push("screenshot");
			if (params.ref) argv.push(params.ref);
			if (params.full) argv.push("--full");
			if (params.annotate) argv.push("--annotate");
			argv.push(path);
			return {
				argv,
				summary: describeCommand("screenshot", [
					params.ref ?? "",
					params.full ? "full" : "",
					params.annotate ? "annotate" : "",
				]),
				outputPath: path,
			};
		}
		case "pdf": {
			const path = outputPath(cwd, toolCallId, "pdf");
			argv.push("pdf", path);
			return { argv, summary: describeCommand("pdf"), outputPath: path };
		}
		case "go-back":
			argv.push("back");
			return { argv, summary: describeCommand("go-back") };
		case "go-forward":
			argv.push("forward");
			return { argv, summary: describeCommand("go-forward") };
		case "reload":
			argv.push("reload");
			return { argv, summary: describeCommand("reload") };
		case "tab-list":
			argv.push("tab", "list");
			return { argv, summary: describeCommand("tab-list") };
		case "tab-new":
			argv.push("tab", "new");
			if (params.url) argv.push(params.url);
			return { argv, summary: describeCommand("tab-new", params.url ? [summarizeValue(params.url, 72)] : []) };
		case "tab-select": {
			const index = requireNumberField(params, "tab-select", "index");
			argv.push("tab", String(index));
			return { argv, summary: describeCommand("tab-select", [String(index)]) };
		}
		case "tab-close":
			argv.push("tab", "close");
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
			argv.push("mouse", "move", String(x), String(y));
			return { argv, summary: describeCommand("mousemove", [String(x), String(y)]) };
		}
		case "mousedown":
			argv.push("mouse", "down");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mousedown", params.button ? [params.button] : []) };
		case "mouseup":
			argv.push("mouse", "up");
			if (params.button) argv.push(params.button);
			return { argv, summary: describeCommand("mouseup", params.button ? [params.button] : []) };
		case "mousewheel": {
			const dy = requireNumberField(params, "mousewheel", "dy");
			argv.push("mouse", "wheel", String(dy));
			if (params.dx !== undefined) argv.push(String(params.dx));
			return {
				argv,
				summary: describeCommand("mousewheel", [String(dy), params.dx !== undefined ? String(params.dx) : ""]),
			};
		}
	}
}

function parseCliResponse(stdout: string): AgentBrowserResponse | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as AgentBrowserResponse;
	} catch {
		return undefined;
	}
}

function formatUnknown(label: string, value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "string") {
		return truncateOutput(label, value);
	}
	try {
		return truncateOutput(label, JSON.stringify(value, null, 2));
	} catch {
		return truncateOutput(label, String(value));
	}
}

function formatCliError(response: AgentBrowserResponse | undefined, stdout: string, stderr: string): string {
	const parts = [
		formatUnknown("error", response?.error),
		formatUnknown("warning", response?.warning),
		truncateOutput("stderr", stderr),
		!response ? truncateOutput("stdout", stdout) : undefined,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	return parts.join("\n\n") || "agent-browser failed";
}

function extractResponseSections(
	response: AgentBrowserResponse | undefined,
	stdout: string,
	stderr: string,
	prepared: PreparedCommand,
): {
	output?: string;
	warnings?: string;
	snapshot?: string;
} {
	const data = response?.data;
	let output: string | undefined;
	let snapshot: string | undefined;

	if (data && typeof data === "object" && !Array.isArray(data)) {
		const record = { ...(data as Record<string, unknown>) };
		if (typeof record.snapshot === "string") {
			snapshot = truncateSnapshot(record.snapshot);
			delete record.snapshot;
			if (record.refs && typeof record.refs === "object" && !Array.isArray(record.refs)) {
				record.refCount = Object.keys(record.refs as Record<string, unknown>).length;
				delete record.refs;
			}
		}
		output = Object.keys(record).length > 0 ? formatUnknown("output", record) : undefined;
	} else if (response) {
		output = formatUnknown("output", data);
	} else if (stdout.trim()) {
		output = truncateOutput("stdout", stdout);
	}

	if (!output && prepared.outputPath) {
		output = formatUnknown("output", { path: prepared.outputPath });
	}

	const warnings =
		[
			formatUnknown("warning", response?.warning),
			truncateOutput("stderr", stderr),
		].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n\n") || undefined;

	return { output, warnings, snapshot };
}

async function resolveCli(pi: ExtensionAPI, state: DriverState, ctx: ExtensionContext): Promise<ResolvedCli> {
	if (state.resolvedCli) {
		return state.resolvedCli;
	}
	const result = await pi.exec(
		"bash",
		[
			"-lc",
			"if command -v agent-browser >/dev/null 2>&1; then printf 'agent-browser'; elif command -v npx >/dev/null 2>&1; then printf 'npx'; else exit 1; fi",
		],
		{ cwd: ctx.cwd, signal: ctx.signal, timeout: 5000 },
	);
	if (result.code !== 0) {
		throw new Error("agent-browser is not installed. Install it with npm install -g agent-browser && agent-browser install.");
	}
	const command = result.stdout.trim();
	state.resolvedCli = command === "agent-browser" ? { command, baseArgs: [] } : { command: "npx", baseArgs: ["-y", "agent-browser"] };
	return state.resolvedCli;
}

async function execCli(pi: ExtensionAPI, state: DriverState, ctx: ExtensionContext, argv: string[]): Promise<CliOutput> {
	const cli = await resolveCli(pi, state, ctx);
	const result = await pi.exec(cli.command, [...cli.baseArgs, "--json", ...argv], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 120000,
	});
	const response = parseCliResponse(result.stdout);
	if (result.code !== 0 || response?.success === false) {
		throw new Error(formatCliError(response, result.stdout, result.stderr));
	}
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		response,
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
		await mkdir(outputDir(ctx.cwd), { recursive: true });
		const sessionName = getSessionName(ctx, params);
		const prepared = buildCommand(params, sessionName, toolCallId, ctx.cwd);
		const output = await execCli(pi, state, ctx, prepared.argv);
		const sections = extractResponseSections(output.response, output.stdout, output.stderr, prepared);
		let image: ImageContent | undefined;
		if (params.command === "screenshot" && prepared.outputPath) {
			image = await readImage(prepared.outputPath);
		}
		const details: BrowserToolDetails = {
			command: params.command,
			sessionName,
			invocation: prepared.argv,
			summary: prepared.summary,
			stdout: sections.output,
			stderr: sections.warnings,
			outputPath: prepared.outputPath,
		};
		const content: (TextContent | ImageContent)[] = [formatContent(prepared.summary, sections.output, sections.warnings, sections.snapshot)];
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
		provider: params.provider,
		engine: params.engine,
		sessionName: params.sessionName,
		profile: params.profile,
		state: params.state,
		autoConnect: params.autoConnect,
		cdp: params.cdp,
		device: params.device,
		allowFileAccess: params.allowFileAccess,
		ignoreHttpsErrors: params.ignoreHttpsErrors,
		headers: params.headers,
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
		name: BROWSER_TOOL_NAMES.goto,
		label: "Browser Goto",
		description: "Navigate the current browser session to a URL with agent-browser.",
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
			ref: Type.String({ description: "Element ref, CSS selector, XPath, or other agent-browser locator." }),
			newTab: Type.Optional(Type.Boolean({ description: "Open a link target in a new tab instead of the current tab." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "click",
			ref: params.ref,
			newTab: params.newTab,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.type,
		label: "Browser Type",
		description: "Type text into the currently focused element.",
		parameters: toolSchema({
			text: Type.String({ description: "Text to type." }),
			insertText: Type.Optional(Type.Boolean({ description: "Insert text without key events." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "type",
			text: params.text,
			insertText: params.insertText,
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
		description: "Select one or more values in a dropdown.",
		parameters: toolSchema({
			ref: Type.String({ description: "Select element ref or selector." }),
			value: Type.Optional(Type.String({ description: "Single option value to select." })),
			values: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "One or more option values to select." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "select",
			ref: params.ref,
			value: params.value,
			values: params.values,
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
		description: "Upload one or more files to a file input.",
		parameters: toolSchema({
			ref: Type.String({ description: "File input ref or selector." }),
			files: Type.Array(Type.String(), { minItems: 1, description: "One or more file paths to upload." }),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "upload",
			ref: params.ref,
			files: params.files,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.scroll,
		label: "Browser Scroll",
		description: "Scroll the page or a specific scrollable container.",
		parameters: toolSchema({
			direction: Type.Optional(BrowserScrollDirectionSchema),
			amount: Type.Optional(Type.Number({ description: "Optional number of pixels to scroll.", minimum: 0 })),
			selector: Type.Optional(Type.String({ description: "Optional selector for a specific scrollable container." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "scroll",
			direction: params.direction,
			amount: params.amount,
			selector: params.selector,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.wait,
		label: "Browser Wait",
		description: "Wait for time, page text, a URL pattern, an element, a load state, or a download.",
		parameters: toolSchema({
			ms: Type.Optional(Type.Number({ description: "Milliseconds to wait.", minimum: 0 })),
			target: Type.Optional(Type.String({ description: "Element ref or selector to wait for." })),
			text: Type.Optional(Type.String({ description: "Page text to wait for." })),
			urlPattern: Type.Optional(Type.String({ description: "URL pattern to wait for." })),
			loadState: Type.Optional(BrowserWaitLoadStateSchema),
			expression: Type.Optional(Type.String({ description: "JavaScript expression to wait for." })),
			waitState: Type.Optional(BrowserWaitStateSchema),
			downloadPath: Type.Optional(Type.String({ description: "Path to save the next download to." })),
			timeout: Type.Optional(Type.Number({ description: "Optional download timeout in milliseconds.", minimum: 0 })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "wait",
			ms: params.ms,
			target: params.target,
			text: params.text,
			urlPattern: params.urlPattern,
			loadState: params.loadState,
			expression: params.expression,
			waitState: params.waitState,
			downloadPath: params.downloadPath,
			timeout: params.timeout,
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
		description: "Capture an accessibility snapshot of the current page with refs.",
		parameters: toolSchema({
			interactive: Type.Optional(Type.Boolean({ description: "Only include interactive elements." })),
			urls: Type.Optional(Type.Boolean({ description: "Include href URLs for links in the snapshot." })),
			compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements." })),
			depth: Type.Optional(Type.Number({ description: "Optional maximum tree depth.", minimum: 1 })),
			selector: Type.Optional(Type.String({ description: "Optional selector to scope the snapshot." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "snapshot",
			interactive: params.interactive,
			urls: params.urls,
			compact: params.compact,
			depth: params.depth,
			selector: params.selector,
		}),
	});

	registerBrowserTool(pi, state, {
		name: BROWSER_TOOL_NAMES.screenshot,
		label: "Browser Screenshot",
		description: "Capture a screenshot of the current page or an element.",
		parameters: toolSchema({
			ref: Type.Optional(Type.String({ description: "Optional element ref or selector for an element screenshot." })),
			full: Type.Optional(Type.Boolean({ description: "Capture the full page instead of only the viewport." })),
			annotate: Type.Optional(Type.Boolean({ description: "Overlay numbered labels that line up with snapshot refs." })),
		}),
		toBrowserParams: (params) => ({
			...getSharedParams(params),
			command: "screenshot",
			ref: params.ref,
			full: params.full,
			annotate: params.annotate,
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
			index: Type.Optional(Type.Number({ description: "Tab index for `select`. Optional for `close`.", minimum: 0 })),
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
			dx: Type.Optional(Type.Number({ description: "Optional horizontal wheel delta for `wheel`." })),
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
					if (params.dy === undefined) {
						throw new Error("browser_mouse with action `wheel` requires `dy`.");
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
