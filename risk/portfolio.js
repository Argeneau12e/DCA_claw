// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — Portfolio Risk Engine
//
//  Five systems in one file:
//
//  1. PORTFOLIO HEAT — tracks total open exposure across all assets.
//     If heat > max, block new buys until positions resolve.
//
//  2. SECTOR CAP — prevents over-concentration in one sector.
//     e.g. can't buy 4 L1s in a row if sector cap = 2.
//
//  3. OPPORTUNITY RANKING — scores all candidates and allocates
//     capital best-first. Highest confidence gets first allocation.
//     If budget only covers 2 trades, pick the top 2 — not random.
//
//  4. DO-NOTHING GATE — market-wide health check before any trade.
//     BTC crash + extreme fear + negative news + liquidations = skip.
//     This is the "protect capital at all costs" layer.
//
//  5. DRAWDOWN MEMORY — tracks open positions, distinguishes
//     market-wide vs asset-specific drawdown.
//     Market-wide: pause new buys.
//     Asset-specific: scale down size only.
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR  = join(__dirname, '../logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const PORTFOLIO_FILE  = join(LOGS_DIR, 'portfolio.json');
const TRADES_FILE     = join(LOGS_DIR, 'shadow_trades.json');

// ── Sector map ────────────────────────────────────────────────────

const SECTORS = {
  L1: ['BTC','ETH','SOL','AVAX','ADA','DOT','NEAR','ATOM','ALGO','ONE','FTM','HBAR','EGLD','KLAY'],
  L2: ['MATIC','OP','ARB','IMX','METIS','BOBA','ZK','STRK','SCROLL','MANTA'],
  DEFI: ['UNI','AAVE','COMP','MKR','CRV','SUSHI','BAL','YFI','SNX','LDO','RPL','PENDLE','GMX'],
  AI: ['FET','AGIX','OCEAN','RNDR','AKT','TAO','ARKM','GRT'],
  GAMING: ['AXS','MANA','SAND','ENJ','GALA','IMX','BEAM','MAGIC'],
  INFRA: ['LINK','BAND','API3','TRB','DON','VET','IOTA','HOLO'],
  EXCHANGE: ['BNB','OKB','KCS','CRO','GT','HT'],
  MEME: ['DOGE','SHIB','PEPE','FLOKI','BONK','WIF','BOME'],
  STABLE: ['USDT','USDC','BUSD','DAI','FDUSD','TUSD','FRAX'],
};

function getSector(asset) {
  for (const [sector, assets] of Object.entries(SECTORS)) {
    if (assets.includes(asset.toUpperCase())) return sector;
  }
  return 'OTHER';
}

// ── Portfolio state ───────────────────────────────────────────────

function loadPortfolio() {
  try {
    if (existsSync(PORTFOLIO_FILE)) return JSON.parse(readFileSync(PORTFOLIO_FILE, 'utf8'));
  } catch {}
  return { openPositions: {}, sectorExposure: {}, totalDeployed: 0, lastUpdated: null };
}

function savePortfolio(data) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2));
}

function loadTrades() {
  try {
    const raw = JSON.parse(readFileSync(TRADES_FILE, 'utf8'));
    return raw.trades || raw || [];
  } catch { return []; }
}

// ── 1. Portfolio Heat ─────────────────────────────────────────────

export function calcPortfolioHeat(config) {
  const portfolio = loadPortfolio();
  const trades    = loadTrades();
  // Heat thresholds by mode:
  //   shadow  — bypassed entirely (calcPortfolioHeatSafe handles this)
  //   testnet — 8x daily spend (fake money, be lenient)
  //   live    — 3x daily spend (real money, be strict)
  const heatMultiplier = (config.mode || 'shadow') === 'live' ? 3 : 8;
  const maxHeat   = config.maxDailySpend * heatMultiplier;

  // Pending trades (bought, not yet resolved)
  const pending = trades.filter(t =>
    (t.action === 'BUY' || t.wouldBuy) && !t.outcome
  );

  const totalOpen  = pending.reduce((s, t) => s + (t.wouldSpendUSDT || t.amount || 0), 0);
  const heatPct    = maxHeat > 0 ? (totalOpen / maxHeat) * 100 : 0;
  const openAssets = [...new Set(pending.map(t => t.asset))];
  const isOverheat = heatPct >= 90;

  return {
    totalOpen:   parseFloat(totalOpen.toFixed(2)),
    maxHeat:     parseFloat(maxHeat.toFixed(2)),
    heatPct:     parseFloat(heatPct.toFixed(1)),
    openCount:   pending.length,
    openAssets,
    isOverheat,
    heatLevel:   heatPct >= 90 ? 'CRITICAL' : heatPct >= 70 ? 'HIGH' : heatPct >= 40 ? 'MEDIUM' : 'LOW',
    narrative:   isOverheat
      ? `🔥 Portfolio heat CRITICAL (${heatPct.toFixed(0)}%) — ${pending.length} unresolved positions. No new buys until trades resolve.`
      : null,
  };
}

// Shadow-safe wrapper — shadow mode always returns clean heat
// Testnet gets a much higher threshold (fake money = learn more)
export function calcPortfolioHeatSafe(config) {
  if ((config.mode || 'shadow') === 'shadow') {
    return {
      totalOpen: 0, maxHeat: 9999, heatPct: 0,
      openCount: 0, openAssets: [], isOverheat: false,
      heatLevel: 'LOW', narrative: null,
    };
  }
  const heat = calcPortfolioHeat(config);
  // Testnet: only block if TRULY overheated (>150% of already-lenient 8x threshold)
  // This prevents stale unresolved testnet trades from permanently blocking new ones
  if ((config.mode || 'shadow') === 'testnet' && heat.heatPct < 150) {
    return { ...heat, isOverheat: false };
  }
  return heat;
}

// ── 2. Sector Exposure Check ──────────────────────────────────────

export function checkSectorCap(asset, config) {
  const trades  = loadTrades();
  const sector  = getSector(asset);

  // Ignore stablecoins entirely
  if (sector === 'STABLE') {
    return { blocked: true, reason: `${asset} is a stablecoin — not tradeable`, sector };
  }

  // Count open positions in same sector
  const pending = trades.filter(t =>
    (t.action === 'BUY' || t.wouldBuy) && !t.outcome
  );
  const sectorPositions = pending.filter(t => getSector(t.asset) === sector);

  const cap = {
    L1:       3, // allow up to 3 L1s open at once
    L2:       2,
    DEFI:     2,
    MEME:     1, // only 1 meme at a time
    EXCHANGE: 2,
    AI:       2,
    GAMING:   2,
    INFRA:    2,
    OTHER:    2,
  }[sector] || 2;

  const blocked = sectorPositions.length >= cap;

  return {
    blocked,
    sector,
    sectorPositions: sectorPositions.length,
    cap,
    reason: blocked
      ? `Sector cap: already have ${sectorPositions.length}/${cap} ${sector} positions open (${sectorPositions.map(t => t.asset).join(', ')})`
      : null,
  };
}

// Shadow-safe wrapper — shadow/testnet mode never blocks on sector cap
export function checkSectorCapSafe(asset, config) {
  const mode = config.mode || 'shadow';
  const sector = getSector(asset);
  if (sector === 'STABLE') return { blocked: true, reason: `${asset} is a stablecoin`, sector };
  if (mode === 'shadow' || mode === 'testnet') {
    return { blocked: false, sector, sectorPositions: 0, cap: 99, reason: null };
  }
  return checkSectorCap(asset, config);
}

// ── 3. Opportunity Ranking — best-first capital allocation ────────

export function rankAndAllocate(actionable, remainingBudget, config) {
  if (!actionable.length) return [];

  const base = config.baseDCAAmount;

  // Score each signal for capital priority
  // Primary: confidence gap (how far above threshold)
  // Secondary: regime quality (COMPRESSED + RANGING = reliable, VOLATILE + CRASH = risky)
  // Tertiary: smart money, whale, freshness

  const regimeQuality = {
    CAPITULATION: 0.9, OVERSOLD: 0.85, DIP: 0.8,
    NEUTRAL: 0.6, HIGH_VOLATILITY: 0.4, PUMP: 0.3,
    OVERHEATED: 0.2, CRASH: 0.5,
    // Probabilistic dominant regimes
    RANGING: 0.85, COMPRESSED: 0.9, TRENDING: 0.75,
    VOLATILE: 0.35, LIQUIDITY_HUNT: 0.25,
  };

  const ranked = actionable.map(signal => {
    const confGap   = signal.confidence - signal.effectiveThreshold;
    const regime    = signal.dominantRegime || signal.regime;
    const rq        = regimeQuality[regime] ?? 0.5;
    const smBonus   = Math.max(0, (signal.smartMoneyScore || 0)) * 0.3;
    const whaleBon  = Math.max(0, (signal.whaleScore || 0)) * 0.2;
    const freshBon  = ((signal.freshnessDecay || 1.0) - 0.75) * 20;
    const confBon   = (signal.confluenceBonus || 0) * 0.5;

    const priority = confGap * 0.5 + rq * 20 + smBonus + whaleBon + freshBon + confBon;

    return { ...signal, _priority: parseFloat(priority.toFixed(2)) };
  }).sort((a, b) => b._priority - a._priority);

  // Allocate capital — highest priority gets first pick
  let remaining = remainingBudget;
  const allocated = [];

  for (const signal of ranked) {
    if (remaining < base * 0.6) break; // can't afford even minimum size
    allocated.push(signal);
    remaining -= base; // reserve base amount per trade (actual size computed by sizing.js)
  }

  return allocated;
}

// ── 4. Do-Nothing Gate ────────────────────────────────────────────
// If ALL of these are true simultaneously, skip entire cycle

export function checkDoNothingGate(context) {
  const {
    btcPct24h    = 0,
    fearGreed    = 50,
    newsScore    = 0,
    btcRsi       = 50,
    cascadeScore = 0,  // from regime.indicators.cascade
    portfolioHeat,
  } = context;

  const triggers = [];
  let triggerCount = 0;

  // Trigger 1: BTC severe crash
  if (btcPct24h <= -10) {
    triggers.push(`BTC crashed ${btcPct24h.toFixed(1)}% in 24h`);
    triggerCount += 2; // counts double
  } else if (btcPct24h <= -7) {
    triggers.push(`BTC down ${btcPct24h.toFixed(1)}%`);
    triggerCount++;
  }

  // Trigger 2: Extreme fear
  if (fearGreed <= 10) {
    triggers.push(`Extreme Fear ${fearGreed}/100`);
    triggerCount += 2;
  } else if (fearGreed <= 20) {
    triggers.push(`Fear ${fearGreed}/100`);
    triggerCount++;
  }

  // Trigger 3: Negative news storm
  if (newsScore <= -10) {
    triggers.push(`Negative news storm (score ${newsScore})`);
    triggerCount += 2;
  } else if (newsScore <= -6) {
    triggers.push(`Negative news (score ${newsScore})`);
    triggerCount++;
  }

  // Trigger 4: Liquidation cascade detected
  if (cascadeScore >= 0.7) {
    triggers.push(`Liquidation cascade detected (${(cascadeScore * 100).toFixed(0)}%)`);
    triggerCount += 2;
  } else if (cascadeScore >= 0.45) {
    triggers.push(`Cascade risk elevated (${(cascadeScore * 100).toFixed(0)}%)`);
    triggerCount++;
  }

  // Trigger 5: Portfolio already at critical heat
  if (portfolioHeat?.heatLevel === 'CRITICAL') {
    triggers.push(`Portfolio heat CRITICAL (${portfolioHeat.heatPct}%)`);
    triggerCount++;
  }

  // Gate fires when 3+ trigger points accumulated
  // (2-point triggers can fire it alone if severe enough)
  const shouldSkip = triggerCount >= 3;

  return {
    shouldSkip,
    triggerCount,
    triggers,
    narrative: shouldSkip
      ? `🛡️ DO-NOTHING GATE ACTIVATED\n\nMarket conditions too dangerous:\n${triggers.map(t => `  • ${t}`).join('\n')}\n\nCapital preservation mode — skipping cycle. Monitoring continues.`
      : null,
  };
}

// Shadow/testnet safe wrapper — only fires in live mode
// Shadow and testnet should always trade to build learning data
export function checkDoNothingGateSafe(context, mode) {
  if ((mode || 'shadow') !== 'live') {
    // Still log a warning in testnet so you know conditions are dangerous
    const result = checkDoNothingGate(context);
    if (result.shouldSkip) {
      console.warn(`[Gate] Would have fired in live mode: ${result.triggers.join(', ')} — proceeding in ${mode} mode`);
    }
    return { shouldSkip: false, triggerCount: result.triggerCount, triggers: result.triggers, narrative: null };
  }
  return checkDoNothingGate(context);
}

// ── 5. Drawdown Memory ────────────────────────────────────────────
// Tracks open positions and classifies drawdown type

export function analyseDrawdown(asset, currentPrice, btcPct24h = 0) {
  const trades    = loadTrades();
  const portfolio = loadPortfolio();

  // Find open position for this asset
  const openBuys = trades.filter(t =>
    t.asset === asset &&
    (t.action === 'BUY' || t.wouldBuy) &&
    !t.outcome &&
    t.priceAtDecision
  ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!openBuys.length) return { hasOpenPosition: false, drawdownType: null };

  const lastEntry = openBuys[0];
  const entryPrice = lastEntry.priceAtDecision;
  const drawdownPct = (currentPrice - entryPrice) / entryPrice * 100;

  // Classify: is this market-wide or asset-specific?
  // If BTC is also down similar %, it's market-wide
  const isMarketWide = btcPct24h <= -5 && drawdownPct <= -5 &&
    Math.abs(drawdownPct - btcPct24h) < 8; // within 8% of BTC move

  const classification = drawdownPct >= 0 ? 'PROFIT'
    : drawdownPct >= -5  ? 'MINOR_DD'
    : drawdownPct >= -12 ? 'MODERATE_DD'
    : drawdownPct >= -25 ? 'SEVERE_DD'
    : 'EXTREME_DD';

  // Recommendation
  const recommendation =
    classification === 'PROFIT'     ? 'NORMAL'   :
    classification === 'MINOR_DD'   ? 'NORMAL'   :
    classification === 'MODERATE_DD' && isMarketWide  ? 'REDUCE_SIZE' :
    classification === 'MODERATE_DD' && !isMarketWide ? 'CAUTION'     :
    classification === 'SEVERE_DD'  && isMarketWide   ? 'PAUSE_NEW'   :
    classification === 'SEVERE_DD'  && !isMarketWide  ? 'INVESTIGATE' :
    'PAUSE_NEW'; // EXTREME_DD

  const sizeFactor =
    recommendation === 'NORMAL'      ? 1.0  :
    recommendation === 'REDUCE_SIZE' ? 0.85 :
    recommendation === 'CAUTION'     ? 0.75 :
    recommendation === 'PAUSE_NEW'   ? 0.0  :
    recommendation === 'INVESTIGATE' ? 0.5  : 1.0;

  return {
    hasOpenPosition: true,
    asset,
    entryPrice,
    currentPrice,
    drawdownPct:     parseFloat(drawdownPct.toFixed(2)),
    classification,
    isMarketWide,
    recommendation,
    sizeFactor,
    openPositionCount: openBuys.length,
    narrative: sizeFactor < 1.0
      ? `${isMarketWide ? '📉 Market-wide' : '⚠️ Asset-specific'} drawdown ${drawdownPct.toFixed(1)}% — ${recommendation.replace('_', ' ')} (${sizeFactor}x size)`
      : null,
  };
}

// ── Full portfolio assessment (called once per cycle) ─────────────

export function assessPortfolio(config, btcContext = {}) {
  const heat = calcPortfolioHeatSafe(config);

  return {
    heat,
    totalDeployed: heat.totalOpen,
    openAssets:    heat.openAssets,
    isOverheat:    heat.isOverheat,
    heatLevel:     heat.heatLevel,
  };
}

export default {
  calcPortfolioHeat,
  checkSectorCap,
  rankAndAllocate,
  checkDoNothingGate,
  analyseDrawdown,
  assessPortfolio,
  getSector,
};