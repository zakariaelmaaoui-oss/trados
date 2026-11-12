import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateProfit, normaliseSymbol } from '../client/src/profit.js';

test('profit estimate matches MT5 for USD-quoted, USD-based pairs and metals', () => {
  // EURUSD buy 0.5 lot, +40 pips → $200
  assert.equal(estimateProfit({ symbol: 'EURUSD', direction: 'buy', volume: 0.5, openPrice: 1.081, closePrice: 1.085 }).profit, 200);
  // GBPUSD sell 0.3, 1.2750 → 1.2720 → +$90
  assert.equal(estimateProfit({ symbol: 'GBPUSD.r', direction: 'sell', volume: 0.3, openPrice: 1.275, closePrice: 1.272 }).profit, 90);
  // USDJPY sell 0.2, 154.20 → 153.90 → 6000 JPY / 153.90 = $38.99
  assert.equal(estimateProfit({ symbol: 'USDJPYm', direction: 'sell', volume: 0.2, openPrice: 154.2, closePrice: 153.9 }).profit, 38.99);
  // XAUUSD buy 0.1, 2650.10 → 2646.00 → −$41
  assert.equal(estimateProfit({ symbol: 'XAUUSD', direction: 'buy', volume: 0.1, openPrice: 2650.1, closePrice: 2646 }).profit, -41);
  assert.equal(estimateProfit({ symbol: 'GOLD', direction: 'sell', volume: 1, openPrice: 2000, closePrice: 1990 }).profit, 1000);
});

test('no guess where the result needs data we do not have', () => {
  assert.equal(estimateProfit({ symbol: 'EURGBP', direction: 'buy', volume: 1, openPrice: 0.85, closePrice: 0.86 }), null, 'cross pair needs GBPUSD');
  assert.equal(estimateProfit({ symbol: 'US30', direction: 'buy', volume: 1, openPrice: 42000, closePrice: 42100 }), null, 'index contract size varies by broker');
  assert.equal(estimateProfit({ symbol: 'EURUSD', direction: 'buy', volume: 1, openPrice: 1.08, closePrice: 1.09, accountCurrency: 'EUR' }), null);
  assert.equal(estimateProfit({ symbol: 'EURUSD', direction: 'buy', volume: 0, openPrice: 1.08, closePrice: 1.09 }), null);
  assert.equal(normaliseSymbol('eurusd-pro'), 'EURUSD');
});
