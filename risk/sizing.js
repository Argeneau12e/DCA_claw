// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Risk Sizing Engine
//
//  Replaces the flat calcBuyAmount() in index.js.
//
//  Formula:
//    base = CONFIG.baseDCAAmount
//    atrSize = (account_risk_pct × account_size) / ATR_pct
//    kellyFraction = (winRate × avgWin - lossRate × avgLoss) / avgWin
//    finalSize = blend(atrSize, base, kellyFraction) × confidenceScale
//    cap = min(finalSize, base × 1.5)   ← soft cap, always enforced
//
//  All trade notifications show the sizing formula used.
// ─────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR  = join(__dirname, '../logs');

// ── Load trade history for Kelly calculation ──────────────────────

function loadResolvedTrades() {
  try {
    const raw = JSON.parse(readFileSync(join(LOGS_DIR, 'shadow_trades.json'), 'utf8'));
    return (raw.trades || raw || []).filter(t => t.outcome && t.pnlPct24h != null);
  } catch { return []; }
}

// ── Kelly Criterion ───────────────────────────────────────────────
// f = (p × b - q) / b
// where p = win rate, q = loss rate, b = avg win / avg loss

function calcKellyFraction(trades, window = 30) {
  const recent = trades.slice(-window);
  if (recent.length < 8) return 0.25; // not enough data — conservative default

  const wins   = recent.filter(t => t.outcome === 'WIN');
  const losses = recent.filter(t => t.outcome === 'LOSS');

  if (!wins.length || !losses.length) return wins.length > losses.length ? 0.35 : 0.15;

  const p    = wins.length / recent.length;
  const q    = 1 - p;
  const avgW = wins.reduce((s, t) => s + Math.abs(t.pnlPct24h), 0) / wins.length;
  const avgL = losses.reduce((s, t) => s + Math.abs(t.pnlPct24h), 0) / losses.length;

  if (avgL === 0) return 0.35;
  const b      = avgW / avgL;
  const kelly  = (p * b - q) / b;

  // Half-Kelly for safety (full Kelly is too aggressive)
  return Math.max(0.1, Math.min(0.5, kelly * 0.5));
}

// ── ATR-based position sizing ─────────────────────────────────────
// size = (account × risk_pct) / atr_pct
// risk_pct = how much of account to risk per trade (1-2%)

function calcATRSize(atrPct, accountSize, riskProfile) {
  if (!atrPct || atrPct <= 0) return null;

  const riskPct = {
    conservative: 0.008, // 0.8% account risk per trade
    balanced:     0.012, // 1.2%
    degen:        0.020, // 2.0%
  }[riskProfile] || 0.012;

  // Size = (account × risk) / ATR
  // ATR represents the "natural move" — we size so one ATR move = our risk budget
  const rawSize = (accountSize * riskPct) / (atrPct / 100);
  return rawSize;
}

// ── Confidence scaling (0.5x – 1.5x) ────────────────────────────
// Higher confidence = larger size, but bounded

function confidenceScale(confidence, threshold) {
  if (confidence <= threshold) return 0.5; // below threshold shouldn't be called
  const excess = confidence - threshold;   // how far above threshold
  // +1pt above threshold = +1% size, capped at +50%
  return Math.min(1.5, 1.0 + (excess / 100));
}

// ── Drawdown memory adjustment ────────────────────────────────────
// If we're already underwater on this asset, adjust sizing

function drawdownAdjustment(asset, currentPrice, resolvedTrades) {
  // Find most recent buy of this asset that's unresolved (or recently resolved at a loss)
  const assetTrades = resolvedTrades
    .filter(t => t.asset === asset)
    .slice(-5);

  if (!assetTrades.length) return { factor: 1.0, note: null };

  // Check if last trade was a loss
  const lastTrade = assetTrades[assetTrades.length - 1];
  if (!lastTrade.priceAtDecision || !currentPrice) return { factor: 1.0, note: null };

  const drawdown = (currentPrice - lastTrade.priceAtDecision) / lastTrade.priceAtDecision * 100;

  // If current price is well below last entry — this is DCA opportunity (reduce slightly, cautious)
  if (drawdown <= -15) {
    return {
      factor: 0.75,
      note: `Drawdown ${drawdown.toFixed(1)}% from last entry — cautious DCA sizing (0.75x)`,
    };
  }
  if (drawdown <= -8) {
    return {
      factor: 0.9,
      note: `Down ${drawdown.toFixed(1)}% from last entry — mild drawdown adjustment (0.9x)`,
    };
  }
  // If current price is ABOVE last entry — this is chasing, reduce
  if (drawdown >= 10) {
    return {
      factor: 0.6,
      note: `Price ${drawdown.toFixed(1)}% ABOVE last entry — chasing warning (0.6x size)`,
    };
  }
  if (drawdown >= 5) {
    return {
      factor: 0.8,
      note: `Price ${drawdown.toFixed(1)}% above last entry — slight caution (0.8x size)`,
    };
  }

  return { factor: 1.0, note: null };
}

// ── Cost basis adjustment ─────────────────────────────────────────
// Would this buy LOWER or RAISE our average cost?
// Lowering average = bonus. Raising average = penalty.

function costBasisAdjustment(asset, currentPrice, resolvedTrades) {
  const assetBuys = resolvedTrades.filter(t =>
    t.asset === asset && t.priceAtDecision && (t.action === 'BUY' || t.wouldBuy)
  ).slice(-10);

  if (assetBuys.length < 2) return { factor: 1.0, note: null, wouldLowerAvg: null };

  const totalSpent = assetBuys.reduce((s, t) => s + (t.wouldSpendUSDT || 0), 0);
  const totalUnits = assetBuys.reduce((s, t) => s + (t.wouldSpendUSDT || 0) / t.priceAtDecision, 0);
  const avgCost    = totalUnits > 0 ? totalSpent / totalUnits : currentPrice;

  const wouldLowerAvg = currentPrice < avgCost;
  const pctFromAvg    = (currentPrice - avgCost) / avgCost * 100;

  if (wouldLowerAvg && pctFromAvg <= -5) {
    return {
      factor: 1.15,
      note: `${Math.abs(pctFromAvg).toFixed(1)}% below avg cost $${avgCost.toFixed(4)} — lowers avg (+15% size)`,
      wouldLowerAvg: true,
      avgCost,
    };
  }
  if (wouldLowerAvg) {
    return {
      factor: 1.05,
      note: `Buying below avg cost $${avgCost.toFixed(4)} — slight DCA bonus (+5% size)`,
      wouldLowerAvg: true,
      avgCost,
    };
  }
  if (pctFromAvg >= 15) {
    return {
      factor: 0.65,
      note: `${pctFromAvg.toFixed(1)}% ABOVE avg cost — raising avg, reduce size (-35%)`,
      wouldLowerAvg: false,
      avgCost,
    };
  }
  if (pctFromAvg >= 8) {
    return {
      factor: 0.80,
      note: `${pctFromAvg.toFixed(1)}% above avg cost — reducing size (-20%)`,
      wouldLowerAvg: false,
      avgCost,
    };
  }

  return { factor: 1.0, note: null, wouldLowerAvg: null, avgCost };
}

// ── Main sizing function ──────────────────────────────────────────

export function calcPositionSize(signal, config, accountSize = 10000) {
  const {
    asset, confidence, effectiveThreshold, volatility,
    currentPrice, riskProfile: signalRisk,
  } = signal;

  const base        = config.baseDCAAmount;
  const riskProfile = config.riskProfile || 'balanced';
  const resolvedTrades = loadResolvedTrades();

  // ── Kelly Criterion ─────────────────────────────────────
  const kellyFraction = calcKellyFraction(resolvedTrades);
  const kellySize     = base * kellyFraction / 0.25; // normalise: kelly 0.25 = base

  // ── ATR-based sizing ────────────────────────────────────
  const atrPct   = volatility || 2.0; // use signal volatility (% of price)
  const atrSize  = calcATRSize(atrPct, accountSize, riskProfile);

  // ── Blend: weight ATR 40%, Kelly 30%, base 30% ──────────
  const blended = atrSize
    ? (atrSize * 0.40 + kellySize * 0.30 + base * 0.30)
    : (kellySize * 0.45 + base * 0.55);

  // ── Confidence scale ────────────────────────────────────
  const confFactor = confidenceScale(confidence, effectiveThreshold);

  // ── Risk profile multiplier ─────────────────────────────
  const riskMult = { conservative: 0.65, balanced: 1.0, degen: 1.5 }[riskProfile] || 1.0;

  let size = blended * confFactor * riskMult;

  // ── Cost basis adjustment ───────────────────────────────
  const costAdj = costBasisAdjustment(asset, currentPrice, resolvedTrades);
  if (costAdj.factor !== 1.0) size *= costAdj.factor;

  // ── Drawdown memory adjustment ──────────────────────────
  const ddAdj = drawdownAdjustment(asset, currentPrice, resolvedTrades);
  if (ddAdj.factor !== 1.0) size *= ddAdj.factor;

  // ── Soft cap: never more than 1.5x base ────────────────
  const softCap = base * 1.5;
  const capped  = Math.min(size, softCap);

  // ── Minimum: never less than 60% of base ───────────────
  const finalSize = Math.max(base * 0.6, Math.round(capped / 0.5) * 0.5); // round to $0.50

  // Build formula string for Telegram notification
  const formulaStr = [
    `Base: $${base}`,
    `ATR: ${atrPct.toFixed(1)}% → size $${atrSize ? atrSize.toFixed(0) : 'N/A'}`,
    `Kelly: ${(kellyFraction * 100).toFixed(0)}% → $${kellySize.toFixed(0)}`,
    `Blended: $${blended.toFixed(0)}`,
    `Confidence: ${confidence}% (${confFactor.toFixed(2)}x)`,
    `Risk: ${riskProfile} (${riskMult}x)`,
    costAdj.note ? `Cost basis: ${costAdj.note}` : null,
    ddAdj.note   ? `Drawdown: ${ddAdj.note}` : null,
    capped < size ? `Cap applied: $${size.toFixed(0)} → $${capped.toFixed(0)}` : null,
    `Final: $${finalSize.toFixed(2)}`,
  ].filter(Boolean).join(' | ');

  return {
    size:    finalSize,
    formula: formulaStr,
    breakdown: {
      base, kellyFraction, kellySize,
      atrPct, atrSize,
      blended, confFactor, riskMult,
      costBasisFactor: costAdj.factor,
      costBasisNote:   costAdj.note,
      wouldLowerAvg:   costAdj.wouldLowerAvg,
      avgCost:         costAdj.avgCost,
      drawdownFactor:  ddAdj.factor,
      drawdownNote:    ddAdj.note,
      cappedAt:        softCap,
      final:           finalSize,
    },
  };
}

export default { calcPositionSize };
