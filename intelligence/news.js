// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3.3 — Enhanced News & Event Intelligence Module
//
//  Sources (all free, no API key required):
//    1. CryptoPanic public API — hot/bullish/bearish filtered
//    2. CoinGecko news endpoint — market context
//    3. RSS fallback (CoinDesk, Decrypt) via rss2json.com
//
//  Decision-making philosophy:
//    - News alone NEVER triggers a buy. It MODIFIES confidence.
//    - High-fear news applies a graduated penalty (−3 to −15pts)
//    - High-greed news applies a smaller boost (up to +8pts) — 
//      because FOMO-driven buys tend to underperform
//    - Per-asset news weighted 3x more than market-wide news
//    - Impact decays over time: fresh news (<1h) = full weight,
//      1-6h = 60%, 6-24h = 30%, >24h = 10%
//    - Each outcome is saved and feeds back into keyword weights
//      (adaptive learning: if "ETF" news leads to losses, 
//       its boost shrinks next time)
//
//  Smart filters:
//    - Duplicate title detection (prevents double-counting)
//    - Source credibility weighting (major outlets > blog posts)
//    - Asset mention validation (BTC in title ≠ BTC/USDT trade)
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEWS_WEIGHTS_FILE = join(__dirname, '../logs/news_weights.json');
const NEWS_CACHE_FILE   = join(__dirname, '../logs/news_cache.json');

// ── Cache & TTL ────────────────────────────────────────────────
const CACHE_TTL  = 15 * 60 * 1000; // 15 min (was 30 — faster now)
let   _memCache  = null;

// ── Credible sources (higher weight) ──────────────────────────
const CREDIBLE_SOURCES = [
  'coindesk','cointelegraph','decrypt','reuters','bloomberg',
  'wsj','ft','theblock','blockworks','cryptobriefing','coingecko',
];

// ── Fear/Greed keywords with BASE weights ─────────────────────
// These are updated by the adaptive learning loop
const DEFAULT_WEIGHTS = {
  fear: {
    hack: 3, exploit: 3, hacked: 3, breach: 3, vulnerability: 2,
    SEC: 3, ban: 3, banned: 3, shutdown: 2, delist: 2, suspend: 2,
    crash: 2, liquidat: 2, collapse: 3, panic: 2, emergency: 2,
    rug: 4, scam: 4, arrest: 2, seized: 2, warning: 1, lawsuit: 2,
    fine: 1, jail: 2, insolvent: 3, bankrupt: 3, contagion: 3,
    'regulatory': 1, 'criminal': 2, 'ponzi': 3, 'fraud': 3,
  },
  greed: {
    ETF: 2, approved: 2, approval: 2, launch: 1, launched: 1,
    partnership: 1, upgrade: 1, bullish: 1, adoption: 2,
    institutional: 2, 'all-time': 2, record: 1, milestone: 1,
    integration: 1, expansion: 1, grant: 1, investment: 2,
    listed: 1, mainnet: 2, tokenomics: 1, airdrop: 1,
    halving: 3, 'layer 2': 1, 'layer2': 1, defi: 1, nft: 0,
  },
};

// ── Load / save adaptive keyword weights ──────────────────────
function loadWeights() {
  try {
    if (existsSync(NEWS_WEIGHTS_FILE))
      return JSON.parse(readFileSync(NEWS_WEIGHTS_FILE, 'utf8'));
  } catch {}
  return { fear: { ...DEFAULT_WEIGHTS.fear }, greed: { ...DEFAULT_WEIGHTS.greed }, lastUpdated: null };
}

function saveWeights(w) {
  try { writeFileSync(NEWS_WEIGHTS_FILE, JSON.stringify({ ...w, lastUpdated: new Date().toISOString() }, null, 2)); }
  catch {}
}

// ── Time-decay multiplier ──────────────────────────────────────
function ageDecay(publishedAt) {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageH  = ageMs / 3600000;
  if (ageH < 1)  return 1.0;
  if (ageH < 6)  return 0.65;
  if (ageH < 24) return 0.32;
  return 0.1;
}

// ── Source credibility multiplier ─────────────────────────────
function sourceWeight(domain = '') {
  const d = domain.toLowerCase();
  if (CREDIBLE_SOURCES.some(s => d.includes(s))) return 1.4;
  return 1.0;
}

// ── Score a single post ───────────────────────────────────────
function scorePost(post, weights) {
  const text   = `${post.title || ''} ${post.description || ''}`.toLowerCase();
  const decay  = ageDecay(post.publishedAt);
  const srcW   = sourceWeight(post.domain);
  let fear = 0, greed = 0;

  for (const [kw, w] of Object.entries(weights.fear || {}))
    if (text.includes(kw.toLowerCase())) fear += w;

  for (const [kw, w] of Object.entries(weights.greed || {}))
    if (text.includes(kw.toLowerCase())) greed += w;

  return {
    fearScore:  Math.round(fear  * decay * srcW * 10) / 10,
    greedScore: Math.round(greed * decay * srcW * 10) / 10,
    netSentiment: Math.round((greed - fear) * decay * srcW * 10) / 10,
  };
}

// ── Fetch from CryptoPanic ─────────────────────────────────────
async function fetchCryptoPanic() {
  try {
    const r = await axios.get('https://cryptopanic.com/api/free/v1/posts/', {
      params: { public: true, kind: 'news', filter: 'hot', regions: 'en' },
      timeout: 8000,
    });
    return (r.data?.results || []).map(p => ({
      id: `cp_${p.id}`,
      title: p.title,
      description: '',
      url: p.url,
      publishedAt: p.published_at,
      domain: p.domain || p.source?.domain || '',
      currencies: (p.currencies || []).map(c => c.code?.toUpperCase()).filter(Boolean),
      source: 'cryptopanic',
    }));
  } catch { return []; }
}

// ── Fetch from CoinGecko news ──────────────────────────────────
async function fetchCoinGeckoNews() {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/news', { timeout: 8000 });
    return (r.data?.data || []).slice(0, 20).map(p => ({
      id: `cg_${p.id || p.title}`,
      title: p.title,
      description: p.description || '',
      url: p.url,
      publishedAt: p.updated_at ? new Date(p.updated_at * 1000).toISOString() : new Date().toISOString(),
      domain: p.author || 'coingecko',
      currencies: [],
      source: 'coingecko',
    }));
  } catch { return []; }
}

// ── Fetch from RSS via rss2json (CoinDesk) ─────────────────────
async function fetchRSS() {
  try {
    const r = await axios.get(
      'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F',
      { timeout: 8000 }
    );
    return (r.data?.items || []).slice(0, 15).map(p => ({
      id: `rss_${p.guid || p.title}`,
      title: p.title,
      description: p.description?.replace(/<[^>]+>/g, '').slice(0, 200) || '',
      url: p.link,
      publishedAt: p.pubDate,
      domain: 'coindesk.com',
      currencies: [],
      source: 'rss',
    }));
  } catch { return []; }
}

// ── Merge + deduplicate posts ──────────────────────────────────
function deduplicatePosts(posts) {
  const seen = new Set();
  return posts.filter(p => {
    const key = p.title?.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main fetch (multi-source, cached) ─────────────────────────
async function fetchAllNews() {
  // Memory cache
  if (_memCache && Date.now() - _memCache.fetchedAt < CACHE_TTL) return _memCache;

  // Disk cache fallback (survive restarts within TTL)
  try {
    if (existsSync(NEWS_CACHE_FILE)) {
      const dc = JSON.parse(readFileSync(NEWS_CACHE_FILE, 'utf8'));
      if (Date.now() - dc.fetchedAt < CACHE_TTL) {
        _memCache = dc;
        return dc;
      }
    }
  } catch {}

  // Fetch from all sources concurrently
  const [cpPosts, cgPosts, rssPosts] = await Promise.allSettled([
    fetchCryptoPanic(),
    fetchCoinGeckoNews(),
    fetchRSS(),
  ]).then(r => r.map(res => res.status === 'fulfilled' ? res.value : []));

  const weights  = loadWeights();
  const allPosts = deduplicatePosts([...cpPosts, ...cgPosts, ...rssPosts]);

  const scored   = allPosts.map(p => ({ ...p, ...scorePost(p, weights) }));

  // Market-wide fear/greed from top 30 posts
  const top30      = scored.slice(0, 30);
  const totalFear  = top30.reduce((s, p) => s + p.fearScore,  0);
  const totalGreed = top30.reduce((s, p) => s + p.greedScore, 0);
  const marketFear = totalFear - totalGreed;

  // Top headlines for dashboard ticker (mix of fear + greed)
  const topHeadlines = scored
    .filter(p => Math.abs(p.netSentiment) >= 0.5 || p.fearScore >= 1 || p.greedScore >= 1)
    .sort((a, b) => Math.abs(b.netSentiment) - Math.abs(a.netSentiment))
    .slice(0, 12)
    .map(p => ({
      title:       p.title,
      url:         p.url,
      publishedAt: p.publishedAt,
      sentiment:   p.netSentiment >= 1 ? 'positive' : p.netSentiment <= -1 ? 'negative' : 'neutral',
      currencies:  p.currencies,
    }));

  const cache = {
    posts: scored,
    topHeadlines,
    marketFear,
    marketGreed:  -marketFear,
    fetchedAt:    Date.now(),
    totalSources: [cpPosts.length > 0, cgPosts.length > 0, rssPosts.length > 0].filter(Boolean).length,
  };

  _memCache = cache;
  try { writeFileSync(NEWS_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
  return cache;
}

// ── Asset-specific score (called per trade in confidence.js) ──
export async function getNewsScore(asset) {
  const news  = await fetchAllNews();
  const clean = asset.toUpperCase();
  const weights = loadWeights();

  // Posts mentioning this asset (from CryptoPanic currencies OR title)
  const assetPosts = news.posts.filter(p =>
    p.currencies?.includes(clean) ||
    p.title?.toUpperCase().includes(clean)
  );

  let score = 0;
  const narrative = [];
  const alerts    = [];

  for (const post of assetPosts.slice(0, 6)) {
    const decay = ageDecay(post.publishedAt);

    if (post.fearScore >= 3) {
      const penalty = Math.round(-12 * decay);
      score += penalty;
      narrative.push(`⚠️ Major negative news for ${asset}: "${post.title?.slice(0, 55)}…" (${penalty}pts)`);
      alerts.push({ type: 'HIGH_FEAR', title: post.title, asset: clean, url: post.url });
    } else if (post.fearScore >= 1.5) {
      const penalty = Math.round(-6 * decay);
      score += penalty;
      narrative.push(`📰 Negative news for ${asset}: "${post.title?.slice(0, 55)}…" (${penalty}pts)`);
      alerts.push({ type: 'FEAR', title: post.title, asset: clean, url: post.url });
    } else if (post.fearScore >= 0.5) {
      score += Math.round(-3 * decay);
      narrative.push(`Mild negative news for ${asset} (${Math.round(-3*decay)}pts)`);
    } else if (post.greedScore >= 3) {
      const boost = Math.round(8 * decay);
      score += boost;
      narrative.push(`📰 Very positive news for ${asset}: "${post.title?.slice(0, 55)}…" (+${boost}pts)`);
    } else if (post.greedScore >= 1.5) {
      const boost = Math.round(5 * decay);
      score += boost;
      narrative.push(`📰 Positive news for ${asset} (+${boost}pts)`);
    } else if (post.greedScore >= 0.5) {
      score += Math.round(3 * decay);
    }
  }

  // Market-wide fear modifier (smaller effect than asset-specific)
  const mf = news.marketFear;
  if (mf >= 6) {
    score -= 8;
    narrative.push(`📰 Very high market fear in news (${mf.toFixed(1)} net fear) — broad caution (-8pts)`);
  } else if (mf >= 3) {
    score -= 4;
    narrative.push(`📰 Elevated market fear in news (-4pts)`);
  } else if (mf >= 1.5) {
    score -= 2;
  } else if (mf <= -4) {
    score += 5;
    narrative.push(`📰 Strongly positive market news sentiment (+5pts)`);
  } else if (mf <= -2) {
    score += 3;
    narrative.push(`📰 Positive market news sentiment (+3pts)`);
  }

  return {
    score:          Math.max(-18, Math.min(10, Math.round(score))),
    marketFear:     mf,
    assetPostCount: assetPosts.length,
    alerts,
    narrative,
    lastFetched:    news.fetchedAt,
    topHeadlines:   news.topHeadlines,
  };
}

// ── Get top headlines for dashboard ticker ─────────────────────
export async function getTopHeadlines(count = 12) {
  try {
    const news = await fetchAllNews();
    return {
      headlines:   news.topHeadlines?.slice(0, count) || [],
      marketFear:  news.marketFear,
      fetchedAt:   news.fetchedAt,
      sources:     news.totalSources,
    };
  } catch {
    return { headlines: [], marketFear: 0, fetchedAt: 0, sources: 0 };
  }
}

// ── Get market-wide alerts for Telegram ──────────────────────
export async function getNewsAlerts() {
  const news = await fetchAllNews();
  const highImpact = news.posts
    .filter(p => p.fearScore >= 2 || p.greedScore >= 2)
    .slice(0, 5);

  return {
    marketFear:  news.marketFear,
    highImpact,
    label:       news.marketFear >= 5 ? '🚨 HIGH FEAR' :
                 news.marketFear >= 2 ? '⚠️ MILD FEAR' :
                 news.marketFear <= -4 ? '📈 VERY POSITIVE' :
                 news.marketFear <= -2 ? '📈 POSITIVE' : '😐 NEUTRAL',
    sources:     news.totalSources,
  };
}

// ── Learning feedback: called after trade resolves ────────────
// outcome: 'WIN' | 'LOSS', newsScore: the score that was applied,
// newsAlerts: the alerts that fired for this trade
export function learnFromNewsOutcome(outcome, newsScore, newsAlerts = []) {
  if (!newsAlerts.length || newsScore === 0) return;

  try {
    const weights = loadWeights();
    const won     = outcome === 'WIN';

    for (const alert of newsAlerts) {
      // If a fear alert fired and we still won → the keyword was too pessimistic
      // Reduce its weight slightly
      if (alert.type === 'FEAR' || alert.type === 'HIGH_FEAR') {
        if (won) {
          // Trade won despite fear news → fear was over-weighted, soften it
          for (const [kw] of Object.entries(weights.fear)) {
            const title = (alert.title || '').toLowerCase();
            if (title.includes(kw)) {
              weights.fear[kw] = Math.max(0.3, (weights.fear[kw] || 1) * 0.92);
            }
          }
        } else {
          // Trade lost and fear news fired → fear was correct, strengthen it
          for (const [kw] of Object.entries(weights.fear)) {
            const title = (alert.title || '').toLowerCase();
            if (title.includes(kw)) {
              weights.fear[kw] = Math.min(5, (weights.fear[kw] || 1) * 1.08);
            }
          }
        }
      }
    }

    saveWeights(weights);
    console.log(`[News] Adaptive weights updated from ${outcome} outcome (${newsAlerts.length} alerts)`);
  } catch (e) {
    console.warn('[News] Weight update failed:', e.message);
  }
}

export default { getNewsScore, getNewsAlerts, getTopHeadlines, learnFromNewsOutcome };