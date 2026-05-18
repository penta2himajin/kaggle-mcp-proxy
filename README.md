# kaggle-mcp-proxy

A remote MCP server on Cloudflare Workers that proxies tool calls to the Kaggle API. Connect from claude.ai (or any MCP client) and run Python/R code on Kaggle's free GPU/TPU infrastructure.

## Tools

| Tool | Description |
|------|-------------|
| `kaggle_kernel_push` | Create/update a kernel and start execution |
| `kaggle_kernel_status` | Check execution status (queued/running/complete/error) |
| `kaggle_kernel_output` | Get execution output (files + log). The `log` field is only populated after the kernel reaches `complete`/`error`; while `queued`/`running` it is empty. Kaggle's public REST API does not expose live execution logs (the official `kaggle` CLI has the same limitation). Poll `kaggle_kernel_status` until completion. |
| `kaggle_kernels_list` | Search kernels |
| `kaggle_accelerators_list` | Fetch the current list of accelerator (`machineShape`) values Kaggle accepts, live from kaggle-cli docs |
| `kaggle_run` | Push code, wait for completion, return output (all-in-one) |
| `kaggle_datasets_list` | Search datasets |
| `kaggle_dataset_create` | Create a new dataset and upload files inline (text or base64) |
| `kaggle_dataset_version` | Upload a new version of an existing dataset |
| `kaggle_dataset_status` | Check processing status of a dataset |
| `kaggle_dataset_files_list` | List files (name, size, columns) inside a dataset |
| `kaggle_dataset_download_url` | Resolve a dataset (or single file) to a temporary signed GCS download URL — no bytes pass through the worker |
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

The `accelerator` parameter on `kaggle_kernel_push` / `kaggle_run` is a
free-form string that maps 1:1 to Kaggle's `machineShape` API field. Pass
`"none"` for CPU-only.

To see what Kaggle currently accepts (the list changes over time as new GPUs
ship), call **`kaggle_accelerators_list`** — it fetches the canonical list
live from
[Kaggle/kaggle-cli `docs/kernels.md`](https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md)
so no proxy redeploy is required when Kaggle adds or removes a shape.

Common shape names at the time of writing: `NvidiaTeslaP100`,
`NvidiaTeslaT4`, `NvidiaTeslaT4Highmem`, `Tpu1VmV38`, `TpuV6E8`. Several
others (A100, L4, H100, RTX Pro 6000, etc.) exist but are restricted to
specific competitions or admins; Kaggle will reject the push if your account
is not eligible.

> **Note:** Kaggle removed `NvidiaTeslaT4x2` from the public API.
> `NvidiaTeslaT4Highmem` is the current higher-resource T4 option.

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

## Platform compatibility

This project is built for **Cloudflare Workers** and tested on that platform. It may work on other MCP-compatible platforms with modifications, but no guarantees are provided.

## License

MIT
