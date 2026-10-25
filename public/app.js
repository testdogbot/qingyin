// 清音前端（无框架）
const $ = s => document.querySelector(s);
const main = $('#main');
const audio = $('#audio');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
const keyOf = t => `${t.source}:${t.id}`;
const svg = (d, f) => `<svg viewBox="0 0 24 24"${f ? ' class="f"' : ''}>${d}</svg>`;
const I = {
  play: svg('<path d="M7 4.5v15l13-7.5z"/>', 1), pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>', 1),
  prev: svg('<path d="M6 5h2v14H6zM20 5v14L9 12z"/>', 1), next: svg('<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>', 1),
  shuffle: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'), repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  queue: svg('<path d="M3 6h13M3 12h13M3 18h9"/><path d="m17 15 5 3-5 3z"/>'), x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
};
const playSvg = '<svg viewBox="0 0 24 24" class="f"><path d="M7 4.5v15l13-7.5z"/></svg>';
const skel = (n = 6) => `<div class="skel">${'<i></i>'.repeat(n)}</div>`;
const setFill = el => el.style.setProperty('--p', (el.value - el.min) / (el.max - el.min) * 100 + '%');

function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2400); }

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}, ...opts, body: opts.body && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showAuth(false); throw new Error('请先登录'); }
  if (!r.ok) throw Object.assign(new Error(d.error || `请求失败 ${r.status}`), { code: d.code });
  return d;
}

// ---------------- 登录 ----------------
let status = {};
function showAuth(setup) {
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
  $('#authHint').textContent = setup ? '第一次使用：设置一个访问密码（至少 6 位）' : '输入密码进入';
  $('#authBtn').textContent = setup ? '设置并进入' : '进入';
  $('#authForm').onsubmit = async e => {
    e.preventDefault(); $('#authErr').textContent = '';
    try { await api(setup ? '/setup' : '/login', { method: 'POST', body: { password: $('#authPw').value } }); boot(); }
    catch (err) { $('#authErr').textContent = err.message; }
  };
}
async function boot() {
  status = await api('/status');
  if (!status.authed) return showAuth(status.setup);
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  await refreshLiked();
  go(location.hash.slice(1) || 'discover');
}

// ---------------- 路由 ----------------
const views = {};
function go(hash) {
  const [view, ...rest] = hash.split('/');
  const fn = views[view] || views.discover;
  document.querySelectorAll('.side a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  if (location.hash.slice(1) !== hash) history.pushState(null, '', '#' + hash);
  main.innerHTML = skel(8);
  main.scrollTop = 0;
  fn(...rest.map(decodeURIComponent)).catch(e => { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
document.querySelectorAll('.side a').forEach(a => a.onclick = () => go(a.dataset.view));

// ---------------- 曲目列表 ----------------
let liked = new Set();
async function refreshLiked() { liked = new Set((await api('/liked')).keys); }
let lists = {};  // listId -> tracks，用于整列播放
function trackRows(tracks, listId, opts = {}) {
  lists[listId] = tracks;
  if (!tracks.length) return `<div class="empty">${opts.empty || '这里还空着'}</div>`;
  return `<div class="list">${tracks.map((t, i) => `
    <div class="tr ${cur && keyOf(cur) === keyOf(t) ? 'playing' : ''}" data-list="${listId}" data-i="${i}">
      <span class="n"><b>${i + 1}</b>${playSvg}<span class="eq"><i></i><i></i><i></i></span></span>
      <div class="img" style="background-image:url('${esc(t.cover)}')"></div>
      <div style="min-width:0"><div class="tt">${esc(t.title)}${t.streams?.flac ? '<span class="q">FLAC</span>' : ''}${t.bitDepth ? `<span class="q">${t.bitDepth}bit/${(t.sampleRate / 1000).toFixed(1)}k</span>` : ''}</div>
        <div class="ta">${esc([t.artist, t.album].filter(Boolean).join(' · '))}</div></div>
      <span class="d">${t.duration ? fmtT(t.duration) : ''}</span>
      <div class="acts">
        <button class="icon like ${liked.has(keyOf(t)) ? 'on' : ''}" data-act="like" title="喜欢">${I.heart}</button>
        <button class="icon" data-act="more" title="更多">${I.more}</button>
      </div>
    </div>`).join('')}</div>`;
}
main.addEventListener('click', e => {
  const row = e.target.closest('.tr[data-list]'); if (!row) return;
  const list = lists[row.dataset.list], i = Number(row.dataset.i), t = list[i];
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'like') return toggleLike(t, e.target.closest('button'));
  if (act === 'more') return trackMenu(t, e, row.dataset.list);
  playList(list, i);
});

async function toggleLike(t, btn) {
  const k = keyOf(t);
  if (liked.has(k)) { await api(`/playlists/1/tracks?key=${encodeURIComponent(k)}`, { method: 'DELETE' }); liked.delete(k); }
  else { await api('/playlists/1/tracks', { method: 'POST', body: { track: t } }); liked.add(k); }
  if (btn) btn.classList.toggle('on', liked.has(k));
  if (cur && keyOf(cur) === k) syncLike();
}

function closeMenu() { document.querySelector('.menu')?.remove(); }
document.addEventListener('click', e => { if (!e.target.closest('.menu') && !e.target.closest('[data-act="more"]')) closeMenu(); });
async function trackMenu(t, ev, listId) {
  closeMenu();
  const items = [['下一首播放', () => { queue.splice(qi + 1, 0, t); renderQueue(); toast('已加到下一首'); }],
    ['加入队列末尾', () => { queue.push(t); renderQueue(); toast('已加入队列'); }]];
  const { playlists } = await api('/playlists');
  playlists.filter(p => p.id !== 1).forEach(p => items.push([`加入歌单「${p.name}」`, async () => { await api(`/playlists/${p.id}/tracks`, { method: 'POST', body: { track: t } }); toast('已加入'); }]));
  items.push(['新建歌单并加入…', async () => { const name = prompt('歌单名'); if (!name) return; const p = await api('/playlists', { method: 'POST', body: { name } }); await api(`/playlists/${p.id}/tracks`, { method: 'POST', body: { track: t } }); toast('已加入'); }]);
  if (t.downloads?.flac) items.push(['下载 FLAC 无损', () => download(t, 'flac')]);
  if (t.downloads?.mp3) items.push(['下载 MP3', () => download(t, 'mp3')]);
  if (t.source !== 'local' && (t.downloads?.flac || t.downloads?.mp3)) items.push(['保存到我的曲库（服务器）', () => importTrack(t)]);
  if (t.source !== 'local' && !t.downloads?.flac && !t.downloads?.mp3) items.push(['（作者未开放下载）', () => {}]);
  if (listId.startsWith('pl')) items.push(['从歌单移除', async () => { await api(`/playlists/${listId.slice(2)}/tracks?key=${encodeURIComponent(keyOf(t))}`, { method: 'DELETE' }); await refreshLiked(); go(location.hash.slice(1)); }]);
  if (t.source === 'local') {
    items.push(['编辑信息', async () => { const title = prompt('标题', t.title); if (title == null) return; const artist = prompt('歌手', t.artist) ?? t.artist; await api(`/library/${t.id}`, { method: 'PATCH', body: { title, artist } }); go(location.hash.slice(1)); }]);
    items.push(['删除文件', async () => { if (!confirm(`删除「${t.title}」？文件会从服务器删掉。`)) return; await api(`/library/${t.id}`, { method: 'DELETE' }); go(location.hash.slice(1)); }]);
  }
  if (t.page) items.push(['打开来源页面', () => window.open(t.page, '_blank', 'noopener')]);
  const m = document.createElement('div'); m.className = 'menu';
  items.forEach(([label, fn]) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { closeMenu(); Promise.resolve(fn()).catch(err => toast(err.message)); }; m.append(b); });
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + 'px';
}

function download(t, q) {
  const url = t.downloads[q];
  const name = [t.artist, t.title].filter(Boolean).join(' - ');
  const href = t.source === 'local' ? url : `/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
  const a = document.createElement('a'); a.href = href; a.download = ''; document.body.append(a); a.click(); a.remove();
}
async function importTrack(t) {
  const q = t.downloads.flac ? 'flac' : 'mp3';
  const { job } = await api('/library/import', { method: 'POST', body: { url: t.downloads[q], title: t.title, artist: t.artist, album: t.album, duration: t.duration } });
  toast('开始保存到曲库…');
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const j = await api(`/library/import/${job}`);
    if (j.status === 'done') return toast(`「${t.title}」已存进曲库`);
    if (j.status === 'error') return toast('保存失败：' + j.error);
  }
}

// ---------------- 视图：发现 ----------------
const GENRES = [['华语', 'zh'], ['中国风', 'chinese'], ['流行', 'pop'], ['电子', 'electronic'], ['摇滚', 'rock'], ['爵士', 'jazz'], ['古典', 'classical'], ['民谣', 'folk'], ['氛围', 'ambient'], ['Lo-fi', 'lofi'], ['嘻哈', 'hiphop'], ['原声', 'soundtrack']];
views.discover = async (tag) => {
  const h = new Date().getHours();
  const hi = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  let html = `<div class="greet"><h1>${hi}</h1><span class="ta">Jamendo 独立音乐 · Internet Archive 无损录音</span></div>`;
  if (status.jamendo) {
    html += `<div class="chips"><button data-tag="" class="${tag ? '' : 'on'}">本周热门</button>${GENRES.map(([n, t]) => `<button data-tag="${t}" class="${tag === t ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    main.innerHTML = html + skel(8);
    html += `<h2>Jamendo · ${tag ? esc(GENRES.find(g => g[1] === tag)?.[0] || tag) : '编辑精选'}</h2>`;
    try { html += trackRows((await api(`/jamendo/tracks?featured=${tag ? '' : '1'}&tags=${encodeURIComponent(tag || '')}`)).tracks, 'disc'); }
    catch (e) { html += `<div class="empty">Jamendo 暂时连不上：${esc(e.message)}</div>`; }
  } else {
    html += `<div class="panel">填上 Jamendo client_id 后，这里会出现大量可无损播放的独立音乐。<button class="btn sm" onclick="location.hash='settings'">去设置</button></div>`;
  }
  if (tag === 'zh') {
    const ia = await api('/archive/search?zh=1&lossless=0').catch(() => ({ albums: [] }));
    html += `<h2>华语老唱片 · 上海时代曲与戏曲（Internet Archive）</h2>` + albumCards(ia.albums);
  } else {
    const ia = await api('/archive/search?lossless=1').catch(() => ({ albums: [] }));
    html += `<h2>Internet Archive · 无损热门专辑</h2>` + albumCards(ia.albums);
  }
  main.innerHTML = html;
  main.querySelectorAll('.chips button').forEach(b => b.onclick = () => go('discover' + (b.dataset.tag ? '/' + b.dataset.tag : '')));
};
function albumCards(albums) {
  if (!albums.length) return '<div class="empty">没有找到</div>';
  return `<div class="grid">${albums.map(a => `<div class="card" onclick="location.hash='album/${encodeURIComponent(a.id)}'">
    <div class="img" style="background-image:url('${esc(a.cover)}')"></div><div class="t">${esc(a.title)}</div><div class="s">${esc([a.artist, a.year].filter(Boolean).join(' · '))}</div></div>`).join('')}</div>`;
}
views.album = async (id) => {
  const a = await api(`/archive/album/${encodeURIComponent(id)}`);
  main.innerHTML = `<div class="hero"><div class="img" style="background-image:url('${esc(a.cover)}')"></div><div>
    <div class="meta">Internet Archive 专辑${a.year ? ' · ' + esc(a.year) : ''} · ${a.tracks.length} 首</div><h1>${esc(a.title)}</h1><div class="meta">${esc(a.artist)}</div>
    <p>${esc(a.description)}</p><div class="row"><button class="btn primary" id="playAll">${I.play}播放全部</button><a class="btn" href="${esc(a.page)}" target="_blank" rel="noopener">来源页面</a></div></div></div>` + trackRows(a.tracks, 'album');
  $('#playAll').onclick = () => playList(a.tracks, 0);
};

// ---------------- 视图：搜索 ----------------
let searchSrc = 'all', lastQ = '';
views.search = async (q = lastQ) => {
  lastQ = q;
  main.innerHTML = `<h1>搜索</h1><form id="sf" class="search-box">${I.search}<input type="search" id="sq" placeholder="歌名、歌手、风格，如：民谣、古筝、周璇…" value="${esc(q)}" autocomplete="off"></form>
    <div class="tabs"><button data-s="all">全部</button><button data-s="jamendo">Jamendo 单曲</button><button data-s="archive">Archive 专辑</button><button data-s="local">我的曲库</button></div><div id="sr"></div>`;
  const setTab = () => main.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.s === searchSrc));
  setTab();
  main.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { searchSrc = b.dataset.s; setTab(); run(); });
  $('#sf').onsubmit = e => { e.preventDefault(); lastQ = $('#sq').value.trim(); history.replaceState(null, '', '#search/' + encodeURIComponent(lastQ)); run(); };
  async function run() {
    const box = $('#sr'), q = lastQ;
    if (!q) { box.innerHTML = `<div class="empty">试试：<a class="link" href="#search/华语">华语</a>　<a class="link" href="#search/民谣">民谣</a>　<a class="link" href="#search/钢琴">钢琴</a>　<a class="link" href="#search/周璇">周璇</a>　<a class="link" href="#search/Grateful Dead">Grateful Dead</a></div>`; return; }
    box.innerHTML = skel(6);
    try {
      if (searchSrc === 'all') {
        const [j, a, l] = await Promise.all([
          status.jamendo ? api(`/jamendo/tracks?q=${encodeURIComponent(q)}`).catch(() => ({ tracks: [] })) : { tracks: [] },
          api(`/archive/search?q=${encodeURIComponent(q)}&lossless=0`).catch(() => ({ albums: [], total: 0 })),
          api(`/library?q=${encodeURIComponent(q)}`).catch(() => ({ tracks: [] })),
        ]);
        let h = '';
        if (l.tracks.length) h += `<h2>我的曲库</h2>` + trackRows(l.tracks, 'sl');
        if (j.tracks.length) h += `<h2>单曲 · Jamendo</h2>` + trackRows(j.tracks, 'sj');
        if (a.albums.length) h += `<h2>专辑 · Internet Archive（${a.total}）</h2>` + albumCards(a.albums);
        box.innerHTML = h || `<div class="empty">没搜到“${esc(q)}”。这里只收录可合法免费听的音乐，主流华语流行歌（如各大唱片公司的歌手）没有授权，可以试试“华语”“古筝”“民谣”这类风格词，或上传自己的音乐。</div>`;
      } else if (searchSrc === 'jamendo') box.innerHTML = trackRows((await api(`/jamendo/tracks?q=${encodeURIComponent(q)}`)).tracks, 'sj', { empty: '没搜到，换个词或试试 Archive' });
      else if (searchSrc === 'archive') { const d = await api(`/archive/search?q=${encodeURIComponent(q)}&lossless=0`); box.innerHTML = `<div class="ta" style="margin-bottom:10px">共 ${d.total} 个结果</div>` + albumCards(d.albums); }
      else box.innerHTML = trackRows((await api(`/library?q=${encodeURIComponent(q)}`)).tracks, 'sl');
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}${e.code === 'NO_KEY' ? ' <a class="link" href="#settings">去设置</a>' : ''}</div>`; }
  }
  run();
};

// ---------------- 视图：我的曲库 ----------------
views.library = async () => {
  const { tracks, totalBytes } = await api('/library');
  main.innerHTML = `<h1>我的曲库</h1>
    <label class="drop" id="drop">${I.upload}把 FLAC / MP3 等音乐文件拖到这里，或 <span class="link">点击选择</span>（可多选）<input type="file" id="files" multiple accept=".flac,.mp3,.m4a,.aac,.ogg,.opus,.wav,audio/*" hidden><div id="up"></div></label>
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="ta">${tracks.length} 首 · ${fmtSize(totalBytes)}</span>${tracks.length ? `<button class="btn primary sm" id="playLib">${I.play}播放全部</button>` : ''}</div>` + trackRows(tracks, 'lib', { empty: '还没有文件，上传几首吧' });
  $('#playLib') && ($('#playLib').onclick = () => playList(tracks, 0));
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
  $('#files').onchange = e => upload([...e.target.files]);
};
async function upload(files) {
  const up = $('#up');
  for (const [i, f] of files.entries()) {
    up.innerHTML = `<div style="margin-top:10px">上传 ${i + 1}/${files.length}：${esc(f.name)}<div class="prog"><i id="pb"></i></div></div>`;
    await new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/library/upload?name=${encodeURIComponent(f.name)}`);
      x.upload.onprogress = e => { if (e.lengthComputable) $('#pb').style.width = (e.loaded / e.total * 100) + '%'; };
      x.onload = () => { if (x.status >= 300) toast(`${f.name}：${(JSON.parse(x.responseText || '{}').error) || '上传失败'}`); resolve(); };
      x.onerror = () => { toast(`${f.name} 上传失败`); resolve(); };
      x.send(f);
    });
  }
  toast('上传完成'); go('library');
}

// ---------------- 视图：歌单 ----------------
views.playlists = async (id) => {
  if (id) {
    const p = await api(`/playlists/${id}`);
    main.innerHTML = `<h1>${esc(p.name)}</h1><div class="row" style="margin-bottom:12px">${p.tracks.length ? `<button class="btn primary" id="pa">${I.play}播放全部</button>` : ''}
      ${p.id !== 1 ? '<button class="btn sm" id="pr">重命名</button><button class="btn sm" id="pd">删除歌单</button>' : ''}</div>` + trackRows(p.tracks, 'pl' + p.id);
    $('#pa') && ($('#pa').onclick = () => playList(p.tracks, 0));
    $('#pr') && ($('#pr').onclick = async () => { const n = prompt('新名字', p.name); if (n) { await api(`/playlists/${id}`, { method: 'PATCH', body: { name: n } }); go('playlists/' + id); } });
    $('#pd') && ($('#pd').onclick = async () => { if (confirm('删除这个歌单？')) { await api(`/playlists/${id}`, { method: 'DELETE' }); go('playlists'); } });
    return;
  }
  const { playlists } = await api('/playlists');
  main.innerHTML = `<h1>歌单</h1><div class="row" style="margin-bottom:14px"><button class="btn" id="np">${I.plus}新建歌单</button></div>
    <div class="grid">${playlists.map(p => `<div class="card" onclick="location.hash='playlists/${p.id}'"><div class="img glyph" style="background:linear-gradient(135deg,${p.id === 1 ? '#ff6b8b,#7a2a4a' : ['#2b5876,#4e4376', '#134e5e,#71b280', '#614385,#516395', '#c06c84,#355c7d'][p.id % 4]});display:grid;place-items:center;font-size:44px;color:rgba(255,255,255,.85)">${p.id === 1 ? '♥' : '♪'}</div><div class="t">${esc(p.name)}</div><div class="s">${p.count} 首</div></div>`).join('')}</div>`;
  $('#np').onclick = async () => { const name = prompt('歌单名'); if (name) { await api('/playlists', { method: 'POST', body: { name } }); go('playlists'); } };
};

// ---------------- 视图：设置 ----------------
views.settings = async () => {
  const s = await api('/settings');
  main.innerHTML = `<h1>设置</h1>
    <div class="panel"><b>Jamendo 曲库</b><p class="ta">到 <a class="link" href="https://devportal.jamendo.com" target="_blank" rel="noopener">devportal.jamendo.com</a> 免费注册，创建一个应用，把 Client ID 填在这里。仅限个人非商业使用。</p>
      <label>Client ID ${s.jamendo_client_id ? `（当前：${esc(s.jamendo_client_id)}${s.jamendo_from_env ? '，来自环境变量' : ''}）` : '（未设置）'}</label>
      <div class="row"><input type="text" id="jk" placeholder="粘贴 Client ID" style="flex:1"><button class="btn primary" id="jkSave">保存</button></div></div>
    <div class="panel"><b>音质</b><p class="ta">优先播放：<label style="display:inline"><input type="radio" name="q" value="flac" ${pref === 'flac' ? 'checked' : ''}> FLAC 无损</label>　<label style="display:inline"><input type="radio" name="q" value="mp3" ${pref === 'mp3' ? 'checked' : ''}> MP3（省流量）</label></p></div>
    <div class="panel"><b>修改密码</b><label>原密码</label><input type="password" id="op"><label>新密码</label><input type="password" id="nw"><div class="row" style="margin-top:10px"><button class="btn" id="pwSave">修改</button><button class="btn" id="logout">退出登录</button></div></div>
    <p class="ta">清音只接入 Jamendo、Internet Archive 等正版免费曲库，以及你自己上传的文件。</p>`;
  $('#jkSave').onclick = async () => { await api('/settings', { method: 'POST', body: { jamendo_client_id: $('#jk').value } }); status = await api('/status'); toast('已保存'); go('settings'); };
  main.querySelectorAll('input[name=q]').forEach(r => r.onchange = () => { pref = r.value; localStorage.qyQ = pref; toast(pref === 'flac' ? '优先无损' : '优先 MP3'); });
  $('#pwSave').onclick = async () => { try { await api('/settings', { method: 'POST', body: { old_password: $('#op').value, new_password: $('#nw').value } }); toast('密码已修改'); } catch (e) { toast(e.message); } };
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); location.reload(); };
};

// ---------------- 播放器 ----------------
let queue = [], qi = -1, cur = null, pref = localStorage.qyQ || 'flac', curQ = null;
let shuffle = localStorage.qyShuffle === '1', repeat = localStorage.qyRepeat || 'all'; // all | one | off
audio.volume = Number(localStorage.qyVol ?? 0.9); $('#pVol').value = audio.volume * 100;

function pickStream(t, prefer) {
  const s = t.streams || {};
  if (prefer === 'flac' && s.flac) return ['flac', s.flac];
  if (s.mp3) return ['mp3', s.mp3];
  if (s.flac) return ['flac', s.flac];
  return [null, null];
}
function playList(list, i) { queue = list.slice(); qi = i; load(true); renderQueue(); }
function load(autoplay, prefer = pref) {
  cur = queue[qi]; if (!cur) return;
  const [q, url] = pickStream(cur, prefer);
  if (!url) { toast('这首没有可播放的音源'); return next(); }
  curQ = q; audio.src = url;
  if (autoplay) audio.play().catch(() => {});
  $('#pTitle').textContent = cur.title; $('#pArtist').textContent = [cur.artist, cur.album].filter(Boolean).join(' · ');
  $('#pCover').style.backgroundImage = cur.cover ? `url('${cur.cover}')` : '';
  const amb = $('#amb'); amb.classList.toggle('img', !!cur.cover); amb.style.backgroundImage = cur.cover ? `url('${cur.cover}')` : '';
  const qb = $('#pQual'); qb.textContent = q === 'flac' ? (cur.bitDepth ? `FLAC ${cur.bitDepth}bit` : 'FLAC 无损') : 'MP3'; qb.classList.toggle('hi', q === 'flac');
  document.title = `${cur.title} · 清音`;
  syncLike(); markPlaying();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: cur.artist, album: cur.album, artwork: cur.cover ? [{ src: cur.cover, sizes: '300x300' }] : [] });
  }
}
function markPlaying() { document.querySelectorAll('.tr[data-list]').forEach(r => { const t = lists[r.dataset.list]?.[r.dataset.i]; r.classList.toggle('playing', !!(t && cur && keyOf(t) === keyOf(cur))); }); renderQueue(); }
function syncLike() { const on = cur && liked.has(keyOf(cur)); $('#pLike').classList.toggle('on', !!on); }
function next(manual = true) {
  if (!queue.length) return;
  if (!manual && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (shuffle && queue.length > 1) { let n; do n = Math.floor(Math.random() * queue.length); while (n === qi); qi = n; }
  else if (qi + 1 < queue.length) qi++;
  else if (repeat === 'all' || manual) qi = 0;
  else { audio.pause(); return; }
  load(true);
}
function prev() { if (audio.currentTime > 4) { audio.currentTime = 0; return; } if (!queue.length) return; qi = (qi - 1 + queue.length) % queue.length; load(true); }
function toggle() { if (!cur) return; audio.paused ? audio.play() : audio.pause(); }

audio.onplay = () => { $('#pPlay').innerHTML = I.pause; document.body.classList.remove('paused'); };
audio.onpause = () => { $('#pPlay').innerHTML = I.play; document.body.classList.add('paused'); };
audio.onended = () => next(false);
audio.onerror = () => {
  if (!cur) return;
  if (curQ === 'flac' && cur.streams?.mp3) { toast('无损音源加载失败，切到 MP3'); const t = audio.currentTime; load(true, 'mp3'); audio.currentTime = t; }
  else { toast('播放失败，跳到下一首'); setTimeout(() => next(false), 800); }
};
let seeking = false;
audio.ontimeupdate = () => {
  if (seeking) return;
  const d = audio.duration || cur?.duration || 0;
  $('#pCur').textContent = fmtT(audio.currentTime); $('#pDur').textContent = fmtT(d);
  $('#pSeek').value = d ? audio.currentTime / d * 1000 : 0; setFill($('#pSeek'));
};
$('#pSeek').oninput = () => { seeking = true; setFill($('#pSeek')); const d = audio.duration || 0; $('#pCur').textContent = fmtT($('#pSeek').value / 1000 * d); };
$('#pSeek').onchange = () => { const d = audio.duration || 0; if (d) audio.currentTime = $('#pSeek').value / 1000 * d; seeking = false; };
$('#pPlay').onclick = toggle; $('#pNext').onclick = () => next(); $('#pPrev').onclick = prev;
$('#pVol').oninput = e => { setFill(e.target); audio.volume = e.target.value / 100; localStorage.qyVol = audio.volume; };
$('#pLike').onclick = () => cur && toggleLike(cur).then(() => markPlaying());
$('#pQual').onclick = () => {
  if (!cur) return;
  const want = curQ === 'flac' ? 'mp3' : 'flac';
  if (!cur.streams?.[want]) return toast(want === 'flac' ? '这首没有无损音源' : '这首只有无损音源');
  const t = audio.currentTime, playing = !audio.paused; load(playing, want); audio.currentTime = t;
};
const syncModes = () => { $('#pShuffle').classList.toggle('on', shuffle); $('#pRepeat').classList.toggle('on', repeat !== 'off'); $('#pRepeat').classList.toggle('one', repeat === 'one'); };
$('#pShuffle').onclick = () => { shuffle = !shuffle; localStorage.qyShuffle = shuffle ? '1' : '0'; syncModes(); };
$('#pRepeat').onclick = () => { repeat = { all: 'one', one: 'off', off: 'all' }[repeat]; localStorage.qyRepeat = repeat; syncModes(); toast({ all: '列表循环', one: '单曲循环', off: '不循环' }[repeat]); };
syncModes();
// 播放栏图标
$('#pPlay').innerHTML = I.play; $('#pPrev').innerHTML = I.prev; $('#pNext').innerHTML = I.next;
$('#pShuffle').innerHTML = I.shuffle; $('#pRepeat').innerHTML = I.repeat; $('#pLike').innerHTML = I.heart; $('#pQueue').innerHTML = I.queue;
document.body.classList.add('paused'); setFill($('#pVol')); setFill($('#pSeek'));
// 手机上点正在播放的歌名打开队列
$('.np-text').onclick = () => { if (matchMedia('(max-width:760px)').matches) $('#queue').classList.toggle('hidden'); };
$('#pQueue').onclick = () => $('#queue').classList.toggle('hidden');
$('#qClear').onclick = () => { queue = cur ? [cur] : []; qi = cur ? 0 : -1; renderQueue(); };
function renderQueue() {
  $('#qList').innerHTML = queue.length ? queue.map((t, i) => `<div class="tr ${i === qi ? 'playing' : ''}" data-q="${i}"><div style="min-width:0"><div class="tt">${esc(t.title)}</div><div class="ta">${esc(t.artist)}</div></div><button class="icon" data-rm="${i}">${I.x}</button></div>`).join('') : '<div class="empty">队列是空的</div>';
}
$('#qList').onclick = e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { const i = Number(rm.dataset.rm); queue.splice(i, 1); if (i < qi) qi--; else if (i === qi) { qi = Math.min(qi, queue.length - 1); if (queue.length) load(!audio.paused); else { audio.pause(); cur = null; } } renderQueue(); return; }
  const row = e.target.closest('[data-q]'); if (row) { qi = Number(row.dataset.q); load(true); }
};
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) next();
  else if (e.code === 'ArrowLeft' && e.shiftKey) prev();
  else if (e.code === 'ArrowRight') audio.currentTime += 10;
  else if (e.code === 'ArrowLeft') audio.currentTime -= 10;
});
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'discover'));

boot().catch(e => { document.body.innerHTML = `<div class="empty">启动失败：${esc(e.message)}</div>`; });
