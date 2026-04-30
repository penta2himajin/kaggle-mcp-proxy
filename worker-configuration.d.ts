/* eslint-disable */
declare namespace Cloudflare {
	interface Env {
		OAUTH_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		ALLOWED_USERS: string;
		KAGGLE_USERNAME: string;
		KAGGLE_KEY: string;
		KAGGLE_SESSION_ID?: string;
		KAGGLE_XSRF_TOKEN?: string;
		MCP_OBJECT: DurableObjectNamespace<import("./src/index").KaggleMCP>;
	}
}
interface Env extends Cloudflare.Env {}
