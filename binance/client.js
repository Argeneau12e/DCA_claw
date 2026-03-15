// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v2 — Binance Order Client
//  Handles TESTNET and LIVE order placement
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binance.vision';
const API_KEY  = process.env.BINANCE_API_KEY  || '';
const SECRET   = process.env.BINANCE_API_SECRET || '';

function sign(params) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', SECRET).update(qs).digest('hex');
  return qs + '&signature=' + sig;
}

export async function getUSDTBalance() {
  try {
    const params = { timestamp: Date.now(), recvWindow: 5000 };
    const res = await axios.get(
      BASE_URL + '/api/v3/account?' + sign(params),
      { headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }
    );
    const usdt = res.data.balances?.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.free) : 0;
  } catch (e) {
    console.warn('[Binance] Balance check failed: ' + e.message);
    return 0;
  }
}

async function getSymbolInfo(symbol) {
  try {
    const r = await axios.get(BASE_URL + '/api/v3/exchangeInfo', {
      params: { symbol }, timeout: 8000
    });
    const info = r.data.symbols?.[0];
    const lotFilter = info?.filters?.find(f => f.filterType === 'LOT_SIZE');
    const minFilter = info?.filters?.find(f => f.filterType === 'MIN_NOTIONAL') ||
                      info?.filters?.find(f => f.filterType === 'NOTIONAL');
    return {
      stepSize:   parseFloat(lotFilter?.stepSize    || '0.001'),
      minQty:     parseFloat(lotFilter?.minQty      || '0.001'),
      minNotional: parseFloat(minFilter?.minNotional || minFilter?.notional || '10'),
    };
  } catch {
    return { stepSize: 0.001, minQty: 0.001, minNotional: 10 };
  }
}

function roundStep(qty, stepSize) {
  if (stepSize <= 0) return qty;
  const precision = Math.max(0, -Math.floor(Math.log10(stepSize)));
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

export async function placeBuyOrder(symbol, usdtAmount) {
  const { stepSize, minQty, minNotional } = await getSymbolInfo(symbol);
  if (usdtAmount < minNotional) {
    throw new Error('Order too small: $' + usdtAmount + ' < min $' + minNotional);
  }

  const tickerRes = await axios.get(BASE_URL + '/api/v3/ticker/price', {
    params: { symbol }, timeout: 6000
  });
  const price = parseFloat(tickerRes.data.price);
  let qty = roundStep(usdtAmount / price, stepSize);
  if (qty < minQty) qty = minQty;

  const params = {
    symbol,
    side:      'BUY',
    type:      'MARKET',
    quantity:  qty,
    timestamp: Date.now(),
    recvWindow: 5000,
  };

  const res = await axios.post(
    BASE_URL + '/api/v3/order',
    sign(params),
    {
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    }
  );
  return res.data;
}

export default { placeBuyOrder, getUSDTBalance };
