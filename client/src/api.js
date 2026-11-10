export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function request(method, url, body, { raw = false, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-TradeOS-Request': '1', ...headers } };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, 'Network error — check your connection'); }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('tradeos:unauthorized'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b ?? {}),
  del: (u) => request('DELETE', u),
  upload: (u, file, headers) => request('POST', u, file, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream', ...headers } }),
};

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
