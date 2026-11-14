import { describe, expect, it } from "vitest";
import type { EventBase } from "../src/core/event-store/types.js";
import {
	maskToolCallArgumentEvents,
	maskToolResultEvents,
} from "../src/core/compaction/tool-result-masking.js";
import { serializeConversation } from "../src/core/compaction/utils.js";

function event(
	sequence: number,
	type: EventBase["type"],
	payload: unknown,
	actor: EventBase["actor_id"] = "runtime",
): EventBase {
	return {
		sequence,
		event_id: `evt_${sequence}`,
		workspace_id: "test",
		runtime_id: "test",
		actor_id: actor,
		timestamp: sequence,
		type,
		payload,
		schema_version: 1,
	};
}

function toolResultEvent(sequence: number, id: string, text: string, isError: boolean): EventBase {
	return event(sequence, "TOOL_EXECUTION_END", {
		tool_call_id: id,
		tool_name: "cli",
		result: [{ type: "text", text }],
		is_error: isError,
		duration_ms: 1,
	});
}

function assistantCallEvent(sequence: number, id: string, content: string): EventBase {
	return event(
		sequence,
		"AGENT_MESSAGE_END",
		{
			content: [
				{
					type: "tool_call",
					id,
					name: "_write",
					arguments: { path: `src/${id}.ts`, content },
				},
			],
			model: { provider: "test", model_id: "test" },
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stop_reason: "tool_use",
		},
		"coder_agent",
	);
}

describe("compaction error protection", () => {
	it("never masks a failed tool result, even when it is large and old", () => {
		const errorText = `Error: test failed\n${"e".repeat(5_000)}`;
		const successText = "s".repeat(5_000);
		const failed = toolResultEvent(1, "err", errorText, true);
		const succeeded = toolResultEvent(2, "ok", successText, false);

		const masked = maskToolResultEvents([failed, succeeded], 100);

		expect(masked[0]).toBe(failed);
		expect((masked[0]!.payload as { result: Array<{ text: string }> }).result[0]!.text).toBe(errorText);
		expect((masked[1]!.payload as { result: Array<{ text: string }> }).result[0]!.text).toContain(
			"Tool result cleared",
		);
	});

	it("never clears the arguments of a failed tool call", () => {
		const content = "x".repeat(40_000);
		const events = [
			assistantCallEvent(1, "failed", content),
			toolResultEvent(2, "failed", "write failed", true),
			assistantCallEvent(3, "succeeded", content),
			toolResultEvent(4, "succeeded", "wrote 40000 bytes", false),
		];

		const masked = maskToolCallArgumentEvents(events, 100);
		const calls = masked
			.filter((item) => item.type === "AGENT_MESSAGE_END")
			.flatMap(
				(item) =>
					(item.payload as {
						content: Array<{ type: string; id?: string; arguments?: { content?: string } }>;
					}).content,
			)
			.filter((block) => block.type === "tool_call");

		const failedCall = calls.find((call) => call.id === "failed");
		expect(failedCall?.arguments?.content).toBe(content);

		const succeededCall = calls.find((call) => call.id === "succeeded");
		expect(succeededCall?.arguments?.content).toContain("chars cleared from old context");
	});

	it("gives errors more room than normal tool results in summaries", () => {
		const errorText = `TypeError: boom\n${"E".repeat(5_000)}`;
		const successText = "S".repeat(5_000);
		const messages = [
			{
				role: "toolResult",
				toolCallId: "err",
				toolName: "cli",
				content: [{ type: "text", text: errorText }],
				isError: true,
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "ok",
				toolName: "cli",
				content: [{ type: "text", text: successText }],
				isError: false,
				timestamp: 1,
			},
		] as Parameters<typeof serializeConversation>[0];

		const serialized = serializeConversation(messages);

		expect(serialized).toContain("[Tool error]:");
		expect(serialized).toContain("TypeError: boom");
		expect(serialized).toContain("E".repeat(4_000));
		expect(serialized).toContain("[Tool result]:");
		expect(serialized).toContain("[... 3000 more characters truncated]");
		expect(serialized).not.toContain("S".repeat(3_000));
	});
});
