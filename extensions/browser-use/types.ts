import { StringEnum } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

export const BrowserNameSchema = StringEnum(["chrome", "firefox", "webkit", "msedge"] as const, {
	description: "Browser engine for playwright-cli.",
});

export const MouseButtonSchema = StringEnum(["left", "right", "middle"] as const, {
	description: "Mouse button to use for click and mouse commands.",
});

export const BrowserCommandNames = [
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

export type BrowserCommandName = (typeof BrowserCommandNames)[number];

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

function commandSchema<TName extends BrowserCommandName, TArgs extends TSchema>(name: TName, args: TArgs) {
	return Type.Object(
		{
			command: Type.Literal(name),
			args,
			...SharedCommandFields,
		},
		{ additionalProperties: false },
	);
}

export const BrowserToolParamsSchema = Type.Union([
	commandSchema(
		"open",
		Type.Object(
			{
				url: Type.Optional(Type.String({ description: "Optional URL to open immediately." })),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"goto",
		Type.Object(
			{
				url: Type.String({ description: "URL to navigate to." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"click",
		Type.Object(
			{
				ref: Type.String({ description: "Element ref, CSS selector, or role selector." }),
				button: Type.Optional(MouseButtonSchema),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"type",
		Type.Object(
			{
				text: Type.String({ description: "Text to type into the focused editable element." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"fill",
		Type.Object(
			{
				ref: Type.String({ description: "Element ref or selector to fill." }),
				text: Type.String({ description: "Replacement text." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"select",
		Type.Object(
			{
				ref: Type.String({ description: "Element ref or selector for the select element." }),
				value: Type.String({ description: "Option value to select." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"check",
		Type.Object(
			{
				ref: Type.String({ description: "Checkbox or radio ref/selector." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"uncheck",
		Type.Object(
			{
				ref: Type.String({ description: "Checkbox ref/selector." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"hover",
		Type.Object(
			{
				ref: Type.String({ description: "Element ref or selector to hover." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"drag",
		Type.Object(
			{
				startRef: Type.String({ description: "Source element ref or selector." }),
				endRef: Type.String({ description: "Target element ref or selector." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"upload",
		Type.Object(
			{
				file: Type.String({ description: "File path to upload." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema("close", Type.Object({}, { additionalProperties: false })),
	commandSchema("snapshot", Type.Object({}, { additionalProperties: false })),
	commandSchema(
		"screenshot",
		Type.Object(
			{
				ref: Type.Optional(Type.String({ description: "Optional element ref or selector for element screenshot." })),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema("pdf", Type.Object({}, { additionalProperties: false })),
	commandSchema("go-back", Type.Object({}, { additionalProperties: false })),
	commandSchema("go-forward", Type.Object({}, { additionalProperties: false })),
	commandSchema("reload", Type.Object({}, { additionalProperties: false })),
	commandSchema("tab-list", Type.Object({}, { additionalProperties: false })),
	commandSchema(
		"tab-new",
		Type.Object(
			{
				url: Type.Optional(Type.String({ description: "Optional URL for the new tab." })),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"tab-select",
		Type.Object(
			{
				index: Type.Number({ description: "Tab index to activate." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"tab-close",
		Type.Object(
			{
				index: Type.Optional(Type.Number({ description: "Optional tab index to close. Defaults to the active tab." })),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"press",
		Type.Object(
			{
				key: Type.String({ description: "Keyboard key name, such as Enter or ArrowDown." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"keydown",
		Type.Object(
			{
				key: Type.String({ description: "Keyboard key name to press down." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"keyup",
		Type.Object(
			{
				key: Type.String({ description: "Keyboard key name to release." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"mousemove",
		Type.Object(
			{
				x: Type.Number({ description: "X coordinate in CSS pixels." }),
				y: Type.Number({ description: "Y coordinate in CSS pixels." }),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"mousedown",
		Type.Object(
			{
				button: Type.Optional(MouseButtonSchema),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"mouseup",
		Type.Object(
			{
				button: Type.Optional(MouseButtonSchema),
			},
			{ additionalProperties: false },
		),
	),
	commandSchema(
		"mousewheel",
		Type.Object(
			{
				dx: Type.Number({ description: "Horizontal wheel delta." }),
				dy: Type.Number({ description: "Vertical wheel delta." }),
			},
			{ additionalProperties: false },
		),
	),
]);

export type BrowserToolParams = Static<typeof BrowserToolParamsSchema>;

export interface BrowserToolDetails {
	command: BrowserCommandName;
	sessionName: string;
	invocation: string[];
	summary: string;
	stdout?: string;
	stderr?: string;
	outputPath?: string;
	snapshotPath?: string;
}
