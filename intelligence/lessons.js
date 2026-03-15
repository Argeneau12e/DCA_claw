// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Lesson Distillation Module
//
//  After every 10 resolved trades, analyses patterns and writes
//  human-readable lessons to logs/lessons.json.
//
//  These lessons feed back into the agent's context and are
//  displayed in the dashboard and Telegram weekly report.
//
//  No Claude API needed — pure rule-based analysis.
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = join(__dirname, '../logs/shadow_trades.json');
const LESSONS_FILE = join(__dirname, '../logs/lessons.json');

// ── Load data ─────────────────────────────────────────────────────

function loadTrades() {
  try {
    if (existsSync(TRADES_FILE)) {
      return JSON.parse(readFileSync(TRADES_FILE, 'utf8')).trades || [];
    }
  } catch {}
  return [];
}

function loadLessons() {
  try {
    if (existsSync(LESSONS_FILE)) return JSON.parse(readFileSync(LESSONS_FILE, 'utf8'));
  } catch {}
  return { lessons: [], lastAnalysedCount: 0, generatedAt: null };
}

function saveLessons(data) {
  writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ── Check if we should distil new lessons ────────────────────────

export function shouldDistilLessons() {
  const trades = loadTrades();
  const resolved = trades.filter(t => t.outcome && t.action === 'BUY');
  const existing = loadLessons();
  return resolved.length >= existing.lastAnalysedCount + 3;
}

// ── Main lesson distillation ──────────────────────────────────────

export function distilLessons() {
  const trades = loadTrades();
  const resolved = trades.filter(t => t.outcome && t.action === 'BUY' && t.pnlPct24h != null);

  if (resolved.length < 5) return null; // not enough data yet

  const existing = loadLessons();
  const newLessons = [];

  // ── Lesson 1: Best/worst regimes ─────────────────────────────
  const byRegime = groupBy(resolved, 'regime');
  for (const [regime, trades] of Object.entries(byRegime)) {
    if (trades.length < 3) continue;
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const winRate = Math.round(wins / trades.length * 100);
    const avgPnl = avg(trades.map(t => t.pnlPct24h));

    if (winRate >= 70) {
      newLessons.push({
        type: 'REGIME_STRENGTH',
        lesson: `${regime} regime has ${winRate}% win rate across ${trades.length} trades (avg ${avgPnl > 0 ? '+' : ''}${avgPnl.toFixed(1)}% PnL). Maintain or increase aggression in ${regime} conditions.`,
        regime,
        winRate,
        avgPnl,
        confidence: 'HIGH',
        tradeCount: trades.length,
      });
    } else if (winRate <= 35) {
      newLessons.push({
        type: 'REGIME_WEAKNESS',
        lesson: `${regime} regime has only ${winRate}% win rate across ${trades.length} trades (avg ${avgPnl.toFixed(1)}% PnL). Be more selective or raise threshold in ${regime} conditions.`,
        regime,
        winRate,
        avgPnl,
        confidence: 'HIGH',
        tradeCount: trades.length,
      });
    }
  }

  // ── Lesson 2: BTC correlation impact ─────────────────────────
  const btcCrashTrades = resolved.filter(t => t.signals?.btcRegime === 'CRASH' || t.signals?.btcCorrelation < 0);
  if (btcCrashTrades.length >= 3) {
    const wins = btcCrashTrades.filter(t => t.outcome === 'WIN').length;
    const winRate = Math.round(wins / btcCrashTrades.length * 100);
    if (winRate <= 40) {
      newLessons.push({
        type: 'BTC_CRASH_RISK',
        lesson: `Buying altcoins during BTC crash regime has only ${winRate}% win rate (${btcCrashTrades.length} trades). The BTC correlation filter is working correctly — trust it and avoid buying when BTC is crashing.`,
        winRate,
        confidence: 'HIGH',
        tradeCount: btcCrashTrades.length,
      });
    }
  }

  // ── Lesson 3: Best performing assets ─────────────────────────
  const byAsset = groupBy(resolved, 'asset');
  const assetStats = Object.entries(byAsset)
    .filter(([, t]) => t.length >= 2)
    .map(([asset, trades]) => ({
      asset,
      winRate: Math.round(trades.filter(t => t.outcome === 'WIN').length / trades.length * 100),
      avgPnl: avg(trades.map(t => t.pnlPct24h)),
      count: trades.length,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  if (assetStats.length >= 2) {
    const best = assetStats[0];
    const worst = assetStats[assetStats.length - 1];
    if (best.winRate >= 75) {
      newLessons.push({
        type: 'BEST_ASSET',
        lesson: `${best.asset} has been the most reliable asset with ${best.winRate}% win rate across ${best.count} trades (avg +${best.avgPnl.toFixed(1)}%). Prioritise ${best.asset} entries when signals align.`,
        asset: best.asset,
        winRate: best.winRate,
        confidence: best.count >= 5 ? 'HIGH' : 'MEDIUM',
        tradeCount: best.count,
      });
    }
    if (worst.winRate <= 30 && worst.count >= 3) {
      newLessons.push({
        type: 'WORST_ASSET',
        lesson: `${worst.asset} has been the least reliable with only ${worst.winRate}% win rate across ${worst.count} trades (avg ${worst.avgPnl.toFixed(1)}%). Consider raising the confidence threshold for ${worst.asset} entries.`,
        asset: worst.asset,
        winRate: worst.winRate,
        confidence: 'MEDIUM',
        tradeCount: worst.count,
      });
    }
  }

  // ── Lesson 4: Confidence score calibration ────────────────────
  const highConf = resolved.filter(t => t.confidence >= 75);
  const lowConf = resolved.filter(t => t.confidence < 55);
  if (highConf.length >= 3 && lowConf.length >= 3) {
    const highWr = Math.round(highConf.filter(t => t.outcome === 'WIN').length / highConf.length * 100);
    const lowWr = Math.round(lowConf.filter(t => t.outcome === 'WIN').length / lowConf.length * 100);
    if (highWr > lowWr + 20) {
      newLessons.push({
        type: 'CONFIDENCE_CALIBRATION',
        lesson: `High confidence trades (≥75%) win ${highWr}% of the time vs ${lowWr}% for low confidence (<55%). The confidence engine is well-calibrated. Trust the high-confidence signals more.`,
        highConfWinRate: highWr,
        lowConfWinRate: lowWr,
        confidence: 'HIGH',
      });
    }
  }

  // ── Lesson 5: Time-based patterns ────────────────────────────
  const hourGroups = groupBy(resolved, t => new Date(t.timestamp).getUTCHours());
  const hourStats = Object.entries(hourGroups)
    .filter(([, t]) => t.length >= 3)
    .map(([hour, trades]) => ({
      hour: parseInt(hour),
      winRate: Math.round(trades.filter(t => t.outcome === 'WIN').length / trades.length * 100),
      count: trades.length,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  if (hourStats.length >= 3) {
    const bestHour = hourStats[0];
    if (bestHour.winRate >= 70) {
      newLessons.push({
        type: 'TIMING',
        lesson: `Trades entered around ${bestHour.hour}:00 UTC have ${bestHour.winRate}% win rate (${bestHour.count} trades). Market conditions tend to be more favourable at this hour.`,
        bestHour: bestHour.hour,
        winRate: bestHour.winRate,
        confidence: 'MEDIUM',
      });
    }
  }

  if (newLessons.length === 0) return null;

  // Save — append new lessons, don't overwrite
  const allLessons = existing.lessons || [];
  const timestamped = newLessons.map(l => ({
    ...l,
    id: `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    generatedAt: new Date().toISOString(),
    basedOnTrades: resolved.length,
  }));

  const updated = {
    lessons: [...allLessons, ...timestamped].slice(-50), // keep last 50 lessons
    lastAnalysedCount: resolved.length,
    generatedAt: new Date().toISOString(),
    totalLessons: allLessons.length + timestamped.length,
  };

  saveLessons(updated);
  return timestamped;
}

// ── Get recent lessons (for Telegram + dashboard) ─────────────────

export function getRecentLessons(count = 5) {
  const data = loadLessons();
  return (data.lessons || []).slice(-count).reverse();
}

// ── Helpers ───────────────────────────────────────────────────────

function groupBy(arr, keyFn) {
  const fn = typeof keyFn === 'string' ? item => item[keyFn] : keyFn;
  return arr.reduce((acc, item) => {
    const key = fn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ── Best/worst trade deep analysis — runs whenever either changes ──
export function analyseExtremes() {
  const trades  = loadTrades();
  const resolved = trades.filter(t => t.outcome && t.pnlPct24h != null && t.action === 'BUY');
  if (resolved.length < 3) return null;

  const sorted   = [...resolved].sort((a, b) => b.pnlPct24h - a.pnlPct24h);
  const best     = sorted[0];
  const worst    = sorted[sorted.length - 1];
  const existing = loadLessons();
  const prevBest  = existing.bestTrade;
  const prevWorst = existing.worstTrade;

  // Only re-analyse if best or worst has actually changed
  const bestChanged  = !prevBest  || prevBest.id  !== best.id;
  const worstChanged = !prevWorst || prevWorst.id !== worst.id;
  if (!bestChanged && !worstChanged) return null;

  const newLessons = [];

  // ── Best trade analysis ──────────────────────────────────────
  if (bestChanged) {
    const signals = best.rawSignals || {};
    const topSignals = Object.entries(signals)
      .filter(([, v]) => v > 5)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim());

    newLessons.push({
      type: 'BEST_TRADE',
      lesson: `Best trade: ${best.asset} returned +${best.pnlPct24h.toFixed(2)}% in ${(best.dominantRegime||best.regime||'?')} regime at ${best.confidence}% confidence. ` +
        `Strong signals: ${topSignals.length ? topSignals.join(', ') : 'high overall score'}. ` +
        `Strategy: ${best.strategy||'DIP_BUYER'}. ` +
        `Entered ${best.sessionContext?.session||'unknown'} session. ` +
        `Replicate these conditions: ${(best.dominantRegime||best.regime)} + ${best.strategy||'DIP_BUYER'} + confidence ≥ ${Math.max(50, best.confidence - 10)}%.`,
      tradeId:   best.id,
      asset:     best.asset,
      pnl:       best.pnlPct24h,
      regime:    best.dominantRegime || best.regime,
      confidence: best.confidence,
      strategy:  best.strategy,
      confidence: 'HIGH',
      tradeCount: 1,
    });
  }

  // ── Worst trade analysis ─────────────────────────────────────
  if (worstChanged) {
    const signals = worst.rawSignals || {};
    const weakSignals = Object.entries(signals)
      .filter(([, v]) => v < -3)
      .sort(([, a], [, b]) => a - b)
      .slice(0, 3)
      .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim());

    // Compare worst to best — what was different?
    const bestConf  = best.confidence  || 0;
    const worstConf = worst.confidence || 0;
    const confDiff  = bestConf - worstConf;
    const regimeDiff = (best.dominantRegime||best.regime) !== (worst.dominantRegime||worst.regime);

    newLessons.push({
      type: 'WORST_TRADE',
      lesson: `Worst trade: ${worst.asset} returned ${worst.pnlPct24h.toFixed(2)}% in ${(worst.dominantRegime||worst.regime||'?')} regime at ${worst.confidence}% confidence. ` +
        `Warning signals: ${weakSignals.length ? weakSignals.join(', ') : 'overall low score'}. ` +
        `${confDiff > 15 ? `Confidence was ${confDiff}pts lower than best trade — consider raising threshold in ${worst.dominantRegime||worst.regime} conditions. ` : ''}` +
        `${regimeDiff ? `Regime mismatch: best trade was in ${best.dominantRegime||best.regime}, worst in ${worst.dominantRegime||worst.regime}. ` : ''}` +
        `Avoid: ${worst.strategy||'DIP_BUYER'} in ${worst.dominantRegime||worst.regime} below ${worst.confidence + 10}% confidence.`,
      tradeId:   worst.id,
      asset:     worst.asset,
      pnl:       worst.pnlPct24h,
      regime:    worst.dominantRegime || worst.regime,
      confidence: worst.confidence,
      strategy:  worst.strategy,
      confidence: 'HIGH',
      tradeCount: 1,
    });

    // ── Cross-lesson: compare extremes to derive a rule ──────
    if (bestChanged && worstChanged) {
      const avgTop3    = sorted.slice(0, 3).reduce((a, t) => a + t.confidence, 0) / 3;
      const avgBottom3 = sorted.slice(-3).reduce((a, t) => a + t.confidence, 0) / 3;
      if (avgTop3 - avgBottom3 >= 10) {
        newLessons.push({
          type: 'CONFIDENCE_CALIBRATION',
          lesson: `Top 3 trades averaged ${avgTop3.toFixed(0)}% confidence vs bottom 3 at ${avgBottom3.toFixed(0)}%. ` +
            `A ${(avgTop3 - avgBottom3).toFixed(0)}pt confidence gap correlates with better outcomes. ` +
            `Current effective threshold should trend toward ${Math.round(avgTop3 - 5)}%+ for optimal selectivity.`,
          confidence: 'HIGH',
          tradeCount: resolved.length,
        });
      }
    }
  }

  if (!newLessons.length) return null;

  // Save — update extremes tracker and append lessons
  const allLessons = existing.lessons || [];
  const timestamped = newLessons.map(l => ({
    ...l,
    id: `extremes_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    generatedAt: new Date().toISOString(),
    basedOnTrades: resolved.length,
  }));

  // Remove old BEST_TRADE/WORST_TRADE lessons before adding new ones
  const filtered = allLessons.filter(l => l.type !== 'BEST_TRADE' && l.type !== 'WORST_TRADE');

  saveLessons({
    ...existing,
    lessons: [...filtered, ...timestamped].slice(-50),
    bestTrade:  { id: best.id,  pnl: best.pnlPct24h,  asset: best.asset  },
    worstTrade: { id: worst.id, pnl: worst.pnlPct24h, asset: worst.asset },
    lastExtremeAnalysis: new Date().toISOString(),
  });

  console.log(`[Lessons] Extreme analysis: best=${best.asset} +${best.pnlPct24h.toFixed(2)}%, worst=${worst.asset} ${worst.pnlPct24h.toFixed(2)}%`);
  return timestamped;
}


// ── AI Deep Learning Pass ─────────────────────────────────────────
// Sends full trade history to Claude/Ollama for strategic insights.
// Called from index.js every 5 resolved trades.

// ── Rule-based insight generator — runs when AI is unavailable ──────
function generateRuleBasedInsights(resolved, wins, losses, byRegime, byStrategy, aiFalse) {
  const insights = [];
  const winRate  = Math.round(wins.length / resolved.length * 100);
  const avgRet   = resolved.reduce((s,t)=>s+(t.pnlPct24h||0),0) / resolved.length;

  // 1. Find worst-performing regime
  const regimeEntries = Object.entries(byRegime).filter(([,d])=>d.total>=3);
  if (regimeEntries.length) {
    const worstRegime = regimeEntries.sort((a,b)=>(a[1].wins/a[1].total)-(b[1].wins/b[1].total))[0];
    const [rName, rData] = worstRegime;
    const rWR = Math.round(rData.wins/rData.total*100);
    if (rWR < 60) {
      insights.push({
        type: 'AI_INSIGHT',
        lesson: `${rName.replace(/_/g,' ')} regime has a ${rWR}% win rate across ${rData.total} trades — significantly below average. Consider raising the confidence threshold in this regime.`,
        actionable: `Set minimum confidence to ${Math.min(85, (resolved[0]?.effectiveThreshold||60)+10)}% when regime is ${rName}.`,
        confidence: 'HIGH',
      });
    }
  }

  // 2. AI false pass pattern
  if (aiFalse.length >= 2) {
    const avgFalsePct = aiFalse.reduce((s,t)=>s+(t.pnlPct24h||0),0)/aiFalse.length;
    insights.push({
      type: 'AI_INSIGHT',
      lesson: `AI approved ${aiFalse.length} trades that resulted in losses (avg ${avgFalsePct.toFixed(1)}% return). Common pattern: low confidence (${Math.round(aiFalse.reduce((s,t)=>s+(t.confidence||0),0)/aiFalse.length)}% avg) entries in volatile conditions.`,
      actionable: 'Increase minimum confidence threshold by 5pts for any AI-approved trade in HIGH_VOLATILITY or PUMP regimes.',
      confidence: 'HIGH',
    });
  }

  // 3. Best-performing strategy
  const stratEntries = Object.entries(byStrategy).filter(([,d])=>d.total>=3);
  if (stratEntries.length >= 2) {
    const bestStrat  = stratEntries.sort((a,b)=>(b[1].wins/b[1].total)-(a[1].wins/a[1].total))[0];
    const worstStrat = stratEntries.sort((a,b)=>(a[1].wins/a[1].total)-(b[1].wins/b[1].total))[0];
    const [bName, bData] = bestStrat;
    const [wName, wData] = worstStrat;
    if (bName !== wName) {
      insights.push({
        type: 'AI_INSIGHT',
        lesson: `${bName.replace(/_/g,' ')} strategy achieves ${Math.round(bData.wins/bData.total*100)}% WR vs ${Math.round(wData.wins/wData.total*100)}% for ${wName.replace(/_/g,' ')}. Capital allocation should reflect this performance gap.`,
        actionable: `Increase position size multiplier for ${bName} by 10-15% and reduce for ${wName} in neutral regimes.`,
        confidence: 'MEDIUM',
      });
    }
  }

  // 4. Win streak / drawdown pattern
  let maxDrawdown = 0; let drawdownStart = null; let ddCount = 0;
  let maxLossRun = 0; let curLossRun = 0;
  resolved.forEach(t => {
    if (t.outcome === 'LOSS') { curLossRun++; maxLossRun = Math.max(maxLossRun, curLossRun); }
    else curLossRun = 0;
  });
  if (maxLossRun >= 3) {
    insights.push({
      type: 'AI_INSIGHT',
      lesson: `The agent experienced a run of ${maxLossRun} consecutive losses in this dataset. This suggests regime-shift risk is not being detected fast enough — the agent needs a circuit breaker.`,
      actionable: `After ${Math.max(2,maxLossRun-1)} consecutive losses, automatically raise confidence threshold by 10pts until a WIN resets the counter.`,
      confidence: 'HIGH',
    });
  }

  // 5. Overall assessment
  insights.push({
    type: 'AI_INSIGHT',
    lesson: `Overall win rate is ${winRate}% with avg 24h return of ${avgRet.toFixed(2)}% across ${resolved.length} resolved trades. ${winRate>=75?'Performance is strong — focus on maintaining edge in trending regimes.':'Win rate needs improvement — tighter entry criteria recommended.'}`,
    actionable: winRate >= 75
      ? 'Maintain current thresholds. Consider increasing position size by 10% in DIP and NEUTRAL regimes where confidence exceeds 75%.'
      : 'Raise global minimum confidence by 5pts and add a 24h cooldown after any loss exceeding -5%.',
    confidence: winRate >= 75 ? 'MEDIUM' : 'HIGH',
  });

  return insights.slice(0, 5);
}

export async function runAIDeepAnalysis() {
  const trades   = loadTrades();
  const resolved = trades.filter(t => t.outcome && t.pnlPct24h != null && t.action === 'BUY');
  if (resolved.length < 5) return null;

  const existing    = loadLessons();
  const lastAICount = existing.lastAIAnalysisCount || 0;
  if (resolved.length < lastAICount + 3) return null; // AI learns every 3 new resolved trades

  const apiKey    = process.env.ANTHROPIC_API_KEY;
  // AI chain: Claude → Groq → Rule-based
  // GROQ_API_KEY read inline in the Groq block below

  const wins     = resolved.filter(t => t.outcome === 'WIN');
  const losses   = resolved.filter(t => t.outcome === 'LOSS');
  const winRate  = Math.round(wins.length / resolved.length * 100);
  const avgReturn = (resolved.reduce((s, t) => s + t.pnlPct24h, 0) / resolved.length).toFixed(2);
  const sorted   = [...resolved].sort((a, b) => b.pnlPct24h - a.pnlPct24h);
  const top5     = sorted.slice(0, 5);
  const bot5     = sorted.slice(-5);

  const byRegime = {};
  resolved.forEach(t => {
    const r = t.dominantRegime || t.regime || 'NEUTRAL';
    if (!byRegime[r]) byRegime[r] = { wins: 0, total: 0 };
    byRegime[r].total++;
    if (t.outcome === 'WIN') byRegime[r].wins++;
  });
  const regimeLines = Object.entries(byRegime)
    .map(([r, d]) => r + ': ' + d.total + ' trades, ' + Math.round(d.wins / d.total * 100) + '% WR')
    .join('; ');

  const byStrategy = {};
  resolved.forEach(t => {
    const s = t.strategy || 'DIP_BUYER';
    if (!byStrategy[s]) byStrategy[s] = { wins: 0, total: 0 };
    byStrategy[s].total++;
    if (t.outcome === 'WIN') byStrategy[s].wins++;
  });
  // AI reasoning source breakdown
  const aiSourceBreakdown = (() => {
    const withAI = resolved.filter(t => t.aiSource);
    if (!withAI.length) return 'No AI reasoning recorded yet';
    const sources = {};
    withAI.forEach(t => { sources[t.aiSource] = (sources[t.aiSource]||0)+1; });
    return Object.entries(sources).map(([s,c]) => s+':'+c).join(', ');
  })();

  const stratLines = Object.entries(byStrategy)
    .map(([s, d]) => s + ': ' + d.total + ' trades, ' + Math.round(d.wins / d.total * 100) + '% WR')
    .join('; ');

  const top5Lines  = top5.map(t => t.asset + ' +' + t.pnlPct24h.toFixed(1) + '% | ' + (t.dominantRegime||t.regime) + ' | conf' + t.confidence + '% | ' + (t.strategy||'DIP_BUYER')).join('\n');
  const bot5Lines  = bot5.map(t => t.asset + ' '  + t.pnlPct24h.toFixed(1) + '% | ' + (t.dominantRegime||t.regime) + ' | conf' + t.confidence + '% | ' + (t.strategy||'DIP_BUYER')).join('\n');
  const tradeLines = resolved.slice(-15).map(t => {
    const aiTag = t.aiVerdict ? ` | AI:${t.aiVerdict}` : '';
    const aiSrc = t.aiSource ? ` [${t.aiSource.replace('groq_','').replace('ollama_','')}]` : '';
    const correct = t.aiVerdict && t.outcome
      ? (t.aiVerdict === 'SKIP_ENTRY' ? ' ← AI SKIPPED' : t.outcome === 'WIN' ? ' ✓' : ' ✗ AI WRONG')
      : '';
    return t.asset + ' | ' + (t.dominantRegime||t.regime) + ' | conf' + t.confidence + '% | ' + t.outcome + ' ' + (t.pnlPct24h > 0 ? '+' : '') + t.pnlPct24h.toFixed(1) + '% | ' + (t.strategy||'DIP_BUYER') + aiTag + aiSrc + correct;
  }).join('\n'); // last 15 trades with AI verdict accuracy

  // ── Find AI false passes (AI said BUY/BUY_WITH_CAUTION but trade lost) ──
  const aiPasses   = resolved.filter(t => t.aiVerdict && t.aiVerdict !== 'SKIP_ENTRY' && t.aiVerdict !== 'WEAK_BUY');
  const aiFalse    = aiPasses.filter(t => t.outcome === 'LOSS');
  const aiFalsePct = aiPasses.length > 0 ? Math.round(aiFalse.length / aiPasses.length * 100) : 0;
  const aiFalseLines = aiFalse.slice(-10).map(t =>
    t.asset + ' | AI said ' + (t.aiVerdict||'BUY') + ' | conf' + t.confidence + '% | ' + (t.dominantRegime||t.regime) + ' | lost ' + t.pnlPct24h.toFixed(1) + '%'
  ).join('\n') || 'None recorded yet';

  const prompt = [
    'You are the learning engine for DCA Claw, an autonomous crypto DCA trading agent.',
    '',
    'Analyse this COMPLETE trade history and generate 3-5 actionable strategic lessons.',
    'Pay special attention to FALSE PASSES — trades where the AI approved but the trade lost.',
    '',
    'PERFORMANCE SUMMARY:',
    '- Total resolved: ' + resolved.length + ' trades',
    '- Win rate: ' + winRate + '% (' + wins.length + 'W / ' + losses.length + 'L)',
    '- Avg 24h return: ' + avgReturn + '%',
    '- Best: ' + (top5[0]?.asset||'?') + ' +' + (top5[0]?.pnlPct24h||0).toFixed(1) + '% | Worst: ' + (bot5[bot5.length-1]?.asset||'?') + ' ' + (bot5[bot5.length-1]?.pnlPct24h||0).toFixed(1) + '%',
    '- AI reasoning source: ' + aiSourceBreakdown,
    '',
    'REGIME BREAKDOWN: ' + regimeLines,
    'STRATEGY BREAKDOWN: ' + stratLines,
    '',
    'TOP 5 TRADES:',
    top5Lines,
    '',
    'WORST 5 TRADES:',
    bot5Lines,
    '',
    'AI FALSE PASSES (' + aiFalsePct + '% false positive rate on ' + aiPasses.length + ' AI-approved trades):',
    aiFalseLines,
    '',
    'LAST 30 TRADES:',
    tradeLines,
    '',
    'Respond ONLY with a JSON array. No preamble, no markdown fences:',
    '[{"type":"AI_INSIGHT","lesson":"1-2 sentence insight naming specific regimes, assets, or confidence levels.","actionable":"One concrete parameter change the agent should make.","confidence":"HIGH"}]',
  ].join('\n');

  let result = null;

  if (apiKey) {
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 }
      );
      const text  = resp.data?.content?.[0]?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const m     = clean.match(/\[[\s\S]*\]/);
      if (m) result = { insights: JSON.parse(m[0]), source: 'claude_api' };
    } catch (e) {
      const errBody = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      console.warn('[AI Learn] Claude failed:', errBody, '— trying Ollama');
    }
  }

  // ── Groq fallback (free cloud AI) ───────────────────────────────
  if (!result) {
    const groqKey = (process.env.GROQ_API_KEY || '').trim(); // trim whitespace/newlines
    if (groqKey) {
      try {
        const { default: axios } = await import('axios');
        const lessonSystemMsg = `You are the strategic learning engine for DCA CLAW, an autonomous Dollar Cost Averaging crypto agent.

YOUR CORE MISSION: Analyse the trade history and extract lessons that will make DCA Claw smarter, safer, and more profitable. Every lesson must be specific — naming actual assets, regimes, confidence levels, and signal combinations found in the data.

DCA CLAW PHILOSOPHY (keep this in mind when generating lessons):
- The agent accumulates during weakness: oversold RSI, price dips, extreme fear = opportunities
- The agent avoids pumps, crowded longs, falling knives, and distribution phases
- SKIP_ENTRY is a valid and often correct decision — false positives waste capital
- Regime matters enormously: same signals behave differently in NEUTRAL vs VOLATILE vs CRASH

ANALYSIS FRAMEWORK — work through each of these:
1. REGIME PERFORMANCE: Which regimes had the best/worst win rates? Why might that be? What should the agent do differently in weak regimes?
2. SIGNAL FAILURE PATTERNS: In losing trades, which TIER 1 signals (RSI, price action) were misleading? Were there contradicting TIER 2/3 signals that should have triggered caution?
3. WINNING PATTERNS: What combination of signals, regimes, and confidence levels consistently led to wins? How can the agent replicate these?
4. AI FALSE PASSES: Where did the AI approve trades that lost? What was the AI missing or misreading?
5. TIMING PATTERNS: Are there time-of-day, day-of-week, or market session patterns in wins vs losses?
6. CONFIDENCE CALIBRATION: Is the confidence engine well-calibrated? Do 70%+ confidence trades win significantly more than 50% confidence trades?

OUTPUT RULES:
- Every lesson must name specific assets, regimes, or signal values from the actual data
- Every actionable must be a concrete parameter change (e.g. "raise threshold by 5pts" not "be more careful")
- Prioritise HIGH confidence lessons backed by 5+ trades over MEDIUM confidence from 2-3 trades
- If you see a pattern that contradicts DCA philosophy (e.g. agent buying pumps), call it out explicitly`;

        const resp = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model:       'llama-3.3-70b-versatile',
            messages:    [
              { role: 'system', content: lessonSystemMsg },
              { role: 'user',   content: prompt + '\nThink step by step, then return ONLY the JSON array. No markdown.' },
            ],
            temperature: 0.3,
            max_tokens:  1000,
          },
          {
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
            timeout: 40000,  // 40s — 70b needs more time than 8b
          }
        );
        const text  = resp.data?.choices?.[0]?.message?.content || '';
        const clean = text.replace(/```json|```/g, '').trim();
        const m     = clean.match(/\[[\s\S]*\]/);
        if (m) result = { insights: JSON.parse(m[0]), source: 'groq_llama3' };
      } catch (e) {
        const gErr = e.response?.data?.error?.message || e.message;
        const gStatus = e.response?.status || 'no-response';
        const keyHint = groqKey ? groqKey.slice(0,8)+'...' : 'NOT SET';
        console.warn(`[AI Learn] Groq failed (${gStatus}, key:${keyHint}): ${gErr} — trying Ollama`);
      }
    }
  }

  // Ollama removed — chain is now: Claude → Groq → Rule-based

  // ── Rule-based AI insight generator (runs when Claude + Ollama both unavailable) ──
  if (!result?.insights?.length) {
    console.warn('[AI Learn] Claude + Ollama unavailable — generating rule-based insights');
    result = { insights: generateRuleBasedInsights(resolved, wins, losses, byRegime, byStrategy, aiFalse), source: 'rule_based' };
  }

  const timestamped = result.insights.map(insight => ({
    ...insight,
    id: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    generatedAt: new Date().toISOString(),
    basedOnTrades: resolved.length,
    aiSource: result.source,
  }));

  const existing2 = loadLessons();
  const filtered  = (existing2.lessons || []).filter(l => l.type !== 'AI_INSIGHT');
  saveLessons({
    ...existing2,
    lessons: [...filtered, ...timestamped].slice(-60),
    lastAIAnalysisCount: resolved.length,
    lastAIAnalysisAt:    new Date().toISOString(),
    lastAISource:        result.source,
  });

  console.log('[AI Learn] ' + timestamped.length + ' AI insights from ' + resolved.length + ' trades via ' + result.source);
  return timestamped;
}

export default { distilLessons, shouldDistilLessons, getRecentLessons, analyseExtremes, runAIDeepAnalysis };