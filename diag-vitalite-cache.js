(async () => {
  const { hash } = require('./lib/hash');
  const { lookupCachedClassifications } = require('./lib/api');
  const { parseRssFeed } = require('./lib/llm_page_extractor');
  const { fetchHtml } = require('./lib/fetch');

  const rssUrl = 'https://vitalitenb.ca/en/health-network/communications/public-notices?format=feed&type=rss';
  const indexBody = await fetchHtml(rssUrl);
  let items = parseRssFeed(indexBody);
  const baseUrl = new URL(rssUrl);
  items = items.map(it => {
    let absUrl = it.url;
    try { absUrl = new URL(it.url, baseUrl).toString(); } catch (_) {}
    return { ...it, url: absUrl };
  });
  for (const it of items) it.body_hash = hash('vitalite_nb', 'list_url_v1', it.url);

  const hashes = items.map(it => it.body_hash);
  const cached = await lookupCachedClassifications('vitalite_nb', hashes);
  console.log('Lookup returned', Object.keys(cached).length, 'rows');
  console.log('Lookup keys (full):', Object.keys(cached));
  console.log();

  let hits = 0, misses = 0;
  for (const item of items) {
    const hit = cached[item.body_hash];
    const wouldCacheHit = Boolean(hit && hit.llm_is_closure !== null && !hit.llm_error);
    if (wouldCacheHit) {
      hits++;
      console.log('  HIT  ', item.body_hash.slice(0,12), 'is_closure=' + hit.llm_is_closure);
    } else if (!hit) {
      misses++;
      console.log('  MISS ', item.body_hash.slice(0,12), 'reason=NO_HIT_FOR_THIS_HASH');
    } else {
      misses++;
      console.log('  MISS ', item.body_hash.slice(0,12),
        'reason=PREDICATE_REJECTED is_closure=' + JSON.stringify(hit.llm_is_closure) +
        ' llm_error=' + JSON.stringify(hit.llm_error));
    }
  }
  console.log();
  console.log('Summary: hits=' + hits + ', misses=' + misses);
})().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
