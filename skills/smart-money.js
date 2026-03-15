// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Smart Money Signal Module (Binance Skills Hub)
//
//  Queries Binance Web3 for on-chain smart money wallet activity
//  on BSC and Solana. Used to INFORM CEX spot decisions.
//
//  When institutional/smart wallets accumulate on-chain,
//  CEX prices typically follow within 1-6 hours.
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const INFLOW_URL = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query';

// Cache smart money data — moves slower than retail, 10min is fine
let smCache = { bsc: null, sol: null, bscTime: 0, solTime: 0 };
const SM_TTL = 10 * 60 * 1000;

// ── Fetch smart money inflow rankings ────────────────────────────

async function fetchSmartMoneyRankings(chainId, period = '1h') {
  try {
    const r = await axios.post(
      INFLOW_URL,
      { chainId, period, tagType: 2 },
      { headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, timeout: 10000 }
    );
    return r.data?.data || [];
  } catch {
    return [];
  }
}

// ── Get cached rankings for both chains ──────────────────────────

async function getSmartMoneyData() {
  const now = Date.now();
  const promises = [];

  if (!smCache.bsc || now - smCache.bscTime > SM_TTL) {
    promises.push(
      fetchSmartMoneyRankings('56', '1h').then(d => { smCache.bsc = d; smCache.bscTime = now; })
    );
  }
  if (!smCache.sol || now - smCache.solTime > SM_TTL) {
    promises.push(
      fetchSmartMoneyRankings('CT_501', '1h').then(d => { smCache.sol = d; smCache.solTime = now; })
    );
  }

  if (promises.length > 0) await Promise.allSettled(promises);
  return { bsc: smCache.bsc || [], sol: smCache.sol || [] };
}

// ── Score a specific asset based on smart money activity ─────────

export async function getSmartMoneyScore(symbol) {
  const clean = symbol.replace('USDT', '').toUpperCase();
  const { bsc, sol } = await getSmartMoneyData();

  // Search both chains for this token
  const allRankings = [...bsc, ...sol];
  const match = allRankings.find(t =>
    t.symbol?.toUpperCase() === clean ||
    t.tokenSymbol?.toUpperCase() === clean
  );

  if (!match) {
    return { score: 0, found: false, narrative: 'No smart money data for this asset' };
  }

  const netInflow = parseFloat(match.netInflow || match.inflowAmount || 0);
  const buyCount = parseInt(match.buyCount || match.buyTxCount || 0);
  const sellCount = parseInt(match.sellCount || match.sellTxCount || 0);
  const exitRate = parseFloat(match.exitRate || 0);

  let score = 0;
  let narrative = [];

  // Exit rate check first — if smart money already left, it's a warning
  if (exitRate > 70) {
    score -= 15;
    narrative.push(`Smart money exited ${exitRate.toFixed(0)}% of position (-15pts)`);
    return { score, found: true, netInflow, buyCount, sellCount, exitRate, narrative };
  }

  // Net inflow scoring
  if (netInflow > 500000 && buyCount >= 5) {
    score += 15;
    narrative.push(`Strong smart money accumulation: $${(netInflow/1000).toFixed(0)}k inflow, ${buyCount} buys (+15pts)`);
  } else if (netInflow > 100000 && buyCount >= 2) {
    score += 10;
    narrative.push(`Moderate smart money interest: $${(netInflow/1000).toFixed(0)}k inflow (+10pts)`);
  } else if (netInflow > 10000) {
    score += 5;
    narrative.push(`Mild smart money interest: $${(netInflow/1000).toFixed(0)}k inflow (+5pts)`);
  } else if (netInflow < -100000) {
    score -= 10;
    narrative.push(`Smart money SELLING: $${(Math.abs(netInflow)/1000).toFixed(0)}k outflow (-10pts)`);
  } else if (netInflow < -10000) {
    score -= 5;
    narrative.push(`Mild smart money selling: $${(Math.abs(netInflow)/1000).toFixed(0)}k outflow (-5pts)`);
  }

  // Sell pressure check
  if (sellCount > buyCount * 2) {
    score -= 5;
    narrative.push(`More sells (${sellCount}) than buys (${buyCount}) from smart money (-5pts)`);
  }

  return {
    score: Math.max(-15, Math.min(15, score)),
    found: true,
    netInflow,
    buyCount,
    sellCount,
    exitRate,
    narrative,
    chain: match.chainId === '56' ? 'BSC' : 'Solana',
  };
}

// ── Get top smart money picks (for opportunity radar) ─────────────

export async function getTopSmartMoneyPicks(limit = 10) {
  const { bsc, sol } = await getSmartMoneyData();
  const all = [...bsc, ...sol]
    .filter(t => parseFloat(t.netInflow || t.inflowAmount || 0) > 50000)
    .sort((a, b) => parseFloat(b.netInflow || b.inflowAmount || 0) - parseFloat(a.netInflow || a.inflowAmount || 0))
    .slice(0, limit);

  return all.map(t => ({
    symbol: (t.symbol || t.tokenSymbol || '').toUpperCase(),
    netInflow: parseFloat(t.netInflow || t.inflowAmount || 0),
    buyCount: parseInt(t.buyCount || t.buyTxCount || 0),
    chain: t.chainId === '56' ? 'BSC' : 'Solana',
  }));
}

export default { getSmartMoneyScore, getTopSmartMoneyPicks };
