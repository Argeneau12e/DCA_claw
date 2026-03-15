// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Daily Limit Auto-Flip Manager
//
//  When daily spend limit is reached in testnet/live mode:
//   1. Auto-switches to shadow mode
//   2. Sends Telegram notification with reset time + upgrade option
//   3. Continues running in shadow (never stops learning)
//   4. Auto-flips back to original mode at midnight UTC reset
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getTimeUntilReset } from './intelligence/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = join(__dirname, 'logs/settings.json');

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  const current = loadSettings();
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

// ── State ─────────────────────────────────────────────────────────

let _autoFlippedFrom = null; // stores 'testnet' or 'live' when auto-flipped
let _flipResetScheduled = false;

// ── Check and handle daily limit ─────────────────────────────────

export async function checkDailyLimitAndFlip(dailySpent, maxDailySpend, currentMode, sendMessageFn) {
  if (dailySpent < maxDailySpend) return currentMode; // no action needed
  if (currentMode === 'shadow') return currentMode;   // already shadow
  if (_autoFlippedFrom) return 'shadow';              // already flipped

  // Hit the limit — flip to shadow
  _autoFlippedFrom = currentMode;
  saveSettings({ agentMode: 'shadow', _prevMode: currentMode, _autoFlippedAt: new Date().toISOString() });

  const resetInfo = getTimeUntilReset();
  const suggestedLimit = maxDailySpend + 100;
  const modeIcon = { testnet: '🧪', live: '💸' }[currentMode] || '❓';

  await sendMessageFn(
    `💰 *Daily limit reached — switched to Shadow mode*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `You spent *$${dailySpent.toFixed(0)}* of your *$${maxDailySpend}* daily limit.\n\n` +
    `${modeIcon} *${currentMode.toUpperCase()} mode paused* — no real orders until reset.\n` +
    `👻 *Shadow mode active* — agent keeps learning, zero cost.\n\n` +
    `⏰ *Auto-reset in ${resetInfo.label}* (midnight UTC)\n` +
    `At reset, agent will automatically return to *${currentMode.toUpperCase()}* mode.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Want to keep trading today?\n` +
    `→ \`BUDGET DAILY ${suggestedLimit}\` — raise limit to $${suggestedLimit}\n` +
    `→ Or type any amount: \`BUDGET DAILY [amount]\`\n\n` +
    `_All decisions still logged. Learning continues._`
  ).catch(() => {});

  // Schedule midnight reset
  if (!_flipResetScheduled) {
    _flipResetScheduled = true;
    scheduleAutoReset(currentMode, sendMessageFn);
  }

  return 'shadow';
}

// ── Schedule midnight UTC auto-reset ─────────────────────────────

function scheduleAutoReset(originalMode, sendMessageFn) {
  const { ms } = getTimeUntilReset();

  setTimeout(async () => {
    if (!_autoFlippedFrom) return; // user manually changed mode — don't override

    const modeIcon = { testnet: '🧪', live: '💸' }[originalMode] || '❓';
    saveSettings({ agentMode: originalMode, _prevMode: null, _autoFlippedAt: null });
    _autoFlippedFrom = null;
    _flipResetScheduled = false;

    await sendMessageFn(
      `🔄 *Daily reset — back to ${originalMode.toUpperCase()}*\n\n` +
      `${modeIcon} Agent is now running in *${originalMode.toUpperCase()}* mode again.\n` +
      `Daily spend counter reset to $0.\n\n` +
      `_Good morning. Let's find some opportunities._ 🦞`
    ).catch(() => {});
  }, ms + 5000); // +5s buffer past midnight
}

// ── Manual mode change cancels auto-flip ─────────────────────────

export function cancelAutoFlip() {
  _autoFlippedFrom = null;
  _flipResetScheduled = false;
}

// ── Get auto-flip state (for STATUS command) ──────────────────────

export function getAutoFlipState() {
  return {
    isAutoFlipped: !!_autoFlippedFrom,
    flippedFrom: _autoFlippedFrom,
    resetIn: _autoFlippedFrom ? getTimeUntilReset().label : null,
  };
}

// ── Budget exhaustion check (used by bot.js MODE guard) ──────────

export function isBudgetExhausted(dailySpent, maxDailySpend) {
  // Returns true if daily limit is hit AND an auto-flip is currently active
  // (meaning the limit was hit this cycle, not just that spend > limit due to stale data)
  return dailySpent >= maxDailySpend && !!_autoFlippedFrom;
}

// ── Manual budget raise clears the exhaustion flag ────────────────
export function onBudgetRaised(newLimit, sendMessageFn) {
  if (!_autoFlippedFrom) return; // wasn't in exhaustion state
  const originalMode = _autoFlippedFrom;
  _autoFlippedFrom = null;
  _flipResetScheduled = false;
  saveSettings({ agentMode: originalMode, _prevMode: null, _autoFlippedAt: null });

  const modeIcon = { testnet: '🧪', live: '💸' }[originalMode] || '❓';
  if (sendMessageFn) {
    sendMessageFn(
      `✅ *Budget raised to $${newLimit} — ${originalMode.toUpperCase()} mode restored*\n\n` +
      `${modeIcon} Agent is back in *${originalMode.toUpperCase()}* mode.\n` +
      `You have $${newLimit} available today.\n\n` +
      `_DCA Claw is watching for opportunities._ 🦞`
    ).catch(() => {});
  }
  return originalMode;
}

export default { checkDailyLimitAndFlip, cancelAutoFlip, getAutoFlipState, isBudgetExhausted, onBudgetRaised };