import { describe, expect, it } from "vitest";
import {
	SseParser,
	parseKernelLogPayload,
	parseCompletedLogBody,
	assembleKernelLogs,
	collapseCarriageReturnsInEvents,
	fetchKernelLogs,
	LOG_END_SENTINEL,
} from "./kernel-logs";

describe("SseParser", () => {
	it("parses events split across chunks and \\r\\n", () => {
		const p = new SseParser();
		expect(p.push('data: {"stream_name":"stdout","time":1,"data":"a"}\r\n\r\n')).toEqual([
			'{"stream_name":"stdout","time":1,"data":"a"}',
		]);
		expect(p.push("data: {\"stream")).toEqual([]);
		expect(p.push("_name\":\"stdout\",\"time\":2,\"data\":\"b\"}\n\n")).toEqual([
			'{"stream_name":"stdout","time":2,"data":"b"}',
		]);
	});

	it("joins multi-line data fields and ignores comments", () => {
		const p = new SseParser();
		const payloads = p.push(": heartbeat\n\ndata: line1\ndata: line2\n\n");
		expect(payloads).toEqual(["line1\nline2"]);
	});

	it("handles END_OF_LOG sentinel", () => {
		expect(parseKernelLogPayload(LOG_END_SENTINEL)).toBe("end");
	});
});

describe("parseCompletedLogBody", () => {
	it("parses JSON array of log events", () => {
		const body = JSON.stringify([
			{ stream_name: "stdout", time: 0.5, data: "hello\n" },
			{ stream_name: "stderr", time: 1, data: "warn" },
		]);
		const events = parseCompletedLogBody(body);
		expect(events).toHaveLength(2);
		expect(events[0].data).toBe("hello\n");
	});
});

describe("assembleKernelLogs", () => {
	const events = [
		{ stream_name: "stdout", time: 1, data: "a\n" },
		{ stream_name: "stderr", time: 2, data: "err\n" },
		{ stream_name: "stdout", time: 3, data: "b\n" },
	];

	it("filters by stream and cursor", () => {
		const r = assembleKernelLogs(events, {
			cursor: 1,
			stream: "stdout",
			ended: false,
			state: "running",
		});
		expect(r.total_events).toBe(2);
		expect(r.log).toContain("3s b");
		expect(r.next_cursor).toBe("2");
	});

	it("applies tail", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({
			stream_name: "stdout",
			time: i,
			data: `line${i}\n`,
		}));
		const r = assembleKernelLogs(many, { tail: 2, ended: true, state: "complete" });
		expect(r.log).toMatch(/line3/);
		expect(r.log).toMatch(/line4/);
		expect(r.log).not.toMatch(/line0/);
	});

	it("truncates by max_bytes keeping newest", () => {
		const many = Array.from({ length: 100 }, (_, i) => ({
			stream_name: "stdout",
			time: i,
			data: `row-${i}-${"x".repeat(40)}\n`,
		}));
		const r = assembleKernelLogs(many, { maxBytes: 200, ended: true, state: "complete" });
		expect(r.truncated).toBe(true);
		expect(r.log.length).toBeLessThanOrEqual(200);
		expect(r.log).toMatch(/row-99/);
	});
});

describe("collapseCarriageReturnsInEvents", () => {
	it("keeps only final tqdm-style overwrite", () => {
		const events = [
			{ stream_name: "stdout", time: 1, data: "\r10%" },
			{ stream_name: "stdout", time: 1.1, data: "\r50%" },
			{ stream_name: "stdout", time: 1.2, data: "\r100%\n" },
		];
		const collapsed = collapseCarriageReturnsInEvents(events);
		const text = collapsed.map((e) => e.data).join("");
		expect(text).not.toContain("10%");
		expect(text).not.toContain("50%");
		expect(text).toContain("100%");
	});
});

describe("fetchKernelLogs", () => {
	it("handles completed JSON blob response", async () => {
		const body = JSON.stringify([{ stream_name: "stdout", time: 0, data: "done\n" }]);
		const result = await fetchKernelLogs({
			authHeader: "Bearer test",
			owner: "alice",
			slug: "kernel",
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});
		expect(result.state).toBe("complete");
		expect(result.ended).toBe(true);
		expect(result.log).toContain("done");
	});

	it("streams SSE until END_OF_LOG", async () => {
		const sse =
			'data: {"stream_name":"stdout","time":1,"data":"hi\\n"}\n\n'
			+ `data: ${LOG_END_SENTINEL}\n\n`;
		const result = await fetchKernelLogs({
			authHeader: "Bearer test",
			owner: "bob",
			slug: "k",
			waitSeconds: 0,
			fetchImpl: async () =>
				new Response(sse, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
		});
		expect(result.ended).toBe(true);
		expect(result.state).toBe("complete");
		expect(result.log).toContain("hi");
	});

	it("maps 403 to helpful slug error", async () => {
		await expect(
			fetchKernelLogs({
				authHeader: "Bearer test",
				owner: "x",
				slug: "y",
				fetchImpl: async () => new Response("denied", { status: 403 }),
			}),
		).rejects.toThrow(/wrong kernel slug/i);
	});
});
