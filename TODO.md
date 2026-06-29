# upworkMCP TODO

## Shipped (merged via git-to-pr)

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
- [x] GitHub issue #1 + PR #2 created/merged with full pipeline (heavy org, critique, simplify, excellent commit, reviews, validate)
- [x] Merged squash to main (GitHub merge commit: e4ccba8249ab16f28cd22aa50a4eb8ca34666302 ; local post-merge: 4fc2c0e). Cleanup done: feature branch deleted locally/remotely, main synced, default branch=main. Post-merge validation (lint + wrangler typegen + dry-run) passed.

- [x] GitHub issue #3 + PR #4 created/merged with full pipeline (post-PR#2 critical review via subagents, fixes for all [implementer] issues from critical-assessment + reviewer subs, PENDING review posted on GH, excellent commit + rich body, manual validation). Remediation for missing MCP client OAuth /authorize handler, OAUTH_KV binding, GraphQL error handling, etc. (root causes of non-functional "Secure remote MCP" after #2).
- [x] Merged squash to main (GitHub merge commit: 7a066732e0a3770ca234abf445985c377f59f58d). Cleanup done: feature branch `fix/mcp-oauth-wiring` deleted locally + remotely, main synced, remote pruned. Post-merge validation (npm run lint clean; wrangler dev lists UPWORK_TOKENS + OAUTH_KV and reaches Ready; types clean). Subagent reviewer + critical-assessment on #4 (0 blockers after fixes; confirmed resolves PR#2 CRITICALs 1-3 + targeted HIGH; low-severity nits addressed or tracked).

## Post-merge review of PR #2 (performed on 2026-06-29 after merge)
**Remediation:** All critical findings addressed in issue #3 + PR #4 (merged squash at 7a06673). Subagent reviewer + critical-assessment run on #4 (see `/tmp/grok-reviews/pr4-review.md` and `/tmp/grok-reviews/pr4-critical-assessment.md`); PENDING GitHub review posted on #4 (id ~4595628681); all [implementer] issues fixed in follow-up commits before merge. 0 blockers post-fixes. Confirmed resolves the auth/KV/isolation gaps.
**Review artifacts:** `/tmp/upworkMCP-PR2-review.md` (detailed 18-issue structured report from reviewer subagent + manual cross-checks against PR body, lib source in node_modules, gh, code, tests, boot).
- **Critical issues found (should have blocked merge):** 
  1. AuthHandler had no /authorize impl (MCP OAuth consent always 404'd; completeAuthorization never called; bearer tokens for /mcp impossible; props always empty → userId="anonymous" for all, total loss of per-user Upwork token isolation). Root: defaultHandler must implement the consent UI + call provider.completeAuthorization (per oauth-provider README + examples).
  2. OAUTH_KV binding entirely absent from wrangler.jsonc (provider *requires* it for grant/token storage; runtime crash on any MCP auth path). Not called out in KV setup steps.
- **HIGH issues:** brittle non-JSON error handling in callUpworkGraphQL (parse after fetch without try, loses body on 4xx/5xx/429 HTML); hardcoded placeholder redirect (and KV ids) make first deploy + Upwork callback registration non-functional without edits.
- Other: stale template tests (all fail), doc over-claims vs shipped tools, minor parse race on state load, unused import, etc.
- Prior self "heavy-advisor equivalent" + pipeline did not catch lib integration contract details or KV requirements (missed during init vs build-mcp assumptions).
**Fixes in this branch (fix/mcp-oauth-wiring):** 
- Added OAUTH_KV (placeholder) to wrangler.jsonc + ran cf-typegen.
- Implemented minimal working /authorize in AuthHandler (auto-grant using per-client-derived userId for isolation; preserves future interactive hardening path per TODO).
- Hardened GraphQL error path (safe text fallback + truncated body).
- Removed dead AuthRequest import; updated setup comments + this TODO section.
- All criticals addressed at root (no fallbacks).

**Safe to merge verdict for PR #2 (retro):** NO — the merge landed non-working core advertised feature ("Secure remote MCP"). The small diff in #2 (DRY + TODO) was correct, but the feature body was incomplete vs claims. Fixes here restore it.

Real deploy + e2e only viable *after* this fix PR merges + user performs the placeholder replacements + exact callback registration + live Upwork keys test (see Next section).

## Next / Polish (post-merge)

- [ ] Update src/index.ts buildRedirectUri + README with your actual worker URL after first deploy (and any dynamic logic)
- [ ] Create real KV namespaces (UPWORK_TOKENS + OAUTH_KV) and edit the ids in wrangler.jsonc (run cf-typegen after)
- [ ] Register the exact /upwork/callback URL in your Upwork developer app
- [x] (from PR#2 post-merge review) Improve the /authorize consent UI — now interactive HTML form with client name, scopes list, approve/deny buttons, double-submit CSRF, and "remembered clients" cookie for auto-approve (see polish/improve-consent-ui branch + PR #6). Critical-assessment addressed parser/CSRF-clear/Secure/redirect-join issues pre-merge. Still recommends full hardening (CSP, signed cookies, etc.) for advanced use per agents examples.
- [ ] Test full flow: MCP client OAuth -> connect_upwork (with tunnel for local) -> real tools against live data
- [ ] Expand tool surface with more mutations (createJobPosting, endContract*, send messages, milestones, etc.) using shapes from the generated-operations.ts we inspected
- [ ] Improve MCP-side consent UI (full CSRF + nice HTML + approved clients cookies) - copy advanced patterns from cloudflare/agents/examples/mcp-worker-authenticated (partially addressed by above interactive version)
- [x] Make redirect host configurable / per-tool param — buildRedirectUri now respects UPWORK_REDIRECT_BASE or UPWORK_REDIRECT_HOST (env/secret). Updated header comments.
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
