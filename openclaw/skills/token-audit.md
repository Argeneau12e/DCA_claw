---
title: Binance Token Audit
description: Audit token security to detect scams, honeypots, and malicious contracts across BSC, Base, Solana, and Ethereum. Use before buying any non-Tier1 asset.
---

# Token Audit Skill

## Overview
Security auditing for crypto tokens using Binance's Web3 risk scoring engine. Returns scam probability, honeypot detection, liquidity analysis, and specific risk flags.

## API Endpoint
```
POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/token-security/v2/token/batch-security-info
Headers: Content-Type: application/json, Accept-Encoding: identity
Body: { "chainId": "56", "addressList": ["0x..."] }
```

## Supported Chains
- `56` — BSC (Binance Smart Chain)
- `1` — Ethereum
- `8453` — Base
- `CT_501` — Solana

## Response Fields
- `riskLevel` — SAFE / LOW / MEDIUM / HIGH / CRITICAL
- `riskNum` — number of risk factors detected
- `cautionNum` — number of caution flags
- `isHoneypot` — boolean, can you sell after buying?
- `isOpenSource` — contract verified?
- `isProxy` — upgradeable proxy (risk)
- `isMintable` — can supply be inflated?
- `ownershipRenounced` — dev gave up control?
- `liquidityLocked` — liquidity locked?
- `holderConcentration` — % held by top 10 wallets

## In DCA CLAW
This skill powers `skills/token-audit.js`:

```javascript
// Hard block rules (trade cancelled):
if (audit.isHoneypot) → BLOCK — cannot sell
if (audit.riskLevel === 'CRITICAL') → BLOCK
if (!audit.isOpenSource && !TIER1) → BLOCK
if (audit.holderConcentration > 80) → BLOCK — rug risk

// Warning rules (confidence penalty):
if (audit.riskLevel === 'HIGH') → -20pts confidence
if (audit.isMintable) → -10pts confidence
if (!audit.liquidityLocked) → -8pts confidence
if (audit.ownershipRenounced === false) → -5pts confidence
```

## Tier1 Assets (skip audit — trusted)
BTC, ETH, BNB, SOL, ADA, AVAX, DOT, LINK, XRP, NEAR, ARB, OP, UNI, ATOM, LTC, POL, INJ, SUI, APT, FIL, ICP, TRX, TON, DOGE

## Usage Notes
- Only call for non-Tier1 assets to avoid rate limits
- Cache results for 1 hour per token (tokens don't change rapidly)
- If API unavailable, apply default -5pts caution penalty and log warning
- Never block a trade solely on caution flags — only hard risk flags
