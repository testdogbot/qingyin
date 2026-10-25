// 极简标签读取：FLAC Vorbis Comment / MP3 ID3v2.3-2.4 / M4A 不解析（用文件名）
import { open } from 'node:fs/promises';

async function readHead(path, n = 512 * 1024) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

function flacTags(b) {
  const out = {};
  let p = 4;
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80, type = b[p] & 0x7f, len = b.readUIntBE(p + 1, 3);
    const s = p + 4;
    if (type === 0 && s + 18 <= b.length) {
      // STREAMINFO：采样率、位深、总采样数
      const sr = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
      const bps = (((b[s + 12] & 1) << 4) | (b[s + 13] >> 4)) + 1;
      const total = (b[s + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14);
      out.sampleRate = sr; out.bitDepth = bps;
      if (sr) out.duration = Math.round(total / sr);
    }
    if (type === 4 && s + len <= b.length) {
      let q = s;
      const vlen = b.readUInt32LE(q); q += 4 + vlen;
      const count = b.readUInt32LE(q); q += 4;
      for (let i = 0; i < count && q + 4 <= s + len; i++) {
        const l = b.readUInt32LE(q); q += 4;
        const kv = b.toString('utf8', q, q + l); q += l;
        const k = kv.slice(0, kv.indexOf('=')).toUpperCase(), v = kv.slice(kv.indexOf('=') + 1);
        if (k === 'TITLE') out.title = v;
        else if (k === 'ARTIST') out.artist = out.artist ? out.artist : v;
        else if (k === 'ALBUM') out.album = v;
        else if (k === 'TRACKNUMBER') out.track = parseInt(v, 10) || undefined;
      }
    }
    if (last) break;
    p = s + len;
  }
  return out;
}

function decodeText(enc, buf) {
  if (enc === 0) return buf.toString('latin1').replace(/\0+$/, '');
  if (enc === 3) return buf.toString('utf8').replace(/\0+$/, '');
  if (enc === 1) {
    let le = true, s = buf;
    if (buf[0] === 0xfe && buf[1] === 0xff) { le = false; s = buf.subarray(2); }
    else if (buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2);
    if (!le) { s = Buffer.from(s); s.swap16(); }
    return s.toString('utf16le').replace(/\0+$/, '');
  }
  if (enc === 2) { const s = Buffer.from(buf.subarray(0, buf.length & ~1)); s.swap16(); return s.toString('utf16le').replace(/\0+$/, ''); }
  return '';
}

function id3Tags(b) {
  const out = {};
  const ver = b[3];
  const syncsafe = (o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const size = syncsafe(6);
  let p = 10;
  const end = Math.min(10 + size, b.length);
  while (p + 10 <= end) {
    const id = b.toString('latin1', p, p + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4 ? syncsafe(p + 4) : b.readUInt32BE(p + 4);
    const s = p + 10;
    if (len <= 0 || s + len > end) break;
    if (id[0] === 'T') {
      const v = decodeText(b[s], b.subarray(s + 1, s + len)).split('\0')[0].trim();
      if (id === 'TIT2') out.title = v;
      else if (id === 'TPE1') out.artist = v;
      else if (id === 'TALB') out.album = v;
      else if (id === 'TRCK') out.track = parseInt(v, 10) || undefined;
    }
    p = s + len;
  }
  return out;
}

export async function readTags(path) {
  try {
    const b = await readHead(path);
    if (b.toString('latin1', 0, 4) === 'fLaC') return { format: 'flac', ...flacTags(b) };
    if (b.toString('latin1', 0, 3) === 'ID3') return { format: 'mp3', ...id3Tags(b) };
    return {};
  } catch { return {}; }
}
