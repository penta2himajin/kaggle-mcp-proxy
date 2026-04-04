# kaggle-mcp-proxy

A remote MCP server on Cloudflare Workers that proxies tool calls to the Kaggle API. Connect from claude.ai (or any MCP client) and run Python/R code on Kaggle's free GPU/TPU infrastructure.

## Tools

| Tool | Description |
|------|-------------|
| `kaggle_kernel_push` | Create/update a kernel and start execution |
| `kaggle_kernel_status` | Check execution status (queued/running/complete/error) |
| `kaggle_kernel_output` | Get execution results |
| `kaggle_kernels_list` | Search kernels |
| `kaggle_run` | Push code, wait for completion, return output (all-in-one) |
| `kaggle_datasets_list` | Search datasets |
| `kaggle_competitions_list` | Search competitions |

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

## Platform compatibility

This project is built for **Cloudflare Workers** and tested on that platform. It may work on other MCP-compatible platforms with modifications, but no guarantees are provided.

## License

MIT
