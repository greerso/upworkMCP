# upworkMCP TODO

## Current

- [x] Discovered Upwork GraphQL API (api.upwork.com/graphql, OAuth2, 75 queries / 52 mutations from community generator + official docs)
- [x] Scaffoled with cloudflare/agents-starter + agents + @modelcontextprotocol/sdk + workers-oauth-provider per /build-mcp skill
- [x] Implemented full-featured UpworkMCP:
  - Secure remote MCP (OAuthProvider)
  - Per-MCP-user Upwork OAuth + token refresh + KV storage
  - Tenant/org support (X-Upwork-API-TenantId)
  - High-level tools for jobs, contracts, offers (with elicitation), proposals, messaging, profiles, talent search, ontology, raw power tool
  - Resources + prompts
  - Elicitation on writes
- [x] README + setup docs (requires real Upwork API app approval + exact redirect URI registration)
- [x] Local boot verified, types clean, wrangler dev succeeds
- [x] GitHub issue created: https://github.com/greerso/upworkMCP/issues/1 (organized via git-to-pr flow)

## Next / Polish (post initial PR)

- [ ] Update src/index.ts buildRedirectUri + README with your actual worker URL after first deploy
- [ ] Create real KV namespaces and edit the ids in wrangler.jsonc
- [ ] Register the exact /upwork/callback URL in your Upwork developer app
- [ ] Test full flow: MCP client OAuth -> connect_upwork (with tunnel for local) -> real tools against live data
- [ ] Expand tool surface with more mutations (createJobPosting, endContract*, send messages, milestones, etc.) using shapes from the generated-operations.ts we inspected
- [ ] Improve MCP-side consent UI (full CSRF + nice HTML + approved clients cookies) - copy advanced patterns from cloudflare/agents/examples/mcp-worker-authenticated
- [ ] Make redirect host configurable / per-tool param (advanced)
- [ ] Add more resources (job templates, room stories, etc.)
- [ ] Optional: background alerts / scheduled jobs per user (Agents workflows + email or webhooks)
- [ ] Add unit tests for the token + graphql helpers (mocked fetch)
- [ ] After real usage, harvest the most useful queries and promote them to dedicated tools (beyond the raw escape hatch)
- [ ] Consider adding a small UI page at /connect-upwork for users who have already authed the MCP side

## Policy Reminders (from Claude.md / AGENTS.md)

- This is a plugin-source-like standalone (remote MCP server), not a Magnolia service, so post-merge validate is "make validate" if we add one, or manual.
- Never commit directly to main. Feature branch + PR.
- Run full pipeline (critical-assessment via heavy, /simplify, reviews, git-to-pr orchestration) before asking human to merge.

## References Used

- Official docs: https://www.upwork.com/developer/documentation/graphql/api/docs/index.html
- Modern client with full schema dump: https://github.com/muhammedaksam/upwork-node (75q/52m)
- Cloudflare build-mcp skill + agents-sdk mcp/agent/ securing references + live docs
- Upwork OAuth endpoints and X-Upwork-API-TenantId requirements from docs + community

Run `/git-to-pr` (or follow the manual heavy subagent sequence) when ready to ship the first version.
