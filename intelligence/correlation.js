// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Cross-Asset Correlation Engine
//
//  Detects sector-wide dips vs isolated asset weakness.
//  A sector dip (3+ assets oversold together) is a stronger
//  accumulation signal than one asset dipping alone.
//
//  Also detects: BTC dominance shifts, sector rotation,
//  and isolated asset weakness (possible bad news).
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const REAL_URL = 'https://api.binance.com';

// Sector definitions
export const SECTORS = {
  LAYER1:   ['BTC','ETH','SOL','AVAX','ADA','DOT','NEAR','ATOM','APT','SUI'],
  DEFI:     ['UNI','AAVE','CRV','MKR','SNX','COMP','LDO','GMX','DYDX'],
  LAYER2:   ['ARB','OP','MATIC','IMX','STRK','MANTA'],
  EXCHANGE: ['BNB','OKB','HT','CRO'],
  MEME:     ['DOGE','SHIB','PEPE','FLOKI','BONK','WIF'],
  AI:       ['FET','AGIX','OCEAN','RNDR','TAO','WLD'],
  GAMING:   ['AXS','SAND','MANA','ENJ','GALA','ILV'],
  INFRA:    ['LINK','GRT','API3','BAND','TRB','FIL','ICP','AR'],
};

// Cache sector health data — expensive to fetch, cache 10 min
let sectorCache = null;
let sectorCacheTime = 0;
const SECTOR_TTL = 10 * 60 * 1000;

// ── Fetch 24h stats for a list of assets ─────────────────────────

async function fetchBatchStats(symbols) {
  try {
    const r = await axios.get(`${REAL_URL}/api/v3/ticker/24hr`, { timeout: 10000 });
    const map = {};
    for (const t of r.data) {
      const asset = t.symbol.replace('USDT', '');
      if (symbols.includes(asset)) {
        map[asset] = {
          pct: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume),
        };
      }
    }
    return map;
  } catch { return {}; }
}

// ── Build sector health snapshot ─────────────────────────────────

export async function getSectorHealth() {
  if (sectorCache && Date.now() - sectorCacheTime < SECTOR_TTL) return sectorCache;

  const allAssets = [...new Set(Object.values(SECTORS).flat())];
  const stats = await fetchBatchStats(allAssets);

  const health = {};
  for (const [sector, members] of Object.entries(SECTORS)) {
    const data = members.map(a => stats[a]).filter(Boolean);
    if (!data.length) continue;

    const avgPct = data.reduce((s, d) => s + d.pct, 0) / data.length;
    const oversoldCount = data.filter(d => d.pct <= -4).length;
    const oversoldRatio = oversoldCount / data.length;
    const totalVolume = data.reduce((s, d) => s + d.volume, 0);

    health[sector] = {
      avgPct: parseFloat(avgPct.toFixed(2)),
      oversoldCount,
      oversoldRatio: parseFloat(oversoldRatio.toFixed(2)),
      totalVolume,
      memberCount: data.length,
      isSectorDip: oversoldRatio >= 0.5 && avgPct <= -3,    // 50%+ of sector down 3%+
      isSectorPump: avgPct >= 5,
    };
  }

  sectorCache = health;
  sectorCacheTime = Date.now();
  return health;
}

// ── Get sector for an asset ───────────────────────────────────────

export function getAssetSector(asset) {
  for (const [sector, members] of Object.entries(SECTORS)) {
    if (members.includes(asset.toUpperCase())) return sector;
  }
  return null;
}

// ── Score correlation for a specific asset ────────────────────────

export async function getCorrelationScore(asset, assetPct) {
  const sector = getAssetSector(asset);
  if (!sector) return { score: 0, narrative: [] };

  const health = await getSectorHealth();
  const sectorData = health[sector];
  if (!sectorData) return { score: 0, narrative: [] };

  let score = 0;
  const narrative = [];

  // Sector-wide dip — strongest signal
  if (sectorData.isSectorDip) {
    score += 8;
    narrative.push(`Sector dip confirmed: ${sectorData.oversoldCount}/${sectorData.memberCount} ${sector} assets down (avg ${sectorData.avgPct}%) — sector accumulation opportunity (+8pts)`);
  }

  // Asset down MORE than sector average — isolated weakness, possible bad news
  if (assetPct < sectorData.avgPct - 5) {
    score -= 8;
    narrative.push(`${asset} down ${Math.abs(assetPct - sectorData.avgPct).toFixed(1)}% MORE than ${sector} sector avg — possible asset-specific issue (-8pts)`);
  }

  // Asset down LESS than sector — relative strength within a dip
  if (sectorData.isSectorDip && assetPct > sectorData.avgPct + 2) {
    score += 5;
    narrative.push(`${asset} showing relative strength vs ${sector} sector — holding better than peers (+5pts)`);
  }

  // Sector pumping while asset is dipping — divergence signal
  if (sectorData.isSectorPump && assetPct <= -2) {
    score -= 6;
    narrative.push(`${sector} sector pumping (+${sectorData.avgPct}%) but ${asset} lagging — bearish divergence (-6pts)`);
  }

  return {
    score: Math.max(-12, Math.min(12, score)),
    sector,
    sectorData,
    narrative,
  };
}

export default { getSectorHealth, getCorrelationScore, getAssetSector, SECTORS };
