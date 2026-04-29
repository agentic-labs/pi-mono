import { createRequire } from "node:module";
import { type TextContent } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ToolCallEvent,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "browser-use";
const BROWSER_TOOL_NAME = "browser";
const REF_ATTRIBUTE = "data-pi-browser-ref";
const DEFAULT_WAIT_MS = 1000;
const DEFAULT_SCROLL_Y = 600;
const DEFAULT_BROWSER_PROMPT_SNIPPET =
	"`browser`: interact with a Chromium browser using text-only accessibility-tree refs. Use this instead of shell tools.";
const DEFAULT_BROWSER_GUIDELINES = [
	"Use only the `browser` tool for browser interaction. Do not attempt to use bash, read, edit, write, grep, find, or ls.",
	"Use `goto` first, then use refs from the returned accessibility tree for `click`, `fill`, `press`, and `scroll` actions.",
	"Refs are regenerated after each browser call. Use only refs from the latest browser result.",
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
	refCount: number;
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
	newCDPSession(page: Page): Promise<CdpSession>;
	close(): Promise<void>;
}

interface Page {
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

interface CdpSession {
	send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	detach(): Promise<void>;
}

interface DriverState {
	activeToolCallId?: string;
	browser?: Browser;
	context?: BrowserContext;
	page?: Page;
	cdp?: CdpSession;
	headed?: boolean;
	refMap: Map<string, number>;
}

interface AXValue {
	value?: unknown;
}

interface AXProperty {
	name: string;
	value?: AXValue;
}

interface AXNode {
	nodeId: string;
	ignored: boolean;
	role?: AXValue;
	name?: AXValue;
	description?: AXValue;
	value?: AXValue;
	properties?: AXProperty[];
	parentId?: string;
	childIds?: string[];
	backendDOMNodeId?: number;
}

interface GetFullAXTreeResponse {
	nodes: AXNode[];
}

interface ResolveNodeResponse {
	object: { objectId?: string };
}

interface CallFunctionOnResponse {
	exceptionDetails?: {
		text?: string;
		exception?: {
			description?: string;
			value?: unknown;
		};
	};
}

const ACTIONABLE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"scrollbar",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);
const TEXT_ROLES = new Set(["heading", "image", "img", "paragraph", "StaticText", "text", "LabelText", "listitem", "cell"]);
const STATE_NAMES = new Set(["checked", "disabled", "editable", "expanded", "focusable", "focused", "pressed", "required", "selected"]);

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as { chromium: BrowserType };

function shouldBlockTool(event: ToolCallEvent): boolean {
	return event.toolName !== BROWSER_TOOL_NAME;
}

function normalizeRef(ref: string): string {
	return ref.startsWith("@") ? ref.slice(1) : ref;
}

function axValueToString(value: AXValue | undefined): string {
	const raw = value?.value;
	if (typeof raw === "string") return raw.trim();
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return "";
}

function axValueToBoolean(value: AXValue | undefined): boolean {
	return value?.value === true || value?.value === "true";
}

function getProperty(node: AXNode, name: string): AXProperty | undefined {
	return node.properties?.find((property) => property.name === name);
}

function hasInterestingState(node: AXNode): boolean {
	return (node.properties ?? []).some((property) => STATE_NAMES.has(property.name) && axValueToString(property.value).length > 0);
}

function isActionable(node: AXNode): boolean {
	const role = axValueToString(node.role);
	return (
		ACTIONABLE_ROLES.has(role) ||
		axValueToBoolean(getProperty(node, "editable")?.value) ||
		axValueToBoolean(getProperty(node, "focusable")?.value) ||
		axValueToBoolean(getProperty(node, "selectable")?.value)
	);
}

function hasTextContent(node: AXNode): boolean {
	return [node.name, node.value, node.description].some((value) => axValueToString(value).length > 0);
}

function shouldRenderNode(node: AXNode): boolean {
	if (node.ignored) return false;
	const role = axValueToString(node.role);
	if (!role || role === "none" || role === "presentation") return false;
	return isActionable(node) || TEXT_ROLES.has(role) || hasTextContent(node) || hasInterestingState(node);
}

function shouldRefNode(node: AXNode): boolean {
	return !node.ignored && typeof node.backendDOMNodeId === "number" && isActionable(node);
}

function formatNodeLine(node: AXNode, ref: string | undefined): string {
	const role = axValueToString(node.role) || "node";
	const parts = ref ? [`[${ref}]`, role] : [role];
	const name = axValueToString(node.name);
	const value = axValueToString(node.value);
	const description = axValueToString(node.description);
	if (name) parts.push(JSON.stringify(name));
	if (value && value !== name) parts.push(`value=${JSON.stringify(value)}`);
	if (description && description !== name) parts.push(`description=${JSON.stringify(description)}`);
	for (const property of node.properties ?? []) {
		if (!STATE_NAMES.has(property.name)) continue;
		const propertyValue = axValueToString(property.value);
		if (propertyValue) parts.push(`${property.name}=${propertyValue}`);
	}
	return parts.join(" ");
}

function truncateSnapshot(text: string): string {
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return truncation.content.trim();
	let content = truncation.content.trim();
	content += `\n\n[Accessibility tree truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	return content;
}

async function ensureDriver(state: DriverState, headed: boolean | undefined): Promise<{ page: Page; cdp: CdpSession }> {
	if (state.page && state.cdp) {
		if (headed !== undefined && headed !== state.headed) throw new Error("Browser is already running; `headed` can only be set on the first browser call.");
		return { page: state.page, cdp: state.cdp };
	}
	state.headed = headed ?? false;
	try {
		state.browser = await chromium.launch({ headless: !state.headed });
		state.context = await state.browser.newContext();
		state.page = await state.context.newPage();
		state.cdp = await state.context.newCDPSession(state.page);
		return { page: state.page, cdp: state.cdp };
	} catch (error) {
		await closeDriver(state);
		throw error;
	}
}

async function closeDriver(state: DriverState): Promise<void> {
	const { browser, cdp, context } = state;
	state.browser = undefined;
	state.context = undefined;
	state.page = undefined;
	state.cdp = undefined;
	state.refMap.clear();
	await cdp?.detach().catch(() => undefined);
	await context?.close().catch(() => undefined);
	await browser?.close().catch(() => undefined);
}

async function resolveObjectId(cdp: CdpSession, backendDOMNodeId: number): Promise<string> {
	const response = await cdp.send<ResolveNodeResponse>("DOM.resolveNode", { backendNodeId: backendDOMNodeId });
	if (!response.object.objectId) throw new Error("Ref no longer resolves to a DOM node.");
	return response.object.objectId;
}

async function clearRefMarkers(page: Page): Promise<void> {
	await page.evaluate((attribute) => {
		for (const element of Array.from(document.querySelectorAll(`[${attribute}]`))) {
			element.removeAttribute(attribute);
		}
	}, REF_ATTRIBUTE);
}

function locatorForRef(page: Page, ref: string): Locator {
	return page.locator(`[${REF_ATTRIBUTE}="${ref}"]`);
}

async function markRef(state: DriverState, page: Page, ref: string): Promise<Locator> {
	if (!state.cdp) throw new Error("Browser is not running.");
	const normalizedRef = normalizeRef(ref);
	const backendDOMNodeId = state.refMap.get(normalizedRef);
	if (backendDOMNodeId === undefined) throw new Error(`Unknown browser ref ${ref}. Use a ref from the latest browser result.`);
	await clearRefMarkers(page);
	const objectId = await resolveObjectId(state.cdp, backendDOMNodeId);
	const response = await state.cdp.send<CallFunctionOnResponse>("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: `function (attribute, ref) {
			if (!(this instanceof Element)) throw new Error("Ref does not resolve to an Element.");
			this.setAttribute(attribute, ref);
		}`,
		arguments: [{ value: REF_ATTRIBUTE }, { value: normalizedRef }],
		awaitPromise: true,
	});
	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Failed to mark browser ref.");
	}
	return locatorForRef(page, normalizedRef);
}

async function clickRef(state: DriverState, page: Page, ref: string): Promise<void> {
	await (await markRef(state, page, ref)).click();
}

async function fillRef(state: DriverState, page: Page, ref: string, text: string): Promise<void> {
	await (await markRef(state, page, ref)).fill(text);
}

async function focusRef(state: DriverState, page: Page, ref: string): Promise<void> {
	await (await markRef(state, page, ref)).focus();
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

async function scrollRef(state: DriverState, page: Page, ref: string, direction: ScrollDirection | undefined, amount: number | undefined): Promise<void> {
	const delta = scrollDelta(direction, amount);
	const locator = await markRef(state, page, ref);
	await locator.evaluate((element, value) => {
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

async function renderAccessibilityTree(page: Page, cdp: CdpSession, state: DriverState): Promise<{ text: string; refCount: number }> {
	await clearRefMarkers(page);
	const response = await cdp.send<GetFullAXTreeResponse>("Accessibility.getFullAXTree");
	const nodesById = new Map(response.nodes.map((node) => [node.nodeId, node]));
	const roots = response.nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
	const lines: string[] = [];
	const nextRefMap = new Map<string, number>();
	let refIndex = 0;
	const visited = new Set<string>();

	const visit = (node: AXNode, depth: number): void => {
		if (visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		const renderSelf = shouldRenderNode(node);
		const ref = renderSelf && shouldRefNode(node) ? `e${++refIndex}` : undefined;
		if (ref && node.backendDOMNodeId !== undefined) nextRefMap.set(ref, node.backendDOMNodeId);
		if (renderSelf) lines.push(`${"  ".repeat(depth)}- ${formatNodeLine(node, ref)}`);
		const childDepth = renderSelf ? depth + 1 : depth;
		for (const childId of node.childIds ?? []) {
			const child = nodesById.get(childId);
			if (child) visit(child, childDepth);
		}
	};

	for (const root of roots) visit(root, 0);
	state.refMap = nextRefMap;
	return { text: truncateSnapshot(lines.join("\n") || "(accessibility tree is empty)"), refCount: nextRefMap.size };
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

async function executeAction(state: DriverState, page: Page, action: BrowserAction): Promise<void> {
	switch (action.type) {
		case "goto":
			await page.goto(action.url, { waitUntil: "domcontentloaded" });
			break;
		case "snapshot":
			break;
		case "click":
			await clickRef(state, page, action.ref);
			break;
		case "fill":
			await fillRef(state, page, action.ref, action.text);
			break;
		case "press":
			if (action.ref) await focusRef(state, page, action.ref);
			await page.keyboard.press(action.key);
			break;
		case "scroll":
			if (action.ref) await scrollRef(state, page, action.ref, action.direction, action.amount);
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
): Promise<{ content: TextContent[]; details: BrowserToolDetails }> {
	if (state.activeToolCallId && state.activeToolCallId !== toolCallId) throw new Error("Browser tool does not allow parallel execution.");
	state.activeToolCallId = toolCallId;
	try {
		const { page, cdp } = await ensureDriver(state, params.headed);
		const summaries: Array<{ type: BrowserAction["type"]; summary: string }> = [];
		for (const action of params.actions) {
			await executeAction(state, page, action);
			summaries.push({ type: action.type, summary: actionSummary(action) });
		}
		const [title, snapshot] = await Promise.all([page.title(), renderAccessibilityTree(page, cdp, state)]);
		const url = page.url();
		const sections = [
			summaries.map((entry, index) => `${index + 1}. ${entry.summary}`).join("\n"),
			`URL: ${url}`,
			`Title: ${title || "(untitled)"}`,
			`Refs: ${snapshot.refCount}`,
			`Accessibility tree:\n${snapshot.text}`,
		].filter((section) => section.length > 0);
		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: { actions: summaries, title, url, refCount: snapshot.refCount },
		};
	} finally {
		if (state.activeToolCallId === toolCallId) state.activeToolCallId = undefined;
	}
}

export default function registerBrowserUseExtension(pi: ExtensionAPI): void {
	const state: DriverState = { refMap: new Map() };

	pi.registerTool({
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description: "Interact with Chromium using a text-only accessibility tree and ref-based actions.",
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

	pi.on("tool_call", async (event) => {
		if (!shouldBlockTool(event)) return;
		return { block: true, reason: `${EXTENSION_NAME} enforces browser-only mode. ${event.toolName} is disabled.` };
	});
}
