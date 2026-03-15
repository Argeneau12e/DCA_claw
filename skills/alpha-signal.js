// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Binance Alpha Signal (NEW Skill)
//
//  Uses the official Binance Alpha Trading API (no API key required):
//    • Token List  → all active Alpha tokens with price/volume/holders
//    • 24hr Ticker → rolling price change stats per Alpha token
//
//  Two functions exported:
//    getAlphaSignal(asset)  → score (-15 to +15) for a specific asset
//    getAlphaTrending()     → sorted list of hottest Alpha assets right now
//
//  How scoring works:
//    +8  : asset is an active Alpha token (verified on Binance Alpha)
//    +4  : 24h volume in top 25% of all Alpha tokens (high activity)
//    +3  : holder count growing (hotTag = true on Binance Alpha)
//    +3  : price change positive but < +15% (momentum without overextension)
//    -3  : price change > +15% (possibly overextended — wait for dip)
//    -5  : price change < -20% (sharp dump — risky entry)
//    +2  : token recently listed on CEX (listingCex = true)
//    -8  : token marked offline or offsell
//
//  Used by:
//    • confidence.js  → as Signal 17 (Alpha Score) — NEW
//    • index.js       → pre-scan: filter/boost assets found on Alpha
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const ALPHA_TOKEN_LIST = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const ALPHA_TICKER     = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/ticker';
const HEADERS          = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' };
const TTL_TOKENS       = 20 * 60 * 1000; // 20 min cache for token list
const TTL_TICKER       = 3  * 60 * 1000; // 3 min cache for price data

// ── Cache ─────────────────────────────────────────────────────────
let _tokenCache     = null;
let _tokenCacheTime = 0;
let _tickerCache    = new Map(); // symbol → { data, time }

// ── Fetch full token list ─────────────────────────────────────────
async function fetchAlphaTokenList() {
  if (_tokenCache && Date.now() - _tokenCacheTime < TTL_TOKENS) {
    return _tokenCache;
  }
  try {
    const r = await axios.get(ALPHA_TOKEN_LIST, { headers: HEADERS, timeout: 8000 });
    if (r.data?.success && Array.isArray(r.data.data)) {
      _tokenCache     = r.data.data;
      _tokenCacheTime = Date.now();
      return _tokenCache;
    }
  } catch (e) {
    console.warn('[AlphaSignal] Token list fetch failed:', e.message);
  }
  return _tokenCache || [];
}

// ── Fetch 24hr ticker for a specific Alpha token ──────────────────
async function fetchAlphaTicker(alphaId) {
  const cached = _tickerCache.get(alphaId);
  if (cached && Date.now() - cached.time < TTL_TICKER) return cached.data;

  try {
    const symbol = `${alphaId}USDT`; // e.g. ALPHA_175USDT
    const r = await axios.get(ALPHA_TICKER, {
      params: { symbol },
      headers: HEADERS,
      timeout: 6000,
    });
    if (r.data?.success && r.data.data) {
      _tickerCache.set(alphaId, { data: r.data.data, time: Date.now() });
      return r.data.data;
    }
  } catch {
    // Ticker not available for this token — not an error
  }
  return null;
}

// ── Score a single asset against Alpha data ───────────────────────
export async function getAlphaSignal(asset) {
  try {
    const tokens = await fetchAlphaTokenList();
    if (!tokens.length) return { score: 0, found: false, narrative: [] };

    // Find this asset in the Alpha token list (case-insensitive)
    const assetUpper = asset.toUpperCase();
    const token = tokens.find(t =>
      (t.symbol || '').toUpperCase() === assetUpper ||
      (t.cexCoinName || '').toUpperCase() === assetUpper ||
      (t.name || '').toUpperCase() === assetUpper
    );

    if (!token) {
      return { score: 0, found: false, narrative: [] };
    }

    const narrative = [];
    let score = 0;

    // Base: confirmed Alpha token
    score += 8;
    narrative.push(`🔺 Binance Alpha token confirmed (+8pts)`);

    // Offline/offsell — hard negative
    if (token.offline || token.offsell) {
      return {
        score: -8,
        found: true,
        hardWarning: true,
        narrative: [`⚠️ Alpha token marked offline/offsell — risky entry`],
      };
    }

    // CEX listing signal
    if (token.listingCex) {
      score += 2;
      narrative.push(`📈 Listed on CEX — institutional discovery (+2pts)`);
    }

    // Hot tag (trending holders)
    if (token.hotTag) {
      score += 3;
      narrative.push(`🔥 Alpha hotTag active — holder growth trending (+3pts)`);
    }

    // Volume percentile — compute vs all tokens
    const volumes = tokens
      .map(t => parseFloat(t.volume24h || 0))
      .filter(v => v > 0)
      .sort((a, b) => a - b);
    const myVol = parseFloat(token.volume24h || 0);
    if (volumes.length > 4 && myVol > 0) {
      const p75 = volumes[Math.floor(volumes.length * 0.75)];
      const p90 = volumes[Math.floor(volumes.length * 0.90)];
      if (myVol >= p90) {
        score += 4;
        narrative.push(`📊 Alpha volume top 10% (${(myVol/1000).toFixed(0)}K USDT 24h) (+4pts)`);
      } else if (myVol >= p75) {
        score += 2;
        narrative.push(`📊 Alpha volume top 25% (+2pts)`);
      }
    }

    // Price change signal
    const pct24h = parseFloat(token.percentChange24h || 0);
    if (pct24h > 0 && pct24h <= 15) {
      score += 3;
      narrative.push(`📈 Alpha price +${pct24h.toFixed(1)}% — healthy momentum (+3pts)`);
    } else if (pct24h > 15) {
      score -= 3;
      narrative.push(`⚡ Alpha price +${pct24h.toFixed(1)}% — may be overextended (-3pts)`);
    } else if (pct24h < -20) {
      score -= 5;
      narrative.push(`📉 Alpha price ${pct24h.toFixed(1)}% — sharp dump, risky entry (-5pts)`);
    }

    // Fetch live ticker if available
    if (token.alphaId) {
      const ticker = await fetchAlphaTicker(token.alphaId);
      if (ticker) {
        const tickerPct = parseFloat(ticker.priceChangePercent || 0);
        const count = parseInt(ticker.count || 0);
        if (count > 50) {
          score += 1;
          narrative.push(`⚡ Alpha: ${count} trades in 24h — active market (+1pt)`);
        }
      }
    }

    return {
      score: Math.max(-15, Math.min(15, Math.round(score))),
      found: true,
      alphaId: token.alphaId,
      holders: token.holders,
      marketCap: token.marketCap,
      volume24h: token.volume24h,
      pct24h,
      narrative,
    };
  } catch (e) {
    console.warn('[AlphaSignal] Score failed for', asset, e.message);
    return { score: 0, found: false, narrative: [] };
  }
}

// ── Get top trending Alpha assets for pre-scan ────────────────────
// Returns array of { asset, score, volume24h, pct24h, holders, hotTag }
// sorted by a combined momentum + volume score
export async function getAlphaTrending(limit = 20) {
  try {
    const tokens = await fetchAlphaTokenList();
    if (!tokens.length) return [];

    // Filter: online, tradeable
    const active = tokens.filter(t => !t.offline && !t.offsell && t.volume24h > 0);

    // Score each for trending-ness
    const scored = active.map(t => {
      const vol    = parseFloat(t.volume24h || 0);
      const pct    = parseFloat(t.percentChange24h || 0);
      const mcap   = parseFloat(t.marketCap || 0);
      const hot    = t.hotTag ? 10 : 0;
      const cex    = t.listingCex ? 5 : 0;
      // Momentum score: positive price action + volume
      const momentum = pct > 0 && pct < 20 ? pct * 0.5 : 0;
      const volScore = vol > 0 ? Math.log10(vol) * 2 : 0;
      const total = hot + cex + momentum + volScore;
      return {
        asset:    (t.cexCoinName || t.symbol || '').toUpperCase(),
        symbol:   t.symbol,
        alphaId:  t.alphaId,
        score:    Math.round(total * 10) / 10,
        volume24h: vol,
        pct24h:   pct,
        holders:  parseInt(t.holders || 0),
        hotTag:   t.hotTag,
        listingCex: t.listingCex,
        marketCap:  mcap,
      };
    });

    return scored
      .filter(t => t.asset && t.asset.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (e) {
    console.warn('[AlphaSignal] Trending fetch failed:', e.message);
    return [];
  }
}

export default { getAlphaSignal, getAlphaTrending };