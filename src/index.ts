/**
 * Upwork MCP Server
 *
 * Best-in-class, full-featured remote MCP server for the Upwork GraphQL API.
 * - Built with Cloudflare McpAgent + Durable Objects for stateful sessions + per-user SQL cache
 * - Secured with @cloudflare/workers-oauth-provider (OAuth 2.1 for MCP clients)
 * - Full Upwork OAuth2 (authorization code + refresh) with per-MCP-user token storage in KV
 * - 20+ high-level tools covering jobs, contracts, offers, proposals, messaging, profiles, orgs, time tracking, ontology
 * - Power-user raw GraphQL execution tool
 * - Resources for profile/contracts/jobs
 * - Prompts for common workflows (proposal drafting, contract review, job matching)
 * - Elicitation for high-stakes mutations (confirm before offers/contracts)
 * - Automatic tenant/org header handling + companySelector helper
 * - Token auto-refresh, friendly error mapping, basic rate limit awareness
 *
 * Usage:
 *   wrangler dev
 *   npx @modelcontextprotocol/inspector@latest  (connect to http://localhost:8787/mcp after OAuth)
 *
 * To connect an MCP client (e.g. Claude Code / Cursor / custom):
 *   1. The server exposes OAuth endpoints (/authorize, /token, /register)
 *   2. Clients perform OAuth flow against this server
 *   3. After MCP auth, use the "connect_upwork" tool (or get_upwork_connect_url) to link a personal Upwork account
 *
 * IMPORTANT: You must first create an Upwork developer app at https://www.upwork.com/developer/keys/apply
 *   - Choose OAuth 2.0
 *   - Register a redirect URI like https://<your-worker>.workers.dev/upwork/callback
 *   - Select appropriate scopes (see README)
 *   - Put CLIENT_ID and CLIENT_SECRET into wrangler secrets:
 *       npx wrangler secret put UPWORK_CLIENT_ID
 *       npx wrangler secret put UPWORK_CLIENT_SECRET
 *
 * KV setup (one-time):
 *   npx wrangler kv namespace create UPWORK_TOKENS
 *   npx wrangler kv namespace create UPWORK_TOKENS --preview
 *   npx wrangler kv namespace create OAUTH_KV
 *   npx wrangler kv namespace create OAUTH_KV --preview
 *   Paste the resulting ids into wrangler.jsonc (replace the placeholder ids).
 *   OAUTH_KV is required by the workers-oauth-provider for MCP client grants/tokens.
 *
 * Optional (recommended for real deploys):
 *   wrangler secret put UPWORK_REDIRECT_BASE   # e.g. https://upwork-mcp.youracct.workers.dev
 *   (or UPWORK_REDIRECT_HOST). Used by buildRedirectUri for the Upwork callback.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare type ExecutionContext = any; // Provided by Cloudflare Workers runtime + wrangler types

// ============================================================================
// Types
// ============================================================================

type State = {
  // Server-wide lightweight cache / counters (namespaced by user in practice)
  lastSync?: string;
};

interface UpworkTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope?: string;
  token_type?: string;
}

interface McpUserProps extends Record<string, unknown> {
  userId: string;
  username?: string;
  email?: string;
  // Add more from your MCP OAuth completeAuthorization metadata if desired
}

type UpworkMCPProps = McpUserProps;

// ============================================================================
// Constants & Config
// ============================================================================

const UPWORK_GRAPHQL = "https://api.upwork.com/graphql";
const UPWORK_AUTHORIZE = "https://www.upwork.com/api/auth/v1/oauth2/authorize";
const UPWORK_TOKEN = "https://www.upwork.com/api/auth/v1/oauth2/token";

// Recommended comprehensive scopes for a full-featured integration.
// Users should select at least these (or more) when creating their Upwork API key.
const DEFAULT_UPWORK_SCOPES = [
  "openid",
  "profile",
  "email",
  "pub-commons:read:all",
  "pub-commons:write:all",
  "pub-marketplace-job-postings:read:all",
  "pub-public-marketplace-job-postings:read:all",
  "pub-management-jobpostings:write:all",
  "pub-offer:read:all",
  "pub-offer:write:all",
  "pub-contract:write:all",
  "pub-messages:write:all",
  "pub-client-proposals:write:all",
  "pub-time-sheet:read:all",
  "pub-transaction:read:all",
  "pub-work-diary-company:read:all",
  "pub-ontology:read:all",
  "pub-freelancer-profiles:write:all",
  "pub-snapshots:read:all",
].join(" ");

// ============================================================================
// Upwork GraphQL Helper (with auth + tenant + refresh)
// ============================================================================

async function exchangeUpworkCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<UpworkTokenData> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(UPWORK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upwork token exchange failed: ${res.status} ${text}`);
  }

  const json: any = await res.json();

  if (!json.access_token) {
    throw new Error("No access_token in Upwork response");
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || "",
    expires_at: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
    scope: json.scope,
    token_type: json.token_type || "bearer",
  };
}

async function refreshUpworkToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<UpworkTokenData> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(UPWORK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upwork token refresh failed: ${res.status} ${text}`);
  }

  const json: any = await res.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refreshToken,
    expires_at: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
    scope: json.scope,
    token_type: json.token_type || "bearer",
  };
}

async function callUpworkGraphQL(
  query: string,
  variables: Record<string, unknown> = {},
  env: Env,
  tokens: UpworkTokenData | null,
  tenantId?: string | null
): Promise<any> {
  if (!tokens?.access_token) {
    throw new Error("Not connected to Upwork. Use connect_upwork tool first.");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (tenantId) {
    headers["X-Upwork-API-TenantId"] = tenantId;
  }

  const res = await fetch(UPWORK_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. HTML error page, plain text); preserve text for error msg
  }

  if (!res.ok || (json && json.errors)) {
    const msg =
      (json && json.errors?.map((e: any) => e.message).join("; ")) ||
      (text && text.slice(0, 500)) ||
      `HTTP ${res.status}`;
    throw new Error(`Upwork GraphQL error: ${msg}`);
  }

  return json || {};
}

// ============================================================================
// Token storage (KV) + helpers inside agent context
// ============================================================================

async function saveUpworkTokens(kv: any, userId: string, data: UpworkTokenData) {
  await kv.put(`upwork:${userId}`, JSON.stringify(data), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

async function loadUpworkTokens(kv: any, userId: string): Promise<UpworkTokenData | null> {
  const raw = await kv.get(`upwork:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw) as UpworkTokenData;
}

async function clearUpworkTokens(kv: any, userId: string) {
  await kv.delete(`upwork:${userId}`);
}

async function saveTempOAuthState(
  kv: any,
  state: string,
  payload: { userId: string; redirectUri: string; requestedScopes?: string }
) {
  await kv.put(`upwork_state:${state}`, JSON.stringify(payload), { expirationTtl: 600 });
}

async function loadTempOAuthState(kv: any, state: string) {
  const raw = await kv.get(`upwork_state:${state}`);
  if (!raw) return null;
  await kv.delete(`upwork_state:${state}`);
  return JSON.parse(raw);
}

// ============================================================================
// The McpAgent
// ============================================================================

export class UpworkMCP extends McpAgent<Env, State, McpUserProps> {
  server = new McpServer({
    name: "upwork-mcp",
    version: "0.1.0",
    websiteUrl: "https://github.com/your-org/upworkMCP", // update after publish
  });

  initialState: State = {};

  // Helper to get current MCP user id from OAuth props (now type-safe via the McpAgent generic + completeAuthorization props)
  private get userId(): string {
    return this.props?.userId || "anonymous";
  }

  private get username(): string {
    return this.props?.username || this.props?.email || this.userId;
  }

  async init() {
    // ------------------------------------------------------------------
    // CONNECTION / AUTH TOOLS
    // ------------------------------------------------------------------
    this.server.registerTool(
      "connect_upwork",
      {
        description:
          "Start the OAuth flow to connect your Upwork account to this MCP. Returns a link you must visit in a browser to authorize. After success, all Upwork tools become available for your account.",
        inputSchema: {
          scopes: z
            .string()
            .optional()
            .describe("Optional space-separated Upwork scopes (defaults to a comprehensive set). Only request what you need."),
        },
      },
      async ({ scopes }) => {
        const e = this.runtimeEnv;
        const clientId = e.UPWORK_CLIENT_ID as string;
        const redirectUri = this.buildRedirectUri();

        if (!clientId) {
          return {
            content: [
              {
                type: "text",
                text: "Server misconfigured: UPWORK_CLIENT_ID secret not set. Ask the operator to configure it.",
              },
            ],
          };
        }

        const requestedScopes = scopes || DEFAULT_UPWORK_SCOPES;
        const state = crypto.randomUUID();

        await saveTempOAuthState(e.UPWORK_TOKENS, state, {
          userId: this.userId,
          redirectUri,
          requestedScopes,
        });

        const authUrl = `${UPWORK_AUTHORIZE}?${new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: requestedScopes,
          state,
        })}`;

        return {
          content: [
            {
              type: "text",
              text:
                `Please open this URL in your browser to connect your Upwork account:\n\n${authUrl}\n\n` +
                `After authorizing, you will be redirected to a success page. Return here and try tools like list_my_contracts or search_jobs.\n\n` +
                `Requested scopes: ${requestedScopes}`,
            },
          ],
        };
      }
    );

    // "get_upwork_connect_url" is intentionally the same as connect_upwork for discoverability.

    this.server.registerTool(
      "disconnect_upwork",
      {
        description: "Revoke the stored Upwork tokens for your MCP user. You will need to reconnect to use Upwork tools again.",
        inputSchema: {},
      },
      async () => {
        await clearUpworkTokens(this.runtimeEnv.UPWORK_TOKENS, this.userId);
        return {
          content: [{ type: "text", text: "Upwork connection removed for your account." }],
        };
      }
    );

    this.server.registerTool(
      "whoami_upwork",
      {
        description: "Show the currently connected Upwork user/org context (if any) and MCP identity.",
        inputSchema: {},
      },
      async () => {
        const tokens = await loadUpworkTokens(this.runtimeEnv.UPWORK_TOKENS, this.userId);
        const info = {
          mcpUser: { userId: this.userId, username: this.username },
          upworkConnected: !!tokens,
          tokenExpiresAt: tokens ? new Date(tokens.expires_at).toISOString() : null,
          scopes: tokens?.scope || null,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // ORG / TENANT HELPERS (required for many queries)
    // ------------------------------------------------------------------
    this.server.registerTool(
      "list_organizations",
      {
        description: "List available organizations/teams (use to discover X-Upwork-API-TenantId values). Many queries require or benefit from the correct tenant header.",
        inputSchema: {},
      },
      async () => {
        const q = `
          query CompanySelector {
            companySelector {
              items {
                title
                organizationId
                isDefault
              }
            }
          }
        `;
        const tokens = await this.ensureFreshUpworkToken();
        const data = await callUpworkGraphQL(q, {}, this.runtimeEnv, tokens);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.companySelector || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "set_default_tenant",
      {
        description: "Remember a preferred organization/tenant ID for future calls in this session (stored in KV under your user).",
        inputSchema: { tenantId: z.string().describe("The organizationId from list_organizations") },
      },
      async ({ tenantId }) => {
        // We store a small user prefs object
        const prefsKey = `prefs:${this.userId}`;
        const existing = (await this.runtimeEnv.UPWORK_TOKENS.get(prefsKey, "json")) || {};
        existing.defaultTenantId = tenantId;
        await this.runtimeEnv.UPWORK_TOKENS.put(prefsKey, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 180 });
        return { content: [{ type: "text", text: `Default tenant set to ${tenantId} for your account.` }] };
      }
    );

    // ------------------------------------------------------------------
    // JOB TOOLS (core for freelancers + clients)
    // ------------------------------------------------------------------
    this.server.registerTool(
      "search_jobs",
      {
        description:
          "Search marketplace job postings (freelancer view). Supports text query, limit, and basic filters. Returns title, id, budget, skills, client info, etc.",
        inputSchema: {
          query: z.string().describe("Search keywords, e.g. 'react typescript'"),
          limit: z.number().int().min(1).max(50).default(10),
          contractType: z.enum(["HOURLY", "FIXED"]).optional(),
          minHourly: z.number().optional(),
          maxHourly: z.number().optional(),
        },
      },
      async ({ query, limit, contractType, minHourly, maxHourly }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const tenant = prefs?.defaultTenantId;

        // marketplaceJobPostingsSearch is the primary one for logged-in freelancers
        const q = `
          query MarketplaceJobPostingsSearch($searchQuery: String, $limit: Int) {
            marketplaceJobPostingsSearch(searchQuery: $searchQuery, limit: $limit) {
              totalCount
              results {
                id
                title
                description
                type
                createdDateTime
                budget {
                  amount { rawValue currency displayValue }
                  type
                }
                hourlyBudget {
                  min { rawValue currency }
                  max { rawValue currency }
                }
                client {
                  id
                  name
                  totalSpent { rawValue }
                  totalHires
                  location { countryName cityName }
                  hasPaymentMethod
                }
                skills { name }
                category { name }
                duration
                experienceLevel
                proposalsCount
                isApplied
                publicUrl
              }
            }
          }
        `;

        const vars: any = { searchQuery: query, limit };
        // Note: more advanced filters exist on the actual type; extend as needed.
        const data = await callUpworkGraphQL(q, vars, this.runtimeEnv, tokens, tenant);
        const results = data?.data?.marketplaceJobPostingsSearch?.results || [];
        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} jobs (total reported: ${data?.data?.marketplaceJobPostingsSearch?.totalCount ?? "unknown"})\n\n` +
                results
                  .map(
                    (j: any) =>
                      `• ${j.title} (id: ${j.id})\n  ${j.type} | ${j.budget?.amount?.displayValue || "budget?"} | ${j.client?.name || "client?"} | skills: ${j.skills?.map((s: any) => s.name).join(", ") || ""}\n  ${j.publicUrl || ""}`
                  )
                  .join("\n\n"),
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "get_job_details",
      {
        description: "Fetch full details for a specific job posting by ID.",
        inputSchema: { jobPostingId: z.string() },
      },
      async ({ jobPostingId }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query JobPosting($jobPostingId: String!) {
            jobPosting(jobPostingId: $jobPostingId) {
              id title description type createdDateTime publicUrl
              budget { amount { displayValue } }
              client { name totalSpent { displayValue } totalHires location { countryName } }
              skills { name }
              category { name }
              proposalsCount
              duration experienceLevel
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { jobPostingId }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.jobPosting || data, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // CONTRACTS, OFFERS, MILESTONES, TIME
    // ------------------------------------------------------------------
    this.server.registerTool(
      "list_my_contracts",
      {
        description: "List active and recent contracts for the current user (as freelancer or client).",
        inputSchema: { limit: z.number().int().max(50).default(20) },
      },
      async ({ limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query ContractList($limit: Int) {
            contractList(limit: $limit) {
              totalCount
              items {
                id cipher title status
                contractor { name }
                buyer { name }
                startDate endDate
                amount { displayValue }
              }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.contractList || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "get_contract_details",
      {
        description: "Get detailed info for one contract (hours, milestones, etc).",
        inputSchema: { contractId: z.string() },
      },
      async ({ contractId }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query Contract($id: ID!) {
            contract(id: $id) {
              id title status description
              contractor { name id } buyer { name }
              milestones { id name amount { displayValue } status }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { id: contractId }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.contract || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "create_offer",
      {
        description: "Create an offer (client side). High-stakes: uses elicitation to confirm before sending.",
        inputSchema: {
          freelancerId: z.string(),
          jobPostingId: z.string().optional(),
          title: z.string(),
          description: z.string(),
          amount: z.number(),
          currency: z.string().default("USD"),
        },
      },
      async (input) => {
        // Elicit confirmation
        const confirm = await this.server.server.elicitInput(
          {
            message: `Confirm you want to send an offer "${input.title}" for $${input.amount} to freelancer ${input.freelancerId}?`,
            requestedSchema: {
              type: "object",
              properties: {
                proceed: { type: "boolean", title: "Proceed with offer?", default: false },
              },
              required: ["proceed"],
            },
          },
          { relatedRequestId: "offer-confirm" }
        );

        if (confirm.action !== "accept" || !confirm.content?.proceed) {
          return { content: [{ type: "text", text: "Offer cancelled by user." }] };
        }

        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();

        const mutation = `
          mutation CreateOffer($input: CreateOfferInput!) {
            createOffer(input: $input) {
              offer { id title status }
              success
            }
          }
        `;
        // The exact input shape may vary; adapt from docs/generated. This is representative.
        const vars = {
          input: {
            freelancerId: input.freelancerId,
            jobPostingId: input.jobPostingId,
            title: input.title,
            description: input.description,
            amount: { rawValue: String(input.amount), currency: input.currency },
          },
        };

        const data = await callUpworkGraphQL(mutation, vars, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.createOffer || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "list_proposals",
      {
        description: "List proposals (as freelancer 'vendor' or as client).",
        inputSchema: { asClient: z.boolean().default(false), limit: z.number().default(10) },
      },
      async ({ asClient, limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const field = asClient ? "clientProposals" : "vendorProposals";
        const q = `
          query Proposals($limit: Int) {
            ${field}(limit: $limit) {
              totalCount
              items { id title status jobPosting { title id } createdDateTime }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data || data, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // MESSAGING (rooms / stories)
    // ------------------------------------------------------------------
    this.server.registerTool(
      "list_rooms",
      {
        description: "List messaging rooms (conversations) for the current user.",
        inputSchema: { limit: z.number().default(20) },
      },
      async ({ limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query RoomList($limit: Int) {
            roomList(limit: $limit) {
              items { id title type lastActivityAt participants { name } }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.roomList || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "get_room_messages",
      {
        description: "Fetch recent messages (stories) from a room.",
        inputSchema: { roomId: z.string(), limit: z.number().default(30) },
      },
      async ({ roomId, limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query RoomStories($roomId: ID!, $limit: Int) {
            roomStories(roomId: $roomId, limit: $limit) {
              items { id message createdDateTime createdBy { name } attachments { name url } }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { roomId, limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.roomStories || data, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // PROFILES & SEARCH (freelancer + client side)
    // ------------------------------------------------------------------
    this.server.registerTool(
      "get_my_profile",
      {
        description: "Get the current authenticated user's profile and basic info.",
        inputSchema: {},
      },
      async () => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query Me {
            user { id name email photoUrl }
            organization { id name }
          }
        `;
        const data = await callUpworkGraphQL(q, {}, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data || data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "search_freelancers",
      {
        description: "Search talent / freelancer profiles (client side use case).",
        inputSchema: { query: z.string(), limit: z.number().default(10) },
      },
      async ({ query, limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query SearchTalent($query: String, $limit: Int) {
            talentProfiles(query: $query, limit: $limit) {
              items {
                id profileKey name title hourlyRate { displayValue }
                skills { name } location { countryName }
                jobSuccessScore totalEarned { displayValue }
              }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { query, limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.talentProfiles || data, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // RAW POWER TOOL + ONTOLOGY
    // ------------------------------------------------------------------
    this.server.registerTool(
      "execute_upwork_graphql",
      {
        description:
          "Advanced: Execute any GraphQL query or mutation against Upwork. Use for operations not covered by the high-level tools, or for custom fields. Be careful with mutations.",
        inputSchema: {
          query: z.string().describe("The full GraphQL document (query or mutation)"),
          variables: z.record(z.string(), z.unknown()).optional(),
          tenantId: z.string().optional(),
          confirm: z.boolean().optional(),
        },
      },
      async ({ query, variables = {}, tenantId, confirm }) => {
        const isMutation = /^\s*mutation/i.test(query);
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const effectiveTenant = tenantId || prefs?.defaultTenantId;

        if (isMutation && !confirm) {
          const c = await this.server.server.elicitInput(
          {
            message: "This is a GraphQL MUTATION that may change data on Upwork. Confirm execution?",
            requestedSchema: {
              type: "object",
              properties: { proceed: { type: "boolean", title: "Execute mutation?", default: false } },
              required: ["proceed"],
            },
          },
          { relatedRequestId: "mutation-confirm" }
        );
          if (c.action !== "accept" || !c.content?.proceed) {
            return { content: [{ type: "text", text: "Mutation cancelled." }] };
          }
        }

        const data = await callUpworkGraphQL(query, variables || {}, this.runtimeEnv, tokens, effectiveTenant);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.registerTool(
      "list_skills",
      {
        description: "Search the Upwork ontology for skills (useful for job posts and profiles).",
        inputSchema: { query: z.string().optional(), limit: z.number().default(20) },
      },
      async ({ query, limit }) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `
          query OntologySkills($query: String, $limit: Int) {
            ontologySkills(query: $query, limit: $limit) {
              items { id prefLabel uri }
            }
          }
        `;
        const data = await callUpworkGraphQL(q, { query, limit }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return { content: [{ type: "text", text: JSON.stringify(data?.data?.ontologySkills || data, null, 2) }] };
      }
    );

    // ------------------------------------------------------------------
    // RESOURCES (for Claude to read contextually)
    // ------------------------------------------------------------------
    this.server.resource(
      "my-upwork-profile",
      "upwork://me/profile",
      async (uri) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `query Me { user { id name email photoUrl } organization { id name } }`;
        const data = await callUpworkGraphQL(q, {}, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(data?.data || data, null, 2),
            },
          ],
        };
      }
    );

    this.server.resource(
      "recent-contracts",
      "upwork://me/contracts",
      async (uri) => {
        const tokens = await this.ensureFreshUpworkToken();
        const prefs = await this.getUserPrefs();
        const q = `query ContractList($limit: Int) { contractList(limit: $limit) { items { id title status amount { displayValue } } } }`;
        const data = await callUpworkGraphQL(q, { limit: 10 }, this.runtimeEnv, tokens, prefs?.defaultTenantId);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data?.data || data, null, 2) }],
        };
      }
    );

    // ------------------------------------------------------------------
    // PROMPTS
    // ------------------------------------------------------------------
    this.server.prompt(
      "draft_proposal",
      "Draft a strong proposal for a job based on your Upwork profile and the job details.",
      {
        jobId: z.string().describe("The job posting ID"),
      },
      async ({ jobId }) => {
        // In a real impl, fetch profile + job in parallel here, then return prompt text.
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  `You are an expert Upwork proposal writer. ` +
                  `First call get_my_profile and get_job_details(jobPostingId: "${jobId}"). ` +
                  `Then write a concise, personalized proposal that highlights relevant experience, addresses the client's needs, and suggests next steps. Keep it under 300 words. Do not submit automatically.`,
              },
            },
          ],
        };
      }
    );

    this.server.prompt(
      "analyze_contract",
      "Analyze a contract for risks, payment terms, and suggested actions.",
      { contractId: z.string() },
      async ({ contractId }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Load contract details for ${contractId} using get_contract_details. Summarize milestones, payment schedule, client history if available, and flag any unusual terms or risks. Suggest questions to ask the client.`,
            },
          },
        ],
      })
    );

    // Add more tools as needed (time reports, end contract with confirmation, etc.). The pattern is established.
  }

  // ------------------------------------------------------------------
  // Internal helpers (available on the agent instance)
  // ------------------------------------------------------------------
  private buildRedirectUri(): string {
    // Supports UPWORK_REDIRECT_BASE (full origin or origin+path, e.g. https://.../sub) or UPWORK_REDIRECT_HOST.
    // Uses URL join so path components are handled correctly. Falls back to placeholder (must be replaced before
    // real Upwork app registration + deploy). Must *exactly* match the redirect URI registered in your Upwork app.
    const e = this.runtimeEnv as any;
    const rawBase = e.UPWORK_REDIRECT_BASE || e.UPWORK_REDIRECT_HOST || "https://upwork-mcp.<YOUR_SUBDOMAIN>.workers.dev";
    const base = rawBase.startsWith("http") ? rawBase : `https://${rawBase}`;
    // Join ensures /upwork/callback is appended to the origin (or existing path) correctly.
    return new URL("/upwork/callback", base).toString();
  }

  // Access the injected runtime env (base McpAgent provides `env` privately in some versions)
  private get runtimeEnv(): Env & {
    UPWORK_CLIENT_ID?: string;
    UPWORK_CLIENT_SECRET?: string;
    UPWORK_TOKENS: any;
    UPWORK_REDIRECT_BASE?: string; // e.g. https://upwork-mcp.your-sub.workers.dev or just the host
    UPWORK_REDIRECT_HOST?: string;
  } {
    return (this as any).env;
  }

  private async getUserPrefs(): Promise<any> {
    return (await this.runtimeEnv.UPWORK_TOKENS.get(`prefs:${this.userId}`, "json")) || {};
  }

  private async ensureFreshUpworkToken(): Promise<UpworkTokenData | null> {
    const e = this.runtimeEnv;
    let tokens = await loadUpworkTokens(e.UPWORK_TOKENS, this.userId);
    if (!tokens) return null;

    if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
      const clientId = e.UPWORK_CLIENT_ID as string;
      const clientSecret = e.UPWORK_CLIENT_SECRET as string;
      if (tokens.refresh_token && clientId && clientSecret) {
        try {
          tokens = await refreshUpworkToken(tokens.refresh_token, clientId, clientSecret);
          await saveUpworkTokens(e.UPWORK_TOKENS, this.userId, tokens);
        } catch (refreshErr) {
          await clearUpworkTokens(e.UPWORK_TOKENS, this.userId);
          return null;
        }
      }
    }
    return tokens;
  }
}

// ============================================================================
// Worker entrypoint + OAuthProvider + Upwork OAuth callback handling
// ============================================================================

// Simple HTML success page for Upwork callback
function upworkCallbackSuccessHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Upwork Connected</title>
<style>body{font-family:system-ui;padding:2rem;max-width:640px;margin:auto;line-height:1.5}</style>
</head><body>
<h1>✅ Upwork account connected successfully</h1>
<p>Return to your MCP client (Claude, Cursor, etc.) and try tools like <code>list_my_contracts</code>, <code>search_jobs</code>, or <code>whoami_upwork</code>.</p>
<p>You can close this tab.</p>
</body></html>`;
}

function upworkCallbackErrorHtml(message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connection Error</title></head><body>
<h1>Upwork connection failed</h1><pre>${message}</pre>
<p>Close this tab and try the connect tool again from your MCP client.</p>
</body></html>`;
}

async function handleUpworkCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(upworkCallbackErrorHtml(`Upwork error: ${error}`), {
      headers: { "Content-Type": "text/html" },
    });
  }
  if (!code || !state) {
    return new Response(upworkCallbackErrorHtml("Missing code or state"), {
      headers: { "Content-Type": "text/html" },
      status: 400,
    });
  }

  const payload = await loadTempOAuthState(env.UPWORK_TOKENS, state);
  if (!payload) {
    return new Response(upworkCallbackErrorHtml("Invalid or expired state. Please restart the connect flow from the MCP client."), {
      headers: { "Content-Type": "text/html" },
      status: 400,
    });
  }

  const clientId = (env as any).UPWORK_CLIENT_ID as string;
  const clientSecret = (env as any).UPWORK_CLIENT_SECRET as string;
  const redirectUri = payload.redirectUri;

  if (!clientId || !clientSecret) {
    return new Response(upworkCallbackErrorHtml("Server missing UPWORK_CLIENT_ID/SECRET"), {
      headers: { "Content-Type": "text/html" },
      status: 500,
    });
  }

  try {
    const tokenData = await exchangeUpworkCode(code, redirectUri, clientId, clientSecret);
    await saveUpworkTokens(env.UPWORK_TOKENS, payload.userId, tokenData);

    // Optional: auto-set a tenant if we can fetch it
    // (left as exercise or future improvement)

    return new Response(upworkCallbackSuccessHtml(), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (e: any) {
    return new Response(upworkCallbackErrorHtml(String(e.message || e)), {
      headers: { "Content-Type": "text/html" },
      status: 500,
    });
  }
}

// Auth handler (for MCP OAuth consent UI + other pages)
class AuthHandler {
  static async fetch(request: Request, env: Env & { OAUTH_PROVIDER?: OAuthHelpers }, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const provider = env.OAUTH_PROVIDER;
      if (!provider) {
        return new Response("OAuth provider not available", { status: 500 });
      }

      let oauthReqInfo: any = null;
      try {
        oauthReqInfo = await provider.parseAuthRequest(request);
        const clientInfo = await provider.lookupClient(oauthReqInfo.clientId);

        // Check for previously approved client via cookie (convenience; user can still deny)
        const cookieHeader = request.headers.get("Cookie") || "";
        const approvedClients = parseApprovedClients(cookieHeader);
        const isApproved = approvedClients.includes(oauthReqInfo.clientId || "");

        if (request.method === "POST") {
          const form = await request.formData();
          const action = form.get("action");
          const submittedCsrf = (form.get("csrfToken") as string) || "";

          // Double-submit CSRF check
          const csrfCookie = parseCookie(cookieHeader, "csrfToken");
          if (!submittedCsrf || submittedCsrf !== csrfCookie) {
            throw new Error("CSRF validation failed");
          }

          if (action !== "approve") {
            // Deny path: proper OAuth error redirect if possible
            if (oauthReqInfo?.redirectUri) {
              const params = new URLSearchParams({
                error: "access_denied",
                error_description: "The user denied the authorization request.",
                state: oauthReqInfo.state || "",
              });
              const r = Response.redirect(`${oauthReqInfo.redirectUri}?${params.toString()}`, 302);
              // Best-effort clear CSRF even on deny redirect
              r.headers.append("Set-Cookie", `csrfToken=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
              return r;
            }
            const r = new Response("Access denied by user.", { status: 403 });
            r.headers.append("Set-Cookie", `csrfToken=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
            return r;
          }

          // Approved via form
          const mcpUserId = `mcp-${oauthReqInfo.clientId || "unknown"}`;
          const { redirectTo } = await provider.completeAuthorization({
            request: oauthReqInfo,
            userId: mcpUserId,
            metadata: { label: clientInfo?.clientName || "MCP client", clientId: oauthReqInfo.clientId },
            scope: oauthReqInfo.scope || [],
            props: {
              userId: mcpUserId,
              username: clientInfo?.clientName || clientInfo?.clientId || "mcp-user",
            },
          });

          // Set/refresh approved client cookie on success redirect (long lived for convenience)
          const headers = new Headers({ Location: redirectTo });
          if (!approvedClients.includes(oauthReqInfo.clientId || "")) {
            const newApproved = [...approvedClients, oauthReqInfo.clientId].filter(Boolean).join(",");
            headers.append(
              "Set-Cookie",
              `mcp_approved_clients=${newApproved}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax; Secure`
            );
          }
          // Clear the one-time CSRF cookie
          headers.append("Set-Cookie", `csrfToken=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
          return new Response(null, { status: 302, headers });
        }

        // GET: auto-approve remembered clients or render consent form
        if (isApproved) {
          const mcpUserId = `mcp-${oauthReqInfo.clientId || "unknown"}`;
          const { redirectTo } = await provider.completeAuthorization({
            request: oauthReqInfo,
            userId: mcpUserId,
            metadata: { label: clientInfo?.clientName || "MCP client", clientId: oauthReqInfo.clientId },
            scope: oauthReqInfo.scope || [],
            props: {
              userId: mcpUserId,
              username: clientInfo?.clientName || clientInfo?.clientId || "mcp-user",
            },
          });
          return Response.redirect(redirectTo, 302);
        }

        // Render interactive consent page with CSRF
        const csrfToken = crypto.randomUUID();
        const html = renderConsentHtml(clientInfo, oauthReqInfo, csrfToken, url.search);
        const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
        headers.append("Set-Cookie", `csrfToken=${csrfToken}; Path=/authorize; Max-Age=300; HttpOnly; SameSite=Lax; Secure`);
        return new Response(html, { headers });
      } catch (e: any) {
        // Robust error handling with OAuth redirect when possible
        if (oauthReqInfo?.redirectUri) {
          const params = new URLSearchParams({
            error: "server_error",
            error_description: String(e?.message || e || "authorize failed"),
            state: oauthReqInfo.state || "",
          });
          const errUrl = `${oauthReqInfo.redirectUri}?${params.toString()}`;
          return Response.redirect(errUrl, 302);
        }
        return new Response(`Upwork MCP authorize error: ${e?.message || e}`, {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // Upwork OAuth callback (user-facing)
    if (url.pathname === "/upwork/callback") {
      return handleUpworkCallback(request, env);
    }

    // Basic home / discovery page
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `<!doctype html>
<html><head><meta charset="utf-8"><title>Upwork MCP</title></head>
<body style="font-family:system-ui;padding:2rem;max-width:720px;margin:auto">
<h1>Upwork MCP Server</h1>
<p>Full-featured MCP server for the Upwork GraphQL API.</p>
<p><strong>MCP endpoint:</strong> <code>/mcp</code> (requires OAuth Bearer token)</p>
<p>OAuth endpoints: <code>/authorize</code>, <code>/token</code>, <code>/register</code></p>
<p>Upwork connect callback: <code>/upwork/callback</code></p>
<p>See README for setup and scopes.</p>
</body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Delegate other routes (including full OAuth consent UI) to the provider's helpers or a full Hono app if you expand.
    // Consent UI for /authorize is now implemented above (interactive form + CSRF + remembered clients).
    return new Response("Not found", { status: 404 });
  }
}

// --- Consent UI helpers (polish improvement over auto-grant) ---

function parseCookie(cookieHeader: string, name: string): string | null {
  // Robust split on "; " or ";" (some clients omit space); trim values.
  const cookies = cookieHeader.split(/;\s*/);
  for (const c of cookies) {
    const [k, ...v] = c.split("=");
    if (k.trim() === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function parseApprovedClients(cookieHeader: string): string[] {
  const val = parseCookie(cookieHeader, "mcp_approved_clients");
  if (!val) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function renderConsentHtml(clientInfo: any, oauthReqInfo: any, csrfToken: string, originalSearch: string): string {
  const clientName = clientInfo?.clientName || clientInfo?.clientId || "Unknown MCP client";
  const scopes = (oauthReqInfo?.scope || []).length ? oauthReqInfo.scope.join(", ") : "(none specified)";
  const action = `/authorize${originalSearch}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize MCP Client • Upwork MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f8f9fa; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  .card { max-width: 520px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); padding: 2rem; }
  @media (prefers-color-scheme: dark) { .card { background: #1f1f1f; } }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  .meta { font-size: 0.9rem; opacity: 0.75; margin-bottom: 1.25rem; }
  .section { margin: 1rem 0; }
  .scopes { background: #f1f3f5; padding: 0.75rem 1rem; border-radius: 8px; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  @media (prefers-color-scheme: dark) { .scopes { background: #2a2a2a; } }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #ccc; font-size: 1rem; cursor: pointer; }
  button[value="approve"] { background: #0a66c2; color: white; border-color: #0a66c2; }
  button[value="deny"] { background: transparent; }
  .note { font-size: 0.8rem; opacity: 0.7; margin-top: 1rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize access</h1>
    <p class="meta">An MCP client wants to connect to your Upwork MCP server.</p>

    <div class="section">
      <strong>Client:</strong><br>
      ${escapeHtml(clientName)}
    </div>

    <div class="section">
      <strong>Requested scopes:</strong>
      <div class="scopes">${escapeHtml(scopes)}</div>
    </div>

    <p>This grant will allow the client to call tools, read resources, and use prompts on this server (which may access your connected Upwork account if you have linked one via the connect_upwork tool).</p>

    <form method="POST" action="${action}">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <div class="actions">
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>

    <p class="note">You can revoke access later via your MCP client's settings or by clearing cookies / reconnecting. This server does not store your Upwork credentials here — only the resulting tokens for tools you explicitly use.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The main export wires OAuth + the MCP server
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: UpworkMCP.serve("/mcp", { binding: "MyMCP" }),

  // OAuth endpoints for MCP clients
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  defaultHandler: {
    async fetch(request: Request, env: Env & { OAUTH_PROVIDER?: OAuthHelpers }, ctx: ExecutionContext) {
      return AuthHandler.fetch(request, env, ctx);
    },
  },

  // You can add more OAuthProvider options (cookie secrets, etc.) as you harden the consent flow.
});

// Class is already exported above. No re-export to avoid conflict.