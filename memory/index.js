// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Memory & Learning Engine
//
//  Upgrades from v2.1:
//   - Returns resolved trades array from updatePnLAndLearn
//     (used by index.js to fire RL reward updates)
//   - Stores strategy, sentiment score, smart money score
//     in trade log for richer lesson distillation
//   - Enhanced weekly report with sentiment + strategy breakdown
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { learnFromNewsOutcome } from '../intelligence/news.js';
import { computeExtension } from '../intelligence/extension.js';
import dayjs from 'dayjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR       = join(__dirname, '../logs');
const TRADES_FILE    = join(LOGS_DIR, 'shadow_trades.json');
const MEMORY_FILE    = join(LOGS_DIR, 'memory.json');
const PORTFOLIO_FILE = join(LOGS_DIR, 'portfolio.json');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const REAL_URL = 'https://api.binance.com';
const BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision';

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(path, data) { writeFileSync(path, JSON.stringify(data, null, 2)); }

// ── Trade logging ─────────────────────────────────────────────────

export function logDecision(signal, action, amount, mode) {
  const db = readJSON(TRADES_FILE, { trades: [] });
  const id = `${signal.asset}_${Date.now()}`;

  const trade = {
    id,
    timestamp:        signal.timestamp || new Date().toISOString(),
    asset:            signal.asset,
    symbol:           signal.symbol,
    action,
    mode,
    priceAtDecision:  signal.currentPrice,
    priceChangePct:   signal.priceChangePct,
    rsi:              signal.rsi,
    rsi4h:            signal.rsi4h || null,
    regime:           signal.regime,
    confidence:       signal.confidence,
    effectiveThreshold: signal.effectiveThreshold,
    wouldBuy:         action === 'BUY',
    wouldSpendUSDT:   amount,
    confidenceBreakdown: signal.breakdown || [],
    eli5:             signal.eli5 || '',
    patternKey:       signal.patternKey,
    btcPctAtDecision: signal.btcHealth?.pct || null,
    // v3 additions:
    strategy:         signal.strategy || 'DIP_BUYER',
    sentimentScore:   signal.sentimentScore || 0,
    fearGreedValue:   signal.fearGreed?.value || null,
    smartMoneyScore:  signal.smartMoneyScore || 0,
    rlWeight:         signal.rlWeight || 1.0,
    signals: {
      rsi1h:       signal.rsi,
      rsi4h:       signal.rsi4h,
      btcRegime:   signal.btcHealth?.pct <= -8 ? 'CRASH' : signal.btcHealth?.pct >= 5 ? 'UP' : 'NEUTRAL',
      sentiment:   signal.sentimentScore,
      smartMoney:  signal.smartMoneyScore,
    },
    rawSignals:     signal.rawSignals    || null,
    // v3.2 signal data for extension engine
    volatility:     signal.volatility   || null,
    fundingRate:    signal.fundingRate  || null,
    newsScore:      signal.newsScore    || 0,
    sessionContext: signal.sessionContext || null,
    dominantRegime: signal.dominantRegime || signal.regime || 'NEUTRAL',
    // Execution quality (from smart.js spread/slippage check):
    spread:         signal._execCheck?.spread     ?? null,
    slippage:       signal._execCheck?.slippage   ?? null,
    _execCheck:     signal._execCheck             || null,
    // AI Reasoning (Claude / Ollama / fallback):
    _reasoning:     signal._reasoning             || null,
    // ML probability:
    mlProbability:  signal.mlProbability          ?? null,
    mlNarrative:    signal.mlNarrative            || null,
    mlSource:       signal.mlSource               || null,
    aiVerdict:      signal._aiVerdict              || null,
    alphaScore:     signal.alphaScore               ?? null,
    alphaFound:     signal.alphaFound               ?? null,
    futuresScore:   signal.futuresScore             ?? null,
    futuresListed:  signal.futuresListed            ?? null,
    oiTrend:        signal.oiTrend                  || null,
    takerRatio:     signal.takerRatio               ?? null,
    // Dynamic signal weights (for heatmap):
    weightedSignals: signal.weightedSignals       || null,
    signalWeights:   signal.signalWeights         || null,
    // Binance AI Skills results:
    auditResult:     signal.auditResult           || null,
    tokenInfoResult: signal.tokenInfoResult       || null,
    // Sizing breakdown:
    _sizeBreakdown:  signal._sizeBreakdown        || null,
    _sizeFormula:    signal._sizeFormula          || null,
    // Sizing context:
    ddCheck:         signal._ddCheck              || null,
    // Filled later:
    priceAfter24h:  null,
    priceAfter7d:   null,
    pnlPct24h:      null,
    pnlPct7d:       null,
    outcome:        null,
    // Extension tracking:
    extended:       false,
    extendedUntil:  null,
    extensionReason: null,
  };

  db.trades.push(trade);
  writeJSON(TRADES_FILE, db);
  return trade;
}

// ── Price fetcher (single symbol, short timeout) ─────────────────

async function getCurrentPrice(symbol) {
  for (const base of [REAL_URL, BASE_URL]) {
    try {
      const r = await axios.get(`${base}/api/v3/ticker/price`, { params: { symbol }, timeout: 4000 });
      return parseFloat(r.data.price);
    } catch {}
  }
  return null;
}

// ── Batch price fetcher — fetches all needed symbols in parallel ───
// Uses /api/v3/ticker/price with no symbol = returns ALL prices in one call

async function getBatchPrices(symbols) {
  const unique = [...new Set(symbols)].map(s => s + 'USDT').filter(s => s !== 'USDTUSDT');
  const priceMap = {};
  try {
    // Single call — returns array of all ~2000 pairs
    const r = await axios.get(`${REAL_URL}/api/v3/ticker/price`, { timeout: 8000 });
    for (const item of r.data) {
      priceMap[item.symbol] = parseFloat(item.price);
    }
    return priceMap;
  } catch {
    // Fallback: fetch each individually but in parallel (still faster than sequential)
    console.log('[Memory] Batch price fetch failed, falling back to parallel individual fetches');
    const results = await Promise.allSettled(
      unique.map(sym => getCurrentPrice(sym.replace('USDT','')).then(p => ({ sym, p })))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.p) priceMap[r.value.sym] = r.value.p;
    }
    return priceMap;
  }
}

// ── PnL updater — returns resolved trades for RL ──────────────────

export async function updatePnLAndLearn() {
  const db  = readJSON(TRADES_FILE, { trades: [] });
  const mem = readJSON(MEMORY_FILE, { patterns: {}, totalLearned: 0 });

  let updated = 0;
  const newlyResolved = [];

  // ── Pre-fetch all prices in one batch call ───────────────────
  const activeTrades = db.trades.filter(t => t.wouldBuy && t.priceAtDecision);
  const needsPrice   = activeTrades.filter(t => {
    const age = dayjs().diff(dayjs(t.timestamp), 'hour');
    return (t.priceAfter24h === null && age >= 23) || (t.priceAfter7d === null && age >= 167);
  });

  let priceMap = {};
  if (needsPrice.length > 0) {
    const symbols = needsPrice.map(t => t.asset || t.symbol?.replace('USDT',''));
    console.log(`[Memory] Fetching prices for ${symbols.length} trade(s): ${[...new Set(symbols)].join(', ')}`);
    priceMap = await getBatchPrices(symbols);
    console.log(`[Memory] Got ${Object.keys(priceMap).length} prices from Binance`);
  } else {
    console.log('[Memory] No trades need price resolution — skipping fetch');
  }

  for (const trade of db.trades) {
    if (!trade.wouldBuy || !trade.priceAtDecision) continue;
    const age = dayjs().diff(dayjs(trade.timestamp), 'hour');
    // Look up from pre-fetched batch
    const sym = (trade.asset || (trade.symbol||'').replace('USDT','')) + 'USDT';
    const price = priceMap[sym] ?? null;

    if (trade.priceAfter24h === null && age >= 23) {
      if (price) {
        trade.priceAfter24h = price;
        trade.pnlPct24h = parseFloat(((price - trade.priceAtDecision) / trade.priceAtDecision * 100).toFixed(2));
        updated++;
      }
    }

    if (trade.priceAfter7d === null && age >= 167) {
      if (price) {
        trade.priceAfter7d = price;
        trade.pnlPct7d = parseFloat(((price - trade.priceAtDecision) / trade.priceAtDecision * 100).toFixed(2));
        updated++;
      }
    }

    if (trade.priceAfter24h !== null && trade.outcome === null) {
      // ── Dynamic extension check ────────────────────────────────
      const now = Date.now();
      const alreadyExtended = trade.extended;
      const extendedUntilMs = trade.extendedUntil ? new Date(trade.extendedUntil).getTime() : 0;
      const extensionStillActive = alreadyExtended && now < extendedUntilMs;

      if (extensionStillActive) {
        // Still in extension window — wait, don't resolve yet
        continue;
      }

      if (!alreadyExtended) {
        // First time at 24h — check if we should extend
        const ext = computeExtension(trade, trade.pnlPct24h);
        if (ext.shouldExtend) {
          trade.extended       = true;
          trade.extendedUntil  = ext.resolveAt;
          trade.extensionReason = ext.reason;
          updated++;
          console.log(`[Memory] ${trade.asset} extended ${ext.extensionHours}h: ${ext.reason}`);
          continue; // Don't resolve yet
        }
      }

      // Resolve: either no extension needed, or extension window passed
      trade.outcome = trade.pnlPct24h >= 0 ? 'WIN' : 'LOSS';
      // ── News learning feedback ───────────────────────────────
      try {
        learnFromNewsOutcome(trade.outcome, trade.newsScore || 0, trade.newsAlerts || []);
      } catch {}

      // Update pattern memory
      const key = trade.patternKey || `${trade.regime}_NEUTRAL`;
      if (!mem.patterns[key]) {
        mem.patterns[key] = { wins: 0, losses: 0, total: 0, adjustedThreshold: 35, history: [] };
      }
      const p = mem.patterns[key];
      if (trade.outcome === 'WIN') p.wins++; else p.losses++;
      p.total++;
      mem.totalLearned = (mem.totalLearned || 0) + 1;

      p.history = [...(p.history || []), {
        ts: trade.timestamp, outcome: trade.outcome,
        confidence: trade.confidence, pnl: trade.pnlPct24h,
      }].slice(-20);

      if (p.total >= 10) {
        const wr = p.wins / p.total;
        if      (wr >= 0.80) p.adjustedThreshold = Math.max(20, p.adjustedThreshold - 3);
        else if (wr >= 0.65) p.adjustedThreshold = Math.max(25, p.adjustedThreshold - 1);
        else if (wr <  0.35) p.adjustedThreshold = Math.min(70, p.adjustedThreshold + 4);
        else if (wr <  0.50) p.adjustedThreshold = Math.min(60, p.adjustedThreshold + 2);
      }

      newlyResolved.push(trade); // return to index.js for RL updates
    }
  }

  if (updated > 0) {
    writeJSON(TRADES_FILE, db);
    mem.lastUpdated = new Date().toISOString();
    writeJSON(MEMORY_FILE, mem);
    updatePortfolioSnapshot(db.trades);
    console.log(`[Memory] Updated ${updated} trades, ${Object.keys(mem.patterns).length} patterns learned`);
  }

  return newlyResolved; // ← v3: return for RL processing in index.js
}

// ── Portfolio tracker ─────────────────────────────────────────────

function updatePortfolioSnapshot(trades) {
  const buys = trades.filter(t => t.wouldBuy && t.pnlPct24h !== null);
  if (!buys.length) return;

  let portfolioValue = 1000;
  const snapshots = [];

  for (const t of buys.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
    const invested = t.wouldSpendUSDT || 50;
    const gain = invested * (t.pnlPct24h / 100);
    portfolioValue += gain;
    snapshots.push({
      date: t.timestamp.slice(0, 10),
      value: parseFloat(portfolioValue.toFixed(2)),
      trade: `${t.asset} ${t.pnlPct24h >= 0 ? '+' : ''}${t.pnlPct24h?.toFixed(2)}%`,
      strategy: t.strategy || 'DIP_BUYER',
    });
  }

  writeJSON(PORTFOLIO_FILE, { snapshots, current: portfolioValue });
}

// ── Getters ───────────────────────────────────────────────────────

export function getMemoryPatterns() {
  return readJSON(MEMORY_FILE, { patterns: {} }).patterns || {};
}

export function getPatternThreshold(patternKey) {
  const mem = readJSON(MEMORY_FILE, { patterns: {} });
  return mem.patterns?.[patternKey]?.adjustedThreshold ?? 35;
}

export function getPortfolioHistory() {
  return readJSON(PORTFOLIO_FILE, { snapshots: [], current: 1000 });
}

// ── Weekly Report ─────────────────────────────────────────────────

export function generateWeeklyReport() {
  const db   = readJSON(TRADES_FILE, { trades: [] });
  const mem  = readJSON(MEMORY_FILE, { patterns: {} });
  const port = readJSON(PORTFOLIO_FILE, { snapshots: [], current: 1000 });

  const weekAgo    = dayjs().subtract(7, 'day');
  const weekTrades = db.trades.filter(t => dayjs(t.timestamp).isAfter(weekAgo));
  const weekBuys   = weekTrades.filter(t => t.wouldBuy);
  const resolved   = weekBuys.filter(t => t.outcome);
  const wins       = resolved.filter(t => t.outcome === 'WIN');

  // Strategy breakdown
  const byStrategy = {};
  for (const t of resolved) {
    const s = t.strategy || 'DIP_BUYER';
    if (!byStrategy[s]) byStrategy[s] = { wins: 0, total: 0 };
    byStrategy[s].total++;
    if (t.outcome === 'WIN') byStrategy[s].wins++;
  }

  return {
    period:          `${weekAgo.format('MMM D')} – ${dayjs().format('MMM D, YYYY')}`,
    totalDecisions:  weekTrades.length,
    buyDecisions:    weekBuys.length,
    resolvedTrades:  resolved.length,
    winRate:         resolved.length > 0 ? (wins.length / resolved.length * 100).toFixed(0) : 'N/A',
    wins:            wins.length,
    losses:          resolved.length - wins.length,
    totalSpent:      weekBuys.reduce((s, t) => s + (t.wouldSpendUSDT || 0), 0).toFixed(2),
    bestTrade:       resolved.length ? resolved.reduce((a, b) => b.pnlPct24h > a.pnlPct24h ? b : a) : null,
    worstTrade:      resolved.length ? resolved.reduce((a, b) => b.pnlPct24h < a.pnlPct24h ? b : a) : null,
    patternsLearned: Object.keys(mem.patterns || {}).length,
    totalLearned:    mem.totalLearned || 0,
    portfolioValue:  port.current?.toFixed(2) || '1000.00',
    strategyBreakdown: byStrategy,
  };
}

export function formatWeeklyReportTelegram(r) {
  const best  = r.bestTrade  ? `${r.bestTrade.asset} +${r.bestTrade.pnlPct24h?.toFixed(2)}%`  : '—';
  const worst = r.worstTrade ? `${r.worstTrade.asset} ${r.worstTrade.pnlPct24h?.toFixed(2)}%` : '—';

  const stratLines = Object.entries(r.strategyBreakdown || {})
    .map(([s, d]) => `  ${s}: ${d.total > 0 ? Math.round(d.wins/d.total*100) : '—'}% WR (${d.total} trades)`)
    .join('\n');

  return `🦞 *DCA CLAW v3 — Weekly Report*
📅 ${r.period}
━━━━━━━━━━━━━━━━━━━━━
📊 *Performance*
Decisions: ${r.totalDecisions} | Buys: ${r.buyDecisions}
Resolved: ${r.resolvedTrades} | Win rate: *${r.winRate}%* (${r.wins}W/${r.losses}L)
Would have spent: $${r.totalSpent} USDT
━━━━━━━━━━━━━━━━━━━━━
🏆 Best: ${best}
💔 Worst: ${worst}
━━━━━━━━━━━━━━━━━━━━━
🎯 *Strategy Breakdown*
${stratLines || '  No resolved trades yet'}
━━━━━━━━━━━━━━━━━━━━━
🧠 *Intelligence*
Patterns learned: ${r.patternsLearned}
Total trades learned: ${r.totalLearned}
━━━━━━━━━━━━━━━━━━━━━
💼 *Portfolio Simulator*
If you had followed every signal:
*$${r.portfolioValue} USDT* (started $1,000)
━━━━━━━━━━━━━━━━━━━━━
_Shadow mode — no real money moved_`;
}

export default {
  logDecision, updatePnLAndLearn,
  getMemoryPatterns, getPatternThreshold,
  getPortfolioHistory, generateWeeklyReport, formatWeeklyReportTelegram,
};