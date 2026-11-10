// MT5 history CSV import: decoding, parsing, column mapping and row validation.
//
// Supported layouts:
//  * MT5 "Positions" history (Terminal > History > Report, or copied/exported table):
//    Time | Position | Symbol | Type | Volume | Price | S / L | T / P | Time | Price | Commission | Swap | Profit
//    (the first Time/Price pair is the open, the second is the close)
//  * Column-named exports: Ticket, Symbol, Type, Volume/Lots, Open Time, Open Price,
//    Close Time, Close Price, S/L, T/P, Commission, Swap, Profit (any order, case-insensitive).
// MT5 writes times in broker *server* time; the account's server UTC offset converts them to UTC.

export function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2)); sw.swap16(); return sw.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // UTF-16LE without BOM: many NUL bytes at odd offsets
  let zeros = 0; const n = Math.min(buf.length, 400);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
  if (n > 20 && zeros > n / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function detectDelimiter(line) {
  const counts = { '\t': 0, ';': 0, ',': 0 };
  let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

export function splitRows(text, delim) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  ticket: ['ticket', 'position', 'positionid', 'order', 'id', 'deal'],
  symbol: ['symbol', 'instrument', 'item'],
  type: ['type', 'side', 'direction', 'action'],
  volume: ['volume', 'lots', 'size', 'lot'],
  open_time: ['opentime', 'timeopen', 'opendate', 'entrytime'],
  open_price: ['openprice', 'priceopen', 'entryprice', 'entry'],
  close_time: ['closetime', 'timeclose', 'closedate', 'exittime'],
  close_price: ['closeprice', 'priceclose', 'exitprice', 'exit'],
  stop_loss: ['sl', 'stoploss', 's/l'],
  take_profit: ['tp', 'takeprofit', 't/p'],
  commission: ['commission', 'comm', 'fee', 'fees'],
  swap: ['swap', 'swaps', 'rollover'],
  profit: ['profit', 'pl', 'pnl', 'netprofit', 'grossprofit'],
};

/** Map header cells to fields. Handles MT5's duplicated Time/Price columns. */
export function mapHeader(cells) {
  const keys = cells.map(norm);
  const map = {};
  const timeIdx = keys.map((k, i) => (k === 'time' ? i : -1)).filter(i => i >= 0);
  const priceIdx = keys.map((k, i) => (k === 'price' ? i : -1)).filter(i => i >= 0);
  if (timeIdx.length >= 2) { map.open_time = timeIdx[0]; map.close_time = timeIdx[1]; }
  if (priceIdx.length >= 2) { map.open_price = priceIdx[0]; map.close_price = priceIdx[1]; }
  keys.forEach((k, i) => {
    for (const [field, al] of Object.entries(ALIASES)) {
      if (map[field] !== undefined) continue;
      if (al.map(norm).includes(k)) { map[field] = i; break; }
    }
  });
  return map;
}

function isHeader(cells) {
  const m = mapHeader(cells);
  return m.symbol !== undefined && m.type !== undefined && m.volume !== undefined && m.profit !== undefined
    && m.open_time !== undefined && m.open_price !== undefined;
}

export function parseNumber(s, delim) {
  if (s === undefined || s === null) return null;
  let t = String(s).replace(/[\s ]/g, '');
  if (t === '' || t === '-') return null;
  if (delim !== ',' && /^-?\d+,\d+$/.test(t)) t = t.replace(',', '.'); // comma decimals in ;/tab files
  else t = t.replace(/,(?=\d{3}(\D|$))/g, '');                           // thousands separators
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse MT5 server time ("2024.01.15 10:30:45", "2024-01-15 10:30", ISO) to UTC ISO. */
export function parseServerTime(s, offsetMin) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (se || 0) > 59) return undefined;
  const t = Date.UTC(y, mo - 1, d, h, mi, se || 0) - offsetMin * 60000;
  const dt = new Date(t);
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return undefined;
  return dt.toISOString();
}

/**
 * Parse + validate. Returns { format, rows: [{line, trade, errors[]}], summary }.
 * Nothing is written to the database here.
 */
export function parseMt5Csv(buf, { serverOffsetMin = 0 } = {}) {
  const text = decodeBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const lines = text.split(/\r?\n/);
  let headerLine = -1, delim = ',';
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    if (!lines[i].trim()) continue;
    const d = detectDelimiter(lines[i]);
    const cells = splitRows(lines[i], d)[0] || [];
    if (isHeader(cells)) { headerLine = i; delim = d; break; }
  }
  if (headerLine < 0) {
    const looksDeals = /\bdeal\b/i.test(text) && /\bdirection\b/i.test(text);
    return {
      ok: false,
      error: looksDeals
        ? 'This looks like an MT5 "Deals" export. Deals cannot be paired into trades reliably — export the "Positions" history instead.'
        : 'Could not find an MT5 positions header (needs Symbol, Type, Volume, Time/Open Time, Price/Open Price and Profit columns).',
      rows: [], summary: { total: 0, valid: 0, invalid: 0 },
    };
  }
  const body = splitRows(lines.slice(headerLine).join('\n'), delim);
  const header = body.shift();
  const map = mapHeader(header);
  const rows = [];
  for (let r = 0; r < body.length; r++) {
    const cells = body[r];
    const lineNo = headerLine + r + 2;
    if (cells.every(c => c === '')) {
      if (rows.length) break; // blank line ends the Positions section
      continue;
    }
    // A new section title (e.g. "Orders", "Deals") or a totals row ends the table.
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length <= 2 && rows.length && !(map.symbol !== undefined && cells[map.symbol])) break;
    const get = f => (map[f] !== undefined ? cells[map[f]] : undefined);
    const errors = [];
    const typeRaw = (get('type') || '').toLowerCase();
    const direction = typeRaw.startsWith('buy') ? 'buy' : typeRaw.startsWith('sell') ? 'sell' : null;
    if (!direction) errors.push(`Type "${get('type') || ''}" is not buy/sell`);
    if (/limit|stop/.test(typeRaw) && direction) errors.push(`Type "${get('type')}" is a pending order, not a position`);
    const symbol = (get('symbol') || '').toUpperCase();
    if (!/^[A-Z0-9._#\-+]{2,20}$/.test(symbol)) errors.push('Missing or invalid symbol');
    const num = (f, { required = false, positive = false } = {}) => {
      const v = parseNumber(get(f), delim);
      if (v === null) { if (required) errors.push(`${f.replace('_', ' ')} is required`); return null; }
      if (Number.isNaN(v)) { errors.push(`${f.replace('_', ' ')} "${get(f)}" is not a number`); return null; }
      if (positive && v <= 0) errors.push(`${f.replace('_', ' ')} must be > 0`);
      return v;
    };
    const volume = num('volume', { required: true, positive: true });
    const open_price = num('open_price', { required: true, positive: true });
    const close_price = num('close_price', { positive: true });
    const stop_loss = num('stop_loss');
    const take_profit = num('take_profit');
    const commission = num('commission') ?? 0;
    const swap = num('swap') ?? 0;
    const profit = num('profit', { required: true });
    const open_time = parseServerTime(get('open_time'), serverOffsetMin);
    if (!open_time) errors.push(`Open time "${get('open_time') || ''}" is not a valid date (expected YYYY.MM.DD HH:MM[:SS])`);
    let close_time = null;
    if (get('close_time')) {
      close_time = parseServerTime(get('close_time'), serverOffsetMin);
      if (!close_time) { errors.push(`Close time "${get('close_time')}" is not a valid date`); close_time = null; }
    }
    if (open_time && close_time && close_time < open_time) errors.push('Close time is before open time');
    if (close_time && close_price === null) errors.push('Close price is required for a closed position');
    if (open_time && Date.parse(open_time) > Date.now() + 86400000) errors.push('Open time is in the future');
    const ticket = (get('ticket') || '').replace(/\s/g, '') || null;
    if (ticket && !/^[\w\-]{1,40}$/.test(ticket)) errors.push('Invalid ticket/position id');
    rows.push({
      line: lineNo, errors,
      trade: { ticket, symbol, direction, volume, open_time, close_time, open_price, close_price,
        stop_loss: stop_loss || null, take_profit: take_profit || null, commission, swap, profit },
    });
  }
  // Duplicate tickets inside the same file
  const seen = new Map();
  for (const r of rows) {
    if (!r.trade.ticket) { r.errors.push('Missing ticket/position id (needed to prevent duplicate imports)'); continue; }
    if (seen.has(r.trade.ticket)) r.errors.push(`Duplicate of line ${seen.get(r.trade.ticket)} in this file`);
    else seen.set(r.trade.ticket, r.line);
  }
  const invalid = rows.filter(r => r.errors.length).length;
  return { ok: true, format: 'mt5_positions', delimiter: delim === '\t' ? 'tab' : delim, rows, summary: { total: rows.length, valid: rows.length - invalid, invalid } };
}
