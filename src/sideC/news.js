const axios = require('axios');

/*
 * Catalyst classification v2.
 *
 * Design constraints (from live screener use):
 *  - One real-world event must yield ONE catalyst, even when five wire
 *    services word the headline differently → classify per headline, then
 *    aggregate by category (corroboration raises confidence, never
 *    duplicates), after collapsing near-identical headlines.
 *  - A calendar mention ("X to report Q2 earnings Tuesday") is NOT a
 *    catalyst — nothing has happened yet. Every earnings-family category
 *    carries a scheduled/preview guard.
 *  - Loose single words ("offering", "deal", "launch") are banned; every
 *    pattern needs the securities/event context around the word, plus an
 *    exclusion guard for the known false-positive phrasings.
 *  - Not all catalysts are equal: tier 1 moves price (FDA, M&A, earnings
 *    surprise, offering, bankruptcy, short report), tier 2 is notable
 *    (guidance-adjacent analyst moves, contracts, splits, listing status),
 *    tier 3 is context you can mostly forget (insider trades, product PR,
 *    management changes). The primary catalyst is picked by score =
 *    tier + corroboration + recency, and everything else detected is
 *    surfaced under `others` instead of being silently dropped.
 */

const TIER_BASE = { 1: 100, 2: 60, 3: 30 };
const TIER_NAME = { 1: 'major', 2: 'notable', 3: 'minor' };

// Headlines about earnings that describe the *event on the calendar*, not a
// result. If one of these fires, the headline proves nothing about price.
const SCHEDULED_EARNINGS = /\b(to (report|announce|release|post|host)|will (report|announce|release)|scheduled to|earnings (date|call|conference|webcast|preview|season)|announces? (the )?(date|timing) of|what to expect|ahead of (its )?(earnings|results|report)|upcoming (earnings|results)|estimates? ahead of|reports? (earnings|results) on (mon|tues|wednes|thurs|fri)day|conference call to discuss|invitation to)\b/i;

// Law-firm class-action solicitation spam — fires on every stock that ever
// dropped; it is an echo of an old event, not a new catalyst.
const LAWFIRM_SPAM = /\b(law firm|deadline alert|lead plaintiff|reminds? investors|encourages? investors|shareholder rights (firm|law)|investors? with losses|class action lawsuit filed on behalf|rosen law|pomerantz|glancy|bronstein|levi & korsinsky|bragar eagel|kessler topaz|robbins geller|hagens berman)\b/i;

// Category table. Order matters only as the tie-break when scores are equal
// (most price-relevant families first). `guard` rejects a headline for that
// category; `family` lets a strong member suppress its weak sibling so one
// event never surfaces twice (e.g. "Earnings Beat" + generic "Earnings").
const CATALYST_PATTERNS = [
  // ---- Tier 1: these move price ----
  { id: 'bankruptcy', tier: 1, label: 'Bankruptcy', sentiment: 'bear', color: '#ef4444',
    pattern: /\b(chapter (7|11)|bankruptcy (protection|filing|petition)|files? for bankruptcy|going[- ]concern (doubt|warning)|insolven)/i,
    guard: /\b(emerg(es|ed|ing) from|exits? |avoid(s|ed|ing)? |not filing)\b/i },
  { id: 'fda_approval', tier: 1, label: 'FDA Approval', sentiment: 'bull', color: '#4ade80',
    pattern: /\b(fda|ema|mhra) (grants? )?(full |accelerated )?approv|pdufa approval|receives? (fda|marketing|regulatory) (approval|authorization|clearance)|510\(k\) clearance|emergency use authorization|ce mark/i,
    guard: /\b(seek(s|ing)?|files? for|submits?|awaiting|decision (date|expected)|pdufa date)\b/i },
  { id: 'fda_rejection', tier: 1, label: 'FDA Rejection', sentiment: 'bear', color: '#ef4444',
    pattern: /\b(complete response letter|crl\b|fda (reject|declin|refus)|clinical hold|refuse[sd]? to file)/i },
  { id: 'trial_win', tier: 1, label: 'Trial Win', sentiment: 'bull', color: '#4ade80',
    pattern: /\b(met (its )?(primary|key) endpoint|positive (topline|top-line|interim|phase) (results|data)|phase (1|2|3|i{1,3})b? (trial|study|data|results).{0,40}(positive|success|met|achiev)|clinical trial success|statistically significant (improvement|benefit))/i },
  { id: 'trial_fail', tier: 1, label: 'Trial Fail', sentiment: 'bear', color: '#f87171',
    pattern: /\b(fail(s|ed)? to (meet|achieve|demonstrate)|miss(es|ed)? (its )?(primary|key) endpoint|did not meet (its )?(primary|key) endpoint|discontinu(es?|ing|ed) (the |its )?(trial|study|program)|halts? (the |its )?(trial|study)|clinical trial fail)/i },
  { id: 'earnings_beat', tier: 1, label: 'Earnings Beat', sentiment: 'bull', color: '#34d399', family: 'earnings',
    pattern: /\b((earnings|eps|revenue|profit|results?) (beat|top(s|ped)?|exceed|surpass|crush)|(beats?|tops?) ((on|q[1-4]|quarterly|analyst|street|consensus|wall street) )*(estimates|expectations|the street|forecasts|consensus|top and bottom)|(exceeds?|surpass(es|ed)?) (estimates|expectations|analyst)|blowout (quarter|earnings|results)|record (quarterly )?(revenue|profit|earnings)|earnings surprise)/i,
    guard: SCHEDULED_EARNINGS },
  { id: 'earnings_miss', tier: 1, label: 'Earnings Miss', sentiment: 'bear', color: '#f87171', family: 'earnings',
    pattern: /\b((earnings|eps|revenue|profit|results?) (miss|disappoint|fell short|falls? short)|miss(es|ed)? (on )?(estimates|expectations|consensus|top and bottom)|falls? short of (estimates|expectations)|(wider|bigger)[- ]than[- ]expected loss|(revenue|profit|sales) (plunge|tumble|slump|decline)[sd]? )/i,
    guard: SCHEDULED_EARNINGS },
  { id: 'guidance_raise', tier: 1, label: 'Guidance Raise', sentiment: 'bull', color: '#34d399',
    pattern: /\b(rais(es|ed|ing)|boost(s|ed|ing)?|hik(es|ed|ing)|lifts?|increases?) (its |their |full[- ]year |fiscal |annual |fy ?\d* |20\d\d |q[1-4] |revenue |sales |eps |profit )*(guidance|outlook|forecast)|guidance above (estimates|consensus|expectations)|guides? (above|higher)/i,
    guard: SCHEDULED_EARNINGS },
  { id: 'guidance_cut', tier: 1, label: 'Guidance Cut', sentiment: 'bear', color: '#f87171',
    pattern: /\b(cut(s|ting)?|lower(s|ed|ing)?|slash(es|ed|ing)?|trims?|withdraw(s|ing|n)?|suspends?) (its |their |full[- ]year |fiscal |annual |fy ?\d* |20\d\d |q[1-4] |revenue |sales |eps |profit )*(guidance|outlook|forecast)|guidance below (estimates|consensus|expectations)|guides? (below|lower)|profit warning|warns? on (profit|revenue|sales)/i,
    guard: SCHEDULED_EARNINGS },
  { id: 'mna', tier: 1, label: 'M&A', sentiment: 'bull', color: '#a78bfa',
    pattern: /\b(acquisition of|to acquire|acquires?|to be acquired|merger (agreement|with)|merges? with|buyout (offer|bid|proposal)?|takeover (offer|bid|approach|target)?|take[- ]private|tender offer|receives? (an? )?(unsolicited |non[- ]binding |revised )?(acquisition |buyout |takeover )?(proposal|offer|bid)|definitive (merger )?agreement to (buy|acquire)|explor(es?|ing) (strategic alternatives|a sale))/i,
    guard: /\b(talent acquisition|customer acquisition|data acquisition|land acquisition)\b/i },
  { id: 'offering', tier: 1, label: 'Dilution', sentiment: 'bear', color: '#f87171', family: 'dilution',
    pattern: /\b((public|secondary|direct|equity|share|stock|common stock|underwritten|units?) offering|offering of (shares|common stock|units|securities)|registered direct (offering|placement)|at[- ]the[- ]market (offering|program|facility)|atm (offering|program)|private placement|pric(es|ed|ing) (its |an? )*(upsized )?offering|proposed (public )?offering|convertible (senior )?notes? offering|sells? (shares|stock) to raise|capital raise|dilut(es?|ion|ive))/i,
    guard: /\boffering (customers|clients|users|patients|investors education|free|a new (product|service|feature))\b/i },
  { id: 'short_report', tier: 1, label: 'Short Report', sentiment: 'bear', color: '#f472b6',
    pattern: /\b(hindenburg|muddy waters|citron|kerrisdale|grizzly research|spruce point|scorpion capital|culper research|fuzzy panda|bear cave|short[- ]?seller (report|attack|target)|activist short)/i },

  // ---- Tier 2: notable, tradeable with confirmation ----
  { id: 'earnings_report', tier: 2, label: 'Earnings', sentiment: 'neutral', color: '#94a3b8', family: 'earnings',
    pattern: /\b((reports?|posts?|announces?|releases?) (q[1-4]|first|second|third|fourth)[- ]quarter (results|earnings|financial results)|(q[1-4]|fy ?\d{2,4}|full[- ]year|quarterly) (results|earnings|financial results)|reports? (record )?(quarterly|annual) )/i,
    guard: SCHEDULED_EARNINGS },
  { id: 'fda_designation', tier: 2, label: 'FDA Designation', sentiment: 'bull', color: '#86efac',
    pattern: /\b(breakthrough therapy|fast[- ]track|orphan drug|rmat) designation|granted (fda )?(fast[- ]track|orphan|breakthrough)/i },
  { id: 'analyst_up', tier: 2, label: 'Upgrade', sentiment: 'bull', color: '#86efac',
    pattern: /\b(upgrad(es?|ed) (\w+ ){0,2}(to|shares|stock|rating)|analyst upgrade|double[- ]upgrade|initiat(es?|ed) coverage.{0,40}\b(buy|outperform|overweight|strong buy)|initiat(es?|ed) (with |at )(a )?(buy|outperform|overweight|strong buy)|(rais(es|ed)|hikes?|boosts?|lifts?) (its )?(price target|pt\b)|price target (raised|increased|hiked|boosted))/i,
    guard: /\b(system|software|network|infrastructure|product|app|platform|facility) upgrade/i },
  { id: 'analyst_down', tier: 2, label: 'Downgrade', sentiment: 'bear', color: '#f87171',
    pattern: /\b(downgrad(es?|ed)|double[- ]downgrade|initiat(es?|ed) coverage.{0,40}\b(sell|underperform|underweight)|initiat(es?|ed) (with |at )(a )?(sell|underperform|underweight)|(cut(s)?|lower(s|ed)?|slash(es|ed)?) (its )?(price target|pt\b)|price target (cut|lowered|slashed|reduced))/i },
  { id: 'contract', tier: 2, label: 'Contract Win', sentiment: 'bull', color: '#67e8f9',
    pattern: /\b((wins?|awarded|secures?|lands?|receives?|books?) (a |an |its )?(\$?[\d.,]+ ?(million|billion|m\b|b\b) )?(contract|order|purchase order|award|task order)|contract (award|win)|government contract|idiq contract|defense contract)/i },
  { id: 'partnership', tier: 2, label: 'Partnership', sentiment: 'bull', color: '#67e8f9',
    pattern: /\b((strategic )?partnership with|partners? with|collaboration (agreement|deal|with)|licensing (agreement|deal|pact)|joint venture with|supply agreement|distribution agreement|signs? (a )?(definitive |strategic |exclusive )?(agreement|deal) with|teams? up with)/i },
  { id: 'buyback', tier: 2, label: 'Buyback', sentiment: 'bull', color: '#4ade80',
    pattern: /\b((share|stock) (buyback|repurchase)|repurchase (program|plan|authorization)|buyback program|authoriz(es|ed|ation).{0,30}repurchase)/i },
  { id: 'reverse_split', tier: 2, label: 'Reverse Split', sentiment: 'bear', color: '#f87171', family: 'split',
    pattern: /\b(reverse (stock )?split|1[- ]for[- ]\d+ (reverse )?(stock )?split)/i },
  { id: 'split', tier: 2, label: 'Stock Split', sentiment: 'bull', color: '#4ade80', family: 'split',
    pattern: /\b(\d+[- ]for[- ]1 (stock )?split|stock split)/i,
    guard: /\breverse\b/i },
  { id: 'index_add', tier: 2, label: 'Index Add', sentiment: 'bull', color: '#a78bfa', family: 'index',
    pattern: /\b((added to|joins?|to join|set to join|inclusion in) (the )?(s&p ?(500|400|600)|nasdaq[- ]?100|russell ?(1000|2000|3000)|dow jones))/i },
  { id: 'index_remove', tier: 2, label: 'Index Removal', sentiment: 'bear', color: '#f87171', family: 'index',
    pattern: /\b((removed|dropped|deleted) from (the )?(s&p|nasdaq[- ]?100|russell|dow jones))/i },
  { id: 'uplisting', tier: 2, label: 'Uplisting', sentiment: 'bull', color: '#86efac', family: 'listing',
    pattern: /\b(uplist|approved for listing on (the )?(nasdaq|nyse)|begins? trading on (the )?(nasdaq|nyse))/i },
  { id: 'delisting', tier: 2, label: 'Delisting Risk', sentiment: 'bear', color: '#f87171', family: 'listing',
    pattern: /\b(delist|non[- ]compliance|listing (deficiency|requirement)|minimum bid price (requirement|rule)|(deficiency|compliance) (notice|notification|letter) from (the )?(nasdaq|nyse))/i,
    guard: /\b(regain(s|ed)?|back in|cures?[sd]?) compliance\b/i },
  { id: 'legal', tier: 2, label: 'Legal Risk', sentiment: 'bear', color: '#f472b6',
    pattern: /\b(lawsuit|class action|sec (charg|investigat|probe|subpoena)|doj (investigat|probe|charg)|criminal (charges|probe)|fraud (charges?|allegations?)|under investigation)/i,
    // spam + resolved-in-their-favor headlines are not new legal risk
    guard: new RegExp(LAWFIRM_SPAM.source + String.raw`|\bwins? (the )?(lawsuit|case|patent)|court rul(es|ing) in (its |their )?favor|settl(es|ed|ement)|dismiss(es|ed|al)`, 'i') },
  { id: 'dividend_cut', tier: 2, label: 'Dividend Cut', sentiment: 'bear', color: '#f87171', family: 'dividend',
    pattern: /\b((cuts?|slash(es|ed)?|suspends?|eliminat(es|ed)|reduc(es|ed)) (its )?(quarterly |annual )?dividend|dividend (cut|suspension))/i },

  // ---- Tier 3: context — usually forgettable on its own ----
  { id: 'dividend_raise', tier: 3, label: 'Dividend Raise', sentiment: 'bull', color: '#86efac', family: 'dividend',
    pattern: /\b((rais(es|ed)|boost(s|ed)?|hik(es|ed)|increas(es|ed)|initiat(es|ed)|declares? (a )?special) (its )?(quarterly |annual |cash )?dividend|dividend (increase|hike|initiation))/i },
  { id: 'squeeze', tier: 3, label: 'Short Squeeze', sentiment: 'bull', color: '#fb923c',
    pattern: /\b(short squeeze|heavily shorted|short interest (surge|spike|jump|soar))/i },
  { id: 'insider_buy', tier: 3, label: 'Insider Buy', sentiment: 'bull', color: '#fbbf24',
    pattern: /\b(insider (buy|purchas)|(ceo|cfo|coo|director|officer|chairman|president) (buys?|bought|purchas(es|ed)))/i },
  { id: 'insider_sell', tier: 3, label: 'Insider Sell', sentiment: 'bear', color: '#f87171',
    pattern: /\b(insider (sell|sale|dump)|(ceo|cfo|coo|director|officer|chairman|president) (sells?|sold|dumps?|unloads?))/i },
  { id: 'shelf', tier: 3, label: 'Shelf Filing', sentiment: 'bear', color: '#fda4af', family: 'dilution',
    pattern: /\b(shelf (registration|offering|filing)|files? (a )?(mixed |universal )?shelf|form s-3|\bs-3\b)/i },
  { id: 'legal_win', tier: 3, label: 'Legal Win', sentiment: 'bull', color: '#86efac',
    pattern: /\b(wins? (lawsuit|patent (case|dispute|litigation|ruling))|court rul(es|ing) in (its )?favor|favorable (court )?ruling|settl(es|ement) (with|of)|patent granted|receives? patent)/i },
  { id: 'product', tier: 3, label: 'Product Launch', sentiment: 'bull', color: '#93c5fd',
    pattern: /\b((launch(es|ed)?|unveils?|introduces?|debuts?) (its |the |a |an )?(new )?(product|platform|app|device|drug|chip|vehicle|model|service line)|commercial launch)/i },
  { id: 'mgmt_change', tier: 3, label: 'Mgmt Change', sentiment: 'neutral', color: '#94a3b8',
    pattern: /\b((ceo|cfo|coo|chief executive|chief financial) (steps? down|resigns?|departs?|to step down|retir(es|ing))|(appoints?|names?) (a )?new (ceo|cfo|coo|chief executive))/i },
  { id: 'layoffs', tier: 3, label: 'Restructuring', sentiment: 'neutral', color: '#94a3b8',
    pattern: /\b(lay(s)? ?offs?|job cuts|cuts? \d+% of (its )?(workforce|staff|jobs)|workforce reduction|restructuring (plan|program)|cost[- ]cutting (plan|measures))/i },
];

// A strong family member silences its weak siblings so one event can't show
// up twice ("Earnings Beat" + "Earnings"; "Dilution" + "Shelf Filing").
function suppressWeakSiblings(hits) {
  const byFamily = new Map();
  for (const h of hits) {
    const fam = h.def.family;
    if (!fam) continue;
    const cur = byFamily.get(fam);
    if (!cur || h.score > cur.score) byFamily.set(fam, h);
  }
  return hits.filter(h => {
    const fam = h.def.family;
    return !fam || byFamily.get(fam) === h;
  });
}

// Generalized one-event-one-catalyst rule (not just earnings): when every
// headline behind category B also triggered category A, and both point the
// same direction, B is a re-description of A's event — "FDA grants approval
// on positive Phase 3 data" must not surface as FDA Approval AND Trial Win.
// Opposite directions are never merged: "beats estimates but cuts guidance"
// is genuinely two facts and both must survive.
function suppressSameEvidence(hits, order) {
  const drop = new Set();
  for (const a of hits) {
    for (const b of hits) {
      if (a === b || drop.has(b)) continue;
      if (a.def.sentiment !== b.def.sentiment) continue;
      let subset = true;
      for (const i of b.idx) if (!a.idx.has(i)) { subset = false; break; }
      if (!subset) continue;
      if (a.score > b.score ||
          (a.score === b.score && order.get(a.def.id) < order.get(b.def.id))) {
        drop.add(b);
      }
    }
  }
  return hits.filter(h => !drop.has(h));
}

function normalizeHeadline(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Accepts plain strings or {headline, ts} (ts in ms). Returns deduped items.
function toItems(headlines, nowMs) {
  const seen = new Set();
  const items = [];
  for (const h of headlines || []) {
    const text = typeof h === 'string' ? h : h && h.headline;
    if (!text) continue;
    const norm = normalizeHeadline(text);
    if (!norm || seen.has(norm)) continue; // same story re-worded identically
    seen.add(norm);
    let ageHours = null;
    const ts = typeof h === 'object' && h ? h.ts : null;
    if (Number.isFinite(ts) && ts > 0) {
      ageHours = Math.max(0, (nowMs - ts) / 3600000);
    }
    items.push({ text, ageHours });
  }
  return items;
}

function recencyAdj(ageHours) {
  if (ageHours == null) return 0;      // unknown timestamp: no adjustment
  if (ageHours <= 24) return 15;       // fresh — today's story
  if (ageHours <= 48) return 5;
  if (ageHours <= 96) return -10;      // getting old
  return -25;                          // last week's news, mostly priced in
}

/**
 * Classify all catalysts across a set of headlines.
 * @param headlines string[] or {headline, ts(ms)}[]
 * @returns ranked array of catalyst hits (may be empty)
 */
function classifyCatalysts(headlines, now = Date.now()) {
  const items = toItems(headlines, now);
  const byCat = new Map(); // id -> { def, count, freshestAge, evidence, idx }

  items.forEach((item, i) => {
    for (const def of CATALYST_PATTERNS) {
      if (def.guard && def.guard.test(item.text)) continue;
      if (!def.pattern.test(item.text)) continue;
      const cur = byCat.get(def.id);
      if (!cur) {
        byCat.set(def.id, { def, count: 1, freshestAge: item.ageHours, evidence: item.text, idx: new Set([i]) });
      } else {
        cur.count += 1;
        cur.idx.add(i);
        // keep the freshest headline as the evidence
        if (item.ageHours != null && (cur.freshestAge == null || item.ageHours < cur.freshestAge)) {
          cur.freshestAge = item.ageHours;
          cur.evidence = item.text;
        }
      }
    }
  });

  let hits = [];
  for (const agg of byCat.values()) {
    const corro = Math.min(agg.count - 1, 3) * 8; // corroboration, capped
    const score = TIER_BASE[agg.def.tier] + corro + recencyAdj(agg.freshestAge);
    hits.push({ def: agg.def, score, count: agg.count, ageHours: agg.freshestAge, evidence: agg.evidence, idx: agg.idx });
  }

  const order = new Map(CATALYST_PATTERNS.map((d, i) => [d.id, i]));
  hits = suppressWeakSiblings(hits);
  hits = suppressSameEvidence(hits, order);
  hits.sort((a, b) => (b.score - a.score) || (order.get(a.def.id) - order.get(b.def.id)));
  return hits;
}

function toPublic(hit) {
  const { def } = hit;
  return {
    label: def.label,
    sentiment: def.sentiment,
    color: def.color,
    source: 'news',
    tier: def.tier,
    tierName: TIER_NAME[def.tier],
    score: Math.round(hit.score),
    corroboration: hit.count,
    ageHours: hit.ageHours == null ? null : Math.round(hit.ageHours),
    stale: hit.ageHours != null && hit.ageHours > 96,
  };
}

/**
 * Primary catalyst (backward-compatible shape: label/sentiment/color) plus
 * tier, score, confidence, evidence headline, and secondary catalysts.
 * Returns null when nothing price-relevant was detected.
 */
function classifyCatalyst(headlines, now = Date.now()) {
  const hits = classifyCatalysts(headlines, now);
  if (!hits.length) return null;
  const primary = toPublic(hits[0]);
  primary.confidence = primary.score >= 105 ? 'high' : primary.score >= 60 ? 'medium' : 'low';
  primary.headline = hits[0].evidence;
  primary.others = hits.slice(1, 5).map(toPublic);
  return primary;
}

/*
 * Why a source returned nothing.
 *
 * All three fetchers used to answer an empty array for every reason there is:
 * no API key, a 403, a timeout, or a genuinely quiet stock. Those are not the
 * same fact and only one of them is about the stock. Twenty-three days of
 * backups show finnhub and edgar returning zero items on every single day —
 * 11,359 stories, all of them Yahoo's — and nothing anywhere said a word,
 * because "no news" is what a broken source and a quiet ticker both look like.
 *
 * Each fetcher now reports how it did alongside what it found, and the card
 * shows it. A source that is misconfigured says so once, where it can be fixed.
 */
function ok(items) { return { items, status: 'ok' }; }
function bad(status, detail) { return { items: [], status, detail }; }

/*
 * Roundups.
 *
 * "Top Premarket Gainers", "BC-Most Active Stocks", "Top Midday Decliners" —
 * 15% of everything delivered over 23 days, and four headlines account for
 * nearly all of it. They report that a stock moved, which is the one thing the
 * screener already established, and say nothing about why. Worse, they reach
 * the catalyst classifier, where words like "gainers" and "surge" are exactly
 * what it is looking for.
 *
 * They cannot be filtered by wording alone without also catching real stories,
 * so the primary test is structural: a wire story about one company is tagged
 * to one or two symbols, and a roundup is tagged to every name it lists. Both
 * TradingView and Yahoo publish that list. Over the threshold, the story is
 * about the market rather than about this stock.
 *
 * The word list stays as a second pass, for sources that send no symbol list
 * at all — it only ever removes, never rescues.
 */
const MAX_RELATED_SYMBOLS = 8;

const ROUNDUP_WORDS = new RegExp([
  'most active', 'top (premarket|pre-market|midday|after-hours) (gainers|decliners|losers)',
  'top (gainers|losers)', 'biggest (movers|gainers|losers)', 'stocks? (moving|to watch|making moves)',
  'market (wrap|open|close|movers)', 'winners and losers', 'what to watch',
  'trending (stocks|tickers)', 'hot stocks',
].join('|'), 'i');

function isRoundup(headline, relatedCount) {
  if (Number.isFinite(relatedCount) && relatedCount > MAX_RELATED_SYMBOLS) return true;
  return ROUNDUP_WORDS.test(headline || '');
}

function fetchError(err) {
  const code = err.response && err.response.status;
  if (code === 401 || code === 403) return bad('denied', `HTTP ${code}`);
  if (code === 429) return bad('rate-limited', 'HTTP 429');
  if (code) return bad('error', `HTTP ${code}`);
  if (err.code === 'ECONNABORTED') return bad('timeout', 'took too long');
  return bad('error', err.code || err.message);
}

/*
 * TradingView headlines.
 *
 * Finnhub used to sit here and never once returned an item — no key was ever
 * entered — and by the trader's own experience of it elsewhere, what it does
 * return is mostly "what is hot today" listings rather than company news. It is
 * gone rather than fixed.
 *
 * TradingView is the replacement, and it is a better source for one specific
 * reason: every story arrives with `relatedSymbols`, the list of tickers it is
 * actually about. That is the field Yahoo never gave us, and it is what makes
 * a roundup separable from a story by structure instead of by guessing at
 * wording. It also sends `urgency`, its own breaking-news marker.
 *
 * Needs the exchange-qualified symbol — NASDAQ:AAPL, not AAPL, which returns
 * HTTP 400. Side A already stores that as stock.tvSymbol.
 */
const TV_NEWS_URL = 'https://news-headlines.tradingview.com/v2/headlines';
const TV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

/*
 * Find the headlines wherever they are.
 *
 * The endpoint is undocumented and its envelope is not stable — this code
 * originally assumed the array sat at the top level or under `.items`, which
 * is exactly the assumption that produced "answering, zero items" in
 * production while the probe, which searched the whole tree, found 25. That is
 * the same failure the source-status work was written to eliminate, reached by
 * a different route: a wrong guess about shape reported as an empty news day.
 *
 * So: search for it. An object with a title and a timestamp is a headline
 * wherever it is nested, and null means the response was genuinely not
 * something we know how to read — which is reported as such rather than as
 * silence.
 */
function findHeadlineArray(data) {
  const seen = new Set();
  const looksLikeHeadline = (x) => x && typeof x === 'object' &&
    (x.title || x.headline) &&
    (x.published || x.publishedAt || x.datetime || x.timestamp);

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some(looksLikeHeadline)) return node.filter(looksLikeHeadline);
      for (const x of node) { const r = walk(x); if (r) return r; }
      return null;
    }
    for (const v of Object.values(node)) { const r = walk(v); if (r) return r; }
    return null;
  };
  // An empty array anywhere is a real "no news" answer, not an unreadable one.
  if (Array.isArray(data) && data.length === 0) return [];
  if (data && typeof data === 'object' && Array.isArray(data.items) && !data.items.length) return [];
  return walk(data);
}

async function fetchTradingView(tvSymbol) {
  if (!tvSymbol || !String(tvSymbol).includes(':')) {
    // Without the exchange prefix the endpoint answers 400. Say which it is,
    // rather than reporting an empty news day for the stock.
    return bad('no-symbol', 'needs EXCHANGE:TICKER — none on this row');
  }
  try {
    const resp = await axios.get(
      `${TV_NEWS_URL}?client=overview&lang=en&symbol=${encodeURIComponent(tvSymbol)}`,
      { headers: TV_HEADERS, timeout: 8000 }
    );
    const items = findHeadlineArray(resp.data);
    // A shape we cannot read is not a quiet stock. Saying "ok, nothing found"
    // here would be the same silent failure the source-status work removed.
    if (items === null) {
      return bad('unreadable', 'answered, but no headline array in the response');
    }
    let dropped = 0;
    const kept = items
      .filter(n => {
        const related = Array.isArray(n.relatedSymbols) ? n.relatedSymbols.length : null;
        if (isRoundup(n.title, related)) { dropped++; return false; }
        return true;
      })
      .slice(0, 10)
      .map(n => ({
        headline: n.title,
        url: n.link || (n.storyPath ? `https://www.tradingview.com${n.storyPath}` : null),
        datetime: n.published,
        provider: (n.source && (n.source.name || n.source)) || n.provider || null,
        urgent: n.urgency === 1 || n.urgency === '1',
        related: Array.isArray(n.relatedSymbols) ? n.relatedSymbols.length : null,
        source: 'tradingview',
      }));
    return { items: kept, status: 'ok', dropped };
  } catch (err) {
    return fetchError(err);
  }
}

async function fetchYahoo(ticker) {
  try {
    const resp = await axios.get(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}`,
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const news = resp.data?.news || [];
    // Requiring Yahoo's own tag was already here, and it is not enough: Yahoo
    // tags "Top Premarket Gainers" with every ticker it lists, so the roundup
    // passes the test on the very stock it is burying. Across 23 days that let
    // 177 listing items through — 15% of everything delivered — and four
    // headlines were most of them. The tag list is also the fix: a story about
    // one company names one or two symbols, a listing names forty.
    let dropped = 0;
    const kept = news
      .filter(n => Array.isArray(n.relatedTickers) && n.relatedTickers.includes(ticker))
      .filter(n => {
        if (isRoundup(n.title, n.relatedTickers.length)) { dropped++; return false; }
        return true;
      })
      .slice(0, 10)
      .map(n => ({
        headline: n.title,
        url: n.link,
        datetime: n.providerPublishTime,
        provider: n.publisher || null,
        related: n.relatedTickers.length,
        source: 'yahoo',
      }));
    return { items: kept, status: 'ok', dropped };
  } catch (err) {
    return fetchError(err);
  }
}

/*
 * SEC filings.
 *
 * This asked for filings for 23 days and got nothing, every day, for every
 * stock. The request went out with no headers at all, and the SEC refuses
 * anonymous automated traffic — their access policy requires a User-Agent
 * naming the requester, and a request without one is denied rather than
 * answered empty. The catch swallowed the refusal and returned [], which is
 * indistinguishable from "this company has not filed anything".
 *
 * An 8-K is the filing that carries the events worth trading — the merger, the
 * offering, the resignation — so this was the source most worth having and the
 * one that never once ran.
 */
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'TradeDesk Screener admin@trade-desk.local';

// A filing is news for about as long as it is news. The first run after the
// request was fixed returned filings from 2023 — three years old, listed
// beside a story from 54 minutes ago as though they were the same kind of
// thing. The window is asked for in the query and enforced again on the way
// out, because a search that ignores the parameter should not be trusted to
// have honoured it.
const EDGAR_DAYS = 14;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/*
 * EDGAR's full-text search does not document its response shape and it has
 * changed before. Rather than reading one field and printing "SEC Filing" when
 * it is absent — which is what produced a list of five identical rows — every
 * name the form type has been seen under is tried, and an item that yields
 * neither a form nor a date is dropped rather than shown as a placeholder.
 */
function edgarItem(h) {
  const s = (h && h._source) || {};
  const form = s.form_type || s.form || s.root_form || s.type || null;
  const dateStr = s.file_date || s.filed_at || s.period_ending || s.period_of_report || null;
  const ts = toMs(dateStr);
  if (!form && !ts) return null;
  const label = form
    ? `${form}${dateStr ? ` — filed ${String(dateStr).slice(0, 10)}` : ''}`
    : `SEC filing — ${String(dateStr).slice(0, 10)}`;
  const cik = s.entity_id || s.cik || (Array.isArray(s.ciks) ? s.ciks[0] : null);
  return {
    headline: label,
    url: cik && h._id ? `https://www.sec.gov/Archives/edgar/data/${cik}/${h._id}` : null,
    datetime: dateStr,
    source: 'edgar',
  };
}

async function fetchEdgar(ticker) {
  try {
    const now = Date.now();
    const from = ymd(now - EDGAR_DAYS * 86400000);
    const resp = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22` +
      `&forms=8-K,S-3&dateRange=custom&startdt=${from}&enddt=${ymd(now)}`,
      {
        timeout: 8000,
        headers: {
          // Required. See https://www.sec.gov/os/webmaster-faq#developers
          'User-Agent': SEC_USER_AGENT,
          'Accept-Encoding': 'gzip, deflate',
          Accept: 'application/json',
        },
      }
    );
    const hits = resp.data?.hits?.hits || [];
    const cutoff = now - EDGAR_DAYS * 86400000;
    let dropped = 0;
    const items = hits
      .map(edgarItem)
      .filter(it => {
        if (!it) { dropped++; return false; }
        const ts = toMs(it.datetime);
        if (ts && ts < cutoff) { dropped++; return false; }
        return true;
      })
      .slice(0, 5);
    return { items, status: 'ok', dropped };
  } catch (err) {
    return fetchError(err);
  }
}

// TradingView `published` and Yahoo `providerPublishTime` are unix seconds;
// EDGAR carries a date string. Normalize to ms (or null).
function toMs(dt) {
  if (Number.isFinite(dt) && dt > 0) return dt < 1e12 ? dt * 1000 : dt;
  if (typeof dt === 'string') {
    const parsed = Date.parse(dt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * @param ticker    bare symbol, for Yahoo and EDGAR
 * @param tvSymbol  EXCHANGE:TICKER, for TradingView — stock.tvSymbol
 */
async function fetchNewsForTicker(ticker, tvSymbol) {
  const [tv, yh, ed] = await Promise.all([
    fetchTradingView(tvSymbol),
    fetchYahoo(ticker),
    fetchEdgar(ticker),
  ]);

  const tradingview = tv.items, yahoo = yh.items, edgar = ed.items;

  // The same story reaches us from more than one source now, and the classifier
  // counts corroboration — two copies of one headline would read as two outlets
  // independently confirming it. Deduplicated on the normalised headline, with
  // the earliest timestamp kept, since that is when the story actually broke.
  const seen = new Map();
  for (const n of [...tradingview, ...yahoo, ...edgar]) {
    if (!n.headline) continue;
    const key = normalizeHeadline(n.headline);
    const ts = toMs(n.datetime);
    const prev = seen.get(key);
    if (!prev || (ts && prev.ts && ts < prev.ts)) seen.set(key, { headline: n.headline, ts });
  }
  const allItems = [...seen.values()];

  const catalyst = classifyCatalyst(allItems);

  // Kept beside the items, and stored on the card, so "no news" can be read as
  // what it is: a quiet stock, or a source that never answered. `dropped` is
  // the roundup count — worth seeing, because a source sending nothing but
  // listings looks identical to a quiet one without it.
  const sources = {
    tradingview: { status: tv.status, detail: tv.detail || null, count: tradingview.length, dropped: tv.dropped || 0 },
    yahoo: { status: yh.status, detail: yh.detail || null, count: yahoo.length, dropped: yh.dropped || 0 },
    edgar: { status: ed.status, detail: ed.detail || null, count: edgar.length, dropped: ed.dropped || 0 },
  };

  return {
    news: { tradingview, yahoo, edgar, sources, fetchedAt: new Date().toISOString() },
    catalyst,
  };
}

module.exports = {
  fetchNewsForTicker, classifyCatalyst, classifyCatalysts, CATALYST_PATTERNS,
  isRoundup, MAX_RELATED_SYMBOLS,
};
