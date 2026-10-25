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

// ---------------- 中文搜索辅助 ----------------
export const hasCJK = s => /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
// 常见中文风格词 → Jamendo 英文标签
const ZH_TAGS = {
  流行: 'pop', 电子: 'electronic', 电音: 'electronic', 摇滚: 'rock', 爵士: 'jazz', 古典: 'classical', 民谣: 'folk',
  氛围: 'ambient', 轻音乐: 'easylistening', 纯音乐: 'instrumental', 钢琴: 'piano', 吉他: 'guitar', 嘻哈: 'hiphop',
  说唱: 'rap', 原声: 'soundtrack', 配乐: 'soundtrack', 影视: 'soundtrack', 放松: 'relaxation', 冥想: 'meditation',
  睡眠: 'sleep', 助眠: 'sleep', 学习: 'lofi', 中国风: 'chinese', 国风: 'chinese', 古风: 'chinese', 古筝: 'chinese',
  二胡: 'chinese', 笛子: 'chinese', 琵琶: 'chinese', 华语: 'chinese', 中文: 'chinese', 中国: 'chinese', 日语: 'japanese',
  日本: 'japanese', 韩语: 'korean', 小提琴: 'violin', 大提琴: 'cello', 蓝调: 'blues', 布鲁斯: 'blues', 金属: 'metal',
  朋克: 'punk', 雷鬼: 'reggae', 拉丁: 'latin', 乡村: 'country', 灵魂乐: 'soul', 舞曲: 'dance', 史诗: 'epic',
  游戏: 'videogame', 儿歌: 'children', 圣诞: 'christmas', 新年: 'chinesenewyear', 治愈: 'relaxing', 浪漫: 'romantic',
  悲伤: 'sad', 伤感: 'sad', 快乐: 'happy', 欢快: 'happy', 夜晚: 'night', 咖啡: 'lounge', 独立: 'indie',
};
export function zhTags(q) { const t = new Set(); for (const [k, v] of Object.entries(ZH_TAGS)) if (q.includes(k)) t.add(v); return [...t]; }

async function jamendoRaw(clientId, params) {
  const p = new URLSearchParams({
    client_id: clientId, format: 'json', limit: '50', audioformat: 'flac', audiodlformat: 'flac',
    imagesize: '300', type: 'single albumtrack', include: 'licenses', ...params,
  });
  const d = await getJSON(`https://api.jamendo.com/v3.0/tracks/?${p}`);
  if (d.headers?.status !== 'success') throw new Error(d.headers?.error_message || 'Jamendo 请求失败');
  return d.results || [];
}
function mergeTracks(lists, max = 60) {
  const seen = new Set(), out = [];
  for (const l of lists) for (const t of l) { if (seen.has(t.id)) continue; seen.add(t.id); out.push(t); }
  return out.slice(0, max).map(mapJamendo);
}

export async function jamendoTracks(clientId, { q = '', tags = '', featured = false, offset = 0, limit = 30 } = {}) {
  if (!clientId) throw Object.assign(new Error('还没填 Jamendo client_id（设置里可填，免费申请）'), { code: 'NO_KEY' });
  if (tags === 'zh') return jamendoChinese(clientId);
  const base = { limit: String(Math.min(limit, 200)), offset: String(offset) };
  if (q) {
    // Jamendo 的 search 对中文几乎不分词；中文时优先按歌名/歌手/专辑名匹配（namesearch），再补风格标签
    const jobs = [];
    if (hasCJK(q)) jobs.push(jamendoRaw(clientId, { ...base, namesearch: q, order: 'popularity_total' }));
    jobs.push(jamendoRaw(clientId, { ...base, search: q }));
    const zt = zhTags(q);
    if (zt.length) jobs.push(jamendoRaw(clientId, { ...base, fuzzytags: zt.join('+'), order: 'popularity_total' }));
    const res = await Promise.allSettled(jobs);
    if (res.every(r => r.status === 'rejected')) throw res[0].reason;
    return mergeTracks(res.map(r => r.status === 'fulfilled' ? r.value : []), 60);
  }
  const p = { ...base };
  if (tags) p.fuzzytags = tags;
  if (featured) { p.featured = '1'; p.groupby = 'artist_id'; p.boost = 'popularity_week'; }
  if (!tags && !featured) p.order = 'popularity_week';
  return (await jamendoRaw(clientId, p)).map(mapJamendo);
}

// 华语：Jamendo 没有语言筛选，用常见汉字做歌名匹配，再合并中国风标签
const ZH_SEEDS = ['的', '我', '你', '爱', '心', '风', '夜', '梦', '月', '雨', '春', '光'];
let zhCache = { at: 0, list: null };
async function jamendoChinese(clientId) {
  if (zhCache.list && Date.now() - zhCache.at < 3600e3) return zhCache.list;
  const jobs = ZH_SEEDS.map(c => jamendoRaw(clientId, { namesearch: c, limit: '40', order: 'popularity_total' }))
    .concat(jamendoRaw(clientId, { fuzzytags: 'chinese', limit: '30', order: 'popularity_total' }));
  const res = (await Promise.allSettled(jobs)).map(r => r.status === 'fulfilled' ? r.value : []);
  const pool = new Map();
  for (const l of res) for (const t of l) if (!pool.has(t.id) && (hasCJK(t.name + t.artist_name + (t.album_name || '')) || l === res[res.length - 1])) pool.set(t.id, t);
  const list = [...pool.values()].sort((a, b) => hasCJK(b.name) - hasCJK(a.name)).slice(0, 80).map(mapJamendo);
  zhCache = { at: Date.now(), list };
  return list;
}

// ---------------- Internet Archive ----------------
const IA_FIELDS = ['identifier', 'title', 'creator', 'downloads', 'year', 'date'];

// 只用授权清晰的合集：etree（艺人允许录制传播的现场）、netlabels（CC 授权网络厂牌）、
// georgeblood / 78rpm（上世纪老唱片数字化保存）。不搜社区上传区，避免盗传的流行专辑。
const IA_SAFE = 'collection:(etree OR netlabels OR georgeblood OR 78rpm)';
const IA_ZH = 'language:(chi OR chinese OR Chinese OR zho OR Mandarin OR Cantonese)';

function iaMap(x) {
  return {
    source: 'archive',
    id: x.identifier,
    title: Array.isArray(x.title) ? x.title[0] : (x.title || x.identifier),
    artist: Array.isArray(x.creator) ? x.creator.join(' / ') : (x.creator || ''),
    year: x.year || (x.date ? String(x.date).slice(0, 4) : ''),
    downloads: x.downloads || 0,
    cover: `https://archive.org/services/img/${encodeURIComponent(x.identifier)}`,
  };
}
async function iaQuery(q, page, rows) {
  const p = new URLSearchParams({ q, rows: String(rows), page: String(page), output: 'json' });
  IA_FIELDS.forEach(f => p.append('fl[]', f));
  p.append('sort[]', 'downloads desc');
  const d = await getJSON(`https://archive.org/advancedsearch.php?${p}`);
  return { total: d.response?.numFound || 0, docs: (d.response?.docs || []).filter(x => !/^None legible$|^Title in Chinese$/i.test(String(x.title || ''))) };
}

export async function archiveSearch({ q = '', lossless = true, page = 1, rows = 30, zh = false } = {}) {
  const clean = q.replace(/[()"\[\]{}:^~*?\\]/g, ' ').trim();
  const parts = ['mediatype:(audio OR etree)', IA_SAFE];
  if (clean) {
    const terms = [`(${clean})`];
    if (hasCJK(clean)) zhTags(clean).forEach(t => terms.push(t === 'chinese' ? `(${IA_ZH})` : `subject:(${t})`));
    parts.push(`(${terms.join(' OR ')})`);
  }
  if (zh) parts.push(IA_ZH);
  const fmt = lossless ? 'format:(Flac OR "24bit Flac")' : 'format:(Flac OR "24bit Flac" OR "VBR MP3")';
  let r = await iaQuery([...parts, fmt].join(' AND '), page, rows);
  // 无损没有结果时自动放宽到 MP3（老唱片很多只有 MP3）
  if (lossless && r.total === 0) r = await iaQuery([...parts, 'format:(Flac OR "24bit Flac" OR "VBR MP3")'].join(' AND '), page, rows);
  return { total: r.total, albums: r.docs.map(iaMap) };
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
