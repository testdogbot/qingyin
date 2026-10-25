// 在线正版免费曲库：Jamendo（需 client_id）与 Internet Archive（无需密钥）
// 统一的曲目结构：
// { source, id, title, artist, album, cover, duration, streams: { flac?, mp3? }, downloads: { flac?, mp3? }, license? }

const UA = 'Qingyin/0.1 (+https://github.com/testdogbot/qingyin)';
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function getJSON(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`上游返回 ${r.status}`);
  const v = await r.json();
  cache.set(url, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

// ---------------- Jamendo ----------------
function jamendoFormat(url, fmt) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.searchParams.has('format')) { u.searchParams.set('format', fmt); return u.toString(); }
    return url.replace(/\/(mp31|mp32|ogg|flac)\/?$/, `/${fmt}/`);
  } catch { return null; }
}

function mapJamendo(t) {
  const dlAllowed = t.audiodownload_allowed !== false && !!t.audiodownload;
  return {
    source: 'jamendo',
    id: String(t.id),
    title: t.name,
    artist: t.artist_name,
    album: t.album_name || '',
    cover: t.image || t.album_image || '',
    duration: Number(t.duration) || 0,
    streams: { flac: jamendoFormat(t.audio, 'flac'), mp3: jamendoFormat(t.audio, 'mp32') },
    downloads: dlAllowed ? { flac: jamendoFormat(t.audiodownload, 'flac'), mp3: jamendoFormat(t.audiodownload, 'mp32') } : {},
    license: t.license_ccurl || '',
    page: t.shareurl || '',
  };
}

export async function jamendoTracks(clientId, { q = '', tags = '', featured = false, offset = 0, limit = 30 } = {}) {
  if (!clientId) throw Object.assign(new Error('还没填 Jamendo client_id（设置里可填，免费申请）'), { code: 'NO_KEY' });
  const p = new URLSearchParams({
    client_id: clientId, format: 'json', limit: String(Math.min(limit, 200)), offset: String(offset),
    audioformat: 'flac', audiodlformat: 'flac', imagesize: '300', type: 'single albumtrack', include: 'licenses',
  });
  if (q) p.set('search', q);
  if (tags) p.set('fuzzytags', tags);
  if (featured) { p.set('featured', '1'); p.set('groupby', 'artist_id'); p.set('boost', 'popularity_week'); }
  if (!q && !tags && !featured) p.set('order', 'popularity_week');
  const d = await getJSON(`https://api.jamendo.com/v3.0/tracks/?${p}`);
  if (d.headers?.status !== 'success') throw new Error(d.headers?.error_message || 'Jamendo 请求失败');
  return (d.results || []).map(mapJamendo);
}

// ---------------- Internet Archive ----------------
const IA_FIELDS = ['identifier', 'title', 'creator', 'downloads', 'year', 'date'];

export async function archiveSearch({ q = '', lossless = true, page = 1, rows = 30 } = {}) {
  const clean = q.replace(/[()"]/g, ' ').trim();
  const parts = [];
  if (clean) parts.push(`(${clean})`);
  parts.push('mediatype:audio');
  parts.push(lossless ? 'format:Flac' : 'format:("VBR MP3" OR Flac)');
  if (!clean) parts.push('collection:(etree OR opensource_audio OR netlabels)');
  const p = new URLSearchParams({ q: parts.join(' AND '), rows: String(rows), page: String(page), output: 'json' });
  IA_FIELDS.forEach(f => p.append('fl[]', f));
  p.append('sort[]', 'downloads desc');
  const d = await getJSON(`https://archive.org/advancedsearch.php?${p}`);
  return {
    total: d.response?.numFound || 0,
    albums: (d.response?.docs || []).map(x => ({
      source: 'archive',
      id: x.identifier,
      title: Array.isArray(x.title) ? x.title[0] : (x.title || x.identifier),
      artist: Array.isArray(x.creator) ? x.creator.join(' / ') : (x.creator || ''),
      year: x.year || (x.date ? String(x.date).slice(0, 4) : ''),
      downloads: x.downloads || 0,
      cover: `https://archive.org/services/img/${encodeURIComponent(x.identifier)}`,
    })),
  };
}

function parseLength(s) {
  if (s == null) return 0;
  const str = String(s);
  if (str.includes(':')) return str.split(':').reduce((a, b) => a * 60 + Number(b || 0), 0);
  return Math.round(Number(str) || 0);
}

export async function archiveAlbum(identifier) {
  if (!/^[\w.\-]+$/.test(identifier)) throw new Error('无效的条目');
  const d = await getJSON(`https://archive.org/metadata/${identifier}`);
  if (!d.files) throw new Error('找不到这个条目');
  const meta = d.metadata || {};
  const base = `https://archive.org/download/${identifier}/`;
  const enc = n => base + n.split('/').map(encodeURIComponent).join('/');
  const byStem = new Map();
  for (const f of d.files) {
    const fmt = f.format || '';
    let kind = null;
    if (/^Flac$|24bit Flac/i.test(fmt)) kind = 'flac';
    else if (/VBR MP3|320Kbps MP3|^MP3$|128Kbps MP3/i.test(fmt)) kind = 'mp3';
    if (!kind) continue;
    const stem = f.name.replace(/\.[^.]+$/, '');
    const e = byStem.get(stem) || { stem, files: {} };
    // 优先 VBR/320 的 mp3
    if (kind === 'mp3' && e.files.mp3 && !/VBR|320/i.test(fmt)) continue;
    e.files[kind] = f;
    byStem.set(stem, e);
  }
  const artist = Array.isArray(meta.creator) ? meta.creator.join(' / ') : (meta.creator || '');
  const album = Array.isArray(meta.title) ? meta.title[0] : (meta.title || identifier);
  const cover = `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
  const tracks = [...byStem.values()].map(e => {
    const main = e.files.flac || e.files.mp3;
    const src = e.files.flac?.title ? e.files.flac : (e.files.mp3 || main);
    const num = parseInt(main.track || src.track || '', 10);
    return {
      source: 'archive',
      id: `${identifier}/${main.name}`,
      title: src.title || main.title || e.stem.split('/').pop(),
      artist: src.creator || src.artist || artist,
      album,
      cover,
      duration: parseLength(main.length || src.length),
      streams: { flac: e.files.flac ? enc(e.files.flac.name) : null, mp3: e.files.mp3 ? enc(e.files.mp3.name) : null },
      downloads: { flac: e.files.flac ? enc(e.files.flac.name) : null, mp3: e.files.mp3 ? enc(e.files.mp3.name) : null },
      license: meta.licenseurl || '',
      page: `https://archive.org/details/${identifier}`,
      _n: Number.isFinite(num) ? num : null,
      _name: main.name,
    };
  });
  tracks.sort((a, b) => (a._n ?? 1e9) - (b._n ?? 1e9) || a._name.localeCompare(b._name, 'en', { numeric: true }));
  tracks.forEach(t => { delete t._n; delete t._name; });
  return {
    source: 'archive', id: identifier, title: album, artist, cover,
    year: meta.year || (meta.date ? String(meta.date).slice(0, 4) : ''),
    description: String(meta.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600),
    license: meta.licenseurl || '',
    page: `https://archive.org/details/${identifier}`,
    tracks,
  };
}

// 只允许代理下载这些主机
export function allowedRemote(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)archive\.org$/.test(u.hostname) || /(^|\.)jamendo\.com$/.test(u.hostname);
  } catch { return false; }
}

export { UA };
