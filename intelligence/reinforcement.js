// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3.2 — Reinforcement Learning (Phase 4 upgrade)
//
//  Upgrades from Phase 4:
//   ✅ Signal-level weight updates (via adaptive.js)
//   ✅ Confidence calibration layer applied before threshold check
//   ✅ Cluster-based performance tracking
//   ✅ Combined RL state report (pattern + signal + cluster)
//
//  Pattern-level RL (regime_RSIzone) unchanged — still EMA.
//  Signal-level RL is a NEW layer on top, not a replacement.
//
//  Application order in confidence.js:
//    rawScore → regimeWeights → adaptiveSignalWeights → RL pattern → calibration
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runAdaptiveUpdate, getAdaptiveSignalWeights,
  getCalibratedConfidence, getClusterAdjustment,
  getAdaptiveState, updateCluster,
} from './adaptive.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = join(__dirname, '../logs/memory.json');
const ALPHA       = 0.1;
const MAX_WEIGHT  = 2.0;
const MIN_WEIGHT  = 0.1;

// ── Load/save pattern-level RL weights ───────────────────────────

function loadWeights() {
  try {
    if (existsSync(MEMORY_FILE)) {
      const m = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
      return m.rlWeights || {};
    }
  } catch {}
  return {};
}

function saveWeights(weights) {
  try {
    let memory = {};
    if (existsSync(MEMORY_FILE)) {
      memory = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
    }
    memory.rlWeights = weights;
    writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) {
    console.error('[RL] Failed to save weights:', e.message);
  }
}

// ── Reward function ───────────────────────────────────────────────

function computeReward(pnlPct, outcome) {
  if (outcome === 'WIN') {
    if (pnlPct >= 10) return 1.0;
    if (pnlPct >= 5)  return 0.8;
    if (pnlPct >= 2)  return 0.6;
    return 0.4;
  }
  if (outcome === 'LOSS') {
    if (pnlPct <= -10) return -1.0;
    if (pnlPct <= -5)  return -0.8;
    if (pnlPct <= -2)  return -0.6;
    return -0.4;
  }
  return 0;
}

// ── Pattern key builder ───────────────────────────────────────────

export function buildPatternKey(regime, rsi, btcRegime) {
  const rsiZone = rsi <= 20 ? 'EXTREME' : rsi <= 30 ? 'DEEP' : rsi <= 40 ? 'OVERSOLD' : rsi <= 50 ? 'NEUTRAL' : 'HIGH';
  const btcCtx  = btcRegime && btcRegime !== 'NEUTRAL' ? `_BTC${btcRegime}` : '';
  return `${regime}_RSI${rsiZone}${btcCtx}`;
}

// ── Update pattern-level weight + trigger signal-level update ─────

export function updateWeight(patternKey, pnlPct, outcome, tradeData = null) {
  // 1. Pattern-level EMA update (unchanged from v3.1)
  const weights       = loadWeights();
  const currentWeight = weights[patternKey]?.weight ?? 1.0;
  const reward        = computeReward(pnlPct, outcome);
  const targetWeight  = 1.0 + reward;
  const newWeight     = ALPHA * targetWeight + (1 - ALPHA) * currentWeight;
  const clamped       = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, newWeight));

  if (!weights[patternKey]) {
    weights[patternKey] = { weight: 1.0, trades: 0, wins: 0, totalPnl: 0 };
  }

  weights[patternKey].weight      = parseFloat(clamped.toFixed(4));
  weights[patternKey].trades      = (weights[patternKey].trades || 0) + 1;
  weights[patternKey].wins        = (weights[patternKey].wins || 0) + (outcome === 'WIN' ? 1 : 0);
  weights[patternKey].totalPnl    = parseFloat(((weights[patternKey].totalPnl || 0) + (pnlPct || 0)).toFixed(2));
  weights[patternKey].lastUpdated = new Date().toISOString();

  saveWeights(weights);

  // 2. Signal-level update (new in Phase 4)
  if (tradeData) {
    try {
      runAdaptiveUpdate([{ ...tradeData, outcome, pnlPct24h: pnlPct }]);
    } catch (e) {
      console.warn('[RL] Signal-level update failed:', e.message);
    }
  }

  return clamped;
}

// ── Get pattern weight ────────────────────────────────────────────

export function getPatternWeight(patternKey) {
  const weights = loadWeights();
  return weights[patternKey]?.weight ?? 1.0;
}

// ── Apply RL weight + adaptive signal weights + calibration ───────
// This is the main function called by confidence.js

export function applyRLWeight(confidence, patternKey) {
  // Layer 1: Pattern-level RL weight
  const patternWeight = getPatternWeight(patternKey);
  let adjusted = confidence * patternWeight;

  return {
    adjusted:      Math.round(Math.min(100, Math.max(0, adjusted))),
    weight:        patternWeight,
    patternKey,
    boost: patternWeight > 1.05
      ? `RL boost ×${patternWeight.toFixed(2)}`
      : patternWeight < 0.95
        ? `RL penalty ×${patternWeight.toFixed(2)}`
        : null,
  };
}

// Apply calibration to final confidence score
// Called as the LAST step before threshold comparison
export function applyCalibratedConfidence(rawConfidence) {
  return getCalibratedConfidence(rawConfidence);
}

// Get adaptive signal weights for layering in confidence.js
export function getAdaptiveWeights() {
  return getAdaptiveSignalWeights();
}

// Get cluster adjustment for current signal
export function getClusterBoost(signal) {
  return getClusterAdjustment(signal);
}

// ── Full RL update for a batch of resolved trades ─────────────────
// Called from index.js processTradeRewards()

export function processTradeRewardsBatch(resolvedTrades) {
  if (!resolvedTrades?.length) return;

  for (const trade of resolvedTrades) {
    if (!trade.outcome || !trade.patternKey) continue;
    try {
      const rlKey = buildPatternKey(
        trade.regime || trade.dominantRegime || 'NEUTRAL',
        trade.rsi || 50,
        'NEUTRAL'
      );
      // Pass full trade data for signal-level learning
      updateWeight(rlKey, trade.pnlPct24h || 0, trade.outcome, trade);
    } catch (e) {
      console.warn(`[RL] Batch update failed for ${trade.asset}: ${e.message}`);
    }
  }
}

// ── Get full combined RL state for reports ────────────────────────

export function getRLState() {
  const weights  = loadWeights();
  const patterns = Object.entries(weights)
    .map(([key, data]) => ({
      pattern:     key,
      weight:      data.weight,
      trades:      data.trades || 0,
      winRate:     data.trades > 0 ? Math.round((data.wins || 0) / data.trades * 100) : null,
      avgPnl:      data.trades > 0 ? parseFloat(((data.totalPnl || 0) / data.trades).toFixed(2)) : null,
      lastUpdated: data.lastUpdated,
    }))
    .sort((a, b) => b.weight - a.weight);

  const adaptive = getAdaptiveState();

  return {
    // Pattern level
    totalPatterns: patterns.length,
    bestPattern:   patterns[0] || null,
    worstPattern:  patterns[patterns.length - 1] || null,
    patterns,
    // Signal level (Phase 4)
    signalWeights:         adaptive.signalSummary,
    bestSignal:            adaptive.bestSignal,
    worstSignal:           adaptive.worstSignal,
    // Calibration (Phase 4)
    calibration:           adaptive.calibrationSummary,
    avgCalibrationError:   adaptive.avgCalibrationError,
    isWellCalibrated:      adaptive.isWellCalibrated,
    // Clusters (Phase 4)
    clusters:              adaptive.clusterSummary,
    bestCluster:           adaptive.bestCluster,
  };
}

export default {
  buildPatternKey, updateWeight, getPatternWeight,
  applyRLWeight, applyCalibratedConfidence,
  getAdaptiveWeights, getClusterBoost,
  processTradeRewardsBatch, getRLState,
};
