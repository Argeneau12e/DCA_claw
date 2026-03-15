// ─────────────────────────────────────────────────────────────────
//  DCA CLAW v3 — AI Reasoning Layer
//
//  Makes a Claude API call for each actionable signal.
//  Claude receives all 16 signal scores + regime + ML probability
//  + recent lessons + portfolio context and produces:
//
//    1. A plain-English trade rationale (replaces template eli5)
//    2. A contradiction score (0–10) — how much the signals disagree
//    3. A confidence penalty (0–10pts) applied if contradictions found
//    4. Key risk factors flagged
//
//  API: POST https://api.anthropic.com/v1/messages
//  Model: claude-haiku-4-5-20251001 (fastest + cheapest for this task)
//  Timeout: 8 seconds — if Claude doesn't respond, skip gracefully
//
//  Caches reasoning per (asset + confidence + regime) for 10 minutes
//  so repeated scoring of the same asset doesn't spam the API.
// ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = join(__dirname, '../logs/lessons.json');

// 10-minute reasoning cache
const reasoningCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// ── Load recent lessons ───────────────────────────────────────────

function loadRecentLessons(limit = 3) {
  try {
    if (existsSync(LESSONS_FILE)) {
      const raw = JSON.parse(readFileSync(LESSONS_FILE, 'utf8'));
      return (raw.lessons || []).slice(-limit).map(l => l.lesson || l);
    }
  } catch {}
  return [];
}

// ── Build signal summary for Claude ──────────────────────────────

function buildSignalSummary(signal) {
  const {
    asset, confidence, effectiveThreshold, regime, dominantRegime,
    rsi, rsi4h, priceChangePct, volatility, fundingRate,
    sentimentScore, smartMoneyScore, whaleScore, newsScore,
    mtfAlignment, correlationScore, sessionContext,
    confluenceBonus, freshnessDecay, rlWeight,
    rawSignals, weightedSignals, regimeBlend,
    mlProbability, strategy,
  } = signal;

  const regimeStr = dominantRegime || regime || 'NEUTRAL';
  const blendStr  = regimeBlend
    ? Object.entries(regimeBlend)
        .filter(([, v]) => v > 0.1)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
        .join(', ')
    : regimeStr;

  return `
ASSET: ${asset}
CONFIDENCE: ${confidence}% (threshold ${effectiveThreshold}%)
ML P(WIN): ${mlProbability != null ? (mlProbability * 100).toFixed(0) + '%' : 'not enough data yet'}
STRATEGY: ${strategy || 'DIP_BUYER'}

MARKET CONDITIONS:
- Regime: ${regimeStr} (blend: ${blendStr})
- RSI 1h: ${rsi?.toFixed(1) || '—'} | RSI 4h: ${rsi4h?.toFixed(1) || '—'}
- Price 24h: ${priceChangePct?.toFixed(2) || '—'}%
- Volatility: ${volatility?.toFixed(2) || '—'}%
- Funding rate: ${fundingRate?.toFixed(4) || '—'}

SIGNAL SCORES (positive = bullish, negative = bearish):
- Sentiment (Fear/Greed): ${sentimentScore ?? '—'}pts
- Smart Money (on-chain): ${smartMoneyScore ?? '—'}pts
- Whale order book:       ${whaleScore ?? '—'}pts
- News score:             ${newsScore ?? '—'}pts
- Multi-timeframe:        ${mtfAlignment || '—'}
- Correlation:            ${correlationScore ?? '—'}pts
- Session context:        ${sessionContext?.label || '—'}

SIGNAL QUALITY:
- Confluence bonus: ${confluenceBonus >= 0 ? '+' : ''}${confluenceBonus ?? 0}pts
- Freshness decay:  ${freshnessDecay?.toFixed(2) || '1.00'}x
- RL weight:        ${rlWeight?.toFixed(2) || '1.00'}x
`.trim();
}

// ── Main reasoning function ───────────────────────────────────────

export async function generateReasoning(signal, portfolioContext = {}) {
  const apiKey   = process.env.ANTHROPIC_API_KEY;
  const groqKey  = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    // No Claude key — try Groq (free cloud) first, then Ollama, then rule-based
    console.log(`[Reasoning] No ANTHROPIC_API_KEY — trying Groq for ${signal.asset}`);
    const lessons = loadRecentLessons(3);
    const signalSummary = buildSignalSummary(signal);
    const prompt = buildReasoningPrompt(signalSummary, portfolioContext, lessons);
    if (groqKey) {
      try {
        return await generateGroqReasoning(signal, prompt);
      } catch (groqErr) {
        console.warn(`[Reasoning] Groq failed: ${groqErr.message} — using rule-based fallback`);
        return buildFallbackReasoning(signal);
      }
    }
    return buildFallbackReasoning(signal);
  }

  // Cache key: asset + confidence bucket + regime
  const cacheKey = `${signal.asset}_${Math.round(signal.confidence / 5) * 5}_${signal.dominantRegime || signal.regime}`;
  const cached   = reasoningCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  const lessons = loadRecentLessons(3);
  const signalSummary = buildSignalSummary(signal);
  const portfolioStr  = portfolioContext.heatLevel
    ? `Portfolio heat: ${portfolioContext.heatLevel} (${portfolioContext.heatPct?.toFixed(0)}% of max)`
    : 'Portfolio: clean';

  // Use the same master prompt for Claude too — consistent quality across all models
  const prompt = buildReasoningPrompt(signalSummary, { heatLevel: portfolioContext.heatLevel, heatPct: portfolioContext.heatPct }, lessons);

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages:   [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 8000,
      }
    );

    const text = response.data?.content?.[0]?.text || '';
    let parsed;
    try {
      // Strip any accidental markdown fences
      const clean = text.split('```json').join('').split('```').join('').trim();
      parsed = JSON.parse(clean);
    } catch {
      return buildFallbackReasoning(signal, text);
    }

    const result = {
      rationale:          parsed.rationale         || `${signal.asset} meets ${signal.confidence}% confidence threshold in ${signal.regime} regime.`,
      primarySignal:      parsed.primarySignal     || '',
      keyRisk:            parsed.keyRisk           || '',
      contradictions:     parsed.contradictions    || [],
      contradictionScore: Math.min(10, Math.max(0, parsed.contradictionScore || 0)),
      confidencePenalty:  Math.min(10, Math.max(0, parsed.confidencePenalty  || 0)),
      verdict:            ['BUY','BUY_WITH_CAUTION','WEAK_BUY','SKIP_ENTRY'].includes(parsed.verdict) ? parsed.verdict : 'BUY',
      source:             'claude_api',
      aiVerdict:          parsed.verdict || 'BUY',
    };

    reasoningCache.set(cacheKey, { ts: Date.now(), result });
    return result;

  } catch (e) {
    // Claude failed — try Groq (free cloud) → rule-based
    const _rErrBody = e.response?.data ? JSON.stringify(e.response.data).slice(0,200) : e.message;
    console.warn(`[Reasoning] Claude failed for ${signal.asset}: ${_rErrBody} — trying Groq`);
    try {
      return await generateGroqReasoning(signal, prompt);
    } catch (groqErr) {
      console.warn(`[Reasoning] Groq failed: ${groqErr.message} — using rule-based fallback`);
      return buildFallbackReasoning(signal);
    }
  }
}

// ── Master prompt builder — used by ALL models ───────────────────
// Implements: persona anchoring, DCA philosophy, signal hierarchy,
// few-shot examples, negative prompting, lesson integration, CoT
function buildReasoningPrompt(signalSummary, portfolioContext, lessons) {
  const portfolioStr = portfolioContext?.heatLevel
    ? `Portfolio heat: ${portfolioContext.heatLevel} (${portfolioContext.heatPct?.toFixed(0)}% of max)`
    : 'Portfolio: clean';

  // Contextualise lessons as warnings, not just facts
  const lessonBlock = lessons.length
    ? `LESSONS LEARNED FROM PAST MISTAKES (apply these NOW):\n${lessons.map((l, i) => `${i + 1}. ⚠️ ${l}`).join('\n')}`
    : 'No past lessons yet — this is early in the agent\'s learning curve.';

  return `You are the trade reasoning engine for DCA CLAW — an autonomous Dollar Cost Averaging agent built on Binance.

═══ YOUR CORE MISSION ═══
DCA Claw accumulates crypto during weakness, not strength. It buys dips, oversold conditions, and fear — not pumps, euphoria, or breakouts. A SKIP_ENTRY verdict is NOT a failure — it is often the correct decision that protects capital.

═══ SIGNAL HIERARCHY (most → least important) ═══
TIER 1 (decisive): RSI 1h, Price Action 24h, RSI 4h
TIER 2 (confirmatory): Volume anomaly, Order book imbalance, Multi-timeframe alignment
TIER 3 (contextual): Funding rate, BTC correlation, Sentiment, Smart money
TIER 4 (supplementary): News, Whale activity, Session context, Correlation

When TIER 1 signals disagree with each other — be cautious.
When TIER 1 and TIER 2 agree — that is a strong entry.

═══ VERDICT DECISION RULES ═══
BUY           → TIER 1 aligned bullish, no major contradictions, clean entry timing
BUY_WITH_CAUTION → 1-2 contradictions but TIER 1 still net positive, entry is acceptable
WEAK_BUY      → confidence borderline, TIER 1 mixed, proceed only if budget allows
SKIP_ENTRY    → USE THIS WHEN:
  • Price just pumped 5%+ in last 4h (chasing, not accumulating)
  • RSI is oversold BUT price still falling with accelerating volume (falling knife)
  • Funding rate extremely elevated (>0.02%) — longs already crowded
  • BTC crashing >5% simultaneously — altcoin correlation will drag this down
  • News sentiment strongly negative with no technical catalyst for reversal
  • Multiple TIER 1 signals contradict each other with no clear resolution

DO NOT use SKIP_ENTRY just because: fear index is low (that is a BUY signal for DCA), confidence is moderate (48-60% is acceptable in DIP/OVERSOLD regimes), or the market is sideways (NEUTRAL regime = valid DCA conditions).

═══ FEW-SHOT EXAMPLES ═══
Example 1 — CORRECT BUY:
Signal: RSI 1h=28 (oversold), price -6.2% (dip), volume 1.8x avg, funding -0.003% (shorts dominant), sentiment=22 (extreme fear)
Verdict: BUY — "Classic DCA setup. RSI deeply oversold, significant dip, shorts paying funding, extreme fear = maximum contrarian opportunity. No major contradictions."

Example 2 — CORRECT SKIP_ENTRY:
Signal: RSI 1h=31 (oversold), BUT price +8.3% last 4h (pump), volume 3.2x avg, funding +0.019% (longs crowded)
Verdict: SKIP_ENTRY — "RSI appears oversold but price just pumped 8% in 4 hours — this is a pump, not a dip. Chasing here contradicts the DCA accumulation strategy. Funding is elevated confirming longs already piled in."

Example 3 — CORRECT BUY_WITH_CAUTION:
Signal: RSI 1h=35, price -3.1%, volume 1.2x, news score=-3 (mild negative news), BTC correlation=neutral
Verdict: BUY_WITH_CAUTION — "Decent dip setup with mild RSI weakness. One contradiction: slightly negative news environment. Still valid DCA entry but reduce size."

═══ SIGNAL DATA ═══
${signalSummary}

PORTFOLIO: ${portfolioStr}

${lessonBlock}

═══ YOUR TASK ═══
Step 1: Identify the TIER 1 signals and whether they agree or conflict.
Step 2: Check for any SKIP_ENTRY triggers from the rules above.
Step 3: Weigh contradictions — are they minor (TIER 3/4) or serious (TIER 1/2)?
Step 4: Apply any relevant past lessons to this specific setup.
Step 5: Produce your verdict.

Respond with ONLY this JSON — no preamble, no markdown, no explanation outside the JSON:
{
  "rationale": "2-3 sentences explaining the key signals driving this decision. Name specific values (e.g. RSI 28, price -6%, funding -0.003%). No generic statements.",
  "primarySignal": "The single strongest signal for or against entry (1 sentence with specific value)",
  "keyRisk": "The most important risk right now (1 sentence — be specific, not generic)",
  "contradictions": ["Each contradiction as a specific signal conflict, e.g. RSI oversold but price still falling on high volume"],
  "contradictionScore": 0,
  "confidencePenalty": 0,
  "verdict": "BUY"
}`;
}


// ── Groq fallback reasoning ──────────────────────────────────────
// Free cloud AI — sign up at console.groq.com, add GROQ_API_KEY to .env
// Uses llama3-8b — fast, free, good at structured JSON output
// Rate limit: 30 req/min, 14,400/day — more than enough for DCA Claw

async function generateGroqReasoning(signal, prompt) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  if (!groqKey) throw new Error('No GROQ_API_KEY');

  // CoT system message — persona + philosophy + explicit reasoning steps
  const systemMsg = `You are the trade reasoning engine for DCA CLAW, an autonomous crypto Dollar Cost Averaging agent on Binance.

CORE PHILOSOPHY: DCA Claw accumulates during weakness. Extreme fear, oversold RSI, and significant price dips are OPPORTUNITIES — not reasons to avoid buying. SKIP_ENTRY is reserved for pumps, falling knives, and crowded longs — NOT for fearful markets.

REASONING PROCESS — follow these steps in order:
Step 1: Read the TIER 1 signals (RSI 1h, Price Action, RSI 4h) — do they agree?
Step 2: Check for SKIP_ENTRY triggers: price pumped recently? funding too high? BTC crashing?
Step 3: Look at TIER 2 confirmations — do volume and order book support the thesis?
Step 4: Check past lessons — has this exact setup failed before?
Step 5: Weigh everything and produce a specific, data-grounded verdict.

You must cite specific signal values in your rationale (e.g. "RSI at 28", "price down 6.3%", "funding -0.003%"). Generic statements like "signals look good" are not acceptable.`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       'llama-3.3-70b-versatile',
      messages:    [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: prompt + '\n\nThink step by step, then respond with ONLY the JSON object. No markdown.' },
      ],
      temperature: 0.3,
      max_tokens:  600,
    },
    {
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 15000,
    }
  );

  const text  = response.data?.choices?.[0]?.message?.content || '';
  const clean = text.split('```json').join('').split('```').join('').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Groq returned no JSON');

  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`[Reasoning] Groq (llama3-8b) succeeded for ${signal.asset}`);
  return {
    rationale:          parsed.rationale         || `${signal.asset} meets ${signal.confidence}% confidence.`,
    primarySignal:      parsed.primarySignal     || '',
    keyRisk:            parsed.keyRisk           || '',
    contradictions:     parsed.contradictions    || [],
    contradictionScore: Math.min(10, Math.max(0, parsed.contradictionScore || 0)),
    confidencePenalty:  Math.min(10, Math.max(0, parsed.confidencePenalty  || 0)),
    verdict:            ['BUY','BUY_WITH_CAUTION','WEAK_BUY','SKIP_ENTRY'].includes(parsed.verdict) ? parsed.verdict : 'BUY',
    source:             'groq_llama3',
  };
}



// ── Fallback reasoning (no API key or API error) ──────────────────

function buildFallbackReasoning(signal, rawText = null) {
  const { asset, confidence, effectiveThreshold, regime, rsi, priceChangePct,
          smartMoneyScore, newsScore, whaleScore, confidenceBreakdown } = signal;

  // Build rationale from top breakdown points
  const topPoints = (confidenceBreakdown || []).slice(0, 3);
  const rationale = topPoints.length
    ? `${asset} scores ${confidence}% confidence (threshold ${effectiveThreshold}%) in ${regime} conditions. Key factors: ${topPoints.map(p => p.replace(/\(\+?\-?\d+pts\)/, '').trim()).join('; ')}.`
    : `${asset} meets the ${confidence}% confidence threshold in ${regime} market regime with RSI at ${rsi?.toFixed(1) || '—'} and ${priceChangePct?.toFixed(1) || '—'}% 24h price change.`;

  // Simple contradiction detection (no Claude)
  const contradictions = [];
  if (newsScore < -5 && confidence > 60) contradictions.push('Strong bullish signal but negative news environment');
  if (whaleScore < -5 && smartMoneyScore > 5) contradictions.push('Smart money bullish but whale order book bearish');
  if (rsi < 30 && priceChangePct > 5) contradictions.push('RSI oversold but price still rising — potential false dip');

  return {
    rationale,
    primarySignal:      topPoints[0]?.replace(/\(\+?\-?\d+pts\)/, '').trim() || `${confidence}% confidence`,
    keyRisk:            contradictions[0] || 'Standard market risk — monitor 24h outcome',
    contradictions,
    contradictionScore: Math.min(10, contradictions.length * 3),
    confidencePenalty:  Math.min(8, contradictions.length * 2),
    verdict:            contradictions.length >= 2 ? 'BUY_WITH_CAUTION' : 'BUY',
    source:             rawText ? 'claude_parse_failed' : 'fallback',
  };
}

// ── Format for Telegram notification ─────────────────────────────

export function formatReasoningForTelegram(reasoning, signal) {
  if (!reasoning) return '';

  const verdictEmoji = {
    BUY:              '✅',
    BUY_WITH_CAUTION: '⚠️',
    WEAK_BUY:         '🟡',
  }[reasoning.verdict] || '🎯';

  let msg = `\n\n${verdictEmoji} *AI Reasoning*\n${reasoning.rationale}`;

  if (reasoning.primarySignal) {
    msg += `\n\n📡 *Top signal:* ${reasoning.primarySignal}`;
  }
  if (reasoning.keyRisk) {
    msg += `\n⚠️ *Key risk:* ${reasoning.keyRisk}`;
  }
  if (reasoning.contradictions?.length) {
    msg += `\n\n🔴 *Contradictions:*\n${reasoning.contradictions.map(c => `• ${c}`).join('\n')}`;
  }
  if (reasoning.confidencePenalty > 0) {
    msg += `\n\n_Confidence penalised by ${reasoning.confidencePenalty}pts due to contradictions._`;
  }

  return msg;
}

export default { generateReasoning, formatReasoningForTelegram, buildFallbackReasoning: buildFallbackReasoning };