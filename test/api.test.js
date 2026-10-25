import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'qy-'));
process.env.DATA_DIR = dir;
const { app } = await import('../server.js');
let server, base, cookie = '';

before(() => new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); }));
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(p, opts = {}) {
  const r = await fetch(base + p, { ...opts, headers: { cookie, ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const sc = r.headers.get('set-cookie'); if (sc && /qy=[a-f0-9]{64}/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

// 构造一个最小 FLAC：STREAMINFO + VORBIS_COMMENT
function fakeFlac() {
  const si = Buffer.alloc(34);
  // 44100Hz, 2ch, 16bit, 44100*5 采样
  const sr = 44100, ch = 1, bps = 15, total = 44100 * 5;
  si[10] = sr >> 12; si[11] = (sr >> 4) & 0xff; si[12] = ((sr & 0xf) << 4) | (ch << 1) | (bps >> 4);
  si[13] = ((bps & 0xf) << 4); si.writeUInt32BE(total, 14);
  const vendor = Buffer.from('test');
  const cs = ['TITLE=晴天测试', 'ARTIST=测试歌手', 'ALBUM=专辑'].map(s => Buffer.from(s));
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
  parts[0].writeUInt32LE(vendor.length); parts[2].writeUInt32LE(cs.length);
  for (const c of cs) { const l = Buffer.alloc(4); l.writeUInt32LE(c.length); parts.push(l, c); }
  const vc = Buffer.concat(parts);
  const h = (last, type, len) => Buffer.from([(last ? 0x80 : 0) | type, len >> 16, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([Buffer.from('fLaC'), h(0, 0, 34), si, h(1, 4, vc.length), vc, Buffer.alloc(64)]);
}

test('未登录访问受保护接口返回 401', async () => {
  assert.equal((await call('/library')).status, 401);
  assert.equal((await call('/status')).body.setup, true);
});

test('设置密码、登录、错误密码', async () => {
  assert.equal((await call('/setup', { method: 'POST', json: { password: '123' } })).status, 400);
  assert.equal((await call('/setup', { method: 'POST', json: { password: 'secret123' } })).status, 200);
  assert.equal((await call('/setup', { method: 'POST', json: { password: 'again123' } })).status, 409);
  const saved = cookie; cookie = '';
  assert.equal((await call('/login', { method: 'POST', json: { password: 'wrong' } })).status, 401);
  assert.equal((await call('/login', { method: 'POST', json: { password: 'secret123' } })).status, 200);
  assert.notEqual(cookie, saved);
  assert.equal((await call('/status')).body.authed, true);
});

test('上传 FLAC 后读取标签、可流式播放与下载', async () => {
  const buf = fakeFlac();
  const up = await call('/library/upload?name=' + encodeURIComponent('x.flac'), { method: 'PUT', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const t = up.body.track;
  assert.equal(t.title, '晴天测试'); assert.equal(t.artist, '测试歌手'); assert.equal(t.format, 'flac');
  assert.equal(t.sampleRate, 44100); assert.equal(t.bitDepth, 16); assert.equal(t.duration, 5);
  const st = await call(`/library/${t.id}/stream`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(st.status, 206); assert.equal(st.body.toString('latin1'), 'fLaC');
  const dl = await call(`/library/${t.id}/download`);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.match(decodeURIComponent(dl.headers.get('content-disposition')), /测试歌手 - 晴天测试\.flac/);
  const lib = await call('/library?q=' + encodeURIComponent('晴天'));
  assert.equal(lib.body.tracks.length, 1);
});

test('拒绝非音频扩展名与非白名单下载地址', async () => {
  assert.equal((await call('/library/upload?name=a.exe', { method: 'PUT', body: Buffer.from('x') })).status, 400);
  assert.equal((await call('/download?url=' + encodeURIComponent('https://evil.example.com/a.flac'))).status, 400);
  assert.equal((await call('/download?url=' + encodeURIComponent('http://archive.org/a.flac'))).status, 400);
  assert.equal((await call('/library/import', { method: 'POST', json: { url: 'file:///etc/passwd' } })).status, 400);
});

test('歌单：喜欢、去重、移除、默认歌单不能删', async () => {
  const track = { source: 'archive', id: 'item/a.flac', title: 'A', artist: 'B', streams: { flac: 'https://archive.org/download/item/a.flac', evil: 'x' } };
  await call('/playlists/1/tracks', { method: 'POST', json: { track } });
  await call('/playlists/1/tracks', { method: 'POST', json: { track } });
  let p = await call('/playlists/1');
  assert.equal(p.body.tracks.length, 1);
  assert.deepEqual(Object.keys(p.body.tracks[0].streams), ['flac']);
  assert.deepEqual((await call('/liked')).body.keys, ['archive:item/a.flac']);
  await call('/playlists/1/tracks?key=' + encodeURIComponent('archive:item/a.flac'), { method: 'DELETE' });
  assert.equal((await call('/playlists/1')).body.tracks.length, 0);
  assert.equal((await call('/playlists/1', { method: 'DELETE' })).status, 400);
  const np = await call('/playlists', { method: 'POST', json: { name: '通勤' } });
  assert.equal((await call('/playlists')).body.playlists.length, 2);
  await call(`/playlists/${np.body.id}`, { method: 'DELETE' });
  assert.equal((await call('/playlists')).body.playlists.length, 1);
});

test('未配置 Jamendo 时给出 NO_KEY 提示', async () => {
  const r = await call('/jamendo/tracks?q=test');
  assert.equal(r.status, 400); assert.equal(r.body.code, 'NO_KEY');
});
