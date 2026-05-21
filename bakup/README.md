# ERstat Provincial Scrapers

National HTML/JSON scraping pipeline for Canadian ER closure data.
Refactored from the original NSH-only scraper to support multiple provinces
through a pluggable provider interface.

## What this is

A single 5-min cron on the `erstat-support` LXC runs `scrape.js`, which
iterates over the providers registered in `scrape.js`. Each provider fetches
its source page, parses entries, classifies them through the shared
regex+LLM pipeline, and writes results to TimescaleDB (via the
`/scraper/*` endpoints on `ts.erstat.ca`) plus Cloudflare D1 (via the
direct query API).

```
provincial_scrapers/
├── scrape.js                       # top-level entry, iterates providers
├── lib/
│   ├── pipeline.js                 # shared fetch → parse → classify → apply → D1 flow
│   ├── fetch.js                    # curl-impersonate-chrome wrapper (WAF bypass)
│   ├── hash.js                     # body-hash computation
│   ├── classify_regex.js           # deterministic fallback classifier
│   ├── classify_llm.js             # Anthropic Haiku 4.5 classifier
│   ├── api.js                      # HTTP client for ts.erstat.ca/scraper/*
│   ├── d1_sync.js                  # Cloudflare D1 official_status writer
│   └── hospital_resolver.js        # per-provider slug → hospital_id lookup
├── providers/
│   └── ns_nshealth.js              # NSH provider (the only one for now)
├── config/providers/
│   └── ns_nshealth.json            # NSH slug → hospital_id map
├── migrations/
│   ├── 001_init.sql                # original NSH schema (already applied)
│   ├── 002_generalize_sources.sql  # renames to source_* and adds source col
│   └── server_endpoints.js         # drop-in Hono router for ts.erstat.ca
├── run-scrape.sh                   # cron wrapper (sources .env, runs node)
├── crontab.sample                  # */5 cron line
├── package.json
└── README.md                       # (this file)
```

## How a provider works

Every provider is a module that exports the same shape:

```js
module.exports = {
  name:        'ns_nshealth',         // identifier (matches config/providers/{name}.json)
  province:    'NS',
  data_source: 'nshealth_html',       // identifier in TS source_* tables + closure_events.source
  enabled:     true,
  timezone:    'America/Halifax',     // for ref_date computation

  async fetch(ctx) { ... },           // raw source data
  async parse(raw, ctx) { ... },      // ParsedEntry[]
  async resolveHospital(entry, ctx) { ... },  // entry → hospital_id (optional, defaults to slug lookup)
  async scope(ctx) { ... },           // hospital_ids this provider writes to in D1
};
```

The `ParsedEntry` shape that `parse()` returns:

```js
{
  source_record_id: string|null,     // stable ID from source, if it has one
  facility_name:    string,
  facility_hint:    string|null,     // slug, site_code, name, etc.
  service_label:    string,          // 'Emergency Department' etc.
  body:             string,
  body_hash:        string,          // SHA-256 prefix, via lib/hash.js
  type_label:       string|null,
  subject_kind:     'facility' | 'zone',
  zone:             string|null,
  location:         string|null,
  metadata:         object,
}
```

The pipeline handles everything else: dedup, regex classify, cache lookup,
LLM classify on cache miss, time-window math, atomic pass, D1 sync.

## Deploy

### One-time: TimescaleDB migration

Stop the cron first so the LXC scraper doesn't hit the API mid-rename:

```bash
ssh erstat-support 'sudo crontab -l > /tmp/cron.bak && sudo crontab -r'
```

Apply the migration:

```bash
scp migrations/002_generalize_sources.sql ts.erstat.ca:/tmp/
ssh ts.erstat.ca 'sudo -u postgres psql -d erstat_history -f /tmp/002_generalize_sources.sql'
```

The verification block at the end should show:

* `source_*` tables exist with the expected row counts
* `source` column populated as `nshealth_html` for all existing rows
* composite uniqueness constraints in place
* view rebuilt

### One-time: Hetzner `server.js` endpoint swap

Open `migrations/server_endpoints.js`. Adjust the `require('./db')` line near
the top to match where your pg pool is exported from in your server. Then
copy the file into your Hetzner server's project directory and mount it:

```js
// in server.js, replacing the old /nsh/* handlers
const scraperRouter = require('./scraper_endpoints');
app.route('/scraper', scraperRouter);
```

The old `/nsh/cached-classifications` and `/nsh/pass` routes can be deleted
once the new LXC scrapers are confirmed working. They reference the renamed
tables and will throw immediately if anyone tries to hit them.

Deploy the server.

### LXC: install scrapers

From a Windows terminal in the backend repo root:

```powershell
scp -r provincial_scrapers erstat-support:/opt/erstat/
ssh erstat-support
```

On the LXC:

```bash
cd /opt/erstat/provincial_scrapers
npm install --omit=dev
sudo chmod +x run-scrape.sh
sudo ln -sf /opt/erstat/provincial_scrapers/run-scrape.sh /opt/erstat/run-scrape.sh
```

Verify env vars are present in `/opt/erstat/.env`:

```bash
grep -E '^(TS_API_URL|TS_API_KEY|ANTHROPIC_API_KEY|CF_ACCOUNT_ID|CF_API_TOKEN|CF_D1_DB_PRODUCTION)=' /opt/erstat/.env
```

### Smoke test

```bash
sudo /opt/erstat/run-scrape.sh
tail -1 /opt/erstat/logs/provincial-scrape.log | python3 -m json.tool
```

Expected output: a JSON object with `ok: true`, `provider: "ns_nshealth"`,
`server_response: { ok: true, ... }`, and `d1_sync: { ok: true, closed_count: N, open_count: M }`.

Verify D1 reflects the pass:

```powershell
wrangler d1 execute waitlog-db --remote --command "SELECT id, official_status, er_closure_end, official_updated_at FROM hospitals WHERE id LIKE 'ns_%' ORDER BY id LIMIT 5;"
```

### Re-enable cron

```bash
sudo crontab -l 2>/dev/null > /tmp/cron.current
echo '*/5 * * * * /opt/erstat/run-scrape.sh' >> /tmp/cron.current
sudo crontab /tmp/cron.current
```

You can delete the old `run-ns-closures.sh` and `ns_closures_parser/` directory
once you've watched a few cron runs complete successfully:

```bash
sudo rm /opt/erstat/run-ns-closures.sh
sudo rm -rf /opt/erstat/ns_closures_parser
```

## Adding a new province

1. Create `config/providers/<name>.json` — slug map mirroring the canonical
   identifiers in `ns-health-service.js` or wherever else they live for that
   province.
2. Create `providers/<name>.js` — implement `fetch()`, `parse()`, and
   `scope()` against the new source. Reuse `lib/fetch.js`, `lib/hash.js`,
   and the resolver. Most providers should be 100-200 lines.
3. Register it in `scrape.js`:
   ```js
   const ALL_PROVIDERS = [
     require('./providers/ns_nshealth'),
     require('./providers/nb_horizon'),     // <-- here
   ];
   ```
4. Test locally with `PROVIDER=nb_horizon node scrape.js`. The pipeline will
   short-circuit other providers and run only the named one.
5. Deploy. Cron picks it up on the next tick.

Each provider runs independently in its own try/catch — a failure in one
province does not stop the others, and they get their own JSON summary
line in the log.

## Operating notes

* **Logs:** one JSON line per provider per run at
  `/opt/erstat/logs/provincial-scrape.log`. Pipe through `jq` for queries.
* **Manual single-provider run:** `PROVIDER=ns_nshealth /opt/erstat/run-scrape.sh`
* **LLM caching:** classifications are cached by `(source, body_hash)`
  forever. The only LLM calls are for genuinely-new advisory text.
  Expect $5-20/year per province at typical event rates.
* **Closure event drift:** if a province updates a closure's
  `expected_reopen` time, a new `closure_events` row is emitted only when
  the change exceeds 15 minutes. Tunable in `server_endpoints.js`.
* **D1 conflict avoidance:** each provider only writes to hospital_ids in
  its `scope()`. Two providers cannot fight over the same row by accident
  unless they declare overlapping scopes (don't do that).
