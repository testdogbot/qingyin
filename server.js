// 清音 · 轻量自建音乐站
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { stat, unlink, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jamendoTracks, archiveSearch, archiveAlbum, allowedRemote, UA } from './lib/sources.js';
import { readTags } from './lib/tags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 800) * 1024 * 1024;
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav']);
mkdirSync(MUSIC_DIR, { recursive: true });

// ---------------- 数据库 ----------------
export const db = new DatabaseSync(path.join(DATA_DIR, 'qingyin.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, title TEXT, artist TEXT, album TEXT,
  format TEXT, size INTEGER, duration INTEGER, sample_rate INTEGER, bit_depth INTEGER,
  track_no INTEGER, origin TEXT, added INTEGER
);
CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL, pos INTEGER NOT NULL, track TEXT NOT NULL, key TEXT NOT NULL,
  PRIMARY KEY (playlist_id, key)
);
CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, status TEXT, error TEXT, track_id TEXT, title TEXT, created INTEGER);
`);
if (!db.prepare('SELECT 1 FROM playlists WHERE id = 1').get()) {
  db.prepare("INSERT INTO playlists (id, name, created) VALUES (1, '我喜欢', ?)").run(Date.now());
}
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const jamendoKey = () => getSetting('jamendo_client_id') || process.env.JAMENDO_CLIENT_ID || '';

// ---------------- 登录（单用户，自己用） ----------------
function hashPw(pw) { const salt = randomBytes(16); return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) {
  const [s, h] = (stored || '').split(':'); if (!s || !h) return false;
  const a = scryptSync(pw, Buffer.from(s, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieToken(req) { const m = /(?:^|;\s*)qy=([a-f0-9]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; }
function authed(req) { const t = cookieToken(req); return !!t && !!db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(t); }
function issueSession(res, req) {
  const t = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created) VALUES (?, ?)').run(t, Date.now());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `qy=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${secure}`);
}

const fails = new Map();
function rateLimited(ip) {
  const now = Date.now(), r = fails.get(ip) || { n: 0, t: now };
  if (now - r.t > 15 * 60 * 1000) { r.n = 0; r.t = now; }
  fails.set(ip, r);
  return r.n >= 10 ? r : null;
}

export const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

const api = express.Router();
api.use(express.json({ limit: '200kb' }));

api.get('/status', (req, res) => {
  res.json({ setup: !getSetting('password'), authed: authed(req), jamendo: !!jamendoKey() });
});
api.post('/setup', (req, res) => {
  if (getSetting('password')) return res.status(409).json({ error: '已经设置过密码了' });
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  setSetting('password', hashPw(pw));
  issueSession(res, req);
  res.json({ ok: true });
});
api.post('/login', (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: '尝试太多次，15 分钟后再试' });
  if (!checkPw(String(req.body?.password || ''), getSetting('password'))) {
    fails.get(ip).n++;
    return res.status(401).json({ error: '密码不对' });
  }
  fails.delete(ip);
  issueSession(res, req);
  res.json({ ok: true });
});
api.post('/logout', (req, res) => {
  const t = cookieToken(req); if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', 'qy=; Path=/; Max-Age=0'); res.json({ ok: true });
});

api.use((req, res, next) => authed(req) ? next() : res.status(401).json({ error: '请先登录' }));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  res.status(e.code === 'NO_KEY' ? 400 : 502).json({ error: e.message || '出错了', code: e.code });
});

// ---------------- 设置 ----------------
api.get('/settings', (req, res) => {
  const k = jamendoKey();
  res.json({ jamendo_client_id: k ? k.slice(0, 4) + '…' : '', jamendo_from_env: !getSetting('jamendo_client_id') && !!process.env.JAMENDO_CLIENT_ID });
});
api.post('/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.jamendo_client_id === 'string') setSetting('jamendo_client_id', b.jamendo_client_id.trim());
  if (b.new_password) {
    if (!checkPw(String(b.old_password || ''), getSetting('password'))) return res.status(400).json({ error: '原密码不对' });
    if (String(b.new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    setSetting('password', hashPw(String(b.new_password)));
    const t = cookieToken(req);
    db.prepare('DELETE FROM sessions WHERE token != ?').run(t || '');
  }
  res.json({ ok: true });
});

// ---------------- 在线曲库 ----------------
api.get('/jamendo/tracks', wrap(async (req, res) => {
  const { q = '', tags = '', featured = '', offset = '0' } = req.query;
  res.json({ tracks: await jamendoTracks(jamendoKey(), { q: String(q).slice(0, 100), tags: String(tags).slice(0, 60), featured: featured === '1', offset: Number(offset) || 0 }) });
}));
api.get('/archive/search', wrap(async (req, res) => {
  const { q = '', lossless = '1', page = '1', zh = '' } = req.query;
  res.json(await archiveSearch({ q: String(q).slice(0, 100), lossless: lossless !== '0', zh: zh === '1', page: Math.max(1, Number(page) || 1) }));
}));
api.get('/archive/album/:id', wrap(async (req, res) => { res.json(await archiveAlbum(req.params.id)); }));

// 代理下载：强制以附件形式保存，文件名用 “歌手 - 标题.扩展名”
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track'; }
function dispo(name) { return `attachment; filename="${encodeURIComponent(name).replace(/%20/g, ' ').replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`; }

api.get('/download', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!allowedRemote(url)) return res.status(400).json({ error: '不支持的下载地址' });
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok || !r.body) return res.status(502).json({ error: `下载源返回 ${r.status}` });
  const ext = (/\.(flac|mp3|ogg|m4a)(\?|$)/i.exec(new URL(r.url).pathname)?.[1] || (/flac/.test(url) ? 'flac' : 'mp3')).toLowerCase();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  if (r.headers.get('content-length')) res.setHeader('Content-Length', r.headers.get('content-length'));
  res.setHeader('Content-Disposition', dispo(`${safeName(req.query.name)}.${ext}`));
  await pipeline(Readable.fromWeb(r.body), res).catch(() => {});
}));

// ---------------- 本地曲库 ----------------
function rowToTrack(r) {
  return {
    source: 'local', id: r.id, title: r.title, artist: r.artist || '', album: r.album || '', cover: '',
    duration: r.duration || 0, format: r.format, size: r.size, sampleRate: r.sample_rate, bitDepth: r.bit_depth,
    streams: { [r.format === 'flac' ? 'flac' : 'mp3']: `/api/library/${r.id}/stream` },
    downloads: { [r.format === 'flac' ? 'flac' : 'mp3']: `/api/library/${r.id}/download` },
  };
}

async function addFile(file, origName, origin, hint = {}) {
  const st = await stat(file);
  const tags = await readTags(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const base = path.basename(origName || file).replace(/\.[^.]+$/, '');
  let title = tags.title || hint.title, artist = tags.artist || hint.artist;
  if (!title) { const m = /^(.+?)\s+-\s+(.+)$/.exec(base); if (m) { artist = artist || m[1]; title = m[2]; } else title = base; }
  const id = path.basename(file).replace(/\.[^.]+$/, '');
  db.prepare(`INSERT OR REPLACE INTO tracks (id, file, title, artist, album, format, size, duration, sample_rate, bit_depth, track_no, origin, added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, path.basename(file), title, artist || '', tags.album || hint.album || '', tags.format || ext, st.size,
    tags.duration || hint.duration || null, tags.sampleRate || null, tags.bitDepth || null, tags.track || null, origin, Date.now());
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

api.get('/library', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db.prepare("SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY added DESC").all(...Array(3).fill(`%${q}%`))
    : db.prepare('SELECT * FROM tracks ORDER BY added DESC').all();
  const total = db.prepare('SELECT COALESCE(SUM(size),0) s FROM tracks').get().s;
  res.json({ tracks: rows.map(rowToTrack), totalBytes: total });
});

// 原始请求体上传：PUT /api/library/upload?name=xxx.flac
api.put('/library/upload', wrap(async (req, res) => {
  const name = String(req.query.name || '');
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_EXT.has(ext)) return res.status(400).json({ error: '只支持 flac/mp3/m4a/aac/ogg/opus/wav' });
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) return res.status(413).json({ error: '文件太大' });
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const tmp = path.join(MUSIC_DIR, `.${id}.part`), dest = path.join(MUSIC_DIR, id + ext);
  let seen = 0;
  const limiter = new Transform({ transform(chunk, _e, cb) { seen += chunk.length; cb(seen > MAX_UPLOAD ? new Error('文件太大') : null, chunk); } });
  try {
    await pipeline(req, limiter, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  res.json({ track: rowToTrack(await addFile(dest, name, 'upload')) });
}));

// 把在线曲目存进本地曲库（服务器端下载，后台进行）
api.post('/library/import', (req, res) => {
  const { url, title, artist, album, duration } = req.body || {};
  if (!allowedRemote(String(url || ''))) return res.status(400).json({ error: '不支持的地址' });
  const jobId = randomUUID();
  db.prepare("INSERT INTO imports (id, status, title, created) VALUES (?, 'running', ?, ?)").run(jobId, String(title || ''), Date.now());
  res.json({ job: jobId });
  (async () => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`下载源返回 ${r.status}`);
    const ext = '.' + ((/\.(flac|mp3|ogg|m4a)$/i.exec(new URL(r.url).pathname)?.[1]) || (/flac/i.test(url) ? 'flac' : 'mp3')).toLowerCase();
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const tmp = path.join(MUSIC_DIR, `.${id}.part`), dest = path.join(MUSIC_DIR, id + ext);
    try { await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp)); await rename(tmp, dest); }
    catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    const row = await addFile(dest, `${title}${ext}`, 'import', { title, artist, album, duration });
    db.prepare("UPDATE imports SET status = 'done', track_id = ? WHERE id = ?").run(row.id, jobId);
  })().catch(e => db.prepare("UPDATE imports SET status = 'error', error = ? WHERE id = ?").run(String(e.message || e), jobId));
});
api.get('/library/import/:job', (req, res) => {
  const j = db.prepare('SELECT * FROM imports WHERE id = ?').get(req.params.job);
  j ? res.json(j) : res.status(404).json({ error: '没有这个任务' });
});

function localFile(id) {
  const r = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(id));
  return r ? { row: r, file: path.join(MUSIC_DIR, r.file) } : null;
}
api.get('/library/:id/stream', (req, res) => {
  const f = localFile(req.params.id); if (!f || !existsSync(f.file)) return res.status(404).end();
  res.sendFile(f.file, { headers: { 'Cache-Control': 'private, max-age=86400' } });
});
api.get('/library/:id/download', (req, res) => {
  const f = localFile(req.params.id); if (!f || !existsSync(f.file)) return res.status(404).end();
  const name = `${safeName([f.row.artist, f.row.title].filter(Boolean).join(' - '))}${path.extname(f.file)}`;
  res.setHeader('Content-Disposition', dispo(name));
  res.sendFile(f.file);
});
api.patch('/library/:id', (req, res) => {
  const f = localFile(req.params.id); if (!f) return res.status(404).json({ error: '没找到' });
  const b = req.body || {};
  db.prepare('UPDATE tracks SET title = COALESCE(?, title), artist = COALESCE(?, artist), album = COALESCE(?, album) WHERE id = ?')
    .run(b.title ?? null, b.artist ?? null, b.album ?? null, f.row.id);
  res.json({ track: rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(f.row.id)) });
});
api.delete('/library/:id', wrap(async (req, res) => {
  const f = localFile(req.params.id); if (!f) return res.status(404).json({ error: '没找到' });
  await unlink(f.file).catch(() => {});
  db.prepare('DELETE FROM tracks WHERE id = ?').run(f.row.id);
  db.prepare("DELETE FROM playlist_items WHERE key = ?").run(`local:${f.row.id}`);
  res.json({ ok: true });
}));

// ---------------- 歌单 ----------------
const keyOf = t => `${t.source}:${t.id}`;
api.get('/playlists', (req, res) => {
  res.json({ playlists: db.prepare('SELECT p.id, p.name, COUNT(i.key) AS count FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id GROUP BY p.id ORDER BY p.id').all() });
});
api.post('/playlists', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: '起个名字吧' });
  const r = db.prepare('INSERT INTO playlists (name, created) VALUES (?, ?)').run(name, Date.now());
  res.json({ id: Number(r.lastInsertRowid), name });
});
api.patch('/playlists/:id', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: '起个名字吧' });
  db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  res.json({ ok: true });
});
api.delete('/playlists/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: '“我喜欢”不能删' });
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  res.json({ ok: true });
});
api.get('/playlists/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '没有这个歌单' });
  const items = db.prepare('SELECT track FROM playlist_items WHERE playlist_id = ? ORDER BY pos').all(p.id).map(r => JSON.parse(r.track));
  res.json({ id: p.id, name: p.name, tracks: items });
});
function cleanTrack(t) {
  const pick = o => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => ['flac', 'mp3'].includes(k) && typeof v === 'string' && v.length < 2000));
  return {
    source: String(t.source).slice(0, 20), id: String(t.id).slice(0, 400), title: String(t.title || '').slice(0, 300),
    artist: String(t.artist || '').slice(0, 300), album: String(t.album || '').slice(0, 300), cover: String(t.cover || '').slice(0, 1000),
    duration: Number(t.duration) || 0, streams: pick(t.streams), downloads: pick(t.downloads), page: String(t.page || '').slice(0, 500),
  };
}
api.post('/playlists/:id/tracks', (req, res) => {
  const pid = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(pid)) return res.status(404).json({ error: '没有这个歌单' });
  const t = req.body?.track; if (!t?.source || !t?.id) return res.status(400).json({ error: '缺少曲目' });
  const ct = cleanTrack(t);
  const pos = (db.prepare('SELECT COALESCE(MAX(pos), 0) m FROM playlist_items WHERE playlist_id = ?').get(pid).m) + 1;
  db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, pos, track, key) VALUES (?, ?, ?, ?)').run(pid, pos, JSON.stringify(ct), keyOf(ct));
  res.json({ ok: true });
});
api.delete('/playlists/:id/tracks', (req, res) => {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND key = ?').run(Number(req.params.id), String(req.query.key || ''));
  res.json({ ok: true });
});
api.get('/liked', (req, res) => {
  res.json({ keys: db.prepare('SELECT key FROM playlist_items WHERE playlist_id = 1').all().map(r => r.key) });
});

app.use('/api', api);
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, HOST, () => console.log(`清音已启动 http://${HOST}:${PORT}  数据目录 ${DATA_DIR}`));
}
