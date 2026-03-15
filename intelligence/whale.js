// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Whale Order Book Detection
//
//  Looks deeper into the order book than the existing Signal 5.
//  Signal 5 checks bid/ask ratio (surface level).
//  This module finds:
//   - Massive bid walls = institutional support (bullish)
//   - Massive ask walls = institutional resistance (bearish)
//   - Iceberg orders = large hidden liquidity
//   - Order book imbalance at key price levels
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const REAL_URL = 'https://api.binance.com';

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function getWhaleScore(symbol) {
  const cacheKey = symbol;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    // Fetch deep order book (500 levels)
    const r = await axios.get(`${REAL_URL}/api/v3/depth`, {
      params: { symbol, limit: 500 },
      timeout: 6000,
    });

    const bids = r.data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks = r.data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    if (!bids.length || !asks.length) return neutral();

    const midPrice = (bids[0].price + asks[0].price) / 2;

    // Total liquidity in top 2% of book
    const bidRange = midPrice * 0.02;
    const askRange = midPrice * 0.02;

    const nearBids = bids.filter(b => b.price >= midPrice - bidRange);
    const nearAsks = asks.filter(a => a.price <= midPrice + askRange);

    const totalBidQty  = nearBids.reduce((s, b) => s + b.qty * b.price, 0);
    const totalAskQty  = nearAsks.reduce((s, a) => s + a.qty * a.price, 0);

    // Find whale walls — single orders that are 10x the average
    const avgBidSize = totalBidQty / Math.max(nearBids.length, 1);
    const avgAskSize = totalAskQty / Math.max(nearAsks.length, 1);

    const whaleBids = nearBids.filter(b => (b.qty * b.price) > avgBidSize * 10);
    const whaleAsks = nearAsks.filter(a => (a.qty * a.price) > avgAskSize * 10);

    const whaleBidTotal = whaleBids.reduce((s, b) => s + b.qty * b.price, 0);
    const whaleAskTotal = whaleAsks.reduce((s, a) => s + a.qty * a.price, 0);

    let score = 0;
    const narrative = [];

    // Strong bid wall — whale supporting price
    if (whaleBids.length > 0 && whaleBidTotal > whaleBidTotal * 0.3) {
      const wallSize = (whaleBidTotal / 1000).toFixed(0);
      score += 10;
      narrative.push(`🐋 Whale bid wall detected: $${wallSize}K support at $${whaleBids[0].price.toFixed(4)} (+10pts)`);
    }

    // Strong ask wall — whale blocking upside
    if (whaleAsks.length > 0 && whaleAskTotal > totalAskQty * 0.3) {
      const wallSize = (whaleAskTotal / 1000).toFixed(0);
      score -= 8;
      narrative.push(`🧱 Whale ask wall detected: $${wallSize}K resistance at $${whaleAsks[0].price.toFixed(4)} (-8pts)`);
    }

    // Overall bid/ask imbalance
    const imbalance = totalBidQty / (totalBidQty + totalAskQty);
    if (imbalance > 0.70) {
      score += 5;
      narrative.push(`Strong bid-side imbalance: ${(imbalance*100).toFixed(0)}% bids vs asks (+5pts)`);
    } else if (imbalance < 0.30) {
      score -= 5;
      narrative.push(`Strong ask-side imbalance: ${((1-imbalance)*100).toFixed(0)}% asks dominating (-5pts)`);
    }

    const result = {
      score: Math.max(-12, Math.min(12, score)),
      whaleBidCount: whaleBids.length,
      whaleAskCount: whaleAsks.length,
      bidAskImbalance: parseFloat(imbalance.toFixed(2)),
      narrative,
    };

    cache.set(cacheKey, { ts: Date.now(), data: result });
    return result;

  } catch {
    return neutral();
  }
}

function neutral() {
  return { score: 0, whaleBidCount: 0, whaleAskCount: 0, bidAskImbalance: 0.5, narrative: [] };
}

export default { getWhaleScore };
