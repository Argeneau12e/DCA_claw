// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Token Info Module (Binance Skills Hub — Skill 3)
//
//  Validates token liquidity, holder count, and market cap before
//  the confidence engine wastes compute on an untradeable asset.
//
//  Gate logic:
//    HARD BLOCK  → liquidity < $5k OR holders < 50
//    SOFT WARN   → liquidity < $50k OR holders < 200 (-8pts)
//    PASS        → adequate liquidity and holders (0 to +3pts bonus)
//
//  Cached per-asset for 30 minutes — token fundamentals don't
//  change cycle-to-cycle.
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const BASE    = 'https://web3.binance.com/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token';
const HEADERS = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' };

// Tier1 — skip API call entirely, always adequate
const TIER1 = new Set([
  'BTC','ETH','BNB','SOL','ADA','AVAX','DOT','LINK','XRP','NEAR',
  'ARB','OP','UNI','ATOM','LTC','POL','INJ','SUI','APT','FIL',
  'ICP','TRX','TON','DOGE','MATIC','FTM','ALGO','VET','HBAR',
  'PEPE','WIF','BONK','SHIB','FLOKI',
]);

// Cache: keyed by symbol, 30-minute TTL
const infoCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// Gate thresholds
const HARD_BLOCK_LIQUIDITY = 5_000;    // $5k — untradeable
const HARD_BLOCK_HOLDERS   = 50;       // ghost token
const WARN_LIQUIDITY       = 50_000;   // $50k — thin
const WARN_HOLDERS         = 200;      // low distribution

// ── Fetch token data from Binance Skills Hub ──────────────────────

async function fetchTokenInfo(symbol) {
  try {
    // Search by symbol
    const searchRes = await axios.get(`${BASE}/search`, {
      params: {
        keyword: symbol,
        chainIds: '56,1,CT_501', // BSC, ETH, Solana
        orderBy: 'VOLUME_24H',
        limit: 5,
      },
      headers: HEADERS,
      timeout: 8000,
    });

    const list = searchRes.data?.data?.list || searchRes.data?.data || [];
    if (!list.length) return null;

    // Pick best match — exact symbol match preferred
    const match = list.find(t =>
      t.symbol?.toUpperCase() === symbol ||
      t.tokenSymbol?.toUpperCase() === symbol
    ) || list[0];

    if (!match) return null;

    // Fetch dynamic data (price, liquidity, holders, volume)
    const tokenId = match.tokenId || match.id || match.contractAddress;
    if (!tokenId) {
      // Use data already in search result
      return extractTokenData(match);
    }

    try {
      const dynRes = await axios.get(`${BASE}/detail/dynamic`, {
        params: { tokenId },
        headers: HEADERS,
        timeout: 6000,
      });
      const dynData = dynRes.data?.data || {};
      return extractTokenData({ ...match, ...dynData });
    } catch {
      return extractTokenData(match);
    }

  } catch (e) {
    return null; // API unavailable — caller handles graceful fallback
  }
}

function extractTokenData(raw) {
  return {
    symbol:     (raw.symbol || raw.tokenSymbol || '').toUpperCase(),
    name:       raw.name || raw.tokenName || '',
    liquidity:  parseFloat(raw.liquidity || raw.liquidityUsd || raw.tvl || 0),
    holders:    parseInt(raw.holderCount || raw.holders || raw.holderNum || 0),
    volume24h:  parseFloat(raw.volume24h || raw.volumeUsd24h || 0),
    marketCap:  parseFloat(raw.marketCap || raw.marketCapUsd || 0),
    price:      parseFloat(raw.price || raw.priceUsd || 0),
    priceChange24h: parseFloat(raw.priceChange24h || raw.priceChangePercent24h || 0),
    chain:      raw.chainId === '56' ? 'BSC' : raw.chainId === '1' ? 'ETH' : raw.chainId === 'CT_501' ? 'SOL' : 'UNKNOWN',
    verified:   raw.verified || raw.isVerified || false,
  };
}

// ── Main gate function ────────────────────────────────────────────

export async function getTokenInfo(symbol) {
  const clean = symbol.replace(/USDT$/i, '').toUpperCase();

  // Tier1 — always pass, no API call needed
  if (TIER1.has(clean)) {
    return {
      pass: true,
      tier1: true,
      score: 0,
      reason: 'Tier1 — liquidity verified',
      data: null,
    };
  }

  // Check cache
  const cached = infoCache.get(clean);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  const data = await fetchTokenInfo(clean);

  // API unavailable — graceful degradation, don't block
  if (!data) {
    const result = {
      pass: true,
      score: -2,
      reason: 'Token Info API unavailable — mild caution applied',
      unavailable: true,
      data: null,
    };
    infoCache.set(clean, { result, ts: Date.now() });
    return result;
  }

  const result = evaluateTokenInfo(clean, data);
  infoCache.set(clean, { result, ts: Date.now() });
  return result;
}

function evaluateTokenInfo(symbol, data) {
  const { liquidity, holders, volume24h, marketCap, verified } = data;
  const flags = [];
  let score = 0;
  let hardBlock = false;
  let blockReason = null;

  // ── Hard blocks ───────────────────────────────────────────────
  if (liquidity > 0 && liquidity < HARD_BLOCK_LIQUIDITY) {
    hardBlock = true;
    blockReason = `🚫 Liquidity too thin ($${(liquidity/1000).toFixed(1)}k) — untradeable`;
  } else if (holders > 0 && holders < HARD_BLOCK_HOLDERS) {
    hardBlock = true;
    blockReason = `🚫 Only ${holders} holders — ghost token`;
  }

  if (hardBlock) {
    return { pass: false, hardBlock: true, score: -100, reason: blockReason, data };
  }

  // ── Soft warnings ─────────────────────────────────────────────
  if (liquidity > 0 && liquidity < WARN_LIQUIDITY) {
    score -= 8;
    flags.push(`Thin liquidity $${(liquidity/1000).toFixed(0)}k (-8pts)`);
  } else if (liquidity >= 1_000_000) {
    score += 2;
    flags.push(`Strong liquidity $${(liquidity/1_000_000).toFixed(1)}M (+2pts)`);
  }

  if (holders > 0 && holders < WARN_HOLDERS) {
    score -= 5;
    flags.push(`Low holder count ${holders.toLocaleString()} (-5pts)`);
  } else if (holders >= 10_000) {
    score += 1;
    flags.push(`Wide distribution ${holders.toLocaleString()} holders (+1pt)`);
  }

  // Volume sanity
  if (volume24h > 0 && volume24h < 10_000) {
    score -= 5;
    flags.push(`Very low volume $${(volume24h/1000).toFixed(1)}k/24h (-5pts)`);
  } else if (volume24h >= 1_000_000) {
    score += 2;
    flags.push(`High volume $${(volume24h/1_000_000).toFixed(1)}M/24h (+2pts)`);
  }

  // Verified contract bonus
  if (verified) {
    score += 1;
    flags.push('Verified contract (+1pt)');
  }

  return {
    pass: true,
    hardBlock: false,
    score: Math.max(-20, Math.min(6, score)),
    reason: flags.length ? flags.join(', ') : 'Adequate token fundamentals',
    flags,
    data,
  };
}

// ── Skill status check (for STATUS command) ───────────────────────

export async function checkTokenInfoAvailability() {
  try {
    const r = await axios.get(`${BASE}/search`, {
      params: { keyword: 'BNB', chainIds: '56', limit: 1 },
      headers: HEADERS,
      timeout: 5000,
    });
    return r.status === 200 && r.data?.data;
  } catch {
    return false;
  }
}

export default { getTokenInfo, checkTokenInfoAvailability };