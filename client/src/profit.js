// Profit estimate for quick trade entry. Only instruments whose result can be
// computed exactly from the trade's own prices are supported; everything else
// returns null and the user types the profit from MT5.
//
// Assumes standard contract sizes: FX 100 000 units/lot, XAUUSD 100 oz,
// XAGUSD 5 000 oz. Broker suffixes like ".r", "m", "-pro" are ignored.

const FX = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];

export function normaliseSymbol(sym) {
  const s = String(sym || '').toUpperCase().replace(/[^A-Z]/g, '');
  const six = s.slice(0, 6);
  if (FX.includes(six.slice(0, 3)) && FX.includes(six.slice(3, 6))) return six;
  if (s.startsWith('XAUUSD') || s === 'GOLD') return 'XAUUSD';
  if (s.startsWith('XAGUSD') || s === 'SILVER') return 'XAGUSD';
  return s;
}

/**
 * @returns {{ profit: number, note: string } | null}
 * profit is in account currency (USD only), before commission and swap.
 */
export function estimateProfit({ symbol, direction, volume, openPrice, closePrice, accountCurrency = 'USD' }) {
  const v = Number(volume), o = Number(openPrice), c = Number(closePrice);
  if (!(v > 0 && o > 0 && c > 0) || !['buy', 'sell'].includes(direction)) return null;
  if (accountCurrency !== 'USD') return null;
  const sym = normaliseSymbol(symbol);
  const diff = direction === 'buy' ? c - o : o - c;
  let profit = null, note = '';
  if (sym === 'XAUUSD') { profit = diff * v * 100; note = 'Gold, 100 oz per lot'; }
  else if (sym === 'XAGUSD') { profit = diff * v * 5000; note = 'Silver, 5 000 oz per lot'; }
  else if (sym.length === 6 && FX.includes(sym.slice(0, 3)) && FX.includes(sym.slice(3))) {
    const base = sym.slice(0, 3), quote = sym.slice(3);
    if (quote === 'USD') { profit = diff * v * 100000; note = '100 000 units per lot'; }
    else if (base === 'USD') { profit = (diff * v * 100000) / c; note = `converted from ${quote} at the exit price`; }
  }
  if (profit === null || !Number.isFinite(profit)) return null;
  return { profit: Math.round(profit * 100) / 100, note };
}
