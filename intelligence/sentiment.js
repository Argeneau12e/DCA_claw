// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Sentiment Analysis Module
//
//  Sources:
//   1. Alternative.me Fear & Greed Index (free, no auth)
//   2. Binance funding rate aggregate (already in confidence.js)
//   3. Binance market rank social hype (Binance Skills Hub)
//
//  Output: sentiment score 0-10pts added to confidence engine
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

// Cache to avoid hammering free APIs
const cache = { fearGreed: null, fgTime: 0, social: null, socialTime: 0 };
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Fear & Greed Index ────────────────────────────────────────────

export async function getFearGreedIndex() {
  if (cache.fearGreed && Date.now() - cache.fgTime < CACHE_TTL) {
    return cache.fearGreed;
  }
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 6000 });
    const d = r.data?.data?.[0];
    if (!d) return null;
    const result = {
      value: parseInt(d.value),
      classification: d.value_classification, // Extreme Fear / Fear / Neutral / Greed / Extreme Greed
      timestamp: d.timestamp,
    };
    cache.fearGreed = result;
    cache.fgTime = Date.now();
    return result;
  } catch {
    return cache.fearGreed || null; // return stale if available
  }
}

// ── Social Hype from Binance Market Rank ──────────────────────────

export async function getSocialHype(symbol) {
  // Cache full social list, not per-symbol
  if (!cache.social || Date.now() - cache.socialTime > CACHE_TTL) {
    try {
      const r = await axios.get(
        'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard',
        {
          params: { chainId: '56', sentiment: 'All', socialLanguage: 'ALL', targetLanguage: 'en', timeRange: 1 },
          headers: { 'Accept-Encoding': 'identity' },
          timeout: 8000,
        }
      );
      cache.social = r.data?.data || [];
      cache.socialTime = Date.now();
    } catch {
      cache.social = cache.social || [];
    }
  }

  const clean = symbol.replace('USDT', '').toUpperCase();
  const rank = cache.social.findIndex(t => t.symbol?.toUpperCase() === clean);
  return rank === -1 ? null : rank + 1; // 1-indexed rank, null if not trending
}

// ── Main Sentiment Score (called by confidence engine) ────────────

export async function getSentimentScore(symbol) {
  const [fg, socialRank] = await Promise.all([
    getFearGreedIndex(),
    getSocialHype(symbol),
  ]);

  let score = 0;
  let narrative = [];

  // Fear & Greed scoring
  if (fg) {
    const v = fg.value;
    if (v <= 15) {
      score += 10;
      narrative.push(`Extreme Fear (${v}) — contrarian buy signal (+10pts)`);
    } else if (v <= 30) {
      score += 7;
      narrative.push(`Fear (${v}) — good DCA conditions (+7pts)`);
    } else if (v <= 45) {
      score += 3;
      narrative.push(`Mild fear (${v}) — slightly favourable (+3pts)`);
    } else if (v <= 60) {
      score += 0;
      narrative.push(`Neutral sentiment (${v}) — no boost`);
    } else if (v <= 75) {
      score -= 5;
      narrative.push(`Greed (${v}) — market may be overheated (-5pts)`);
    } else {
      score -= 10;
      narrative.push(`Extreme Greed (${v}) — very risky to buy now (-10pts)`);
    }
  }

  // Social hype scoring — trending can mean pump risk OR genuine interest
  if (socialRank !== null) {
    if (socialRank <= 5) {
      score += 3;
      narrative.push(`Trending #${socialRank} socially — momentum (+3pts)`);
    } else if (socialRank <= 15) {
      score += 1;
      narrative.push(`Social rank #${socialRank} — mild buzz (+1pt)`);
    }
  }

  return {
    score: Math.max(-10, Math.min(10, score)), // clamp -10 to +10
    fearGreed: fg,
    socialRank,
    narrative,
  };
}

// ── Sentiment regime label (for Telegram messages) ────────────────

export function sentimentLabel(fgValue) {
  if (!fgValue) return 'Unknown';
  if (fgValue <= 15) return '😱 Extreme Fear';
  if (fgValue <= 30) return '😨 Fear';
  if (fgValue <= 45) return '😐 Mild Fear';
  if (fgValue <= 55) return '😐 Neutral';
  if (fgValue <= 75) return '😏 Greed';
  return '🤑 Extreme Greed';
}

export default { getSentimentScore, getFearGreedIndex, sentimentLabel };
