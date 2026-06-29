import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("Upwork MCP server", () => {
	describe("home page /", () => {
		it("returns the Upwork MCP home HTML (unit style)", async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>(
				"http://example.com/"
			);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			const text = await response.text();
			expect(response.status).toBe(200);
			expect(text).toContain("Upwork MCP Server");
			expect(text).toContain("/mcp");
			expect(text).toContain("/authorize");
		});

		it("returns the Upwork MCP home HTML from assets (integration style)", async () => {
			const request = new Request("http://example.com/");
			const response = await SELF.fetch(request);
			const text = await response.text();
			expect(response.status).toBe(200);
			expect(text).toContain("Best-in-class remote MCP server for the Upwork GraphQL API");
			expect(text).toContain("/mcp");
		});
	});

	describe("unknown routes", () => {
		it("returns 404 for unknown paths", async () => {
			const request = new Request("http://example.com/unknown");
			const response = await SELF.fetch(request);
			expect(response.status).toBe(404);
		});
	});

	describe("Upwork callback error handling", () => {
		it("returns error HTML for missing code/state", async () => {
			const request = new Request("http://example.com/upwork/callback");
			const response = await SELF.fetch(request);
			const text = await response.text();
			expect(response.status).toBe(400);
			expect(text).toContain("Upwork connection failed");
			expect(text).toContain("Missing code or state");
		});

		it("returns error HTML for Upwork error param", async () => {
			const request = new Request("http://example.com/upwork/callback?error=access_denied");
			const response = await SELF.fetch(request);
			const text = await response.text();
			expect(response.status).toBe(200); // our handler returns 200 with error HTML
			expect(text).toContain("Upwork connection failed");
			expect(text).toContain("access_denied");
		});
	});

	// Note: Full OAuth /authorize and token helpers require the OAUTH_PROVIDER injection and KV mocks.
	// Real E2E + mocked fetch for GraphQL/token exchange covered in manual validate + user deploy tests.
	// TODO: expand with @cloudflare/vitest-pool-workers mocks for callUpworkGraphQL, ensureFreshUpworkToken, etc.
});
