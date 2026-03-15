// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3.2 — Main Agent Orchestrator
//
//  Phase 3 upgrades:
//   ✅ ATR + Kelly volatility-based position sizing (replaces flat calcBuyAmount)
//   ✅ Portfolio heat tracking — blocks new buys when overexposed
//   ✅ Sector cap — prevents 4x L1 concentration
//   ✅ Opportunity ranking — best-first capital allocation
//   ✅ Do-nothing gate — market health check before any trade
//   ✅ Drawdown memory — market-wide vs asset-specific classification
//   ✅ Cost basis intelligence — lowers avg = size bonus
//   ✅ Stablecoin/forex filter — USDT, USDC, EUR etc never scored
// ─────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import cron from 'node-cron';
import chalk from 'chalk';
import dayjs from 'dayjs';
import { readFileSync, existsSync } from 'fs';

import { scanForOpportunities } from './scanner/index.js';
import { scoreAsset, MIN_CONFIDENCE } from './signals/confidence.js';
import {
  logDecision, updatePnLAndLearn, getMemoryPatterns,
  getPatternThreshold, generateWeeklyReport, formatWeeklyReportTelegram,
} from './memory/index.js';
import {
  initBot, sendMessage, isAgentKilled, runFirstLaunchWizard,
  notifyShadowDecision, notifyTestnetDecision, notifyTradeExecuted,
  requestApproval, getSettings, registerScanCallback,
  registerRadarCallbacks, reportCycleResult, notifyScanResult,
  notifyScoring, deleteMessage,
} from './telegram/bot.js';
import { initRadar, stopRadar } from './radar/index.js';
import { distilLessons, shouldDistilLessons, getRecentLessons, analyseExtremes, runAIDeepAnalysis } from './intelligence/lessons.js';
import { processTradeRewardsBatch, buildPatternKey, getRLState } from './intelligence/reinforcement.js';
import { getFearGreedIndex, sentimentLabel } from './intelligence/sentiment.js';
import { getAlphaTrending } from './skills/alpha-signal.js';

// Strip chars that break Telegram MarkdownV1 inside dynamic text
function tgSafe(text) {
  if (!text) return '';
  return String(text)
    .replace(/[*_`\[\]()~>#+\-=|{}.!\\]/g, ' ')  // strip all Markdown special chars
    .replace(/\s+/g, ' ')
    .trim();
}
import { getTopSmartMoneyPicks } from './skills/smart-money.js';
import { getTrendingAssets } from './skills/market-rank.js';
import { checkDailyLimitAndFlip } from './dailyflip.js';
import { calcPositionSize } from './risk/sizing.js';
import { checkExecution } from './execution/smart.js';
import {
  checkSectorCapSafe, rankAndAllocate,
  checkDoNothingGateSafe, analyseDrawdown, assessPortfolio,
} from './risk/portfolio.js';
import { predictWinProbability, recordTradesBatch, getMLState } from './intelligence/ml.js';
import { generateReasoning, formatReasoningForTelegram } from './intelligence/reasoning.js';

dotenv.config({ override: true });

// ── Config ────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (existsSync('./logs/settings.json')) return JSON.parse(readFileSync('./logs/settings.json', 'utf8'));
  } catch {}
  return {};
}

const CONFIG = {
  get mode()              { return loadConfig().agentMode    || process.env.AGENT_MODE          || 'shadow'; },
  get riskProfile()       { return loadConfig().riskProfile  || process.env.RISK_PROFILE        || 'balanced'; },
  get cronSchedule()      { return loadConfig().cronSchedule || process.env.CHECK_INTERVAL_CRON || '0 * * * *'; },
  get maxDailySpend()     { return parseFloat(loadConfig().maxDailySpend || process.env.MAX_DAILY_SPEND || '100'); },
  get baseDCAAmount()     { return parseFloat(loadConfig().baseDCAAmount || process.env.BASE_DCA_AMOUNT || '50'); },
  get approvalThreshold() { return parseFloat(process.env.APPROVAL_THRESHOLD_USDT || '50'); },
  weeklyCron:    '0 9 * * 0',
  minConfidence: MIN_CONFIDENCE,
};

const RISK_MULTIPLIERS = {
  conservative: { high: 0.6,  medium: 0.4,  low: 0 },
  balanced:     { high: 1.2,  medium: 0.75, low: 0.4 },
  degen:        { high: 2.0,  medium: 1.25, low: 0.75 },
};

let dailySpent     = 0;  // shadow + real combined (for shadow learning tracking)
let dailyRealSpent = 0;  // testnet + live ONLY — gates real trades
let lastResetDate  = dayjs().format('YYYY-MM-DD');
let currentStrategy = 'DIP_BUYER';

// ── Logging ───────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts = dayjs().format('HH:mm:ss');
  const prefix = {
    info:    chalk.cyan(`[${ts}] ℹ️ `),
    success: chalk.green(`[${ts}] ✅`),
    warn:    chalk.yellow(`[${ts}] ⚠️ `),
    error:   chalk.red(`[${ts}] ❌`),
    shadow:  chalk.magenta(`[${ts}] 👻`),
    testnet: chalk.blue(`[${ts}] 🧪`),
    live:    chalk.greenBright(`[${ts}] 💸`),
    learn:   chalk.blue(`[${ts}] 🧠`),
    radar:   chalk.yellow(`[${ts}] 🔭`),
    rl:      chalk.magenta(`[${ts}] 🔁`),
  }[level] || `[${ts}]`;
  console.log(`${prefix} ${msg}`);
}

function resetDailySpend() {
  const today = dayjs().format('YYYY-MM-DD');
  if (today !== lastResetDate) { dailySpent = 0; dailyRealSpent = 0; lastResetDate = today; }
}

// calcBuyAmount — wraps risk/sizing.js with simple fallback
function calcBuyAmount(signal) {
  try {
    const result = calcPositionSize(signal, CONFIG);
    return result.size;
  } catch {
    const stratMod = signal.strategy === 'MOMENTUM_RIDER' ? 0.85 :
                     signal.strategy === 'ACCUMULATOR' ? 0.7 : 1.0;
    const tier = signal.confidence >= 78 ? 'high' : signal.confidence >= 60 ? 'medium' : 'low';
    const multiplier = RISK_MULTIPLIERS[CONFIG.riskProfile]?.[tier] ?? 0.5;
    return CONFIG.baseDCAAmount * multiplier * stratMod;
  }
}

// ── Post-trade RL + adaptive update ──────────────────────────────
async function processTradeRewards(resolvedTrades) {
  if (!resolvedTrades?.length) return;
  try {
    processTradeRewardsBatch(resolvedTrades);
    recordTradesBatch(resolvedTrades);
    for (const trade of resolvedTrades) {
      if (!trade.outcome) continue;
      const rlKey = buildPatternKey(trade.regime || 'NEUTRAL', trade.rsi || 50, 'NEUTRAL');
      log(`RL+Adaptive update: ${rlKey} (${trade.outcome} ${trade.pnlPct24h > 0 ? '+' : ''}${(trade.pnlPct24h || 0).toFixed(1)}%)`, 'rl');
    }
    const mlState = getMLState();
    if (mlState.totalObservations > 0) {
      log(`ML model: ${mlState.totalObservations} observations · ${mlState.overallWinRate ?? '—'}% WR · ${mlState.isMLActive ? 'ACTIVE' : `${20 - mlState.totalObservations} trades until ML active`}`, 'learn');
    }
  } catch (e) {
    log(`RL+ML update failed: ${e.message}`, 'warn');
  }
}

// ── Main Agent Cycle ──────────────────────────────────────────────
async function runAgentCycle() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`DCA CLAW v3.2 CYCLE — ${dayjs().format('YYYY-MM-DD HH:mm')}`);
  log(`Mode: ${CONFIG.mode.toUpperCase()} | Risk: ${CONFIG.riskProfile.toUpperCase()}`);

  if (isAgentKilled()) { log('Kill switch active — skipping cycle', 'warn'); return; }
  resetDailySpend();

  // Auto-flip to shadow if daily limit hit
  const effectiveMode = await checkDailyLimitAndFlip(
    dailyRealSpent, CONFIG.maxDailySpend, CONFIG.mode, sendMessage
  );
  if (effectiveMode !== CONFIG.mode) {
    log('Daily limit hit — running in shadow mode until midnight reset', 'warn');
  }
  if (dailyRealSpent >= CONFIG.maxDailySpend && effectiveMode === 'shadow') {
    log('Daily limit reached but continuing in shadow mode for learning', 'info');
  }

  // ── Step 1: Learning engine + RL rewards ─────────────────────
  log('Running learning engine...', 'learn');
  let resolvedTrades = [];
  try {
    // Hard 25s timeout — learning NEVER blocks the scan cycle
    const learnResult = await Promise.race([
      updatePnLAndLearn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Learning timeout after 25s')), 25000)),
    ]);
    resolvedTrades = learnResult || [];
    if (resolvedTrades.length) log(`Learning resolved ${resolvedTrades.length} trade(s)`, 'learn');
    await processTradeRewards(resolvedTrades);
  } catch (e) { log(`Learning skipped: ${e.message}`, 'warn'); }
  log('Learning engine done — proceeding to scan...', 'learn');

  // ── Step 2a: Lesson distillation (every 3 new resolved trades) ─
  if (shouldDistilLessons()) {
    log('Distilling lessons from trade history...', 'learn');
    try {
      const newLessons = distilLessons();
      if (newLessons?.length) {
        log(`${newLessons.length} new lessons distilled`, 'learn');
        const lessonSummary = newLessons.map(l => {
          const txt = tgSafe(l.lesson);
          // Slice at word boundary to avoid mid-word cuts
          const short = txt.length > 120 ? txt.slice(0,120).replace(/\s+\S*$/, '...') : txt;
          return `• ${short}`;
        }).join('\n');
        // Count ALL resolved trades from file, not just ones resolved this cycle
        let totalResolved = resolvedTrades.length;
        try {
          const tPaths = ['./logs/shadow_trades.json', '../logs/shadow_trades.json'];
          for (const p of tPaths) {
            if (existsSync(p)) {
              const raw = JSON.parse(readFileSync(p,'utf8'));
              const all = (raw.trades || raw);
              totalResolved = all.filter(t => t.outcome && t.outcome !== 'CANCELLED' && t.outcome !== 'REDUNDANT').length;
              break;
            }
          }
        } catch {}
        await sendMessage(
          `🧠 *DCA Claw — New Lessons Learned*\n\n${lessonSummary}\n\nAgent adapting from ${totalResolved} resolved trades.`
        ).catch(() => {});
      }
    } catch (e) { log(`Lesson distillation failed: ${e.message}`, 'warn'); }
  }

  // ── Step 2b: Best/worst trade extreme analysis ────────────────
  // Runs every cycle but only generates lessons when best or worst changes
  try {
    const extremeLessons = analyseExtremes();
    if (extremeLessons?.length) {
      log(`Extreme analysis: ${extremeLessons.length} new insight(s) from best/worst trades`, 'learn');
      const summary = extremeLessons.map(l => `• *${l.type.replace(/_/g,' ')}* — ${tgSafe(l.lesson).slice(0,120)}`).join('\n\n');
      await sendMessage(
        `📊 *DCA Claw — Best/Worst Trade Analysis*\n\n${summary}\n\nAgent updated thresholds based on extreme outcomes.`
      ).catch(() => {});
    }
  } catch (e) { log(`Extreme analysis failed: ${e.message}`, 'warn'); }

  // ── Step 2c: AI Deep Learning — scans ALL trades for strategic insights ─
  try {
    const aiInsights = await runAIDeepAnalysis();
    if (aiInsights?.length) {
      log(`AI deep analysis: ${aiInsights.length} new strategic insight(s) from full trade history`, 'learn');
      const source = aiInsights[0]?.aiSource || 'AI';
      const srcLabel = source === 'claude_api' ? '🤖 Claude' : source.startsWith('groq') ? '🌩️ Groq' : source.startsWith('ollama') ? '🦙 Ollama' : '📋 Rule-based';
      const summary = aiInsights.slice(0, 3).map(i => {
        const lesson = tgSafe(i.lesson);
        const action = tgSafe(i.actionable);
        const l = lesson.length > 90  ? lesson.slice(0,90).replace(/\s+\S*$/, '...') : lesson;
        const a = action.length > 60  ? action.slice(0,60).replace(/\s+\S*$/, '...') : action;
        return `• ${l}\n  → ${a}`;
      }).join('\n\n');
      await sendMessage(
        `🧠 *DCA Claw — AI Strategic Analysis* (${tgSafe(srcLabel)})\n\n${summary}\n\nBased on ${aiInsights[0]?.basedOnTrades} resolved trades.`
      ).catch(() => {});
    }
  } catch (e) { log(`AI deep analysis failed: ${e.message}`, 'warn'); }

  // ── Step 3: Load memory + RL state ───────────────────────────
  const memoryPatterns = getMemoryPatterns();
  const rlState = getRLState();
  const rlWinRate = rlState.totalPatterns > 0
    ? Math.round(rlState.patterns.filter(p => (p.winRate ?? 0) >= 50).length / rlState.totalPatterns * 100)
    : null;
  if (Object.keys(memoryPatterns).length > 0) {
    log(`Memory: ${Object.keys(memoryPatterns).length} patterns | RL: ${rlState.totalPatterns} weights`, 'learn');
  }

  // ── Step 4: Fetch sentiment + smart money ────────────────────
  log('Fetching market context (sentiment + smart money)...', 'info');
  let fgData = null;
  let smPicks = [];
  try {
    [fgData, smPicks] = await Promise.all([
      getFearGreedIndex(),
      getTopSmartMoneyPicks(10),
    ]);
    if (fgData) log(`Sentiment: ${sentimentLabel(fgData.value)} (${fgData.value})`, 'info');
    if (smPicks.length) log(`Smart money watching: ${smPicks.slice(0, 3).map(p => p.symbol).join(', ')}`, 'info');
  } catch (e) { log(`Context fetch failed: ${e.message}`, 'warn'); }

  // ── Step 5: Dynamic scanner ───────────────────────────────────
  log('Scanning market for opportunities...', 'info');
  let assets;
  try {
    assets = await scanForOpportunities();
    const smSymbols = smPicks.map(p => p.symbol.replace('USDT', ''));
    const smFirst = smSymbols.filter(s => assets.includes(s));
    const rest = assets.filter(s => !smSymbols.includes(s));
    if (smFirst.length) {
      assets = [...smFirst, ...rest];
      log(`Prioritised ${smFirst.length} smart money assets for scoring`, 'info');
    }

    // ── Binance Alpha pre-scan: inject trending Alpha tokens ──────
    try {
      const alphaTop = await getAlphaTrending(15);
      const alphaSymbols = alphaTop
        .map(t => (t.asset || '').toUpperCase())
        .filter(a => a.length > 0 && !assets.includes(a));
      if (alphaSymbols.length) {
        assets = [...alphaSymbols, ...assets]; // Alpha tokens get first priority
        log(`🔺 Alpha: injected ${alphaSymbols.length} trending tokens (${alphaSymbols.slice(0,5).join(', ')}...)`, 'info');
      }
    } catch (e) {
      log(`Alpha trending fetch failed: ${e.message}`, 'warn');
    }
  } catch (e) {
    log(`Scanner failed: ${e.message} — using fallback`, 'warn');
    assets = ['BTC', 'ETH', 'BNB', 'SOL', 'AVAX', 'XRP', 'ADA', 'DOT', 'LINK', 'NEAR'];
  }

  // ── Step 5b: Filter stablecoins + forex ──────────────────────
  const BLOCKED_ASSETS = new Set([
    'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'FRAX', 'USDP', 'GUSD', 'LUSD',
    'EUR', 'GBP', 'AUD', 'BIDR', 'BRL', 'NGN', 'RUB', 'TRY', 'VAI', 'SUSD',
  ]);
  assets = assets.filter(a => !BLOCKED_ASSETS.has(a.toUpperCase()));
  log(`After stablecoin/forex filter: ${assets.length} assets to score`, 'info');

  // ── Step 5c: Portfolio health assessment ──────────────────────
  const portfolio = assessPortfolio(CONFIG, { btcPct24h: 0 });
  log(`Portfolio heat: ${portfolio.heatLevel} (${portfolio.heat.heatPct}% of max)`, 'info');

  // ── Step 6: Score each asset through 16-signal engine ────────
  log(`Scoring ${assets.length} assets through 16-signal + adaptive engine...`, 'info');
  // Send "scoring in progress" — auto-deleted when results post
  const scoringMsgId = await notifyScoring(assets.length).catch(() => null);
  const scores = [];

  if (portfolio.isOverheat) {
    log('Portfolio heat CRITICAL — skipping new buys this cycle', 'warn');
    await sendMessage(portfolio.heat.narrative).catch(() => {});
    reportCycleResult(0, CONFIG.maxDailySpend - dailySpent);
    return;
  }

  for (const asset of assets) {
    try {
      const score = await scoreAsset(asset, memoryPatterns, rlWinRate);

      if (score.hardBlock) {
        log(`${asset.padEnd(7)} 🚨 HARD BLOCK: ${score.blockReason}`, 'warn');
        logDecision(score, 'BLOCKED', 0, CONFIG.mode);
        continue;
      }

      scores.push(score);
      if (score.strategy && score.strategy !== currentStrategy) {
        currentStrategy = score.strategy;
      }

      const filled = Math.round(score.confidence / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const smTag = score.smartMoneyScore > 5 ? ' 🐋' : score.smartMoneyScore < -5 ? ' 📉' : '';
      const stratTag = score.strategy !== 'DIP_BUYER' ? ` [${score.strategy}]` : '';
      log(`${asset.padEnd(7)} [${bar}] ${score.confidence}% ≥${score.effectiveThreshold}% | ${score.regime}${smTag}${stratTag}`);
    } catch (e) {
      log(`Failed to score ${asset}: ${e.message}`, 'warn');
    }
  }

  // ── Step 7: Filter using self-determined thresholds ──────────
  const actionable = scores
    .filter(s => {
      const memThreshold = getPatternThreshold(s.patternKey);
      const threshold = Math.min(s.effectiveThreshold ?? 40, memThreshold);
      return s.confidence >= threshold;
    })
    .sort((a, b) => b.confidence - a.confidence);

  log(`${actionable.length}/${scores.length} assets meet thresholds`, 'info');

  // Notify if limit already hit but signals found
  // Shadow mode: stay silent here — each signal gets its own "would have bought" notification below
  if (actionable.length > 0 && dailyRealSpent >= CONFIG.maxDailySpend && CONFIG.mode !== 'shadow') {
    await notifyScanResult(actionable, dailyRealSpent, CONFIG.maxDailySpend);
  }

  // ── Step 7b: Do-Nothing Gate ──────────────────────────────────
  const btcScore = scores.find(s => s.asset === 'BTC');
  const doNothingCtx = {
    btcPct24h:    btcScore?.priceChangePct ?? 0,
    fearGreed:    fgData?.value ?? 50,
    newsScore:    scores.length
      ? scores.reduce((s, sc) => s + (sc.newsScore || 0), 0) / scores.length
      : 0,
    btcRsi:       btcScore?.rsi ?? 50,
    cascadeScore: btcScore?.probabilisticRegime?.indicators?.cascade ?? 0,
    portfolioHeat: portfolio.heat,
  };
  const doNothing = checkDoNothingGateSafe(doNothingCtx, CONFIG.mode);
  if (doNothing.shouldSkip) {
    log('DO-NOTHING GATE FIRED — skipping entire cycle', 'warn');
    await sendMessage(doNothing.narrative).catch(() => {});
    for (const s of scores) logDecision(s, 'SKIP', 0, CONFIG.mode);
    reportCycleResult(0, CONFIG.maxDailySpend - dailySpent);
    return;
  }

  // ── Step 7c: Best-first opportunity ranking ───────────────────
  const remaining0 = CONFIG.maxDailySpend - dailyRealSpent;
  const rankedActionable = rankAndAllocate(actionable, remaining0, CONFIG);
  if (rankedActionable.length < actionable.length) {
    log(`Opportunity ranking: ${rankedActionable.length}/${actionable.length} signals get capital allocation`, 'info');
  }

  // Delete scoring message — results (or absence of) are ready
  if (typeof scoringMsgId !== 'undefined' && scoringMsgId) {
    await deleteMessage(scoringMsgId).catch(() => null);
  }

  // ── Step 8: No signals — watching brief ──────────────────────
  if (actionable.length === 0) {
    const closest = [...scores]
      .sort((a, b) => (b.confidence - b.effectiveThreshold) - (a.confidence - a.effectiveThreshold))
      .slice(0, 3);

    // Log skip-cycle context so AI has richer data when it analyses trade history
    // This records WHY we skipped — useful for lesson generation
    if (closest.length > 0) {
      const topAsset = closest[0];
      const gap = topAsset.effectiveThreshold - topAsset.confidence;
      log(`Best asset this cycle: ${topAsset.asset} at ${topAsset.confidence}% (${gap}pts below ${topAsset.effectiveThreshold}% threshold) — logged for AI learning`, 'learn');
    }

    const watchLines = closest.map(s => {
      const gap = s.effectiveThreshold - s.confidence;
      const smNote = s.smartMoneyScore > 5 ? ' 🐋 SM buying' : '';
      return `• *${s.asset}* — ${s.confidence}% (need ${s.effectiveThreshold}%) | ${s.regime}${smNote}\n  ${gap > 0 ? `needs ${gap}pts more` : 'just at threshold'}`;
    }).join('\n\n');

    const fgLine   = fgData ? `\n📊 Sentiment: ${sentimentLabel(fgData.value)} (${fgData.value}/100)` : '';
    const stratLine = `\n🎯 Strategy: ${currentStrategy}`;

    await sendMessage(
      `👀 *DCA Claw v3 — Watching Brief*\n\n` +
      `${fgLine}${stratLine}\n\n` +
      `🔍 *Closest to buying:*\n${watchLines}\n\n` +
      `⏸️ _No trades this cycle. Radar is running every 5 mins._\n_Send \`HELP\` for commands._`
    ).catch(() => {});

    for (const s of scores) logDecision(s, 'SKIP', 0, CONFIG.mode);
    reportCycleResult(0, CONFIG.maxDailySpend - dailySpent);
    return;
  }

  // ── Step 9: Execute based on mode ────────────────────────────
  let usdtBalance = 0;
  if (CONFIG.mode !== 'shadow') {
    try {
      const { getUSDTBalance } = await import('./binance/client.js');
      usdtBalance = await getUSDTBalance();
      log(`USDT Balance: $${usdtBalance.toFixed(2)}`, 'info');
    } catch (e) { log(`Balance check failed: ${e.message}`, 'warn'); }
  }

  let actionsTaken = 0;

  for (const signal of rankedActionable) {

    // ── Sector cap check ─────────────────────────────────────
    const sectorCheck = checkSectorCapSafe(signal.asset, CONFIG);
    if (sectorCheck.blocked) {
      log(`${signal.asset}: ${sectorCheck.reason}`, 'warn');
      logDecision(signal, 'SKIP', 0, CONFIG.mode);
      continue;
    }

    // ── Drawdown memory check ─────────────────────────────────
    const ddCheck = analyseDrawdown(signal.asset, signal.currentPrice, doNothingCtx.btcPct24h);
    if (ddCheck.sizeFactor === 0) {
      log(`${signal.asset}: ${ddCheck.narrative} — blocking new buy`, 'warn');
      logDecision(signal, 'SKIP', 0, CONFIG.mode);
      continue;
    }

    // ── ML Probability ───────────────────────────────────────
    let mlResult = null;
    try {
      mlResult = predictWinProbability(signal);
      signal.mlProbability    = mlResult.probability;
      signal.mlNarrative      = mlResult.narrative;
      signal.mlSource         = mlResult.source;
      signal.mlBlendRatio     = mlResult.blendRatio;
      if (mlResult.source !== 'confidence_fallback') {
        log(`${signal.asset}: ML P(win) ${(mlResult.probability * 100).toFixed(0)}% — ${mlResult.narrative.split('·')[0].trim()}`, 'learn');
      }
    } catch (e) {
      log(`ML prediction failed for ${signal.asset}: ${e.message}`, 'warn');
    }

    // ── AI Reasoning ─────────────────────────────────────────
    let reasoning = null;
    try {
      reasoning = await generateReasoning(signal, portfolio.heat);
      signal._reasoning = reasoning;
      // Apply contradiction penalty to confidence
      if (reasoning.confidencePenalty > 0) {
        const originalConf = signal.confidence;
        signal.confidence = Math.max(0, signal.confidence - reasoning.confidencePenalty);
        log(`${signal.asset}: AI reasoning penalised confidence ${originalConf}% → ${signal.confidence}% (−${reasoning.confidencePenalty}pts: ${reasoning.contradictions[0] || 'contradictions'})`, 'learn');
        // Re-check threshold after penalty
        if (signal.confidence < signal.effectiveThreshold) {
          log(`${signal.asset}: confidence dropped below threshold after AI penalty — skipping`, 'warn');
          logDecision(signal, 'SKIP', 0, CONFIG.mode);
          continue;
        }
      }
      if (reasoning.verdict === 'SKIP_ENTRY') {
        log(`${signal.asset}: AI verdict SKIP_ENTRY — no good entry point this cycle, skipping`, 'warn');
        signal._aiVerdict = 'SKIP_ENTRY';
        logDecision(signal, 'SKIP', 0, CONFIG.mode);
        await sendMessage(
          `🚫 *${signal.asset} — AI vetoed entry*\n` +
          `Confidence was ${signal.confidence}% but AI analysis found a poor entry point.\n` +
          `${tgSafe(reasoning.keyRisk || reasoning.rationale || 'No good entry this cycle.').slice(0,120)}\n\n` +
          `_Agent will re-evaluate next cycle._`
        ).catch(() => {});
        continue;
      }
      if (reasoning.verdict === 'WEAK_BUY') {
        log(`${signal.asset}: AI verdict WEAK_BUY — proceeding with caution`, 'warn');
      }
      // Tag aiVerdict on signal for learning + display
      signal._aiVerdict = reasoning.verdict || 'BUY';
    } catch (e) {
      log(`AI reasoning failed for ${signal.asset}: ${e.message} — proceeding without`, 'warn');
    }

    // ── Position sizing ───────────────────────────────────────
    let sizeResult;
    try {
      // Use ML probability to scale position size if available
      const mlProb = mlResult?.probability ?? signal.confidence / 100;
      sizeResult = calcPositionSize({ ...signal, mlProbability: mlProb }, CONFIG);
    } catch (e) {
      log(`Sizing failed for ${signal.asset}: ${e.message} — using fallback`, 'warn');
      sizeResult = { size: CONFIG.baseDCAAmount, formula: 'fallback' };
    }

    const buyAmount   = sizeResult.size * (ddCheck.sizeFactor ?? 1.0);
    const remaining   = CONFIG.maxDailySpend - dailyRealSpent;
    const finalAmount = Math.min(buyAmount, remaining);

    if (finalAmount < 10) {
      log(`${signal.asset}: amount too small ($${finalAmount.toFixed(2)}) — skip`, 'warn');
      logDecision(signal, 'SKIP', 0, CONFIG.mode);
      continue;
    }

    // ── Duplicate suppression — skip if same asset bought recently at similar price ──
    {
      const TRADES_FILE_PATH = './logs/shadow_trades.json';
      try {
        if (existsSync(TRADES_FILE_PATH)) {
          const raw = JSON.parse(readFileSync(TRADES_FILE_PATH, 'utf8'));
          const allTrades = raw.trades || raw || [];
          // Get last 7 BUY cycles for this asset
          const recentBuys = allTrades
            .filter(t => t.asset === signal.asset && (t.action === 'BUY' || t.wouldBuy) && !t.outcome)
            .slice(-7);
          if (recentBuys.length > 0) {
            const latest = recentBuys[recentBuys.length - 1];
            const priceDelta = latest.priceAtDecision
              ? Math.abs((signal.currentPrice - latest.priceAtDecision) / latest.priceAtDecision)
              : 1;
            const confDelta = Math.abs((signal.confidence || 0) - (latest.confidence || 0));
            // Skip if: price within ±2%, confidence within 5pts, AND no significant price drop
            // (price drop ≥5% = genuine DCA opportunity, should NOT be skipped)
            const priceDropped = latest.priceAtDecision
              ? (signal.currentPrice - latest.priceAtDecision) / latest.priceAtDecision <= -0.05
              : false;
            if (priceDelta < 0.02 && confDelta < 5 && !priceDropped) {
              log(`${signal.asset}: REDUNDANT — open position at similar price (\$${latest.priceAtDecision?.toFixed(4)}, Δ${(priceDelta*100).toFixed(1)}%) — skipping`, 'info');
              logDecision({ ...signal, eli5: `Redundant: already positioned at similar price $${latest.priceAtDecision?.toFixed(4)}` }, 'SKIP', 0, CONFIG.mode);
              continue;
            }
          }
        }
      } catch (e) {
        log(`Duplicate check failed for ${signal.asset}: ${e.message} — proceeding`, 'warn');
      }
    }

    // ── Spread / slippage check (execution/smart.js) ────────
    let execAmount = finalAmount;
    try {
      const execCheck = await checkExecution(signal.symbol, finalAmount, CONFIG.riskProfile);
      signal._execCheck = execCheck;
      // In shadow: tag as 'flagged' so dashboard shows ⚠️ not 🚫 — trade still logs for learning
      if (CONFIG.mode === 'shadow' && !execCheck.approved) {
        execCheck._shadowFlagged = true;
      }
      if (CONFIG.mode !== 'shadow') {
        // In live/testnet: block or adjust on bad execution conditions
        if (!execCheck.approved) {
          log(`${signal.asset}: ${execCheck.narrative}`, 'warn');
          logDecision(signal, 'SKIP', 0, CONFIG.mode);
          continue;
        }
        if (execCheck.adjustedSize < finalAmount) {
          log(`${signal.asset}: size adjusted $${finalAmount.toFixed(2)} → $${execCheck.adjustedSize.toFixed(2)} (${execCheck.reason})`, 'warn');
          execAmount = execCheck.adjustedSize;
        }
      }
      if (execCheck.reason !== 'clean') {
        log(`${signal.asset}: exec check — ${execCheck.narrative}`, 'info');
      }
    } catch (e) {
      log(`Execution check failed for ${signal.asset}: ${e.message} — proceeding`, 'warn');
    }

    // Attach sizing metadata to signal for notifications
    signal._sizeFormula   = sizeResult.formula;
    signal._sizeBreakdown = sizeResult.breakdown;
    signal._sectorCheck   = sectorCheck;
    signal._ddCheck       = ddCheck;

    // ── Shadow ────────────────────────────────────────────────
    if (CONFIG.mode === 'shadow') {
      logDecision(signal, 'BUY', execAmount, 'shadow');
      await notifyShadowDecision(signal, execAmount).catch(() => {});
      log(`[SHADOW] Would buy $${execAmount.toFixed(2)} of ${signal.asset} — ${signal.confidence}% | ${signal.strategy} | ${sizeResult.formula.split('|').pop().trim()}`, 'shadow');
      dailySpent += execAmount; // shadow — tracked for learning but NOT budget gate
      actionsTaken++;
      // Persist shadow spend separately — does NOT count toward real budget
      try {
        const { readFileSync: rfs, writeFileSync: wfs, existsSync: efs } = await import('fs');
        const sp = './logs/settings.json';
        if (efs(sp)) {
          const ss = JSON.parse(rfs(sp, 'utf8'));
          // _todaySpent = real spend only; _todayShadowSpent = shadow simulation
          wfs(sp, JSON.stringify({ ...ss, _todaySpent: dailyRealSpent, _todayShadowSpent: dailySpent }, null, 2));
        }
      } catch {}
      continue;
    }

    // ── Testnet ───────────────────────────────────────────────
    if (CONFIG.mode === 'testnet') {
      if (usdtBalance < execAmount) {
        logDecision(signal, 'SKIP', 0, 'testnet');
        continue;
      }
      try {
        const { placeBuyOrder } = await import('./binance/client.js');
        const order = await placeBuyOrder(signal.symbol, execAmount);
        dailySpent += execAmount;
        dailyRealSpent += execAmount; // counts toward real budget gate
        logDecision(signal, 'BUY', execAmount, 'testnet');
        await notifyTestnetDecision(signal, execAmount, order).catch(() => {});
        log(`[TESTNET] Bought $${finalAmount.toFixed(2)} of ${signal.asset} — Order ${order.orderId}`, 'testnet');
        actionsTaken++;
      } catch (e) {
        log(`Testnet order failed: ${e.message}`, 'error');
        await sendMessage(`🧪 Testnet order failed: *${signal.asset}* — ${e.message}`).catch(() => {});
        logDecision(signal, 'SKIP', 0, 'testnet');
      }
      continue;
    }

    // ── Live ──────────────────────────────────────────────────
    if (CONFIG.mode === 'live') {
      if (usdtBalance < execAmount) {
        logDecision(signal, 'SKIP', 0, 'live');
        continue;
      }
      let approved = true;
      if (execAmount >= CONFIG.approvalThreshold) {
        approved = await requestApproval(signal, execAmount);
      }
      if (!approved) { logDecision(signal, 'REJECTED', 0, 'live'); continue; }

      try {
        const { placeBuyOrder } = await import('./binance/client.js');
        const order = await placeBuyOrder(signal.symbol, execAmount);
        dailySpent += execAmount;
        dailyRealSpent += execAmount; // counts toward real budget gate
        logDecision(signal, 'BUY', execAmount, 'live');
        await notifyTradeExecuted(signal, execAmount, order).catch(() => {});
        log(`[LIVE] Bought $${finalAmount.toFixed(2)} of ${signal.asset}`, 'live');
        actionsTaken++;
      } catch (e) {
        log(`Live order failed: ${e.message}`, 'error');
        await sendMessage(`❌ Live order failed: *${signal.asset}* — ${e.message}`).catch(() => {});
        logDecision(signal, 'SKIP', 0, 'live');
      }
    }
  }

  // Log all skipped
  for (const s of scores.filter(s => !rankedActionable.find(a => a.asset === s.asset))) {
    logDecision(s, 'SKIP', 0, CONFIG.mode);
  }

  log(`Cycle complete. Real: $${dailyRealSpent.toFixed(2)}/$${CONFIG.maxDailySpend} | Shadow sim: $${dailySpent.toFixed(2)} | ${actionsTaken} trades | Heat: ${portfolio.heatLevel}`, 'success');
  reportCycleResult(actionsTaken, CONFIG.maxDailySpend - dailyRealSpent);
}

// ── Weekly Report ─────────────────────────────────────────────────
async function sendWeeklyReport() {
  try {
    const report  = generateWeeklyReport();
    const lessons = getRecentLessons(3);
    const rlState = getRLState();
    let msg = formatWeeklyReportTelegram(report);

    if (lessons.length > 0) {
      msg += `\n\n🧠 *Recent Lessons:*\n${lessons.map(l => `• ${l.lesson.slice(0, 100)}...`).join('\n')}`;
    }
    if (rlState.bestPattern) {
      msg += `\n\n🔁 *Best Pattern:* ${rlState.bestPattern.pattern} (×${rlState.bestPattern.weight.toFixed(2)} weight, ${rlState.bestPattern.winRate}% WR)`;
    }

    await sendMessage(msg);
    log('Weekly report sent', 'success');
  } catch (e) { log(`Weekly report failed: ${e.message}`, 'error'); }
}

// ── Startup ───────────────────────────────────────────────────────
async function start() {
  const modeIcon = { shadow: '👻', testnet: '🧪', live: '💸' }[CONFIG.mode] || '❓';

  console.log(chalk.yellow(`
  ██████╗   ██████╗  █████╗       ██████╗██╗      █████╗ ██╗    ██╗
  ██╔══██╗██╔════╝ ██╔══██╗    ██╔════╝██║     ██╔══██╗██║    ██║
  ██║  ██║██║     ███████║    ██║     ██║     ███████║██║ █╗ ██║
  ██║  ██║██║     ██╔══██║    ██║     ██║     ██╔══██║██║███╗██║
  ██████╔╝╚██████╗██║  ██║    ╚██████╗███████╗██║  ██║╚███╔███╔╝
  ╚═════╝  ╚═════╝╚═╝  ╚═╝     ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  🦞
                         v3.2 — OPENCLAW INTELLIGENCE
  `));

  console.log(chalk.cyan('  Mode:        ') + chalk.white(`${modeIcon} ${CONFIG.mode.toUpperCase()}`));
  console.log(chalk.cyan('  Risk:        ') + chalk.white(CONFIG.riskProfile.toUpperCase()));
  console.log(chalk.cyan('  Budget:      ') + chalk.white(`$${CONFIG.maxDailySpend}/day | $${CONFIG.baseDCAAmount}/trade`));
  console.log(chalk.cyan('  Signals:     ') + chalk.white('16 (+ Probabilistic Regime + Dynamic Weights)'));
  console.log(chalk.cyan('  Intelligence:') + chalk.white('RL + Adaptive ML + Bayesian P(win) + AI Reasoning (Claude)'));
  console.log(chalk.cyan('  Risk Engine: ') + chalk.white('ATR/Kelly sizing + Portfolio heat + Sector cap + Do-nothing gate'));
  console.log(chalk.cyan('  Execution:   ') + chalk.white('Bid-ask spread check + slippage estimation + spread-adjusted sizing'));
  console.log(chalk.cyan('  On-chain:    ') + chalk.white('Token Audit + Smart Money + Market Rank'));
  console.log(chalk.cyan('  Daily limit: ') + chalk.white('Auto-flip to shadow + midnight reset'));
  console.log(chalk.cyan('  Radar:       ') + chalk.white('5-min opportunity scanner running'));
  console.log('');

  // ── Init Telegram ─────────────────────────────────────────────
  try {
    const alertFn = (msg) => sendMessage(msg).catch(() => {});
    initBot(
      () => { log('Kill switch activated', 'warn'); stopRadar(); },
      async () => {
        log('Wizard complete — firing first scan', 'info');
        await runAgentCycle().catch(e => log(`First cycle error: ${e.message}`, 'error'));
      }
    );
    registerScanCallback(runAgentCycle);
    registerRadarCallbacks(
      () => initRadar(alertFn),
      () => stopRadar()
    );
  } catch (e) { log(`Telegram init failed: ${e.message}`, 'warn'); }

  // ── Init Radar ────────────────────────────────────────────────
  try {
    initRadar((msg) => sendMessage(msg).catch(() => {}));
    log('Opportunity radar started (5-min interval)', 'radar');
  } catch (e) { log(`Radar init failed: ${e.message}`, 'warn'); }

  // ── Startup message ───────────────────────────────────────────
  await sendMessage(
    `🦞 *DCA CLAW v3.2 ONLINE*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Mode: ${modeIcon} ${CONFIG.mode.toUpperCase()}\n` +
    `Risk: ${CONFIG.riskProfile.toUpperCase()}\n` +
    `Budget: $${CONFIG.maxDailySpend}/day | $${CONFIG.baseDCAAmount}/trade\n\n` +
    `🧠 *Intelligence active:*\n` +
    `• 16-signal engine (Probabilistic regime + Dynamic weights)\n` +
    `• RL + Adaptive signal weights + Confidence calibration\n` +
    `• ATR/Kelly sizing + Portfolio heat + Sector cap\n` +
    `• Do-nothing gate + Drawdown memory\n` +
    `• Stablecoin/forex filter active\n\n` +
    `🔭 Opportunity radar active — instant alerts every 5 min\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Send \`HELP\` for all commands.`
  ).catch(e => log(`Startup message failed: ${e.message}`, 'warn'));

  // ── First cycle ───────────────────────────────────────────────
  const settings = loadConfig();
  if (settings.wizardComplete) {
    log('Settings found — firing first scan immediately', 'info');
    await runAgentCycle().catch(e => log(`First cycle error: ${e.message}`, 'error'));
  } else {
    log('First launch — waiting for wizard to complete', 'info');
    await runFirstLaunchWizard().catch(() => {});
  }

  // ── Cron scheduler ────────────────────────────────────────────
  cron.schedule(CONFIG.cronSchedule, async () => {
    try { await runAgentCycle(); }
    catch (e) { log(`Cycle error: ${e.message}`, 'error'); }
  });
  log(`Scheduled: ${CONFIG.cronSchedule}`, 'success');

  // Weekly report
  cron.schedule(CONFIG.weeklyCron, sendWeeklyReport);
}

start().catch(e => { console.error('Fatal startup error:', e); process.exit(1); });