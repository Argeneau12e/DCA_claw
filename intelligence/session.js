// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Time-of-Day Session Intelligence
//
//  Crypto markets have consistent session patterns:
//
//  Asian Session   (00:00–08:00 UTC) — Lower liquidity, noisy signals
//  European Open   (07:00–10:00 UTC) — Increasing volume, watch BTC
//  US Pre-market   (12:00–13:30 UTC) — Anticipation, volatility rising
//  US Session      (13:30–20:00 UTC) — Highest volume, cleanest signals
//  US Close        (20:00–22:00 UTC) — Position squaring, reversals
//  Dead Hours      (22:00–00:00 UTC) — Lowest liquidity, avoid entries
//
//  Output: threshold modifier + confidence modifier + narrative
// ─────────────────────────────────────────────────────────────────

export function getSessionContext() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDecimal = utcHour + utcMinute / 60;
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  let session, confidenceModifier, thresholdModifier, narrative, emoji;

  // Weekend — lower liquidity across the board
  if (isWeekend) {
    session = 'WEEKEND';
    confidenceModifier = -5;
    thresholdModifier = +5;
    emoji = '😴';
    narrative = `Weekend session — lower liquidity and higher volatility risk (+5pt threshold, -5pt confidence)`;
  }
  // Dead hours — worst time to enter
  else if (utcDecimal >= 22 || utcDecimal < 1) {
    session = 'DEAD_HOURS';
    confidenceModifier = -8;
    thresholdModifier = +8;
    emoji = '🌑';
    narrative = `Dead hours (22:00–01:00 UTC) — minimal liquidity, unreliable signals (+8pt threshold)`;
  }
  // Asian session — noisy, thin
  else if (utcDecimal >= 1 && utcDecimal < 7) {
    session = 'ASIAN';
    confidenceModifier = -3;
    thresholdModifier = +3;
    emoji = '🌏';
    narrative = `Asian session — moderate liquidity (+3pt threshold)`;
  }
  // European open — improving
  else if (utcDecimal >= 7 && utcDecimal < 10) {
    session = 'EU_OPEN';
    confidenceModifier = +2;
    thresholdModifier = -2;
    emoji = '🌍';
    narrative = `European open — improving liquidity (-2pt threshold)`;
  }
  // Pre-US — anticipation, rising volume
  else if (utcDecimal >= 12 && utcDecimal < 13.5) {
    session = 'US_PREMARKET';
    confidenceModifier = +3;
    thresholdModifier = -2;
    emoji = '🌅';
    narrative = `US pre-market — volume building, good entry window (-2pt threshold)`;
  }
  // US session — peak liquidity, cleanest signals
  else if (utcDecimal >= 13.5 && utcDecimal < 20) {
    session = 'US_SESSION';
    confidenceModifier = +5;
    thresholdModifier = -5;
    emoji = '🇺🇸';
    narrative = `US session — peak liquidity, cleanest signals (-5pt threshold, +5pt confidence)`;
  }
  // US close — position squaring, potential reversals
  else if (utcDecimal >= 20 && utcDecimal < 22) {
    session = 'US_CLOSE';
    confidenceModifier = -2;
    thresholdModifier = +3;
    emoji = '🌆';
    narrative = `US close — position squaring, reversal risk (+3pt threshold)`;
  }
  // EU/US overlap — strong
  else if (utcDecimal >= 10 && utcDecimal < 12) {
    session = 'EU_US_OVERLAP';
    confidenceModifier = +4;
    thresholdModifier = -3;
    emoji = '💪';
    narrative = `EU/US overlap — strong bidirectional volume (-3pt threshold)`;
  } else {
    session = 'NEUTRAL';
    confidenceModifier = 0;
    thresholdModifier = 0;
    emoji = '⏰';
    narrative = `Normal session hours`;
  }

  return {
    session,
    emoji,
    utcHour,
    isWeekend,
    confidenceModifier,
    thresholdModifier,
    narrative,
    timeString: `${String(utcHour).padStart(2,'0')}:${String(utcMinute).padStart(2,'0')} UTC`,
  };
}

// ── Time until next reset (midnight UTC) ─────────────────────────

export function getTimeUntilReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const ms = midnight - now;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return { ms, hours, minutes, label: `${hours}h ${minutes}m` };
}

export default { getSessionContext, getTimeUntilReset };
