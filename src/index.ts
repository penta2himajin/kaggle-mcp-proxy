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

async function kaggleApi(
	env: Env,
	path: string,
	method: "GET" | "POST" = "GET",
	body?: unknown,
): Promise<unknown> {
	// Support both legacy Basic auth and new KGAT_ bearer tokens
	const isBearer = env.KAGGLE_KEY.startsWith("KGAT_");
	const authHeader = isBearer
		? `Bearer ${env.KAGGLE_KEY}`
		: `Basic ${btoa(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`)}`;
	const opts: RequestInit = {
		method,
		headers: {
			Authorization: authHeader,
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
						...(accelerator !== "none" ? { accelerator } : {}),
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
						...(accelerator !== "none" ? { accelerator } : {}),
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
