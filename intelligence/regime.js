// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Probabilistic Regime Classifier
//
//  Unlike a simple label classifier, this outputs a BLEND:
//  { trending: 0.6, ranging: 0.2, crash: 0.1, compression: 0.1 }
//
//  Six regimes detected:
//    TRENDING     — sustained directional move, momentum dominant
//    RANGING      — mean reversion valid, RSI reliable
//    VOLATILE     — expansion phase, wicks everywhere
//    COMPRESSED   — tight coil before breakout
//    CRASH        — panic selling, cascading liquidations
//    LIQUIDITY_HUNT — stop hunts, false breakouts, manipulation
//
//  This blend is used by weights.js to produce a dynamic weight
//  matrix for all 16 signals — no static weights anywhere.
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

const REAL_URL = 'https://api.binance.com';

// Cache per symbol — 10 min
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// ── ATR calculation ───────────────────────────────────────────────

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = klines.slice(1).map((k, i) => {
    const prev = klines[i];
    return Math.max(
      k.high - k.low,
      Math.abs(k.high - prev.close),
      Math.abs(k.low - prev.close)
    );
  });
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}

// ── EMA ───────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Bollinger Band width (measures compression vs expansion) ──────

function calcBBWidth(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return (std * 2) / mean; // normalised width as fraction of price
}

// ── ADX (trend strength) ──────────────────────────────────────────

function calcADX(klines, period = 14) {
  if (klines.length < period * 2) return null;
  const dms = klines.slice(1).map((k, i) => {
    const prev = klines[i];
    const upMove   = k.high - prev.high;
    const downMove = prev.low - k.low;
    const dmPlus  = (upMove > downMove && upMove > 0) ? upMove : 0;
    const dmMinus = (downMove > upMove && downMove > 0) ? downMove : 0;
    const tr = Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
    return { dmPlus, dmMinus, tr };
  });

  const recent = dms.slice(-period * 2);
  let smoothTR = 0, smoothPlus = 0, smoothMinus = 0;
  recent.slice(0, period).forEach(d => {
    smoothTR    += d.tr;
    smoothPlus  += d.dmPlus;
    smoothMinus += d.dmMinus;
  });

  const dxValues = [];
  for (let i = period; i < recent.length; i++) {
    smoothTR    = smoothTR    - smoothTR / period    + recent[i].tr;
    smoothPlus  = smoothPlus  - smoothPlus / period  + recent[i].dmPlus;
    smoothMinus = smoothMinus - smoothMinus / period + recent[i].dmMinus;
    if (smoothTR === 0) continue;
    const diPlus  = (smoothPlus / smoothTR) * 100;
    const diMinus = (smoothMinus / smoothTR) * 100;
    const diSum   = diPlus + diMinus;
    if (diSum === 0) continue;
    dxValues.push(Math.abs(diPlus - diMinus) / diSum * 100);
  }

  if (!dxValues.length) return null;
  return dxValues.reduce((s, v) => s + v, 0) / dxValues.length;
}

// ── Detect liquidation cascade proxy ─────────────────────────────
// Large candles with high volume = likely cascade

function detectLiquidationProxy(klines) {
  if (klines.length < 5) return 0;
  const recent = klines.slice(-5);
  const avgVol  = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const avgRange = klines.slice(-20).reduce((s, k) => s + (k.high - k.low) / k.close, 0) / 20;

  let cascadeScore = 0;
  for (const k of recent) {
    const volSpike  = k.volume / avgVol;
    const rangeSpike = (k.high - k.low) / k.close / avgRange;
    const isBearish  = k.close < k.open;
    if (volSpike > 3 && rangeSpike > 2 && isBearish) cascadeScore += 0.3;
    else if (volSpike > 2 && rangeSpike > 1.5 && isBearish) cascadeScore += 0.15;
  }
  return Math.min(1, cascadeScore);
}

// ── Detect stop hunt / liquidity hunt ────────────────────────────
// Long wicks relative to body = manipulation

function detectStopHunt(klines) {
  if (klines.length < 10) return 0;
  const recent = klines.slice(-10);
  let huntScore = 0;
  for (const k of recent) {
    const body = Math.abs(k.close - k.open);
    const totalRange = k.high - k.low;
    if (totalRange === 0) continue;
    const wickRatio = (totalRange - body) / totalRange;
    if (wickRatio > 0.75) huntScore += 0.15; // >75% wick = stop hunt candle
    else if (wickRatio > 0.60) huntScore += 0.07;
  }
  return Math.min(1, huntScore);
}

// ── Main regime classifier ────────────────────────────────────────

export async function classifyRegime(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    // Fetch 1h klines (100 candles for robust calculations)
    const r = await axios.get(`${REAL_URL}/api/v3/klines`, {
      params: { symbol, interval: '1h', limit: 100 },
      timeout: 8000,
    });

    const klines = r.data.map(k => ({
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    const closes  = klines.map(k => k.close);
    const current = closes[closes.length - 1];
    const pct24h  = (current - closes[closes.length - 25]) / closes[closes.length - 25] * 100;

    // Calculate regime indicators
    const atr       = calcATR(klines) || 0;
    const atrPct    = current > 0 ? atr / current * 100 : 0; // ATR as % of price
    const bbWidth   = calcBBWidth(closes) || 0;
    const adx       = calcADX(klines) || 0;
    const ema20     = calcEMA(closes, 20) || current;
    const ema50     = calcEMA(closes, 50) || current;
    const ema200    = calcEMA(closes, 200);
    const cascade   = detectLiquidationProxy(klines);
    const stopHunt  = detectStopHunt(klines);

    // Historical ATR average for comparison
    const atrHistory = klines.slice(-50).map((_, i, arr) =>
      i < 14 ? 0 : calcATR(arr.slice(Math.max(0, i - 14), i + 1)) || 0
    ).filter(v => v > 0);
    const avgHistATR = atrHistory.length
      ? atrHistory.reduce((s, v) => s + v, 0) / atrHistory.length
      : atr;
    const atrRatio = avgHistATR > 0 ? atr / avgHistATR : 1;

    // ── Score each regime 0–1 ─────────────────────────────────

    // CRASH: large price drop + liquidation cascade
    const crashScore = Math.min(1,
      (pct24h <= -12 ? 0.5 : pct24h <= -8 ? 0.3 : pct24h <= -5 ? 0.15 : 0) +
      cascade * 0.4 +
      (atrRatio > 3 ? 0.1 : 0)
    );

    // TRENDING: strong ADX + EMA alignment + directional move
    const emaAligned = ema200 ? (current > ema50 && ema50 > ema200 ? 1 : current < ema50 && ema50 < ema200 ? 0.8 : 0) : 0.5;
    const trendScore = Math.min(1,
      (adx > 30 ? 0.4 : adx > 20 ? 0.25 : adx > 15 ? 0.1 : 0) +
      emaAligned * 0.35 +
      (Math.abs(pct24h) > 5 && adx > 20 ? 0.25 : 0)
    );

    // RANGING: low ADX + price bouncing around EMA + tight BB
    const nearEMA = Math.abs(current - ema20) / ema20 < 0.02;
    const rangeScore = Math.min(1,
      (adx < 20 ? 0.4 : adx < 25 ? 0.2 : 0) +
      (nearEMA ? 0.2 : 0) +
      (bbWidth < 0.03 ? 0.25 : bbWidth < 0.05 ? 0.15 : 0) +
      (Math.abs(pct24h) < 3 ? 0.15 : 0)
    );

    // COMPRESSED: very tight BB + shrinking volume + low ATR
    const recentVol = klines.slice(-10).reduce((s, k) => s + k.volume, 0) / 10;
    const olderVol  = klines.slice(-30, -10).reduce((s, k) => s + k.volume, 0) / 20;
    const volShrink = olderVol > 0 ? 1 - recentVol / olderVol : 0;
    const compScore = Math.min(1,
      (bbWidth < 0.02 ? 0.5 : bbWidth < 0.03 ? 0.3 : 0) +
      (atrRatio < 0.7 ? 0.3 : atrRatio < 0.85 ? 0.15 : 0) +
      Math.max(0, volShrink * 0.2)
    );

    // VOLATILE: high ATR ratio + wide BB + large candle bodies
    const avgBody = klines.slice(-20).reduce((s, k) => s + Math.abs(k.close - k.open) / k.close, 0) / 20;
    const volScore = Math.min(1,
      (atrRatio > 2.5 ? 0.4 : atrRatio > 1.8 ? 0.25 : atrRatio > 1.3 ? 0.1 : 0) +
      (bbWidth > 0.08 ? 0.3 : bbWidth > 0.05 ? 0.15 : 0) +
      (avgBody > 0.015 ? 0.2 : avgBody > 0.01 ? 0.1 : 0) +
      (atrPct > 4 ? 0.1 : 0)
    );

    // LIQUIDITY_HUNT: stop hunt candles + medium volatility
    const huntScore = Math.min(1,
      stopHunt * 0.7 +
      (atrRatio > 1.2 && atrRatio < 2.5 ? 0.2 : 0) +
      (adx < 25 ? 0.1 : 0)
    );

    // ── Normalise to sum = 1 ──────────────────────────────────
    const raw = {
      TRENDING:        trendScore,
      RANGING:         rangeScore,
      VOLATILE:        volScore,
      COMPRESSED:      compScore,
      CRASH:           crashScore,
      LIQUIDITY_HUNT:  huntScore,
    };

    const total = Object.values(raw).reduce((s, v) => s + v, 0);
    const blend = total > 0
      ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, parseFloat((v / total).toFixed(3))]))
      : { TRENDING: 0, RANGING: 0.4, VOLATILE: 0.2, COMPRESSED: 0.1, CRASH: 0, LIQUIDITY_HUNT: 0.3 };

    // Dominant regime
    const dominant = Object.entries(blend).reduce((a, b) => b[1] > a[1] ? b : a)[0];
    const dominantConf = blend[dominant];

    const result = {
      blend,
      dominant,
      dominantConf: parseFloat(dominantConf.toFixed(3)),
      // Raw indicators for debugging
      indicators: {
        adx: parseFloat(adx.toFixed(1)),
        atrPct: parseFloat(atrPct.toFixed(2)),
        atrRatio: parseFloat(atrRatio.toFixed(2)),
        bbWidth: parseFloat(bbWidth.toFixed(4)),
        cascade: parseFloat(cascade.toFixed(2)),
        stopHunt: parseFloat(stopHunt.toFixed(2)),
        pct24h: parseFloat(pct24h.toFixed(2)),
        ema20AboveEma50: ema20 > ema50,
      },
    };

    cache.set(symbol, { ts: Date.now(), data: result });
    return result;

  } catch {
    // Fallback — neutral regime with uncertainty
    return {
      blend: { TRENDING: 0.1, RANGING: 0.35, VOLATILE: 0.25, COMPRESSED: 0.1, CRASH: 0.1, LIQUIDITY_HUNT: 0.1 },
      dominant: 'RANGING',
      dominantConf: 0.35,
      indicators: {},
    };
  }
}

// ── Get regime label for display ──────────────────────────────────

export function regimeLabel(regime) {
  return {
    TRENDING:       '📈 Trending',
    RANGING:        '↔️ Ranging',
    VOLATILE:       '⚡ Volatile',
    COMPRESSED:     '🗜️ Compressed',
    CRASH:          '🔴 Crash',
    LIQUIDITY_HUNT: '🎯 Liq Hunt',
  }[regime] || regime;
}

export default { classifyRegime, regimeLabel };
