#!/usr/bin/env node
/**
 * Production readiness / plugin-source validate script.
 * Run via: npm run validate
 * Checks: lint, types, no obvious placeholders in wrangler/config, basic sanity.
 * Per CLAUDE.md policy for standalone/plugin-source repos (manual "make validate" equivalent).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔍 Running upwork-mcp production validate...\n');

let errors = 0;

function fail(msg) {
  console.error('❌ ' + msg);
  errors++;
}

function warn(msg) {
  console.warn('⚠️  ' + msg);
}

// 1. Lint
try {
  console.log('→ Running lint (tsc --noEmit)...');
  execSync('npm run lint', { stdio: 'inherit' });
  console.log('✅ lint passed\n');
} catch (e) {
  fail('lint failed');
}

// 2. Types
try {
  console.log('→ Running cf-typegen (wrangler types)...');
  execSync('npm run cf-typegen', { stdio: 'inherit' });
  console.log('✅ types generated\n');
} catch (e) {
  fail('cf-typegen failed');
}

// 3. Check wrangler.jsonc for placeholders
const wranglerPath = path.join(__dirname, '..', 'wrangler.jsonc');
const wrangler = fs.readFileSync(wranglerPath, 'utf8');

if (/00000000000000000000000000000000/.test(wrangler)) {
  fail('Placeholder KV ids (0000...) still present in wrangler.jsonc. Run `npx wrangler kv namespace create ...` for UPWORK_TOKENS and OAUTH_KV and edit ids.');
} else {
  console.log('✅ wrangler.jsonc KV ids look real (no 0000... placeholders)\n');
}

if (wrangler.includes('<YOUR_SUBDOMAIN>') || wrangler.includes('your-subdomain')) {
  warn('Possible placeholder in wrangler comments or config for redirect subdomain.');
}

// 4. Check src for obvious remaining placeholders in code (not comments)
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
if (/https:\/\/upwork-mcp\.<YOUR_SUBDOMAIN>/.test(src)) {
  // This is expected in the fallback; only warn if not behind comment/env
  warn('Placeholder redirect still in src/index.ts fallback (expected until UPWORK_REDIRECT_* secret set + deploy).');
}

// 5. Check for doc drift / stale references to shipped polish (per critical-assessment)
const publicHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
if (publicHtml.includes('the constant in src/index.ts')) {
  warn('Stale text in public/index.html ("the constant in src/index.ts"). Update to reflect env/secret + validate.');
}

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
if (readme.includes('Better consent UI for the MCP OAuth leg (copy advanced patterns from agents examples + add CSRF/approved clients).') || readme.includes('Dynamic redirect URI (derive from the original request')) {
  warn('README Next Steps / Polish Ideas still lists future items for shipped polish (consent UI, configurable redirect). Prune or mark as done.');
}

// 6. Basic package sanity
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
if (!pkg.scripts.validate) {
  warn('No "validate" script in package.json (this script itself).');
}

// 7. Reminder for secrets that can't be checked from the repo (not present in source at all).
warn('Cannot verify from source: OWNER_PASSWORD must be set via `npx wrangler secret put OWNER_PASSWORD` before deploy. /authorize refuses all requests (fail closed) without it — see README "Single-owner model".');

if (errors > 0) {
  console.error(`\n❌ Validate failed with ${errors} error(s). Fix above before considering production-ready.`);
  process.exit(1);
} else {
  console.log('✅✅✅ Validate passed! (lint, types, no critical placeholders)');
  console.log('Note: Full production readiness also requires: real KV ids + deploy, Upwork app callback registration + approval, real E2E test with keys, and addressing remaining TODO items (more tests, mutations, resources, etc.).');
  process.exit(0);
}
