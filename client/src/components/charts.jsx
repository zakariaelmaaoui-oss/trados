import { useMemo, useState } from 'react';
import { money } from '../format.js';

/** Equity curve from real closed trades. */
export function EquityChart({ points, currency = 'USD', height = 220 }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = height, PAD = { l: 8, r: 8, t: 16, b: 22 };
  const data = useMemo(() => [{ equity: 0, t: null }, ...points], [points]);
  if (points.length === 0) return null;
  const ys = data.map((p) => p.equity);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i) => PAD.l + (i / (data.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const line = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join('');
  const area = `${line}L${x(data.length - 1)},${y(min)}L${x(0)},${y(min)}Z`;
  const last = data[data.length - 1].equity;
  const stroke = last >= 0 ? 'var(--accent)' : 'var(--neg)';
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Equity curve">
        <defs>
          <linearGradient id="eqg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity=".22" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={area} fill="url(#eqg)" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover !== null && hover > 0 && (
        <div className="badge" style={{ position: 'absolute', top: 0, left: `${(x(hover) / W) * 100}%`, transform: 'translateX(-50%)', boxShadow: 'var(--shadow)', background: 'var(--surface)' }}>
          Trade {hover}: {money(data[hover].equity, currency, { sign: true })}
        </div>
      )}
    </div>
  );
}

/** Simple bars for daily P&L or discipline scores. */
export function Bars({ items, valueKey = 'value', labelKey = 'label', height = 120, format = (v) => v, colorFor }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i[valueKey] || 0)));
  const hasNeg = items.some((i) => (i[valueKey] || 0) < 0);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, height: height + 34 }}>
      {items.map((it, idx) => {
        const v = it[valueKey];
        const h = v === null || v === undefined ? 0 : (Math.abs(v) / max) * (hasNeg ? height / 2 : height);
        const color = colorFor ? colorFor(v) : v >= 0 ? 'var(--accent)' : 'var(--neg)';
        return (
          <div className="bar-day" key={idx} title={`${it[labelKey]}: ${v === null ? 'n/a' : format(v)}`}>
            <div style={{ height, width: '100%', position: 'relative' }}>
              {v !== null && v !== undefined && (
                <div style={{
                  position: 'absolute', left: '18%', right: '18%', borderRadius: 6, background: color, opacity: 0.9,
                  height: Math.max(2, h),
                  ...(hasNeg ? (v >= 0 ? { bottom: height / 2 } : { top: height / 2 }) : { bottom: 0 }),
                }} />
              )}
              {hasNeg && <div style={{ position: 'absolute', left: 0, right: 0, top: height / 2, borderTop: '1px dashed var(--border)' }} />}
            </div>
            <span className="tiny muted ellipsis" style={{ maxWidth: '100%' }}>{it[labelKey]}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ScoreRing({ score, size = 116 }) {
  const r = 46, c = 2 * Math.PI * r;
  const v = score ?? 0;
  const color = score === null ? 'var(--border)' : v >= 80 ? 'var(--pos)' : v >= 50 ? 'var(--accent)' : 'var(--neg)';
  return (
    <div className="score-ring" style={{ width: size, height: size }} role="img" aria-label={`Discipline score ${score ?? 'not available'}`}>
      <svg viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
        <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ transition: 'stroke-dashoffset .5s' }} />
      </svg>
      <div className="v">{score === null ? '—' : score}</div>
    </div>
  );
}
