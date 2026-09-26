import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Load .env if present (Node 20.12+ built-in). No dependency, no crash if missing.
try { process.loadEnvFile(); } catch { /* no .env file — fine */ }

// ── Config ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const TRIAL_SECONDS = Number(process.env.OPENWEAR_TRIAL_SECONDS || 60);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
// The name+email dev fallback is on when asked for, or whenever Google isn't
// configured yet (so the gate is still testable end to end).
const DEV_LOGIN_ENABLED = process.env.OPENWEAR_ALLOW_DEV_LOGIN === '1' || !GOOGLE_ENABLED;
// Decart platform key. Server-side only. Absent ⇒ try-on runs in stub mode.
const DECART_API_KEY = process.env.DECART_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[openwear] SESSION_SECRET not set — using an ephemeral secret; sessions reset on restart.');
}

// The app dir holds server-only files (.env, openwear.db); only public/ is served.
const root = import.meta.dirname;
const publicDir = join(root, 'public');

// ── Storage (built-in SQLite, no packages) ──────────────────────────
const db = new DatabaseSync(join(root, 'openwear.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trials (
    id           TEXT PRIMARY KEY,
    identity_key TEXT,               -- 'google:<sub>' or 'email:<addr>'
    email        TEXT,
    device_token TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    started_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    ended_at     INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_trials_identity ON trials(identity_key);
  CREATE INDEX IF NOT EXISTS idx_trials_device ON trials(device_token);
`);
// Prepare per call: node:sqlite finalizes StatementSync objects on GC, so
// long-lived module-level statements can go stale. Preparing is cheap here.
function findTrial(identityKey, deviceToken) {
  return (
    (identityKey && db.prepare('SELECT id FROM trials WHERE identity_key = ?').get(identityKey)) ||
    (deviceToken && db.prepare('SELECT id FROM trials WHERE device_token = ?').get(deviceToken)) ||
    null
  );
}
function insertTrial(id, identityKey, email, deviceToken, startedAt, expiresAt) {
  db.prepare(
    `INSERT INTO trials (id, identity_key, email, device_token, status, started_at, expires_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, identityKey, email, deviceToken, startedAt, expiresAt);
}
function completeTrial(endedAt, id, identityKey) {
  db.prepare(
    `UPDATE trials SET status = 'completed', ended_at = ? WHERE id = ? AND identity_key = ?`,
  ).run(endedAt, id, identityKey);
}

/** A prior trial for this account OR this device means the free try is spent. */
function trialState(identityKey, deviceToken) {
  const existing = findTrial(identityKey, deviceToken);
  return { eligible: !existing, reason: existing ? 'trial_used' : null };
}

// ── Cookies + signing (node:crypto) ─────────────────────────────────
function sign(value) {
  const sig = createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${sig}`;
}
function unsign(signed) {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
function cookie(name, value, { maxAge, path = '/', httpOnly = true, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

const YEAR = 365 * 24 * 3600;
const MONTH = 30 * 24 * 3600;

/** Read (or issue) the long-lived device token. Pushes a Set-Cookie when new. */
function ensureDevice(req, setCookies) {
  const token = unsign(parseCookies(req).ow_device);
  if (token) return token;
  const fresh = randomUUID();
  setCookies.push(cookie('ow_device', sign(fresh), { maxAge: YEAR }));
  return fresh;
}
function readSession(req) {
  const raw = unsign(parseCookies(req).ow_session);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
function sessionCookie(identity) {
  const raw = Buffer.from(JSON.stringify(identity)).toString('base64url');
  return cookie('ow_session', sign(raw), { maxAge: MONTH });
}

// ── Small HTTP helpers ──────────────────────────────────────────────
async function readJson(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
function sendJson(res, status, data, setCookies = []) {
  const body = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(status, headers);
  res.end(body);
}
function redirect(res, location, setCookies = []) {
  const headers = { Location: location };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(302, headers);
  res.end();
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Server ──────────────────────────────────────────────────────────
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.gif': 'image/gif', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    console.error('[openwear] request failed:', error);
    if (!res.headersSent) res.writeHead(error instanceof URIError ? 400 : 500);
    res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`Openwear running at http://${HOST}:${PORT}`);
  console.log(`  identity: ${GOOGLE_ENABLED ? 'Google sign-in' : 'dev fallback (name+email)'}` +
    `${DEV_LOGIN_ENABLED && GOOGLE_ENABLED ? ' + dev fallback' : ''} · try-on: ${DECART_API_KEY ? 'live' : 'stub'}`);
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const { pathname } = url;
  const method = req.method || 'GET';
  const setCookies = [];
  const device = ensureDevice(req, setCookies);

  // ── Trial API ──
  if (pathname === '/api/session' && method === 'GET') {
    const session = readSession(req);
    const { eligible, reason } = session ? trialState(session.k, device) : { eligible: false, reason: 'sign_in_required' };
    return sendJson(res, 200, {
      signedIn: Boolean(session),
      name: session?.name ?? null,
      email: session?.email ?? null,
      provider: session?.provider ?? null,
      eligible: Boolean(session) && eligible,
      reason: session ? reason : 'sign_in_required',
      trialSeconds: TRIAL_SECONDS,
      googleEnabled: GOOGLE_ENABLED,
      devLoginEnabled: DEV_LOGIN_ENABLED,
    }, setCookies);
  }

  if (pathname === '/api/trial/start' && method === 'POST') {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { error: 'sign_in_required' }, setCookies);
    if (!trialState(session.k, device).eligible) {
      return sendJson(res, 403, { error: 'trial_used' }, setCookies);
    }
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TRIAL_SECONDS;
    try {
      insertTrial(id, session.k, session.email ?? null, device, now, expiresAt);
    } catch {
      // Unique index on identity, or a race — the trial is already spent.
      return sendJson(res, 403, { error: 'trial_used' }, setCookies);
    }
    return sendJson(res, 200, {
      sessionId: id,
      expiresIn: TRIAL_SECONDS,
      expiresAt,
      mode: DECART_API_KEY ? 'live' : 'stub',
    }, setCookies);
  }

  if (pathname === '/api/trial/end' && method === 'POST') {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { error: 'sign_in_required' }, setCookies);
    const body = await readJson(req);
    if (body.sessionId) completeTrial(Math.floor(Date.now() / 1000), String(body.sessionId), session.k);
    return sendJson(res, 200, { ok: true }, setCookies);
  }

  // ── Auth: Google ──
  if (pathname === '/auth/google' && method === 'GET') {
    if (!GOOGLE_ENABLED) return redirect(res, '/?auth=disabled', setCookies);
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, setCookies);
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    if (!GOOGLE_ENABLED || !code) return redirect(res, '/?auth=error', setCookies);
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return redirect(res, '/?auth=error', setCookies);
      const { access_token } = await tokenRes.json();
      const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then((r) => r.json());
      if (!info?.id) return redirect(res, '/?auth=error', setCookies);
      const identity = { k: `google:${info.id}`, name: info.name ?? null, email: info.email ?? null, provider: 'google' };
      setCookies.push(sessionCookie(identity));
      return redirect(res, '/?auth=success', setCookies);
    } catch {
      return redirect(res, '/?auth=error', setCookies);
    }
  }

  // ── Auth: dev fallback (name + email; unverified) ──
  if (pathname === '/auth/dev' && method === 'POST') {
    if (!DEV_LOGIN_ENABLED) return sendJson(res, 404, { error: 'not_found' }, setCookies);
    const body = await readJson(req);
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!name) return sendJson(res, 400, { error: 'name_required' }, setCookies);
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'invalid_email' }, setCookies);
    const identity = { k: `email:${email}`, name, email, provider: 'dev' };
    setCookies.push(sessionCookie(identity));
    return sendJson(res, 200, { ok: true, signedIn: true, name, email }, setCookies);
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    setCookies.push(cookie('ow_session', '', { maxAge: 0 }));
    return sendJson(res, 200, { ok: true }, setCookies);
  }

  // ── Static files (with byte-range for video) ──
  const decoded = decodeURIComponent(pathname);
  const rel = normalize(decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  const target = join(publicDir, rel);
  if (!target.startsWith(publicDir + sep) || !existsSync(target) || statSync(target).isDirectory()) {
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    res.writeHead(404).end('Not found');
    return;
  }
  if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
  res.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const { size } = statSync(target);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', size);
  createReadStream(target).pipe(res);
}
