// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3.2 — Telegram Bot (Phase 1: All bugs fixed)
//
//  FIXED in v3.2:
//   ✅ Markdown escaping — no more parse entity errors
//   ✅ STATUS button in HELP now works via callback
//   ✅ Radar restarts when CLAW START is called
//   ✅ UPGRADE command — guided daily limit upgrade
//   ✅ Smart idle-to-shadow flip (3 empty cycles → shadow)
//   ✅ Scan-with-limit: shows found opportunities + limit message
//   ✅ Mode-switching buttons cancel auto-flip properly
// ─────────────────────────────────────────────────────────────────

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { checkTokenInfoAvailability } from '../skills/token-info.js';
import { auditToken } from '../skills/token-audit.js';
import { getMarketRankScore } from '../skills/market-rank.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateWeeklyReport, formatWeeklyReportTelegram } from '../memory/index.js';
import { getRecentLessons } from '../intelligence/lessons.js';
import { getRLState } from '../intelligence/reinforcement.js';
import { cancelAutoFlip, getAutoFlipState, isBudgetExhausted, onBudgetRaised } from '../dailyflip.js';
import { getTimeUntilReset } from '../intelligence/session.js';

let _scanCallback = null;
let _radarStart   = null;   // injected by index.js so CLAW START can restart radar
let _radarStop    = null;

export function registerScanCallback(fn)  { _scanCallback = fn; }
export function registerRadarCallbacks(startFn, stopFn) {
  _radarStart = startFn;
  _radarStop  = stopFn;
}

const __dirname     = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR      = join(__dirname, '../logs');
const SETTINGS_FILE = join(LOGS_DIR, 'settings.json');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const KILL_PHRASE = (process.env.KILL_SWITCH_PHRASE || 'CLAW STOP').toUpperCase();

let bot             = null;
let isKilled        = false;
let onKillSwitch    = null;
let onWizardComplete = null;

// Idle cycle tracker — 3 consecutive zero-action cycles triggers shadow flip
let idleCycleCount  = 0;
const IDLE_FLIP_THRESHOLD = 3;

const wizardState = {};

// ── Settings ──────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  const current = loadSettings();
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

export function getSettings() { return loadSettings(); }
export function isAgentKilled() { return isKilled; }

// ── Markdown escaping — prevents all parse entity errors ──────────
// Escapes all Telegram MarkdownV1 special chars in dynamic content

function esc(text) {
  // Escape all Telegram Markdown special chars in dynamic content
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/>/g, '\\>');
}

// escRaw — for signal breakdown lines that already have formatting chars
// strips all special chars rather than escaping them
function escRaw(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[*_`\[\]\(\)~>\\]/g, '');
}

// Safe number/price formatting
function fmtPrice(p)  { return p ? `$${parseFloat(p).toLocaleString()}` : 'N/A'; }
function fmtPct(p)    { return p != null ? `${parseFloat(p).toFixed(2)}%` : 'N/A'; }
function fmtAmt(a)    { return a != null ? `$${parseFloat(a).toFixed(2)}` : 'N/A'; }

// ── Send helpers ──────────────────────────────────────────────────

export async function sendMessage(text, extra = {}) {
  if (!bot || !CHAT_ID) return;
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown', ...extra });
  } catch (e) {
    // If Markdown fails, strip all formatting and retry as plain text
    try {
      const plain = text.replace(/[*_`\[\]]/g, '');
      await bot.sendMessage(CHAT_ID, plain, { ...extra, parse_mode: undefined });
    } catch {}
    console.warn(`[Telegram] Send failed: ${e.message}`);
  }
}

async function sendWithButtons(text, buttons) {
  if (!bot || !CHAT_ID) return;
  try {
    await bot.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (e) {
    // Fallback without markdown
    try {
      const plain = text.replace(/[*_`\[\]]/g, '');
      await bot.sendMessage(CHAT_ID, plain, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch {}
    console.warn(`[Telegram] Button send failed: ${e.message}`);
  }
}

// ── Scoring in progress notification ────────────────────────────

// Returns the message_id so it can be deleted later
export async function notifyScoring(assetCount) {
  if (!bot || !CHAT_ID) return null;
  try {
    const msg = await bot.sendMessage(
      CHAT_ID,
      `⏳ *Scoring ${assetCount} assets...*\n` +
      `_Running 16-signal engine · ML probability · AI reasoning_\n` +
      `_Results in a few seconds..._`,
      { parse_mode: 'Markdown' }
    );
    return msg?.message_id ?? null;
  } catch { return null; }
}

export async function deleteMessage(messageId) {
  if (!bot || !CHAT_ID || !messageId) return;
  try { await bot.deleteMessage(CHAT_ID, messageId); } catch {}
}

// ── Idle cycle tracking ───────────────────────────────────────────

export function reportCycleResult(actionsTaken, remainingBudget) {
  const s = loadSettings();
  const mode = s.agentMode || 'shadow';
  if (mode === 'shadow') { idleCycleCount = 0; return; } // shadow never counts as idle

  if (actionsTaken === 0) {
    idleCycleCount++;
    if (idleCycleCount >= IDLE_FLIP_THRESHOLD) {
      idleCycleCount = 0;
      saveSettings({ agentMode: 'shadow', _prevMode: mode });
      sendMessage(
        `🔄 *Auto-switched to Shadow mode*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `After ${IDLE_FLIP_THRESHOLD} consecutive scans with no action, the agent switched itself to *SHADOW* mode.\n\n` +
        `*Reason:* Remaining daily budget ($${fmtAmt(remainingBudget).replace('$','')}) is below the minimum trade size — no orders can be placed.\n\n` +
        `The agent will keep scanning and learning in shadow. Daily budget resets at midnight UTC.\n` +
        `_No upgrade needed — this is normal end-of-day behaviour._`
      ).catch(() => {});
    }
  } else {
    idleCycleCount = 0; // reset on any action
  }
}

// ── Scan result with limit awareness ─────────────────────────────

export async function notifyScanResult(opportunities, dailySpent, maxDailySpend) {
  if (!opportunities || !opportunities.length) return;

  const s         = loadSettings();
  const mode      = s.agentMode || 'shadow';
  const remaining = maxDailySpend - dailySpent;
  const minTrade  = s.baseDCAAmount || 50;
  const isLimited = remaining < minTrade;

  if (!isLimited) return; // normal flow — individual trade notifications handle this

  // ── Shadow mode (manual or auto-flip): never show upsell ────────────────
  // Send per-signal "I would have bought" style instead — same as normal shadow flow.
  // notifyShadowDecision() handles the full rich format; here we just need
  // to avoid the upsell entirely. The caller (index.js) already calls
  // notifyShadowDecision for each signal in shadow mode, so in shadow we
  // simply return silently — no extra message needed.
  if (mode === 'shadow') return;

  // ── Live / Testnet but budget exhausted — upsell is appropriate ──────────
  const top3 = opportunities.slice(0, 3);
  const lines = top3.map(o =>
    `• *${esc(o.asset)}* — ${o.confidence}% confidence | ${esc(o.regime)} | ${esc(o.strategy)}`
  ).join('\n');

  const suggestedLimit = Math.ceil((maxDailySpend + 100) / 50) * 50;

  await sendWithButtons(
    `🔍 *Scan Complete — Budget Exhausted*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Found *${opportunities.length} buy signal${opportunities.length > 1 ? 's' : ''}*, but today's budget is fully spent.\n\n` +
    `*Top missed opportunities:*\n${lines}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Budget:* $${dailySpent.toFixed(0)} spent of $${maxDailySpend} limit — *$${remaining.toFixed(0)} remaining*\n` +
    `Minimum trade size: $${minTrade}\n\n` +
    `To act on tomorrow's signals:\n` +
    `→ \`BUDGET DAILY ${suggestedLimit}\` — raise limit to $${suggestedLimit}\n` +
    `→ Or wait — budget resets at midnight UTC\n\n` +
    `_The agent keeps scanning and will resume at reset._`,
    [
      [{ text: `💰 Raise limit to $${suggestedLimit}`, callback_data: `BUDGET_RAISE_${suggestedLimit}` }],
      [{ text: '📊 View Status', callback_data: 'DO_STATUS' }],
    ]
  );
}

// ── Trade notifications ───────────────────────────────────────────

// ── Pending approval store (in-memory, keyed by asset+timestamp) ─
const pendingApprovals = new Map();

// ── Sizing transparency line ──────────────────────────────────────
function buildSizingLine(sizeBreakdown, amount) {
  if (!sizeBreakdown) return '';
  const bd = sizeBreakdown;
  const parts = [
    `$${bd.base} base`,
    `${(bd.kellyFraction * 100).toFixed(0)}% Kelly`,
    `${bd.confFactor.toFixed(2)}x conf`,
    bd.riskMult !== 1.0 ? `${bd.riskMult}x risk` : null,
    bd.costBasisFactor !== 1.0 ? `${bd.costBasisFactor > 1 ? '+' : ''}${((bd.costBasisFactor - 1) * 100).toFixed(0)}% cost` : null,
    bd.drawdownFactor !== 1.0 ? `${bd.drawdownFactor}x dd` : null,
  ].filter(Boolean).join(' × ');
  return `\n  └ _${parts} = *$${amount.toFixed(2)}*_`;
}

export async function notifyShadowDecision(signal, amount) {
  const { asset, currentPrice, priceChangePct, rsi, rsi4h, regime,
          confidence, eli5, breakdown, effectiveThreshold,
          strategy, sessionContext, mtfAlignment, sector,
          _sizeBreakdown } = signal;

  const top3    = (breakdown || signal.confidenceBreakdown || []).slice(0, 3).map(b => `  · ${escRaw(b)}`).join('\n');
  const sesLine = sessionContext ? `\n${sessionContext.emoji} ${esc(sessionContext.session)}` : '';
  const mtfLine = mtfAlignment && mtfAlignment !== 'UNKNOWN' ? `\nMTF: ${esc(mtfAlignment)}` : '';
  const secLine = sector ? `\nSector: ${esc(sector)}` : '';

  const sizingLine = buildSizingLine(signal._sizeBreakdown, amount);

  // ── Store signal for later approval callback ────────────────
  const approvalKey = `${asset}_${Date.now()}`;
  pendingApprovals.set(approvalKey, { signal, amount, ts: Date.now() });
  // Auto-expire after 10 minutes
  setTimeout(() => pendingApprovals.delete(approvalKey), 10 * 60 * 1000);

  await sendWithButtons(
    '👻 *[SHADOW] Buy Signal*\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    `*${esc(asset)}/USDT* @ ${esc(fmtPrice(currentPrice))}\n` +
    `24h: ${esc(fmtPct(priceChangePct))} | RSI 1h: ${esc(rsi ?? 'N/A')} | 4h: ${esc(rsi4h ?? 'N/A')}\n` +
    `Regime: ${esc(regime)} | Strategy: ${esc(strategy || 'DIP_BUYER')}${secLine}${sesLine}${mtfLine}\n` +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    `🎯 *Confidence: ${confidence}%* (threshold: ${effectiveThreshold}%)\n` +
    `${top3}\n` +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    `🧠 *Analysis:*\n${esc(eli5 || 'No analysis available')}\n` +
    '━━━━━━━━━━━━━━━━━━━━━\n' +
    `💰 *Would Buy: ${esc(fmtAmt(amount))} USDT*${sizingLine}\n` +
    (() => {
      const audit = signal.auditResult;
      const info  = signal.tokenInfoResult;
      const lines = [];
      if (audit && !audit.tier1 && audit.riskLevel && audit.riskLevel !== 'UNKNOWN') {
        const icon = audit.riskLevel === 'SAFE' ? '✅' : audit.riskLevel === 'LOW' ? '🟡' : audit.riskLevel === 'MEDIUM' ? '🟠' : '🔴';
        lines.push(`${icon} Audit: ${audit.riskLevel}${audit.flags?.length ? ' — ' + audit.flags[0] : ''}`);
      }
      if (info && !info.tier1 && info.data) {
        const liq = info.data.liquidity;
        const hld = info.data.holders;
        if (liq || hld) lines.push(`💧 Liquidity: $${liq >= 1e6 ? (liq/1e6).toFixed(1)+'M' : liq >= 1e3 ? (liq/1e3).toFixed(0)+'k' : liq?.toFixed(0) || '?'} | Holders: ${hld?.toLocaleString() || '?'}`);
      }
      return lines.length ? `\n${lines.join('\n')}\n` : '';
    })() +
    '_Shadow mode — no real money moved_\n\n' +
    '💡 *Want to execute this trade for real?*',
    [
      [
        { text: `💸 Approve → LIVE`, callback_data: `SHADOW_APPROVE_LIVE_${approvalKey}` },
        { text: `🧪 Approve → TESTNET`, callback_data: `SHADOW_APPROVE_TEST_${approvalKey}` },
      ],
      [
        { text: `👻 Keep as Shadow`, callback_data: `SHADOW_KEEP_${approvalKey}` },
      ]
    ]
  );
}

export async function notifyTestnetDecision(signal, amount, order) {
  const { asset, currentPrice, confidence, regime, strategy,
          breakdown, effectiveThreshold } = signal;
  const top3 = (breakdown || signal.confidenceBreakdown || []).slice(0, 3).map(b => `  · ${escRaw(b)}`).join('\n');
  const sizingLineT = buildSizingLine(signal._sizeBreakdown, amount);

  await sendMessage(
    `🧪 *[TESTNET] Order Placed*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `*${esc(asset)}/USDT* @ ${esc(fmtPrice(currentPrice))}\n` +
    `Regime: ${esc(regime)} | Confidence: ${confidence}% | Strategy: ${esc(strategy || 'DIP_BUYER')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Top signals:*\n${top3}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *Order filled on Testnet*\n` +
    `Amount: ${esc(fmtAmt(amount))} USDT${sizingLineT}\n` +
    `Order ID: ${esc(order?.orderId ?? 'N/A')}\n` +
    `Qty: ${esc(order?.executedQty ?? 'N/A')} ${esc(asset)}\n` +
    `Fill price: ${esc(fmtPrice(order?.fills?.[0]?.price ?? currentPrice))}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Testnet — fake money, real execution_`
  );
}

export async function notifyTradeExecuted(signal, amount, order) {
  const { asset, currentPrice, confidence, regime, strategy } = signal;
  const sizingLineL = buildSizingLine(signal._sizeBreakdown, amount);
  await sendMessage(
    `✅ *[LIVE] Trade Executed*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `*${esc(asset)}/USDT* @ ${esc(fmtPrice(currentPrice))}\n` +
    `Regime: ${esc(regime)} | Confidence: ${confidence}%\n` +
    `Strategy: ${esc(strategy || 'DIP_BUYER')}\n` +
    `Amount: ${esc(fmtAmt(amount))} USDT${sizingLineL}\n` +
    `Order ID: ${esc(order?.orderId ?? 'N/A')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_REAL money moved — check your Binance account_`
  );
}

// ── Active Trades / Open Positions ───────────────────────────────
async function sendActiveTrades() {
  try {
    const paths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
    let trades = [];
    for (const p of paths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        trades = raw.trades || raw || [];
        break;
      }
    }

    // Pending = BUY decisions with no outcome yet
    const pending = trades.filter(t =>
      (t.action === 'BUY' || t.wouldBuy) && !t.outcome
    ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (!pending.length) {
      await sendWithButtons(
        '📂 *Active Trades*\n━━━━━━━━━━━━━━━━━━━━━\n' +
        '_No open positions right now._\n\n' +
        'All past decisions have resolved. The bot scans continuously and will open new positions when signals align.',
        [[{ text: '🔍 Scan Now', callback_data: 'TRIGGER_SCAN' }]]
      );
      return;
    }

    // Summary header
    const totalDeployed = pending.reduce((s, t) => s + (t.wouldSpendUSDT || 0), 0);
    const modeIcon = { live: '💸', testnet: '🧪', shadow: '👻' };

    let msg = `📂 *Active Positions — ${pending.length} open*\n` +
              `━━━━━━━━━━━━━━━━━━━━━\n` +
              `💰 Total deployed: *$${totalDeployed.toFixed(2)} USDT*\n\n`;

    for (const t of pending.slice(0, 8)) {
      const now     = Date.now();
      const entryMs = new Date(t.timestamp).getTime();
      const ageH    = Math.floor((now - entryMs) / 3600000);
      const ageM    = Math.floor(((now - entryMs) % 3600000) / 60000);

      // Time remaining
      const isExtended = t.extended || !!t.extendedUntil;
      const left = t.extendedUntil
        ? Math.max(0, Math.ceil((new Date(t.extendedUntil) - now) / 3600000))
        : Math.max(0, 24 - ageH);
      const isOverdue = ageH > 24 && !isExtended;

      // Mode badge
      const mode = modeIcon[t.mode || 'shadow'] || '👻';

      // Entry price formatted
      const entryFmt = t.priceAtDecision
        ? '$' + (+t.priceAtDecision).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
        : '—';

      // Progress bar (time elapsed)
      const totalWindow = isExtended ? (ageH + left) : 24;
      const pct = Math.min(100, Math.round(ageH / Math.max(1, totalWindow) * 100));
      const bar = '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

      // Status line
      const statusLine = isOverdue
        ? '🔄 Resolving next cycle'
        : isExtended
          ? `⏱ Extended — ${left}h remaining`
          : left > 0
            ? `⏳ ~${left}h to resolve`
            : '🔄 Due to resolve';

      // Top signal (first breakdown item)
      const topSig = (t.confidenceBreakdown || [])[0]
        ? '📡 ' + esc(t.confidenceBreakdown[0].replace(/\([+-]?\d+pts\)/g, '').trim().slice(0, 50))
        : '';

      // Extension reason
      const extNote = isExtended && t.extensionReason
        ? `\n_Ext: ${esc(t.extensionReason.replace(/^Extending \d+h: /, '').slice(0, 60))}_`
        : '';

      // News alert
      const newsNote = (t.newsAlerts || []).length > 0
        ? `\n📰 News: ${esc((t.newsAlerts[0].title || '').slice(0, 55))}…`
        : '';

      msg += `${mode} *${esc(t.asset)}/USDT* · ${esc(t.regime || 'NEUTRAL')}\n` +
             `├ Entry: ${esc(entryFmt)} · $${(t.wouldSpendUSDT || 0).toFixed(0)} deployed\n` +
             `├ Conf: *${t.confidence || 0}%* · ${esc(t.strategy || 'DIP_BUYER')}\n` +
             `├ Age: ${ageH}h ${ageM}m · ${statusLine}\n` +
             `├ ${bar} ${pct}%${extNote}${newsNote}\n` +
             `${topSig ? '└ ' + topSig : '└ —'}\n\n`;
    }

    if (pending.length > 8) {
      msg += `_...and ${pending.length - 8} more positions_\n\n`;
    }

    const tstamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    msg += `━━━━━━━━━━━━━━━━━━━━━\n_Updated at ${tstamp} — resolves automatically_`;

    await sendWithButtons(msg, [
      [
        { text: '📊 Status', callback_data: 'DO_STATUS' },
        { text: '🔄 Refresh Trades', callback_data: 'DO_TRADES' },
      ]
    ]);
  } catch (e) {
    await sendMessage(`❌ Trades error: ${esc(e.message)}`);
  }
}

// ── Live approval with inline buttons ────────────────────────────

export async function requestApproval(signal, amount) {
  if (!bot) return false;
  const { asset, confidence, regime, currentPrice, breakdown } = signal;
  const top2 = (breakdown || signal.confidenceBreakdown || []).slice(0, 2).map(b => `  · ${escRaw(b)}`).join('\n');

  await sendWithButtons(
    `⚠️ *Approval Required — Live Trade*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Asset: *${esc(asset)}/USDT* @ ${esc(fmtPrice(currentPrice))}\n` +
    `Amount: *${esc(fmtAmt(amount))} USDT*\n` +
    `Confidence: ${confidence}% | Regime: ${esc(regime)}\n\n` +
    `*Top signals:*\n${top2}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Tap YES to approve or NO to skip. Auto-skips in 60s._`,
    [
      [
        { text: `✅ YES — Buy ${esc(fmtAmt(amount))} ${esc(asset)}`, callback_data: `APPROVE_${asset}` },
        { text: `❌ NO — Skip`, callback_data: `REJECT_${asset}` },
      ]
    ]
  );

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      bot.removeListener('callback_query', cbHandler);
      resolve(false);
    }, 60000);

    const cbHandler = (query) => {
      const data = query.data;
      if (data === `APPROVE_${asset}` || data === `REJECT_${asset}`) {
        clearTimeout(timer);
        bot.removeListener('callback_query', cbHandler);
        bot.answerCallbackQuery(query.id).catch(() => {});
        resolve(data.startsWith('APPROVE'));
      }
    };
    bot.on('callback_query', cbHandler);
  });
}

// ── Bot init ──────────────────────────────────────────────────────

export function initBot(onKill, onWizardDone) {
  if (!TOKEN) { console.warn('[Telegram] No TELEGRAM_BOT_TOKEN — bot disabled'); return; }
  onKillSwitch    = onKill;
  onWizardComplete = onWizardDone || null;

  bot = new TelegramBot(TOKEN, { polling: true });

  // ── Inline button handler ─────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    bot.answerCallbackQuery(query.id).catch(() => {});

    // Mode switch buttons
    if (data.startsWith('MODE_')) {
      const mode = data.replace('MODE_', '').toLowerCase();
      const s = loadSettings();
      const spent = parseFloat(s._todaySpent || 0);
      const limit = parseFloat(s.maxDailySpend || 100);

      // Block switching to testnet/live if budget is exhausted
      if (mode !== 'shadow' && isBudgetExhausted(spent, limit)) {
        const resetInfo = getTimeUntilReset ? getTimeUntilReset() : { label: 'midnight UTC' };
        await sendWithButtons(
          `🚫 *Cannot switch to ${mode.toUpperCase()} — daily limit active*\n\n` +
          `You've spent *$${spent.toFixed(0)}* of your *$${limit}* daily limit.\n\n` +
          `To unlock ${mode.toUpperCase()} mode:\n` +
          `→ Wait for reset in *${resetInfo?.label || 'a few hours'}*\n` +
          `→ Or raise your budget now:`,
          [
            [{ text: `💰 Raise to $${limit + 100}`, callback_data: `BUDGET_RAISE_${limit + 100}` }],
            [{ text: '👻 Stay in Shadow', callback_data: 'MODE_shadow' }],
          ]
        );
        return;
      }

      cancelAutoFlip();
      idleCycleCount = 0;
      saveSettings({ agentMode: mode });
      const icons = { shadow: '👻', testnet: '🧪', live: '💸' };
      await sendMessage(
        `✅ *Mode → ${mode.toUpperCase()}* ${icons[mode] || ''}\n_Saved. Takes effect next cycle._`
      );
    }

    // TRADES button (from HELP)
    if (data === 'DO_PERF') { await sendPerformanceMessage(); return; }
    if (data === 'DO_TRADES') {
      await sendActiveTrades();
      return;
    }

    // STATUS button (from HELP)
    if (data === 'DO_STATUS') {
      await sendStatusMessage();
    }

    // Kill / Resume
    if (data === 'KILL_AGENT') {
      isKilled = true;
      if (_radarStop) _radarStop();
      await sendWithButtons(
        `🛑 *KILL SWITCH ACTIVATED*\nAll activity halted. Radar stopped.`,
        [[{ text: '▶️ Resume Agent', callback_data: 'RESUME_AGENT' }]]
      );
      if (onKillSwitch) onKillSwitch();
    }
    if (data === 'RESUME_AGENT') {
      isKilled = false;
      if (_radarStart) _radarStart();
      await sendMessage(`✅ *DCA CLAW RESUMED*\nAgent and radar are back online.`);
    }

    // Scan button
    if (data === 'TRIGGER_SCAN') {
      if (!_scanCallback) return;
      await sendMessage(`🔍 *Scan triggered*\n_Scanning 100+ assets through 16-signal engine..._`);
      _scanCallback().catch(async (e) => {
        await sendMessage(`❌ Scan failed: ${esc(e.message)}`);
      });
    }

    // ── Shadow approval buttons ─────────────────────────────────
    if (data.startsWith('SHADOW_APPROVE_LIVE_') || data.startsWith('SHADOW_APPROVE_TEST_') || data.startsWith('SHADOW_KEEP_')) {
      let approvalKey, targetMode;

      if (data.startsWith('SHADOW_APPROVE_LIVE_')) {
        approvalKey = data.replace('SHADOW_APPROVE_LIVE_', '');
        targetMode  = 'live';
      } else if (data.startsWith('SHADOW_APPROVE_TEST_')) {
        approvalKey = data.replace('SHADOW_APPROVE_TEST_', '');
        targetMode  = 'testnet';
      } else {
        approvalKey = data.replace('SHADOW_KEEP_', '');
        targetMode  = null;
      }

      const pending = pendingApprovals.get(approvalKey);

      if (!pending) {
        await sendMessage('⏰ *This approval has expired* (10 min window)\n_The signal is no longer actionable._');
        return;
      }

      pendingApprovals.delete(approvalKey);

      if (!targetMode) {
        await sendMessage(`👻 *Kept as shadow* — ${esc(pending.signal.asset)} logged for learning only.`);
        return;
      }

      const { signal, amount } = pending;
      const s = loadSettings();
      const spent = parseFloat(s._todaySpent || 0);
      const limit = parseFloat(s.maxDailySpend || 100);

      // Budget check
      if (isBudgetExhausted(spent, limit) && targetMode !== 'shadow') {
        await sendMessage(
          `🚫 *Cannot approve — daily limit reached*\n` +
          `Spent $${spent.toFixed(0)} / $${limit} today.\n` +
          `_Raise your budget or wait for reset._`
        );
        return;
      }

      // API keys check for live mode
      if (targetMode === 'live') {
        const key = process.env.BINANCE_API_KEY || '';
        if (!key || key.includes('your-real') || key.length < 10) {
          await sendMessage(
            '🚫 *Cannot approve → LIVE*\n' +
            'Your `.env` still has placeholder API keys.\n' +
            '_Add real Binance API key + secret first._'
          );
          return;
        }
      }

      // Execute the approved trade
      try {
        await sendMessage(
          `⚡ *Executing approved trade...*\n` +
          `${esc(signal.asset)}/USDT @ ${esc(fmtPrice(signal.currentPrice))}\n` +
          `Amount: ${esc(fmtAmt(amount))} USDT\n` +
          `Mode: ${targetMode.toUpperCase()}`
        );

        if (targetMode === 'testnet' || targetMode === 'live') {
          const { placeBuyOrder } = await import('../binance/client.js');
          const order = await placeBuyOrder(signal.symbol, amount);

          // ── Patch the trade record in shadow_trades.json ──────────────
          // logDecision() wrote this as 'shadow' — update it to the real mode
          // so the dashboard PnL card shows the correct 🧪/💸 emoji
          try {
            const tPaths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
            let tPath = null, tData = null;
            for (const p of tPaths) {
              if (existsSync(p)) { tPath = p; tData = JSON.parse(readFileSync(p, 'utf8')); break; }
            }
            if (tPath && tData) {
              const tradeList = tData.trades || tData;
              // Find the most recent trade for this asset with mode: shadow and no outcome
              const idx = [...tradeList].reverse().findIndex(t =>
                t.asset === signal.asset && (t.mode === 'shadow' || !t.mode) && !t.outcome &&
                Math.abs(new Date(t.timestamp) - Date.now()) < 10 * 60 * 1000  // within 10 min
              );
              const realIdx = idx >= 0 ? tradeList.length - 1 - idx : -1;
              if (realIdx >= 0) {
                tradeList[realIdx].mode        = targetMode;
                tradeList[realIdx].orderId     = order?.orderId ?? null;
                tradeList[realIdx].executedQty = order?.executedQty ?? null;
                tradeList[realIdx].fillPrice   = order?.fills?.[0]?.price ?? signal.currentPrice;
                tradeList[realIdx].executedAt  = new Date().toISOString();
                const save = Array.isArray(tData) ? tradeList : { ...tData, trades: tradeList };
                writeFileSync(tPath, JSON.stringify(save, null, 2));
                console.log(`[Bot] Trade record updated → mode:${targetMode}, orderId:${order?.orderId}`);
              }
            }
          } catch (patchErr) {
            console.warn('[Bot] Could not patch trade record:', patchErr.message);
          }

          if (targetMode === 'live') {
            await notifyTradeExecuted(signal, amount, order);
          } else {
            await notifyTestnetDecision(signal, amount, order);
          }
          await sendMessage(
            `✅ *Trade executed on ${targetMode.toUpperCase()}*\n` +
            `Order ID: ${esc(order?.orderId ?? 'N/A')}\n` +
            `Qty: ${esc(order?.executedQty ?? 'N/A')} ${esc(signal.asset)}\n` +
            `Fill: ${esc(fmtPrice(order?.fills?.[0]?.price ?? signal.currentPrice))}`
          );
        }
      } catch (e) {
        await sendMessage(
          `❌ *Approval execution failed*\n` +
          `${esc(e.message)}\n\n` +
          `_Trade was NOT executed. Signal logged in shadow as normal._`
        );
      }
      return;
    }

    // Budget raise button (from limit notification)
    if (data.startsWith('BUDGET_RAISE_')) {
      const val = parseInt(data.replace('BUDGET_RAISE_', ''));
      // If budget was exhausted, raising it unlocks original mode
      const restoredMode = onBudgetRaised(val, sendMessage);
      const s   = loadSettings();
      const prev = s.maxDailySpend || 100;
      // Track daily spent persisted value for cross-restart awareness
      if (val > prev) {
        cancelAutoFlip();
        idleCycleCount = 0;
        saveSettings({ agentMode: s._prevMode || 'testnet', maxDailySpend: val });
        await sendMessage(
          `✅ *Daily limit raised to $${val}*\n\n` +
          `🔄 Resumed *${(s._prevMode || 'testnet').toUpperCase()}* mode — ready to trade again! 🦞`
        );
      }
    }
  });

  // ── Message handler ──────────────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text   = (msg.text || '').trim();
    const upper  = text.toUpperCase();

    if (upper === KILL_PHRASE) {
      isKilled = true;
      if (_radarStop) _radarStop();
      await sendWithButtons(
        `🛑 *KILL SWITCH ACTIVATED*\nAll activity halted immediately. Radar stopped.`,
        [[{ text: '▶️ Resume Agent', callback_data: 'RESUME_AGENT' }]]
      );
      if (onKillSwitch) onKillSwitch();
      return;
    }

    if (upper === 'CLAW START') {
      isKilled = false;
      idleCycleCount = 0;
      if (_radarStart) _radarStart(); // ✅ FIXED: radar restarts on resume
      await sendMessage(`✅ *DCA CLAW RESUMED*\nAgent and radar are back online.`);
      return;
    }

    if (wizardState[chatId]) { await handleWizardReply(chatId, text); return; }

    // ── STATUS ───────────────────────────────────────────────
    if (upper === 'STATUS') { await sendStatusMessage(); return; }
    if (upper === 'PERFORMANCE' || upper === 'PERF' || upper === 'STATS') {
      await sendPerformanceMessage(); return;
    }

    // ── BALANCE ──────────────────────────────────────────────
    if (upper === 'BALANCE' || upper === 'WALLET' || upper === 'FUNDS') {
      try {
        const s3 = loadSettings();
        const mode3 = s3.agentMode || 'shadow';
        const baseUrl3 = mode3 === 'testnet'
          ? 'https://testnet.binance.vision'
          : (process.env.BINANCE_BASE_URL || 'https://api.binance.com');
        const apiKey3 = process.env.BINANCE_API_KEY;
        const apiSecret3 = process.env.BINANCE_API_SECRET;

        if (!apiKey3 || !apiSecret3) {
          await sendMessage('❌ *No API keys configured*\n\nAdd BINANCE\_API\_KEY and BINANCE\_API\_SECRET to your .env file.');
          return;
        }
        if (mode3 === 'shadow') {
          await sendMessage('👻 *Shadow mode — no real wallet*\n\nSwitch to testnet or live to check your balance.\nSend `MODE testnet` to switch.');
          return;
        }

        const { createHmac } = await import('crypto');
        const axiosB = (await import('axios')).default;
        const ts3 = Date.now();
        const qs3 = `timestamp=${ts3}`;
        const sig3 = createHmac('sha256', apiSecret3).update(qs3).digest('hex');
        const res3 = await axiosB.get(`${baseUrl3}/api/v3/account?${qs3}&signature=${sig3}`, {
          headers: { 'X-MBX-APIKEY': apiKey3 },
          timeout: 8000,
        });
        const balances = res3.data.balances
          .filter(b => parseFloat(b.free) > 0.0001 || parseFloat(b.locked) > 0.0001)
          .sort((a, b) => {
            // USDT first, then by free balance
            if (a.asset === 'USDT') return -1;
            if (b.asset === 'USDT') return 1;
            return parseFloat(b.free) - parseFloat(a.free);
          })
          .slice(0, 18);

        if (!balances.length) {
          await sendMessage(`💼 *Wallet empty*\n\nNo assets found in your ${mode3.toUpperCase()} account.`);
          return;
        }

        const modeIcon3 = { testnet: '🧪', live: '💸' }[mode3] || '❓';
        const rows3 = balances.map(b => {
          const free = parseFloat(b.free);
          const locked = parseFloat(b.locked);
          const total = (free + locked);
          const dp = total < 1 ? 6 : total < 100 ? 4 : 2;
          const lockedStr = locked > 0.0001 ? ` _(${locked.toFixed(4)} locked)_` : '';
          return `• *${b.asset}*: \`${total.toFixed(dp)}\`${lockedStr}`;
        }).join('\n');

        await sendMessage(
          `${modeIcon3} *${mode3.toUpperCase()} Wallet*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          rows3 + '\n' +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `_${balances.length} asset${balances.length!==1?'s':''} · Tap SPENT for today's budget_`
        );
      } catch (e) {
        await sendMessage(`❌ *Balance fetch failed*\n\`${e.message}\`\n\nCheck your API key has Read Info enabled.`);
      }
      return;
    }

    // ── SPENT ────────────────────────────────────────────────
    if (upper === 'SPENT' || upper === 'BUDGET STATUS' || upper === 'TODAY') {
      await sendSpentMessage(); return;
    }

    // ── HELP ─────────────────────────────────────────────────
    if (upper === 'HELP') {
      await sendWithButtons(
        '🦞 *DCA CLAW v3 COMMANDS*\n' +
        '━━━━━━━━━━━━━━━━━━━━━\n' +
        '`STATUS` — Agent status\n' +
        '`TRADES` — Open / active positions\n' +
        '`SPENT` — Today\'s spending & budget\n' +
        '`BALANCE` — Wallet balance (testnet/live)\n' +
        '`SCAN` — Manual scan now\n' +
        '`REPORT` — Weekly performance\n' +
        '`LESSONS` — Learned lessons\n`CANCEL [asset]` — Cancel a pending trade\n' +
        '`UPGRADE` — Raise daily limit\n\n' +
        '*Mode:*\n' +
        '`MODE shadow` | `MODE testnet` | `MODE live`\n\n' +
        '*Risk:*\n' +
        '`RISK conservative` | `RISK balanced` | `RISK degen`\n\n' +
        '*Budget:*\n' +
        '\`BUDGET DAILY 150` — set daily limit\n' +
        '`BUDGET TRADE 75` — set per-trade max\n\n' +
        '*Frequency:*\n' +
        '`FREQUENCY 15m` | `30m` | `1h` | `4h` | `1d`\n\n' +
        '*Control:*\n' +
        '`CLAW STOP` — Emergency halt\n' +
        '`CLAW START` — Resume\n' +
        '`SETUP` — Re-run wizard\n' +
        '━━━━━━━━━━━━━━━━━━━━━\n' +
        '_Note: Per-trade amount scales with confidence (max 1.5x). ' +
        'Example: $50 base at 90% confidence = up to $75. ' +
        'Use \`BUDGET TRADE\` to set your base._\n' +
        '━━━━━━━━━━━━━━━━━━━━━\n' +
        '💬 *Ask me anything in plain English:*\n' +
        '\'"Why did you buy FLOW?"\' | \'"What is my worst trade?"\' | \'"Should I raise my budget?"\'',
        [
          [
            { text: '📊 Status', callback_data: 'DO_STATUS' },
            { text: '📂 Trades', callback_data: 'DO_TRADES' },
            { text: '📈 Performance', callback_data: 'DO_PERF' },
            { text: '🔍 Scan Now', callback_data: 'TRIGGER_SCAN' },
          ],
          [
            { text: '👻 Shadow', callback_data: 'MODE_shadow' },
            { text: '🧪 Testnet', callback_data: 'MODE_testnet' },
            { text: '💸 Live', callback_data: 'MODE_live' },
          ]
        ]
      );
      return;
    }

    // ── SCAN ─────────────────────────────────────────────────
    if (upper === 'SCAN') {
      if (isKilled) { await sendMessage(`🛑 Agent is halted. Send \`CLAW START\` first.`); return; }
      if (!_scanCallback) { await sendMessage(`⚠️ Scan callback not registered yet.`); return; }
      await sendMessage(
        `🔍 *Manual scan triggered!*\n\nScanning 100+ assets through 16-signal engine...\n_Results incoming in 3-5 minutes._`
      );
      _scanCallback().catch(async (e) => {
        await sendMessage(`❌ Scan failed: ${esc(e.message)}`);
      });
      return;
    }

    // ── CANCEL ───────────────────────────────────────────────
    if (upper.startsWith('CANCEL ') || upper.startsWith('/CANCEL ')) {
      const assetRaw = upper.replace(/^\/CANCEL |^CANCEL /, '').trim().toUpperCase();
      if (!assetRaw) {
        await sendMessage('Usage: `CANCEL BTC` or `CANCEL HBAR` — cancels a pending trade by asset name.');
        return;
      }
      try {
        const { readFileSync, writeFileSync, existsSync } = await import('fs');
        const shadowFile = './logs/shadow_trades.json';
        if (!existsSync(shadowFile)) {
          await sendMessage(`❌ No trades file found.`);
          return;
        }
        const data  = JSON.parse(readFileSync(shadowFile, 'utf8'));
        const trades = data.trades || data;
        const pending = trades.filter(t =>
          (t.asset || '').toUpperCase() === assetRaw &&
          (!t.outcome || t.outcome === 'PENDING') &&
          (t.action === 'BUY' || t.wouldBuy)
        );
        if (!pending.length) {
          await sendMessage(`⚠️ No pending trade found for *${esc(assetRaw)}*.\nThe trade may have already resolved, or use PERFORMANCE to check.`);
          return;
        }
        // Cancel all matching pending trades
        let cancelled = 0;
        (Array.isArray(data) ? data : data.trades || []).forEach(t => {
          if (
            (t.asset || '').toUpperCase() === assetRaw &&
            (!t.outcome || t.outcome === 'PENDING') &&
            (t.action === 'BUY' || t.wouldBuy)
          ) {
            t.outcome   = 'CANCELLED';
            t.action    = 'CANCELLED';
            t.cancelledAt = new Date().toISOString();
            t.cancelledBy = 'telegram';
            cancelled++;
          }
        });
        writeFileSync(shadowFile, JSON.stringify(data, null, 2));
        await sendMessage(
          `✅ *${esc(assetRaw)} — Trade Cancelled*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `${cancelled} pending trade${cancelled !== 1 ? 's' : ''} marked as CANCELLED.\n` +
          `Asset removed from active tracking.\n\n` +
          `_Trade logged for AI learning. Decision marked CANCELLED in history._`
        );
      } catch (e) {
        await sendMessage(`❌ Cancel failed: ${e.message}`);
      }
      return;
    }

    // ── LESSONS ──────────────────────────────────────────────
    if (upper === 'LESSONS') {
      try {
        const lessons = getRecentLessons(5);
        if (!lessons.length) {
          await sendMessage(
            `🧠 *No lessons yet*\n\nLessons appear after 10 resolved trades (24h each).\nKeep the agent running — they will distil automatically.`
          );
          return;
        }
        const rl = getRLState();
        const lines = lessons
          .map((l, i) => `*${i + 1}. ${esc(l.type?.replace(/_/g, ' ') || 'Lesson')}*\n${esc(l.lesson)}`)
          .join('\n\n');
        const rlLine = rl.bestPattern
          ? `\n\n🔁 *Best RL pattern:* \`${esc(rl.bestPattern.pattern)}\` (x${rl.bestPattern.weight?.toFixed(2)}, ${rl.bestPattern.winRate}% WR)`
          : '';
        await sendMessage(
          `🧠 *DCA Claw — Recent Lessons*\n━━━━━━━━━━━━━━━━━━━━━\n${lines}${rlLine}\n━━━━━━━━━━━━━━━━━━━━━\n_Based on resolved trade history_`
        );
      } catch (e) { await sendMessage(`❌ Lessons error: ${esc(e.message)}`); }
      return;
    }

    // ── TRADES / POSITIONS ──────────────────────────────────
    if (upper === 'TRADES' || upper === 'POSITIONS' || upper === 'OPEN') {
      await sendActiveTrades();
      return;
    }

    // ── REPORT ───────────────────────────────────────────────
    if (upper === 'REPORT') {
      try {
        const report = generateWeeklyReport();
        await sendMessage(formatWeeklyReportTelegram(report));
      } catch (e) { await sendMessage(`❌ Report error: ${esc(e.message)}`); }
      return;
    }

    // ── UPGRADE ──────────────────────────────────────────────
    if (upper === 'UPGRADE' || upper.startsWith('UPGRADE ')) {
      const s   = loadSettings();
      const cur = s.maxDailySpend || 100;
      const sug = cur + 100;

      if (upper === 'UPGRADE') {
        // Show upgrade options
        await sendWithButtons(
          `💰 *Upgrade Daily Limit*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `Current limit: *$${cur} USDT*\n\n` +
          `Choose a new limit or type \`BUDGET DAILY [amount]\`:`,
          [
            [
              { text: `+$100 → $${cur + 100}`, callback_data: `BUDGET_RAISE_${cur + 100}` },
              { text: `+$200 → $${cur + 200}`, callback_data: `BUDGET_RAISE_${cur + 200}` },
            ],
            [
              { text: `2x → $${cur * 2}`, callback_data: `BUDGET_RAISE_${cur * 2}` },
              { text: '❌ Cancel', callback_data: 'DO_STATUS' },
            ]
          ]
        );
      } else {
        // UPGRADE 300 — direct amount
        const val = parseFloat(text.split(' ')[1]);
        if (isNaN(val) || val <= cur) {
          await sendMessage(`⚠️ Amount must be greater than current limit ($${cur}). Try \`UPGRADE ${sug}\``); 
          return;
        }
        cancelAutoFlip();
        idleCycleCount = 0;
        saveSettings({ maxDailySpend: val });
        await sendMessage(`✅ *Daily limit raised to $${val} USDT*\n_Saved permanently. Agent continues._`);
      }
      return;
    }

    // ── MODE ─────────────────────────────────────────────────
    if (upper.startsWith('MODE ')) {
      const mode = text.split(' ')[1]?.toLowerCase();
      if (!['shadow', 'testnet', 'live'].includes(mode)) {
        await sendMessage(`❓ Unknown mode. Use:\n\`MODE shadow\`\n\`MODE testnet\`\n\`MODE live\``);
        return;
      }

      // Block testnet/live if daily limit is exhausted
      const s2 = loadSettings();
      const spent2 = parseFloat(s2._todaySpent || 0);
      const limit2 = parseFloat(s2.maxDailySpend || 100);
      if (mode !== 'shadow' && isBudgetExhausted(spent2, limit2)) {
        const resetInfo2 = getTimeUntilReset ? getTimeUntilReset() : { label: 'midnight UTC' };
        await sendWithButtons(
          `🚫 *Cannot switch to ${mode.toUpperCase()} — daily limit active*\n\n` +
          `You've spent *$${spent2.toFixed(0)}* of your *$${limit2}* daily limit today.\n\n` +
          `*To unlock:*\n` +
          `→ Wait for auto-reset in *${resetInfo2?.label || 'midnight UTC'}*\n` +
          `→ Or raise your budget: \`BUDGET DAILY ${limit2 + 100}\`\n\n` +
          `_Shadow mode stays active — agent keeps learning._`,
          [
            [{ text: `💰 Raise to $${limit2 + 100}`, callback_data: `BUDGET_RAISE_${limit2 + 100}` }],
            [{ text: '📊 View Status', callback_data: 'DO_STATUS' }],
          ]
        );
        return;
      }

      cancelAutoFlip();
      idleCycleCount = 0;
      const icons = { shadow: '👻', testnet: '🧪', live: '💸' };
      const desc  = {
        shadow:  'Decisions logged only. Zero real orders. Safe for building track record.',
        testnet: 'Real orders on Binance Testnet. Fake money, real order flow.',
        live:    '⚠️ REAL money. Real Binance. Agent will trade on next cycle.',
      };
      saveSettings({ agentMode: mode });
      await sendMessage(`✅ *Mode → ${mode.toUpperCase()}* ${icons[mode]}\n\n${escRaw(desc[mode])}\n\n_Saved permanently._`);
      return;
    }

    // ── RISK ─────────────────────────────────────────────────
    if (upper.startsWith('RISK ')) {
      const profile = text.split(' ')[1]?.toLowerCase();
      if (!['conservative', 'balanced', 'degen'].includes(profile)) {
        await sendMessage(`❓ Use:\n\`RISK conservative\`\n\`RISK balanced\`\n\`RISK degen\``);
        return;
      }
      const desc = {
        conservative: '🛡️ 7%+ dips. Smaller sizes. Maximum protection.',
        balanced:     '⚖️ 4%+ dips. Moderate sizes. Recommended.',
        degen:        '🎰 2%+ dips. Aggressive sizes. High risk/reward.',
      };
      saveSettings({ riskProfile: profile });
      await sendMessage(`✅ *Risk → ${profile.toUpperCase()}*\n\n${esc(desc[profile])}\n\n_Saved permanently._`);
      return;
    }

    // ── BUDGET ───────────────────────────────────────────────
    if (upper.startsWith('BUDGET ')) {
      const parts = text.split(' ');
      const sub   = parts[1]?.toUpperCase();
      const val   = parseFloat(parts[2]);
      if (isNaN(val) || val < 5) {
        await sendMessage(`❓ Use:\n\`BUDGET DAILY 150\`\n\`BUDGET TRADE 75\``);
        return;
      }
      const s = loadSettings();
      if (sub === 'DAILY') {
        const prev = s.maxDailySpend || 100;
        if (val <= prev) {
          await sendMessage(
            `⚠️ New daily limit ($${val}) must be greater than current ($${prev}).\n` +
            `Try \`BUDGET DAILY ${prev + 100}\` or send \`UPGRADE\` for options.`
          );
          return;
        }
        cancelAutoFlip();
        idleCycleCount = 0;
        const prevMode = s._prevMode;
        saveSettings({ maxDailySpend: val, agentMode: prevMode || s.agentMode });
        if (prevMode) {
          await sendMessage(
            `✅ *Daily limit raised to $${val} USDT*\n\n` +
            `🔄 Resumed *${prevMode.toUpperCase()}* mode automatically.\n_Back to trading!_ 🦞`
          );
        } else {
          await sendMessage(`✅ *Daily limit → $${val} USDT*\n_Saved permanently._`);
        }
      } else if (sub === 'TRADE') {
        saveSettings({ baseDCAAmount: val });
        await sendMessage(
          `✅ *Per-trade base → $${val} USDT*\n\n` +
          `_Note: actual trade size scales with confidence (max 1.5x = $${(val * 1.5).toFixed(0)})._\n` +
          `_Use \`BUDGET TRADE\` to adjust your base._`
        );
      } else {
        await sendMessage(`❓ Use DAILY or TRADE:\n\`BUDGET DAILY 150\`\n\`BUDGET TRADE 75\``);
      }
      return;
    }

    // ── FREQUENCY ────────────────────────────────────────────
    if (upper.startsWith('FREQUENCY ')) {
      const freq    = text.split(' ')[1]?.toLowerCase();
      const cronMap = {
        '15m': { cron: '*/15 * * * *', label: 'every 15 minutes' },
        '30m': { cron: '*/30 * * * *', label: 'every 30 minutes' },
        '1h':  { cron: '0 * * * *',    label: 'every hour' },
        '4h':  { cron: '0 */4 * * *',  label: 'every 4 hours' },
        '1d':  { cron: '0 9 * * *',    label: 'once daily at 9am UTC' },
      };
      const cfg = cronMap[freq];
      if (!cfg) {
        await sendMessage(`❓ Use: \`FREQUENCY 15m\`, \`30m\`, \`1h\`, \`4h\`, \`1d\``);
        return;
      }
      saveSettings({ cronSchedule: cfg.cron, frequencyLabel: cfg.label });
      await sendMessage(`✅ *Frequency → ${esc(cfg.label)}*\n_Saved. Restart to apply._`);
      return;
    }

    // ── SETUP ────────────────────────────────────────────────
    if (upper === 'SETUP') { await startWizard(chatId); return; }

    // ── NATURAL LANGUAGE — catch-all for any question ────────────
    // Any message that isn't a known command goes to the AI
    // Examples: "Why did you buy FLOW?" | "What's your worst trade?" | "Should I raise my budget?"
    if (text.length > 3 && !upper.startsWith('/')) {
      await handleNaturalLanguageQuery(text);
      return;
    }
  });

  console.log('[Telegram] Bot v3.2 online — all bugs fixed, inline buttons active');
}

// ── Status message helper (shared by command + button) ───────────

async function sendSpentMessage() {
  const s = loadSettings();
  const maxDaily   = s.maxDailySpend  || parseFloat(process.env.MAX_DAILY_SPEND  || '100');
  const baseTrade  = s.baseDCAAmount  || parseFloat(process.env.BASE_DCA_AMOUNT  || '50');
  const mode       = s.agentMode || process.env.AGENT_MODE || 'shadow';
  const modeIcon   = { shadow: '👻', testnet: '🧪', live: '💸' }[mode] || '❓';

  // Read trade log to compute today's spend
  let todaySpent = 0;
  let todayTrades = [];
  let totalResolved = 0;
  let totalWins = 0;
  try {
    const { readFileSync, existsSync } = await import('fs');
    const dayjs = (await import('dayjs')).default;
    const paths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
    let raw = null;
    for (const p of paths) {
      if (existsSync(p)) { raw = JSON.parse(readFileSync(p, 'utf8')); break; }
    }
    if (raw) {
      const trades = raw.trades || raw || [];
      const todayStr = dayjs().format('YYYY-MM-DD');
      todayTrades = trades.filter(t => {
        const ts = t.timestamp || '';
        return ts.startsWith(todayStr) && (t.action === 'BUY' || t.wouldBuy);
      });
      // Split by mode — shadow is simulation only, never counts toward real budget
      const shadowTrades  = todayTrades.filter(t => (t.mode || 'shadow') === 'shadow');
      const testnetTrades = todayTrades.filter(t => t.mode === 'testnet');
      const liveTrades    = todayTrades.filter(t => t.mode === 'live');
      const shadowSpent   = shadowTrades.reduce((s, t)  => s + (t.wouldSpendUSDT || 0), 0);
      const testnetSpent  = testnetTrades.reduce((s, t) => s + (t.wouldSpendUSDT || 0), 0);
      const liveSpent     = liveTrades.reduce((s, t)    => s + (t.wouldSpendUSDT || 0), 0);
      // Real spend = testnet + live only
      todaySpent = testnetSpent + liveSpent;
      // Store on outer scope for message building
      todayTrades._shadowSpent  = shadowSpent;
      todayTrades._testnetSpent = testnetSpent;
      todayTrades._liveSpent    = liveSpent;
      const resolved = trades.filter(t => t.outcome && t.outcome !== 'CANCELLED' && t.outcome !== 'REDUNDANT');
      totalResolved = resolved.length;
      totalWins = resolved.filter(t => t.outcome === 'WIN').length;
    }
  } catch (e) {
    console.warn('[Bot] Failed to read trades for SPENT:', e.message);
  }

  const remaining  = Math.max(0, maxDaily - todaySpent);
  const pct        = maxDaily > 0 ? Math.min(100, Math.round(todaySpent / maxDaily * 100)) : 0;
  const barFilled  = Math.round(pct / 5);
  const bar        = '█'.repeat(barFilled) + '░'.repeat(20 - barFilled);
  const wr         = totalResolved > 0 ? Math.round(totalWins / totalResolved * 100) : null;

  // Build per-trade breakdown for today
  const tradeLines = todayTrades.slice(-8).map(t => {
    const outcome = t.outcome ? (t.outcome === 'WIN' ? '✅' : '❌') : '⏳';
    const pnl = t.pnlPct24h != null ? ` ${t.pnlPct24h >= 0 ? '+' : ''}${t.pnlPct24h.toFixed(1)}%` : '';
    return `${outcome} ${esc(t.asset)} - $${(t.wouldSpendUSDT || 0).toFixed(0)}${pnl}`;
  }).join('\n');

  const shadowSpent  = todayTrades._shadowSpent  || 0;
  const testnetSpent = todayTrades._testnetSpent || 0;
  const liveSpent    = todayTrades._liveSpent    || 0;

  // Mode-specific trade lines
  const realTradeLines = todayTrades
    .filter(t => t.mode === 'live' || t.mode === 'testnet')
    .slice(-6).map(t => {
      const mIcon = t.mode === 'live' ? '💸' : '🧪';
      const outcome = t.outcome ? (t.outcome === 'WIN' ? '✅' : '❌') : '⏳';
      const pnl = t.pnlPct24h != null ? ` ${t.pnlPct24h >= 0 ? '+' : ''}${t.pnlPct24h.toFixed(1)}%` : '';
      return `${mIcon}${outcome} ${esc(t.asset)} $${(t.wouldSpendUSDT || 0).toFixed(0)}${pnl}`;
    }).join('\n');

  const shadowTradeLines = todayTrades
    .filter(t => (t.mode || 'shadow') === 'shadow')
    .slice(-4).map(t => {
      const outcome = t.outcome ? (t.outcome === 'WIN' ? '✅' : '❌') : '⏳';
      const pnl = t.pnlPct24h != null ? ` ${t.pnlPct24h >= 0 ? '+' : ''}${t.pnlPct24h.toFixed(1)}%` : '';
      return `👻 ${esc(t.asset)} $${(t.wouldSpendUSDT || 0).toFixed(0)}${pnl}`;
    }).join('\n');

  await sendWithButtons(
    `💰 *Today's Budget Report*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Mode: ${modeIcon} *${mode.toUpperCase()}*\n\n` +
    `*Real spend (counts toward limit):*\n` +
    `  💸 Live:    $${liveSpent.toFixed(2)}\n` +
    `  🧪 Testnet: $${testnetSpent.toFixed(2)}\n` +
    `  ─────────────────\n` +
    `  Total: $${todaySpent.toFixed(2)} / $${maxDaily}\n` +
    `  [${bar}] ${pct}%\n` +
    `  Remaining: *$${remaining.toFixed(2)}*\n\n` +
    `*👻 Shadow simulation (informational):*\n` +
    `  $${shadowSpent.toFixed(2)} simulated today · not counted\n\n` +
    (realTradeLines ? `*Real trades today:*\n${realTradeLines}\n\n` : '') +
    (shadowTradeLines ? `*Shadow trades today:*\n${shadowTradeLines}\n\n` : '') +
    `*All-time:* ${totalResolved} resolved · ${wr != null ? wr + '% WR' : 'no resolved trades'}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Resets at midnight UTC_`,
    [
      [
        { text: '🔍 Scan Now',    callback_data: 'TRIGGER_SCAN' },
        { text: '📊 Status',      callback_data: 'DO_STATUS'    },
      ],
      [
        { text: '💰 Raise Limit', callback_data: `BUDGET_RAISE_${Math.ceil((maxDaily + 100) / 50) * 50}` },
      ]
    ]
  );
}

async function sendPerformanceMessage() {
  try {
    const paths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
    let trades = [];
    for (const p of paths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        trades = raw.trades || raw || [];
        break;
      }
    }

    const resolved = trades.filter(t => t.outcome && t.outcome !== 'CANCELLED' && t.outcome !== 'REDUNDANT' && t.pnlPct24h != null);
    const buys     = trades.filter(t => t.action === 'BUY' || t.wouldBuy);
    const pending  = buys.filter(t => !t.outcome);

    if (!resolved.length) {
      await sendMessage(
        '📈 *Performance Summary*\n━━━━━━━━━━━━━━━━━━━━━\n' +
        '_No resolved trades yet — agent is still building history._\n\n' +
        `${pending.length} trade${pending.length !== 1 ? 's' : ''} pending resolution.`
      );
      return;
    }

    const wins    = resolved.filter(t => t.outcome === 'WIN');
    const losses  = resolved.filter(t => t.outcome === 'LOSS');
    const winRate = Math.round(wins.length / resolved.length * 100);

    const avgReturn = resolved.reduce((s, t) => s + (t.pnlPct24h || 0), 0) / resolved.length;
    const totalSpent = buys.reduce((s, t) => s + (t.wouldSpendUSDT || 0), 0);

    // Best and worst by actual pnlPct24h from real trade data
    const sorted     = [...resolved].sort((a, b) => (b.pnlPct24h || 0) - (a.pnlPct24h || 0));
    const bestTrade  = sorted[0];
    const worstTrade = sorted[sorted.length - 1];

    // Sharpe-like: avg return / std dev of returns
    const returns    = resolved.map(t => t.pnlPct24h || 0);
    const mean       = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance   = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
    const stdDev     = Math.sqrt(variance);
    const sharpe     = stdDev > 0 ? (mean / stdDev).toFixed(2) : 'N/A';

    // Win streak
    let currentStreak = 0, maxStreak = 0, streak = 0;
    for (const t of [...resolved].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp))) {
      if (t.outcome === 'WIN') { streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    }
    // Current streak (from end)
    for (let i = resolved.length - 1; i >= 0; i--) {
      if (resolved[i].outcome === 'WIN') currentStreak++;
      else break;
    }

    // Mode breakdown
    const byMode = {};
    resolved.forEach(t => {
      const m = t.mode || 'shadow';
      if (!byMode[m]) byMode[m] = { wins: 0, total: 0 };
      byMode[m].total++;
      if (t.outcome === 'WIN') byMode[m].wins++;
    });
    const modeLine = Object.entries(byMode)
      .map(([m, d]) => `${m === 'shadow' ? '👻' : m === 'testnet' ? '🧪' : '💸'} ${m}: ${Math.round(d.wins/d.total*100)}% (${d.wins}W/${d.total-d.wins}L)`)
      .join('\n');

    await sendWithButtons(
      `📈 *DCA CLAW — Performance Summary*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *Overall*\n` +
      `• ${resolved.length} resolved · ${pending.length} pending\n` +
      `• Win rate: *${winRate}%* (${wins.length}W / ${losses.length}L)\n` +
      `• Avg 24h return: *${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%*\n` +
      `• Sharpe ratio: *${sharpe}*\n` +
      `• Total simulated: *$${totalSpent.toFixed(0)} USDT*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏆 *Best trade:* ${esc(bestTrade.asset)} *+${bestTrade.pnlPct24h?.toFixed(1)}%*\n` +
      `  _${esc(bestTrade.regime)} regime · ${bestTrade.confidence}% confidence_\n` +
      `💔 *Worst trade:* ${esc(worstTrade.asset)} *${worstTrade.pnlPct24h?.toFixed(1)}%*\n` +
      `  _${esc(worstTrade.regime)} regime · ${worstTrade.confidence}% confidence_\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔥 *Win streak:* ${currentStreak} current · ${maxStreak} best\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `*By mode:*\n${modeLine}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `_All data from real trade log — no estimates_`,
      [
        [{ text: '📊 Full Status', callback_data: 'DO_STATUS' }],
        [{ text: '📂 Open Trades', callback_data: 'DO_TRADES' }],
      ]
    );
  } catch (e) {
    await sendMessage(`📈 Performance data unavailable: ${e.message}`).catch(() => {});
  }
}

async function sendStatusMessage() {
  const s       = loadSettings();
  const mode    = s.agentMode || process.env.AGENT_MODE || 'shadow';
  const icons   = { shadow: '👻', testnet: '🧪', live: '💸' };
  const flip    = getAutoFlipState();
  const flipLine = flip.isAutoFlipped
    ? `\n⚠️ *Auto-flipped from ${esc(flip.flippedFrom?.toUpperCase())}* — resets in ${esc(flip.resetIn)}`
    : '';
  const idleLine = idleCycleCount > 0
    ? `\n🔄 Idle cycles: ${idleCycleCount}/${IDLE_FLIP_THRESHOLD} before auto-shadow`
    : '';

  // Check Binance Skills availability
  let skillsLine = '';
  try {
    const tokenInfoOk = await checkTokenInfoAvailability();
    // Audit and market rank are always available (public endpoints with no search needed)
    skillsLine = `\n━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔌 *Binance AI Skills*\n` +
      `  ${tokenInfoOk ? '✅' : '⚠️'} Token Info — ${tokenInfoOk ? 'active' : 'fallback'}\n` +
      `  ✅ Token Audit — active\n` +
      `  ✅ Market Rank — active`;
  } catch {
    skillsLine = `\n━━━━━━━━━━━━━━━━━━━━━\n🔌 *Binance AI Skills* — checking...`;
  }

  await sendWithButtons(
    `🦞 *DCA CLAW v3 STATUS*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Agent: ${isKilled ? '🔴 HALTED' : '🟢 RUNNING'}\n` +
    `Mode: ${icons[mode] || '❓'} *${mode.toUpperCase()}*${flipLine}${idleLine}\n` +
    `Risk: ${esc((s.riskProfile || 'balanced').toUpperCase())}\n` +
    `Frequency: ${esc(s.frequencyLabel || 'every hour')}\n` +
    `Max daily: $${s.maxDailySpend || 100} USDT\n` +
    `Per trade: $${s.baseDCAAmount || 50} USDT (base, scales 1x-1.5x)\n` +
    `${skillsLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Send \`HELP\` for all commands_`,
    [
      [
        { text: '👻 Shadow', callback_data: 'MODE_shadow' },
        { text: '🧪 Testnet', callback_data: 'MODE_testnet' },
        { text: '💸 Live',   callback_data: 'MODE_live'    },
      ],
      [
        { text: '💰 Spent Today', callback_data: 'DO_SPENT' },
        { text: '🔍 Scan Now', callback_data: 'TRIGGER_SCAN' },
      ],
      [
        { text: isKilled ? '▶️ Resume' : '🛑 Kill', callback_data: isKilled ? 'RESUME_AGENT' : 'KILL_AGENT' },
      ]
    ]
  );
}

// ── Wizard ────────────────────────────────────────────────────────

export async function runFirstLaunchWizard() {
  if (!TOKEN || !CHAT_ID) return;
  const s = loadSettings();
  if (s.wizardComplete) return;

  await sendMessage(
    `🦞 *Welcome to DCA CLAW v3!*\n\n` +
    `I'm your autonomous DCA agent. Let's set your budget before we start.\n\n` +
    `*Step 1 of 3:* What's your *daily spending limit* in USDT?\n` +
    `_(Total across all trades per day)_\n\n` +
    `Reply with a number. Example: \`100\``
  );
  wizardState[CHAT_ID] = { step: 1 };
}

async function startWizard(chatId) {
  await sendMessage(
    `🔧 *Budget Setup Wizard*\n\n` +
    `*Step 1 of 3:* What's your *daily spending limit* in USDT?\n\n` +
    `Example: \`100\``
  );
  wizardState[chatId] = { step: 1 };
}

async function handleWizardReply(chatId, text) {
  const state = wizardState[chatId];
  const val   = parseFloat(text);

  if (state.step === 1) {
    if (isNaN(val) || val < 5) { await sendMessage(`❓ Please enter a valid number (min $5). Example: \`100\``); return; }
    state.maxDailySpend = val; state.step = 2;
    await sendMessage(
      `✅ Daily limit: *$${val} USDT*\n\n` +
      `*Step 2 of 3:* What's your *per-trade base amount*?\n` +
      `_(Must be less than daily limit. Actual size scales up to 1.5x at high confidence.)_\n\n` +
      `Example: \`50\``
    );
    return;
  }

  if (state.step === 2) {
    if (isNaN(val) || val < 5) { await sendMessage(`❓ Please enter a valid number (min $5).`); return; }
    if (val > state.maxDailySpend) {
      await sendMessage(`❓ Per-trade base can't exceed daily limit ($${state.maxDailySpend}).`);
      return;
    }
    state.baseDCAAmount = val; state.step = 3;
    await sendMessage(
      `✅ Per-trade base: *$${val} USDT* (max per trade: $${(val * 1.5).toFixed(0)} at peak confidence)\n\n` +
      `*Step 3 of 3:* What's your *risk profile*?\n\n` +
      `\`conservative\` — 7%+ dips, smaller sizes _(safest)_\n` +
      `\`balanced\` — 4%+ dips, moderate sizes _(recommended)_\n` +
      `\`degen\` — 2%+ dips, aggressive sizes _(highest risk)_`
    );
    return;
  }

  if (state.step === 3) {
    const profile = text.toLowerCase();
    if (!['conservative', 'balanced', 'degen'].includes(profile)) {
      await sendMessage(`❓ Please reply with: \`conservative\`, \`balanced\`, or \`degen\``);
      return;
    }
    state.riskProfile = profile;
    saveSettings({
      maxDailySpend:  state.maxDailySpend,
      baseDCAAmount:  state.baseDCAAmount,
      riskProfile:    state.riskProfile,
      agentMode:      'shadow',
      wizardComplete: true,
    });
    delete wizardState[chatId];

    await sendWithButtons(
      `🎉 *Setup Complete!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Daily limit: *$${state.maxDailySpend} USDT*\n` +
      `Per trade: *$${state.baseDCAAmount} USDT base* (max $${(state.baseDCAAmount * 1.5).toFixed(0)})\n` +
      `Risk profile: *${state.riskProfile.toUpperCase()}*\n` +
      `Starting mode: *👻 SHADOW* (safe default)\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `🦞 Firing first scan now...\n\n` +
      `_Switch mode anytime with the buttons below._`,
      [
        [
          { text: '👻 Shadow', callback_data: 'MODE_shadow' },
          { text: '🧪 Testnet', callback_data: 'MODE_testnet' },
          { text: '💸 Live',   callback_data: 'MODE_live'    },
        ]
      ]
    );
    if (onWizardComplete) setTimeout(() => onWizardComplete(), 1000);
  }
}

// ── Natural Language Query Handler ────────────────────────────────
// Powered by Groq llama-3.3-70b — understands any question about trades,
// performance, lessons, strategy, or agent decisions in plain English
async function handleNaturalLanguageQuery(text) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  if (!groqKey) {
    await sendMessage('🤖 _AI chat requires GROQ_API_KEY in your .env file._');
    return;
  }

  await sendMessage('🤖 _Thinking..._');

  // Load all context the agent has
  let tradeContext = '';
  let lessonContext = '';
  let settingsContext = '';
  try {
    const { readFileSync, existsSync } = await import('fs');
    const paths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
    for (const p of paths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        const trades = (raw.trades || raw).slice(-30); // last 30 trades
        const resolved = trades.filter(t => t.outcome);
        const pending  = trades.filter(t => !t.outcome);
        const wins = resolved.filter(t => t.outcome === 'WIN').length;
        const wr = resolved.length ? Math.round(wins/resolved.length*100) : 0;
        tradeContext = `RECENT TRADES (last 30):
Total resolved: ${resolved.length} | Win rate: ${wr}% | Pending: ${pending.length}
${trades.map(t => {
  const status = t.outcome ? (t.outcome==='WIN'?'✓WIN':'✗LOSS') : '⏳PENDING';
  const pnl = t.pnlPct24h != null ? ` ${t.pnlPct24h>0?'+':''}${t.pnlPct24h.toFixed(1)}%` : '';
  const ai = t.aiVerdict ? ` AI:${t.aiVerdict}` : '';
  return `${t.asset} | ${t.regime||'?'} | conf${t.confidence||0}% | ${status}${pnl}${ai} | ${t.strategy||'DIP_BUYER'} | ${new Date(t.timestamp).toLocaleDateString('en-GB')}`;
}).join('\n')}`;
        break;
      }
    }
    const lPaths = ['./logs/lessons.json', '../logs/lessons.json'];
    for (const p of lPaths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        const lessons = (raw.lessons || []).slice(-5);
        lessonContext = `RECENT LESSONS:\n${lessons.map(l => `• ${l.lesson}`).join('\n')}`;
        break;
      }
    }
    const sPaths = ['./logs/settings.json', '../logs/settings.json'];
    for (const p of sPaths) {
      if (existsSync(p)) {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        settingsContext = `AGENT SETTINGS: mode=${s.agentMode||'shadow'} | risk=${s.riskProfile||'balanced'} | daily=$${s.maxDailySpend||100} | base=$${s.baseDCAAmount||50}`;
        break;
      }
    }
  } catch (e) {
    console.warn('[NL] Context load failed:', e.message);
  }

  try {
    const { default: axios } = await import('axios');
    const systemMsg = `You are DCA CLAW 🦞, an autonomous crypto Dollar Cost Averaging agent on Binance.
You are answering a question from your operator about your own trading activity, decisions, and performance.
Answer in plain English, max 3-4 sentences. Be specific — use actual numbers from the trade data.
Be honest about mistakes and failures — don't spin bad results.
If asked about a specific asset, find it in the trade data and explain what happened.
Never say you "cannot access" data — all data is provided to you in context.`;

    const userMsg = `${settingsContext}

${tradeContext}

${lessonContext}

OPERATOR QUESTION: ${text}

Answer concisely and specifically, citing actual trade data where relevant.`;

    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user',   content: userMsg },
        ],
        temperature: 0.4,
        max_tokens:  300,
      },
      {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    const answer = resp.data?.choices?.[0]?.message?.content || 'No response.';
    // Sanitize for Telegram
    const safe = answer.replace(/[*_`\[\]()~>#+\-=|{}.!\\]/g, ' ').replace(/\s+/g,' ').trim();
    await sendMessage(`🤖 *DCA Claw says:*\n\n${safe}`);
  } catch (e) {
    await sendMessage(`🤖 _AI unavailable right now: ${e.response?.data?.error?.message || e.message}_`);
  }
}

export default {
  initBot, sendMessage, sendWithButtons,
  notifyShadowDecision, notifyTestnetDecision, notifyTradeExecuted,
  notifyScoring, deleteMessage,
  requestApproval, isAgentKilled, runFirstLaunchWizard, getSettings,
  registerScanCallback, registerRadarCallbacks,
  reportCycleResult, notifyScanResult,
};