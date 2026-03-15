// ─────────────────────────────────────────────
//  DCA CLAW v2 — PnL Share Card Generator
//  Generates a Bybit-style HTML card saved
//  as an image and sent via Telegram
// ─────────────────────────────────────────────

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const CARDS_DIR = join(__dirname2, '../logs/cards');

export function ensureCardsDir() {
  if (!existsSync(CARDS_DIR)) mkdirSync(CARDS_DIR, { recursive: true });
}

// ── Generate HTML card for a decision ─────────
export function generatePnLCardHTML(trade) {
  ensureCardsDir();

  const {
    asset, priceAtDecision, pnlPct24h, pnlPct7d,
    regime, confidence, wouldSpendUSDT,
    timestamp, outcome, eli5,
  } = trade;

  const pnl = pnlPct24h ?? 0;
  const isWin = pnl >= 0;
  const sign = pnl >= 0 ? '+' : '';
  const entryDate = new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const ASSET_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', BNB: '#f3ba2f',
    SOL: '#9945ff', AVAX: '#e84142', ADA: '#0d1e2d',
    DOGE: '#c2a633', XRP: '#00aae4', DOT: '#e6007a',
    LINK: '#2a5ada', ARB: '#12aaff', OP: '#ff0420',
    INJ: '#00b2ff', SUI: '#6fbcf0', NEAR: '#00c08b',
  };

  const assetColor = ASSET_COLORS[asset] || '#00f5c4';
  const pnlColor = isWin ? '#22c55e' : '#ef4444';
  const bgGradient = isWin
    ? 'linear-gradient(135deg, #0a1a0f 0%, #050810 60%, #0a150a 100%)'
    : 'linear-gradient(135deg, #1a0a0a 0%, #050810 60%, #150a0a 100%)';

  const outcomeEmoji = outcome === 'WIN' ? '🏆' : outcome === 'LOSS' ? '💔' : '⏳';
  const outcomeLabel = outcome === 'WIN' ? 'WINNING TRADE' : outcome === 'LOSS' ? 'LEARNING TRADE' : 'OPEN POSITION';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 600px; height: 340px;
    background: ${bgGradient};
    font-family: 'Segoe UI', system-ui, sans-serif;
    color: #ddeeff;
    overflow: hidden;
    position: relative;
  }
  body::before {
    content:'';
    position:absolute; inset:0;
    background-image:
      linear-gradient(rgba(0,245,196,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,245,196,.03) 1px, transparent 1px);
    background-size: 30px 30px;
  }
  .card {
    position: relative; z-index: 1;
    padding: 28px 32px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  /* Top row */
  .top { display:flex; justify-content:space-between; align-items:flex-start; }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand-icon { font-size: 1.6rem; }
  .brand-text h1 { font-size:.8rem; font-weight:800; letter-spacing:.1em; color:#00f5c4; }
  .brand-text p { font-size:.55rem; color:#3a5a7a; letter-spacing:.08em; text-transform:uppercase; }
  .outcome-badge {
    padding: 5px 14px; border-radius: 100px;
    font-size: .6rem; font-weight: 800; letter-spacing: .1em;
    background: ${isWin ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)'};
    border: 1px solid ${pnlColor};
    color: ${pnlColor};
  }

  /* Asset row */
  .asset-row { display:flex; align-items:center; gap:14px; margin: 4px 0; }
  .asset-dot {
    width: 40px; height: 40px; border-radius: 50%;
    background: ${assetColor}22;
    border: 2px solid ${assetColor};
    display:flex; align-items:center; justify-content:center;
    font-size: .75rem; font-weight: 800; color: ${assetColor};
  }
  .asset-name { font-size: 1.8rem; font-weight: 800; letter-spacing:-.02em; }
  .asset-sub { font-size: .65rem; color: #3a5a7a; margin-top: 2px; font-family: monospace; }
  .regime-tag {
    margin-left: auto;
    padding: 4px 10px; border-radius: 4px;
    font-size: .6rem; font-weight: 700;
    background: rgba(0,245,196,.08);
    border: 1px solid rgba(0,245,196,.2);
    color: #00f5c4;
  }

  /* PnL big number */
  .pnl-section { text-align: center; margin: 2px 0; }
  .pnl-label { font-size: .58rem; color: #3a5a7a; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 2px; }
  .pnl-number {
    font-size: 3.8rem; font-weight: 800;
    color: ${pnlColor};
    line-height: 1;
    text-shadow: 0 0 40px ${pnlColor}44;
  }
  .pnl-sub { font-size: .6rem; color: #3a5a7a; margin-top: 2px; }

  /* Stats row */
  .stats { display:flex; gap:0; border-top: 1px solid #162030; padding-top: 14px; }
  .stat { flex:1; text-align:center; border-right: 1px solid #162030; padding: 0 8px; }
  .stat:last-child { border-right: none; }
  .stat-label { font-size: .52rem; color: #3a5a7a; text-transform:uppercase; letter-spacing:.07em; margin-bottom:3px; }
  .stat-value { font-size: .82rem; font-weight: 700; color: #ddeeff; font-family: monospace; }

  /* Bottom */
  .bottom { display:flex; justify-content:space-between; align-items:center; margin-top:4px; }
  .eli5 {
    font-size: .58rem; color: #3a5a7a;
    max-width: 420px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .watermark { font-size: .52rem; color: #1a2a3a; font-family: monospace; }
</style>
</head>
<body>
<div class="card">
  <div class="top">
    <div class="brand">
      <div class="brand-icon">🦞</div>
      <div class="brand-text">
        <h1>DCA CLAW</h1>
        <p>Smart Accumulation Agent · v2.0</p>
      </div>
    </div>
    <div class="outcome-badge">${outcomeEmoji} ${outcomeLabel}</div>
  </div>

  <div class="asset-row">
    <div class="asset-dot">${asset.slice(0,3)}</div>
    <div>
      <div class="asset-name">${asset}/USDT</div>
      <div class="asset-sub">Entry: $${priceAtDecision?.toLocaleString()} · ${entryDate}</div>
    </div>
    <div class="regime-tag">${regime}</div>
  </div>

  <div class="pnl-section">
    <div class="pnl-label">24h PnL</div>
    <div class="pnl-number">${sign}${pnl.toFixed(2)}%</div>
    <div class="pnl-sub">${isWin ? '📈 Position in profit' : pnl === 0 ? '⏳ Awaiting outcome' : '📉 Position in drawdown'}</div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Deployed</div>
      <div class="stat-value">$${(wouldSpendUSDT || 0).toFixed(0)} USDT</div>
    </div>
    <div class="stat">
      <div class="stat-label">Confidence</div>
      <div class="stat-value">${confidence}%</div>
    </div>
    <div class="stat">
      <div class="stat-label">Regime</div>
      <div class="stat-value">${regime}</div>
    </div>
    <div class="stat">
      <div class="stat-label">7d PnL</div>
      <div class="stat-value" style="color:${(pnlPct7d??0)>=0?'#22c55e':'#ef4444'}">${pnlPct7d != null ? (pnlPct7d>=0?'+':'')+pnlPct7d.toFixed(2)+'%' : 'pending'}</div>
    </div>
  </div>

  <div class="bottom">
    <div class="eli5">${(eli5 || '').split('\n')[0]}</div>
    <div class="watermark">dcaclaw.app</div>
  </div>
</div>
</body>
</html>`;

  const filename = `card_${asset}_${Date.now()}.html`;
  const filepath = join(CARDS_DIR, filename);
  writeFileSync(filepath, html);
  return filepath;
}

export default { generatePnLCardHTML, ensureCardsDir };