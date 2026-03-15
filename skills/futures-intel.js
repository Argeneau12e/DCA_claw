// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Binance Futures Intelligence (NEW Skill)
//
//  Uses Binance USD-margined Futures API (public endpoints, no key):
//    • GET /fapi/v1/openInterest         → current OI for symbol
//    • GET /futures/data/openInterestHist → OI trend (rising/falling)
//    • GET /futures/data/takerlongshortRatio → buy/sell pressure
//    • GET /fapi/v1/fundingRate           → funding rate (replaces old)
//    • GET /fapi/v1/premiumIndex          → mark price + index price
//
//  Scoring rationale:
//    Open Interest RISING  + price rising  = real bullish conviction (+6)
//    Open Interest RISING  + price falling = short build-up, bearish (-4)
//    Open Interest FALLING + price rising  = short squeeze ongoing (+4)
//    Open Interest FALLING + price falling = longs capitulating (-4)
//    Taker buy ratio > 0.55 = buy pressure (+4)
//    Taker buy ratio < 0.45 = sell pressure (-4)
//    Funding < -0.005 = shorts dominant = contrarian long signal (+8)
//    Funding > 0.015  = longs overheated = caution (-6)
//
//  Returns: { score, oiTrend, takerRatio, fundingRate, narrative[] }
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const FAPI      = 'https://fapi.binance.com';
const FAPI_DATA = 'https://fapi.binance.com/futures/data';
const HEADERS   = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' };
const TTL       = 5 * 60 * 1000; // 5 min cache

// ── Cache ─────────────────────────────────────────────────────────
const _cache = new Map(); // symbol → { data, time }

function getCache(key) {
  const c = _cache.get(key);
  return c && Date.now() - c.time < TTL ? c.data : null;
}
function setCache(key, data) {
  _cache.set(key, { data, time: Date.now() });
}

// ── Fetch helpers ─────────────────────────────────────────────────

async function fetchOI(symbol) {
  const key = `oi_${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const r = await axios.get(`${FAPI}/fapi/v1/openInterest`, {
      params: { symbol },
      headers: HEADERS,
      timeout: 6000,
    });
    setCache(key, r.data);
    return r.data;
  } catch { return null; }
}

async function fetchOIHistory(symbol) {
  const key = `oihist_${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const r = await axios.get(`${FAPI_DATA}/openInterestHist`, {
      params: { symbol, period: '1h', limit: 6 }, // last 6 hours
      headers: HEADERS,
      timeout: 6000,
    });
    setCache(key, r.data);
    return r.data;
  } catch { return null; }
}

async function fetchTakerRatio(symbol) {
  const key = `taker_${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const r = await axios.get(`${FAPI_DATA}/takerlongshortRatio`, {
      params: { symbol, period: '1h', limit: 3 },
      headers: HEADERS,
      timeout: 6000,
    });
    setCache(key, r.data);
    return r.data;
  } catch { return null; }
}

async function fetchFundingRate(symbol) {
  const key = `funding_${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const r = await axios.get(`${FAPI}/fapi/v1/fundingRate`, {
      params: { symbol, limit: 1 },
      headers: HEADERS,
      timeout: 6000,
    });
    const rate = parseFloat(r.data[0]?.fundingRate ?? null);
    setCache(key, rate);
    return rate;
  } catch { return null; }
}

async function fetchPremiumIndex(symbol) {
  const key = `premium_${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const r = await axios.get(`${FAPI}/fapi/v1/premiumIndex`, {
      params: { symbol },
      headers: HEADERS,
      timeout: 6000,
    });
    setCache(key, r.data);
    return r.data;
  } catch { return null; }
}

// ── Compute OI trend from history ────────────────────────────────
function computeOITrend(hist) {
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const vals = hist.map(h => parseFloat(h.sumOpenInterest || 0));
  const first = vals[0];
  const last  = vals[vals.length - 1];
  if (first === 0) return null;
  const changePct = ((last - first) / first) * 100;
  return { changePct: parseFloat(changePct.toFixed(2)), rising: changePct > 1, falling: changePct < -1 };
}

// ── Main export ───────────────────────────────────────────────────
export async function getFuturesIntelligence(asset) {
  const symbol = `${asset}USDT`;
  const narrative = [];
  let score = 0;

  try {
    // Fetch all in parallel
    const [oi, oiHist, takerData, fundingRate, premium] = await Promise.allSettled([
      fetchOI(symbol),
      fetchOIHistory(symbol),
      fetchTakerRatio(symbol),
      fetchFundingRate(symbol),
      fetchPremiumIndex(symbol),
    ]).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : null));

    // Not a futures-listed asset — return neutral but don't error
    if (!oi && !fundingRate) {
      return {
        score: 0,
        futuresListed: false,
        narrative: [],
        oiTrend: null,
        takerRatio: null,
        fundingRate: null,
      };
    }

    // ── Open Interest Analysis ────────────────────────────────────
    const oiTrend = computeOITrend(oiHist);
    let currentOI = oi ? parseFloat(oi.openInterest || 0) : 0;

    if (oiTrend) {
      if (oiTrend.rising) {
        score += 4;
        narrative.push(`📊 OI rising +${oiTrend.changePct.toFixed(1)}% (6h) — new money entering (+4pts)`);
      } else if (oiTrend.falling) {
        score -= 2;
        narrative.push(`📉 OI falling ${oiTrend.changePct.toFixed(1)}% (6h) — position unwinding (-2pts)`);
      } else {
        narrative.push(`📊 OI stable — no major position shifts (0pts)`);
      }
    }

    // ── Taker Buy/Sell Ratio ──────────────────────────────────────
    let takerRatio = null;
    if (Array.isArray(takerData) && takerData.length > 0) {
      // Average the last 3 periods
      const avg = takerData.reduce((s, d) => s + parseFloat(d.buySellRatio || 0.5), 0) / takerData.length;
      takerRatio = parseFloat(avg.toFixed(3));

      if (takerRatio >= 0.58) {
        score += 5;
        narrative.push(`🟢 Taker buy ratio ${(takerRatio*100).toFixed(0)}% — aggressive buyers dominant (+5pts)`);
      } else if (takerRatio >= 0.52) {
        score += 2;
        narrative.push(`🟢 Taker buy ratio ${(takerRatio*100).toFixed(0)}% — slight buy pressure (+2pts)`);
      } else if (takerRatio <= 0.42) {
        score -= 5;
        narrative.push(`🔴 Taker sell ratio ${((1-takerRatio)*100).toFixed(0)}% — sellers dominating (-5pts)`);
      } else if (takerRatio <= 0.48) {
        score -= 2;
        narrative.push(`🔴 Taker sell bias ${((1-takerRatio)*100).toFixed(0)}% — slight sell pressure (-2pts)`);
      }
    }

    // ── Funding Rate ──────────────────────────────────────────────
    if (fundingRate !== null && !isNaN(fundingRate)) {
      if (fundingRate < -0.012) {
        score += 10;
        narrative.push(`💰 Funding ${(fundingRate*100).toFixed(3)}% — extreme shorts = max contrarian long (+10pts)`);
      } else if (fundingRate < -0.005) {
        score += 6;
        narrative.push(`💰 Funding ${(fundingRate*100).toFixed(3)}% — negative rate, shorts paying (+6pts)`);
      } else if (fundingRate > 0.025) {
        score -= 8;
        narrative.push(`⚠️ Funding ${(fundingRate*100).toFixed(3)}% — severely overheated longs (-8pts)`);
      } else if (fundingRate > 0.015) {
        score -= 4;
        narrative.push(`⚠️ Funding ${(fundingRate*100).toFixed(3)}% — elevated long crowding (-4pts)`);
      } else if (fundingRate > 0.005) {
        score -= 1;
        narrative.push(`📊 Funding ${(fundingRate*100).toFixed(3)}% — longs slightly dominant (-1pt)`);
      } else {
        narrative.push(`📊 Funding ${(fundingRate*100).toFixed(3)}% — neutral rate`);
      }
    }

    // ── Premium Index / Basis ─────────────────────────────────────
    if (premium) {
      const markPrice  = parseFloat(premium.markPrice || 0);
      const indexPrice = parseFloat(premium.indexPrice || 0);
      if (markPrice > 0 && indexPrice > 0) {
        const basisPct = ((markPrice - indexPrice) / indexPrice) * 100;
        if (basisPct > 0.3) {
          score -= 2;
          narrative.push(`📈 Futures premium ${basisPct.toFixed(2)}% over spot — contango, longs bullish (-2pts caution)`);
        } else if (basisPct < -0.3) {
          score += 2;
          narrative.push(`📉 Futures discount ${Math.abs(basisPct).toFixed(2)}% — backwardation = distressed longs (+2pts)`);
        }
      }
    }

    return {
      score:          Math.max(-15, Math.min(15, Math.round(score))),
      futuresListed:  true,
      oiTrend,
      currentOI,
      takerRatio,
      fundingRate,
      narrative,
    };

  } catch (e) {
    console.warn('[FuturesIntel] Failed for', asset, e.message);
    return { score: 0, futuresListed: false, narrative: [], oiTrend: null, takerRatio: null, fundingRate: null };
  }
}

// Also export funding-only for confidence.js backwards compatibility
export async function getFundingRate(symbol) {
  return fetchFundingRate(symbol);
}

export default { getFuturesIntelligence, getFundingRate };