// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — One-time patch: fix shadow trades that ran on testnet
//
//  Run ONCE from your project root:
//    node patch-testnet-trades.js
//
//  What it does:
//    Finds any trade in shadow_trades.json that has an orderId
//    (meaning it was actually executed) but still has mode: 'shadow'.
//    Patches those to mode: 'testnet' so the dashboard shows 🧪 TEST.
//
//  Also lets you manually specify assets to patch if needed.
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';

const TRADES_PATH = './logs/shadow_trades.json';

// ── Assets you KNOW executed on testnet today (from your Telegram messages)
// Add any others you approved via Telegram → Approve → TESTNET
const KNOWN_TESTNET_ASSETS = ['FLOW', 'FIO', 'PAXG', 'OMNI', 'POL', 'CVX'];

if (!existsSync(TRADES_PATH)) {
  console.error('❌ shadow_trades.json not found at', TRADES_PATH);
  process.exit(1);
}

const raw   = JSON.parse(readFileSync(TRADES_PATH, 'utf8'));
const trades = raw.trades || raw;

let patched = 0;

for (const t of trades) {
  const needsPatch =
    // Has orderId but still marked as shadow
    (t.orderId && (t.mode === 'shadow' || !t.mode)) ||
    // Known testnet asset from today with no outcome (pending)
    (KNOWN_TESTNET_ASSETS.includes(t.asset) && !t.outcome && (t.mode === 'shadow' || !t.mode));

  if (needsPatch) {
    const before = t.mode || 'shadow';
    t.mode = 'testnet';
    console.log(`✅ Patched ${t.asset} [${new Date(t.timestamp).toLocaleTimeString()}] ${before} → testnet${t.orderId ? ' (Order #'+t.orderId+')' : ''}`);
    patched++;
  }
}

if (patched === 0) {
  console.log('ℹ️  No trades needed patching — all modes are already correct.');
} else {
  const save = Array.isArray(raw) ? trades : { ...raw, trades };
  writeFileSync(TRADES_PATH, JSON.stringify(save, null, 2));
  console.log(`\n🦞 Done — ${patched} trade(s) patched to testnet mode.`);
  console.log('   Refresh your dashboard to see 🧪 TEST on the cards.');
}