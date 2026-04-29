import { createRequire } from "node:module";
import { type Message, type TextContent, type ToolResultMessage } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

const EXTENSION_NAME = "browser-use";
const BROWSER_TOOL_NAME = "browser";
const DEFAULT_WAIT_MS = 1000;
const DEFAULT_SCROLL_Y = 600;
const DEFAULT_BROWSER_PROMPT_SNIPPET =
	"`browser`: interact with a Chromium browser using Playwright AI accessibility-tree refs. Batch stable actions; every successful call returns the latest accessibility tree after all requested actions.";
const DEFAULT_BROWSER_GUIDELINES = [
	"Use only the `browser` tool for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"Use `goto` first, then use refs from the returned accessibility tree for `click`, `fill`, `press`, and `scroll` actions.",
	"Every successful browser call returns a fresh accessibility tree after the full action batch completes.",
	"Batch actions that use refs already present in the latest tree and are expected to stay stable, such as filling visible fields, pressing keys in a focused field, toggling checkboxes, scrolling, waiting, and saving.",
	"Stop the batch and use the returned snapshot after actions that reveal or replace UI, such as opening menus, clicking New, adding rows, selecting autocomplete values, navigating, or opening dialogs.",
	"If an action fails, use the returned error details and latest accessibility tree to recover.",
	"Refs are regenerated after each browser call. Use exact refs from the latest browser result, such as `e3`.",
	"Do not predict screen coordinates or rely on screenshots. The browser tool is text-only.",
];

const LoadStateSchema = Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")]);
const ScrollDirectionSchema = Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]);

const browserToolParameters = Type.Object(
	{
		headed: Type.Optional(Type.Boolean({ description: "Whether to show the Chromium window." })),
		actions: Type.Array(
			Type.Union([
				Type.Object({ type: Type.Literal("goto"), url: Type.String({ description: "URL to navigate to." }) }, { additionalProperties: false }),
				Type.Object({ type: Type.Literal("snapshot") }, { additionalProperties: false }),
				Type.Object({ type: Type.Literal("click"), ref: Type.String({ description: "Ref from the latest accessibility tree, such as e3." }) }, { additionalProperties: false }),
				Type.Object(
					{
						type: Type.Literal("fill"),
						ref: Type.String({ description: "Editable ref from the latest accessibility tree." }),
						text: Type.String({ description: "Replacement text." }),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						type: Type.Literal("press"),
						key: Type.String({ description: "Keyboard key name, such as Enter, Tab, or ArrowDown." }),
						ref: Type.Optional(Type.String({ description: "Optional ref to focus before pressing the key." })),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						type: Type.Literal("scroll"),
						ref: Type.Optional(Type.String({ description: "Optional scrollable ref. If omitted, scrolls the page." })),
						direction: Type.Optional(ScrollDirectionSchema),
						amount: Type.Optional(Type.Number({ description: "Scroll amount in pixels.", minimum: 0 })),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						type: Type.Literal("wait"),
						ms: Type.Optional(Type.Number({ description: "Milliseconds to wait.", minimum: 0 })),
						loadState: Type.Optional(LoadStateSchema),
					},
					{ additionalProperties: false },
				),
			]),
			{ minItems: 1, maxItems: 7, description: "Browser actions to execute sequentially." },
		),
	},
	{ additionalProperties: false },
);

type BrowserToolCallParams = Static<typeof browserToolParameters>;
type BrowserAction = BrowserToolCallParams["actions"][number];
type LoadState = Static<typeof LoadStateSchema>;
type ScrollDirection = Static<typeof ScrollDirectionSchema>;

interface BrowserToolDetails {
	actions: Array<{ type: BrowserAction["type"]; summary: string }>;
	title: string;
	url: string;
	error?: string;
	failedActionIndex?: number;
	failedActionSummary?: string;
}

interface BrowserToolResult {
	content: TextContent[];
	details: BrowserToolDetails;
	isError?: boolean;
}

interface BrowserType {
	launch(options: { headless: boolean }): Promise<Browser>;
}

interface Browser {
	newContext(): Promise<BrowserContext>;
	close(): Promise<void>;
}

interface BrowserContext {
	newPage(): Promise<Page>;
	close(): Promise<void>;
}

interface Page {
	ariaSnapshot(options: { mode: "ai" }): Promise<string>;
	goto(url: string, options?: { waitUntil?: LoadState }): Promise<unknown>;
	title(): Promise<string>;
	url(): string;
	waitForLoadState(state: LoadState): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	evaluate<TArg>(pageFunction: (arg: TArg) => unknown, arg: TArg): Promise<unknown>;
	locator(selector: string): Locator;
	keyboard: { press(key: string): Promise<void> };
}

interface Locator {
	click(): Promise<void>;
	fill(text: string): Promise<void>;
	focus(): Promise<void>;
	evaluate<TArg>(pageFunction: (element: Element, arg: TArg) => unknown, arg: TArg): Promise<unknown>;
}

interface DriverState {
	activeToolCallId?: string;
	browser?: Browser;
	context?: BrowserContext;
	page?: Page;
	headed?: boolean;
}

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as { chromium: BrowserType };

function shouldBlockTool(event: ToolCallEvent): boolean {
	return event.toolName !== BROWSER_TOOL_NAME;
}

function refLocator(page: Page, ref: string): Locator {
	return page.locator(`aria-ref=${ref}`);
}

function errorToString(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function truncateSnapshot(text: string): string {
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return truncation.content.trim();
	let content = truncation.content.trim();
	content += `\n\n[Accessibility tree truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	return content;
}

async function ensureDriver(state: DriverState, headed: boolean | undefined): Promise<Page> {
	if (state.page) {
		if (headed !== undefined && headed !== state.headed) throw new Error("Browser is already running; `headed` can only be set on the first browser call.");
		return state.page;
	}
	state.headed = headed ?? false;
	state.browser = await chromium.launch({ headless: !state.headed });
	state.context = await state.browser.newContext();
	state.page = await state.context.newPage();
	return state.page;
}

async function closeDriver(state: DriverState): Promise<void> {
	const { browser, context } = state;
	state.browser = undefined;
	state.context = undefined;
	state.page = undefined;
	await context?.close().catch(() => undefined);
	await browser?.close().catch(() => undefined);
}

async function clickRef(page: Page, ref: string): Promise<void> {
	await refLocator(page, ref).click();
}

async function fillRef(page: Page, ref: string, text: string): Promise<void> {
	await refLocator(page, ref).fill(text);
}

async function focusRef(page: Page, ref: string): Promise<void> {
	await refLocator(page, ref).focus();
}

function scrollDelta(direction: ScrollDirection | undefined, amount: number | undefined): { x: number; y: number } {
	const value = amount ?? DEFAULT_SCROLL_Y;
	switch (direction ?? "down") {
		case "up":
			return { x: 0, y: -value };
		case "left":
			return { x: -value, y: 0 };
		case "right":
			return { x: value, y: 0 };
		case "down":
			return { x: 0, y: value };
	}
	throw new Error(`Unsupported scroll direction: ${String(direction)}`);
}

async function scrollRef(page: Page, ref: string, direction: ScrollDirection | undefined, amount: number | undefined): Promise<void> {
	const delta = scrollDelta(direction, amount);
	await refLocator(page, ref).evaluate((element, value) => {
		element.scrollIntoView({ block: "center", inline: "center" });
		element.scrollBy(value.x, value.y);
	}, delta);
}

async function scrollPage(page: Page, direction: ScrollDirection | undefined, amount: number | undefined): Promise<void> {
	const delta = scrollDelta(direction, amount);
	await page.evaluate((value) => {
		const target = globalThis as { scrollBy?: (x: number, y: number) => void };
		target.scrollBy?.(value.x, value.y);
	}, delta);
}

async function renderAccessibilityTree(page: Page): Promise<string> {
	const snapshot = await page.ariaSnapshot({ mode: "ai" });
	return truncateSnapshot(snapshot || "(accessibility tree is empty)");
}

async function buildBrowserToolResult(
	page: Page,
	summaries: Array<{ type: BrowserAction["type"]; summary: string }>,
	errorDetails?: { error: string; failedActionIndex: number; failedActionSummary: string },
): Promise<BrowserToolResult> {
	const [title, snapshot] = await Promise.all([page.title(), renderAccessibilityTree(page)]);
	const url = page.url();
	const sections = [
		errorDetails
			? `Action ${errorDetails.failedActionIndex + 1} failed: ${errorDetails.failedActionSummary}\nError: ${errorDetails.error}`
			: undefined,
		summaries.map((entry, index) => `${index + 1}. ${entry.summary}`).join("\n"),
		`URL: ${url}`,
		`Title: ${title || "(untitled)"}`,
		`Accessibility tree:\n${snapshot}`,
	].filter((section): section is string => typeof section === "string" && section.length > 0);
	return {
		content: [{ type: "text", text: sections.join("\n\n") }],
		details: {
			actions: summaries,
			title,
			url,
			error: errorDetails?.error,
			failedActionIndex: errorDetails?.failedActionIndex,
			failedActionSummary: errorDetails?.failedActionSummary,
		},
		isError: errorDetails !== undefined,
	};
}

function actionSummary(action: BrowserAction): string {
	switch (action.type) {
		case "goto":
			return `Opened ${JSON.stringify(action.url)}`;
		case "snapshot":
			return "Captured accessibility tree";
		case "click":
			return `Clicked ${action.ref}`;
		case "fill":
			return `Filled ${action.ref} with ${action.text.length} characters`;
		case "press":
			return action.ref ? `Focused ${action.ref} and pressed ${action.key}` : `Pressed ${action.key}`;
		case "scroll":
			return action.ref ? `Scrolled ${action.ref}` : "Scrolled page";
		case "wait":
			return action.loadState ? `Waited for ${action.loadState}` : `Waited ${action.ms ?? DEFAULT_WAIT_MS}ms`;
	}
	throw new Error("Unsupported browser action.");
}

function isBrowserToolResult(message: Message): message is ToolResultMessage<BrowserToolDetails> {
	return message.role === "toolResult" && message.toolName === BROWSER_TOOL_NAME;
}

function latestBrowserToolResultIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isBrowserToolResult(messages[index])) return index;
	}
	return -1;
}

function fallbackErrorText(message: ToolResultMessage<BrowserToolDetails>): string | undefined {
	if (!message.isError) return undefined;
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text.split("\n\nAccessibility tree:")[0]?.trim())
		.find((text) => text && text.length > 0);
}

function collapseBrowserToolResult(message: ToolResultMessage<BrowserToolDetails>): ToolResultMessage<BrowserToolDetails> {
	const details = message.details;
	const error = details?.error ?? fallbackErrorText(message);
	const summary = [
		"Previous browser result collapsed. The latest browser result contains the current accessibility tree.",
		error ? `Error: ${error}` : undefined,
		details?.failedActionIndex !== undefined ? `Failed action index: ${details.failedActionIndex}` : undefined,
		details?.failedActionSummary ? `Failed action: ${details.failedActionSummary}` : undefined,
		details?.actions.length ? `Actions: ${details.actions.map((action) => action.summary).join("; ")}` : undefined,
		details?.url ? `URL: ${details.url}` : undefined,
		details?.title ? `Title: ${details.title}` : undefined,
	].filter((line): line is string => typeof line === "string" && line.length > 0);
	return {
		...message,
		content: [{ type: "text", text: summary.join("\n") }],
	};
}

async function executeAction(page: Page, action: BrowserAction): Promise<void> {
	switch (action.type) {
		case "goto":
			await page.goto(action.url, { waitUntil: "domcontentloaded" });
			break;
		case "snapshot":
			break;
		case "click":
			await clickRef(page, action.ref);
			break;
		case "fill":
			await fillRef(page, action.ref, action.text);
			break;
		case "press":
			if (action.ref) await focusRef(page, action.ref);
			await page.keyboard.press(action.key);
			break;
		case "scroll":
			if (action.ref) await scrollRef(page, action.ref, action.direction, action.amount);
			else await scrollPage(page, action.direction, action.amount);
			break;
		case "wait":
			if (action.ms !== undefined && action.loadState !== undefined) throw new Error("browser wait accepts either `ms` or `loadState`, not both.");
			if (action.loadState) await page.waitForLoadState(action.loadState);
			else await page.waitForTimeout(action.ms ?? DEFAULT_WAIT_MS);
			break;
	}
}

async function runBrowserTool(
	state: DriverState,
	toolCallId: string,
	params: BrowserToolCallParams,
): Promise<BrowserToolResult> {
	if (state.activeToolCallId && state.activeToolCallId !== toolCallId) throw new Error("Browser tool does not allow parallel execution.");
	state.activeToolCallId = toolCallId;
	try {
		const page = await ensureDriver(state, params.headed);
		const summaries: Array<{ type: BrowserAction["type"]; summary: string }> = [];
		for (const [index, action] of params.actions.entries()) {
			const summary = actionSummary(action);
			try {
				await executeAction(page, action);
				summaries.push({ type: action.type, summary });
			} catch (error) {
				return buildBrowserToolResult(page, summaries, {
					error: errorToString(error),
					failedActionIndex: index,
					failedActionSummary: summary,
				});
			}
		}
		return buildBrowserToolResult(page, summaries);
	} finally {
		if (state.activeToolCallId === toolCallId) state.activeToolCallId = undefined;
	}
}

export default function registerBrowserUseExtension(pi: ExtensionAPI): void {
	const state: DriverState = {};

	pi.registerTool({
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description: "Interact with Chromium using Playwright AI accessibility-tree refs. Successful calls always return the latest snapshot.",
		promptSnippet: DEFAULT_BROWSER_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_BROWSER_GUIDELINES,
		parameters: browserToolParameters,
		async execute(toolCallId, params) {
			return runBrowserTool(state, toolCallId, params);
		},
	});

	pi.on("session_start", () => {
		pi.setActiveTools([BROWSER_TOOL_NAME]);
	});

	pi.on("session_shutdown", async () => {
		await closeDriver(state);
	});

	pi.on("context", async (event) => {
		const messages = event.messages as Message[];
		const latestBrowserIndex = latestBrowserToolResultIndex(messages);
		if (latestBrowserIndex === -1) return;
		return {
			messages: messages.map((message, index) => {
				if (index === latestBrowserIndex || !isBrowserToolResult(message)) return message;
				return collapseBrowserToolResult(message);
			}),
		};
	});

	pi.on("tool_call", async (event) => {
		if (!shouldBlockTool(event)) return;
		return { block: true, reason: `${EXTENSION_NAME} enforces browser-only mode. ${event.toolName} is disabled.` };
	});
}
