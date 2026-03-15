// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Smart Execution Engine
//
//  Before any order is placed, this runs three checks:
//
//  1. BID-ASK SPREAD CHECK
//     Fetches live order book, computes spread %.
//     If spread > threshold for risk profile → skip or reduce size.
//     Spread thresholds:
//       conservative: 0.15% max
//       balanced:     0.25% max
//       degen:        0.50% max
//
//  2. SLIPPAGE ESTIMATION
//     Walks the order book to estimate actual fill price
//     for the given USDT amount. Reports expected slippage %.
//     If estimated slippage > 0.5% → warn or block.
//
//  3. SPREAD-ADJUSTED SIZING
//     If spread is elevated but within tolerance, reduces size
//     proportionally so the spread cost doesn't eat the edge.
//     Formula: adjustedSize = size × (1 - spread / maxSpread)
//
//  Returns: { approved, adjustedSize, spread, slippage, reason, narrative }
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const REAL_URL = 'https://api.binance.com';

// Cache spreads — 30 second TTL (spreads change fast)
const spreadCache = new Map();
const CACHE_TTL   = 30_000;

// Max spread thresholds per risk profile
const MAX_SPREAD = {
  conservative: 0.0015, // 0.15%
  balanced:     0.0025, // 0.25%
  degen:        0.0050, // 0.50%
};

// Max slippage thresholds per risk profile
const MAX_SLIPPAGE = {
  conservative: 0.003,  // 0.30%
  balanced:     0.005,  // 0.50%
  degen:        0.010,  // 1.00%
};

// ── Fetch order book (500 levels for accurate walk) ───────────────

async function fetchDeepOrderBook(symbol) {
  const cached = spreadCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const r = await axios.get(`${REAL_URL}/api/v3/depth`, {
      params: { symbol, limit: 500 },
      timeout: 6000,
    });

    const data = {
      bids: r.data.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: r.data.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) })),
    };

    spreadCache.set(symbol, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

// ── Compute bid-ask spread ────────────────────────────────────────

function computeSpread(ob) {
  if (!ob?.bids?.length || !ob?.asks?.length) return null;
  const bestBid = ob.bids[0].price;
  const bestAsk = ob.asks[0].price;
  const mid     = (bestBid + bestAsk) / 2;
  return mid > 0 ? (bestAsk - bestBid) / mid : null;
}

// ── Walk order book to estimate fill price for a given USDT amount

function estimateFillPrice(asks, usdtAmount) {
  if (!asks?.length) return null;

  let remaining = usdtAmount;
  let totalQty  = 0;
  let totalCost = 0;

  for (const ask of asks) {
    const levelCost = ask.price * ask.qty;
    if (remaining <= 0) break;

    if (levelCost <= remaining) {
      totalQty  += ask.qty;
      totalCost += levelCost;
      remaining -= levelCost;
    } else {
      const partialQty = remaining / ask.price;
      totalQty  += partialQty;
      totalCost += remaining;
      remaining  = 0;
    }
  }

  if (totalQty === 0) return null;
  return totalCost / totalQty; // average fill price
}

// ── Main execution check ──────────────────────────────────────────

export async function checkExecution(symbol, usdtAmount, riskProfile = 'balanced') {
  const ob = await fetchDeepOrderBook(symbol);

  if (!ob) {
    // Can't check — allow execution with a warning
    return {
      approved:     true,
      adjustedSize: usdtAmount,
      spread:       null,
      slippage:     null,
      reason:       'order_book_unavailable',
      narrative:    '⚠️ Order book unavailable — proceeding without spread check',
    };
  }

  const spread = computeSpread(ob);
  if (spread === null) {
    return {
      approved:     true,
      adjustedSize: usdtAmount,
      spread:       null,
      slippage:     null,
      reason:       'spread_calc_failed',
      narrative:    '⚠️ Spread calculation failed — proceeding',
    };
  }

  const maxSpread   = MAX_SPREAD[riskProfile]   || 0.0025;
  const maxSlippage = MAX_SLIPPAGE[riskProfile] || 0.005;

  // Estimate fill price and slippage
  const bestAsk     = ob.asks[0]?.price ?? 0;
  const fillPrice   = estimateFillPrice(ob.asks, usdtAmount);
  const slippage    = fillPrice && bestAsk > 0 ? (fillPrice - bestAsk) / bestAsk : 0;

  const spreadPct   = spread * 100;
  const slippagePct = slippage * 100;

  // ── Decision ─────────────────────────────────────────────────

  // BLOCK: spread way too wide
  if (spread > maxSpread * 2) {
    return {
      approved:     false,
      adjustedSize: 0,
      spread:       parseFloat(spreadPct.toFixed(4)),
      slippage:     parseFloat(slippagePct.toFixed(4)),
      reason:       'spread_too_wide',
      narrative:    `🚫 Spread ${spreadPct.toFixed(3)}% is ${(spread / maxSpread).toFixed(1)}x your ${riskProfile} limit (${(maxSpread * 100).toFixed(2)}%) — skipping order`,
    };
  }

  // BLOCK: slippage too high
  if (slippage > maxSlippage * 1.5) {
    return {
      approved:     false,
      adjustedSize: 0,
      spread:       parseFloat(spreadPct.toFixed(4)),
      slippage:     parseFloat(slippagePct.toFixed(4)),
      reason:       'slippage_too_high',
      narrative:    `🚫 Estimated slippage ${slippagePct.toFixed(3)}% exceeds ${riskProfile} limit — insufficient liquidity for $${usdtAmount}`,
    };
  }

  // REDUCE: spread elevated but within 2x limit — scale down size
  if (spread > maxSpread) {
    const sizeFactor  = Math.max(0.5, 1 - (spread - maxSpread) / maxSpread);
    const adjustedSize = Math.round(usdtAmount * sizeFactor * 100) / 100;

    return {
      approved:     true,
      adjustedSize,
      spread:       parseFloat(spreadPct.toFixed(4)),
      slippage:     parseFloat(slippagePct.toFixed(4)),
      reason:       'spread_elevated_size_reduced',
      narrative:    `⚡ Spread ${spreadPct.toFixed(3)}% elevated — size reduced from $${usdtAmount} to $${adjustedSize} (${(sizeFactor * 100).toFixed(0)}%)`,
      sizeFactor,
    };
  }

  // WARN: slippage elevated but within limit
  if (slippage > maxSlippage * 0.7) {
    return {
      approved:     true,
      adjustedSize: usdtAmount,
      spread:       parseFloat(spreadPct.toFixed(4)),
      slippage:     parseFloat(slippagePct.toFixed(4)),
      reason:       'slippage_elevated',
      narrative:    `⚠️ Slippage ~${slippagePct.toFixed(3)}% — above average, proceeding at full size`,
    };
  }

  // CLEAN: all good
  return {
    approved:     true,
    adjustedSize: usdtAmount,
    spread:       parseFloat(spreadPct.toFixed(4)),
    slippage:     parseFloat(slippagePct.toFixed(4)),
    reason:       'clean',
    narrative:    `✅ Spread ${spreadPct.toFixed(3)}% · Slippage ~${slippagePct.toFixed(3)}% — clean execution`,
  };
}

// ── Batch check for opportunity ranking ──────────────────────────
// Quickly checks spreads for multiple assets to deprioritise illiquid ones

export async function rankByLiquidity(signals, riskProfile = 'balanced') {
  const results = await Promise.allSettled(
    signals.map(async (s) => {
      const ob     = await fetchDeepOrderBook(s.symbol);
      const spread = ob ? computeSpread(ob) : 0.01; // penalise if unavailable
      return { ...s, _spread: spread ?? 0.01 };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => {
      // Sort by combined score: confidence - spread penalty
      const aPenalty = (a._spread / (MAX_SPREAD[riskProfile] || 0.0025)) * 10;
      const bPenalty = (b._spread / (MAX_SPREAD[riskProfile] || 0.0025)) * 10;
      return (b.confidence - bPenalty) - (a.confidence - aPenalty);
    });
}

export default { checkExecution, rankByLiquidity };