// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — ML Probability Engine
//
//  Converts raw signal scores into a calibrated P(win) probability.
//
//  How it works:
//    1. After every resolved trade, records which "signal profile"
//       was active (bucketised signal scores) and the outcome.
//    2. For a new trade, finds the closest matching historical
//       profiles using cosine similarity on the signal vector.
//    3. Computes P(win) = weighted win rate of k nearest neighbours.
//    4. Blends with base confidence score until enough data exists.
//
//  Falls back to (confidence / 100) until 20+ resolved trades.
//  After 50+ trades, ML probability fully overrides confidence.
//  Between 20-50: blended linearly.
//
//  Signal vector (16 dimensions):
//    rsi1h, rsi4h, priceAction, volume, orderBook, funding,
//    volatility, btcCorr, memory, sentiment, smartMoney,
//    correlation, session, news, whale, mtf
//
//  Stored in: logs/ml_model.json
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = join(__dirname, '../logs');
const MODEL_FILE = join(LOGS_DIR, 'ml_model.json');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// Signal keys — order matters (defines vector dimensions)
const SIGNAL_KEYS = [
  'rsi1h', 'rsi4h', 'priceAction', 'volume', 'orderBook',
  'funding', 'volatility', 'btcCorr', 'memory', 'sentiment',
  'smartMoney', 'correlation', 'session', 'news', 'whale', 'mtf',
];

const K_NEIGHBOURS  = 7;   // k-NN: look at 7 closest past trades
const MIN_TRADES_ML = 20;  // minimum trades before ML kicks in
const FULL_ML_TRADES = 50; // trades needed for full ML override

// ── Load / save model ─────────────────────────────────────────────

function loadModel() {
  try {
    if (existsSync(MODEL_FILE)) return JSON.parse(readFileSync(MODEL_FILE, 'utf8'));
  } catch {}
  return { observations: [], metadata: { totalTrades: 0, wins: 0, lastUpdated: null } };
}

function saveModel(model) {
  model.metadata.lastUpdated = new Date().toISOString();
  writeFileSync(MODEL_FILE, JSON.stringify(model, null, 2));
}

// ── Signal vector extraction ──────────────────────────────────────

function extractVector(rawSignals) {
  return SIGNAL_KEYS.map(k => {
    const v = rawSignals?.[k] ?? 0;
    // Normalise to [-1, +1] range (signals typically range -15 to +15)
    return Math.max(-1, Math.min(1, v / 15));
  });
}

// ── Cosine similarity between two vectors ─────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── Record a resolved trade ───────────────────────────────────────

export function recordTradeOutcome(trade) {
  const { outcome, rawSignals, confidence, regime, dominantRegime, asset } = trade;
  if (!outcome || !rawSignals) return;

  const model = loadModel();
  const vector = extractVector(rawSignals);

  model.observations.push({
    vector,
    outcome: outcome === 'WIN' ? 1 : 0,
    confidence: confidence ?? 50,
    regime: dominantRegime || regime || 'NEUTRAL',
    asset,
    timestamp: trade.timestamp || new Date().toISOString(),
    pnlPct: trade.pnlPct24h ?? 0,
  });

  model.metadata.totalTrades++;
  if (outcome === 'WIN') model.metadata.wins++;

  // Keep last 500 observations (memory-efficient)
  if (model.observations.length > 500) {
    model.observations = model.observations.slice(-500);
  }

  saveModel(model);
}

// ── Predict P(win) for a new signal ──────────────────────────────

export function predictWinProbability(signal) {
  const model    = loadModel();
  const total    = model.metadata.totalTrades || 0;
  const baseProb = (signal.confidence ?? 50) / 100;

  // Not enough data — return confidence-based estimate
  if (total < MIN_TRADES_ML) {
    return {
      probability:      parseFloat(baseProb.toFixed(3)),
      mlProbability:    null,
      blendRatio:       0,
      kNeighbours:      0,
      totalObservations: total,
      source:           'confidence_fallback',
      narrative:        `P(win) from confidence score (need ${MIN_TRADES_ML - total} more resolved trades for ML)`,
    };
  }

  const queryVector = extractVector(signal.rawSignals || {});

  // Find k nearest neighbours by cosine similarity
  const similarities = model.observations.map((obs, idx) => ({
    idx,
    sim: cosineSimilarity(queryVector, obs.vector),
    obs,
  })).sort((a, b) => b.sim - a.sim).slice(0, K_NEIGHBOURS);

  if (!similarities.length) {
    return {
      probability:      parseFloat(baseProb.toFixed(3)),
      mlProbability:    null,
      blendRatio:       0,
      kNeighbours:      0,
      totalObservations: total,
      source:           'confidence_fallback',
      narrative:        'No similar past trades found — using confidence',
    };
  }

  // Weighted win rate: closer neighbours get more weight
  // Weight = similarity² (emphasise very close matches)
  let weightedWins = 0, totalWeight = 0;
  for (const { sim, obs } of similarities) {
    const w = Math.max(0, sim) ** 2;
    weightedWins += obs.outcome * w;
    totalWeight  += w;
  }

  const mlProb = totalWeight > 0 ? weightedWins / totalWeight : baseProb;

  // Blend ratio: 0 at MIN_TRADES_ML, 1.0 at FULL_ML_TRADES
  const blendRatio = Math.min(1, (total - MIN_TRADES_ML) / (FULL_ML_TRADES - MIN_TRADES_ML));
  const finalProb  = mlProb * blendRatio + baseProb * (1 - blendRatio);

  // Nearest regime context for narrative
  const topMatch = similarities[0];
  const avgSim   = similarities.reduce((s, x) => s + x.sim, 0) / similarities.length;

  return {
    probability:      parseFloat(finalProb.toFixed(3)),
    mlProbability:    parseFloat(mlProb.toFixed(3)),
    blendRatio:       parseFloat(blendRatio.toFixed(2)),
    kNeighbours:      similarities.length,
    avgSimilarity:    parseFloat(avgSim.toFixed(3)),
    totalObservations: total,
    nearestRegime:    topMatch.obs.regime,
    source:           blendRatio >= 1 ? 'ml_full' : 'ml_blended',
    narrative:        `P(win) ${(finalProb * 100).toFixed(0)}% — ML: ${(mlProb * 100).toFixed(0)}% from ${similarities.length} similar past trades (avg match ${(avgSim * 100).toFixed(0)}%) · blend ${(blendRatio * 100).toFixed(0)}% ML`,
  };
}

// ── Batch record (called from processTradeRewards) ────────────────

export function recordTradesBatch(resolvedTrades) {
  if (!resolvedTrades?.length) return;
  let recorded = 0;
  for (const trade of resolvedTrades) {
    if (!trade.outcome || trade.outcome === 'PENDING') continue;
    try {
      recordTradeOutcome(trade);
      recorded++;
    } catch (e) {
      console.warn(`[ML] Failed to record trade ${trade.asset}: ${e.message}`);
    }
  }
  if (recorded > 0) {
    const model = loadModel();
    console.log(`[ML] Recorded ${recorded} trades — model has ${model.metadata.totalTrades} total observations`);
  }
}

// ── Get model stats for dashboard/reports ────────────────────────

export function getMLState() {
  const model = loadModel();
  const total = model.metadata.totalTrades || 0;
  const wins  = model.metadata.wins || 0;

  // Win rate by regime
  const byRegime = {};
  for (const obs of model.observations) {
    if (!byRegime[obs.regime]) byRegime[obs.regime] = { wins: 0, total: 0 };
    byRegime[obs.regime].total++;
    if (obs.outcome) byRegime[obs.regime].wins++;
  }

  const regimeStats = Object.entries(byRegime)
    .map(([regime, d]) => ({
      regime,
      winRate:  Math.round(d.wins / d.total * 100),
      trades:   d.total,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  // Average P(win) for winning vs losing trades (calibration check)
  const recentObs = model.observations.slice(-50);
  const avgConfWins  = recentObs.filter(o => o.outcome).map(o => o.confidence);
  const avgConfLoss  = recentObs.filter(o => !o.outcome).map(o => o.confidence);
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    totalObservations: total,
    overallWinRate:    total > 0 ? Math.round(wins / total * 100) : null,
    isMLActive:        total >= MIN_TRADES_ML,
    mlBlendRatio:      total >= FULL_ML_TRADES ? 1.0 : total >= MIN_TRADES_ML ? (total - MIN_TRADES_ML) / (FULL_ML_TRADES - MIN_TRADES_ML) : 0,
    regimeStats,
    avgConfWinningTrades: mean(avgConfWins) ? parseFloat(mean(avgConfWins).toFixed(1)) : null,
    avgConfLosingTrades:  mean(avgConfLoss) ? parseFloat(mean(avgConfLoss).toFixed(1)) : null,
    lastUpdated: model.metadata.lastUpdated,
  };
}

export default { predictWinProbability, recordTradesBatch, recordTradeOutcome, getMLState };
