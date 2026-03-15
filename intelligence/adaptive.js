// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Adaptive ML Engine
//
//  Phase 4: signal-level learning. Previously only patterns
//  (regime_RSIzone) were tracked. Now each of the 16 signals
//  gets its own EMA weight that updates after every resolved trade.
//
//  Three systems:
//
//  1. SIGNAL-LEVEL WEIGHTS
//     After each resolved trade, check which signals were present
//     at entry. If the trade won → increase those signals' weights.
//     If the trade lost → decrease them.
//     These weights feed into weights.js as a final multiplier layer.
//
//  2. CONFIDENCE CALIBRATION
//     Track predicted confidence vs actual outcome.
//     If 70% confidence is only winning 45% of the time → the
//     engine is overconfident. Apply a calibration curve to squish
//     predictions toward reality.
//
//  3. MARKET CLUSTER TRACKING
//     Group trades into market conditions (bull/bear/sideways × 
//     high/low volatility). Track which clusters the agent performs
//     best in. When current market matches a winning cluster → boost.
//     When it matches a losing cluster → reduce size.
//
//  All data stored in logs/adaptive.json
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR    = join(__dirname, '../logs');
const ADAPTIVE_FILE = join(LOGS_DIR, 'adaptive.json');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ── Signal keys — must match weights.js ──────────────────────────

const SIGNAL_KEYS = [
  'rsi1h', 'rsi4h', 'priceAction', 'volume', 'orderBook',
  'funding', 'volatility', 'btcCorr', 'memory', 'sentiment',
  'smartMoney', 'correlation', 'session', 'news', 'whale', 'mtf',
];

// Learning rates — different signals update at different speeds
// Faster = responds to new info quickly but is noisier
// Slower = more stable but slower to adapt
const SIGNAL_ALPHA = {
  rsi1h:       0.08, // slow — RSI is reliable long-term
  rsi4h:       0.08,
  priceAction: 0.10,
  volume:      0.12, // medium — volume regimes change
  orderBook:   0.15, // faster — OB changes quickly
  funding:     0.12,
  volatility:  0.10,
  btcCorr:     0.08, // slow — BTC correlation is structural
  memory:      0.06, // very slow — memory patterns need accumulation
  sentiment:   0.14, // faster — sentiment is reactive
  smartMoney:  0.10,
  correlation: 0.12,
  session:     0.08,
  news:        0.18, // fastest — news is highly situational
  whale:       0.13,
  mtf:         0.09,
};

const MAX_SIGNAL_WEIGHT = 1.8;
const MIN_SIGNAL_WEIGHT = 0.3;

// ── Load/save adaptive state ──────────────────────────────────────

function loadAdaptive() {
  try {
    if (existsSync(ADAPTIVE_FILE)) {
      return JSON.parse(readFileSync(ADAPTIVE_FILE, 'utf8'));
    }
  } catch {}
  return {
    signalWeights: {},    // { signalKey: { weight, trades, wins, lastUpdated } }
    calibration: {},      // { confBucket: { predicted, actual, trades } }
    clusters: {},         // { clusterKey: { trades, wins, avgPnl } }
    lastUpdated: null,
  };
}

function saveAdaptive(data) {
  writeFileSync(ADAPTIVE_FILE, JSON.stringify({
    ...data,
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

// ── 1. Signal-level weight update ────────────────────────────────

function computeSignalReward(pnlPct, outcome) {
  if (outcome === 'WIN') {
    if (pnlPct >= 8)  return 1.0;
    if (pnlPct >= 4)  return 0.75;
    if (pnlPct >= 1)  return 0.5;
    return 0.3;
  }
  if (outcome === 'LOSS') {
    if (pnlPct <= -8)  return -1.0;
    if (pnlPct <= -4)  return -0.75;
    if (pnlPct <= -1)  return -0.5;
    return -0.3;
  }
  return 0;
}

export function updateSignalWeights(trade) {
  const { outcome, pnlPct24h, rawSignals, asset } = trade;
  if (!outcome || pnlPct24h == null || !rawSignals) return;

  const state  = loadAdaptive();
  const reward = computeSignalReward(pnlPct24h, outcome);

  for (const key of SIGNAL_KEYS) {
    const rawScore = rawSignals[key];
    if (rawScore === undefined || rawScore === null) continue;

    // Only learn from signals that were active (non-zero contribution)
    const wasActive = Math.abs(rawScore) > 1;
    if (!wasActive) continue;

    // Signal was positive (bullish) — was that correct?
    const signalWasBullish = rawScore > 0;
    const outcomeWasGood   = outcome === 'WIN';

    // Agreement: signal and outcome match → reward. Disagreement → penalise.
    const agreement = (signalWasBullish === outcomeWasGood) ? 1 : -1;
    const scaledReward = reward * agreement * Math.min(1, Math.abs(rawScore) / 10);

    // EMA update
    const alpha  = SIGNAL_ALPHA[key] || 0.10;
    const current = state.signalWeights[key]?.weight ?? 1.0;
    const target  = 1.0 + scaledReward;
    const updated = alpha * target + (1 - alpha) * current;
    const clamped = Math.max(MIN_SIGNAL_WEIGHT, Math.min(MAX_SIGNAL_WEIGHT, updated));

    if (!state.signalWeights[key]) {
      state.signalWeights[key] = { weight: 1.0, trades: 0, wins: 0, totalPnl: 0 };
    }

    state.signalWeights[key].weight     = parseFloat(clamped.toFixed(4));
    state.signalWeights[key].trades     = (state.signalWeights[key].trades || 0) + 1;
    state.signalWeights[key].wins       = (state.signalWeights[key].wins || 0) + (outcome === 'WIN' ? 1 : 0);
    state.signalWeights[key].totalPnl   = parseFloat(((state.signalWeights[key].totalPnl || 0) + (pnlPct24h || 0)).toFixed(2));
    state.signalWeights[key].lastUpdated = new Date().toISOString();
  }

  saveAdaptive(state);
}

// ── 2. Confidence calibration ─────────────────────────────────────
// Bucket predicted confidence into 10% bands
// Track actual win rate per band
// If overfitting detected, return a calibration multiplier

function getConfBucket(confidence) {
  return Math.floor(confidence / 10) * 10; // 0,10,20,...,90
}

export function updateCalibration(trade) {
  const { confidence, outcome } = trade;
  if (!confidence || !outcome || outcome === 'PENDING') return;

  const state  = loadAdaptive();
  const bucket = getConfBucket(confidence);
  const key    = `conf_${bucket}`;

  if (!state.calibration[key]) {
    state.calibration[key] = { predicted: bucket + 5, actual: 0, trades: 0, wins: 0 };
  }

  state.calibration[key].trades++;
  if (outcome === 'WIN') state.calibration[key].wins++;
  state.calibration[key].actual = parseFloat(
    (state.calibration[key].wins / state.calibration[key].trades * 100).toFixed(1)
  );

  saveAdaptive(state);
}

// Returns calibrated confidence — squishes toward empirical win rate
export function getCalibratedConfidence(rawConfidence) {
  const state   = loadAdaptive();
  const bucket  = getConfBucket(rawConfidence);
  const key     = `conf_${bucket}`;
  const cal     = state.calibration[key];

  if (!cal || cal.trades < 10) {
    // Not enough data — return raw confidence with a mild conservative squish
    return Math.round(rawConfidence * 0.95);
  }

  const predictedMid = bucket + 5;
  const actualRate   = cal.actual;

  // Blend: 60% raw + 40% empirical
  // This prevents over-correction from small samples
  const blended = rawConfidence * 0.6 + (rawConfidence * (actualRate / predictedMid)) * 0.4;
  return Math.round(Math.max(0, Math.min(100, blended)));
}

// ── 3. Market cluster tracking ────────────────────────────────────
// Cluster = market condition at time of entry
// Key = btcTrend_volatilityLevel_fearGreedZone

function buildClusterKey(signal) {
  const btcPct  = signal.btcHealth?.pct ?? 0;
  const btcTrend = btcPct >= 3 ? 'BTC_BULL' : btcPct <= -3 ? 'BTC_BEAR' : 'BTC_FLAT';

  const vol = signal.volatility ?? 2;
  const volLevel = vol >= 4 ? 'HIGH_VOL' : vol >= 1.5 ? 'MED_VOL' : 'LOW_VOL';

  const fg = signal.fearGreed?.value ?? 50;
  const fgZone = fg <= 25 ? 'FEAR' : fg >= 75 ? 'GREED' : 'NEUTRAL';

  return `${btcTrend}_${volLevel}_${fgZone}`;
}

export function updateCluster(trade) {
  const { outcome, pnlPct24h } = trade;
  if (!outcome || pnlPct24h == null) return;

  // Need signal data at entry — stored in trade log
  const clusterKey = trade.clusterKey || buildClusterKey(trade);
  if (!clusterKey) return;

  const state = loadAdaptive();
  if (!state.clusters[clusterKey]) {
    state.clusters[clusterKey] = { trades: 0, wins: 0, avgPnl: 0, totalPnl: 0 };
  }

  const c = state.clusters[clusterKey];
  c.trades++;
  if (outcome === 'WIN') c.wins++;
  c.totalPnl  = parseFloat((c.totalPnl + pnlPct24h).toFixed(2));
  c.avgPnl    = parseFloat((c.totalPnl / c.trades).toFixed(2));
  c.winRate   = parseFloat((c.wins / c.trades * 100).toFixed(1));
  c.lastSeen  = new Date().toISOString();

  saveAdaptive(state);
}

// Get cluster adjustment for current market conditions
export function getClusterAdjustment(signal) {
  const state      = loadAdaptive();
  const clusterKey = buildClusterKey(signal);
  const cluster    = state.clusters[clusterKey];

  if (!cluster || cluster.trades < 5) {
    return { factor: 1.0, clusterKey, narrative: null };
  }

  const wr = cluster.winRate;

  if (wr >= 75 && cluster.trades >= 8) {
    return {
      factor: 1.15,
      clusterKey,
      narrative: `📊 Cluster ${clusterKey}: ${wr}% WR over ${cluster.trades} trades — strong conditions (+15% boost)`,
    };
  }
  if (wr >= 60 && cluster.trades >= 6) {
    return {
      factor: 1.07,
      clusterKey,
      narrative: `📊 Cluster ${clusterKey}: ${wr}% WR — favourable conditions (+7% boost)`,
    };
  }
  if (wr <= 30 && cluster.trades >= 6) {
    return {
      factor: 0.75,
      clusterKey,
      narrative: `⚠️ Cluster ${clusterKey}: only ${wr}% WR over ${cluster.trades} trades — poor conditions (-25% size)`,
    };
  }
  if (wr <= 40 && cluster.trades >= 5) {
    return {
      factor: 0.88,
      clusterKey,
      narrative: `Cluster ${clusterKey}: ${wr}% WR — below-average conditions (-12% size)`,
    };
  }

  return { factor: 1.0, clusterKey, narrative: null };
}

// ── Full adaptive update — called after every resolved trade ──────

export function runAdaptiveUpdate(resolvedTrades) {
  if (!resolvedTrades?.length) return;
  let updated = 0;
  for (const trade of resolvedTrades) {
    if (!trade.outcome || trade.outcome === 'PENDING') continue;
    try {
      updateSignalWeights(trade);
      updateCalibration(trade);
      updateCluster(trade);
      updated++;
    } catch (e) {
      console.warn(`[Adaptive] Update failed for ${trade.asset}: ${e.message}`);
    }
  }
  if (updated > 0) {
    console.log(`[Adaptive] Updated signal weights from ${updated} resolved trades`);
  }
}

// ── Get adaptive signal weights (for confidence.js) ──────────────
// Returns per-signal multipliers to layer on top of regime weights

export function getAdaptiveSignalWeights() {
  const state = loadAdaptive();
  const weights = {};

  for (const key of SIGNAL_KEYS) {
    const data = state.signalWeights[key];
    if (!data || data.trades < 3) {
      weights[key] = 1.0; // not enough data — neutral
    } else {
      weights[key] = data.weight;
    }
  }

  return weights;
}

// ── Get adaptive state for reports/dashboard ──────────────────────

export function getAdaptiveState() {
  const state = loadAdaptive();

  const signalSummary = Object.entries(state.signalWeights)
    .map(([key, data]) => ({
      signal:    key,
      weight:    data.weight,
      trades:    data.trades,
      winRate:   data.trades > 0 ? Math.round(data.wins / data.trades * 100) : null,
      avgPnl:    data.trades > 0 ? parseFloat((data.totalPnl / data.trades).toFixed(2)) : null,
    }))
    .sort((a, b) => b.weight - a.weight);

  const calibrationSummary = Object.entries(state.calibration)
    .map(([key, data]) => ({
      bucket:    key,
      predicted: data.predicted,
      actual:    data.actual,
      trades:    data.trades,
      error:     parseFloat((data.actual - data.predicted).toFixed(1)),
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  const clusterSummary = Object.entries(state.clusters)
    .map(([key, data]) => ({ cluster: key, ...data }))
    .filter(c => c.trades >= 3)
    .sort((a, b) => b.winRate - a.winRate);

  const bestSignal  = signalSummary[0] || null;
  const worstSignal = signalSummary[signalSummary.length - 1] || null;
  const bestCluster = clusterSummary[0] || null;

  // Calibration quality — average absolute error across buckets with 5+ trades
  const calBuckets = calibrationSummary.filter(b => b.trades >= 5);
  const avgCalError = calBuckets.length
    ? calBuckets.reduce((s, b) => s + Math.abs(b.error), 0) / calBuckets.length
    : null;

  return {
    signalSummary,
    calibrationSummary,
    clusterSummary,
    bestSignal,
    worstSignal,
    bestCluster,
    avgCalibrationError: avgCalError !== null ? parseFloat(avgCalError.toFixed(1)) : null,
    isWellCalibrated: avgCalError !== null && avgCalError < 10,
    totalSignalTrades: signalSummary.reduce((s, x) => s + (x.trades || 0), 0),
  };
}

export default {
  updateSignalWeights,
  updateCalibration,
  updateCluster,
  runAdaptiveUpdate,
  getAdaptiveSignalWeights,
  getCalibratedConfidence,
  getClusterAdjustment,
  getAdaptiveState,
  buildClusterKey,
};
