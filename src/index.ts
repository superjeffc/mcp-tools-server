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
	}
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


