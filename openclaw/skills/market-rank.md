---
title: Binance Crypto Market Rank
description: Query crypto market rankings including trending tokens, smart money inflows, social hype rankings, and top trader PnL leaderboards. Use to find which assets have momentum and institutional interest.
---

# Crypto Market Rank Skill

## Overview
Real-time market rankings and leaderboards from Binance Web3. Identifies which tokens have momentum, social buzz, smart money inflows, and trader activity.

## Key Endpoints

### Trending Tokens (Social Hype)
```
GET https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard?chainId=56&sentiment=All&socialLanguage=ALL&targetLanguage=en&timeRange=1
Headers: Accept-Encoding: identity
```

### Smart Money Inflow Rankings
```
POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query
Headers: Content-Type: application/json, Accept-Encoding: identity
Body: { "chainId": "56", "period": "24h", "tagType": 2 }
```

### Token Pulse Rankings (by volume/momentum)
```
POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list
Headers: Content-Type: application/json, Accept-Encoding: identity
Body: { "rankType": 10, "chainId": "56", "period": 50, "sortBy": 70, "orderAsc": false, "pageSize": 20 }
```

## sortBy Options
- `70` — Volume (recommended)
- `40` — Market cap
- `50` — Price change
- `100` — Unique traders
- `30` — Holders
- `20` — Liquidity

## In DCA CLAW
This skill powers `skills/market-rank.js`:

```
Market Rank Score (max 10pts):
  Token in top 10 smart money inflow   → +10pts
  Token in top 20 smart money inflow   → +7pts
  Token trending socially (top 10)     → +5pts (social momentum)
  Token NOT in any ranking             → 0pts (neutral)
  Token shows net outflow in rankings  → -5pts (losing momentum)
```

## Scanner Integration
Market rank data is also used by the scanner to PRIORITISE which assets to score first. Tokens with strong inflows are scored before neutral ones, making the scan more efficient.

## Time Ranges
- `timeRange=1` — last 1 hour
- `timeRange=4` — last 4 hours  
- `timeRange=24` — last 24 hours

## Cache
Trend rankings cached for 15 minutes. Inflow rankings cached for 10 minutes.
