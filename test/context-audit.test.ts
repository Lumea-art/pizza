import { beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { auditContext } from "../src/core/context/context-audit.js";
import { contextCommand } from "../src/builtin-extensions/context-router/index.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";

describe("context audit", () => {
	let store: SqliteEventStore;
	let ctx: ExtensionContext;

	beforeEach(() => {
		store = new SqliteEventStore("context-audit", ":memory:");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "We need to keep the public API stable and only edit source files." },
			thread_id: "thread-a",
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: { tool_call_id: "tc1", tool_name: "read", result: [{ type: "text", text: "latest observation" }], is_error: false },
			thread_id: "thread-a",
		});
		ctx = {
			cwd: "/workspace",
			sessionManager: {
				eventStore: store,
				projection: {
					getDescriptor: () => ({
						session_id: "s1",
						thread_id: "thread-a",
						workspace_id: "ws1",
						event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
						created_by: "user_explicit",
						created_at: 0,
					}),
				},
			},
		} as unknown as ExtensionContext;
	});

	it("flags early constraints absent from the recent window", () => {
		for (let i = 0; i < 20; i++) {
			store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_END",
				payload: {
					tool_call_id: `recent_${i}`,
					tool_name: "read",
					result: [{ type: "text", text: `recent observation ${i} ` + "x".repeat(800) }],
					is_error: false,
				},
				thread_id: "thread-a",
			});
		}
		const audit = auditContext(store.query({}), { pinsBudget: 2000, recentBudget: 100 });
		expect(audit.pinsOnly.some((item) => item.type === "USER_MESSAGE")).toBe(true);
		expect(audit.recentOnly.some((item) => item.type === "TOOL_EXECUTION_END")).toBe(true);
		expect(audit.risk).toBe("high");
		expect(audit.markdown).toContain("GoalPins");
		expect(audit.recommendation).toContain("GoalPins");
	});

	it("does not flag when the recent window contains the pin", () => {
		const audit = auditContext(store.query({}), { pinsBudget: 100, recentBudget: 2000 });
		expect(audit.pinsOnly).toHaveLength(0);
		expect(audit.risk).toBe("low");
	});

	it("parses and executes _context audit", async () => {
		expect(contextCommand.parseArguments?.(["audit", "--budget", "1000", "--json"], undefined, {})).toMatchObject({
			subcommand: "audit",
			budget: 1000,
			json: true,
		});
		const result = await contextCommand.execute("ctx-audit", { subcommand: "audit" }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).toContain("Context audit");
	});
});
