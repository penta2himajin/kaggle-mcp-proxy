# kaggle-mcp-proxy

A remote MCP server on Cloudflare Workers that proxies tool calls to the Kaggle API. Connect from claude.ai (or any MCP client) and run Python/R code on Kaggle's free GPU/TPU infrastructure.

## Tools

| Tool | Description |
|------|-------------|
| `kaggle_kernel_push` | Create/update a kernel and start execution |
| `kaggle_kernel_status` | Check execution status (queued/running/complete/error) |
| `kaggle_kernel_output` | Get execution results |
| `kaggle_kernel_logs` | Tail kernel execution log. The public API only populates the log after `complete`/`error` (same limitation as the official `kaggle` CLI). Pass `live: true` to attempt Kaggle's undocumented internal RPC for live tailing — experimental, falls back to the public API and emits a `warning` if the internal call fails. |
| `kaggle_kernels_list` | Search kernels |
| `kaggle_run` | Push code, wait for completion, return output (all-in-one) |
| `kaggle_datasets_list` | Search datasets |
| `kaggle_dataset_create` | Create a new dataset and upload files inline (text or base64) |
| `kaggle_dataset_version` | Upload a new version of an existing dataset |
| `kaggle_dataset_status` | Check processing status of a dataset |
| `kaggle_competitions_list` | Search competitions |

### Uploading training data

`kaggle_dataset_create` and `kaggle_dataset_version` accept files inline:

```jsonc
{
  "slug": "my-training-data",
  "title": "My Training Data",
  "files": [
    { "name": "train.csv", "content": "id,label\n1,0\n2,1\n", "content_type": "text/csv" },
    { "name": "weights.bin", "content": "<base64...>", "encoding": "base64" }
  ]
}
```

Each file is uploaded via Kaggle's blob protocol (`POST /blobs/upload` →
`PUT createUrl`), then attached when the dataset (or new version) is finalized.
Because content is sent inline through the MCP request, total payload size is
bounded by Cloudflare Workers' request limits (100 MB on paid plans). For
larger uploads, use the official `kaggle` CLI directly.

### GPU/TPU Accelerators

Specify the `accelerator` parameter when pushing kernels:

| Value | Hardware |
|-------|----------|
| `none` | CPU only |
| `NvidiaTeslaP100` | NVIDIA Tesla P100 (16GB) |
| `NvidiaTeslaT4` | NVIDIA Tesla T4 (16GB) |
| `NvidiaTeslaT4x2` | NVIDIA Tesla T4 x2 |
| `TpuV6E8` | TPU v6e-8 |

Kaggle provides **30 hours/week** of free GPU time.

## Setup

### Prerequisites

- Cloudflare account with Workers enabled
- GitHub account (used as OAuth provider for MCP auth)
- Kaggle account with API token

### 1. Clone and install

```bash
git clone https://github.com/penta2himajin/kaggle-mcp-proxy.git
cd kaggle-mcp-proxy
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
# Update wrangler.jsonc with the returned ID
```

### 3. Create GitHub OAuth App

Go to https://github.com/settings/developers → New OAuth App:

- **Homepage URL**: `https://<your-worker>.workers.dev`
- **Callback URL**: `https://<your-worker>.workers.dev/callback`

### 4. Get Kaggle API token

Go to https://www.kaggle.com/settings → API → Create New API Token.

### 5. Set secrets and deploy

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # any random string
npx wrangler secret put ALLOWED_USERS             # comma-separated GitHub usernames (optional)
npx wrangler secret put KAGGLE_USERNAME            # your Kaggle username
npx wrangler secret put KAGGLE_KEY                 # your Kaggle API token (KGAT_... or legacy key)

npm run deploy
```

### 6. Connect from claude.ai

1. Settings → Connectors → Add custom connector
2. Remote MCP server URL: `https://<your-worker>.workers.dev/mcp`
3. Leave OAuth fields empty (Dynamic Client Registration is supported)
4. Authenticate with GitHub

## Environment Variables (Secrets)

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `COOKIE_ENCRYPTION_KEY` | Yes | Random string for cookie signing |
| `ALLOWED_USERS` | No | Comma-separated GitHub usernames |
| `KAGGLE_USERNAME` | Yes | Kaggle account username |
| `KAGGLE_KEY` | Yes | Kaggle API token |
| `KAGGLE_SESSION_ID` | No | `ka_sessionid` cookie value (only for `kaggle_kernel_logs` with `live: true`; see below) |
| `KAGGLE_XSRF_TOKEN` | No | `XSRF-TOKEN` cookie value (paired with `KAGGLE_SESSION_ID`) |

## Live kernel logs (`live: true`)

The Kaggle public REST API (`/api/v1/kernels/output`) only populates the
log after a kernel reaches `complete` or `error` — the official `kaggle`
CLI's `--follow` flag has the exact same limitation. To stream logs while
a kernel is still running, the Kaggle web UI uses an internal RPC
(`/api/i/kernels.KernelsService/GetKernelSessionLog`) that **rejects
API-key authentication and only accepts session cookies**. After
investigating kagglehub, kagglesdk, and every community project that
calls `/api/i/`, we confirmed there is no API-key → session-cookie
exchange — it requires an interactive browser login.

If you want `live: true` to work, paste your own browser session into
Worker secrets:

1. Log in to https://www.kaggle.com in any browser.
2. Open DevTools → Application → Cookies → `https://www.kaggle.com`.
3. Copy the values of `ka_sessionid` and `XSRF-TOKEN`.
4. Store them as Worker secrets:

   ```bash
   npx wrangler secret put KAGGLE_SESSION_ID    # paste ka_sessionid value
   npx wrangler secret put KAGGLE_XSRF_TOKEN     # paste XSRF-TOKEN value
   ```

Cookies typically last ~30 days. When `live: true` returns a `warning`
mentioning status 401/403, your cookies have expired — re-extract and
re-set the secrets. Without these secrets set, `live: true` falls back to
the public API and returns a warning.

## Platform compatibility

This project is built for **Cloudflare Workers** and tested on that platform. It may work on other MCP-compatible platforms with modifications, but no guarantees are provided.

## License

MIT
