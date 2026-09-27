// TryOn API on Cloudflare Workers. Static files in public/ are served by the
// Workers assets binding; only /api/* and /auth/* reach this script
// (see run_worker_first in wrangler.jsonc). Trials live in D1 (binding DB).

const YEAR = 365 * 24 * 3600;
const MONTH = 30 * 24 * 3600;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Config (from wrangler vars + secrets) ───────────────────────────
function config(env) {
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return {
    trialSeconds: Number(env.TRIAL_SECONDS || 60),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    googleEnabled,
    // The name+email fallback is on when asked for, or whenever Google isn't
    // configured yet (so the gate is still testable end to end).
    devLoginEnabled: env.ALLOW_DEV_LOGIN === '1' || !googleEnabled,
    // Decart platform key. Secret, server-side only. Absent ⇒ stub mode.
    decartApiKey: env.DECART_API_KEY || '',
    decartApiBase: (env.DECART_API_BASE || 'https://api.decart.ai/v1').replace(/\/+$/, ''),
    decartModel: env.DECART_MODEL || 'lucy-vton-3.5',
    sessionSecret: env.SESSION_SECRET || '',
  };
}

// ── Storage (D1) ────────────────────────────────────────────────────
async function findTrial(db, identityKey, deviceToken) {
  if (identityKey) {
    const row = await db.prepare('SELECT id FROM trials WHERE identity_key = ?').bind(identityKey).first();
    if (row) return row;
  }
  if (deviceToken) {
    const row = await db.prepare('SELECT id FROM trials WHERE device_token = ?').bind(deviceToken).first();
    if (row) return row;
  }
  return null;
}

/** A prior trial for this account OR this device means the free try is spent. */
async function trialState(db, identityKey, deviceToken) {
  const existing = await findTrial(db, identityKey, deviceToken);
  return { eligible: !existing, reason: existing ? 'trial_used' : null };
}

/** The trial row iff it belongs to this identity, is still active, and unexpired. */
async function activeTrial(db, sessionId, identityKey) {
  if (!sessionId || !identityKey) return null;
  const row = await db
    .prepare('SELECT id, status, expires_at FROM trials WHERE id = ? AND identity_key = ?')
    .bind(sessionId, identityKey)
    .first();
  if (!row || row.status !== 'active') return null;
  if (Number(row.expires_at) * 1000 < Date.now()) return null;
  return row;
}

function completeTrial(db, id, identityKey) {
  return db
    .prepare(`UPDATE trials SET status = 'completed', ended_at = ? WHERE id = ? AND identity_key = ?`)
    .bind(nowSeconds(), id, identityKey)
    .run();
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── Cookies + signing (Web Crypto HMAC-SHA256) ──────────────────────
const encoder = new TextEncoder();
let cachedKey = null;
let cachedKeySecret = null;

async function hmacKey(secret) {
  if (cachedKey && cachedKeySecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  cachedKeySecret = secret;
  return cachedKey;
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sign(secret, value) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value));
  return `${value}.${toBase64Url(sig)}`;
}
async function unsign(secret, signed) {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  let sig;
  try { sig = fromBase64Url(signed.slice(dot + 1)); } catch { return null; }
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, encoder.encode(value));
  return ok ? value : null;
}

function parseCookies(request) {
  const header = request.headers.get('cookie');
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try { out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

function cookie(name, value, { maxAge, secure, path = '/', sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}; HttpOnly`;
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// ── Response helpers ────────────────────────────────────────────────
function json(status, data, setCookies) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(data), { status, headers });
}
function redirect(location, setCookies) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ── Worker ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handle(request, env, url);
    } catch (error) {
      console.error('[TryOn] request failed:', error);
      return new Response('Internal error', { status: 500 });
    }
  },
};

async function handle(request, env, url) {
  const cfg = config(env);
  // Without a fixed secret every isolate would sign with a different key and
  // sessions would break at random, so refuse instead of guessing.
  if (!cfg.sessionSecret) {
    console.error('[TryOn] SESSION_SECRET is not set. Run: wrangler secret put SESSION_SECRET');
    return new Response('Server not configured', { status: 500 });
  }

  const { pathname } = url;
  const method = request.method;
  const secure = url.protocol === 'https:';
  const cookies = parseCookies(request);
  const setCookies = [];

  // Long-lived device token; issued on first contact.
  let device = await unsign(cfg.sessionSecret, cookies.ow_device);
  if (!device) {
    device = crypto.randomUUID();
    setCookies.push(cookie('ow_device', await sign(cfg.sessionSecret, device), { maxAge: YEAR, secure }));
  }

  const readSession = async () => {
    const raw = await unsign(cfg.sessionSecret, cookies.ow_session);
    if (!raw) return null;
    try { return JSON.parse(new TextDecoder().decode(fromBase64Url(raw))); } catch { return null; }
  };
  const sessionCookie = async (identity) => {
    const raw = toBase64Url(encoder.encode(JSON.stringify(identity)));
    return cookie('ow_session', await sign(cfg.sessionSecret, raw), { maxAge: MONTH, secure });
  };

  // ── Trial API ──
  if (pathname === '/api/session' && method === 'GET') {
    const session = await readSession();
    const { eligible, reason } = session
      ? await trialState(env.DB, session.k, device)
      : { eligible: false, reason: 'sign_in_required' };
    return json(200, {
      signedIn: Boolean(session),
      name: session?.name ?? null,
      email: session?.email ?? null,
      provider: session?.provider ?? null,
      eligible: Boolean(session) && eligible,
      reason: session ? reason : 'sign_in_required',
      trialSeconds: cfg.trialSeconds,
      googleEnabled: cfg.googleEnabled,
      devLoginEnabled: cfg.devLoginEnabled,
      liveTryOn: Boolean(cfg.decartApiKey),
    }, setCookies);
  }

  if (pathname === '/api/trial/start' && method === 'POST') {
    const session = await readSession();
    if (!session) return json(401, { error: 'sign_in_required' }, setCookies);
    if (!(await trialState(env.DB, session.k, device)).eligible) {
      return json(403, { error: 'trial_used' }, setCookies);
    }
    const id = crypto.randomUUID();
    const now = nowSeconds();
    const expiresAt = now + cfg.trialSeconds;
    try {
      await env.DB
        .prepare(`INSERT INTO trials (id, identity_key, email, device_token, status, started_at, expires_at)
                  VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .bind(id, session.k, session.email ?? null, device, now, expiresAt)
        .run();
    } catch {
      // Unique index on identity, or a race — the trial is already spent.
      return json(403, { error: 'trial_used' }, setCookies);
    }
    return json(200, {
      sessionId: id,
      expiresIn: cfg.trialSeconds,
      expiresAt,
      mode: cfg.decartApiKey ? 'live' : 'stub',
    }, setCookies);
  }

  if (pathname === '/api/trial/end' && method === 'POST') {
    const session = await readSession();
    if (!session) return json(401, { error: 'sign_in_required' }, setCookies);
    const body = await readJson(request);
    if (body.sessionId) await completeTrial(env.DB, String(body.sessionId), session.k);
    return json(200, { ok: true }, setCookies);
  }

  // ── Realtime try-on: mint an ephemeral client token for the browser ──
  // The permanent key stays here; the browser gets a short-lived token that
  // the Decart SDK uses to open the WebRTC session directly.
  if (pathname === '/api/tryon/token' && method === 'POST') {
    const session = await readSession();
    if (!session) return json(401, { error: 'sign_in_required' }, setCookies);
    const sessionId = url.searchParams.get('sessionId');
    if (!(await activeTrial(env.DB, sessionId, session.k))) return json(403, { error: 'trial_inactive' }, setCookies);
    if (!cfg.decartApiKey) return json(200, { mode: 'stub' }, setCookies);
    // One live session per trial: spend it now so a second token can't be minted.
    await completeTrial(env.DB, sessionId, session.k);
    try {
      const r = await fetch(`${cfg.decartApiBase}/client/tokens`, {
        method: 'POST',
        headers: { 'x-api-key': cfg.decartApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiresIn: 300, // token TTL; the live session length is capped below
          allowedModels: [cfg.decartModel, 'lucy-vton-latest'],
          allowedOrigins: [url.origin],
          constraints: { realtime: { maxSessionDuration: cfg.trialSeconds + 30 } },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.apiKey) return json(502, { error: 'token_failed' }, setCookies);
      return json(200, {
        mode: 'live',
        token: data.apiKey,
        expiresAt: data.expiresAt ?? null,
        model: cfg.decartModel,
        trialSeconds: cfg.trialSeconds,
      }, setCookies);
    } catch {
      return json(502, { error: 'decart_unreachable' }, setCookies);
    }
  }

  // ── Auth: Google ──
  if (pathname === '/auth/google' && method === 'GET') {
    if (!cfg.googleEnabled) return redirect('/?auth=disabled', setCookies);
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: `${url.origin}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, setCookies);
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    if (!cfg.googleEnabled || !code) return redirect('/?auth=error', setCookies);
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.googleClientId,
          client_secret: cfg.googleClientSecret,
          redirect_uri: `${url.origin}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return redirect('/?auth=error', setCookies);
      const { access_token } = await tokenRes.json();
      const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then((r) => r.json());
      if (!info?.id) return redirect('/?auth=error', setCookies);
      const identity = { k: `google:${info.id}`, name: info.name ?? null, email: info.email ?? null, provider: 'google' };
      setCookies.push(await sessionCookie(identity));
      return redirect('/?auth=success', setCookies);
    } catch {
      return redirect('/?auth=error', setCookies);
    }
  }

  // ── Auth: dev fallback (name + email; unverified) ──
  if (pathname === '/auth/dev' && method === 'POST') {
    if (!cfg.devLoginEnabled) return json(404, { error: 'not_found' }, setCookies);
    const body = await readJson(request);
    const name = String(body.name ?? '').trim().slice(0, 120);
    const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
    if (!name) return json(400, { error: 'name_required' }, setCookies);
    if (!EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' }, setCookies);
    const identity = { k: `email:${email}`, name, email, provider: 'dev' };
    setCookies.push(await sessionCookie(identity));
    return json(200, { ok: true, signedIn: true, name, email }, setCookies);
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    setCookies.push(cookie('ow_session', '', { maxAge: 0, secure }));
    return json(200, { ok: true }, setCookies);
  }

  return json(404, { error: 'not_found' }, setCookies);
}
