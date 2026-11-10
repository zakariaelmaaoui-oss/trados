import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt5Csv } from '../server/services/mt5.js';

const POSITIONS = [
  'Trade History Report',
  'Name:,Test Trader',
  '',
  'Positions',
  'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit',
  '2026.11.02 10:15:02,5001,EURUSD,buy,0.50,1.08120,1.07900,1.08600,2026.11.02 14:40:10,1.08410,-3.50,0.00,145.00',
  '2026.11.03 09:00:00,5002,GBPUSD,sell,0.20,1.27500,1.27800,1.27000,2026.11.03 11:30:00,1.27800,-1.40,0.00,-60.00',
  '',
  'Orders',
  'Open Time,Order,Symbol,Type,Volume,Price',
].join('\n');

test('parses MT5 Positions table with duplicated Time/Price columns and server-time offset', () => {
  const r = parseMt5Csv(Buffer.from(POSITIONS), { serverOffsetMin: 120 });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2, 'stops at the end of the Positions section');
  const [a, b] = r.rows;
  assert.deepEqual(a.errors, []);
  assert.equal(a.trade.ticket, '5001');
  assert.equal(a.trade.direction, 'buy');
  assert.equal(a.trade.open_time, '2026-11-02T08:15:02.000Z'); // server UTC+2 → UTC
  assert.equal(a.trade.close_time, '2026-11-02T12:40:10.000Z');
  assert.equal(a.trade.open_price, 1.0812);
  assert.equal(a.trade.close_price, 1.0841);
  assert.equal(a.trade.commission, -3.5);
  assert.equal(a.trade.profit, 145);
  assert.equal(b.trade.direction, 'sell');
  assert.equal(b.trade.profit, -60);
});

test('decodes UTF-16LE with BOM and tab delimiter (native MT5 export encoding)', () => {
  const tsv = POSITIONS.replace(/,/g, '\t');
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(tsv, 'utf16le')]);
  const r = parseMt5Csv(buf, { serverOffsetMin: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, 'tab');
  assert.equal(r.summary.valid, 2);
});

test('semicolon file with comma decimals', () => {
  const csv = 'Time;Position;Symbol;Type;Volume;Price;S / L;T / P;Time;Price;Commission;Swap;Profit\n2026.11.04 08:00;77;USDJPY;buy;1,00;150,100;;;2026.11.04 09:00;150,400;-7,00;-0,50;198,40\n';
  const r = parseMt5Csv(Buffer.from(csv), { serverOffsetMin: 0 });
  assert.deepEqual(r.rows[0].errors, []);
  assert.equal(r.rows[0].trade.volume, 1);
  assert.equal(r.rows[0].trade.open_price, 150.1);
  assert.equal(r.rows[0].trade.profit, 198.4);
});

test('flags invalid rows with precise reasons and in-file duplicates', () => {
  const csv = [
    'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit',
    '2026.13.40 10:00:00,1,EURUSD,buy,0.1,1.1,,,2026.11.02 11:00:00,1.2,0,0,10',   // bad date
    '2026.11.02 10:00:00,2,EURUSD,hold,0.1,1.1,,,2026.11.02 11:00:00,1.2,0,0,10',  // bad type
    '2026.11.02 10:00:00,3,EURUSD,buy,abc,1.1,,,2026.11.02 11:00:00,1.2,0,0,10',   // bad volume
    '2026.11.02 12:00:00,4,EURUSD,buy,0.1,1.1,,,2026.11.02 11:00:00,1.2,0,0,10',   // close before open
    '2026.11.02 10:00:00,5,EURUSD,buy limit,0.1,1.1,,,2026.11.02 11:00:00,1.2,0,0,10', // pending order
    '2026.11.02 10:00:00,6,EURUSD,sell,0.1,1.1,,,2026.11.02 11:00:00,1.0,0,0,10',
    '2026.11.02 10:00:00,6,EURUSD,sell,0.1,1.1,,,2026.11.02 11:00:00,1.0,0,0,10',  // duplicate ticket
  ].join('\n');
  const r = parseMt5Csv(Buffer.from(csv), { serverOffsetMin: 0 });
  const errs = r.rows.map((x) => x.errors.join('|'));
  assert.match(errs[0], /Open time/);
  assert.match(errs[1], /not buy\/sell/);
  assert.match(errs[2], /volume .*not a number/);
  assert.match(errs[3], /before open/);
  assert.match(errs[4], /pending order/);
  assert.equal(errs[5], '');
  assert.match(errs[6], /Duplicate of line/);
  assert.equal(r.summary.valid, 1);
  assert.equal(r.summary.invalid, 6);
});

test('rejects files that are not a positions table, with guidance for Deals exports', () => {
  const deals = 'Time,Deal,Symbol,Type,Direction,Volume,Price,Order,Commission,Fee,Swap,Profit,Balance,Comment\n';
  const r = parseMt5Csv(Buffer.from(deals));
  assert.equal(r.ok, false);
  assert.match(r.error, /Deals/);
  assert.equal(parseMt5Csv(Buffer.from('hello,world\n1,2\n')).ok, false);
});
