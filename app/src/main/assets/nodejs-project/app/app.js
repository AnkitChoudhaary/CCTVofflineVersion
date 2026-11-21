'use strict';
const $ = s => document.querySelector(s);
const api = (p, q = {}) => fetch(p + '?' + new URLSearchParams(q)).then(r => r.json());
const fmt = s => { s = Math.max(0, s | 0); return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0'); };

const V = $('#src');
const state = {
  ip: '', day: '', idx: -1, layout: 'both', maxFrames: 0, segments: [], curSeg: null, seekAfterLoad: null,
  lens: { top: { zoom: 1, panX: 0, panY: 0, rot: 0 }, bottom: { zoom: 1, panX: 0, panY: 0, rot: 0 } },
};

// ---------- persisted view preferences (rotation + layout) — restored on next launch, applies in fullscreen too ----------
const PREFS_KEY = 'v380.viewPrefs';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.layout) state.layout = p.layout;
    for (const k of ['top', 'bottom']) if (p.rot && typeof p.rot[k] === 'number') state.lens[k].rot = ((p.rot[k] % 360) + 360) % 360;
  } catch {}
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ layout: state.layout, rot: { top: state.lens.top.rot, bottom: state.lens.bottom.rot } })); } catch {}
}
function rotateLens(k) { state.lens[k].rot = (state.lens[k].rot + 90) % 360; state.lens[k].panX = state.lens[k].panY = 0; savePrefs(); }
const canvases = { top: $('#lensTop canvas'), bottom: $('#lensBottom canvas') };
const zlabel = { top: $('#lensTop .z'), bottom: $('#lensBottom .z') };

function setStatus(t, cls) { const s = $('#status'); s.textContent = t; s.style.color = cls === 'err' ? '#e05a5a' : cls === 'ok' ? 'var(--ok)' : 'var(--mut)'; }

// ---------- discovery / browsing ----------
async function rescan() {
  setStatus('scanning hotspot…');
  const { cameras } = await api('/api/discover');
  const sel = $('#cams'); sel.innerHTML = '';
  if (!cameras.length) { sel.innerHTML = '<option value="">none found</option>'; $('#camPill').textContent = 'no camera'; setStatus('no camera found', 'err'); return; }
  for (const c of cameras) { const o = document.createElement('option'); o.value = c.ip; o.textContent = `${c.ip}  (${c.mac || 'cam'})`; sel.appendChild(o); }
  sel.value = cameras[0].ip; await selectCamera(cameras[0].ip);
}
async function selectCamera(ip) {
  state.ip = ip; $('#camPill').textContent = ip; setStatus('connecting…');
  const r = await api('/api/days', { ip });
  if (r.error) { setStatus('auth/connect failed: ' + r.error, 'err'); return; }
  setStatus(`connected · LAN pass ${r.origin === 1 ? 'factory' : 'set'}`, 'ok');
  const days = $('#days'); days.innerHTML = '';
  if (!r.days.length) { days.innerHTML = '<option value="">no recordings</option>'; $('#segs').innerHTML = ''; return; }
  for (const d of r.days.sort().reverse()) { const o = document.createElement('option'); o.value = d; o.textContent = d; days.appendChild(o); }
  days.value = r.days.sort().reverse()[0]; await selectDay(days.value);
}
async function selectDay(day) {
  state.day = day; setStatus('loading recordings…');
  const r = await api('/api/segments', { ip: state.ip, day });
  state.segments = r.segments;
  const box = $('#segs'); box.innerHTML = '';
  for (const s of r.segments) {
    const row = document.createElement('div'); row.className = 'segrow'; row.dataset.idx = s.idx;
    const time = new Date(s.startMs).toLocaleTimeString();
    row.innerHTML = `<span class="t ${s.type}"></span><div class="meta"><div class="time">${time}</div><div class="sub">${s.durationS}s · ${s.type}</div></div>`;
    row.onclick = () => playSegment(s.idx, row);
    box.appendChild(row);
  }
  renderTimeline();
  setStatus(`${r.segments.length} recordings on ${day}`, 'ok');
}

// ---------- day timeline (local time-of-day) ----------
const secOfDay = ms => { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
function renderTimeline() {
  const ticks = $('#tlticks'), blocks = $('#tlblocks');
  ticks.innerHTML = ''; blocks.innerHTML = '';
  for (let h = 0; h <= 24; h += 2) { const x = h / 24 * 100; const t = document.createElement('div'); t.className = 'tick'; t.style.left = x + '%'; ticks.appendChild(t); if (h < 24) { const l = document.createElement('div'); l.className = 'tl'; l.style.left = x + '%'; l.textContent = h; ticks.appendChild(l); } }
  for (const s of (state.segments || [])) {
    const x0 = secOfDay(s.startMs) / 86400 * 100, w = Math.max(0.15, s.durationS / 86400 * 100);
    const b = document.createElement('div'); b.className = 'blk ' + s.type; b.style.left = x0 + '%'; b.style.width = w + '%';
    b.title = new Date(s.startMs).toLocaleTimeString() + ' · ' + s.durationS + 's · ' + s.type;
    b.onclick = e => { e.stopPropagation(); playSegment(s.idx, [...document.querySelectorAll('.segrow')][s.idx]); };
    blocks.appendChild(b);
  }
}
function updatePlayhead() {
  const head = $('#tlhead');
  if (!state.curSeg || !V.duration) { head.classList.add('hide'); return; }
  const sec = secOfDay(state.curSeg.startMs) + V.currentTime;
  head.style.left = (sec / 86400 * 100) + '%'; head.classList.remove('hide');
}
$('#timeline').addEventListener('mousemove', e => {
  const r = $('#timeline').getBoundingClientRect(); const frac = (e.clientX - r.left) / r.width;
  const sec = frac * 86400, hh = sec / 3600 | 0, mm = (sec % 3600) / 60 | 0;
  const tip = $('#tltip'); tip.classList.remove('hide'); tip.style.left = (frac * 100) + '%'; tip.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
});
$('#timeline').addEventListener('mouseleave', () => $('#tltip').classList.add('hide'));
$('#timeline').addEventListener('click', e => {
  const r = $('#timeline').getBoundingClientRect(); const sec = (e.clientX - r.left) / r.width * 86400;
  const segs = state.segments || [];
  let best = null;
  for (const s of segs) { const a = secOfDay(s.startMs), b = a + s.durationS; if (sec >= a && sec <= b) { best = { s, off: sec - a }; break; } }
  if (!best) { // nearest upcoming
    let min = 1e9; for (const s of segs) { const d = Math.abs(secOfDay(s.startMs) - sec); if (d < min) { min = d; best = { s, off: 0 }; } }
  }
  if (best) { state.seekAfterLoad = best.off; playSegment(best.s.idx, [...document.querySelectorAll('.segrow')][best.s.idx]); }
});

// ---------- live view (MSE + fMP4) ----------
let liveCtl = null;
// translucent on-lens pan/tilt pad (bottom/motorised lens) — shown LIVE only, in normal + fullscreen
function updateLensPtz() { const el = document.querySelector('#lensPtz'); if (el) el.classList.toggle('hide', !liveCtl); }
function stopLive() { if (liveCtl) { liveCtl.abort?.(); liveCtl = null; } $('#liveBadge').classList.add('hide'); const lb = $('#live'); lb.classList.remove('on'); lb.textContent = '● Start live'; updateLensPtz(); syncFsIcons(); }
async function startLive() {
  if (!state.ip) { setStatus('connect to a camera first', 'err'); return; }
  const wasLive = !!liveCtl;
  stopLive(); setTab('live'); document.querySelectorAll('.segrow').forEach(r => r.classList.remove('on'));
  resetZoom(); $('#load').classList.remove('hide'); $('#loadtxt').textContent = 'Connecting to live stream…';
  setStatus('starting live…'); $('#liveBadge').classList.remove('hide'); const lb = $('#live'); lb.classList.add('on'); lb.textContent = '■ Stop live';
  const ac = new AbortController(); liveCtl = ac; updateLensPtz();
  const ms = new MediaSource(); V.src = URL.createObjectURL(ms);
  await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
  const codec = state.hd ? 'video/mp4; codecs="avc1.640033,mp4a.40.2"' : 'video/mp4; codecs="avc1.64001f,mp4a.40.2"';
  let sb;
  try { sb = ms.addSourceBuffer(codec); }
  catch (e) { setStatus('live codec unsupported: ' + e.message, 'err'); return; }
  sb.mode = 'sequence';
  const queue = [];
  const pump = () => { if (!queue.length || sb.updating) return; try { sb.appendBuffer(queue.shift()); } catch (e) { /* QuotaExceeded: drop old */ if (e.name === 'QuotaExceededError' && V.buffered.length) { try { sb.remove(0, V.currentTime - 2); } catch {} } } };
  sb.addEventListener('updateend', () => { pump(); trimBuffer(sb); });
  function trimBuffer(sb) { try { if (V.buffered.length && V.currentTime - V.buffered.start(0) > 20) sb.remove(0, V.currentTime - 10); } catch {} }
  V.muted = true; V.play().catch(() => {});
  try {
    const res = await fetch('/api/live?ip=' + encodeURIComponent(state.ip) + '&hd=' + (state.hd ? 1 : 0), { signal: ac.signal });
    const reader = res.body.getReader();
    $('#load').classList.add('hide'); setStatus('live', 'ok');
    while (true) { const { done, value } = await reader.read(); if (done || ac.signal.aborted) break; queue.push(value); pump();
      // keep playhead near the live edge
      if (V.buffered.length && V.readyState >= 2) { const end = V.buffered.end(V.buffered.length - 1); if (end - V.currentTime > 1.2) V.currentTime = end - 0.3; }
    }
  } catch (e) { if (!ac.signal.aborted) setStatus('live ended: ' + e.message, 'err'); }
  $('#load').classList.add('hide');
}

// ---------- playback ----------
function playSegment(idx, row) {
  stopLive(); setTab('rec');
  state.idx = idx; state.curSeg = (state.segments || [])[idx] || null;
  document.querySelectorAll('.segrow').forEach(r => r.classList.toggle('on', r === row));
  if (row) row.scrollIntoView({ block: 'nearest' });
  resetZoom();
  const dur = state.curSeg ? state.curSeg.durationS : 0;
  $('#load').classList.remove('hide'); $('#loadtxt').textContent = `Fetching & decoding ${dur}s recording from the camera…`;
  $('#clipname').textContent = state.curSeg ? new Date(state.curSeg.startMs).toLocaleTimeString() : '';
  setStatus('retrieving recording…');
  V.src = '/api/clip?' + new URLSearchParams({ ip: state.ip, day: state.day, idx, max: state.maxFrames });
  V.load(); V.play().catch(() => {});
}
function playNext() { const segs = state.segments || []; if (state.idx >= 0 && state.idx + 1 < segs.length) playSegment(state.idx + 1, [...document.querySelectorAll('.segrow')][state.idx + 1]); }
V.addEventListener('ended', () => { if (state.curSeg) playNext(); });
V.addEventListener('loadedmetadata', () => { $('#vinfo').textContent = `${V.videoWidth}×${V.videoHeight} · 2 lenses · ${V.duration.toFixed(0)}s`; sizeCanvases(); });
V.addEventListener('canplay', () => { $('#load').classList.add('hide'); setStatus('playing', 'ok'); if (state.seekAfterLoad != null) { try { V.currentTime = Math.min(state.seekAfterLoad, (V.duration || 1) - 0.1); } catch {} state.seekAfterLoad = null; } });
V.addEventListener('error', () => { $('#load').classList.add('hide'); setStatus('playback error', 'err'); });
V.addEventListener('timeupdate', () => { $('#tcur').textContent = fmt(V.currentTime); $('#tdur').textContent = fmt(V.duration || 0); if (!seeking) $('#seek').value = (V.duration ? V.currentTime / V.duration * 1000 : 0); updatePlayhead(); });
V.addEventListener('play', () => { $('#play').textContent = '⏸'; $('#fsPlay').textContent = '⏸'; }); V.addEventListener('pause', () => { $('#play').textContent = '▶'; $('#fsPlay').textContent = '▶'; });

// ---------- dual-lens canvas rendering ----------
function sizeCanvases() {
  for (const k of ['top', 'bottom']) {
    const cvs = canvases[k], box = cvs.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = Math.max(8, box.width * dpr | 0); cvs.height = Math.max(8, box.height * dpr | 0);
    cvs.style.width = box.width + 'px'; cvs.style.height = box.height + 'px';
  }
}
function drawLens(k) {
  const cvs = canvases[k], ctx = cvs.getContext('2d'); const st = state.lens[k];
  const cw = cvs.width, ch = cvs.height; ctx.clearRect(0, 0, cw, ch);
  if (!V.videoWidth) return;
  const lw = V.videoWidth, lh = V.videoHeight / 2, srcY = k === 'top' ? 0 : lh;
  const rot = ((st.rot % 360) + 360) % 360, swap = rot % 180 !== 0;
  // fit the ROTATED bounding box into the canvas
  const fitW = swap ? lh : lw, fitH = swap ? lw : lh;
  const base = Math.min(cw / fitW, ch / fitH), scale = base * st.zoom;
  const dw = lw * scale, dh = lh * scale;                 // image size in its own (pre-rotation) axes
  const bbW = swap ? dh : dw, bbH = swap ? dw : dh;        // on-screen bounding box after rotation
  // clamp pan so edges don't cross the center-fit bounds when zoomed
  const maxPanX = Math.max(0, (bbW - cw) / 2), maxPanY = Math.max(0, (bbH - ch) / 2);
  st.panX = Math.max(-maxPanX, Math.min(maxPanX, st.panX));
  st.panY = Math.max(-maxPanY, Math.min(maxPanY, st.panY));
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(cw / 2 + st.panX, ch / 2 + st.panY);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(V, 0, srcY, lw, lh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  zlabel[k].textContent = st.zoom.toFixed(1) + '×' + (rot ? ' · ' + rot + '°' : '');
}
function render() { if (state.layout !== 'bottom') drawLens('top'); if (state.layout !== 'top') drawLens('bottom'); requestAnimationFrame(render); }
requestAnimationFrame(render);

// ---------- zoom / pan ----------
function bindZoom(k) {
  const cvs = canvases[k], st = state.lens[k];
  cvs.addEventListener('wheel', e => { e.preventDefault(); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; st.zoom = Math.max(1, Math.min(8, st.zoom * f)); if (st.zoom === 1) { st.panX = st.panY = 0; } }, { passive: false });
  let drag = null;
  cvs.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; cvs.setPointerCapture(e.pointerId); });
  cvs.addEventListener('pointermove', e => { if (!drag) return; const dpr = Math.min(2, window.devicePixelRatio || 1); st.panX += (e.clientX - drag.x) * dpr; st.panY += (e.clientY - drag.y) * dpr; drag = { x: e.clientX, y: e.clientY }; });
  cvs.addEventListener('pointerup', () => drag = null); cvs.addEventListener('pointercancel', () => drag = null);
  cvs.addEventListener('dblclick', () => { st.zoom = st.zoom > 1 ? 1 : 2.5; if (st.zoom === 1) st.panX = st.panY = 0; });
}
bindZoom('top'); bindZoom('bottom');
function resetZoom() { for (const k of ['top', 'bottom']) { state.lens[k].zoom = 1; state.lens[k].panX = state.lens[k].panY = 0; } }

// ---------- layout ----------
function setLayout(l) {
  state.layout = l;
  document.querySelectorAll('#layout button').forEach(b => b.classList.toggle('on', b.dataset.l === l));
  $('#lensTop').classList.toggle('hide', l === 'bottom');
  $('#lensBottom').classList.toggle('hide', l === 'top');
  setTimeout(sizeCanvases, 0);
  savePrefs();
}

// ---------- tabs (Live view / Recordings) ----------
function setTab(t) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#panel-live').classList.toggle('hide', t !== 'live');
  $('#panel-rec').classList.toggle('hide', t !== 'rec');
  setTimeout(sizeCanvases, 0);
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));

// ---------- controls & wiring ----------
$('#live').onclick = () => { if (liveCtl) stopLive(); else startLive(); };
state.hd = false;
document.querySelectorAll('#quality button').forEach(b => b.onclick = () => { document.querySelectorAll('#quality button').forEach(x => x.classList.toggle('on', x === b)); state.hd = b.dataset.q === 'hd'; if (liveCtl) startLive(); });
$('#rescan').onclick = rescan;
{ const ab = document.querySelector('#addCam'); if (ab) ab.onclick = () => {
  if (window.AndroidSetup && window.AndroidSetup.startBleSetup) AndroidSetup.startBleSetup();
  else setStatus('Bluetooth camera setup is available in the Android app only.', 'err');
}; }
$('#cams').onchange = e => selectCamera(e.target.value);
$('#days').onchange = e => selectDay(e.target.value);
document.querySelectorAll('#layout button').forEach(b => b.onclick = () => setLayout(b.dataset.l));
document.querySelectorAll('.lens .rot').forEach(btn => btn.onclick = e => { e.stopPropagation(); rotateLens(btn.dataset.k); });
// share URL (other devices on the same network) — prefer the server address on the camera's own subnet
(async () => {
  try {
    const info = await api('/api/serverinfo');
    const urls = (info.urls && info.urls.length) ? info.urls : [location.origin];
    const pick = () => { const net = (state.ip || '').split('.').slice(0, 3).join('.'); return (net && urls.find(u => u.includes('://' + net + '.'))) || urls[0]; };
    const el = $('#share');
    if (el) {
      el.title = 'Open on any device on the same Wi-Fi/hotspot:\n' + urls.join('\n') + '\n(click to copy the one for this camera network)';
      el.onclick = async () => { const url = pick(); try { await navigator.clipboard.writeText(url); el.textContent = 'copied ✓'; setTimeout(() => el.textContent = 'share ↗', 1200); } catch { setStatus('Open on another device: ' + url, 'ok'); } };
    }
  } catch {}
})();
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => { document.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b)); if (b.dataset.m === 'server') setStatus('Server (cloud) mode is not wired yet — uses the vendor relay; local mode is fully working.', 'err'); else setStatus('local mode', 'ok'); });
$('#resetZoom').onclick = resetZoom;
$('#play').onclick = () => V.paused ? V.play() : V.pause();
$('#mute').onclick = () => { V.muted = !V.muted; $('#mute').textContent = V.muted ? '🔇' : '🔊'; $('#fsMute').textContent = V.muted ? '🔇' : '🔊'; };
function nativeFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function inFullscreen() { return nativeFs() || document.body.classList.contains('cssfs'); }
function exitFs() {
  if (nativeFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
  if (document.body.classList.contains('cssfs')) { document.body.classList.remove('cssfs'); toggleFsOverlay(); }
}
function enterFs() {
  const el = $('#view');
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  // If native fullscreen didn't actually engage shortly after (WebView without/with a broken
  // Fullscreen API, or no user-gesture), fall back to a CSS-maximised view.
  setTimeout(() => { if (!nativeFs() && !document.body.classList.contains('cssfs')) { document.body.classList.add('cssfs'); toggleFsOverlay(); } }, 300);
}
$('#fs').onclick = () => { if (inFullscreen()) exitFs(); else enterFs(); };
let seeking = false;
$('#seek').addEventListener('input', () => { seeking = true; if (V.duration) { $('#tcur').textContent = fmt(V.duration * $('#seek').value / 1000); } });
$('#seek').addEventListener('change', () => { if (V.duration) V.currentTime = V.duration * $('#seek').value / 1000; seeking = false; });
window.addEventListener('resize', sizeCanvases);
document.addEventListener('fullscreenchange', () => { toggleFsOverlay(); setTimeout(sizeCanvases, 50); });
document.addEventListener('webkitfullscreenchange', () => { toggleFsOverlay(); setTimeout(sizeCanvases, 50); });
// ---------- camera controls drawer (settings + PTZ) ----------
const drawer = $('#drawer');
$('#ctrlBtn').onclick = () => { if (!state.ip) { setStatus('connect to a camera first', 'err'); return; } if (drawer.classList.contains('hide')) { drawer.classList.remove('hide'); loadSettings(); } else drawer.classList.add('hide'); };
$('#ctrlClose').onclick = () => drawer.classList.add('hide');

async function setProp(key, value) { const r = await api('/api/setprop', { ip: state.ip, key, value }); if (!r.ok) setStatus('setting failed (code ' + r.result + ')', 'err'); else setStatus('saved', 'ok'); return r; }

async function loadSettings() {
  const host = $('#settingsHost'); host.innerHTML = '<div class="note">Reading from camera…</div>';
  let r; try { r = await api('/api/settings', { ip: state.ip }); } catch { host.innerHTML = '<div class="note">Could not read settings.</div>'; return; }
  const items = r.items || [];
  if (!items.length) { host.innerHTML = '<div class="note">No adjustable settings reported by this camera.</div>'; return; }
  const bySect = {}; for (const it of items) (bySect[it.sect] = bySect[it.sect] || []).push(it);
  host.innerHTML = '';
  for (const [sect, list] of Object.entries(bySect)) {
    const sec = document.createElement('div'); sec.className = 'dsect';
    const h = document.createElement('h3'); h.textContent = sect; sec.appendChild(h);
    for (const it of list) {
      const row = document.createElement('div'); row.className = 'ctrlrow';
      const lab = document.createElement('label'); lab.textContent = it.label; row.appendChild(lab);
      if (it.kind === 'bool') {
        const sw = document.createElement('div'); sw.className = 'switch' + (it.value ? ' on' : ''); sw.innerHTML = '<i></i>';
        sw.onclick = async () => { const nv = !sw.classList.contains('on'); const rr = await setProp(it.key, nv ? 1 : 0); if (rr.ok) sw.classList.toggle('on', nv); };
        row.appendChild(sw);
      } else if (it.kind === 'enum') {
        const sel = document.createElement('select');
        const opts = it.options || {};
        if (!(String(it.value) in opts)) { const o = document.createElement('option'); o.value = it.value; o.textContent = 'Current (' + it.value + ')'; o.selected = true; sel.appendChild(o); }
        for (const [v, label] of Object.entries(opts)) { const o = document.createElement('option'); o.value = v; o.textContent = label; if (+v === +it.value) o.selected = true; sel.appendChild(o); }
        sel.onchange = () => setProp(it.key, sel.value);
        row.appendChild(sel);
      } else { // int / objset -> slider
        const rng = document.createElement('input'); rng.type = 'range'; rng.min = it.min ?? 0; rng.max = it.max ?? 100; rng.value = it.value;
        const val = document.createElement('span'); val.className = 'val'; val.textContent = it.value;
        rng.oninput = () => val.textContent = rng.value;
        rng.onchange = () => setProp(it.key, rng.value);
        row.appendChild(rng); row.appendChild(val);
      }
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }
}
// PTZ actions
const ptz = (cmd, extra = {}) => api('/api/ptz', { ip: state.ip, cmd, ...extra });
const ptzHomeFn = async () => { setStatus('PTZ: moving to home…'); const r = await ptz('home'); setStatus(r.result === 1000 ? 'PTZ: at home position' : 'PTZ home failed (' + (r.result ?? r.error) + ')', r.result === 1000 ? 'ok' : 'err'); };
document.querySelectorAll('#ptzHome, [data-fshome]').forEach(b => b.onclick = ptzHomeFn);
$('#ptzRecal').onclick = async () => { if (!confirm('Recalibrate the pan/tilt motor? The camera will sweep its full range.')) return; setStatus('PTZ: recalibrating…'); const r = await ptz('recal'); setStatus(r.result === 1000 ? 'PTZ: recalibrating' : 'PTZ recal failed', r.result === 1000 ? 'ok' : 'err'); };
// hold a direction to move; the camera steps once per packet, so resend while held, then send stop on release.
// binds every direction button — the drawer pad AND the fullscreen on-video pad.
document.querySelectorAll('[data-dir]').forEach(b => {
  let timer = null;
  const stop = () => { if (!timer) return; clearInterval(timer); timer = null; ptz('move', { dir: 'stop' }); setStatus('PTZ: stopped', 'ok'); };
  const start = e => { e.preventDefault(); if (timer) return; const dir = b.dataset.dir; ptz('move', { dir }); setStatus('PTZ: ' + dir + '…'); timer = setInterval(() => ptz('move', { dir }), 350); };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
});
// fullscreen on-video controls (translucent; shown only while in fullscreen)
const syncFsIcons = () => { $('#fsPlay').textContent = V.paused ? '▶' : '⏸'; $('#fsMute').textContent = V.muted ? '🔇' : '🔊'; $('#fsLive').classList.toggle('on', !!liveCtl); };
function toggleFsOverlay() { $('#fsctrl').classList.toggle('hide', !inFullscreen()); syncFsIcons(); }
$('#fsPlay').onclick = () => { if (liveCtl) return; V.paused ? V.play() : V.pause(); };
$('#fsMute').onclick = () => { $('#mute').click(); };
$('#fsRotT').onclick = () => rotateLens('top');
$('#fsRotB').onclick = () => rotateLens('bottom');
$('#fsLive').onclick = () => { startLive(); setTimeout(syncFsIcons, 150); };
$('#fsExit').onclick = () => exitFs();

V.muted = true;
loadPrefs(); setLayout(state.layout);   // restore last-used rotation + layout (also used in fullscreen)
window.__app = { state, renderTimeline, playSegment, selectDay, rotateLens, savePrefs };
rescan();
