---
title: DCA CLAW Trading Cycle
description: Understand and explain DCA CLAW's autonomous trading cycle, signal engine, learning system, and decision logic. Use when users ask about trades, decisions, strategy, or performance.
---

# DCA CLAW Trading Cycle Skill

## Overview
DCA CLAW runs an autonomous hourly cycle that scans 100+ Binance spot assets, scores them through a 9+2 signal engine, applies RL-weighted pattern learning, and executes DCA orders when confidence exceeds self-determined thresholds.

## The Cycle (runs every hour)

### Step 1 — Learning Engine
Updates PnL for all trades older than 24h by fetching current prices. Calculates win/loss outcomes. Applies RL reward signal to update pattern weights. Distills lessons every 10 resolved trades.

### Step 2 — Smart Money Pre-Scan
Queries Binance Skills Hub `trading-signal` for tokens with active smart money accumulation on BSC/Solana. These tokens get priority scoring and a confidence boost.

### Step 3 — Market Scanner
Scans all Binance USDT pairs (300+). Filters by: min $1M daily volume, min 300 trades, no leveraged tokens, no stablecoins. Returns top 100 + 24 always-include core assets.

### Step 4 — 11-Signal Confidence Engine
Each asset scored 0-100% across:
1. RSI 1h (25pts) — oversold detection
2. RSI 4h (15pts) — multi-timeframe confirmation
3. Price Action 24h (20pts) — dip magnitude
4. Volume Anomaly (10pts) — selling pressure vs thin market
5. Order Book (10pts) — bid/ask imbalance
6. Funding Rate (12pts) — futures sentiment
7. Volatility ATR (8pts) — stable entry conditions
8. BTC Correlation (10pts) — don't buy alts in BTC crash
9. Memory Win Rate (5pts) — this pattern's historical success
10. Sentiment (10pts) — Fear & Greed Index signal
11. Smart Money (15pts) — on-chain institutional accumulation

### Step 5 — Token Audit Gate
Non-Tier1 assets pass through the Binance Token Audit skill. Hard blocks on honeypots, CRITICAL risk, and unverified contracts. Confidence penalties for medium risks.

### Step 6 — Threshold Check
Each asset has a self-determined threshold based on regime:
- CAPITULATION: 22% (be aggressive in extreme fear)
- OVERSOLD: 30%
- DIP: 35%
- NEUTRAL: 48%
- HIGH_VOLATILITY: 55%
- PUMP: 72%
- CRASH: 38%

RL-learned pattern thresholds can lower or raise these based on past performance.

### Step 7 — Execution
- SHADOW: Log decision only, send Telegram notification
- TESTNET: Place real order on testnet.binance.vision
- LIVE: Request approval if above threshold, then execute

## Answering User Questions

### "Why did you buy [ASSET]?"
Look in `logs/shadow_trades.json` for the most recent BUY decision for that asset. Report: confidence score, regime, top 3 signals that contributed most points, smart money status, audit result.

### "What are you watching right now?"
Report the 5 assets closest to their buy threshold. Show: current confidence, required threshold, gap, regime, and what would push them over.

### "How have you been performing?"
Calculate from `logs/shadow_trades.json`: total decisions, BUY count, WIN rate on resolved trades, best/worst trade, current portfolio simulation value.

### "What have you learned?"
Read from `logs/lessons.json` and summarise the top 3-5 most recent lessons in plain English.

### "Change my settings"
Settings are in `logs/settings.json`. Valid commands: MODE shadow|testnet|live, RISK conservative|balanced|degen, BUDGET DAILY [amount], BUDGET TRADE [amount], FREQUENCY 15m|30m|1h|4h|1d.

## Files Reference
- `logs/shadow_trades.json` — all trade decisions with full signal breakdown
- `logs/memory.json` — learned pattern weights and win rates
- `logs/lessons.json` — distilled human-readable lessons
- `logs/settings.json` — current agent configuration
- `logs/portfolio.json` — simulated portfolio value over time
