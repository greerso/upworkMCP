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

## Production Readiness Notes

- **Consent UI**: `/authorize` now serves an interactive approval page (client name, scopes, CSRF-protected form, remembered clients via cookie for convenience). See source for details; copy advanced patterns from cloudflare/agents for full CSP/signed cookies in multi-tenant scenarios.
- **Security headers**: Basic CSP, X-Frame-Options, etc. are set on consent/home responses. Enhance in production (e.g. via Cloudflare WAF or response headers in wrangler).
- **Config**: Use `UPWORK_REDIRECT_BASE` secret for the Upwork callback. Always use real KV namespaces (OAUTH_KV + UPWORK_TOKENS) — see `npm run validate`.
- **Rate limits & ToS**: Upwork ~300 req/min per IP; respect caching rules (≤24h). No spam paths exposed.
- **Monitoring**: Enable observability in wrangler.jsonc; use `wrangler tail` or dashboards for errors/token refreshes.
- **Secrets & KV**: Never commit real ids or keys. Rotate tokens by disconnect + re-connect.
- After deploy: run `npm run validate`, register exact callback in Upwork app, test full OAuth + tools E2E with real keys.

## Limitations (Upwork side)

- The public GraphQL API is read-heavy for many freelancer actions.
- Submitting proposals (spending Connects) and certain write actions that Upwork wants to rate-limit are either missing from the schema or intentionally restricted ("coming soon" scopes exist).
- You cannot (and should not) use this to spam applications.
- Caching policy: Upwork ToS prohibits caching data > 24 hours in most cases.

See "Production Readiness Notes" above for security, consent, and deploy hardening.

## Deploy

```bash
npm run deploy
# Update the redirect URI (now configurable via `UPWORK_REDIRECT_BASE` or `UPWORK_REDIRECT_HOST` secret/env — see src/index.ts header for details) + re-deploy if you changed the worker name/subdomain. The value must *exactly* match what you registered in the Upwork developer console.
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

## Next Steps / Polish Ideas (post current polish)

Many items require real deploy + Upwork keys + E2E (see TODO.md "Next / Polish"):

- Real KV namespaces (UPWORK_TOKENS + OAUTH_KV) + edit ids + Upwork app callback registration + approval.
- Full E2E test of MCP client OAuth (new interactive consent) + connect_upwork + live tools + refresh + isolation + elicitation.
- Expand tool surface with more mutations (using shapes from community generators).
- Add unit tests for helpers (mocked fetch; basic endpoint tests added).
- More resources/prompts (recent-proposals added; job templates, stories, etc.).
- Advanced consent (full CSP/signed cookies per agents mcp-worker-authenticated; current is interactive+CSRF+remembered for v1 self-hosted).
- Background jobs, /connect-upwork UI page, per-tool redirect (advanced), harvest common queries to dedicated tools.

Run `npm run validate` as a pre-deploy gate. PRs welcome for the rest.

See README "Production Readiness Notes" and TODO for current status.

---

Run `npm run dev`, connect, `connect_upwork`, and start automating your Upwork life responsibly.
