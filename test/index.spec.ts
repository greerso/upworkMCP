import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker, {
	exchangeUpworkCode,
	refreshUpworkToken,
	callUpworkGraphQL,
	UpworkAuthError,
	isGraphqlMutation,
	parseCookie,
	parseApprovedClients,
} from "../src/index";

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
			expect(text).toContain("Single-operator remote MCP server for the Upwork GraphQL API");
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

	// Note: Full OAuth /authorize flow (consent form, owner password gate, CSRF) requires the
	// OAUTH_PROVIDER injection and is exercised manually against a real deploy. The token +
	// GraphQL helpers below are pure functions, so they're covered directly with mocked fetch.

	describe("token + graphql helpers (mocked fetch)", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("exchangeUpworkCode normalizes a successful token response", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid", token_type: "bearer" }),
						{ status: 200 }
					)
				)
			);
			const result = await exchangeUpworkCode("code123", "https://example.com/cb", "cid", "csecret");
			expect(result.access_token).toBe("at");
			expect(result.refresh_token).toBe("rt");
			expect(result.expires_at).toBeGreaterThan(Date.now());
		});

		it("exchangeUpworkCode throws when Upwork returns no access_token", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })));
			await expect(exchangeUpworkCode("code123", "https://example.com/cb", "cid", "csecret")).rejects.toThrow(
				"No access_token"
			);
		});

		it("refreshUpworkToken normalizes a successful refresh, falling back to the old refresh_token", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "at2", expires_in: 1800 }), { status: 200 }))
			);
			const result = await refreshUpworkToken("oldrt", "cid", "csecret");
			expect(result.access_token).toBe("at2");
			expect(result.refresh_token).toBe("oldrt");
		});

		it("refreshUpworkToken throws UpworkAuthError with the HTTP status on a definitive auth failure", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid_grant", { status: 401 })));
			let caught: unknown;
			await refreshUpworkToken("badrt", "cid", "csecret").catch((e) => {
				caught = e;
			});
			expect(caught).toBeInstanceOf(UpworkAuthError);
			expect(caught).toMatchObject({ status: 401 });
		});

		it("refreshUpworkToken throws when the 200 response is missing access_token", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })));
			await expect(refreshUpworkToken("rt", "cid", "csecret")).rejects.toThrow("No access_token");
		});

		it("callUpworkGraphQL throws immediately when not connected", async () => {
			await expect(callUpworkGraphQL("{ me }", {}, {} as any, null)).rejects.toThrow("Not connected to Upwork");
		});

		it("callUpworkGraphQL sends the bearer token + tenant header and returns parsed json", async () => {
			const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);
			const tokens = { access_token: "tok", refresh_token: "r", expires_at: Date.now() + 100000 };
			const result = await callUpworkGraphQL("query { me }", {}, {} as any, tokens, "tenant-1");
			expect(result.data.ok).toBe(true);
			const [, init] = fetchMock.mock.calls[0];
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer tok");
			expect(headers["X-Upwork-API-TenantId"]).toBe("tenant-1");
		});

		it("callUpworkGraphQL throws a friendly error when Upwork returns a GraphQL errors array", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "bad field" }] }), { status: 200 }))
			);
			const tokens = { access_token: "tok", refresh_token: "r", expires_at: Date.now() + 100000 };
			await expect(callUpworkGraphQL("query { bad }", {}, {} as any, tokens)).rejects.toThrow("bad field");
		});
	});

	describe("cookie helpers", () => {
		it("parseCookie extracts a named cookie value", () => {
			expect(parseCookie("a=1; b=2; csrfToken=abc123", "csrfToken")).toBe("abc123");
		});

		it("parseCookie returns null when the cookie is absent", () => {
			expect(parseCookie("a=1; b=2", "csrfToken")).toBeNull();
		});

		it("parseApprovedClients splits the comma-separated cookie value", () => {
			expect(parseApprovedClients("mcp_approved_clients=client1,client2")).toEqual(["client1", "client2"]);
		});

		it("parseApprovedClients returns an empty array when absent", () => {
			expect(parseApprovedClients("a=1")).toEqual([]);
		});
	});

	describe("isGraphqlMutation", () => {
		it("detects a plain mutation", () => {
			expect(isGraphqlMutation("mutation { createOffer(input: {}) { id } }")).toBe(true);
		});

		it("detects a mutation preceded by a leading comment line", () => {
			expect(isGraphqlMutation("# leading comment\nmutation { createOffer(input: {}) { id } }")).toBe(true);
		});

		it("does not flag a query as a mutation", () => {
			expect(isGraphqlMutation("query { me { id } }")).toBe(false);
		});
	});
});
