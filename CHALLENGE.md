# CloneFX SignalEngine.js Profitability Challenge

## Objective

Improve the existing `SignalEngine.js` to develop a more robust and potentially profitable forex trading strategy.

This challenge is specifically about improving our existing signal-generation logic, not building a new trading application from scratch.

## What We Provide

- Existing `SignalEngine.js`
- Existing `SignalEngine.test.js`

## Developer Challenge

Analyze the existing implementation, identify weaknesses and submit improvements.

You may propose changes to entry conditions, signal filtering, trend confirmation, momentum confirmation and strategy parameters.

Preserve existing integration contracts unless changes are justified and documented.

## Evaluation Criteria

- Net profitability after spread, commission and slippage
- Profit factor and expectancy
- Maximum drawdown
- Out-of-sample performance
- Robustness across currency pairs and market conditions
- Reproducible tests and code quality

## Submission Requirements

Submit:
1. Improved source code.
2. Explanation of the changes.
3. Automated tests.
4. Reproducible backtest results.
5. Risk and limitations analysis.

Do not use Martingale, Grid, loss recovery, look-ahead bias or misleading backtests.

## Important Notice

Profitability must be demonstrated through reproducible testing. No strategy is guaranteed to remain profitable in live markets.
