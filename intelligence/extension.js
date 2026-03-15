// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Dynamic PnL Extension Engine
//
//  When a trade's 24h PnL lands in a "near-zero" band, this engine
//  decides whether to extend the resolution window — and for how long.
//
//  Extension logic is fully per-trade, driven by conditions at entry:
//
//  BAND WIDTH (what counts as "near-zero"):
//    Base: ±1%
//    + Volatility scaling: high ATR assets need wider bands
//      (a ±1% move on ZK is noise; on BTC it's meaningful)
//    + Regime adjustment: RANGING/COMPRESSED → wider (slow markets)
//      TRENDING/HIGH_VOLATILITY → tighter (fast markets)
//    + Confidence scaling: high-confidence trades get more patience
//
//  EXTENSION DURATION (extra hours before re-check):
//    Base: 24h
//    + Session cycle: if entered during Asia, hasn't seen full
//      London + NY session → extend to complete the cycle
//    + News score: negative news = more headwind = more time needed
//    + Funding rate: positive funding fighting oversold = more time
//    + Volume: low-volume entry = market hasn't digested yet
//    Hard cap: max 72h total from entry (prevents infinite deferral)
//
//  Returns: { shouldExtend, extensionHours, extensionBand, reason }
// ─────────────────────────────────────────────────────────────────

// ── Session cycle hours (when does each session open in UTC) ─────
const SESSION_OPENS_UTC = {
  ASIA:   0,  // 00:00 UTC
  LONDON: 8,  // 08:00 UTC
  NY:     13, // 13:00 UTC
};

// ── Compute dynamic extension for a single trade ─────────────────

export function computeExtension(trade, currentPnlPct) {
  const {
    volatility,           // ATR as % (e.g. 3.5 means 3.5% daily range)
    regime,
    dominantRegime,
    confidence,
    effectiveThreshold,
    sessionContext,       // { session: 'ASIA' | 'LONDON' | 'NY', ... }
    newsScore,            // -15 to +8
    fundingRate,          // raw funding rate decimal
    timestamp,            // trade entry time
    rsi,
  } = trade;

  const mktRegime = dominantRegime || regime || 'NEUTRAL';
  const pnl = Math.abs(currentPnlPct);
  const isNegative = currentPnlPct < 0;

  // ── 1. Compute band width ─────────────────────────────────────

  let band = 1.0; // base ±1%

  // Volatility scaling: scale band by (atr / 2) capped at 3x
  const atr = parseFloat(volatility) || 2.0;
  const atrFactor = Math.min(3.0, Math.max(0.5, atr / 2.0));
  band *= atrFactor;

  // Regime adjustment
  const regimeFactors = {
    RANGING:        1.4,  // slow market — wider band
    COMPRESSED:     1.5,  // very slow — widest
    NEUTRAL:        1.0,
    OVERSOLD:       0.9,  // should have bounced — tighter
    DIP:            1.0,
    TRENDING:       0.7,  // fast market — tighter (should have moved)
    HIGH_VOLATILITY: 0.6, // very fast — tightest
    CAPITULATION:   1.2,  // chaotic — bit wider
  };
  band *= (regimeFactors[mktRegime] || 1.0);

  // Confidence scaling: high confidence = more patience = wider band
  const confNorm = Math.max(0, Math.min(100, confidence || 50)) / 100;
  band *= (0.7 + confNorm * 0.6); // 0.7 at 0% conf, 1.3 at 100% conf

  // Cap band: min 0.3%, max 4.0%
  band = Math.max(0.3, Math.min(4.0, parseFloat(band.toFixed(2))));

  // ── 2. Should we extend? ──────────────────────────────────────

  // Only extend if |pnl| is within band
  if (pnl > band) {
    return {
      shouldExtend:   false,
      extensionHours: 0,
      extensionBand:  band,
      reason:         `PnL ${currentPnlPct.toFixed(2)}% outside band ±${band.toFixed(2)}% — resolving now`,
    };
  }

  // ── 3. Compute extension duration ────────────────────────────

  let hours = 24; // base extension
  const reasons = [];

  // Session cycle analysis: how many major sessions remain?
  const entryHour = new Date(timestamp).getUTCHours();
  const nowHour   = new Date().getUTCHours();
  const tradedHours = (new Date() - new Date(timestamp)) / 3600000;

  // Check which sessions the trade has missed
  const sessionsRemaining = [];
  if (entryHour >= SESSION_OPENS_UTC.NY || (entryHour < SESSION_OPENS_UTC.ASIA)) {
    // Entered late NY or overnight — hasn't seen full Asia + London + NY cycle
    sessionsRemaining.push('ASIA', 'LONDON');
  } else if (entryHour >= SESSION_OPENS_UTC.LONDON) {
    // Entered during London — might need to see NY
    sessionsRemaining.push('NY');
  }

  if (sessionsRemaining.length > 0) {
    hours += sessionsRemaining.length * 8; // 8h per session
    reasons.push(`${sessionsRemaining.join('+')} session(s) not yet active`);
  }

  // News headwind: negative news = more time to overcome
  const news = parseFloat(newsScore) || 0;
  if (news < -8 && isNegative) {
    hours += 16;
    reasons.push('strong news headwind');
  } else if (news < -4 && isNegative) {
    hours += 8;
    reasons.push('mild news headwind');
  }

  // Funding rate: positive funding = longs paying = headwind for oversold bounce
  const funding = parseFloat(fundingRate) || 0;
  if (funding > 0.001 && rsi < 40) {
    hours += 8;
    reasons.push('positive funding fighting oversold RSI');
  }

  // Confidence: very high confidence buys deserve more time
  if (confidence >= 80) {
    hours += 8;
    reasons.push('high confidence trade');
  }

  // Negative with mild headwind: give extra time
  if (isNegative && pnl < band * 0.5) {
    hours += 4;
    reasons.push('marginally negative — may recover');
  }

  // ── 4. Apply hard cap ─────────────────────────────────────────
  // Never extend beyond 72h total from entry
  const totalFromEntry = tradedHours + hours;
  if (totalFromEntry > 72) {
    hours = Math.max(0, 72 - tradedHours);
  }

  // If hours came out zero (already past 72h), resolve now
  if (hours < 1) {
    return {
      shouldExtend:   false,
      extensionHours: 0,
      extensionBand:  band,
      reason:         `72h hard cap reached — resolving as ${isNegative ? 'LOSS' : 'WIN'}`,
    };
  }

  return {
    shouldExtend:   true,
    extensionHours: Math.round(hours),
    extensionBand:  band,
    resolveAt:      new Date(Date.now() + hours * 3600000).toISOString(),
    reason:         reasons.length
      ? `Extending ${Math.round(hours)}h: ${reasons.join(', ')}`
      : `PnL ±${pnl.toFixed(2)}% within ±${band.toFixed(2)}% band — extending ${Math.round(hours)}h`,
  };
}

export default { computeExtension };