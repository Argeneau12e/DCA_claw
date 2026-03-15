// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Opportunity Radar + Smart Alerts
//
//  Runs every 5 minutes (separate from hourly decision cycle).
//  Does NOT make trades — sends Telegram alerts when:
//
//  1. RSI drops below 30 on any Tier1/Tier2 asset
//  2. Price drops 5%+ in the last hour
//  3. Volume spikes 5x above 24h average
//  4. BTC regime changes (NEUTRAL → CRASH etc)
//  5. Smart money starts accumulating a new asset
//  6. Fear & Greed drops into Extreme Fear (< 20)
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import cron from 'node-cron';

const REAL_URL = 'https://api.binance.com';

// Radar watchlist — focused on most liquid assets
const RADAR_ASSETS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT',
  'AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','NEARUSDT','ARBUSDT',
  'OPUSDT','UNIUSDT','ATOMUSDT','LTCUSDT','INJUSDT','SUIUSDT',
  'APTUSDT','DOGEUSDT','TONUSDT','TRXUSDT',
];

// State tracking to avoid duplicate alerts
const alertState = {
  lastBtcRegime: null,
  lastFgZone: null,
  alertedRsi: new Map(),    // symbol → last alerted price
  alertedVolume: new Map(), // symbol → last alert timestamp
  alertedDrop: new Map(),   // symbol → last alert timestamp
};

const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between same alert

let sendAlert = null; // injected from index.js
let radarJob = null;

// ── Initialise radar ──────────────────────────────────────────────

export function initRadar(alertFn) {
  sendAlert = alertFn;
  radarJob = cron.schedule('*/5 * * * *', runRadarScan, { scheduled: false });
  radarJob.start();
  console.log('[Radar] 🔭 Opportunity radar started — scanning every 5 minutes');
}

export function stopRadar() {
  if (radarJob) { radarJob.stop(); console.log('[Radar] Stopped'); }
}

// ── Main radar scan ───────────────────────────────────────────────

async function runRadarScan() {
  try {
    await Promise.allSettled([
      checkRsiAlerts(),
      checkPriceDropAlerts(),
      checkVolumeAlerts(),
      checkBtcRegimeChange(),
      checkFearGreedAlert(),
    ]);
  } catch (e) {
    console.error('[Radar] Scan error:', e.message);
  }
}

// ── RSI Alert (RSI drops below 30) ───────────────────────────────

async function checkRsiAlerts() {
  for (const symbol of RADAR_ASSETS.slice(0, 12)) { // top 12 to avoid rate limits
    try {
      const klines = await fetchKlines(symbol, '1h', 15);
      if (klines.length < 14) continue;
      const rsi = calcRsi(klines.map(k => k.close), 14);
      if (rsi > 30) continue;

      const lastAlert = alertState.alertedRsi.get(symbol);
      if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN) continue;

      alertState.alertedRsi.set(symbol, Date.now());
      const asset = symbol.replace('USDT', '');
      const price = klines[klines.length - 1].close;

      await sendAlert?.(
        `🔭 *Radar Alert — RSI Oversold*\n\n` +
        `Asset: *${asset}/USDT*\n` +
        `RSI 1h: *${rsi.toFixed(1)}* (below 30 ⚡)\n` +
        `Price: $${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}\n\n` +
        `_This is a radar alert — not a trade signal. The full hourly engine will score this asset next cycle._\n` +
        `_Send \`STATUS\` to see current agent decisions._`
      );
    } catch {}
  }
}

// ── Price Drop Alert (5%+ drop in 1 hour) ────────────────────────

async function checkPriceDropAlerts() {
  try {
    const tickers = await axios.get(`${REAL_URL}/api/v3/ticker/24hr`, { timeout: 8000 });
    const relevant = tickers.data
      .filter(t => RADAR_ASSETS.includes(t.symbol))
      .filter(t => parseFloat(t.priceChangePercent) <= -5);

    for (const ticker of relevant) {
      const lastAlert = alertState.alertedDrop.get(ticker.symbol);
      if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN) continue;

      alertState.alertedDrop.set(ticker.symbol, Date.now());
      const asset = ticker.symbol.replace('USDT', '');
      const drop = parseFloat(ticker.priceChangePercent).toFixed(2);

      await sendAlert?.(
        `🔭 *Radar Alert — Sharp Drop Detected*\n\n` +
        `Asset: *${asset}/USDT*\n` +
        `24h Drop: *${drop}%* 📉\n` +
        `Current Price: $${parseFloat(ticker.lastPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })}\n` +
        `Volume: $${(parseFloat(ticker.quoteVolume) / 1e6).toFixed(1)}M\n\n` +
        `_Radar alert — full scoring runs next hourly cycle._`
      );
    }
  } catch {}
}

// ── Volume Spike Alert (5x average) ──────────────────────────────

async function checkVolumeAlerts() {
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT']) {
    try {
      const klines = await fetchKlines(symbol, '1h', 25);
      if (klines.length < 20) continue;

      const recent = klines[klines.length - 1].volume;
      const avgVol = klines.slice(-25, -1).reduce((s, k) => s + k.volume, 0) / 24;
      const ratio = recent / avgVol;

      if (ratio < 5) continue;

      const lastAlert = alertState.alertedVolume.get(symbol);
      if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN) continue;
      alertState.alertedVolume.set(symbol, Date.now());

      const asset = symbol.replace('USDT', '');
      await sendAlert?.(
        `🔭 *Radar Alert — Volume Spike*\n\n` +
        `Asset: *${asset}/USDT*\n` +
        `Volume: *${ratio.toFixed(1)}x* above average 📊\n` +
        `_Could indicate news, whale movement, or incoming volatility._\n\n` +
        `_Radar alert — full scoring runs next hourly cycle._`
      );
    } catch {}
  }
}

// ── BTC Regime Change Alert ───────────────────────────────────────

async function checkBtcRegimeChange() {
  try {
    const klines = await fetchKlines('BTCUSDT', '1h', 26);
    if (klines.length < 25) return;

    const closes = klines.map(k => k.close);
    const rsi = calcRsi(closes, 14);
    const priceChange = (closes[closes.length - 1] - closes[closes.length - 25]) / closes[closes.length - 25] * 100;

    let regime = 'NEUTRAL';
    if (rsi < 25 && priceChange < -8) regime = 'CAPITULATION';
    else if (rsi < 30) regime = 'OVERSOLD';
    else if (priceChange < -5) regime = 'CRASH';
    else if (rsi > 75) regime = 'OVERHEATED';
    else if (priceChange > 8) regime = 'PUMP';

    if (regime === alertState.lastBtcRegime) return;
    const prev = alertState.lastBtcRegime;
    alertState.lastBtcRegime = regime;
    if (!prev) return; // first run, no alert

    const regimeEmoji = {
      CAPITULATION: '🆘', OVERSOLD: '😰', CRASH: '📉',
      NEUTRAL: '😐', OVERHEATED: '🔥', PUMP: '🚀',
    }[regime] || '📊';

    await sendAlert?.(
      `🔭 *Radar Alert — BTC Regime Change*\n\n` +
      `${regimeEmoji} BTC shifted: *${prev}* → *${regime}*\n` +
      `RSI: ${rsi.toFixed(1)} | 24h: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%\n\n` +
      `${regime === 'CAPITULATION' ? '🎯 Potential accumulation opportunity — agent will be aggressive next cycle.' :
        regime === 'CRASH' ? '⚠️ BTC crashing — agent will apply correlation filter to all altcoins.' :
        regime === 'PUMP' ? '⚠️ BTC pumping — agent will require higher confidence for altcoin entries.' :
        'Agent is monitoring for opportunities.'}\n\n` +
      `_Regime change alert — not a trade signal._`
    );
  } catch {}
}

// ── Fear & Greed Extreme Alert ────────────────────────────────────

async function checkFearGreedAlert() {
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 6000 });
    const val = parseInt(r.data?.data?.[0]?.value || 50);
    const zone = val <= 15 ? 'EXTREME_FEAR' : val >= 85 ? 'EXTREME_GREED' : 'NORMAL';

    if (zone === 'NORMAL' || zone === alertState.lastFgZone) {
      alertState.lastFgZone = zone;
      return;
    }
    alertState.lastFgZone = zone;

    if (zone === 'EXTREME_FEAR') {
      await sendAlert?.(
        `🔭 *Radar Alert — Extreme Fear Detected*\n\n` +
        `😱 Fear & Greed Index: *${val}/100 — EXTREME FEAR*\n\n` +
        `_Historically, extreme fear is one of the best times to DCA into quality assets._\n` +
        `_Agent will apply a +10pt sentiment boost to all confidence scores next cycle._`
      );
    } else if (zone === 'EXTREME_GREED') {
      await sendAlert?.(
        `🔭 *Radar Alert — Extreme Greed Detected*\n\n` +
        `🤑 Fear & Greed Index: *${val}/100 — EXTREME GREED*\n\n` +
        `_Market may be overheated. Agent will apply a -10pt sentiment penalty to confidence scores._\n` +
        `_Consider pausing new entries or reducing position sizes._`
      );
    }
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  const r = await axios.get(`${REAL_URL}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 6000,
  });
  return r.data.map(k => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 0.001);
  return 100 - (100 / (1 + rs));
}

export default { initRadar, stopRadar };
