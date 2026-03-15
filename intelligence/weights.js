// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Dynamic Signal Weight Matrix
//
//  Instead of RSI always = 25pts, each signal's max contribution
//  shifts based on the probabilistic regime blend.
//
//  Example:
//    In RANGING market  → RSI weight 1.4x (mean reversion works)
//    In TRENDING market → RSI weight 0.5x (oversold = trap)
//    In CRASH market    → BTC correlation weight 1.8x (safety first)
//
//  The weight matrix is a 6×16 table (6 regimes × 16 signals).
//  The final weight for each signal = dot product of regime blend
//  and that signal's weights across all regimes.
//
//  Signal index reference:
//    0  rsi1h          1  rsi4h          2  priceAction
//    3  volume         4  orderBook      5  funding
//    6  volatility     7  btcCorr        8  memory
//    9  sentiment      10 smartMoney     11 correlation
//    12 session        13 news           14 whale
//    15 mtf
// ─────────────────────────────────────────────────────────────────

// ── Weight matrix ─────────────────────────────────────────────────
// Each row = one regime. Each column = one signal.
// Value = multiplier (1.0 = no change, 1.5 = 50% boost, 0.4 = 60% reduction)

const SIGNAL_KEYS = [
  'rsi1h', 'rsi4h', 'priceAction', 'volume', 'orderBook',
  'funding', 'volatility', 'btcCorr', 'memory', 'sentiment',
  'smartMoney', 'correlation', 'session', 'news', 'whale', 'mtf',
];

const REGIME_WEIGHTS = {
  //              rsi1h  rsi4h  price  vol   ob    fund  volat btcC  mem   sent  sm    corr  sess  news  whal  mtf
  TRENDING:      [0.50,  0.55,  1.30,  1.40, 1.20, 1.30, 0.80, 1.10, 0.90, 1.10, 1.30, 1.20, 1.10, 1.00, 1.20, 1.40],
  RANGING:       [1.40,  1.35,  1.10,  0.90, 1.10, 1.00, 1.20, 0.90, 1.30, 1.10, 1.00, 0.90, 1.00, 0.90, 0.90, 1.20],
  VOLATILE:      [0.70,  0.75,  0.80,  1.20, 0.90, 1.10, 0.40, 1.20, 0.70, 0.90, 1.10, 1.10, 0.80, 1.20, 1.30, 0.80],
  COMPRESSED:    [1.20,  1.25,  0.90,  0.70, 1.00, 0.90, 1.40, 0.80, 1.10, 1.00, 1.20, 0.80, 0.90, 0.80, 0.80, 1.30],
  CRASH:         [0.60,  0.65,  1.20,  1.50, 1.00, 0.90, 0.50, 1.80, 0.80, 1.30, 1.40, 1.50, 0.70, 1.40, 1.00, 0.70],
  LIQUIDITY_HUNT:[0.80,  0.80,  0.90,  1.10, 0.70, 1.20, 0.90, 1.00, 0.90, 0.90, 1.20, 1.00, 0.90, 0.90, 1.50, 0.90],
};

// ── Threshold adjustments per dominant regime ─────────────────────
// Added to base threshold — positive = harder to trigger

const REGIME_THRESHOLD_DELTA = {
  TRENDING:       +5,   // need more conviction in trends
  RANGING:        -3,   // mean reversion more reliable
  VOLATILE:       +10,  // much harder to trigger in chaos
  COMPRESSED:     -5,   // compressed = pre-breakout, be ready
  CRASH:          +8,   // extra caution in crash
  LIQUIDITY_HUNT: +12,  // most caution — market is hunting stops
};

// ── Compute blended weight for each signal ────────────────────────

export function computeSignalWeights(regimeBlend) {
  const weights = {};

  for (let i = 0; i < SIGNAL_KEYS.length; i++) {
    const key = SIGNAL_KEYS[i];
    let blendedWeight = 0;
    let totalBlend = 0;

    for (const [regime, share] of Object.entries(regimeBlend)) {
      const regimeRow = REGIME_WEIGHTS[regime];
      if (!regimeRow) continue;
      blendedWeight += regimeRow[i] * share;
      totalBlend += share;
    }

    // Normalise in case blend doesn't sum to exactly 1
    weights[key] = totalBlend > 0
      ? parseFloat((blendedWeight / totalBlend).toFixed(3))
      : 1.0;
  }

  return weights;
}

// ── Compute blended threshold delta ──────────────────────────────

export function computeThresholdDelta(regimeBlend) {
  let delta = 0;
  for (const [regime, share] of Object.entries(regimeBlend)) {
    const rd = REGIME_THRESHOLD_DELTA[regime] ?? 0;
    delta += rd * share;
  }
  return Math.round(delta);
}

// ── Apply weights to raw signal scores ───────────────────────────

export function applyDynamicWeights(rawSignals, signalWeights) {
  const weighted = {};
  for (const [key, score] of Object.entries(rawSignals)) {
    const w = signalWeights[key] ?? 1.0;
    weighted[key] = parseFloat((score * w).toFixed(2));
  }
  return weighted;
}

// ── Confluence multiplier ─────────────────────────────────────────
// When top signals AGREE strongly, add a bonus
// When top signals CONTRADICT each other, apply a penalty

export function computeConfluenceMultiplier(rawSignals, signalWeights) {
  // Score each signal by its weighted contribution
  const contributions = Object.entries(rawSignals)
    .map(([key, score]) => ({
      key,
      raw: score,
      weighted: score * (signalWeights[key] ?? 1.0),
    }))
    .filter(s => s.raw !== 0)
    .sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted));

  if (contributions.length < 3) return { multiplier: 1.0, bonus: 0, narrative: [] };

  const top5 = contributions.slice(0, 5);
  const positives = top5.filter(s => s.weighted > 0);
  const negatives = top5.filter(s => s.weighted < 0);

  let bonus = 0;
  const narrative = [];

  // Strong confluence — top 4+ signals all agree bullish
  if (positives.length >= 4 && negatives.length === 0) {
    bonus = 12;
    narrative.push(`🔥 Strong confluence: top ${positives.length} signals all bullish (+12 confluence bonus)`);
  } else if (positives.length >= 3 && negatives.length === 0) {
    bonus = 7;
    narrative.push(`✨ Good confluence: ${positives.length} signals aligned bullish (+7 confluence bonus)`);
  } else if (positives.length >= 2 && negatives.length === 0) {
    bonus = 3;
    narrative.push(`Signal agreement: ${positives.length} signals aligned (+3 confluence bonus)`);
  }

  // Contradiction — top signals fighting each other
  if (positives.length >= 2 && negatives.length >= 2) {
    bonus -= 8;
    narrative.push(`⚠️ Signal conflict: ${positives.length} bullish vs ${negatives.length} bearish signals (-8 conflict penalty)`);
  } else if (positives.length >= 1 && negatives.length >= 2) {
    bonus -= 5;
    narrative.push(`Mixed signals: more bearish than bullish in top indicators (-5 conflict penalty)`);
  }

  return {
    bonus,
    multiplier: 1.0, // bonus is additive, not multiplicative
    narrative,
    topSignals: top5.map(s => s.key),
  };
}

// ── Signal freshness decay ────────────────────────────────────────
// Penalise signals based on how stale the conditions are.
// Uses the timestamp of when scoring started vs when RSI last crossed threshold.

export function computeFreshnessDecay(klines1h, rsi1h) {
  if (!klines1h || klines1h.length < 3 || rsi1h === null) {
    return { decayFactor: 1.0, narrative: [] };
  }

  // Check how long RSI has been oversold
  const closes = klines1h.map(k => k.close || k[4]);
  let oversoldPeriods = 0;

  // Count how many consecutive hours RSI has been <45
  for (let i = closes.length - 1; i >= Math.max(0, closes.length - 8); i--) {
    const slice = closes.slice(Math.max(0, i - 14), i + 1);
    if (slice.length < 10) break;
    // Quick RSI estimate
    let ag = 0, al = 0;
    for (let j = 1; j < slice.length; j++) {
      const d = slice[j] - slice[j - 1];
      if (d > 0) ag += d; else al += Math.abs(d);
    }
    ag /= (slice.length - 1); al /= (slice.length - 1);
    const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    if (rsi > 45) break;
    oversoldPeriods++;
  }

  let decayFactor = 1.0;
  const narrative = [];

  if (oversoldPeriods >= 6) {
    decayFactor = 0.75;
    narrative.push(`⏰ Signal decay: RSI has been oversold for ${oversoldPeriods}h — stale setup (0.75x decay)`);
  } else if (oversoldPeriods >= 4) {
    decayFactor = 0.88;
    narrative.push(`Signal decay: oversold for ${oversoldPeriods}h — mild staleness (0.88x decay)`);
  } else if (oversoldPeriods <= 1) {
    // Fresh signal
    decayFactor = 1.08;
    narrative.push(`⚡ Fresh signal: RSI just crossed oversold threshold — high freshness (+8% boost)`);
  }

  return { decayFactor, oversoldPeriods, narrative };
}

export default {
  computeSignalWeights,
  computeThresholdDelta,
  applyDynamicWeights,
  computeConfluenceMultiplier,
  computeFreshnessDecay,
  SIGNAL_KEYS,
};
