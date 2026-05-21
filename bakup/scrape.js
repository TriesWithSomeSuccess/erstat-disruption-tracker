#!/usr/bin/env node
// scrape.js
//
// Top-level scraper. Run every 5 min via cron on the erstat-support LXC.
//
// Loops over PROVIDERS in lib/providers.js, running each through the shared
// pipeline. One provider failing does not stop the others — each is wrapped
// in its own try/catch and emits its own summary JSON line.
//
// Exit code:
//   0  — at least one provider ran successfully
//   1  — fatal: no providers configured, or all failed
//
// Set PROVIDER=ns_nshealth (or comma-separated) to run a subset; useful for
// manual debugging without touching the providers registry.

const { runProvider } = require('./lib/pipeline');

// Provider registry. Order is the run order (mostly cosmetic — each runs
// independently). Add new providers here as they come online.
const ALL_PROVIDERS = [
  require('./providers/ns_nshealth'),
  require('./providers/nb_horizon'),
  // Phase 2 — to be added:
  // require('./providers/ab_ahs'),
  // require('./providers/sk_sha'),
  // require('./providers/nl_nlhs'),
  // require('./providers/bc_northern'),
  // require('./providers/nt_nthssa'),
];

function selectProviders() {
  const wanted = process.env.PROVIDER;
  if (!wanted) return ALL_PROVIDERS.filter(p => p.enabled !== false);
  const names = new Set(wanted.split(',').map(s => s.trim()));
  return ALL_PROVIDERS.filter(p => names.has(p.name));
}

async function main() {
  const providers = selectProviders();
  if (providers.length === 0) {
    console.error(`[scrape] no providers selected (env PROVIDER=${process.env.PROVIDER || '(unset)'})`);
    process.exit(1);
  }

  const results = [];
  let anySuccess = false;

  for (const provider of providers) {
    let result;
    try {
      result = await runProvider(provider);
    } catch (err) {
      result = {
        ok: false,
        stage: 'unhandled',
        provider: provider.name,
        error: err.stack || err.message,
      };
    }
    if (result.ok) anySuccess = true;
    results.push(result);

    // Emit one JSON summary line per provider for log scraping
    console.log(JSON.stringify(result));
  }

  process.exit(anySuccess ? 0 : 1);
}

main().catch((err) => {
  console.error(`[scrape] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
