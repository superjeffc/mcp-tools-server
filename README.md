# Remote Model Context Protocol (MCP) Server with GitHub OAuth

A production-grade, serverless Remote Model Context Protocol (MCP) server built on Cloudflare Workers and Durable Objects. This application acts as a secure bridge between AI client interfaces (such as Claude Desktop, Cursor, and Windsurf) and external services, featuring built-in GitHub OAuth 2.1 authentication, role-based tool access control, dynamic fallback analytics, serverless AI image generation, and third-party REST/GraphQL integrations.

---

## Overview

The Model Context Protocol (MCP) allows Large Language Models (LLMs) to query external context and execute tools dynamically. This server exposes a remote MCP endpoint over Server-Sent Events (SSE) hosted on Cloudflare Workers.

To prevent unauthorized access, the server integrates `@cloudflare/workers-oauth-provider` to manage OAuth 2.1 authentication. When an MCP client attempts to connect, users complete a secure GitHub OAuth authorization flow before tool capabilities are granted. User identity and session tokens are stored securely in Cloudflare Durable Objects and KV storage, allowing fine-grained access control to privileged tools.

---

## Architecture and Key Technical Features

### Serverless Architecture at the Edge
- **Cloudflare Workers**: Edge runtime hosting for sub-millisecond routing and high availability without cold starts.
- **Cloudflare Durable Objects (`McpAgent`)**: Provides persistent, stateful SSE connection management and session context preservation across requests.
- **Cloudflare KV (`OAUTH_KV`)**: Stores encrypted OAuth states, authorization requests, and client consent tokens.

### OAuth 2.1 Server and Upstream Authentication
- Acts as an **OAuth 2.1 Server** to connecting MCP clients (e.g., Claude Desktop, Cursor).
- Acts as an **OAuth Client** to GitHub's OAuth server.
- Built-in CSRF protection with state binding cookies (`__Host-CONSENTED_STATE`).
- Client approval dialog with remembered authorization states to minimize friction on repeated logins.

### Role-Based Access Control (RBAC)
- Restricted tools (such as image generation and analytics queries) require user authentication against an explicit list of allowed GitHub handles (`ALLOWED_USERNAMES`).
- Unauthenticated or unauthorized accounts are gracefully restricted to public utility tools.

### Multi-Service API & AI Integrations
- **Cloudflare Workers AI**: Executes the `@cf/black-forest-labs/flux-1-schnell` image generation model directly on edge GPUs.
- **Cloudflare GraphQL Analytics API**: Retrieves zone domain analytics (requests, page views, bandwidth, TTFB latency) with automatic query fallback cascades for handling plan differences.
- **GitHub Octokit API**: Queries authenticated user profiles and permissions.
- **eBird API**: Fetches real-time geospatial bird observation records with customizable search radius and historical range.
- **USDA FoodData Central API**: Provides full-text searching and nutrient profiling for agricultural and branded food items.

---

## Available MCP Tools

| Tool Name | Access Control | Description |
| --- | --- | --- |
| `add` | Public | Utility tool that calculates the sum of two numbers. |
| `getDomainStatistics` | Restricted | Fetches zone analytics (requests, views, bandwidth, TTFB) from Cloudflare GraphQL API with automatic fallback handling. |
| `userInfoOctokit` | Restricted | Retrieves authenticated GitHub user details using the session OAuth token via Octokit. |
| `generateImage` | Restricted | Generates images from text prompts using the FLUX.1 Schnell model on Cloudflare Workers AI. |
| `getNearbyBirds` | Restricted | Queries recent bird observations within a geographic radius using the eBird API. |
| `searchFood` | Restricted | Searches the USDA FoodData Central database for food items by keyword and type filters. |
| `getFoodDetails` | Restricted | Retrieves detailed composition and nutrient profiles for a specific FoodData Central ID (`fdcId`). |

---

## System Flow

```
[ MCP Client ] 
    |
    | (1) Connect /sse
    v
[ Cloudflare Worker ] ---> (2) Check Authorization Header
    |                             |
    | (Missing/Invalid)           | (Valid Token)
    v                             v
[ OAuth Approval Dialog ]     [ Durable Object (MyMCP) ]
    |                             |
    | (3) GitHub OAuth            | (4) Execute Tool & Fetch APIs
    v                             +---> Cloudflare Workers AI (FLUX)
[ GitHub Identity Provider ]      +---> Cloudflare GraphQL Analytics
                                  +---> GitHub Octokit API
                                  +---> eBird / USDA APIs
```

---

## Tech Stack

- **Runtime & Deployment**: Cloudflare Workers, Cloudflare Durable Objects, Cloudflare KV
- **Language**: TypeScript, Node.js compatibility layer
- **Frameworks & Libraries**: Hono, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `agents`, Octokit, Zod
- **AI & Analytics**: Cloudflare Workers AI (`flux-1-schnell`), Cloudflare GraphQL Analytics API
- **Tooling**: Wrangler CLI, TypeScript, MCP Inspector

---

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Cloudflare account with Wrangler CLI configured (`npx wrangler login`)
- GitHub account to create an OAuth Application

### Installation

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/superjeffc/mcp-tools-server.git
   cd mcp-tools-server
   npm install
   ```

2. Generate TypeScript types for Cloudflare Worker bindings:
   ```bash
   npm run cf-typegen
   ```

---

## Local Development Setup

To test the server locally, create a local GitHub OAuth App and configure environment variables.

### 1. Register Local GitHub OAuth Application
- Go to **GitHub Settings** > **Developer Settings** > **OAuth Apps** > **New OAuth App**.
- Set **Application Name**: `Local Remote MCP Server`
- Set **Homepage URL**: `http://localhost:8788`
- Set **Authorization callback URL**: `http://localhost:8788/callback`
- Save the **Client ID** and generate a **Client Secret**.

### 2. Configure Local Environment
Create a `.dev.vars` file in the project root:
```ini
GITHUB_CLIENT_ID=your_local_github_client_id
GITHUB_CLIENT_SECRET=your_local_github_client_secret
COOKIE_ENCRYPTION_KEY=a_random_32_byte_hex_string
CF_API_TOKEN=your_optional_cloudflare_api_token
CF_ZONE_ID=your_optional_cloudflare_zone_id
EBIRD_API_TOKEN=your_optional_ebird_api_token
USDA_API_KEY=your_optional_usda_api_key
```

### 3. Start Local Development Server
```bash
npm run dev
```
The local server runs at `http://localhost:8788`.

### 4. Test via MCP Inspector
Launch the official MCP Inspector:
```bash
npx @modelcontextprotocol/inspector@latest
```
Connect to `http://localhost:8788/sse`. Follow the browser login prompt to complete GitHub authentication and test tool execution.

---

## Production Deployment Guide

### 1. Register Production GitHub OAuth Application
- Create a new OAuth App in GitHub Developer Settings.
- Set **Homepage URL**: `https://<your-worker-name>.<your-subdomain>.workers.dev`
- Set **Authorization callback URL**: `https://<your-worker-name>.<your-subdomain>.workers.dev/callback`

### 2. Configure Cloudflare KV Namespace
Create the KV namespace for storing OAuth states:
```bash
npx wrangler kv namespace create "OAUTH_KV"
```
Copy the returned namespace `id` into `wrangler.jsonc`:
```json
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "<your-kv-namespace-id>"
  }
]
```

### 3. Set Production Secrets
Store secrets securely in Cloudflare using Wrangler:
```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
npx wrangler secret put EBIRD_API_TOKEN
npx wrangler secret put USDA_API_KEY
```

### 4. Deploy to Cloudflare Workers
```bash
npm run deploy
```

---

## Client Configuration Instructions

### Claude Desktop Integration

Add the remote MCP server to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-tools-server": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-worker-name>.<your-subdomain>.workers.dev/sse"
      ]
    }
  }
}
```
After restarting Claude Desktop, complete the pop-up browser authentication. Once authorized, tools will appear under the MCP tool menu.

### Cursor & Windsurf Integration

For Cursor, navigate to **Settings** > **MCP Servers** > **Add New MCP Server**:
- **Name**: `mcp-tools-server`
- **Type**: `command`
- **Command**: `npx mcp-remote https://<your-worker-name>.<your-subdomain>.workers.dev/sse`

---

## Security & Defense in Depth

- **State Validation & Session Binding**: Prevents authorization code injection and CSRF attacks by binding state tokens to browser session cookies.
- **Secret Encryption**: Sensitive properties are encrypted via `COOKIE_ENCRYPTION_KEY` before being transmitted to client sessions.
- **Strict User Scoping**: Privileged tools assess user identity via `this.props.login` against an explicit set of allowed handles.

---

## Project Structure

```
.
├── src/
│   ├── index.ts              # Core Durable Object (MyMCP), tool definitions, and worker entrypoint
│   ├── github-handler.ts     # Hono OAuth 2.1 routes (/authorize, /callback)
│   ├── utils.ts              # OAuth helper methods and upstream request builders
│   └── workers-oauth-utils.ts# CSRF, state management, and cookie binding utilities
├── package.json              # Dependencies and build scripts
├── tsconfig.json             # TypeScript compiler settings
├── wrangler.jsonc            # Cloudflare Worker, Durable Object, and KV bindings
└── README.md                 # Project documentation
```

---

## License & Copyright

Copyright (c) 2026 Jeff Chan. All Rights Reserved.

All rights reserved to Jeff Chan. No part of this repository or its associated software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of the copyright holder.
