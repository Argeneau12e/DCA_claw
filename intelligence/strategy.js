// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Adaptive Strategy Selection
//
//  Three strategies the agent switches between based on market
//  regime, BTC trend, and Fear & Greed index:
//
//  DIP_BUYER    — RSI-heavy, buys oversold dips (current default)
//  MOMENTUM_RIDER — buys breakouts, strength-following
//  ACCUMULATOR  — steady DCA regardless of signals (sideways/neutral)
//
//  Strategy affects: signal weights, threshold levels, buy sizing
// ─────────────────────────────────────────────────────────────────

// ── Strategy definitions ──────────────────────────────────────────

export const STRATEGIES = {
  DIP_BUYER: {
    name: 'DIP_BUYER',
    emoji: '🎣',
    description: 'Buys oversold dips. Favours RSI extremes and price drops.',
    signalWeights: {
      rsi1h: 1.4,      // RSI is king for dip buying
      rsi4h: 1.3,
      priceAction: 1.3,
      volume: 1.0,
      orderBook: 1.1,
      funding: 1.0,
      volatility: 0.8,  // less worried about volatility
      btcCorr: 1.2,
      memory: 1.0,
      sentiment: 1.2,   // fear is good for dip buying
      smartMoney: 1.0,
    },
    thresholdModifier: -3, // slightly lower bar (we want dips)
    sizeModifier: 1.0,
    activeRegimes: ['OVERSOLD', 'CAPITULATION', 'CRASH', 'DIP'],
  },

  MOMENTUM_RIDER: {
    name: 'MOMENTUM_RIDER',
    emoji: '🚀',
    description: 'Buys momentum and breakouts. Follows smart money and strength.',
    signalWeights: {
      rsi1h: 0.6,       // RSI less important — we WANT higher RSI for momentum
      rsi4h: 0.7,
      priceAction: 0.7, // drops are bad in momentum strategy
      volume: 1.5,      // volume breakout is key
      orderBook: 1.3,   // buy pressure matters
      funding: 0.8,
      volatility: 0.6,
      btcCorr: 1.4,     // BTC momentum = altcoin momentum
      memory: 1.0,
      sentiment: 0.8,
      smartMoney: 1.8,  // smart money following is critical
    },
    thresholdModifier: +8, // higher bar — momentum false signals are expensive
    sizeModifier: 0.85,    // slightly smaller size (breakouts can reverse)
    activeRegimes: ['NEUTRAL', 'DIP', 'HIGH_VOLATILITY'],
  },

  ACCUMULATOR: {
    name: 'ACCUMULATOR',
    emoji: '🏦',
    description: 'Steady accumulation regardless of short-term signals. Long-term DCA.',
    signalWeights: {
      rsi1h: 0.8,
      rsi4h: 1.0,
      priceAction: 1.0,
      volume: 0.8,
      orderBook: 0.8,
      funding: 0.6,     // funding less relevant for long-term accumulation
      volatility: 1.2,  // want stable entries
      btcCorr: 0.8,
      memory: 1.0,
      sentiment: 1.0,
      smartMoney: 0.9,
    },
    thresholdModifier: -8, // much lower bar — we want to buy regularly
    sizeModifier: 0.7,     // smaller size per trade (more frequent)
    activeRegimes: ['NEUTRAL', 'DIP', 'OVERSOLD', 'CAPITULATION'],
  },
};

// ── Strategy selection logic ──────────────────────────────────────

export function selectStrategy(regime, fearGreedValue, btcTrend, rlWinRate) {
  // Override to ACCUMULATOR if market is very sideways/neutral with low volatility
  if (regime === 'NEUTRAL' && fearGreedValue >= 40 && fearGreedValue <= 60) {
    return { strategy: STRATEGIES.ACCUMULATOR, reason: 'Neutral market — steady accumulation mode' };
  }

  // CAPITULATION or OVERSOLD → DIP_BUYER aggressively
  if (['CAPITULATION', 'OVERSOLD'].includes(regime)) {
    return { strategy: STRATEGIES.DIP_BUYER, reason: `${regime} detected — dip buying mode activated` };
  }

  // Strong uptrend with smart money following → MOMENTUM_RIDER
  if (['PUMP'].includes(regime) || (btcTrend === 'UP' && fearGreedValue > 60)) {
    return { strategy: STRATEGIES.MOMENTUM_RIDER, reason: 'Uptrend with positive sentiment — momentum mode' };
  }

  // High volatility → MOMENTUM_RIDER (be selective, higher bar)
  if (regime === 'HIGH_VOLATILITY') {
    return { strategy: STRATEGIES.MOMENTUM_RIDER, reason: 'High volatility — momentum mode for selective entries' };
  }

  // CRASH → DIP_BUYER but with BTC correlation safety
  if (regime === 'CRASH') {
    return { strategy: STRATEGIES.DIP_BUYER, reason: 'Crash regime — opportunistic dip buying with BTC safety filter' };
  }

  // If RL win rate is poor across the board → ACCUMULATOR (safe default)
  if (rlWinRate !== null && rlWinRate < 35) {
    return { strategy: STRATEGIES.ACCUMULATOR, reason: `Low recent win rate (${rlWinRate}%) — switching to conservative accumulation` };
  }

  // Default: DIP_BUYER (original strategy)
  return { strategy: STRATEGIES.DIP_BUYER, reason: 'Default DCA dip-buying strategy' };
}

// ── Apply strategy weights to a raw signal score ─────────────────

export function applyStrategyWeights(rawSignals, strategy) {
  const w = strategy.signalWeights;
  const weighted = {
    rsi1h:       (rawSignals.rsi1h || 0)       * w.rsi1h,
    rsi4h:       (rawSignals.rsi4h || 0)       * w.rsi4h,
    priceAction: (rawSignals.priceAction || 0) * w.priceAction,
    volume:      (rawSignals.volume || 0)      * w.volume,
    orderBook:   (rawSignals.orderBook || 0)   * w.orderBook,
    funding:     (rawSignals.funding || 0)     * w.funding,
    volatility:  (rawSignals.volatility || 0)  * w.volatility,
    btcCorr:     (rawSignals.btcCorr || 0)     * w.btcCorr,
    memory:      (rawSignals.memory || 0)      * w.memory,
    sentiment:   (rawSignals.sentiment || 0)   * w.sentiment,
    smartMoney:  (rawSignals.smartMoney || 0)  * w.smartMoney,
  };
  return weighted;
}

// ── Get current strategy label (for dashboard/Telegram) ──────────

export function strategyStatus(strategy) {
  return `${strategy.emoji} ${strategy.name} — ${strategy.description}`;
}

export default { STRATEGIES, selectStrategy, applyStrategyWeights, strategyStatus };
