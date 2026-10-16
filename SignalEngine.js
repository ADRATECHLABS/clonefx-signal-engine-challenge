/**
 * CloneFx Trader Pro - Signal Engine v4
 *
 * v3 used hard AND-gates: trend AND momentum had to both independently agree
 * on direction before a trade was even considered. Real logs showed this
 * stalling for hours during normal pullbacks — a strong H1 trend (EMA50
 * meaningfully above EMA200, price above both) would sit idle whenever M30
 * RSI/MACD dipped mildly bearish, even though that dip-inside-an-uptrend is
 * exactly the kind of setup a trend-follower wants to buy.
 *
 * v4 replaces the hard gates with a continuous WEIGHTED SCORE:
 *
 *   Trend            35%  — magnitude of (EMA50-EMA200)/ATR, not just sign
 *   Momentum         30%  — pullback-and-reversal score, not a fresh AND-gate
 *   Entry/Structure  20%  — same 5-condition system as v3 (rejection,
 *                           engulfing, pullback, breakout, volume), count/5
 *   Volatility fit    15%  — penalizes abnormally compressed/expanded ATR
 *                           relative to its own recent average (a practical,
 *                           candle-only proxy for spread/cost conditions —
 *                           live tick spread isn't available at this layer)
 *
 * A trade fires when the weighted score crosses ±0.5. Nothing is a hard veto
 * any more: a mild momentum disagreement pulls the score down a bit instead
 * of zeroing the whole signal out, so a genuinely strong trend can still
 * carry a trade through a shallow pullback.
 *
 * evaluateTrend / evaluateMomentum / detectRejectionCandle / detectEngulfingCandle
 * are kept with their original boolean-classification signatures and return
 * shapes — ExitManager.js depends on these exactly as before and needs no
 * changes for this upgrade.
 */

const { logger } = require('../utils/logger');

// ─── Minimum candle requirements (data validation) ────────────────────────

const MIN_CANDLES = {
  intraday:   { trend: 220, confirm: 100, entry: 80 },
  long_trade: { trend: 200, confirm: 150, entry: 100 },
};

// Score threshold to fire a trade (calibrate from real trade history later —
// raise toward 0.6-0.65 for fewer/higher-quality trades, lower toward 0.4
// for more trade frequency).
//
// Safe/balanced/aggressive risk-mode presets were removed: position sizing
// now always goes through direct custom lot size + SL/TP pips
// (AutoBotEngine's hasDirectPositionControls path), so there's no separate
// "risk mode" left for the entry filter to key off — every account already
// sizes its own risk explicitly. 0.35 is the old "balanced" value, which is
// what every account was actually running at anyway, since the engine has
// been sending mode:'custom' (not a key in the old mode map, so it always
// fell through to this default).
const DEFAULT_SCORE_THRESHOLD = 0.60;
const SCORE_THRESHOLD = DEFAULT_SCORE_THRESHOLD;

const WEIGHTS = { trend: 0.35, momentum: 0.30, entry: 0.20, volatility: 0.15 };

// ─── Indicator primitives ──────────────────────────────────────────────────

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

// Returns an array of EMA values (one per input bar, null until warmed up)
// so we can read the slope (current vs N bars ago) instead of a single point.
function calcEMASeries(prices, period) {
  if (!prices || prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Returns an array of ATR values (one per bar from `period` onward) so we
// can compare current ATR against its own recent history for the
// volatility-fit score, not just a single latest value.
function calcATRSeries(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const out = [];
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 0.001);
  return 100 - 100 / (1 + rs);
}

// Returns an array of RSI values (one per bar) so momentum scoring can look
// back a few bars to detect a pullback-and-reversal, not just a single point.
function calcRSISeries(prices, period = 14, lookback = 6) {
  const out = [];
  const minLen = period + 1;
  for (let end = prices.length - lookback; end <= prices.length; end++) {
    if (end < minLen) { out.push(null); continue; }
    out.push(calcRSI(prices.slice(0, end), period));
  }
  return out;
}

// Full MACD histogram (MACD line - signal line), not just the MACD line.
// signalPeriod EMA of the MACD line itself.
function calcMACDHistogram(prices, fast = 12, slow = 26, signalPeriod = 9) {
  if (!prices || prices.length < slow + signalPeriod) return null;
  const macdLine = [];
  for (let i = slow - 1; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const emaFast = calcEMA(slice, fast);
    const emaSlow = calcEMA(slice, slow);
    if (emaFast == null || emaSlow == null) continue;
    macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < signalPeriod) return null;
  const signalLine = calcEMA(macdLine, signalPeriod);
  if (signalLine == null) return null;
  const macdNow = macdLine[macdLine.length - 1];
  return macdNow - signalLine; // histogram value
}

// Returns the last `count` MACD histogram values, for trend-of-the-histogram
// detection (is it rising/falling), used by the pullback-reversal score.
function calcMACDHistogramSeries(prices, count = 4, fast = 12, slow = 26, signalPeriod = 9) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = prices.length - i;
    if (end < slow + signalPeriod) { out.push(null); continue; }
    out.push(calcMACDHistogram(prices.slice(0, end), fast, slow, signalPeriod));
  }
  return out;
}

function avgVolume(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((a, c) => a + (c.volume || 0), 0) / slice.length;
}

function detectRejectionCandle(candle) {
  if (!candle) return null;
  const body  = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range === 0) return null;
  const lower = Math.min(candle.open, candle.close) - candle.low;
  const upper = candle.high - Math.max(candle.open, candle.close);
  if (lower > body * 1.5 && lower > range * 0.4) return 'bullish';
  if (upper > body * 1.5 && upper > range * 0.4) return 'bearish';
  return null;
}

// Bullish engulfing: current candle's body fully engulfs the previous candle's
// body, and current candle is bullish while previous was bearish (or smaller).
function detectEngulfingCandle(prev, curr) {
  if (!prev || !curr) return null;
  const currBull = curr.close > curr.open;
  const currBear = curr.close < curr.open;
  const prevBull = prev.close > prev.open;
  const prevBear = prev.close < prev.open;
  const currBody = Math.abs(curr.close - curr.open);
  const prevBody = Math.abs(prev.close - prev.open);
  if (currBody === 0 || prevBody === 0) return null;

  if (currBull && prevBear && curr.open <= prev.close && curr.close >= prev.open && currBody > prevBody) {
    return 'bullish';
  }
  if (currBear && prevBull && curr.open >= prev.close && curr.close <= prev.open && currBody > prevBody) {
    return 'bearish';
  }
  return null;
}

// Pullback to EMA20: price touched/crossed the EMA20 within the last few bars
// and is now resuming in the trend direction (i.e. a genuine pullback-entry,
// not just "close to the line" all the time).
function detectPullbackToEMA(closes, emaSeries, direction, lookback = 5) {
  if (!emaSeries || emaSeries.length < lookback + 1) return false;
  const n = closes.length;
  let touched = false;
  for (let i = n - lookback; i < n - 1; i++) {
    if (emaSeries[i] == null) continue;
    const dist = Math.abs(closes[i] - emaSeries[i]);
    const proximity = dist / closes[i] < 0.0015; // within ~0.15%
    if (proximity) { touched = true; break; }
  }
  if (!touched) return false;
  const lastClose = closes[n - 1];
  const lastEma    = emaSeries[n - 1];
  if (lastEma == null) return false;
  return direction === 'BUY' ? lastClose > lastEma : lastClose < lastEma;
}

// Breakout of recent swing high/low (excluding the current bar itself).
function detectSwingBreakout(candles, direction, lookback = 20) {
  if (!candles || candles.length < lookback + 1) return false;
  const recent = candles.slice(-lookback - 1, -1); // exclude current bar
  const curr   = candles[candles.length - 1];
  if (direction === 'BUY') {
    const swingHigh = Math.max(...recent.map((c) => c.high));
    return curr.close > swingHigh;
  } else {
    const swingLow = Math.min(...recent.map((c) => c.low));
    return curr.close < swingLow;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function _confidence(passedCount, totalCount) {
  return Math.round((passedCount / totalCount) * 100);
}

function getSignalRejectionReasons({ direction, trend, momentumScore, entryPassedCount, totalScore, threshold }) {
  const reasons = [];
  const alignedTrend = (direction === 'BUY' && trend === 'bull') || (direction === 'SELL' && trend === 'bear');
  if (!alignedTrend) reasons.push('trend_alignment_failed');
  if (!(momentumScore > 0)) reasons.push('momentum_confirmation_failed');
  if (!(entryPassedCount > 0)) reasons.push('missing_entry_pattern');
  if (!(totalScore >= threshold)) reasons.push('weak_confidence');
  return reasons;
}

// ─── Trend classification (kept for ExitManager.js compatibility) ─────────
//
// Bull: price > EMA200 AND EMA50 > EMA200
// Bear: price < EMA200 AND EMA50 < EMA200
// This boolean classification is still used by ExitManager's "trend change"
// and "EMA50 cross against position" exit rules — those should stay binary,
// since an open position genuinely needs a clear invalidation signal to
// close, not a partial score. Only the ENTRY decision below moves to scoring.

function evaluateTrend(trendCloses, slopeLookback = 10) {
  const emaSeries200 = calcEMASeries(trendCloses, 200);
  const ema200 = emaSeries200[emaSeries200.length - 1];
  const ema50  = calcEMA(trendCloses, 50);
  if (ema200 == null || ema50 == null) return { trend: 'none', ema200: null, ema50: null, slope: null };

  const price = trendCloses[trendCloses.length - 1];

  const priorIdx = emaSeries200.length - 1 - slopeLookback;
  const priorEma200 = priorIdx >= 0 ? emaSeries200[priorIdx] : null;
  const slope = priorEma200 != null ? ema200 - priorEma200 : null;

  const bullTrend = price > ema200 && ema50 > ema200;
  const bearTrend = price < ema200 && ema50 < ema200;

  return {
    trend: bullTrend ? 'bull' : bearTrend ? 'bear' : 'none',
    bullTrend, bearTrend,
    ema200, ema50, slope, price,
  };
}

// ─── Momentum classification (kept for ExitManager.js compatibility) ──────
//
// Same RSI/MACD AND-gate as v3. ExitManager's "momentum reversal" exit rule
// relies on this exact boolean behavior. The ENTRY scoring below uses a
// separate, continuous momentum score instead of this classification.

function evaluateMomentum(confirmCloses) {
  const rsi  = calcRSI(confirmCloses, 14);
  const hist = calcMACDHistogram(confirmCloses);

  if (rsi == null) return { momentum: 'none', rsi: null, histogram: hist, bullMomentum: false, bearMomentum: false };
  if (rsi >= 45 && rsi <= 55) return { momentum: 'sideways', rsi, histogram: hist, bullMomentum: false, bearMomentum: false };

  const bullMomentum = rsi > 55 && hist != null && hist > 0;
  const bearMomentum = rsi < 45 && hist != null && hist < 0;

  return { momentum: bullMomentum ? 'bull' : bearMomentum ? 'bear' : 'none', rsi, histogram: hist, bullMomentum, bearMomentum };
}

// ─── Scored Trend Factor (-1 to +1) ─────────────────────────────────────────
//
// Magnitude-aware: a trend with EMA50 far above EMA200 (relative to ATR)
// scores closer to +1; a trend that's barely separated scores closer to 0.
// This replaces the v3 hard bullTrend/bearTrend boolean as the ENTRY signal
// input (evaluateTrend() above is still used for ExitManager compatibility).

function scoreTrend(trendCloses, atr) {
  const trendResult = evaluateTrend(trendCloses);
  if (trendResult.ema200 == null || trendResult.ema50 == null || !atr) {
    return { score: 0, ...trendResult };
  }
  const { price, ema200, ema50 } = trendResult;
  const gap = ema50 - ema200;

  // BUG FIX: previously this only normalized (EMA50-EMA200)/ATR, which can
  // be misleadingly positive even while PRICE has already dropped below
  // EMA200 — a lagging-EMA50 artifact right after a sharp reversal (EMA50
  // hasn't caught down to EMA200 yet). That produced Direction=BUY with a
  // positive TrendScore while price was actually falling through both EMAs,
  // a live risk of opening a wrong-direction trade. Price's own position
  // relative to EMA200 must set the SIGN; the EMA50/EMA200 gap only adds or
  // subtracts MAGNITUDE (agreement strengthens the score, disagreement
  // weakens/can flip it) — it can no longer override where price actually is.
  const priceSide = price > ema200 ? 1 : price < ema200 ? -1 : 0;
  const gapSide   = gap > 0 ? 1 : gap < 0 ? -1 : 0;

  // Noise-floor dampener: in a genuinely flat/choppy market, ATR can be tiny
  // (price barely moves at all), which makes the (price-ema200)/atr and
  // gap/atr normalizations blow up from pure random noise — a 0.46-point
  // EMA50/EMA200 separation isn't a "strong trend", it's noise, but dividing
  // it by a near-zero ATR can clamp straight to the ±1 ceiling. Require the
  // EMA50/EMA200 gap to be at least 0.15 ATR before treating the trend as
  // having any real conviction; below that, scale the whole score down
  // toward zero rather than letting the ATR normalization alone decide.
  const gapInAtr = Math.abs(gap) / atr;
  const noiseFloorFactor = clamp(gapInAtr / 0.15, 0, 1);

  // Normalize price's own distance from EMA200 by ATR (this is the primary,
  // authoritative signal — price is the ground truth, EMAs are derived from it).
  const priceComponent = clamp((price - ema200) / atr, -2, 2) / 2;

  // EMA50/EMA200 gap is a secondary confirmation: agrees with price → adds
  // confidence toward the same side; disagrees (the lagging-artifact case
  // from this bug) → pulls the score toward neutral instead of flipping sign.
  const gapComponent = clamp(gap / atr, -2, 2) / 2;
  const gapAgrees = priceSide !== 0 && gapSide === priceSide;

  const rawScore = gapAgrees
    ? clamp(0.7 * priceComponent + 0.3 * gapComponent, -1, 1)
    : clamp(priceComponent * 0.6, -1, 1); // disagreement: keep price's side, dampen magnitude

  const score = rawScore * noiseFloorFactor;

  return { score, ...trendResult };
}

// ─── Scored Momentum Factor (-1 to +1) — pullback & reversal detection ─────
//
// This is the actual fix for the stalling problem: instead of requiring RSI
// to ALREADY be bullish (>55) before a BUY can even be considered, this
// rewards a momentum DIP-AND-RECOVERY — RSI was soft recently and is now
// turning back up, MACD histogram rising even if still negative. A
// confirmed/strong bullish RSI+MACD still scores highest; a fresh dip with
// no recovery yet scores low/negative; a dip that's actively recovering
// scores positive even while RSI is still under 50.

function scoreMomentum(confirmCloses, direction) {
  const rsiSeries  = calcRSISeries(confirmCloses, 14, 6);
  const histSeries = calcMACDHistogramSeries(confirmCloses, 4);

  const rsiNow  = rsiSeries[rsiSeries.length - 1];
  const histNow = histSeries[histSeries.length - 1];

  if (rsiNow == null) return { score: 0, rsi: null, histogram: histNow };

  // RSI distance from neutral (50), signed by direction, normalized to +/-1
  // over a 0-30 point range (RSI 50->80 or 50->20 = fully strong).
  const rsiDirSigned = direction === 'BUY' ? (rsiNow - 50) : (50 - rsiNow);
  const rsiComponent = clamp(rsiDirSigned / 30, -1, 1);

  // RSI trend over the lookback window — is it rising (good for BUY) or
  // falling (good for SELL)? This is what actually detects "pulling back
  // and now recovering" rather than "already fully bullish".
  const validRsi = rsiSeries.filter((v) => v != null);
  let rsiSlopeComponent = 0;
  if (validRsi.length >= 2) {
    const rsiSlope = validRsi[validRsi.length - 1] - validRsi[0];
    const rsiSlopeSigned = direction === 'BUY' ? rsiSlope : -rsiSlope;
    rsiSlopeComponent = clamp(rsiSlopeSigned / 10, -1, 1);
  }

  // MACD histogram trend — rising histogram (even if still negative) means
  // bearish momentum is FADING, which is the reversal signal for a BUY.
  const validHist = histSeries.filter((v) => v != null);
  let histComponent = 0;
  if (validHist.length >= 2) {
    const histNowVal  = validHist[validHist.length - 1];
    const histSlope    = validHist[validHist.length - 1] - validHist[0];
    const histSlopeSigned = direction === 'BUY' ? histSlope : -histSlope;
    const histLevelSigned = direction === 'BUY' ? histNowVal : -histNowVal;
    // Blend level (is it already on the right side of zero) with slope (is
    // it moving the right way) — weighted toward slope, since that's the
    // actual "reversal in progress" signal this function exists to catch.
    histComponent = clamp(0.4 * (histLevelSigned / 0.5) + 0.6 * (histSlopeSigned / 0.3), -1, 1);
  }

  // Final momentum score: RSI level (40%), RSI slope/reversal (35%), MACD
  // histogram level+slope (25%). RSI level still matters most, but a
  // recovering RSI/MACD pair can push the score positive well before RSI
  // crosses the old hard 55/45 thresholds.
  const score = clamp(0.40 * rsiComponent + 0.35 * rsiSlopeComponent + 0.25 * histComponent, -1, 1);

  return { score, rsi: rsiNow, histogram: histNow, rsiComponent, rsiSlopeComponent, histComponent };
}

// ─── Scored Volatility-Fit Factor (0 to 1, never negative) ─────────────────
//
// Penalizes entries when current ATR is abnormally compressed or expanded
// relative to its own recent average. Live bid/ask spread isn't available
// at this layer (only candle data is passed in here) — this is a practical,
// candle-only proxy: very low ATR often precedes a spread-widening breakout
// that chews through stops; very high ATR means costs and slippage are
// already elevated relative to normal conditions for this symbol right now.

function scoreVolatilityFit(trendCandles) {
  const atrSeries = calcATRSeries(trendCandles, 14);
  if (atrSeries.length < 20) return { score: 0, atrNow: null, atrAvg: null, available: false };

  const atrNow = atrSeries[atrSeries.length - 1];
  const atrAvg = atrSeries.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (!atrAvg) return { score: 0, atrNow, atrAvg, available: false };

  const ratio = atrNow / atrAvg; // 1.0 = normal, <0.5 = very compressed, >2 = very expanded
  // Full score (1.0) in the 0.7-1.5x normal-ATR band; tapers to 0 outside a
  // 0.3x-2.5x band.
  let score;
  if (ratio >= 0.7 && ratio <= 1.5) score = 1;
  else if (ratio < 0.7) score = clamp((ratio - 0.3) / 0.4, 0, 1);
  else score = clamp((2.5 - ratio) / 1.0, 0, 1);

  return { score, atrNow, atrAvg, ratio };
}

function scoreVolatilityContribution(volatilityFit) {
  if (volatilityFit?.available === false) return 0;
  return Math.min(0, Number(volatilityFit?.score) - 1);
}

// ─── Entry/Structure condition scoring (count/5, same conditions as v3) ────

// Entry condition point values (spec-exact, sum to 1.0):
//   rejection candle      = 0.20
//   engulfing candle      = 0.25
//   pullback confirmation = 0.20
//   breakout confirmation = 0.25
//   above-average volume  = 0.10
// Previously this was a flat count/5 (each condition worth exactly 0.20
// regardless of quality) — weighting reflects that a confirmed engulfing or
// breakout is a stronger, more decisive entry signal than a generic
// near-EMA "pullback" tag.
const ENTRY_POINTS = { rejection: 0.20, engulfing: 0.25, pullback: 0.20, breakout: 0.25, volumeAboveAvg: 0.10 };

function evaluateEntryConditions({ direction, entryCandles, trendCandles }) {
  const entryCloses = entryCandles.map((c) => c.close);
  const last  = entryCandles[entryCandles.length - 1];
  const prev  = entryCandles[entryCandles.length - 2];

  const rejection = detectRejectionCandle(last);
  const engulfing = detectEngulfingCandle(prev, last);
  const ema20Series = calcEMASeries(entryCloses, 20);
  const pullback = detectPullbackToEMA(entryCloses, ema20Series, direction);
  const breakout = detectSwingBreakout(entryCandles, direction, 20);

  const avgVol = avgVolume(entryCandles, 20);
  const lastVol = last.volume || 0;
  const volumeAboveAvg = avgVol != null && avgVol > 0 && lastVol > avgVol;

  const conditions = {
    rejection: direction === 'BUY' ? rejection === 'bullish' : rejection === 'bearish',
    engulfing: direction === 'BUY' ? engulfing === 'bullish' : engulfing === 'bearish',
    pullback,
    breakout,
    volumeAboveAvg,
  };

  const passedCount = Object.values(conditions).filter(Boolean).length;
  const score = Object.entries(conditions).reduce(
    (sum, [key, passed]) => sum + (passed ? ENTRY_POINTS[key] : 0), 0
  );
  return { conditions, passedCount, score };
}

// ─── Public: full signal analysis for one cycle ─────────────────────────────

function analyseSignal({ tradingStyle, trendCandles, confirmCandles, entryCandles, accountId, minimumSignalScore = DEFAULT_SCORE_THRESHOLD }) {
  const req = MIN_CANDLES[tradingStyle] || MIN_CANDLES.intraday;
  const configuredThreshold = Number(minimumSignalScore);
  const threshold = Number.isFinite(configuredThreshold) ? clamp(configuredThreshold, 0.40, 0.90) : DEFAULT_SCORE_THRESHOLD;

  if (!trendCandles || trendCandles.length < req.trend) {
    logger.debug(`[Signal][${accountId}] Skip: trend candles ${trendCandles?.length || 0}/${req.trend}`);
    return { signal: null, reason: 'insufficient_trend_data' };
  }
  if (!confirmCandles || confirmCandles.length < req.confirm) {
    logger.debug(`[Signal][${accountId}] Skip: confirm candles ${confirmCandles?.length || 0}/${req.confirm}`);
    return { signal: null, reason: 'insufficient_confirm_data' };
  }
  if (!entryCandles || entryCandles.length < req.entry) {
    logger.debug(`[Signal][${accountId}] Skip: entry candles ${entryCandles?.length || 0}/${req.entry}`);
    return { signal: null, reason: 'insufficient_entry_data' };
  }

  const trendCloses   = trendCandles.map((c) => c.close);
  const confirmCloses = confirmCandles.map((c) => c.close);
  const atr   = calcATR(trendCandles, 14);
  const price = trendCloses[trendCloses.length - 1];

  if (!atr) {
    logger.debug(`[Signal][${accountId}] Skip: ATR unavailable`);
    return { signal: null, reason: 'no_atr' };
  }

  const trendScored = scoreTrend(trendCloses, atr);
  const volFit       = scoreVolatilityFit(trendCandles);

  // Direction is decided by the SIGN of the trend score — even a mild trend
  // tilt picks a side. Momentum/entry/volatility then determine whether that
  // tilt is strong enough to actually trade, via the weighted total.
  const direction = trendScored.score > 0 ? 'BUY' : trendScored.score < 0 ? 'SELL' : null;

  const dashboard = {
    trend: trendScored.trend,
    bullTrend: trendScored.bullTrend,
    bearTrend: trendScored.bearTrend,
    ema200: trendScored.ema200,
    ema50: trendScored.ema50,
    slope: trendScored.slope,
    trendScore: parseFloat(trendScored.score.toFixed(3)),
    volatilityScore: parseFloat(volFit.score.toFixed(3)),
    volatilityAvailable: volFit.available !== false,
    atrRatio: volFit.ratio != null ? parseFloat(volFit.ratio.toFixed(2)) : null,
    threshold,
  };

  if (!direction) {
    logger.debug(`[DEBUG] TrendScore=0.000 — price exactly on EMA200, no directional tilt | price=${price.toFixed(5)} ema200=${trendScored.ema200?.toFixed(5)}`);
    logger.info(`[Signal][${accountId}] Trade rejected: Reason = No directional trend tilt (price exactly on EMA200)`);
    return { signal: null, reason: 'no_trend_tilt', dashboard };
  }

  const momentumScored = scoreMomentum(confirmCloses, direction);
  const entryScored    = evaluateEntryConditions({ direction, entryCandles, trendCandles });
  const rejectionReasons = [];

  dashboard.momentumScore = parseFloat(momentumScored.score.toFixed(3));
  dashboard.rsi = momentumScored.rsi != null ? parseFloat(momentumScored.rsi.toFixed(1)) : null;
  dashboard.macdHistogram = momentumScored.histogram != null ? parseFloat(momentumScored.histogram.toFixed(5)) : null;
  dashboard.entryScore = entryScored.score;
  dashboard.entryConditionsPassed = entryScored.passedCount;
  dashboard.entryConditions = entryScored.conditions;

  // Hard momentum gate REMOVED (by request): momentum can no longer reject a trade.
  // The momentum score is still computed and shown on the dashboard.

  // ── Weighted total score ───────────────────────────────────────────────
  // Entry/structure and volatility scores are direction-agnostic 0-1 values;
  // they contribute their full weight in the direction the trend already
  // picked. Trend uses its absolute magnitude (conviction in the chosen
  // direction, regardless of which side).
  //
  // FIX: momentum was previously added RAW, including its full negative
  // range. That meant a momentum reading that simply hasn't caught up to
  // the trend yet (a pullback still in progress, not yet reversing) was
  // penalized identically to momentum actively accelerating AGAINST the
  // trade — both just subtracted from the total. A strong trend with
  // merely-lagging momentum should still be tradeable; a strong trend
  // fighting hard-reversing momentum should not. The floor below softens
  // (but does not remove) the penalty for negative momentum, so a strong
  // trend score can still carry the total over threshold when momentum is
  // mildly against it, while a deeply negative momentum (genuine reversal
  // risk) still meaningfully drags the score down.
  // FIX: momentumScored.score being negative does NOT by itself distinguish
  // "momentum simply hasn't caught up to a fresh trend yet" (safe to dampen)
  // from "momentum is actively reversing against an already-extended trend"
  // (should NOT be dampened — this is real, in-progress reversal risk).
  // scoreMomentum() already computes rsiSlopeComponent specifically to
  // capture that distinction (it's described there as "the actual reversal
  // in progress signal"), so reuse it as the gate: only dampen when the
  // slope isn't actively moving against the trade direction. Without this
  // gate, a strongly-extended trendScore (near its +/-1 floor — i.e. price
  // far from EMA200, a stretched move, not a fresh one) could carry a trade
  // through threshold purely on trend magnitude while RSI climbed steadily
  // against the position across many consecutive cycles — entries the
  // structure-break / momentum-reversal exit rules then immediately closed,
  // because the reversal they were detecting was already real at entry.
  const momentumActivelyReversing = momentumScored.rsiSlopeComponent < -0.15;
  const momentumContribution = momentumScored.score >= 0
    ? momentumScored.score
    : momentumActivelyReversing
      ? momentumScored.score        // full penalty — genuine reversal in progress
      : momentumScored.score * 0.4; // dampened — merely lagging, not reversing

  // Volatility is a cost/risk suitability check, not directional evidence.
  // A normal ATR ratio must not add confidence to an otherwise weak setup.
  const volatilityContribution = scoreVolatilityContribution(volFit);
  const totalScore =
    WEIGHTS.trend      * Math.abs(trendScored.score) +
    WEIGHTS.momentum   * momentumContribution +
    WEIGHTS.entry      * entryScored.score +
    WEIGHTS.volatility * volatilityContribution;

  dashboard.totalScore = parseFloat(totalScore.toFixed(3));
  dashboard.scoreThreshold = threshold;
  rejectionReasons.push(...getSignalRejectionReasons({
    direction, trend: trendScored.trend, momentumScore: momentumScored.score,
    entryPassedCount: entryScored.passedCount, totalScore, threshold,
  }));
  dashboard.rejectionReasons = rejectionReasons;

  const decision = rejectionReasons.length === 0 ? direction : null;

  logger.debug(
    `[DEBUG] Direction=${direction} TrendScore=${trendScored.score.toFixed(3)} MomentumScore=${momentumScored.score.toFixed(3)} ` +
    `EntryScore=${entryScored.score.toFixed(3)} VolatilityScore=${volFit.score.toFixed(3)} TotalScore=${totalScore.toFixed(3)} ` +
    `Threshold=${threshold} | price=${price.toFixed(5)} ema200=${trendScored.ema200?.toFixed(5)} ema50=${trendScored.ema50?.toFixed(5)} ` +
    `RSI=${momentumScored.rsi?.toFixed(1) ?? 'n/a'} MACD=${momentumScored.histogram != null ? momentumScored.histogram.toFixed(5) : 'n/a'} ` +
    `entryConditions=${JSON.stringify(entryScored.conditions)}`
  );

  // Spec-exact summary log format
  logger.info(
    `[Signal]\n` +
    `Trend=${trendScored.score.toFixed(2)}\n` +
    `Momentum=${momentumScored.score.toFixed(2)}\n` +
    `Entry=${entryScored.score.toFixed(2)}\n` +
    `Volatility=${volFit.score.toFixed(2)}\n` +
    `Total=${totalScore.toFixed(2)}\n` +
    `Threshold=${threshold}\n` +
    `Decision=${decision || 'REJECT'} | Rejections=${rejectionReasons.join(',') || 'none'}`
  );

  const confidence = Math.max(0, Math.round(totalScore * 100));
  dashboard.confidence = confidence;

  logger.info(`[Signal][${accountId}] ${direction} signal: totalScore=${totalScore.toFixed(3)} confidence=${confidence}% threshold=${threshold} (trend=${trendScored.score.toFixed(2)} momentum=${momentumScored.score.toFixed(2)} entry=${entryScored.score.toFixed(2)} volatility=${volFit.score.toFixed(2)})`);

  if (!decision) {
    logger.info(`[Signal][${accountId}] Rejected: ${rejectionReasons.join(',')}`);
    return { signal: null, reason: rejectionReasons[0] || 'signal_rejected', dashboard };
  }
  return {
    signal: {
      direction, atr, price, confidence,
      entryConditions: entryScored.conditions,
      momentumScore: parseFloat(momentumScored.score.toFixed(3)),
      totalScore: dashboard.totalScore,
    },
    reason: 'signal_generated',
    dashboard,
  };
}

module.exports = {
  analyseSignal,
  getSignalRejectionReasons,
  evaluateTrend,
  evaluateMomentum,
  evaluateEntryConditions,
  scoreTrend,
  scoreMomentum,
  scoreVolatilityFit,
  scoreVolatilityContribution,
  calcEMA,
  calcEMASeries,
  calcATR,
  calcATRSeries,
  calcRSI,
  calcRSISeries,
  calcMACDHistogram,
  calcMACDHistogramSeries,
  detectRejectionCandle,
  detectEngulfingCandle,
  detectSwingBreakout,
  MIN_CANDLES,
  SCORE_THRESHOLD,
  ENTRY_POINTS,
  WEIGHTS,
};
