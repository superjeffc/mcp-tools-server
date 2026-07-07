import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Octokit } from "octokit";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

declare global {
	interface Env {
		COOKIE_ENCRYPTION_KEY: string;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		CF_API_TOKEN?: string;
		CF_ZONE_ID?: string;
	}
}

async function queryCloudflareGraphQL(
	apiToken: string,
	query: string,
	variables: Record<string, unknown>
): Promise<any> {
	const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Cloudflare API error (${response.status}): ${text}`);
	}

	const json = (await response.json()) as {
		data: any;
		errors?: { message: string; code?: number }[];
	};

	if (json.errors && json.errors.length > 0) {
		throw new Error(json.errors.map((e: any) => `${e.message} (code: ${e.code || "unknown"})`).join("; "));
	}

	return json.data;
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
	// Add GitHub usernames of users who should have access to the image generation tool
	// For example: 'yourusername', 'coworkerusername'
]);

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Github OAuth Proxy Demo",
		version: "1.0.0",
	});

	async init() {
		// Hello, world!
		this.server.tool(
			"add",
			"Add two numbers the way only MCP can",
			{ a: z.number(), b: z.number() },
			async ({ a, b }) => ({
				content: [{ text: String(a + b), type: "text" }],
			}),
		);

		this.server.tool(
			"getDomainStatistics",
			"Fetch domain analytics from Cloudflare (requests, visits, bandwidth, average latency/TTFB). Requires a Cloudflare API token with Zone Analytics Read permissions and a Zone ID.",
			{
				zoneId: z
					.string()
					.optional()
					.describe("The Cloudflare Zone ID for the domain. If not provided, the server's CF_ZONE_ID environment variable will be used."),
				cfApiToken: z
					.string()
					.optional()
					.describe("The Cloudflare API Token. If not provided, the server's CF_API_TOKEN environment variable will be used."),
				hours: z
					.number()
					.min(1)
					.max(168)
					.default(24)
					.describe("Number of hours of history to retrieve (1 to 168 hours)."),
			},
			async ({ zoneId, cfApiToken, hours }) => {
				const activeToken = cfApiToken || this.env.CF_API_TOKEN;
				const activeZoneId = zoneId || this.env.CF_ZONE_ID;

				if (!activeToken) {
					return {
						content: [
							{
								text: "Error: Cloudflare API Token is required. Please provide it as a parameter (cfApiToken) or set the CF_API_TOKEN environment variable/secret.",
								type: "text",
							},
						],
						isError: true,
					};
				}

				if (!activeZoneId) {
					return {
						content: [
							{
								text: "Error: Cloudflare Zone ID is required. Please provide it as a parameter (zoneId) or set the CF_ZONE_ID environment variable/secret.",
								type: "text",
							},
						],
						isError: true,
					};
				}

				const end = new Date();
				const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
				const variables = {
					zoneTag: activeZoneId,
					start: start.toISOString(),
					end: end.toISOString(),
				};

				// We try httpRequestsAdaptiveGroups first, and if that fails, we try httpRequests1hGroups as a fallback
				let data;
				let source = "httpRequestsAdaptiveGroups";
				try {
					const query = `
						query GetTrafficStats($zoneTag: string!, $start: Time!, $end: Time!) {
							viewer {
								zones(filter: { zoneTag: $zoneTag }) {
									httpRequestsAdaptiveGroups(
										filter: { datetime_geq: $start, datetime_leq: $end }
										limit: 1
									) {
										count
										sum {
											edgeResponseBytes
											visits
											edgeTimeToFirstByteMs
										}
									}
								}
							}
						}
					`;
					data = await queryCloudflareGraphQL(activeToken, query, variables);
				} catch (adaptiveError: any) {
					// Fall back to httpRequests1hGroups
					source = "httpRequests1hGroups";
					try {
						const fallbackQuery = `
							query GetTrafficStatsFallback($zoneTag: string!, $start: Time!, $end: Time!) {
								viewer {
									zones(filter: { zoneTag: $zoneTag }) {
										httpRequests1hGroups(
											filter: { datetime_geq: $start, datetime_leq: $end }
											limit: 1
										) {
											count
											sum {
												edgeResponseBytes
												visits
												edgeTimeToFirstByteMs
											}
										}
									}
								}
							}
						`;
						data = await queryCloudflareGraphQL(activeToken, fallbackQuery, variables);
					} catch (fallbackError: any) {
						return {
							content: [
								{
									text: `Failed to retrieve domain statistics.\n\nAdaptive query error: ${adaptiveError.message}\n\nFallback query error: ${fallbackError.message}`,
									type: "text",
								},
							],
							isError: true,
						};
					}
				}

				const zoneData = data?.viewer?.zones?.[0];
				const metricsGroup = zoneData?.[source]?.[0];

				if (!zoneData || !metricsGroup) {
					return {
						content: [
							{
								text: `No analytics data found for Zone ID "${activeZoneId}" in the last ${hours} hours. Please make sure the Zone ID is correct and the domain has traffic.`,
								type: "text",
							},
						],
					};
				}

				const count = metricsGroup.count || 0;
				const sum = metricsGroup.sum || {};
				const visits = sum.visits || 0;
				const bytes = sum.edgeResponseBytes || 0;
				const latencySumMs = sum.edgeTimeToFirstByteMs || 0;
				const avgLatencyMs = count > 0 ? (latencySumMs / count).toFixed(2) : "0.00";

				// Format bandwidth nicely
				let bandwidthStr = `${bytes} B`;
				if (bytes >= 1024 * 1024 * 1024) {
					bandwidthStr = `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
				} else if (bytes >= 1024 * 1024) {
					bandwidthStr = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
				} else if (bytes >= 1024) {
					bandwidthStr = `${(bytes / 1024).toFixed(2)} KB`;
				}

				const resultText = [
					`### Domain Statistics (Last ${hours} Hours)`,
					`* **Source Dataset**: \`${source}\``,
					`* **Total Requests**: ${count.toLocaleString()}`,
					`* **Page Visits (Views)**: ${visits.toLocaleString()}`,
					`* **Bandwidth Transferred**: ${bandwidthStr}`,
					`* **Average Latency (TTFB)**: ${avgLatencyMs} ms`,
				].join("\n");

				return {
					content: [
						{
							text: resultText,
							type: "text",
						},
					],
				};
			}
		);

		// Use the upstream access token to facilitate tools
		this.server.tool(
			"userInfoOctokit",
			"Get user info from GitHub, via Octokit",
			{},
			async () => {
				const octokit = new Octokit({ auth: this.props!.accessToken });
				return {
					content: [
						{
							text: JSON.stringify(await octokit.rest.users.getAuthenticated()),
							type: "text",
						},
					],
				};
			},
		);

		// Dynamically add tools based on the user's login. In this case, I want to limit
		// access to my Image Generation tool to just me
		if (ALLOWED_USERNAMES.has(this.props!.login)) {
			this.server.tool(
				"generateImage",
				"Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
				{
					prompt: z
						.string()
						.describe("A text description of the image you want to generate."),
					steps: z
						.number()
						.min(4)
						.max(8)
						.default(4)
						.describe(
							"The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
						),
				},
				async ({ prompt, steps }) => {
					const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
						prompt,
						steps,
					});

					return {
						content: [{ data: response.image!, mimeType: "image/jpeg", type: "image" }],
					};
				},
			);
		}
	}
}

const provider = new OAuthProvider({
	apiHandlers: {
		"/mcp": MyMCP.serve("/mcp", { binding: "MCP_OBJECT", transport: "auto" }),
		"/sse": MyMCP.serve("/sse", { binding: "MCP_OBJECT", transport: "auto" }),
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	clientIdMetadataDocumentEnabled: true,
	resourceMetadata: {
		bearer_methods_supported: ["header", "query"],
	},
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const token = url.searchParams.get("token") || url.searchParams.get("access_token");
		if (token && !request.headers.has("Authorization")) {
			const headers = new Headers(request.headers);
			headers.set("Authorization", `Bearer ${token}`);
			request = new Request(request, { headers });
		}
		return provider.fetch(request, env, ctx);
	}
};


