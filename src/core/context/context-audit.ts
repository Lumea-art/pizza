/**
 * Context audit: compare GoalPins with the recent window before choosing a
 * routing strategy. This is a read-only diagnostic, not a context builder.
 */

import type { EventBase } from "../event-store/types.js";
import { estimateStringTokens } from "../compaction/token-estimation.js";
import {
	selectGoalPins,
	selectRecentContext,
	type ContextEvidence,
	type ContextSelection,
} from "./goal-pins.js";

export interface ContextAuditOptions {
	pinsBudget?: number;
	recentBudget?: number;
}

export interface ContextAudit {
	pins: ContextSelection;
	recent: ContextSelection;
	overlap: number;
	pinsOnly: ContextEvidence[];
	recentOnly: ContextEvidence[];
	pinsTokens: number;
	recentTokens: number;
	risk: "low" | "medium" | "high";
	recommendation: string;
	markdown: string;
}

function ids(selection: ContextSelection): Set<string> {
	return new Set(selection.evidence.map((item) => item.eventId));
}

function renderEvidence(items: ContextEvidence[], limit = 3): string[] {
	return items.slice(0, limit).map((item) => `  - [${item.type}] ${item.summary}`);
}

export function auditContext(events: EventBase[], options: ContextAuditOptions = {}): ContextAudit {
	const pins = selectGoalPins(events, {
		tokenBudget: options.pinsBudget ?? 1200,
	});
	const recent = selectRecentContext(events, { tokenBudget: options.recentBudget ?? 2000 });
	const pinIds = ids(pins);
	const recentIds = ids(recent);
	const pinsOnly = pins.evidence.filter((item) => !recentIds.has(item.eventId));
	const recentOnly = recent.evidence.filter((item) => !pinIds.has(item.eventId));
	const overlap = pins.evidence.filter((item) => recentIds.has(item.eventId)).length;
	const pinsTokens = estimateStringTokens(pins.markdown);
	const recentTokens = estimateStringTokens(recent.markdown);

	let risk: ContextAudit["risk"] = "low";
	if (pinsOnly.length > 0) risk = "medium";
	if (pinsOnly.some((item) => item.type === "USER_MESSAGE" || item.type === "MEMORY")) risk = "high";

	const recommendation = risk === "high"
		? "Early constraints are absent from the recent window. Use GoalPins for constraint/plan questions; do not rely on recent-only context."
		: risk === "medium"
			? "Some pinned evidence is outside the recent window. Keep GoalPins available for long-range questions."
			: "Recent context covers the pinned evidence. Use the recent window for next-action work.";

	const markdown = [
		"## Context audit",
		"",
		`- GoalPins: ${pins.evidence.length} event(s), ~${pinsTokens} tokens`,
		`- Recent: ${recent.evidence.length} event(s), ~${recentTokens} tokens`,
		`- Overlap: ${overlap}`,
		`- Pins only: ${pinsOnly.length}`,
		...renderEvidence(pinsOnly),
		`- Recent only: ${recentOnly.length}`,
		...renderEvidence(recentOnly),
		"",
		`Risk: ${risk}`,
		`Recommendation: ${recommendation}`,
	].join("\n");

	return {
		pins,
		recent,
		overlap,
		pinsOnly,
		recentOnly,
		pinsTokens,
		recentTokens,
		risk,
		recommendation,
		markdown,
	};
}
