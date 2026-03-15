---
title: Binance Spot
description: Execute spot trades, fetch market data, check balances, and manage orders on Binance using authenticated API endpoints. Supports both testnet and mainnet.
---

# Binance Spot Skill

## Overview
Binance Spot requests using the Binance API. Authentication requires API key and secret key. Supports testnet and mainnet.

## Authentication
Credentials are stored in `.env`:
- `BINANCE_API_KEY` — your API key
- `BINANCE_API_SECRET` — your secret key  
- `BINANCE_BASE_URL` — `https://testnet.binance.vision` (testnet) or `https://api.binance.com` (live)

Always include `User-Agent: binance-spot/1.0.1 (Skill)` header on all requests.

## Key Endpoints

### Market Data (no auth required)
- `GET /api/v3/ticker/24hr?symbol=BTCUSDT` — 24h price stats
- `GET /api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100` — candlestick data
- `GET /api/v3/depth?symbol=BTCUSDT&limit=20` — order book
- `GET /api/v3/ticker/price` — all current prices

### Account (auth required — HMAC signed)
- `GET /api/v3/account` — balances and account info
- `GET /api/v3/openOrders` — open orders
- `GET /api/v3/allOrders` — order history

### Trading (auth required — HMAC signed)
- `POST /api/v3/order` — place order
  - Required: `symbol`, `side` (BUY/SELL), `type` (MARKET/LIMIT), `quantity` or `quoteOrderQty`
- `DELETE /api/v3/order` — cancel order

## HMAC Signing
All authenticated requests require:
1. Add `timestamp` param (current ms)
2. Build query string
3. Sign with HMAC-SHA256 using secret key
4. Append `&signature=<sig>` to query string
5. Add `X-MBX-APIKEY: <key>` header

## In DCA CLAW
This skill powers:
- `binance/client.js` — order placement and balance checks
- `signals/confidence.js` — market data for all 9 signals
- `scanner/index.js` — asset universe discovery

## Safety Rules
- Always confirm with user before placing live mainnet orders
- Testnet orders can proceed automatically
- Never expose API keys in responses
- Check USDT balance before every order
- Respect lot size and min notional from exchange info
