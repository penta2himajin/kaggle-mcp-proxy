import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

// ── Kaggle API helpers ─────────────────────────────────────────────

const KAGGLE_API = "https://www.kaggle.com/api/v1";
const KAGGLE_INTERNAL_API = "https://www.kaggle.com/api/i";

function kaggleAuthHeader(env: Env): string {
	const isBearer = env.KAGGLE_KEY.startsWith("KGAT_");
	return isBearer
		? `Bearer ${env.KAGGLE_KEY}`
		: `Basic ${btoa(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`)}`;
}

async function kaggleApi(
	env: Env,
	path: string,
	method: "GET" | "POST" = "GET",
	body?: unknown,
): Promise<unknown> {
	const opts: RequestInit = {
		method,
		headers: {
			Authorization: kaggleAuthHeader(env),
			"Content-Type": "application/json",
		},
	};
	if (body) opts.body = JSON.stringify(body);

	const res = await fetch(`${KAGGLE_API}${path}`, opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Kaggle API ${res.status}: ${text}`);
	}
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

type InternalRpcResult =
	| { ok: true; data: unknown }
	| { ok: false; status: number; body: string }
	| { ok: false; status: 0; body: string };

// Build headers for Kaggle's internal RPC service used by the web app
// (e.g. /api/i/kernels.KernelsService/GetKernel). These endpoints
// authenticate via the user's web session cookies (`ka_sessionid` +
// `XSRF-TOKEN`); the API-key Authorization header is silently ignored.
// Set KAGGLE_SESSION_ID and KAGGLE_XSRF_TOKEN secrets (extracted from a
// logged-in browser) to enable internal-RPC access.
function kaggleInternalHeaders(env: Env): HeadersInit {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": "kaggle-mcp-proxy/1.0",
		Origin: "https://www.kaggle.com",
		Referer: "https://www.kaggle.com/",
	};
	const session = env.KAGGLE_SESSION_ID;
	const xsrf = env.KAGGLE_XSRF_TOKEN;
	if (session && xsrf) {
		headers.Cookie = `ka_sessionid=${session}; XSRF-TOKEN=${xsrf}`;
		headers["X-XSRF-TOKEN"] = xsrf;
	}
	return headers;
}

async function kaggleInternalRpc(
	env: Env,
	rpcPath: string,
	body: unknown,
): Promise<InternalRpcResult> {
	let res: Response;
	try {
		res = await fetch(`${KAGGLE_INTERNAL_API}/${rpcPath}`, {
			method: "POST",
			headers: kaggleInternalHeaders(env),
			body: JSON.stringify(body),
		});
	} catch (e) {
		return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		return { ok: false, status: res.status, body };
	}
	const text = await res.text();
	try {
		return { ok: true, data: JSON.parse(text) };
	} catch {
		return { ok: true, data: { raw: text } };
	}
}

// Decode a Connect-protocol streaming body into an array of JSON messages.
// Wire format per envelope: 1 flag byte + 4-byte BE length + N message bytes.
// The final envelope has flag bit 0x02 set and contains end-of-stream
// metadata (which we ignore). Returns null if the buffer doesn't parse as
// envelopes — the caller can then try plain JSON.
function parseConnectStream(buf: Uint8Array): unknown[] | null {
	const messages: unknown[] = [];
	let off = 0;
	const dec = new TextDecoder();
	while (off + 5 <= buf.byteLength) {
		const flags = buf[off];
		const len =
			(buf[off + 1] << 24) |
			(buf[off + 2] << 16) |
			(buf[off + 3] << 8) |
			buf[off + 4];
		off += 5;
		if (off + len > buf.byteLength) return null;
		const body = buf.subarray(off, off + len);
		off += len;
		if (flags & 0x02) break;
		try {
			messages.push(JSON.parse(dec.decode(body)));
		} catch {
			return null;
		}
	}
	if (off !== buf.byteLength && (off === 0 || messages.length === 0)) return null;
	return messages;
}

type LiveLogResult =
	| { ok: true; raw: string }
	| { ok: false; reason: string };

// Resolve owner/slug → kernelRun.id (acts as kernelSessionId for log RPCs).
async function resolveKernelSessionId(
	env: Env,
	owner: string,
	slug: string,
): Promise<{ ok: true; sessionId: number } | { ok: false; reason: string }> {
	const result = await kaggleInternalRpc(env, "kernels.KernelsService/GetKernel", {
		username: owner,
		slug,
	});
	if (!result.ok) {
		return { ok: false, reason: `GetKernel failed (status=${result.status}): ${result.body.slice(0, 200)}` };
	}
	const data = result.data as { kernelRun?: { id?: number } } | null;
	const id = data?.kernelRun?.id;
	if (typeof id !== "number" || id <= 0) {
		return { ok: false, reason: `GetKernel returned no kernelRun.id; payload: ${JSON.stringify(data).slice(0, 200)}` };
	}
	return { ok: true, sessionId: id };
}

// Fetch live log records via the internal streaming RPC. Returns the same
// `[{stream_name, time, data}, ...]` shape that the public API uses for
// completed kernels, re-serialized as a JSON string so callers can apply
// the existing parsing path uniformly.
async function fetchLiveKernelLog(
	env: Env,
	sessionId: number,
): Promise<LiveLogResult> {
	let res: Response;
	try {
		res = await fetch(
			`${KAGGLE_INTERNAL_API}/kernels.KernelsService/GetKernelSessionLog`,
			{
				method: "POST",
				headers: kaggleInternalHeaders(env),
				body: JSON.stringify({ kernelSessionId: sessionId }),
			},
		);
	} catch (e) {
		return { ok: false, reason: `network error: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 200);
		return { ok: false, reason: `GetKernelSessionLog status=${res.status}: ${body}` };
	}

	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength === 0) return { ok: true, raw: "" };

	// First try plain JSON (unary response shape).
	try {
		const text = new TextDecoder().decode(buf);
		const json = JSON.parse(text) as { log?: string; messages?: unknown[] };
		if (typeof json.log === "string") return { ok: true, raw: json.log };
		if (Array.isArray(json.messages)) return { ok: true, raw: JSON.stringify(json.messages) };
		if (Array.isArray(json)) return { ok: true, raw: JSON.stringify(json) };
	} catch {
		// Not plain JSON — try Connect envelope framing.
	}

	const messages = parseConnectStream(buf);
	if (messages === null) {
		return { ok: false, reason: "GetKernelSessionLog response was neither plain JSON nor a parseable Connect stream" };
	}
	const flat = messages.flatMap((m) => (Array.isArray(m) ? m : [m]));
	return { ok: true, raw: JSON.stringify(flat) };
}

// Decode either a base64 string or a plain UTF-8 string into bytes.
function decodeFileContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
	if (encoding === "base64") {
		const bin = atob(content);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}
	return new TextEncoder().encode(content);
}

// Upload a single file to Kaggle's blob store and return the resulting token.
// Two-step protocol: (1) POST /blobs/upload to get a signed createUrl,
// (2) PUT the bytes to that URL.
async function uploadDatasetFile(
	env: Env,
	name: string,
	bytes: Uint8Array,
	contentType?: string,
): Promise<string> {
	const start = await kaggleApi(env, "/blobs/upload", "POST", {
		type: "DATASET",
		name,
		contentLength: bytes.byteLength,
		lastModifiedEpochSeconds: Math.floor(Date.now() / 1000),
		...(contentType ? { contentType } : {}),
	}) as { token?: string; createUrl?: string };

	if (!start.token || !start.createUrl) {
		throw new Error(`Unexpected blob upload response: ${JSON.stringify(start)}`);
	}

	const putRes = await fetch(start.createUrl, {
		method: "PUT",
		body: bytes,
		headers: contentType ? { "Content-Type": contentType } : {},
	});
	if (!putRes.ok) {
		const text = await putRes.text();
		throw new Error(`Blob PUT ${putRes.status}: ${text}`);
	}
	return start.token;
}

// ── MCP Server ──────────────────────────────────────────────────────

export class KaggleMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Kaggle MCP Proxy",
		version: "1.0.0",
	});

	async init() {
		const allowedUsers = (this.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
		if (allowedUsers.length > 0 && !allowedUsers.includes(this.props!.login)) {
			return;
		}

		// ── Kernel (Notebook) tools ────────────────────────────────

		this.server.tool(
			"kaggle_kernel_push",
			"Create or update a Kaggle kernel (notebook/script) and start execution. Returns the kernel reference for status checking.",
			{
				title: z.string().describe("Kernel title"),
				code: z.string().describe("Python code to execute"),
				language: z.enum(["python", "r"]).default("python").describe("Programming language"),
				kernel_type: z.enum(["notebook", "script"]).default("script").describe("Kernel type"),
				accelerator: z.enum(["none", "NvidiaTeslaP100", "NvidiaTeslaT4", "NvidiaTeslaT4x2", "TpuV6E8"]).default("none").describe("GPU/TPU accelerator (none, NvidiaTeslaP100, NvidiaTeslaT4, NvidiaTeslaT4x2, TpuV6E8)"),
				enable_internet: z.boolean().default(true).describe("Enable internet access"),
				dataset_sources: z.array(z.string()).optional().describe("Dataset references to attach (e.g., 'username/dataset-name')"),
			},
			async ({ title, code, language, kernel_type, accelerator, enable_internet, dataset_sources }) => {
				try {
					const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
					const result = await kaggleApi(this.env, "/kernels/push", "POST", {
						slug: `${this.env.KAGGLE_USERNAME}/${slug}`,
						newTitle: title,
						text: code,
						language,
						kernelType: kernel_type,
						isPrivate: true,
						enableGpu: accelerator !== "none",
						...(accelerator !== "none" ? { machineShape: accelerator } : {}),
						enableInternet: enable_internet,
						datasetDataSources: dataset_sources || [],
						competitionDataSources: [],
						kernelDataSources: [],
						categoryIds: [],
					});
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								status: "submitted",
								ref: `${this.env.KAGGLE_USERNAME}/${slug}`,
								message: "Kernel pushed. Use kaggle_kernel_status to check execution progress.",
								result,
							}, null, 2),
						}],
					};
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_kernel_status",
			"Check the execution status of a Kaggle kernel. Returns status (queued/running/complete/error).",
			{
				kernel: z.string().describe("Kernel reference (e.g., 'username/kernel-name')"),
			},
			async ({ kernel }) => {
				try {
					const [owner, name] = kernel.split("/");
					const result = await kaggleApi(this.env, `/kernels/status?userName=${owner}&kernelSlug=${name}`);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_kernel_output",
			"Get the output/results of a completed Kaggle kernel execution.",
			{
				kernel: z.string().describe("Kernel reference (e.g., 'username/kernel-name')"),
			},
			async ({ kernel }) => {
				try {
					const [owner, name] = kernel.split("/");
					const result = await kaggleApi(this.env, `/kernels/output?userName=${owner}&kernelSlug=${name}`);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_kernel_logs",
			"Fetch the execution log of a Kaggle kernel. By default uses the public API, which only populates the log after the kernel reaches `complete` or `error` (the official `kaggle` CLI has the same limitation). Pass `live: true` to attempt Kaggle's undocumented internal RPC for live tailing of running kernels; this requires KAGGLE_SESSION_ID and KAGGLE_XSRF_TOKEN secrets (extracted from a logged-in browser — see README) because Kaggle's internal endpoints reject API-key auth. Falls back to the public API on any failure and returns a `warning` field describing why.",
			{
				kernel: z.string().describe("Kernel reference (e.g., 'username/kernel-name')"),
				since_line: z.number().int().nonnegative().default(0).describe("Skip the first N lines of the log. Use the `total_lines` from the previous call to stream only new output."),
				tail: z.number().int().positive().optional().describe("If set, return only the last N lines (after `since_line` is applied)."),
				live: z.boolean().default(false).describe("Experimental: try Kaggle's internal streaming RPC for live logs while the kernel is running. Requires KAGGLE_SESSION_ID + KAGGLE_XSRF_TOKEN secrets. Falls back to the public API on failure."),
			},
			async ({ kernel, since_line, tail, live }) => {
				try {
					const [owner, name] = kernel.split("/");
					let rawLog = "";
					let warning: string | undefined;
					let source = "public";

					if (live) {
						if (!this.env.KAGGLE_SESSION_ID || !this.env.KAGGLE_XSRF_TOKEN) {
							warning = "live=true ignored: KAGGLE_SESSION_ID and KAGGLE_XSRF_TOKEN secrets are not set. See README for how to extract them from a logged-in browser. Falling back to the public API (logs only available after kernel completion).";
						} else {
							const resolved = await resolveKernelSessionId(this.env, owner, name);
							if (!resolved.ok) {
								warning = `live=true failed: ${resolved.reason}. Falling back to the public API. If the status is 401/403, your KAGGLE_SESSION_ID/XSRF token has expired — re-extract from your browser.`;
							} else {
								const liveLog = await fetchLiveKernelLog(this.env, resolved.sessionId);
								if (!liveLog.ok) {
									warning = `live=true failed for session ${resolved.sessionId}: ${liveLog.reason}. Falling back to the public API.`;
								} else {
									rawLog = liveLog.raw;
									source = "internal";
								}
							}
						}
					}

					if (source === "public") {
						const result = await kaggleApi(
							this.env,
							`/kernels/output?userName=${owner}&kernelSlug=${name}`,
						) as { log?: string };
						rawLog = result.log ?? "";
					}

					// Both code paths return a JSON-encoded array of stream records:
					//   [{"stream_name":"stdout","time":0.9,"data":"..."}, ...]
					// Decode and concatenate the `data` fields to reconstruct plain text.
					let logText = "";
					if (rawLog) {
						try {
							const records = JSON.parse(rawLog) as Array<{ data?: string }>;
							logText = records.map((r) => r.data ?? "").join("");
						} catch {
							logText = rawLog;
						}
					}

					const allLines = logText.split("\n");
					if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
						allLines.pop();
					}
					let lines = allLines.slice(since_line);
					if (tail !== undefined && lines.length > tail) {
						lines = lines.slice(-tail);
					}
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								source,
								total_lines: allLines.length,
								returned_lines: lines.length,
								log: lines.join("\n"),
								...(warning ? { warning } : {}),
							}, null, 2),
						}],
					};
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_kernels_list",
			"Search and list Kaggle kernels/notebooks.",
			{
				search: z.string().optional().describe("Search query"),
				user: z.string().optional().describe("Filter by username"),
				language: z.enum(["python", "r", "julia", "sql"]).optional(),
				sort_by: z.enum(["hotness", "commentCount", "dateCreated", "dateRun", "relevance", "viewCount", "voteCount"]).optional(),
				page: z.number().optional(),
				page_size: z.number().optional(),
			},
			async ({ search, user, language, sort_by, page, page_size }) => {
				try {
					const params = new URLSearchParams();
					if (search) params.set("search", search);
					if (user) params.set("user", user);
					if (language) params.set("language", language);
					if (sort_by) params.set("sortBy", sort_by);
					if (page) params.set("page", String(page));
					if (page_size) params.set("pageSize", String(page_size));
					const result = await kaggleApi(this.env, `/kernels/list?${params}`);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		// ── Dataset tools ──────────────────────────────────────────

		const datasetFileSchema = z.object({
			name: z.string().describe("File name including extension (e.g. 'train.csv')"),
			content: z.string().describe("File content. Plain text by default; set encoding='base64' for binary."),
			encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of `content`"),
			content_type: z.string().optional().describe("MIME type (e.g. 'text/csv'). Optional."),
			description: z.string().optional().describe("Per-file description shown on the dataset page"),
		});

		this.server.tool(
			"kaggle_dataset_create",
			"Create a new private Kaggle dataset and upload one or more files. Files are passed inline as text or base64. Subject to Cloudflare Worker request-size limits, so prefer this for small/medium training data.",
			{
				slug: z.string().describe("Dataset slug (lowercase, hyphenated). Must be unique within your account."),
				title: z.string().describe("Human-readable dataset title"),
				files: z.array(datasetFileSchema).min(1).describe("Files to include in the initial version"),
				license_name: z.string().default("CC0-1.0").describe("License identifier (e.g. 'CC0-1.0', 'CC-BY-SA-4.0')"),
				is_private: z.boolean().default(true).describe("Create as private (default true)"),
				subtitle: z.string().optional().describe("Short subtitle"),
				description: z.string().optional().describe("Long-form description (Markdown)"),
				category_ids: z.array(z.string()).optional().describe("Tag/category IDs"),
			},
			async ({ slug, title, files, license_name, is_private, subtitle, description, category_ids }) => {
				try {
					const fileTokens: { token: string; description?: string }[] = [];
					for (const f of files) {
						const bytes = decodeFileContent(f.content, f.encoding);
						const token = await uploadDatasetFile(this.env, f.name, bytes, f.content_type);
						fileTokens.push(f.description ? { token, description: f.description } : { token });
					}

					const result = await kaggleApi(this.env, "/datasets/create/new", "POST", {
						ownerSlug: this.env.KAGGLE_USERNAME,
						slug,
						title,
						licenseName: license_name,
						isPrivate: is_private,
						files: fileTokens,
						...(subtitle ? { subtitle } : {}),
						...(description ? { description } : {}),
						...(category_ids ? { categoryIds: category_ids } : {}),
					});
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								ref: `${this.env.KAGGLE_USERNAME}/${slug}`,
								result,
							}, null, 2),
						}],
					};
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_dataset_version",
			"Upload a new version of an existing Kaggle dataset. Replaces or augments the prior version's files.",
			{
				dataset: z.string().describe("Dataset reference 'owner/slug' (owner defaults to KAGGLE_USERNAME if omitted)"),
				files: z.array(datasetFileSchema).min(1).describe("Files to include in the new version"),
				version_notes: z.string().describe("Description of what changed in this version"),
				delete_old_versions: z.boolean().default(false).describe("Delete prior versions after this upload"),
				subtitle: z.string().optional(),
				description: z.string().optional(),
				category_ids: z.array(z.string()).optional(),
			},
			async ({ dataset, files, version_notes, delete_old_versions, subtitle, description, category_ids }) => {
				try {
					const parts = dataset.split("/");
					const owner = parts.length === 2 ? parts[0] : this.env.KAGGLE_USERNAME;
					const datasetSlug = parts.length === 2 ? parts[1] : parts[0];

					const fileTokens: { token: string; description?: string }[] = [];
					for (const f of files) {
						const bytes = decodeFileContent(f.content, f.encoding);
						const token = await uploadDatasetFile(this.env, f.name, bytes, f.content_type);
						fileTokens.push(f.description ? { token, description: f.description } : { token });
					}

					const result = await kaggleApi(
						this.env,
						`/datasets/create/version/${encodeURIComponent(owner)}/${encodeURIComponent(datasetSlug)}`,
						"POST",
						{
							versionNotes: version_notes,
							deleteOldVersions: delete_old_versions,
							files: fileTokens,
							...(subtitle ? { subtitle } : {}),
							...(description ? { description } : {}),
							...(category_ids ? { categoryIds: category_ids } : {}),
						},
					);
					return {
						content: [{
							type: "text",
							text: JSON.stringify({ ref: `${owner}/${datasetSlug}`, result }, null, 2),
						}],
					};
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_dataset_status",
			"Check the processing status of a Kaggle dataset (useful right after upload).",
			{
				dataset: z.string().describe("Dataset reference 'owner/slug'"),
			},
			async ({ dataset }) => {
				try {
					const parts = dataset.split("/");
					const owner = parts.length === 2 ? parts[0] : this.env.KAGGLE_USERNAME;
					const datasetSlug = parts.length === 2 ? parts[1] : parts[0];
					const result = await kaggleApi(
						this.env,
						`/datasets/status/${encodeURIComponent(owner)}/${encodeURIComponent(datasetSlug)}`,
					);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.tool(
			"kaggle_datasets_list",
			"Search and list Kaggle datasets.",
			{
				search: z.string().optional().describe("Search query"),
				sort_by: z.enum(["hotness", "votes", "updated", "active", "published"]).optional(),
				page: z.number().optional(),
				page_size: z.number().optional(),
			},
			async ({ search, sort_by, page, page_size }) => {
				try {
					const params = new URLSearchParams();
					if (search) params.set("search", search);
					if (sort_by) params.set("sortBy", sort_by);
					if (page) params.set("page", String(page));
					if (page_size) params.set("pageSize", String(page_size));
					const result = await kaggleApi(this.env, `/datasets/list?${params}`);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		// ── Competition tools ──────────────────────────────────────

		this.server.tool(
			"kaggle_competitions_list",
			"Search and list Kaggle competitions.",
			{
				search: z.string().optional().describe("Search query"),
				category: z.enum(["all", "featured", "research", "recruitment", "gettingStarted", "masters", "playground"]).optional(),
				sort_by: z.enum(["grouped", "prize", "earliestDeadline", "latestDeadline", "numberOfTeams", "recentlyCreated"]).optional(),
				page: z.number().optional(),
			},
			async ({ search, category, sort_by, page }) => {
				try {
					const params = new URLSearchParams();
					if (search) params.set("search", search);
					if (category) params.set("category", category);
					if (sort_by) params.set("sortBy", sort_by);
					if (page) params.set("page", String(page));
					const result = await kaggleApi(this.env, `/competitions/list?${params}`);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		// ── Convenience: run and wait ──────────────────────────────

		this.server.tool(
			"kaggle_run",
			"Push a Python script to Kaggle, wait for execution to complete, and return the output. Combines push + poll + output in one call.",
			{
				title: z.string().describe("Kernel title (used as slug)"),
				code: z.string().describe("Python code to execute"),
				accelerator: z.enum(["none", "NvidiaTeslaP100", "NvidiaTeslaT4", "NvidiaTeslaT4x2", "TpuV6E8"]).default("none").describe("GPU/TPU accelerator"),
				dataset_sources: z.array(z.string()).optional().describe("Dataset references to attach"),
				timeout_seconds: z.number().default(600).describe("Max wait time in seconds (default: 10 min)"),
			},
			async ({ title, code, accelerator, dataset_sources, timeout_seconds }) => {
				try {
					const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
					const ref = `${this.env.KAGGLE_USERNAME}/${slug}`;

					// Push
					await kaggleApi(this.env, "/kernels/push", "POST", {
						slug: ref,
						newTitle: title,
						text: code,
						language: "python",
						kernelType: "script",
						isPrivate: true,
						enableGpu: accelerator !== "none",
						...(accelerator !== "none" ? { machineShape: accelerator } : {}),
						enableInternet: true,
						datasetDataSources: dataset_sources || [],
						competitionDataSources: [],
						kernelDataSources: [],
						categoryIds: [],
					});

					// Poll
					const deadline = Date.now() + timeout_seconds * 1000;
					let status = "queued";
					while (Date.now() < deadline) {
						await new Promise((r) => setTimeout(r, 5000));
						const s = await kaggleApi(this.env, `/kernels/status?userName=${this.env.KAGGLE_USERNAME}&kernelSlug=${slug}`) as Record<string, string>;
						status = s.status || "unknown";
						if (status === "complete" || status === "error") break;
					}

					if (status === "complete") {
						const output = await kaggleApi(this.env, `/kernels/output?userName=${this.env.KAGGLE_USERNAME}&kernelSlug=${slug}`);
						return { content: [{ type: "text", text: JSON.stringify({ status: "complete", ref, output }, null, 2) }] };
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								status,
								ref,
								message: status === "error"
									? "Execution failed. Use kaggle_kernel_output for details."
									: `Timed out after ${timeout_seconds}s. Use kaggle_kernel_status to check.`,
							}, null, 2),
						}],
					};
				} catch (e: unknown) {
					return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);
	}
}

export default new OAuthProvider({
	apiHandler: KaggleMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
