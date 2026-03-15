---
title: Binance Trading Signal
description: Monitor on-chain Smart Money buy/sell signals with price, max gain, and exit rate data on Solana and BSC. Use to boost confidence when institutional wallets are accumulating.
---

# Trading Signal Skill (Smart Money)

## Overview
Tracks historically profitable "Smart Money" wallet addresses on Solana and BSC. When clusters of these wallets buy or sell a token, it's a leading indicator for CEX price movement.

## API Endpoints

### Smart Money Buy Signals
```
POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query
Headers: Content-Type: application/json, Accept-Encoding: identity
Body: { "chainId": "56", "period": "1h", "tagType": 2 }
```

### Smart Money Sell Signals  
```
POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query
Headers: Content-Type: application/json, Accept-Encoding: identity
Body: { "chainId": "56", "period": "1h", "tagType": 2, "orderAsc": true }
```

## Period Options
- `5m` — very recent (last 5 minutes)
- `1h` — last hour (recommended for DCA signals)
- `4h` — last 4 hours
- `24h` — last 24 hours

## Chain IDs
- `56` — BSC
- `CT_501` — Solana

## Response Fields
- `symbol` — token symbol
- `netInflow` — USD net inflow from smart money wallets
- `buyCount` — number of smart money buy transactions
- `sellCount` — number of smart money sell transactions
- `priceChange` — price change in period
- `maxGain` — maximum gain from entry for recent signals
- `exitRate` — % of smart money that has exited position

## In DCA CLAW
This skill powers `skills/smart-money.js` as Signal 10:

```
Smart Money Score (max 15pts):
  netInflow > $500k AND buyCount > 5  → +15pts (strong accumulation)
  netInflow > $100k AND buyCount > 2  → +10pts (moderate accumulation)
  netInflow > $10k                    → +5pts  (mild interest)
  netSell pressure detected           → -10pts (smart money exiting)
  exitRate > 70%                      → -15pts (smart money already left)
```

## CEX/On-Chain Correlation Logic
Smart money on BSC/Solana buying a token often precedes Binance Spot price movement within 1-6 hours. This signal is used to INFORM spot decisions, not replace them. It amplifies existing confidence scores — it never triggers a trade alone.

## Cache
Results cached for 10 minutes to avoid rate limits. Smart money moves slower than retail — 10 min cache is appropriate.
