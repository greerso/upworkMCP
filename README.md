# upwork-mcp

**Best-in-class full-featured MCP server for the Upwork GraphQL API.**

Built with the Cloudflare Agents SDK + McpAgent for a stateful, durable, production-ready remote MCP server.

## Features

- **20+ high-level tools** for jobs (search + details), contracts, offers, milestones, proposals, messaging (rooms/stories), profiles, talent search, organizations, time reports, ontology (skills/categories), work diary, transactions, etc.
- **Power tool**: `execute_upwork_graphql` for any custom query/mutation with safety elicitation on writes.
- **Resources**: `upwork://me/profile`, `upwork://me/contracts` (and easily extendable).
- **Prompts**: `draft_proposal`, `analyze_contract` (Claude can auto-load data + write guided output).
- **Elicitation**: Interactive confirmation for high-stakes actions (create offer, raw mutations).
- **Full OAuth2 for Upwork**: `connect_upwork` / disconnect, auto token refresh, per-MCP-user storage.
- **Organization / Tenant support**: `list_organizations` + `set_default_tenant` (sends correct `X-Upwork-API-TenantId`).
- **Secure by default**: MCP clients must complete OAuth 2.1 flow against the server (via workers-oauth-provider) before calling tools. `props` carry user identity.
- **Stateful + durable**: Built on Durable Objects + SQLite (via McpAgent). KV for tokens/prefs (easy to swap).
- Rate-limit aware (300/min per IP documented by Upwork), friendly errors, ToS note about caching (≤24h).

## Quick Start (Local)

```bash
npm install
# Set secrets (create an Upwork dev app first!)
npx wrangler secret put UPWORK_CLIENT_ID
npx wrangler secret put UPWORK_CLIENT_SECRET

npm run dev
```

In another terminal, test with the inspector (after you complete MCP OAuth + Upwork connect):

```bash
npx @modelcontextprotocol/inspector@latest
# Connect to http://localhost:8787/mcp  (you will be guided through OAuth)
```

## Upwork App Setup (required)

1. Go to https://www.upwork.com/developer/keys/apply (or /developer)
2. Create OAuth 2.0 app under the correct org context.
3. **Important**: Set a Redirect URI that matches exactly what the server will use, e.g.:
   - Production: `https://upwork-mcp.your-subdomain.workers.dev/upwork/callback`
   - For local testing: use a public HTTPS tunnel (cloudflared, ngrok) pointing at your local /upwork/callback and register that URL.
4. Select scopes during key creation (and again at runtime via the connect tool). See recommended set in the code (`DEFAULT_UPWORK_SCOPES`) and SCOPES.md in similar clients.
5. The key will be reviewed by Upwork (profile requirements apply: real photo, address, clear intended use, reasonable volume).

After approval, store the Client ID + Secret as wrangler secrets (above).

## KV Setup (tokens & prefs)

```bash
npx wrangler kv namespace create UPWORK_TOKENS
npx wrangler kv namespace create UPWORK_TOKENS --preview
# Copy the output ids into wrangler.jsonc (replace the placeholder 0000... values)
```

Then `npm run dev` (local KV works automatically) or `npm run deploy`.

## Connecting from Claude Code / other MCP clients

Remote MCP servers are connected via URL + the OAuth flow exposed by this server (`/authorize`, `/token`, `/register`).

After the MCP client has a valid token for this server, call the `connect_upwork` tool inside a conversation. It returns a link — open it, log into Upwork, authorize the scopes, and you'll be redirected to a success page. Then Upwork tools light up for that user.

Each MCP-authenticated user gets isolated Upwork tokens.

## Architecture Notes

- `UpworkMCP` extends `McpAgent` → per-session durable state + embedded SQLite.
- `OAuthProvider` wraps the `/mcp` handler + provides the standard OAuth endpoints for clients.
- Upwork tokens live in the `UPWORK_TOKENS` KV (keyed by MCP `userId` from props).
- All GraphQL calls go through a small helper that injects Bearer + optional X-Upwork-API-TenantId and does transparent refresh.
- Temp OAuth states for the Upwork leg also live in KV (short TTL).

## Limitations (Upwork side)

- The public GraphQL API is read-heavy for many freelancer actions.
- Submitting proposals (spending Connects) and certain write actions that Upwork wants to rate-limit are either missing from the schema or intentionally restricted ("coming soon" scopes exist).
- You cannot (and should not) use this to spam applications.
- Caching policy: Upwork ToS prohibits caching data > 24 hours in most cases.

## Deploy

```bash
npm run deploy
# Update the redirect URI constant in src/index.ts (buildRedirectUri) + re-deploy if you changed the worker name/subdomain.
# Update the KV ids in wrangler.jsonc with the real ones from `wrangler kv namespace create`.
```

## Environment / Secrets

- `UPWORK_CLIENT_ID`, `UPWORK_CLIENT_SECRET` (wrangler secrets)
- `UPWORK_TOKENS` KV binding

## Development Tips

- `npm run dev` + inspector is the fastest loop.
- Use the `execute_upwork_graphql` tool + the official docs (https://www.upwork.com/developer/documentation/graphql/api/docs/index.html) or the generated client (muhammedaksam/upwork-node) to discover more operations and exact variable shapes.
- Add new high-level tools following the existing pattern (load tokens + prefs tenant, call helper, return text content).
- For even richer clients, you can expose more of the 75 queries / 52 mutations surfaced by community generators.

## Credits & Disclaimer

Unofficial. Not affiliated with Upwork. Comply with Upwork's API Terms of Use (https://www.upwork.com/legal#api) and rate limits.

Built following the Cloudflare "build-mcp" skill / Agents SDK patterns for remote MCP servers.

## Next Steps / Polish Ideas

- Dynamic redirect URI (derive from the original request that triggered connect, or a user setting).
- Richer structured content responses (instead of just text JSON dumps).
- Background scheduled jobs per user (e.g. new job alerts via workflows + push/email).
- Better consent UI for the MCP OAuth leg (copy advanced patterns from agents examples + add CSRF/approved clients).
- Optional D1 or SQLite user prefs instead of KV for everything.

PRs welcome.

---

Run `npm run dev`, connect, `connect_upwork`, and start automating your Upwork life responsibly.
