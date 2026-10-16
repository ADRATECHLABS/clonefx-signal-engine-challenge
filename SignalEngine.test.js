/**
 * CloneFx Trader Pro - Signal Engine Tests
 * Tests: EMA calculation, ATR, RSI, swing breakout, rejection candle
 *
 * WIRING FIX: previously required from '../engine/src/autobot/AutoBotEngine',
 * which no longer defines any of these — v3 of AutoBotEngine.js delegates all
 * signal math to SignalEngine.js's analyseSignal(). Updated to import from
 * SignalEngine.js directly, and to match its current exports:
 *
 *   - detectBreakout(candles, lookback) → { type } no longer exists; it was
 *     replaced by detectSwingBreakout(candles, direction, lookback) → boolean.
 *     Tests below use the new signature/return shape.
 *   - detectRejectionCandle(candle) now returns 'bullish' / 'bearish' (not
 *     'bullish_rejection' / 'bearish_rejection'). Assertions updated to match.
 *   - isLondonSession / isNewYorkSession do not exist anywhere in
 *     SignalEngine.js. Session filtering was removed in this version (the UI
 *     also hardcodes settings.sessionFilter: false, and AutoBotEngine.js has
 *     no session check anywhere) — this isn't a wiring gap, it's a strategy
 *     decision already reflected across the codebase, so those tests are
 *     removed rather than pointed at something that doesn't exist. If session
 *     filtering comes back, these tests should be reinstated against wherever
 *     that logic lands.
 */

const {
  calcEMA,
  calcATR,
  calcRSI,
  detectSwingBreakout,
  detectRejectionCandle,
  getSignalRejectionReasons,
  scoreVolatilityFit,
  scoreVolatilityContribution,
} = require('./SignalEngine');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandles(count, basePrice = 2300, trend = 0) {
  const candles = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 5 + trend;
    const open   = price;
    const close  = price + change;
    const high   = Math.max(open, close) + Math.random() * 3;
    const low    = Math.min(open, close) - Math.random() * 3;
    candles.push({ time: Date.now() - (count - i) * 3600000, open, high, low, close });
    price = close;
  }
  return candles;
}

function makePrices(count, start = 1.0, trend = 0.001) {
  return Array.from({ length: count }, (_, i) => start + i * trend + (Math.random() - 0.5) * 0.001);
}

describe('critical signal gates', () => {
  test('rejects a signal when every entry condition is false', () => {
    expect(getSignalRejectionReasons({ direction: 'BUY', trend: 'bull', momentumScore: 0.2, entryPassedCount: 0, totalScore: 0.8, threshold: 0.6 }))
      .toContain('missing_entry_pattern');
  });

  test('rejects trend and momentum conflicts and weak score', () => {
    const reasons = getSignalRejectionReasons({ direction: 'BUY', trend: 'bear', momentumScore: -0.1, entryPassedCount: 1, totalScore: 0.2, threshold: 0.6 });
    expect(reasons).toEqual(['trend_alignment_failed', 'momentum_confirmation_failed', 'weak_confidence']);
  });

  test('a configured confidence threshold is enforced', () => {
    expect(getSignalRejectionReasons({ direction: 'SELL', trend: 'bear', momentumScore: 0.2, entryPassedCount: 1, totalScore: 0.59, threshold: 0.6 }))
      .toContain('weak_confidence');
  });

  test('volatility normalization does not award a full score without history', () => {
    const result = scoreVolatilityFit(makeCandles(20));
    expect(result.available).toBe(false);
    expect(result.score).toBe(0);
  });

  test('normal volatility contributes no positive confidence bonus', () => {
    expect(scoreVolatilityContribution({ score: 1, available: true })).toBe(0);
    expect(scoreVolatilityContribution({ score: 0.5, available: true })).toBeLessThan(0);
    expect(scoreVolatilityContribution({ score: 0, available: false })).toBe(0);
  });
});

// ─── EMA Tests ───────────────────────────────────────────────────────────────

describe('calcEMA', () => {
  test('returns null when insufficient data', () => {
    expect(calcEMA([1, 2, 3], 5)).toBeNull();
  });

  test('calculates correct SMA for first EMA value', () => {
    const prices = [10, 20, 30, 40, 50]; // SMA(5) = 30
    const ema = calcEMA(prices, 5);
    expect(ema).toBeCloseTo(30, 0);
  });

  test('EMA gives more weight to recent prices', () => {
    const pricesUp   = makePrices(210, 1.0, +0.001);
    const pricesDown = makePrices(210, 1.0, -0.001);
    const emaUp   = calcEMA(pricesUp, 200);
    const emaDown = calcEMA(pricesDown, 200);
    expect(emaUp).toBeGreaterThan(emaDown);
  });

  test('EMA200 on bullish data has price above EMA', () => {
    const prices = makePrices(250, 1.0, +0.005);
    const ema200 = calcEMA(prices, 200);
    const lastPrice = prices[prices.length - 1];
    expect(lastPrice).toBeGreaterThan(ema200);
  });

  test('EMA200 on bearish data has price below EMA', () => {
    const prices = makePrices(250, 1.5, -0.005);
    const ema200 = calcEMA(prices, 200);
    const lastPrice = prices[prices.length - 1];
    expect(lastPrice).toBeLessThan(ema200);
  });
});

// ─── ATR Tests ───────────────────────────────────────────────────────────────

describe('calcATR', () => {
  test('returns null when insufficient data', () => {
    const candles = makeCandles(5);
    expect(calcATR(candles, 14)).toBeNull();
  });

  test('calculates positive ATR', () => {
    const candles = makeCandles(30, 2300);
    const atr = calcATR(candles, 14);
    expect(atr).toBeGreaterThan(0);
  });

  test('high-volatility candles produce larger ATR', () => {
    const lowVol  = Array.from({ length: 20 }, () => ({ time: 0, open: 100, close: 101, high: 102,  low: 99 }));
    const highVol = Array.from({ length: 20 }, () => ({ time: 0, open: 100, close: 105, high: 115,  low: 90 }));
    const atrLow  = calcATR(lowVol, 14);
    const atrHigh = calcATR(highVol, 14);
    expect(atrHigh).toBeGreaterThan(atrLow);
  });
});

// ─── RSI Tests ───────────────────────────────────────────────────────────────

describe('calcRSI', () => {
  test('returns null when insufficient data', () => {
    expect(calcRSI([1, 2, 3], 14)).toBeNull();
  });

  test('RSI is between 0 and 100', () => {
    const prices = makePrices(50, 1.0, 0.001);
    const rsi = calcRSI(prices, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test('strong uptrend produces high RSI', () => {
    const prices = makePrices(50, 1.0, +0.01);  // Strong up
    const rsi = calcRSI(prices, 14);
    expect(rsi).toBeGreaterThan(60);
  });

  test('strong downtrend produces low RSI', () => {
    const prices = makePrices(50, 2.0, -0.01);  // Strong down
    const rsi = calcRSI(prices, 14);
    expect(rsi).toBeLessThan(40);
  });
});

// ─── Swing Breakout Detection ─────────────────────────────────────────────────
// Replaces the old detectBreakout(candles, lookback) → {type}. Current API is
// detectSwingBreakout(candles, direction, lookback) → boolean, and it checks
// the swing high/low over the window EXCLUDING the current (last) bar.

describe('detectSwingBreakout', () => {
  test('detects bullish breakout when price exceeds prior swing high', () => {
    const candles = makeCandles(25, 2300, 0);
    // Force last candle to close above every prior high in the lookback window
    candles[candles.length - 1].close = 2400;
    candles[candles.length - 1].high  = 2401;
    expect(detectSwingBreakout(candles, 'BUY', 20)).toBe(true);
  });

  test('detects bearish breakdown when price drops below prior swing low', () => {
    const candles = makeCandles(25, 2300, 0);
    candles[candles.length - 1].close = 2100;
    candles[candles.length - 1].low   = 2099;
    expect(detectSwingBreakout(candles, 'SELL', 20)).toBe(true);
  });

  test('returns false when price stays inside the prior range', () => {
    const candles = makeCandles(25, 2300, 0);
    // Force every prior candle's range wide, and the last candle's close
    // safely in the middle — well inside the prior swing high/low.
    for (const c of candles.slice(0, -1)) {
      c.high = Math.max(c.high, 2320);
      c.low  = Math.min(c.low, 2280);
    }
    candles[candles.length - 1].close = 2300;
    expect(detectSwingBreakout(candles, 'BUY', 20)).toBe(false);
    expect(detectSwingBreakout(candles, 'SELL', 20)).toBe(false);
  });
});

// ─── Rejection Candle ─────────────────────────────────────────────────────────
// detectRejectionCandle returns 'bullish' / 'bearish' / null (not
// 'bullish_rejection' / 'bearish_rejection' — that suffix doesn't appear in
// the current implementation).

describe('detectRejectionCandle', () => {
  test('detects bullish rejection (hammer)', () => {
    const candle = { open: 100, close: 101, high: 103, low: 90 };  // Long lower wick
    expect(detectRejectionCandle(candle)).toBe('bullish');
  });

  test('detects bearish rejection (shooting star)', () => {
    const candle = { open: 100, close: 99, high: 113, low: 97 };   // Long upper wick
    expect(detectRejectionCandle(candle)).toBe('bearish');
  });

  test('returns null for doji-like candle', () => {
    const candle = { open: 100, close: 100.5, high: 101, low: 99.5 };
    expect(detectRejectionCandle(candle)).toBeNull();
  });

  test('returns null for zero range candle', () => {
    const candle = { open: 100, close: 100, high: 100, low: 100 };
    expect(detectRejectionCandle(candle)).toBeNull();
  });
});

// ─── Integration: Signal Logic ────────────────────────────────────────────────

describe('AutoBot Signal Logic (integration)', () => {
  test('BUY signal conditions: price above EMA200 + bullish confirmation', () => {
    const upPrices   = makePrices(220, 1.0, +0.005);
    const ema200     = calcEMA(upPrices, 200);
    const lastPrice  = upPrices[upPrices.length - 1];
    const rsi        = calcRSI(upPrices, 14);

    // Price should be above EMA200 (bullish trend)
    expect(lastPrice).toBeGreaterThan(ema200);
    // RSI should be in valid range (not overbought)
    expect(rsi).toBeGreaterThan(50);
  });

  test('SELL signal conditions: price below EMA200 + bearish confirmation', () => {
    const downPrices = makePrices(220, 2.0, -0.005);
    const ema200     = calcEMA(downPrices, 200);
    const lastPrice  = downPrices[downPrices.length - 1];
    const rsi        = calcRSI(downPrices, 14);

    // Price should be below EMA200 (bearish trend)
    expect(lastPrice).toBeLessThan(ema200);
    // RSI should be in valid range (not oversold)
    expect(rsi).toBeLessThan(50);
  });
});
