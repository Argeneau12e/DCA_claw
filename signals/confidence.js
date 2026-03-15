// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3.2 — Regime-Aware Confidence Engine
//
//  Phase 2 upgrades:
//   ✅ Probabilistic regime classification (6 regimes, blended)
//   ✅ Dynamic signal weights per regime (no more static 25pts)
//   ✅ Confluence multiplier (top signals agreeing = bonus)
//   ✅ Signal freshness decay (stale setups penalised)
//   ✅ Regime-adjusted confidence threshold
//   ✅ All 16 signals preserved and enhanced
//
//  Signal index:
//   0  rsi1h    1  rsi4h    2  priceAction  3  volume    4  orderBook
//   5  funding  6  volatility  7 btcCorr   8  memory    9  sentiment
//  10  smartMoney  11  correlation  12 session  13 news  14 whale  15 mtf
//  16  alpha(NEW)  17  futuresIntel(NEW)
//   10 smartMoney  11 correlation  12 session  13 news  14 whale  15 mtf  16 audit/tokenInfo
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import dotenv from 'dotenv';
import { getSentimentScore } from '../intelligence/sentiment.js';
import { getSmartMoneyScore } from '../skills/smart-money.js';
import { getMarketRankScore } from '../skills/market-rank.js';
import { auditToken } from '../skills/token-audit.js';
import { getTokenInfo } from '../skills/token-info.js';
import {
  applyRLWeight, buildPatternKey,
  getAdaptiveWeights, applyCalibratedConfidence, getClusterBoost,
} from '../intelligence/reinforcement.js';
import { selectStrategy, applyStrategyWeights } from '../intelligence/strategy.js';
import { getCorrelationScore } from '../intelligence/correlation.js';
import { getSessionContext } from '../intelligence/session.js';
import { getNewsScore } from '../intelligence/news.js';
import { getWhaleScore } from '../intelligence/whale.js';
import { getAlphaSignal } from '../skills/alpha-signal.js';
import { getFuturesIntelligence } from '../skills/futures-intel.js';
import { getMultiTimeframeScore } from '../intelligence/multitimeframe.js';
import { classifyRegime, regimeLabel } from '../intelligence/regime.js';
import {
  computeSignalWeights,
  computeThresholdDelta,
  applyDynamicWeights,
  computeConfluenceMultiplier,
  computeFreshnessDecay,
} from '../intelligence/weights.js';

dotenv.config();

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision';
const REAL_URL = 'https://api.binance.com';

export const MIN_CONFIDENCE = parseInt(process.env.MIN_CONFIDENCE || '35');

// ── Base threshold per legacy regime ─────────────────────────────
// (still used as a starting point, then adjusted by regime blend)

export function selfDetermineThreshold(legacyRegime, fundingAvailable) {
  const base = {
    CAPITULATION:    22,
    OVERSOLD:        30,
    DIP:             35,
    NEUTRAL:         48,
    HIGH_VOLATILITY: 55,
    PUMP:            72,
    OVERHEATED:      82,
    CRASH:           38,
  }[legacyRegime] ?? 42;
  if (!fundingAvailable) return Math.max(18, base - 10);
  return base;
}

// ── Data fetchers ─────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  for (const b of [REAL_URL, BASE_URL]) {
    try {
      const r = await axios.get(`${b}/api/v3/klines`, {
        params: { symbol, interval, limit }, timeout: 8000,
      });
      return r.data.map(k => ({
        open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      }));
    } catch {}
  }
  return [];
}

async function fetch24hStats(symbol) {
  for (const b of [REAL_URL, BASE_URL]) {
    try {
      const r = await axios.get(`${b}/api/v3/ticker/24hr`, { params: { symbol }, timeout: 8000 });
      return r.data;
    } catch {}
  }
  return null;
}

async function fetchOrderBook(symbol) {
  for (const b of [REAL_URL, BASE_URL]) {
    try {
      const r = await axios.get(`${b}/api/v3/depth`, { params: { symbol, limit: 20 }, timeout: 6000 });
      return r.data;
    } catch {}
  }
  return null;
}

async function fetchFundingRate(symbol) {
  try {
    const futBase = BASE_URL.includes('testnet') ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const r = await axios.get(`${futBase}/fapi/v1/fundingRate`, { params: { symbol, limit: 1 }, timeout: 6000 });
    return parseFloat(r.data[0]?.fundingRate ?? 0);
  } catch { return null; }
}

let _btcCache = null; let _btcCacheTime = 0;
async function getBTCHealth() {
  if (_btcCache && Date.now() - _btcCacheTime < 300_000) return _btcCache;
  try {
    const [klines, stats] = await Promise.all([fetchKlines('BTCUSDT', '1h', 50), fetch24hStats('BTCUSDT')]);
    const rsi = klines.length ? calcRSI(klines.map(k => k.close)) : null;
    const pct = stats ? parseFloat(stats.priceChangePercent) : 0;
    _btcCache = { rsi, pct };
    _btcCacheTime = Date.now();
    return _btcCache;
  } catch { return { rsi: null, pct: 0 }; }
}

// ── Math helpers ──────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function calcVolatility(klines) {
  if (!klines.length) return 0;
  return klines.map(k => (k.high - k.low) / k.close * 100)
    .reduce((s, r) => s + r, 0) / klines.length;
}

function calcVolumeRatio(klines) {
  if (klines.length < 2) return 1;
  const vols = klines.map(k => k.volume);
  const avg  = vols.slice(0, -1).reduce((s, v) => s + v, 0) / (vols.length - 1);
  return avg > 0 ? vols[vols.length - 1] / avg : 1;
}

function calcOBImbalance(ob) {
  if (!ob?.bids?.length || !ob?.asks?.length) return 0.5;
  const bidVol = ob.bids.reduce((s, b) => s + +b[0] * +b[1], 0);
  const askVol = ob.asks.reduce((s, a) => s + +a[0] * +a[1], 0);
  const total  = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}

function detectLegacyRegime(rsi1h, pct24h, volatility) {
  if (rsi1h !== null && rsi1h < 22) return 'CAPITULATION';
  if (rsi1h !== null && rsi1h > 80) return 'OVERHEATED';
  if (pct24h <= -12) return 'CRASH';
  if (pct24h <= -4 && rsi1h !== null && rsi1h < 45) return 'OVERSOLD';
  if (pct24h <= -2) return 'DIP';
  if (volatility > 3.5) return 'HIGH_VOLATILITY';
  if (pct24h >= 8) return 'PUMP';
  return 'NEUTRAL';
}

// ── Narrative builder ─────────────────────────────────────────────

function buildNarrative(asset, legacyRegime, probabilisticRegime, rsi1h, rsi4h,
  pct24h, fundingRate, confidence, shouldAct, threshold,
  btcHealth, sentimentData, smData, strategy, sessionCtx,
  correlationData, newsData, mtfData, signalWeights, confluenceResult) {

  const lines = [];

  // Regime with probabilistic blend
  const domConf = Math.round((probabilisticRegime?.dominantConf || 0) * 100);
  const regLine = probabilisticRegime
    ? `${regimeLabel(probabilisticRegime.dominant)} (${domConf}% confidence)`
    : legacyRegime;

  const legacyLine = {
    CAPITULATION:    `${asset} in full capitulation — panic selling everywhere.`,
    OVERSOLD:        `${asset} down ${Math.abs(pct24h).toFixed(1)}% — deeply oversold near a local floor.`,
    DIP:             `${asset} down ${Math.abs(pct24h).toFixed(1)}% — healthy dip.`,
    NEUTRAL:         `${asset} in wait-and-see mode.`,
    PUMP:            `${asset} surged ${pct24h.toFixed(1)}% — chasing pumps is risky.`,
    OVERHEATED:      `${asset} RSI ${rsi1h?.toFixed(0)} — overbought territory.`,
    CRASH:           `${asset} crashing -${Math.abs(pct24h).toFixed(1)}%.`,
    HIGH_VOLATILITY: `${asset} swinging wildly — high slippage risk.`,
  }[legacyRegime] || `${asset} — mixed signals.`;

  lines.push(`${legacyLine} Market regime: ${regLine}`);

  if (rsi1h !== null && rsi1h < 30) {
    const conf4h = rsi4h !== null && rsi4h < 40 ? ` 4h RSI ${rsi4h.toFixed(0)} confirms.` : '';
    lines.push(`1h RSI ${rsi1h.toFixed(0)} — heavily sold off.${conf4h}`);
  }

  // Dynamic weight notable changes
  if (signalWeights) {
    const boosted  = Object.entries(signalWeights).filter(([, w]) => w > 1.3).map(([k]) => k);
    const reduced  = Object.entries(signalWeights).filter(([, w]) => w < 0.7).map(([k]) => k);
    if (boosted.length)  lines.push(`📊 Regime boosted: ${boosted.slice(0, 3).join(', ')} signals (${probabilisticRegime?.dominant} context)`);
    if (reduced.length)  lines.push(`📊 Regime reduced: ${reduced.slice(0, 3).join(', ')} signals less reliable here`);
  }

  if (confluenceResult?.bonus > 0) lines.push(...confluenceResult.narrative);
  if (confluenceResult?.bonus < 0) lines.push(...confluenceResult.narrative);

  if (btcHealth?.pct < -5 && asset !== 'BTC')
    lines.push(`⚠️ BTC down ${Math.abs(btcHealth.pct).toFixed(1)}% — altcoin caution.`);

  if (correlationData?.sectorData?.isSectorDip)
    lines.push(`📊 Sector dip confirmed — institutional accumulation window.`);

  if (sessionCtx?.confidenceModifier > 2)
    lines.push(`${sessionCtx.emoji} ${sessionCtx.narrative}`);

  if (mtfData?.alignment === 'STRONG')
    lines.push(`🎯 All timeframes aligned — highest-conviction entry.`);

  if (newsData?.alerts?.length > 0)
    lines.push(`📰 ${newsData.alerts[0].title?.slice(0, 70)}...`);

  if (sentimentData?.fearGreed?.value <= 25)
    lines.push(`😱 Extreme Fear (${sentimentData.fearGreed.value}) — contrarian accumulation zone.`);

  if (smData?.found && smData.score > 5)
    lines.push(`🐋 Smart money accumulating ${asset} on-chain.`);

  if (strategy?.name && strategy.name !== 'DIP_BUYER')
    lines.push(`Strategy: ${strategy.emoji || ''} ${strategy.name}`);

  lines.push(shouldAct
    ? `✅ Decision: Buy. ${confidence}% confidence ≥ ${threshold}% threshold.`
    : `⏸️ Wait. ${confidence}% is ${threshold - confidence}pts below ${threshold}% threshold.`
  );

  return lines.join('\n');
}

// ── Main scorer ───────────────────────────────────────────────────

export async function scoreAsset(asset, memoryPatterns = {}, rlWinRate = null) {
  const symbol = `${asset}USDT`;
  const breakdown = [];
  let rawSignals = {};

  // ── Fetch all CEX data in parallel ───────────────────────────
  const [klines1h, klines4h, stats, ob, fundingRate, btcHealth] = await Promise.all([
    fetchKlines(symbol, '1h', 100), // 100 candles for regime detection
    fetchKlines(symbol, '4h', 50),
    fetch24hStats(symbol),
    fetchOrderBook(symbol),
    fetchFundingRate(symbol),
    getBTCHealth(),
  ]);

  if (!stats) throw new Error(`No stats for ${asset}`);

  const closes1h   = klines1h.map(k => k.close);
  const closes4h   = klines4h.map(k => k.close);
  const rsi1h      = calcRSI(closes1h);
  const rsi4h      = calcRSI(closes4h);
  const pct24h     = parseFloat(stats.priceChangePercent);
  const volatility = calcVolatility(klines1h);
  const volRatio   = calcVolumeRatio(klines1h);
  const obImb      = calcOBImbalance(ob);
  const legacyRegime = detectLegacyRegime(rsi1h, pct24h, volatility);

  const btcRegime = btcHealth?.pct <= -8 ? 'CRASH' : btcHealth?.pct >= 5 ? 'UP' : 'NEUTRAL';
  const { strategy, reason: strategyReason } = selectStrategy(legacyRegime, 50, btcRegime, rlWinRate);

  // ── Fetch all intelligence in parallel ───────────────────────
  const [
    sentimentData, smData, rankData,
    correlationData, newsData, whaleData, mtfData, probabilisticRegime, tokenInfoData,
    alphaData, futuresData,
  ] = await Promise.allSettled([
    getSentimentScore(symbol),
    getSmartMoneyScore(asset),
    getMarketRankScore(symbol),
    getCorrelationScore(asset, pct24h),
    getNewsScore(asset),
    getWhaleScore(symbol),
    getMultiTimeframeScore(symbol, rsi1h),
    classifyRegime(symbol),
    getTokenInfo(asset),
    getAlphaSignal(asset),      // NEW: Binance Alpha signal
    getFuturesIntelligence(asset), // NEW: OI + taker ratio + enhanced funding
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  // Session context (sync)
  const sessionCtx = getSessionContext();

  // ── Compute dynamic signal weights from regime blend ─────────
  const regimeBlend = probabilisticRegime?.blend || { RANGING: 0.5, VOLATILE: 0.3, TRENDING: 0.2 };
  const regimeWeights = computeSignalWeights(regimeBlend);
  const thresholdDelta = computeThresholdDelta(regimeBlend);

  // ── Layer 2: Adaptive signal weights from trade history ───────
  const adaptiveWeights = getAdaptiveWeights();
  const signalWeights = {};
  for (const key of Object.keys(regimeWeights)) {
    const rw = regimeWeights[key] ?? 1.0;
    const aw = adaptiveWeights[key] ?? 1.0;
    const adaptiveTrades = Object.values(adaptiveWeights).filter(w => w !== 1.0).length;
    const adaptiveBlend = Math.min(0.4, adaptiveTrades / 40);
    signalWeights[key] = parseFloat((rw * (1 - adaptiveBlend) + rw * aw * adaptiveBlend).toFixed(3));
  }

  // ── Signal freshness decay ────────────────────────────────────
  const freshnessResult = computeFreshnessDecay(klines1h, rsi1h);
  if (freshnessResult.narrative.length) breakdown.push(...freshnessResult.narrative);

  // ── Raw signal scoring (same logic, weights applied after) ───

  // Signal 1: RSI 1h
  let s1 = 0;
  if (rsi1h !== null) {
    if      (rsi1h < 22) { s1 = 25; breakdown.push(`RSI 1h ${rsi1h} — deep capitulation (+25pts raw)`); }
    else if (rsi1h < 32) { s1 = 20; breakdown.push(`RSI 1h ${rsi1h} — oversold (+20pts raw)`); }
    else if (rsi1h < 42) { s1 = 12; breakdown.push(`RSI 1h ${rsi1h} — below neutral (+12pts raw)`); }
    else if (rsi1h < 52) { s1 =  5; breakdown.push(`RSI 1h ${rsi1h} — neutral (+5pts raw)`); }
    else if (rsi1h > 72) { s1 = -16; breakdown.push(`RSI 1h ${rsi1h} — overbought (-16pts raw)`); }
    else if (rsi1h > 62) { s1 =  -6; breakdown.push(`RSI 1h ${rsi1h} — elevated (-6pts raw)`); }
  }
  rawSignals.rsi1h = s1;

  // Signal 2: RSI 4h
  let s2 = 0;
  if (rsi4h !== null) {
    if      (rsi4h < 28) { s2 = 15; breakdown.push(`RSI 4h ${rsi4h} — deep oversold (+15pts raw)`); }
    else if (rsi4h < 38) { s2 = 10; breakdown.push(`RSI 4h ${rsi4h} — oversold (+10pts raw)`); }
    else if (rsi4h < 48) { s2 =  5; breakdown.push(`RSI 4h ${rsi4h} — below neutral (+5pts raw)`); }
    else if (rsi4h > 72) { s2 = -10; breakdown.push(`RSI 4h ${rsi4h} — overbought (-10pts raw)`); }
  }
  rawSignals.rsi4h = s2;

  // Signal 3: Price Action
  let s3 = 0;
  if      (pct24h <= -15) { s3 = 20; breakdown.push(`Price -${Math.abs(pct24h).toFixed(1)}% — extreme crash (+20pts raw)`); }
  else if (pct24h <= -8)  { s3 = 16; breakdown.push(`Price -${Math.abs(pct24h).toFixed(1)}% — large dip (+16pts raw)`); }
  else if (pct24h <= -4)  { s3 = 12; breakdown.push(`Price -${Math.abs(pct24h).toFixed(1)}% — healthy dip (+12pts raw)`); }
  else if (pct24h <= -2)  { s3 =  6; breakdown.push(`Price -${Math.abs(pct24h).toFixed(1)}% — minor dip (+6pts raw)`); }
  else if (pct24h >= 10)  { s3 = -14; breakdown.push(`Price +${pct24h.toFixed(1)}% — chasing pump (-14pts raw)`); }
  else if (pct24h >= 5)   { s3 =  -6; breakdown.push(`Price +${pct24h.toFixed(1)}% — elevated (-6pts raw)`); }
  rawSignals.priceAction = s3;

  // Signal 4: Volume
  let s4 = 0;
  if      (volRatio > 3.5) { s4 = 10; breakdown.push(`Volume ${volRatio.toFixed(1)}x — whale activity (+10pts raw)`); }
  else if (volRatio > 2.0) { s4 =  7; breakdown.push(`Volume ${volRatio.toFixed(1)}x — elevated (+7pts raw)`); }
  else if (volRatio > 1.5) { s4 =  4; breakdown.push(`Volume ${volRatio.toFixed(1)}x — above avg (+4pts raw)`); }
  else if (volRatio < 0.4) { s4 = -6; breakdown.push(`Volume ${volRatio.toFixed(1)}x — suspiciously low (-6pts raw)`); }
  rawSignals.volume = s4;

  // Signal 5: Order Book
  let s5 = 0;
  if      (obImb > 0.68) { s5 = 10; breakdown.push(`OB ${(obImb*100).toFixed(0)}% bids — strong buy pressure (+10pts raw)`); }
  else if (obImb > 0.57) { s5 =  6; breakdown.push(`OB ${(obImb*100).toFixed(0)}% bids — buy pressure (+6pts raw)`); }
  else if (obImb < 0.32) { s5 = -9; breakdown.push(`OB ${(obImb*100).toFixed(0)}% bids — heavy selling (-9pts raw)`); }
  else if (obImb < 0.43) { s5 = -3; breakdown.push(`OB ${(obImb*100).toFixed(0)}% bids — slight selling (-3pts raw)`); }
  rawSignals.orderBook = s5;

  // Signal 6: Funding Rate
  let s6 = 0;
  if (fundingRate !== null) {
    if      (fundingRate < -0.012) { s6 = 12; breakdown.push(`Funding ${(fundingRate*100).toFixed(3)}% — heavy shorts, very bullish (+12pts raw)`); }
    else if (fundingRate < -0.005) { s6 =  8; breakdown.push(`Funding ${(fundingRate*100).toFixed(3)}% — negative, bullish (+8pts raw)`); }
    else if (fundingRate >  0.025) { s6 = -12; breakdown.push(`Funding ${(fundingRate*100).toFixed(3)}% — longs overheated (-12pts raw)`); }
    else if (fundingRate >  0.012) { s6 =  -6; breakdown.push(`Funding ${(fundingRate*100).toFixed(3)}% — elevated longs (-6pts raw)`); }
    else { breakdown.push(`Funding ${(fundingRate*100).toFixed(3)}% — neutral`); }
  } else { breakdown.push('Funding: unavailable'); }
  rawSignals.funding = s6;

  // Signal 7: Volatility ATR
  let s7 = 0;
  if      (volatility < 0.8) { s7 =  8; breakdown.push(`Volatility ${volatility.toFixed(2)}% — calm entry (+8pts raw)`); }
  else if (volatility < 1.8) { s7 =  5; breakdown.push(`Volatility ${volatility.toFixed(2)}% — moderate (+5pts raw)`); }
  else if (volatility > 6.0) { s7 = -9; breakdown.push(`Volatility ${volatility.toFixed(2)}% — extreme (-9pts raw)`); }
  else if (volatility > 3.5) { s7 = -4; breakdown.push(`Volatility ${volatility.toFixed(2)}% — elevated (-4pts raw)`); }
  rawSignals.volatility = s7;

  // Signal 8: BTC Correlation
  let s8 = 0;
  if (btcHealth && asset !== 'BTC') {
    const { pct: btcPct, rsi: btcRsi } = btcHealth;
    if      (btcPct <= -8)  { s8 = -12; breakdown.push(`BTC down ${Math.abs(btcPct).toFixed(1)}% — crash, risky for alts (-12pts raw)`); }
    else if (btcPct <= -4)  { s8 =  -6; breakdown.push(`BTC down ${Math.abs(btcPct).toFixed(1)}% — Bitcoin weak (-6pts raw)`); }
    else if (btcPct <= -2)  { s8 =  -2; breakdown.push(`BTC down ${Math.abs(btcPct).toFixed(1)}% — minor drag (-2pts raw)`); }
    else if (btcPct >= 3 && (btcRsi ?? 50) < 65) { s8 = 5; breakdown.push(`BTC healthy +${btcPct.toFixed(1)}% — tailwind (+5pts raw)`); }
  }
  rawSignals.btcCorr = s8;

  // Signal 9: Memory Win Rate
  let s9 = 0;
  const rsiZone   = rsi1h !== null ? (rsi1h < 40 ? 'OVERSOLD' : rsi1h > 60 ? 'OVERBOUGHT' : 'NEUTRAL') : 'UNKNOWN';
  const patternKey = `${legacyRegime}_${rsiZone}`;
  const pattern   = memoryPatterns[patternKey];
  if (pattern?.total >= 5) {
    const wr = pattern.wins / pattern.total;
    if      (wr >= 0.78) { s9 =  5; breakdown.push(`Pattern "${patternKey}" — ${(wr*100).toFixed(0)}% WR (+5pts raw)`); }
    else if (wr >= 0.62) { s9 =  3; breakdown.push(`Pattern "${patternKey}" — ${(wr*100).toFixed(0)}% WR (+3pts raw)`); }
    else if (wr <  0.38) { s9 = -9; breakdown.push(`Pattern "${patternKey}" — ${(wr*100).toFixed(0)}% WR (-9pts raw)`); }
    else if (wr <  0.50) { s9 = -4; breakdown.push(`Pattern "${patternKey}" — ${(wr*100).toFixed(0)}% WR (-4pts raw)`); }
  }
  rawSignals.memory = s9;

  // Signal 10: Sentiment
  let s10 = 0;
  if (sentimentData) {
    s10 = Math.round(sentimentData.score);
    if (s10 !== 0) breakdown.push(...(sentimentData.narrative || []));
  }
  rawSignals.sentiment = s10;

  // Signal 11: Smart Money + Market Rank
  let s11 = 0;
  if (smData?.found) { s11 = smData.score; if (smData.narrative?.length) breakdown.push(...smData.narrative); }
  if (rankData)      { s11 = Math.max(-15, Math.min(15, s11 + (rankData.score || 0))); if (rankData.narrative?.length) breakdown.push(...rankData.narrative); }
  rawSignals.smartMoney = s11;

  // Signal 12: Correlation
  let s12 = correlationData?.score || 0;
  if (correlationData?.narrative?.length) breakdown.push(...correlationData.narrative);
  rawSignals.correlation = s12;

  // Signal 13: Session
  let s13 = Math.max(-8, Math.min(8, sessionCtx?.confidenceModifier || 0));
  if (Math.abs(s13) >= 3) breakdown.push(`${sessionCtx.emoji} ${sessionCtx.narrative}`);
  rawSignals.session = s13;

  // Signal 14: News
  let s14 = newsData?.score || 0;
  if (newsData?.narrative?.length) breakdown.push(...newsData.narrative);
  rawSignals.news = s14;

  // Signal 15: Whale
  let s15 = whaleData?.score || 0;
  if (whaleData?.narrative?.length) breakdown.push(...whaleData.narrative);
  rawSignals.whale = s15;

  // Signal 16: Multi-timeframe
  let s16 = mtfData?.score || 0;
  if (mtfData?.narrative?.length) breakdown.push(...mtfData.narrative);
  rawSignals.mtf = s16;

  // Signal 16: Binance Alpha (NEW)
  let s17 = 0;
  if (alphaData?.found) {
    s17 = alphaData.score || 0;
    if (alphaData.narrative?.length) breakdown.push(...alphaData.narrative);
    // Hard warning: Alpha flags this token as offline/offsell
    if (alphaData.hardWarning) {
      breakdown.push(`⚠️ Alpha token flagged offline — caution`);
      s17 = Math.min(s17, -8);
    }
  }
  rawSignals.alpha = s17;

  // Signal 17: Futures Intelligence — OI trend + taker pressure (NEW)
  let s18 = 0;
  if (futuresData?.futuresListed) {
    s18 = futuresData.score || 0;
    if (futuresData.narrative?.length) breakdown.push(...futuresData.narrative);
    // Override funding signal if futures intelligence has better data
    if (futuresData.fundingRate !== null && s6 === 0) {
      // Only override if original funding signal came back null/zero
      const fr = futuresData.fundingRate;
      if      (fr < -0.012) s6 = 12;
      else if (fr < -0.005) s6 = 8;
      else if (fr >  0.025) s6 = -12;
      else if (fr >  0.012) s6 = -6;
      rawSignals.funding = s6; // update with better data
    }
  }
  rawSignals.futuresIntel = s18;

  // ── Token Info Gate (Skill 3 — liquidity/holder check) ──────────
  let tokenInfoResult = tokenInfoData;
  if (tokenInfoResult && tokenInfoResult.hardBlock) {
    return {
      asset, symbol, hardBlock: true, blockReason: tokenInfoResult.reason,
      confidence: 0, effectiveThreshold: 100, shouldAct: false,
      legacyRegime, probabilisticRegime,
      rsi: rsi1h, rsi4h, priceChangePct: pct24h,
      currentPrice: parseFloat(stats.lastPrice),
      breakdown: [...breakdown, `🚫 TOKEN INFO BLOCK: ${tokenInfoResult.reason}`],
      eli5: `${asset} blocked: ${tokenInfoResult.reason}`,
      timestamp: new Date().toISOString(), patternKey,
      blockSource: 'TOKEN_INFO',
    };
  }
  if (tokenInfoResult?.score && tokenInfoResult.score !== 0) {
    rawSignals.tokenInfo = tokenInfoResult.score;
    breakdown.push(`Token info: ${tokenInfoResult.reason} (${tokenInfoResult.score > 0 ? '+' : ''}${tokenInfoResult.score}pts)`);
  }

  // ── Token Audit Gate (Skill 7 — contract security) ───────────────
  let auditResult = null;
  try {
    auditResult = await auditToken(asset);
    if (auditResult.hardBlock) {
      return {
        asset, symbol, hardBlock: true, blockReason: auditResult.reason,
        confidence: 0, effectiveThreshold: 100, shouldAct: false,
        legacyRegime, probabilisticRegime,
        rsi: rsi1h, rsi4h, priceChangePct: pct24h,
        currentPrice: parseFloat(stats.lastPrice),
        breakdown: [...breakdown, `🚨 AUDIT HARD BLOCK: ${auditResult.reason}`],
        eli5: `${asset} blocked: ${auditResult.reason}`,
        timestamp: new Date().toISOString(), patternKey,
      };
    }
    if (auditResult.score !== 0) {
      rawSignals.audit = auditResult.score;
      breakdown.push(`Token audit: ${auditResult.reason} (${auditResult.score > 0 ? '+' : ''}${auditResult.score}pts)`);
    }
  } catch {}

  // ── Apply dynamic weights ─────────────────────────────────────
  const weightedSignals = applyDynamicWeights(rawSignals, signalWeights);
  let totalScore = Object.values(weightedSignals).reduce((s, v) => s + v, 0);

  // Show weight impact in breakdown
  const rawTotal = Object.values(rawSignals).reduce((s, v) => s + v, 0);
  const weightImpact = Math.round(totalScore - rawTotal);
  if (Math.abs(weightImpact) > 3) {
    breakdown.push(`📊 Regime weighting: ${weightImpact > 0 ? '+' : ''}${weightImpact}pts (${probabilisticRegime?.dominant || 'RANGING'} market context)`);
  }

  // ── Apply freshness decay ─────────────────────────────────────
  totalScore *= freshnessResult.decayFactor;

  // ── Apply confluence multiplier ───────────────────────────────
  const confluenceResult = computeConfluenceMultiplier(rawSignals, signalWeights);
  totalScore += confluenceResult.bonus;
  if (confluenceResult.narrative.length) breakdown.push(...confluenceResult.narrative);

  // ── Apply legacy strategy weights ────────────────────────────
  const stratWeighted = applyStrategyWeights(rawSignals, strategy);
  const stratAdj = Math.round(
    Object.values(stratWeighted).reduce((s, v) => s + v, 0) -
    Object.values(rawSignals).reduce((s, v) => s + v, 0)
  );
  if (Math.abs(stratAdj) > 2) {
    breakdown.push(`${strategy.emoji} Strategy ${strategy.name}: ${stratAdj > 0 ? '+' : ''}${stratAdj}pts`);
    totalScore += stratAdj;
  }

  // ── Apply RL weight multiplier ────────────────────────────────
  const rlPatternKey = buildPatternKey(legacyRegime, rsi1h ?? 50, btcRegime);
  const rlResult = applyRLWeight(totalScore, rlPatternKey);
  if (rlResult.boost) {
    breakdown.push(`🧠 ${rlResult.boost} applied to pattern ${rlPatternKey}`);
    totalScore = rlResult.adjusted;
  }

  // ── Cluster adjustment ────────────────────────────────────────
  const clusterResult = getClusterBoost({
    btcHealth, volatility, fearGreed: sentimentData?.fearGreed ?? null,
  });
  if (clusterResult.factor !== 1.0) {
    totalScore *= clusterResult.factor;
    if (clusterResult.narrative) breakdown.push(clusterResult.narrative);
  }

  // ── Final confidence + calibration ───────────────────────────
  const normalised    = Math.round((totalScore / 140) * 100);
  const rawConfidence = Math.max(0, Math.min(100, normalised));
  const confidence    = applyCalibratedConfidence(rawConfidence);

  // Threshold = base (legacy regime) + regime blend delta + strategy modifier + session modifier
  const baseThreshold = selfDetermineThreshold(legacyRegime, fundingRate !== null);
  const effectiveThreshold = Math.max(15, Math.min(90,
    baseThreshold +
    thresholdDelta +
    (strategy.thresholdModifier || 0) +
    (sessionCtx?.thresholdModifier || 0)
  ));
  const shouldAct = confidence >= effectiveThreshold;

  const eli5 = buildNarrative(
    asset, legacyRegime, probabilisticRegime, rsi1h, rsi4h, pct24h, fundingRate,
    confidence, shouldAct, effectiveThreshold, btcHealth, sentimentData, smData,
    strategy, sessionCtx, correlationData, newsData, mtfData,
    signalWeights, confluenceResult
  );

  return {
    asset, symbol,
    currentPrice: parseFloat(stats.lastPrice),
    priceChangePct: pct24h,
    rsi: rsi1h, rsi4h,
    // Regime data
    regime: legacyRegime,
    probabilisticRegime,
    dominantRegime: probabilisticRegime?.dominant || legacyRegime,
    regimeBlend,
    // Signal data
    rawSignals,
    weightedSignals,
    signalWeights,
    volatility: parseFloat(volatility.toFixed(2)),
    volumeRatio: parseFloat(volRatio.toFixed(2)),
    obImbalance: parseFloat(obImb.toFixed(3)),
    fundingRate, btcHealth,
    // Intelligence
    sentimentScore: s10, fearGreed: sentimentData?.fearGreed ?? null,
    smartMoneyScore: s11, smartMoneyData: smData,
    correlationScore: s12, sector: correlationData?.sector ?? null,
    sessionContext: sessionCtx,
    newsScore: s14, newsAlerts: newsData?.alerts ?? [],
    whaleScore: s15, whaleBidCount: whaleData?.whaleBidCount ?? 0,
    mtfScore: s16, mtfAlignment: mtfData?.alignment ?? 'UNKNOWN',
    mtfTimeframes: mtfData?.timeframes ?? {},
    alphaScore: s17, alphaFound: alphaData?.found ?? false, alphaId: alphaData?.alphaId ?? null,
    futuresScore: s18, futuresListed: futuresData?.futuresListed ?? false,
    oiTrend: futuresData?.oiTrend ?? null, takerRatio: futuresData?.takerRatio ?? null,
    confluenceBonus: confluenceResult.bonus,
    freshnessDecay: freshnessResult.decayFactor,
    auditResult,
    tokenInfoResult,
    strategy: strategy.name, strategyReason,
    rlPatternKey, rlWeight: rlResult.weight,
    clusterKey: clusterResult.clusterKey,
    rawConfidence,
    confidence, effectiveThreshold, shouldAct,
    thresholdBreakdown: {
      base: baseThreshold,
      regimeDelta: thresholdDelta,
      strategyDelta: strategy.thresholdModifier || 0,
      sessionDelta: sessionCtx?.thresholdModifier || 0,
    },
    breakdown, eli5, patternKey,
    timestamp: new Date().toISOString(),
    signalCount: 17,
  };
}

export default { scoreAsset, MIN_CONFIDENCE, selfDetermineThreshold };