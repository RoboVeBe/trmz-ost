// TRMZ OST — ost.trmz.app
// Viewers:  GET /            boombox + tape racks (read-only)
//           GET /api/site    tape list + boombox layout + photo version
//           GET /audio/:id   song (supports Range; ?dl=1 = download if allowed)
//           GET /photo       boombox photo
// Admin:    GET /admin       same page in admin mode (protect /admin* with Cloudflare Access)
//           /api/admin/*     me, site (PUT), audio/:id (PUT/DELETE), photo (PUT)
// Storage:  R2 bucket bound as BUCKET:  site.json, photo, audio/<id>

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const ID_RE = /^[a-z0-9]{6,40}$/i;
const EMPTY_SITE = { v: 1, photo: 0, layout: null, tapes: [] };

async function getSite(env) {
  const obj = await env.BUCKET.get('site.json');
  if (!obj) return EMPTY_SITE;
  try { return await obj.json(); } catch { return EMPTY_SITE; }
}

// ---------- admin auth ----------
let certCache = null, certTime = 0;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function verifyAccess(jwt, env) {
  try {
    const [h, p, sig] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64u(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
    const team = env.ACCESS_TEAM.replace(/^https?:\/\//, '').replace(/\.cloudflareaccess\.com.*$/, '');
    const iss = `https://${team}.cloudflareaccess.com`;
    if (payload.iss !== iss) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!certCache || Date.now() - certTime > 3600e3) {
      certCache = await (await fetch(`${iss}/cdn-cgi/access/certs`)).json(); certTime = Date.now();
    }
    const jwk = (certCache.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
    return ok ? payload : null;
  } catch { return null; }
}
async function safeEqual(a, b) {
  const enc = new TextEncoder(), [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const ua = new Uint8Array(x), ub = new Uint8Array(y); let d = 0; for (let i = 0; i < ua.length; i++) d |= ua[i] ^ ub[i]; return d === 0;
}
// returns { who } | { error, status }
async function auth(req, env) {
  const hasAccess = env.ACCESS_TEAM && env.ACCESS_AUD;
  if (hasAccess) {
    const jwt = req.headers.get('cf-access-jwt-assertion') || (req.headers.get('cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
    if (jwt) {
      const p = await verifyAccess(jwt, env);
      if (p) {
        const allowed = (env.ADMIN_EMAIL || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
        if (!allowed.length || allowed.includes(String(p.email || '').toLowerCase())) return { who: p.email };
        return { error: 'not an admin', status: 403 };
      }
    }
  }
  if (env.ADMIN_PASSWORD) {
    const h = req.headers.get('authorization') || '';
    if (h.startsWith('Bearer ') && await safeEqual(h.slice(7), env.ADMIN_PASSWORD)) return { who: 'password' };
    return { error: 'sign in required', status: 401 };
  }
  if (hasAccess) return { error: 'sign in required', status: 401 };
  return { error: 'admin login is not set up yet (add ACCESS_TEAM + ACCESS_AUD or ADMIN_PASSWORD)', status: 503 };
}

// ---------- handlers ----------
async function serveAudio(req, env, id, url) {
  if (!ID_RE.test(id)) return new Response('Not found', { status: 404 });
  let dlName = null;
  if (url.searchParams.has('dl')) {
    const site = await getSite(env), t = site.tapes.find(x => x.id === id);
    if (!t || t.download === false) return new Response('Download not available for this tape', { status: 403 });
    const ext = (t.file || '').match(/\.[a-z0-9]{2,5}$/i)?.[0] || '.mp3';
    dlName = `${t.artist ? t.artist + ' - ' : ''}${t.title || 'TRMZ OST'}`.replace(/[\\/:*?"<>|]+/g, '').trim() + ext;
  }
  const obj = await env.BUCKET.get('audio/' + id, { range: req.headers, onlyIf: req.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag); h.set('accept-ranges', 'bytes'); h.set('cache-control', 'public, max-age=31536000, immutable');
  if (dlName) h.set('content-disposition', `attachment; filename="${dlName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(dlName)}`);
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h });
  let status = 200;
  if (obj.range && req.headers.has('range')) {
    const size = obj.size, r = obj.range;
    const start = 'suffix' in r ? size - r.suffix : r.offset;
    const end = 'suffix' in r ? size - 1 : (r.length !== undefined ? r.offset + r.length - 1 : size - 1);
    h.set('content-range', `bytes ${start}-${end}/${size}`); h.set('content-length', String(end - start + 1)); status = 206;
  }
  return new Response(obj.body, { status, headers: h });
}

async function admin(req, env, path) {
  const a = await auth(req, env);
  if (a.error) return json({ error: a.error }, a.status);
  const m = req.method;
  if (path === 'me' && m === 'GET') return json({ ok: true, who: a.who });
  if (path === 'site' && m === 'PUT') {
    const text = await req.text();
    if (text.length > 2_000_000) return json({ error: 'too big' }, 413);
    let site; try { site = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
    if (!site || !Array.isArray(site.tapes)) return json({ error: 'tapes missing' }, 400);
    site.tapes = site.tapes.filter(t => t && ID_RE.test(t.id)).map(t => ({
      id: t.id, title: String(t.title || '').slice(0, 200), artist: String(t.artist || '').slice(0, 120), msg: String(t.msg || '').slice(0, 300),
      label: ['cream', 'white', 'orange', 'black'].includes(t.label) ? t.label : 'cream', dur: Number(t.dur) || 0, download: t.download !== false, file: String(t.file || '').slice(0, 200)
    }));
    site.updated = new Date().toISOString();
    await env.BUCKET.put('site.json', JSON.stringify(site), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, tapes: site.tapes.length });
  }
  const am = path.match(/^audio\/([^/]+)$/);
  if (am) {
    const id = am[1]; if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
    if (m === 'PUT') {
      const type = req.headers.get('content-type') || 'application/octet-stream';
      if (!/^(audio\/|application\/octet-stream|video\/webm)/.test(type)) return json({ error: 'audio files only' }, 415);
      await env.BUCKET.put('audio/' + id, req.body, { httpMetadata: { contentType: type } });
      return json({ ok: true });
    }
    if (m === 'DELETE') { await env.BUCKET.delete('audio/' + id); return json({ ok: true }); }
  }
  if (path === 'photo' && m === 'PUT') {
    const type = req.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return json({ error: 'images only' }, 415);
    await env.BUCKET.put('photo', req.body, { httpMetadata: { contentType: type } });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    try {
      if (path === '/api/site' && req.method === 'GET') return json(await getSite(env));
      if (path.startsWith('/audio/') && (req.method === 'GET' || req.method === 'HEAD')) return serveAudio(req, env, path.slice(7), url);
      if (path === '/photo' && req.method === 'GET') {
        const obj = await env.BUCKET.get('photo');
        if (!obj) return new Response('Not found', { status: 404 });
        const h = new Headers(); obj.writeHttpMetadata(h); h.set('etag', obj.httpEtag); h.set('cache-control', 'public, max-age=300');
        return new Response(obj.body, { headers: h });
      }
      if (path.startsWith('/api/admin/')) return admin(req, env, path.slice(11));
      if (path === '/admin' || path === '/admin/') {
        const r = await env.ASSETS.fetch(new Request(new URL('/', url), req));
        const h = new Headers(r.headers); h.set('cache-control', 'no-store'); h.set('x-robots-tag', 'noindex');
        return new Response(r.body, { status: r.status, headers: h });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message || e) }, 500);
    }
  }
};
