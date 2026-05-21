const { makeLlmListProvider } = require('./lib/llm_page_extractor');
const { runProvider } = require('./lib/pipeline');

const provider = makeLlmListProvider({
  name: 'nb_vitalite',
  province: 'NB',
  data_source: 'vitalite_nb',
  rss_url: 'https://vitalitenb.ca/en/health-network/communications/public-notices?format=feed&type=rss',
  source_label: 'Vitalite Public Notices',
  timezone: 'America/Moncton',
  max_items: 15,
  enabled: true,
});

(async () => {
  const t0 = Date.now();
  const result = await runProvider(provider);
  const elapsed = Date.now() - t0;
  console.log('Elapsed (provider+pipeline):', elapsed, 'ms');
  console.log();
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
