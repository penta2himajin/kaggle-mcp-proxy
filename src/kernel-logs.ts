/** Kaggle kernel log streaming (SSE + completed JSON blob). */

export const KAGGLE_API = "https://www.kaggle.com/api/v1";
export const DEFAULT_MAX_BYTES = 20_480;
export const LOG_END_SENTINEL = "END_OF_LOG";

export type KernelLogEvent = {
	stream_name: string;
	time: number;
	data: string;
};

export type KernelLogStreamFilter = "stdout" | "stderr" | "all";

export type AssembleLogsOptions = {
	cursor?: number;
	tail?: number;
	stream?: KernelLogStreamFilter;
	maxBytes?: number;
};

export type AssembledKernelLogs = {
	state: "running" | "complete";
	ended: boolean;
	next_cursor: string;
	truncated: boolean;
	total_events: number;
	log: string;
};

/** Incremental SSE parser (partial chunks, \\r\\n, multi-line data:, comment lines). */
export class SseParser {
	private buffer = "";
	private dataLines: string[] = [];

	push(chunk: string): string[] {
		this.buffer += chunk;
		const payloads: string[] = [];
		let lineStart = 0;
		for (let i = 0; i < this.buffer.length; i++) {
			const c = this.buffer[i];
			if (c === "\n") {
				let line = this.buffer.slice(lineStart, i);
				lineStart = i + 1;
				if (line.endsWith("\r")) line = line.slice(0, -1);
				const p = this.consumeLine(line);
				if (p !== undefined) payloads.push(p);
			}
		}
		this.buffer = this.buffer.slice(lineStart);
		return payloads;
	}

	flush(): string[] {
		const payloads: string[] = [];
		if (this.buffer.length) {
			let line = this.buffer;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const p = this.consumeLine(line);
			if (p !== undefined) payloads.push(p);
			this.buffer = "";
		}
		return payloads;
	}

	private consumeLine(line: string): string | undefined {
		if (!line) {
			if (this.dataLines.length) {
				const payload = this.dataLines.join("\n");
				this.dataLines = [];
				return payload;
			}
			return undefined;
		}
		if (line.startsWith(":")) return undefined;
		if (line.startsWith("data:")) {
			this.dataLines.push(line.slice(5).replace(/^\s/, ""));
			return undefined;
		}
		// Ignore other SSE fields (event:, id:, retry:)
		return undefined;
	}
}

export function parseKernelLogPayload(payload: string): KernelLogEvent | "end" | null {
	if (payload === LOG_END_SENTINEL) return "end";
	try {
		const obj = JSON.parse(payload) as Record<string, unknown>;
		if (obj && typeof obj === "object") {
			const data = obj.data;
			return {
				stream_name: String(obj.stream_name ?? "stdout"),
				time: typeof obj.time === "number" ? obj.time : Number(obj.time) || 0,
				data: data == null ? "" : String(data),
			};
		}
	} catch {
		return { stream_name: "stdout", time: 0, data: payload };
	}
	return null;
}

/** Collapse tqdm-style \\r overwrites so only the final line state remains. */
export function collapseCarriageReturnsInEvents(events: KernelLogEvent[]): KernelLogEvent[] {
	const out: KernelLogEvent[] = [];
	for (const ev of events) {
		const raw = ev.data;
		const endsWithNl = raw.endsWith("\n");
		const lineBody = endsWithNl ? raw.slice(0, -1) : raw;
		const visible = lineBody.includes("\r") ? (lineBody.split("\r").pop() ?? "") : lineBody.replace(/^\r+/, "");
		const data = endsWithNl ? `${visible}\n` : visible;
		if (!data) continue;

		const prevOpen = out.length > 0 && !out[out.length - 1].data.endsWith("\n");
		if (raw.startsWith("\r") && prevOpen) {
			out[out.length - 1] = { ...ev, data };
		} else {
			out.push({ ...ev, data });
		}
	}
	return out;
}

function streamMatches(streamName: string, filter: KernelLogStreamFilter): boolean {
	if (filter === "all") return true;
	const n = streamName.toLowerCase();
	if (filter === "stderr") return n.includes("stderr") || n === "error";
	return n.includes("stdout") || n === "output" || (!n.includes("stderr") && !n.includes("error"));
}

/** Format kernel log timestamps to millisecond precision (token-friendly). */
export function formatLogTime(seconds: number): string {
	const rounded = Math.round(seconds * 1000) / 1000;
	let s = rounded.toFixed(3);
	s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	return `${s}s`;
}

export function formatLogLine(ev: KernelLogEvent): string {
	const stream = ev.stream_name.toLowerCase().includes("stderr") ? "stderr" : "stdout";
	const t = formatLogTime(ev.time);
	const text = ev.data.replace(/\r/g, "").replace(/\n$/, "");
	return `[${stream}] ${t} ${text}`;
}

export function assembleKernelLogs(
	allEvents: KernelLogEvent[],
	opts: AssembleLogsOptions & { ended: boolean; state: "running" | "complete" },
): AssembledKernelLogs {
	const cursor = opts.cursor ?? 0;
	const streamFilter = opts.stream ?? "all";
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

	const collapsed = collapseCarriageReturnsInEvents(allEvents);
	const filtered = collapsed.filter((e) => streamMatches(e.stream_name, streamFilter));
	const total_events = filtered.length;

	const sliceStart = Math.min(cursor, total_events);
	const selected = filtered.slice(sliceStart);

	let formatted = selected.map(formatLogLine);
	if (opts.tail != null && opts.tail > 0) {
		formatted = formatted.slice(-opts.tail);
	}

	let log = formatted.join("\n");
	if (log.length) log += "\n";

	let truncated = false;
	if (log.length > maxBytes) {
		truncated = true;
		log = log.slice(log.length - maxBytes);
		// Drop partial first line after byte cut
		const nl = log.indexOf("\n");
		if (nl >= 0 && nl < log.length - 1) log = log.slice(nl + 1);
	}

	return {
		state: opts.state,
		ended: opts.ended,
		next_cursor: String(total_events),
		truncated,
		total_events,
		log,
	};
}

export function parseCompletedLogBody(body: string): KernelLogEvent[] {
	try {
		const payload = JSON.parse(body) as unknown;
		const events = Array.isArray(payload) ? payload : [payload];
		const out: KernelLogEvent[] = [];
		for (const event of events) {
			if (!event || typeof event !== "object") continue;
			const e = event as Record<string, unknown>;
			out.push({
				stream_name: String(e.stream_name ?? "stdout"),
				time: typeof e.time === "number" ? e.time : Number(e.time) || 0,
				data: e.data == null ? "" : String(e.data),
			});
		}
		return out;
	} catch {
		return body
			.split("\n")
			.filter(Boolean)
			.map((line) => ({ stream_name: "stdout", time: 0, data: line }));
	}
}

export type FetchKernelLogsParams = {
	authHeader: string;
	owner: string;
	slug: string;
	version?: string;
	cursor?: string;
	tail?: number;
	stream?: KernelLogStreamFilter;
	waitSeconds?: number;
	maxBytes?: number;
	fetchImpl?: typeof fetch;
};

const CATCH_UP_QUIET_MS = 1250;

export async function fetchKernelLogs(params: FetchKernelLogsParams): Promise<AssembledKernelLogs> {
	const {
		authHeader,
		owner,
		slug,
		version,
		cursor: cursorStr,
		tail,
		stream,
		waitSeconds = 0,
		maxBytes,
		fetchImpl = fetch,
	} = params;

	const cursor = cursorStr ? Math.max(0, parseInt(cursorStr, 10) || 0) : 0;
	const qs = new URLSearchParams();
	if (version) qs.set("versionLabel", version);
	const url = `${KAGGLE_API}/kernels/logs/stream/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}${qs.size ? `?${qs}` : ""}`;

	const waitMs = Math.min(25, Math.max(0, waitSeconds)) * 1000;
	const overallMs = waitMs + 8000;

	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), overallMs);

	let res: Response;
	try {
		res = await fetchImpl(url, {
			headers: {
				Authorization: authHeader,
				Accept: "text/event-stream, */*",
			},
			signal: controller.signal,
		});
	} catch (e) {
		clearTimeout(deadline);
		if (controller.signal.aborted) {
			return assembleKernelLogs([], {
				cursor,
				tail,
				stream,
				maxBytes,
				ended: false,
				state: "running",
			});
		}
		throw e;
	}

	if (res.status === 401 || res.status === 403) {
		clearTimeout(deadline);
		const body = await res.text();
		throw new Error(
			`Cannot stream logs for kernel '${owner}/${slug}' (HTTP ${res.status}). `
			+ "Permission denied — the most likely cause is a wrong kernel slug. "
			+ "Use the slug from the notebook URL (kaggle.com/code/owner/KERNEL-SLUG). "
			+ (body ? `Response: ${body.slice(0, 200)}` : ""),
		);
	}

	if (!res.ok) {
		clearTimeout(deadline);
		const body = await res.text();
		throw new Error(`Kaggle API ${res.status}: ${body}`);
	}

	const contentType = (res.headers.get("Content-Type") || "").toLowerCase();

	if (!contentType.startsWith("text/event-stream")) {
		const body = await res.text();
		clearTimeout(deadline);
		const events = parseCompletedLogBody(body);
		return assembleKernelLogs(events, {
			cursor,
			tail,
			stream,
			maxBytes,
			ended: true,
			state: "complete",
		});
	}

	const events: KernelLogEvent[] = [];
	let ended = false;
	let caughtUp = false;
	let caughtUpAt = 0;
	let lastEventAt = Date.now();

	const parser = new SseParser();
	const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();

	const processPayload = (payload: string) => {
		const parsed = parseKernelLogPayload(payload);
		if (parsed === "end") {
			ended = true;
			return;
		}
		if (parsed) {
			events.push(parsed);
			lastEventAt = Date.now();
		}
	};

	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	try {
		if (!reader) {
			clearTimeout(deadline);
			return assembleKernelLogs(events, {
				cursor,
				tail,
				stream,
				maxBytes,
				ended,
				state: ended ? "complete" : "running",
			});
		}

		while (!ended && !controller.signal.aborted) {
			const quietFor = Date.now() - lastEventAt;
			if (!caughtUp && quietFor >= CATCH_UP_QUIET_MS) {
				caughtUp = true;
				caughtUpAt = Date.now();
			}
			if (caughtUp && waitMs === 0) break;
			if (caughtUp && Date.now() - caughtUpAt >= waitMs) break;

			const readResult = await Promise.race([
				reader.read(),
				sleep(caughtUp ? Math.max(50, waitMs - (Date.now() - caughtUpAt)) : CATCH_UP_QUIET_MS).then(
					() => ({ timedOut: true as const }),
				),
			]);

			if ("timedOut" in readResult) {
				continue;
			}

			const { done, value } = readResult;
			if (done) break;
			if (value) {
				for (const payload of parser.push(value)) {
					processPayload(payload);
					if (ended) break;
				}
			}
		}

		for (const payload of parser.flush()) {
			processPayload(payload);
		}
	} finally {
		clearTimeout(deadline);
		try {
			await reader?.cancel();
		} catch {
			/* ignore */
		}
		controller.abort();
	}

	return assembleKernelLogs(events, {
		cursor,
		tail,
		stream,
		maxBytes,
		ended,
		state: ended ? "complete" : "running",
	});
}
