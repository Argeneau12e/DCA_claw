// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Multi-Timeframe Trend Alignment
//
//  When 15m + 1h + 4h + 1d all agree the asset is oversold,
//  confidence gets a major boost. Mixed signals = uncertainty = penalty.
//
//  Timeframes: 15m (momentum), 1h (short), 4h (medium), 1d (macro)
//  RSI thresholds: oversold <35, neutral 35-65, overbought >65
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const REAL_URL = 'https://api.binance.com';

const cache = new Map();
const CACHE_TTL = 8 * 60 * 1000; // 8 min

// ── RSI calculation ───────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ── Fetch RSI for one timeframe ───────────────────────────────────

async function fetchRSI(symbol, interval, limit = 50) {
  try {
    const r = await axios.get(`${REAL_URL}/api/v3/klines`, {
      params: { symbol, interval, limit },
      timeout: 6000,
    });
    const closes = r.data.map(k => parseFloat(k[4]));
    return calcRSI(closes);
  } catch { return null; }
}

// ── Label RSI zone ────────────────────────────────────────────────

function rsiZone(rsi) {
  if (rsi === null) return 'UNKNOWN';
  if (rsi < 25) return 'DEEP_OVERSOLD';
  if (rsi < 35) return 'OVERSOLD';
  if (rsi < 45) return 'WEAK';
  if (rsi < 55) return 'NEUTRAL';
  if (rsi < 65) return 'STRONG';
  if (rsi < 75) return 'OVERBOUGHT';
  return 'DEEP_OVERBOUGHT';
}

// ── Get multi-timeframe alignment score ───────────────────────────

export async function getMultiTimeframeScore(symbol, rsi1h = null) {
  const cacheKey = symbol;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  // Fetch 15m, 4h, 1d (we already have 1h from main engine)
  const [rsi15m, rsi4h, rsi1d] = await Promise.all([
    fetchRSI(symbol, '15m', 50),
    fetchRSI(symbol, '4h', 50),
    fetchRSI(symbol, '1d', 30),
  ]);

  const timeframes = {
    '15m': { rsi: rsi15m, zone: rsiZone(rsi15m), weight: 1 },
    '1h':  { rsi: rsi1h,  zone: rsiZone(rsi1h),  weight: 2 },
    '4h':  { rsi: rsi4h,  zone: rsiZone(rsi4h),  weight: 3 },
    '1d':  { rsi: rsi1d,  zone: rsiZone(rsi1d),  weight: 4 },
  };

  const validTFs = Object.entries(timeframes).filter(([, v]) => v.rsi !== null);
  if (validTFs.length < 2) return neutral(timeframes);

  // Count alignments
  const oversoldCount    = validTFs.filter(([, v]) => ['DEEP_OVERSOLD','OVERSOLD'].includes(v.zone)).length;
  const overboughtCount  = validTFs.filter(([, v]) => ['DEEP_OVERBOUGHT','OVERBOUGHT'].includes(v.zone)).length;
  const deepOversoldCount = validTFs.filter(([, v]) => v.zone === 'DEEP_OVERSOLD').length;

  let score = 0;
  const narrative = [];

  // Full alignment — all timeframes oversold
  if (oversoldCount === validTFs.length) {
    score += 15;
    narrative.push(`🎯 Full MTF alignment: ALL timeframes oversold (15m/1h/4h/1d) — extremely strong entry (+15pts)`);
  } else if (oversoldCount >= 3) {
    score += 10;
    narrative.push(`Strong MTF alignment: ${oversoldCount}/4 timeframes oversold (+10pts)`);
  } else if (oversoldCount === 2) {
    score += 5;
    narrative.push(`Partial MTF alignment: 2/4 timeframes oversold (+5pts)`);
  }

  // Deep oversold on higher timeframes (4h or 1d) — macro significance
  if ((timeframes['4h'].zone === 'DEEP_OVERSOLD' || timeframes['1d'].zone === 'DEEP_OVERSOLD')) {
    score += 6;
    narrative.push(`Macro deep oversold: ${timeframes['1d'].zone === 'DEEP_OVERSOLD' ? '1d' : '4h'} RSI in deep oversold territory (+6pts)`);
  }

  // Overbought alignment — counter-signal
  if (overboughtCount >= 3) {
    score -= 12;
    narrative.push(`⚠️ MTF overbought: ${overboughtCount}/4 timeframes overbought — avoid buying into peaks (-12pts)`);
  }

  // Mixed signals — short term oversold but long term overbought
  if (['DEEP_OVERSOLD','OVERSOLD'].includes(timeframes['15m'].zone) &&
      ['OVERBOUGHT','DEEP_OVERBOUGHT'].includes(timeframes['1d'].zone)) {
    score -= 5;
    narrative.push(`MTF conflict: 15m oversold but 1d overbought — short-term bounce in downtrend (-5pts)`);
  }

  const result = {
    score: Math.max(-15, Math.min(15, score)),
    timeframes,
    oversoldCount,
    overboughtCount,
    deepOversoldCount,
    narrative,
    alignment: oversoldCount >= 3 ? 'STRONG' : oversoldCount >= 2 ? 'MODERATE' : 'WEAK',
  };

  cache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

function neutral(timeframes) {
  return {
    score: 0, timeframes, oversoldCount: 0,
    overboughtCount: 0, deepOversoldCount: 0,
    narrative: [], alignment: 'UNKNOWN',
  };
}

export default { getMultiTimeframeScore };
