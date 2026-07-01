# upwork-mcp

**Single-operator MCP server for the Upwork GraphQL API.**

Built with the Cloudflare Agents SDK + McpAgent. Designed for one owner running their own Upwork account through it — see "Single-owner model" below before deploying for anyone else.

## Features

- **17 high-level tools** for jobs (search + details), contracts, offers, proposals (read-only — Upwork's API has no submit/withdraw mutation, see Limitations), messaging (rooms/stories), profiles, talent search, organizations, ontology (skills). No time-report, work-diary, transaction, portfolio, or milestone-mutation tools exist — Upwork's API doesn't expose those either (verified against the live docs; see Limitations).
- **Power tool**: `execute_upwork_graphql` for any custom query/mutation. Mutations always require an interactive elicitation confirmation — there is no way for a tool caller to skip it.
- **Resources**: `upwork://me/profile`, `upwork://me/contracts`, `upwork://me/proposals`.
- **Prompts**: `draft_proposal`, `analyze_contract` (Claude can auto-load data + write guided output).
- **Elicitation**: Interactive confirmation for high-stakes actions (create offer, raw mutations).
- **Full OAuth2 for Upwork**: `connect_upwork` / disconnect, auto token refresh (only clears stored tokens on a definitive 400/401 auth failure, not on transient errors).
- **Organization / Tenant support**: `list_organizations` + `set_default_tenant` (sends correct `X-Upwork-API-TenantId`).
- **Secure by default**: MCP clients must complete OAuth 2.1 flow (via workers-oauth-provider) before calling tools, AND the human must enter the `OWNER_PASSWORD` on the consent screen — see "Single-owner model".
- **Stateful + durable**: Built on Durable Objects + SQLite (via McpAgent). KV for tokens/prefs (easy to swap).
- Basic rate limiting on failed owner-password attempts (8 per 10 min per IP); friendly errors; ToS note about caching (≤24h).

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

After the MCP client has a valid token for this server, call the `connect_upwork` tool inside a conversation. It returns a link — open it, log into Upwork, authorize the scopes, and you'll be redirected to a success page. Then Upwork tools light up.

## Single-owner model (read before deploying)

This server does **not** isolate Upwork tokens per human user. Upwork tokens are keyed by the MCP client's registered `clientId`, so any two people who complete OAuth using the same registered MCP client would share one Upwork account's tokens. That's fine for the intended use case — one operator, running their own Upwork account through their own MCP clients (Claude Code, Cursor, etc.) — and is not fine for a multi-tenant deployment.

Because `/authorize` has no per-user login of its own, the **only** thing stopping a random visitor from completing OAuth and getting a token issued is the `OWNER_PASSWORD` secret, entered on the consent screen. Deploying without it set is refused (fail closed — see AuthHandler). Set it before your first deploy:

```bash
npx wrangler secret put OWNER_PASSWORD
```

Failed password attempts are rate-limited (8 per 10 minutes per IP, tracked in the `UPWORK_TOKENS` KV) to blunt brute-forcing. Once you approve a client once, a long-lived `mcp_approved_clients` cookie skips the password prompt on that browser going forward — treat that cookie like a credential.

If you need real multi-user isolation later, that requires adding actual per-user authentication in front of `completeAuthorization` and keying Upwork tokens by authenticated user identity instead of `clientId` — not implemented here.

## Architecture Notes

- `UpworkMCP` extends `McpAgent` → per-session durable state + embedded SQLite.
- `OAuthProvider` wraps the `/mcp` handler + provides the standard OAuth endpoints for clients.
- Upwork tokens live in the `UPWORK_TOKENS` KV (keyed by MCP `userId` from props).
- All GraphQL calls go through a small helper that injects Bearer + optional X-Upwork-API-TenantId and does transparent refresh.
- Temp OAuth states for the Upwork leg also live in KV (short TTL).

## Production Readiness Notes

- **Consent UI + owner password**: `/authorize` serves an interactive approval page (client name, scopes, CSRF-protected form, owner-password field, remembered clients via cookie for convenience). Requests are refused (500, fail closed) if `OWNER_PASSWORD` isn't set. See "Single-owner model" above.
- **Security headers**: Basic CSP, X-Frame-Options, etc. are set on /authorize consent form, 404s, and /upwork/callback (via shared `appendSecurityHeaders` helper). Static assets get the matching CSP from `public/_headers`.
- **Config**: Use `UPWORK_REDIRECT_BASE` secret for the Upwork callback — `connect_upwork` now refuses to proceed (with a clear error) if this isn't set, instead of generating a broken redirect URI. Always use real KV namespaces (OAUTH_KV + UPWORK_TOKENS) — see `npm run validate`.
- **Dev for consent UI + cookies**: The interactive /authorize + remembered clients use Secure cookies. Standard `wrangler dev` (http) will not set/send them (browser policy), so no auto-approve and CSRF checks may fail on POST. Use an https tunnel (cloudflared/ngrok) for full local OAuth + consent testing. Prod (workers.dev https) is unaffected.
- **Token refresh resilience**: A transient Upwork 5xx/network error during refresh no longer forces a full re-auth — stored tokens are only cleared on a definitive 400/401 (revoked/expired refresh_token). See `UpworkAuthError` in src/index.ts.
- **Rate limits & ToS**: Upwork ~300 req/min per IP; respect caching rules (≤24h). Failed owner-password attempts are separately rate-limited (see "Single-owner model").
- **Monitoring**: Enable observability in wrangler.jsonc; use `wrangler tail` or dashboards for errors/token refreshes.
- **Secrets & KV**: Never commit real ids or keys. Rotate tokens by disconnect + re-connect.
- **Not yet verified against the live API**: every Upwork GraphQL operation in this codebase (field/argument names) was authored from docs and community references, not run against a live Upwork account. Test the full flow — MCP OAuth → `connect_upwork` → each tool — with real Upwork developer keys before trusting the output. This is the biggest remaining gap; see TODO.md.
- After deploy: run `npm run validate`, register exact callback in Upwork app, test full OAuth + tools E2E with real keys.

## Limitations (Upwork side, confirmed against the live docs)

- **No proposal submission/withdrawal mutation exists.** Checked `#group-Types-Proposals` and the full mutations index at developers.upwork.com directly: only read queries exist (`vendorProposal(s)`, `clientProposal(s)`, `clientInvitation(s)`, `proposalMetadata`). This is deliberate on Upwork's part — write operations that spend Connects stay UI-only to prevent bid-spam automation. Not something this codebase can add.
- **No portfolio type, query, or mutation exists anywhere in the schema.** Portfolio management is UI-only on Upwork's side.
- **Connects balance/spend/purchase is not exposed via the API at all.**
- Caching policy: Upwork ToS prohibits caching data > 24 hours in most cases.
- You cannot (and should not) use this to spam applications.

See "Production Readiness Notes" above for security, consent, and deploy hardening.

## Deploy

```bash
npm run deploy
# Update the redirect URI (now configurable via `UPWORK_REDIRECT_BASE` or `UPWORK_REDIRECT_HOST` secret/env — see src/index.ts header for details) + re-deploy if you changed the worker name/subdomain. The value must *exactly* match what you registered in the Upwork developer console.
# Update the KV ids in wrangler.jsonc with the real ones from `wrangler kv namespace create`.
```

## Environment / Secrets

- `UPWORK_CLIENT_ID`, `UPWORK_CLIENT_SECRET` (wrangler secrets)
- `OWNER_PASSWORD` (wrangler secret, **required** — see "Single-owner model")
- `UPWORK_REDIRECT_BASE` or `UPWORK_REDIRECT_HOST` (wrangler secret, recommended — required before `connect_upwork` will work)
- `UPWORK_TOKENS`, `OAUTH_KV` KV bindings

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
