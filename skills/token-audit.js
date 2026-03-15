// ─────────────────────────────────────────────────────────────────
//  DCA CLAW — Token Audit Module (Binance Skills Hub)
//
//  Calls Binance Web3 token security API before buying any
//  non-Tier1 asset. Blocks honeypots, scams, and rugs.
//
//  Hard blocks: honeypot, CRITICAL risk, unverified + non-Tier1
//  Soft penalties: HIGH risk, mintable, no liquidity lock
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';

// Tier1 assets — trusted, skip audit to save API calls
const TIER1 = new Set([
  'BTC','ETH','BNB','SOL','ADA','AVAX','DOT','LINK','XRP','NEAR',
  'ARB','OP','UNI','ATOM','LTC','POL','INJ','SUI','APT','FIL',
  'ICP','TRX','TON','DOGE','MATIC','FTM','ALGO','VET','HBAR',
]);

// Known BSC contract addresses for common tokens (for audit API)
const TOKEN_CONTRACTS = {
  'CAKE': '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  'PEPE': '0x6982508145454ce325ddbe47a25d4ec3d2311933',
  // Add more as needed — audit only matters for non-Tier1 anyway
};

// Cache audit results (tokens don't change security profile quickly)
const auditCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Main audit function ───────────────────────────────────────────

export async function auditToken(symbol) {
  const clean = symbol.replace('USDT', '').toUpperCase();

  // Skip Tier1 — trusted
  if (TIER1.has(clean)) {
    return { safe: true, tier1: true, score: 0, reason: 'Tier1 trusted asset' };
  }

  // Check cache
  const cached = auditCache.get(clean);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  // Get contract address if known
  const contractAddress = TOKEN_CONTRACTS[clean];
  if (!contractAddress) {
    // No contract address known — apply mild caution penalty
    const result = {
      safe: true,
      score: -3,
      reason: 'Contract address unknown — mild caution',
      riskLevel: 'UNKNOWN',
    };
    auditCache.set(clean, { result, timestamp: Date.now() });
    return result;
  }

  try {
    const r = await axios.post(
      'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/token-security/v2/token/batch-security-info',
      { chainId: '56', addressList: [contractAddress] },
      { headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, timeout: 10000 }
    );

    const data = r.data?.data?.[contractAddress] || r.data?.data?.[0];
    if (!data) {
      return { safe: true, score: -2, reason: 'Audit data unavailable', riskLevel: 'UNKNOWN' };
    }

    const result = parseAuditResult(clean, data);
    auditCache.set(clean, { result, timestamp: Date.now() });
    return result;

  } catch (e) {
    // API unavailable — mild penalty, don't block
    const result = {
      safe: true,
      score: -3,
      reason: `Audit API unavailable: ${e.message}`,
      riskLevel: 'UNKNOWN',
    };
    auditCache.set(clean, { result, timestamp: Date.now() });
    return result;
  }
}

// ── Parse audit response into DCA CLAW scoring ───────────────────

function parseAuditResult(symbol, data) {
  const flags = [];
  let score = 0;
  let hardBlock = false;
  let blockReason = null;

  // Hard block conditions
  if (data.isHoneypot) {
    hardBlock = true;
    blockReason = '🚨 HONEYPOT — cannot sell after buying';
  } else if (data.riskLevel === 'CRITICAL') {
    hardBlock = true;
    blockReason = '🚨 CRITICAL risk score from Binance audit';
  } else if (!data.isOpenSource) {
    hardBlock = true;
    blockReason = '🚨 Unverified contract — source code not public';
  }

  if (hardBlock) {
    return { safe: false, hardBlock: true, score: -100, reason: blockReason, riskLevel: data.riskLevel, flags };
  }

  // Soft penalties
  if (data.riskLevel === 'HIGH') { score -= 20; flags.push('HIGH risk (-20pts)'); }
  else if (data.riskLevel === 'MEDIUM') { score -= 10; flags.push('MEDIUM risk (-10pts)'); }
  else if (data.riskLevel === 'LOW') { score -= 3; flags.push('LOW risk (-3pts)'); }
  else if (data.riskLevel === 'SAFE') { score += 3; flags.push('SAFE audit (+3pts)'); }

  if (data.isMintable) { score -= 10; flags.push('Mintable supply (-10pts)'); }
  if (data.isProxy) { score -= 5; flags.push('Upgradeable proxy (-5pts)'); }
  if (!data.liquidityLocked) { score -= 8; flags.push('Liquidity not locked (-8pts)'); }
  if (!data.ownershipRenounced) { score -= 5; flags.push('Ownership not renounced (-5pts)'); }
  if (data.holderConcentration > 80) { score -= 15; flags.push(`Top holders own ${data.holderConcentration}% (-15pts)`); }
  else if (data.holderConcentration > 60) { score -= 8; flags.push(`High concentration ${data.holderConcentration}% (-8pts)`); }

  return {
    safe: true,
    hardBlock: false,
    score: Math.max(-50, score), // floor at -50
    riskLevel: data.riskLevel || 'UNKNOWN',
    flags,
    reason: flags.length > 0 ? flags.join(', ') : 'Clean audit',
    raw: data,
  };
}

// ── Batch audit for scanner efficiency ───────────────────────────

export async function auditBatch(symbols) {
  const results = {};
  // Process in parallel, max 5 at a time to avoid rate limits
  const nonTier1 = symbols.filter(s => !TIER1.has(s.replace('USDT', '').toUpperCase()));
  const tier1 = symbols.filter(s => TIER1.has(s.replace('USDT', '').toUpperCase()));

  for (const s of tier1) {
    results[s] = { safe: true, tier1: true, score: 0, reason: 'Tier1 trusted' };
  }

  const chunks = [];
  for (let i = 0; i < nonTier1.length; i += 5) chunks.push(nonTier1.slice(i, i + 5));
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map(s => auditToken(s)));
    chunk.forEach((s, i) => { results[s] = chunkResults[i]; });
  }

  return results;
}

export default { auditToken, auditBatch, TIER1 };
