/**
 * pi-reviewer — Post-task critique extension
 *
 * At the end of every task (agent_settled), prompts the user to run a
 * multi-area code review. The /review command triggers the same flow
 * manually.  Each of the 7 areas is evaluated with its own specialized
 * system prompt.
 *
 * Areas:
 *   general      – Did the implementation satisfy the original task?
 *   security     – Did it introduce security vulnerabilities?
 *   code_quality – Is it maintainable and consistent with the codebase?
 *   ui_ux        – Is the user-facing implementation complete?
 *   testing      – Is it adequately tested?
 *   performance  – Could it cause performance problems?
 *   scope        – Did the agent change more than it should have?
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Review area definitions
// ---------------------------------------------------------------------------

interface ReviewArea {
	id: string;
	label: string;
	description: string;
	systemPrompt: string;
}

const REVIEW_AREAS: ReviewArea[] = [
	{
		id: "general",
		label: "General Task Review",
		description: "Verify the implementation satisfied the original task",
		systemPrompt: `You are a senior code reviewer conducting a GENERAL TASK REVIEW.

QUESTION: Did the implementation actually satisfy the original task?

Check every aspect below and give concrete examples from the conversation:

1. Requirements completed — Were ALL stated requirements addressed?
2. Missing functionality — Is anything the user asked for still missing?
3. Incorrect assumptions — Did the agent misunderstand any requirement?
4. Regressions — Did any previously working feature break?
5. Overall quality — Is the implementation sensible and well-thought-out?

Structure your response as:

## General Task Review

### ✅ What was done well
### ❌ Issues found
### ⚠️ Risks / concerns
### 📋 Recommendation`,
	},
	{
		id: "security",
		label: "Security Review",
		description: "Check for vulnerabilities introduced by the change",
		systemPrompt: `You are a security auditor conducting a SECURITY REVIEW.

QUESTION: Did the implementation introduce security vulnerabilities?

Check every aspect below and give concrete examples from the conversation or code:

1. Authentication & authorization — Are access controls correct?
2. Input validation — Is all user input validated and sanitized?
3. SQL injection — Are queries using parameterized statements / ORM?
4. XSS — Is all user-controlled output properly escaped?
5. CSRF — Are state-changing requests protected?
6. Sensitive data exposure — Are secrets, tokens, or PII logged or leaked?
7. Insecure file handling — Are file operations path-traversal safe?
8. Secrets accidentally exposed — Are API keys, passwords in code?
9. API endpoint security — Are new routes properly protected?

Structure your response as:

## Security Review

### ✅ Secure practices observed
### ❌ Vulnerabilities found
### ⚠️ Potential concerns
### 📋 Recommendation`,
	},
	{
		id: "code_quality",
		label: "Code Quality Review",
		description: "Assess maintainability and consistency with codebase",
		systemPrompt: `You are a software architect conducting a CODE QUALITY REVIEW.

QUESTION: Is the implementation maintainable and consistent with the existing codebase?

Check every aspect below and give concrete examples:

1. Architecture — Are classes/modules well-structured?
2. Duplication — Is there copy-pasted or near-duplicate code?
3. Naming — Are variables, methods, classes named clearly and consistently?
4. Complexity — Are there overly complex methods or deep nesting?
5. Error handling — Are errors caught and handled appropriately?
6. Framework conventions — Does the code follow the project's established patterns?
7. Unnecessary code — Are there dead comments, unused imports, or leftover debug code?
8. Technical debt — Does this add shortcuts that will cost later?

Structure your response as:

## Code Quality Review

### ✅ What's well-structured
### ❌ Issues found
### ⚠️ Technical debt introduced
### 📋 Recommendation`,
	},
	{
		id: "ui_ux",
		label: "UI/UX Completion Review",
		description: "Verify frontend completeness and user experience",
		systemPrompt: `You are a UX specialist conducting a UI/UX COMPLETION REVIEW.

QUESTION: Is the user-facing implementation actually complete?

Check every aspect below and give concrete examples:

1. All requested UI elements exist — Are buttons, inputs, cards, modals present?
2. Loading states — Are async operations shown with spinners / skeletons?
3. Empty states — What does the user see when there is no data?
4. Error states — Are errors surfaced clearly and helpfully?
5. Validation feedback — Are form validation messages timely and clear?
6. Responsive behavior — Does it work on mobile/tablet breakpoints?
7. Visual consistency — Does it match the design system (colors, spacing, typography)?
8. User flow completeness — Can the user complete the entire task without gaps?

If the change has no frontend impact, state that and skip.

Structure your response as:

## UI/UX Review

### ✅ Complete & well-done
### ❌ Missing or broken
### ⚠️ Edge cases to address
### 📋 Recommendation`,
	},
	{
		id: "testing",
		label: "Testing Review",
		description: "Check test coverage and regression risks",
		systemPrompt: `You are a QA engineer conducting a TESTING REVIEW.

QUESTION: Is the implementation adequately tested?

Check every aspect below and give concrete examples:

1. Existing tests still pass — Is there evidence tests ran successfully?
2. New functionality has appropriate tests — Are there tests for the new behavior?
3. Edge cases — Are boundary conditions, nulls, and error paths tested?
4. Regression risks — Could this change silently break other features?
5. Missing test coverage — Which code paths lack tests?

If no tests exist in the project, note that and suggest what should be tested.

Structure your response as:

## Testing Review

### ✅ Well-tested areas
### ❌ Missing or insufficient tests
### ⚠️ Regression risks
### 📋 Recommendation`,
	},
	{
		id: "performance",
		label: "Performance Review",
		description: "Identify performance issues and optimization opportunities",
		systemPrompt: `You are a performance engineer conducting a PERFORMANCE REVIEW.

QUESTION: Could this implementation cause performance problems?

Check every aspect below and give concrete examples:

1. N+1 queries — Are there loops that trigger repeated database queries?
2. Unnecessary database queries — Could queries be combined or eliminated?
3. Expensive loops — Is there O(n²) or worse complexity where linear would work?
4. Memory usage — Are large datasets loaded into memory unnecessarily?
5. Missing indexes — Do new queries need database indexes?
6. API calls — Are there redundant or unbatched external API calls?
7. Caching opportunities — Could results be cached to reduce repeated work?
8. Frontend performance — Large bundles, unoptimized images, blocking scripts?

If the change is trivial with no performance impact, state that.

Structure your response as:

## Performance Review

### ✅ Efficient patterns used
### ❌ Performance issues found
### ⚠️ Potential bottlenecks at scale
### 📋 Recommendation`,
	},
	{
		id: "scope",
		label: "Requirements / Scope Review",
		description: "Check for unnecessary or out-of-scope changes",
		systemPrompt: `You are a project manager conducting a SCOPE REVIEW.

QUESTION: Did the agent change more than it should have?

Check every aspect below and give concrete examples from the conversation:

1. Unrequested changes — Were files modified that had nothing to do with the task?
2. Unnecessary refactoring — Was working code rewritten without reason?
3. Breaking changes — Did any API, signature, or behavior change unexpectedly?
4. Files modified outside the scope — List all modified files and flag the out-of-scope ones.
5. Features implemented differently from the requested behavior — Does the solution match what was asked?

Structure your response as:

## Scope Review

### ✅ Changes aligned with the request
### ❌ Out-of-scope changes
### ⚠️ Unnecessary modifications
### 📋 Recommendation`,
	},
];

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

interface ReviewerState {
	autoOffer: boolean;
}

const STATE_CUSTOM_TYPE = "pi-reviewer-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function collectConversation(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch
			.map(entryToMessage)
			.filter((m): m is AgentMessage => m !== undefined);
	}
	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction"
			? branch.findIndex((e) => e.id === compaction.firstKeptEntryId)
			: -1;
	const compacted = [
		compaction,
		...(firstKeptIndex >= 0
			? branch.slice(firstKeptIndex, compactionIndex)
			: []),
		...branch.slice(compactionIndex + 1),
	];
	return compacted
		.map(entryToMessage)
		.filter((m): m is AgentMessage => m !== undefined);
}

// ---------------------------------------------------------------------------
// Multi‑select checkbox component
// ---------------------------------------------------------------------------

interface CheckboxItem {
	id: string;
	label: string;
	description: string;
}

class CheckboxList {
	private cursor = 0;
	public onConfirm?: (selected: Set<string>) => void;
	public onCancel?: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private items: CheckboxItem[],
		private checked: Set<string>,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.invalidate();
		} else if (matchesKey(data, Key.down)) {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			this.invalidate();
		} else if (matchesKey(data, Key.space)) {
			const id = this.items[this.cursor]!.id;
			if (this.checked.has(id)) this.checked.delete(id);
			else this.checked.add(id);
			this.invalidate();
		} else if (data === "a" || data === "A") {
			if (this.checked.size === this.items.length) {
				this.checked.clear();
			} else {
				for (const item of this.items) this.checked.add(item.id);
			}
			this.invalidate();
		} else if (matchesKey(data, Key.enter)) {
			this.onConfirm?.(new Set(this.checked));
		} else if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
		}
	}

	render(width: number, theme: {
		fg: (color: string, text: string) => string;
		bg: (color: string, text: string) => string;
	}): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const rw = Math.max(1, width);

		function addWrapped(text: string) {
			lines.push(...wrapTextWithAnsi(text, rw));
		}
		function addWrappedWithPrefix(prefix: string, text: string) {
			const linesWrapped = wrapTextWithAnsi(text, rw - [...prefix].length);
			for (const l of linesWrapped) addWrapped(prefix + l);
		}

		addWrapped(theme.fg("accent", "─".repeat(rw)));
		addWrapped(
			theme.fg("accent", theme.bold("Code Review — select areas to evaluate")),
		);
		addWrapped("");
		addWrapped(
			theme.fg(
				"dim",
				"Space: toggle  •  A: toggle all  •  Enter: run  •  Esc: cancel",
			),
		);
		addWrapped("");

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const isFocused = i === this.cursor;
			const isChecked = this.checked.has(item.id);

			const prefix = isFocused ? theme.fg("accent", ">") : " ";
			const check = isChecked ? "☒" : "☐";
			const body = `${check} ${item.label}`;

			const fullLine = `${prefix} ${
				isFocused
					? theme.bg("selectedBg", theme.fg("text", body))
					: theme.fg(isChecked ? "success" : "text", body)
			}`;
			addWrapped(fullLine);

			if (item.description) {
				addWrappedWithPrefix(
					"    ",
					theme.fg("muted", item.description),
				);
			}
		}

		addWrapped("");
		const selectedCount = this.checked.size;
		addWrapped(
			theme.fg(
				selectedCount > 0 ? "success" : "dim",
				`${selectedCount} of ${this.items.length} areas selected`,
			),
		);
		addWrapped(theme.fg("accent", "─".repeat(rw)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piReviewer(pi: ExtensionAPI) {
	// Whether we auto-offered after agent_settled (avoid double‑prompt)
	let offeredThisTask = false;

	// Persistent configuration
	let autoOffer = true;

	function persistState() {
		pi.appendEntry<ReviewerState>(STATE_CUSTOM_TYPE, { autoOffer });
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "custom" &&
				entry.customType === STATE_CUSTOM_TYPE
			) {
				const data = entry.data as ReviewerState | undefined;
				if (typeof data?.autoOffer === "boolean") {
					autoOffer = data.autoOffer;
				}
				break;
			}
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		if (autoOffer) {
			ctx.ui.setStatus(
				"pi-reviewer",
				ctx.ui.theme.fg("accent", "🔍 auto-review"),
			);
		} else {
			ctx.ui.setStatus("pi-reviewer", undefined);
		}
	}

	// -----------------------------------------------------------------------
	// Core review function
	// -----------------------------------------------------------------------

	async function runReview(
		areaIds: Set<string>,
		ctx: ExtensionContext,
		editorMode: boolean,
	) {
		const areas = REVIEW_AREAS.filter((a) => areaIds.has(a.id));
		if (areas.length === 0) {
			ctx.ui.notify("No areas selected", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		// Collect conversation context
		const messages = collectConversation(ctx.sessionManager.getBranch());
		if (messages.length === 0) {
			ctx.ui.notify("No conversation to review", "error");
			return;
		}

		const llmMessages = convertToLlm(messages);
		const conversationText = serializeConversation(llmMessages);

		// Run each area sequentially with a loader UI per area
		const results: { area: ReviewArea; text: string }[] = [];

		for (const area of areas) {
			const areaResult = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Reviewing: ${area.label}...`,
					);
					loader.onAbort = () => done(null);

					const doReview = async () => {
						try {
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
								ctx.model!,
							);
							if (!auth.ok || !auth.apiKey) {
								done(null);
								return;
							}

							const response = await complete(
								ctx.model!,
								{
									systemPrompt: area.systemPrompt,
									messages: [
										{
											role: "user",
											content: [
												{
													type: "text",
													text: `## Conversation to review\n\n${conversationText}\n\nPlease provide your ${area.label} based on the conversation above.`,
												},
											],
											timestamp: Date.now(),
										},
									],
								},
								{
									apiKey: auth.apiKey,
									headers: auth.headers,
									env: auth.env,
									signal: loader.signal,
								},
							);

							if (response.stopReason === "aborted") {
								done(null);
								return;
							}

							const text = response.content
								.filter(
									(c): c is { type: "text"; text: string } =>
										c.type === "text",
								)
								.map((c) => c.text)
								.join("\n");
							done(text);
						} catch {
							done(null);
						}
					};

					doReview();
					return loader;
				},
			);

			if (areaResult === null) {
				ctx.ui.notify(`Review cancelled during "${area.label}"`, "info");
				return;
			}

			results.push({ area, text: areaResult });
		}

		if (results.length === 0) return;

		// Build combined output
		const combined = results
			.map((r) => r.text)
			.join("\n\n---\n\n");

		if (editorMode) {
			ctx.ui.setEditorText(combined);
			ctx.ui.notify(
				`Review complete — ${results.length} area(s) loaded into editor`,
				"info",
			);
		} else {
			// Send as a custom displayed message
			pi.sendMessage(
				{
					customType: "pi-reviewer-report",
					content: combined,
					display: true,
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(
				`Review complete — ${results.length} area(s)`,
				"info",
			);
		}
	}

	// -----------------------------------------------------------------------
	// Review area picker UI (shared by command and agent_settled)
	// -----------------------------------------------------------------------

	async function pickAndReview(
		ctx: ExtensionContext,
		editorMode: boolean,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/review requires interactive mode", "error");
			return;
		}

		const selected = await ctx.ui.custom<Set<string> | null>(
			(tui, theme, _kb, done) => {
				const list = new CheckboxList(
					REVIEW_AREAS.map((a) => ({
						id: a.id,
						label: a.label,
						description: a.description,
					})),
					new Set(REVIEW_AREAS.map((a) => a.id)), // all checked by default
				);
				list.onConfirm = (s) => done(s);
				list.onCancel = () => done(null);

				return {
					render: (w: number) => list.render(w, theme),
					invalidate: () => list.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			},
		);

		if (selected === null || selected.size === 0) {
			ctx.ui.notify("Review cancelled", "info");
			return;
		}

		await runReview(selected, ctx, editorMode);
	}

	// -----------------------------------------------------------------------
	// /review command
	// -----------------------------------------------------------------------

	pi.registerCommand("review", {
		description: "Run a multi-area code review on the just-completed task",
		handler: async (_args, ctx) => {
			await pickAndReview(ctx, false);
		},
	});

	// -----------------------------------------------------------------------
	// /review-toggle command — enable/disable auto‑offer on task completion
	// -----------------------------------------------------------------------

	pi.registerCommand("review-toggle", {
		description: "Toggle auto-review prompt after each task",
		handler: async (_args, ctx) => {
			autoOffer = !autoOffer;
			persistState();
			updateStatus(ctx);
			ctx.ui.notify(
				autoOffer
					? "Auto-review ON — you will be prompted after each task"
					: "Auto-review OFF — use /review to run manually",
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// Auto‑offer after agent settles
	// -----------------------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (offeredThisTask) return;
		offeredThisTask = true;

		if (!autoOffer) return;

		const choice = await ctx.ui.select("Task complete — run a code review?", [
			"Review (all 7 areas)",
			"Pick which areas to review",
			"Disable auto-offer (use /review manually)",
			"Skip",
		]);

		if (choice === "Skip" || choice === undefined) return;

		if (choice?.startsWith("Disable")) {
			autoOffer = false;
			persistState();
			updateStatus(ctx);
			ctx.ui.notify(
				"Auto-review disabled. Use /review to run manually.",
				"info",
			);
			return;
		}

		if (choice === "Review (all 7 areas)") {
			const allIds = new Set(REVIEW_AREAS.map((a) => a.id));
			await runReview(allIds, ctx, false);
		} else {
			await pickAndReview(ctx, false);
		}
	});

	// Reset the offer flag when a new agent run starts
	pi.on("agent_start", () => {
		offeredThisTask = false;
	});

	// -----------------------------------------------------------------------
	// Session lifecycle — restore state and show status
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});
}
