const HIGH_RISK_TERMS = [
  'bankruptcy','chapter 11','delisting','trading halt','going concern',
  'reverse split','fraud investigation','sec charges'
];

const EVENT_TERMS = [
  'earnings','revenue','guidance','results','fda','trial','offering',
  'merger','acquisition','lawsuit','investigation','recall','layoff'
];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function dateOnly(d) {
  return new Date(d).toISOString().slice(0,10);
}

export async function fetchNewsContext(symbols, key, secret) {
  const unique = [...new Set((symbols || []).filter(Boolean))].slice(0, 8);
  if (!unique.length) return {};

  const url = new URL('https://data.alpaca.markets/v1beta1/news');
  url.searchParams.set('symbols', unique.join(','));
  url.searchParams.set('start', isoDaysAgo(3));
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('limit', '50');
  url.searchParams.set('include_content', 'false');

  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret
    }
  });
  const data = await r.json();
  if (!r.ok) return {};

  const map = Object.fromEntries(unique.map(s => [s, []]));
  for (const article of data?.news || []) {
    const articleSymbols = Array.isArray(article?.symbols) ? article.symbols : [];
    for (const symbol of articleSymbols) {
      if (!map[symbol]) continue;
      const headline = String(article?.headline || '').trim();
      if (!headline) continue;
      if (map[symbol].length < 5) {
        map[symbol].push({
          headline,
          created_at: article?.created_at || null,
          source: article?.source || null
        });
      }
    }
  }
  return map;
}

export async function fetchCorporateActionContext(symbols, key, secret) {
  const unique = [...new Set((symbols || []).filter(Boolean))].slice(0, 8);
  if (!unique.length) return {};

  const url = new URL('https://data.alpaca.markets/v1/corporate-actions');
  url.searchParams.set('symbols', unique.join(','));
  url.searchParams.set('start', dateOnly(Date.now() - 7 * 86400000));
  url.searchParams.set('end', dateOnly(Date.now() + 30 * 86400000));
  url.searchParams.set('limit', '1000');
  url.searchParams.set('data_quality', 'complete');

  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret
    }
  });
  const data = await r.json();
  if (!r.ok) return {};

  const map = Object.fromEntries(unique.map(s => [s, []]));
  for (const [type, rows] of Object.entries(data || {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const symbol = row?.symbol || row?.initiating_symbol || row?.new_symbol;
      if (!map[symbol]) continue;
      if (map[symbol].length < 8) {
        map[symbol].push({
          type,
          ex_date: row?.ex_date || null,
          process_date: row?.process_date || null,
          record_date: row?.record_date || null
        });
      }
    }
  }
  return map;
}

function summarizeRisk(headlines = [], actions = []) {
  const text = headlines.map(x => x.headline).join(' ').toLowerCase();
  const highTerms = HIGH_RISK_TERMS.filter(k => text.includes(k));
  const eventTerms = EVENT_TERMS.filter(k => text.includes(k));

  const actionTypes = actions.map(x => String(x.type || '').toLowerCase());
  const dangerousActions = actionTypes.filter(t =>
    t.includes('reverse_split') ||
    t.includes('worthless') ||
    t.includes('redemption') ||
    t.includes('merger')
  );

  const hardBlock = highTerms.length > 0 || dangerousActions.some(t =>
    t.includes('worthless') || t.includes('redemption')
  );

  let level = 'LOW';
  if (hardBlock || dangerousActions.length) level = 'HIGH';
  else if (eventTerms.length) level = 'MEDIUM';

  return {
    level,
    hard_block: hardBlock,
    high_risk_terms: highTerms,
    event_terms: eventTerms,
    corporate_action_types: [...new Set(actionTypes)]
  };
}

export async function buildCandidateContext(candidates, key, secret) {
  const symbols = (candidates || []).map(c => c.symbol).slice(0, 8);
  const [news, actions] = await Promise.all([
    fetchNewsContext(symbols, key, secret),
    fetchCorporateActionContext(symbols, key, secret)
  ]);

  const out = {};
  for (const symbol of symbols) {
    const headlines = news[symbol] || [];
    const corporateActions = actions[symbol] || [];
    out[symbol] = {
      headlines,
      corporate_actions: corporateActions,
      risk: summarizeRisk(headlines, corporateActions)
    };
  }
  return out;
}
