// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Market Rank Module (Binance Skills Hub)
//
//  Pulls trending tokens, smart money inflow rankings, and
//  social hype data from Binance Web3 APIs.
//
//  Used by: scanner (prioritisation), confidence engine (signal)
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const BASE = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct';
const HEADERS = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' };

let rankCache = { trending: null, trendingTime: 0, pulse: null, pulseTime: 0 };
const TTL = 15 * 60 * 1000; // 15 minutes

// ── Trending tokens (social hype) ────────────────────────────────

async function fetchTrending() {
  if (rankCache.trending && Date.now() - rankCache.trendingTime < TTL) {
    return rankCache.trending;
  }
  try {
    const r = await axios.get(
      `${BASE}/buw/wallet/market/token/pulse/social/hype/rank/leaderboard`,
      {
        params: { chainId: '56', sentiment: 'All', socialLanguage: 'ALL', targetLanguage: 'en', timeRange: 1 },
        headers: HEADERS,
        timeout: 8000,
      }
    );
    rankCache.trending = r.data?.data || [];
    rankCache.trendingTime = Date.now();
    return rankCache.trending;
  } catch {
    return rankCache.trending || [];
  }
}

// ── Token pulse rankings (by volume/momentum) ─────────────────────

async function fetchPulseRankings() {
  if (rankCache.pulse && Date.now() - rankCache.pulseTime < TTL) {
    return rankCache.pulse;
  }
  try {
    const r = await axios.post(
      `${BASE}/buw/wallet/market/token/pulse/unified/rank/list`,
      { rankType: 10, chainId: '56', period: 50, sortBy: 70, orderAsc: false, pageSize: 50 },
      { headers: HEADERS, timeout: 8000 }
    );
    rankCache.pulse = r.data?.data?.list || r.data?.data || [];
    rankCache.pulseTime = Date.now();
    return rankCache.pulse;
  } catch {
    return rankCache.pulse || [];
  }
}

// ── Score asset based on market rank data ─────────────────────────

export async function getMarketRankScore(symbol) {
  const clean = symbol.replace('USDT', '').toUpperCase();
  const [trending, pulse] = await Promise.all([fetchTrending(), fetchPulseRankings()]);

  let score = 0;
  let narrative = [];

  // Trending rank
  const trendIdx = trending.findIndex(t => t.symbol?.toUpperCase() === clean);
  if (trendIdx !== -1) {
    const rank = trendIdx + 1;
    if (rank <= 5) {
      score += 5;
      narrative.push(`Trending #${rank} socially on Binance Web3 (+5pts)`);
    } else if (rank <= 15) {
      score += 3;
      narrative.push(`Social rank #${rank} — gaining attention (+3pts)`);
    } else if (rank <= 30) {
      score += 1;
      narrative.push(`Social rank #${rank} — mild buzz (+1pt)`);
    }
  }

  // Pulse volume rank
  const pulseIdx = pulse.findIndex(t =>
    t.symbol?.toUpperCase() === clean || t.tokenSymbol?.toUpperCase() === clean
  );
  if (pulseIdx !== -1) {
    const rank = pulseIdx + 1;
    if (rank <= 10) {
      score += 5;
      narrative.push(`Top ${rank} by volume on Binance Web3 pulse (+5pts)`);
    } else if (rank <= 25) {
      score += 3;
      narrative.push(`Pulse rank #${rank} — strong activity (+3pts)`);
    }
  }

  // Outflow check — if not in any ranking and NOT a Tier1, slight negative
  if (trendIdx === -1 && pulseIdx === -1) {
    score += 0; // neutral — absence isn't negative for large caps
  }

  return {
    score: Math.max(-5, Math.min(10, score)),
    trendingRank: trendIdx === -1 ? null : trendIdx + 1,
    pulseRank: pulseIdx === -1 ? null : pulseIdx + 1,
    narrative,
  };
}

// ── Get full trending list (for radar and reports) ────────────────

export async function getTrendingAssets(limit = 20) {
  const [trending, pulse] = await Promise.all([fetchTrending(), fetchPulseRankings()]);
  const combined = new Map();

  trending.slice(0, limit).forEach((t, i) => {
    const sym = (t.symbol || '').toUpperCase();
    if (sym) combined.set(sym, { symbol: sym, trendRank: i + 1, pulseRank: null, source: 'social' });
  });

  pulse.slice(0, limit).forEach((t, i) => {
    const sym = (t.symbol || t.tokenSymbol || '').toUpperCase();
    if (!sym) return;
    if (combined.has(sym)) {
      combined.get(sym).pulseRank = i + 1;
    } else {
      combined.set(sym, { symbol: sym, trendRank: null, pulseRank: i + 1, source: 'volume' });
    }
  });

  return [...combined.values()]
    .sort((a, b) => (a.trendRank || 999) - (b.trendRank || 999))
    .slice(0, limit);
}

export default { getMarketRankScore, getTrendingAssets };
