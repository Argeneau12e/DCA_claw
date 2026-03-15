// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v2 — Dynamic Asset Scanner
//  Scans ALL Binance USDT universe (300+ pairs)
//  Returns top 80-100 assets scored by dip + volume + tier
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const REAL_URL = 'https://api.binance.com';
const BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision';

// Safety blacklist — no leveraged tokens, no stablecoins, no fiat pairs
const BLACKLIST = [
  /UP$/, /DOWN$/, /BEAR$/, /BULL$/,
  /3L$/, /3S$/, /5L$/, /5S$/, /2L$/, /2S$/,
  /^USDT/, /USDC$/, /BUSD$/, /TUSD$/, /DAI$/, /FDUSD$/, /USDD$/, /USDP$/,
  /^UST/, /BVND/, /IDRT/, /BIDR/,
  /EUR$/, /GBP$/, /AUD$/, /BRL$/, /RUB$/, /NGN$/, /TRY$/, /ZAR$/,
];

// Tier classification for scoring bonus
const TIER1 = new Set(['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','TRX','LINK','TON','DOT','SHIB','MATIC','POL','UNI','ATOM','LTC','BCH','ETC']);
const TIER2 = new Set(['NEAR','ARB','OP','INJ','SUI','APT','FIL','ICP','HBAR','VET','ALGO','SAND','MANA','AXS','GALA','IMX','BLUR','PEPE','WIF','BONK','JUP','PYTH','W','STRK','ZETA','ENA','AAVE','CRV','SNX','COMP','MKR','1INCH','GRT','LRC','ENJ','BAT']);
const TIER3 = new Set(['BAL','SUSHI','YFI','ZRX','STORJ','OCEAN','BAND','SKL','ANKR','CELR','COTI','DENT','HOT','THETA','FTM','ONE','CELO','ROSE','KAVA','ZIL','CHR','ONT','ZEN','DGB','NKN','RUNE','STX','MINA','FLOW','IOTA','XTZ','EOS','XLM','XMR','ZEC','DASH','DCR','QTUM','WAVES','NANO','ICX','RVN','JASMY','ACH','CLV','GMX','DYDX','LDO','CVX','CFX','RDNT','ID']);

// Always include these regardless of dynamic scan results
export const ALWAYS_INCLUDE = [
  'BTC','ETH','BNB','SOL','ADA','AVAX','DOT','LINK',
  'POL','UNI','ATOM','LTC','XRP','NEAR','ARB','OP',
  'INJ','SUI','APT','FIL','ICP','TRX','TON','DOGE',
];

const MIN_VOLUME = 1_000_000;
const MIN_TRADES = 300;
const MAX_SCAN   = 100;

function isSafe(t) {
  if (!t.symbol.endsWith('USDT')) return false;
  for (const p of BLACKLIST) if (p.test(t.symbol)) return false;
  if (parseFloat(t.quoteVolume) < MIN_VOLUME) return false;
  if (parseInt(t.count || '0') < MIN_TRADES) return false;
  return true;
}

function scoreAssetOpportunity(t) {
  const asset = t.symbol.replace('USDT', '');
  const pct = parseFloat(t.priceChangePercent);
  const vol = parseFloat(t.quoteVolume);
  let s = 0;

  if      (pct <= -15) s += 35;
  else if (pct <= -10) s += 28;
  else if (pct <=  -7) s += 22;
  else if (pct <=  -4) s += 14;
  else if (pct <=  -2) s +=  7;
  else if (pct >=  15) s -= 25;
  else if (pct >=  10) s -= 18;

  if      (vol > 1_000_000_000) s += 18;
  else if (vol >   500_000_000) s += 13;
  else if (vol >   100_000_000) s +=  9;
  else if (vol >    50_000_000) s +=  5;

  if      (TIER1.has(asset)) s += 12;
  else if (TIER2.has(asset)) s +=  7;
  else if (TIER3.has(asset)) s +=  3;

  if (ALWAYS_INCLUDE.includes(asset)) s += 5;
  return { asset, s };
}

export async function scanForOpportunities() {
  console.log('[Scanner] Scanning Binance universe...');
  let tickers = [];

  for (const base of [REAL_URL, BASE_URL]) {
    try {
      const r = await axios.get(`${base}/api/v3/ticker/24hr`, { timeout: 12000 });
      tickers = Array.isArray(r.data) ? r.data : [];
      if (tickers.length > 50) break;
    } catch (e) {
      console.warn(`[Scanner] ${base} unavailable: ${e.message}`);
    }
  }

  if (!tickers.length) {
    console.warn('[Scanner] All APIs failed — using ALWAYS_INCLUDE fallback');
    return ALWAYS_INCLUDE;
  }

  const safe = tickers.filter(isSafe);
  console.log(`[Scanner] ${tickers.length} pairs → ${safe.length} passed safety filter`);

  const seen = new Set();
  const scored = safe
    .map(scoreAssetOpportunity)
    .filter(s => { if (seen.has(s.asset)) return false; seen.add(s.asset); return true; })
    .sort((a, b) => b.s - a.s);

  const top = scored.slice(0, MAX_SCAN).map(s => s.asset);
  const final = [...new Set([...ALWAYS_INCLUDE, ...top])];
  console.log(`[Scanner] ${final.length} assets queued for scoring this cycle`);
  return final;
}

export default { scanForOpportunities };
