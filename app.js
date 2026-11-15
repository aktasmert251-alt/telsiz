/* Telsiz — sunucusuz, cihazdan cihaza mesaj ve dosya (WebRTC + QR eşleşme). */
(() => {
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';
const CHUNK = 16 * 1024;          // tek veri paketi
const SLICE = 256 * 1024;         // dosyadan bir seferde okunan parça
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const SYNC_COUNT = 200;
const BIG_FILE = 500 * 1024 * 1024;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = name => {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = (n = 8) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
};
const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
const cleanName = v => str(v, 60).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
const cleanFileName = v => str(v, 300).replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 120) || 'dosya';
const isId = v => typeof v === 'string' && /^[a-f0-9]{8,40}$/.test(v);

/* ---------- kimlik ve kalıcı kayıt ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* özel sekme vb. */ } },
};
const me = store.get('telsiz.me', null) || { id: rid(6), name: '' };
const myKind = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? 'tel' : 'pc';
const who = () => ({ id: me.id, name: me.name || 'Cihaz' });

const db = (() => {
  let opening;
  const open = () => opening || (opening = new Promise((res, rej) => {
    const r = indexedDB.open('telsiz', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('msgs', { keyPath: 'mid' });
      r.result.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (name, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode);
      const rq = fn(t.objectStore(name));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => run('msgs', 'readonly', s => s.getAll()).catch(() => []),
    put: m => run('msgs', 'readwrite', s => s.put(m)).catch(() => {}),
    putFile: (id, blob) => run('files', 'readwrite', s => s.put(blob, id)).catch(() => {}),
    getFile: id => run('files', 'readonly', s => s.get(id)).catch(() => null),
    async clear() {
      await run('msgs', 'readwrite', s => s.clear()).catch(() => {});
      await run('files', 'readwrite', s => s.clear()).catch(() => {});
    },
  };
})();

/* ---------- durum ---------- */
let msgs = [];                  // zamana göre sıralı
const known = new Map();        // mid -> mesaj
const blobs = new Map();        // dosya id -> Blob
const urls = new Map();         // dosya id -> object URL
const incoming = new Set();     // şu an alınan dosya mesajları (mid)
const peers = new Map();        // key -> eş
const openPeers = () => Array.from(peers.values()).filter(p => p.open);

const stream = $('#stream');
let pinned = true;
let unread = 0;
let renderQueued = false;

/* ---------- küçük arayüz yardımcıları ---------- */
function toast(text, ms = 3200) {
  const t = el('div', 'toast', text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
const hm = ts => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dayKey = ts => { const d = new Date(ts); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
function dayLabel(ts) {
  const today = dayKey(Date.now());
  const k = dayKey(ts);
  if (k === today) return 'BUGÜN';
  if (k === dayKey(Date.now() - 864e5)) return 'DÜN';
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).toLocaleUpperCase('tr-TR');
}
function fmtSize(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0).replace('.', ',') : String(n)) + ' ' + u[i];
}
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* yok */ }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? 'KOPYALANDI' : 'KOPYALANAMADI';
    setTimeout(() => { btn.textContent = old; }, 1400);
  }
}
const atBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
function scrollToBottom() { stream.scrollTop = stream.scrollHeight; pinned = true; $('#jump').hidden = true; }

/* ---------- mesajları çizme ---------- */
function withBlob(id) {
  if (blobs.has(id)) return Promise.resolve(blobs.get(id));
  return db.getFile(id).then(b => { if (b) blobs.set(id, b); return b || null; });
}
function urlFor(id, blob) {
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(blob));
  return urls.get(id);
}
function fillText(box, text) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  parts.forEach((part, i) => {
    if (i % 2) {
      const a = el('a', null, part);
      a.href = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.append(a);
    } else if (part) box.append(part);
  });
}
function fillFile(box, m) {
  const f = m.file;
  box.classList.add('file');
  const row = el('div', 'file-row');
  const dot = f.name.lastIndexOf('.');
  const ext = (dot > 0 ? f.name.slice(dot + 1) : 'dosya').slice(0, 5).toLocaleUpperCase('tr-TR');
  const info = el('div', 'file-info');
  info.append(el('div', 'file-name', f.name), el('div', 'file-size', fmtSize(f.size)));
  row.append(el('span', 'ext', ext), info);
  const actions = el('div', 'file-actions');
  box.append(row, actions);
  withBlob(f.id).then(blob => {
    if (!blob) { actions.append(el('span', 'gone', 'Dosya bu cihazda saklı değil.')); return; }
    const url = urlFor(f.id, blob);
    if (/^image\//.test(f.mime)) {
      const img = el('img', 'thumb');
      img.alt = f.name;
      img.onload = () => { if (pinned) scrollToBottom(); };
      img.onerror = () => img.remove();
      img.onclick = () => openLightbox(url, f.name);
      img.src = url;
      box.prepend(img);
    }
    const a = el('a', 'btn btn-sm', 'İNDİR');
    a.href = url;
    a.download = f.name;
    actions.append(a);
    try {
      const file = new File([blob], f.name, { type: f.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const s = el('button', 'btn btn-sm', 'PAYLAŞ / KAYDET');
        s.type = 'button';
        s.onclick = () => navigator.share({ files: [file] }).catch(() => {});
        actions.append(s);
      }
    } catch { /* paylaşım desteklenmiyor */ }
    if (pinned) scrollToBottom();
  });
}
function buildNode(m, prev) {
  const frag = document.createDocumentFragment();
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) frag.append(el('div', 'day', dayLabel(m.ts)));
  if (m.sys) { frag.append(el('div', 'sys', m.text + ' · ' + hm(m.ts))); return frag; }
  const own = m.from.id === me.id;
  const cont = !!prev && !prev.sys && prev.from.id === m.from.id && m.ts - prev.ts < 5 * 60000 && dayKey(prev.ts) === dayKey(m.ts);
  const node = el('div', 'msg ' + (own ? 'own' : 'other') + (cont ? ' cont' : ''));
  node.dataset.mid = m.mid;
  if (!cont) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'who', own ? 'SEN' : m.from.name), el('time', null, hm(m.ts)));
    node.append(meta);
  }
  const bubble = el('div', 'bubble');
  if (m.file) fillFile(bubble, m); else fillText(bubble, m.text);
  node.append(bubble);
  const foot = el('div', 'foot');
  if (m.pending) foot.append(el('span', 'pend', 'BEKLİYOR · bağlanınca gider'));
  if (!m.file) {
    const c = el('button', 'link copy', 'KOPYALA');
    c.type = 'button';
    c.onclick = () => copyText(m.text, c);
    foot.append(c);
  }
  node.append(foot);
  frag.append(node);
  return frag;
}
function buildEmpty() {
  const box = el('div', 'empty');
  box.append(el('div', 'label', 'Kanal sessiz'));
  box.append(el('div', 'empty-title', 'İnternet yok. Hat yok. Yine de konuşabilirsin.'));
  const ol = el('ol', 'steps');
  [
    'Karşı cihazla aynı Wi‑Fi\'a ya da aynı hotspot\'a bağlan.',
    'BAĞLAN\'a bas; bir cihaz kodu göstersin, diğeri okutsun.',
    'Mesaj yaz ya da ataç simgesiyle dosya gönder.',
  ].forEach(t => ol.append(el('li', null, t)));
  box.append(ol);
  const b = el('button', 'btn btn-accent', 'CİHAZ BAĞLA');
  b.type = 'button';
  b.onclick = openPair;
  box.append(b);
  return box;
}
function renderAll() {
  renderQueued = false;
  const keep = pinned;
  const top = stream.scrollTop;
  stream.textContent = '';
  if (!msgs.length) { stream.append(buildEmpty()); return; }
  const frag = document.createDocumentFragment();
  msgs.forEach((m, i) => frag.append(buildNode(m, msgs[i - 1])));
  stream.append(frag);
  if (keep) scrollToBottom(); else stream.scrollTop = top;
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderAll);
}
function addMessage(m, quiet) {
  if (known.has(m.mid)) return false;
  known.set(m.mid, m);
  const wasPinned = pinned;
  const inOrder = !msgs.length || m.ts >= msgs[msgs.length - 1].ts;
  if (inOrder) msgs.push(m);
  else {
    let i = msgs.length;
    while (i > 0 && msgs[i - 1].ts > m.ts) i--;
    msgs.splice(i, 0, m);
  }
  if (!m.sys) db.put(m);
  if (inOrder && !renderQueued && msgs.length > 1) {
    stream.append(buildNode(m, msgs[msgs.length - 2]));
    if (wasPinned || (!m.sys && m.from.id === me.id)) scrollToBottom();
  } else queueRender();
  if (!quiet && !m.sys && m.from.id !== me.id) {
    if (!wasPinned) $('#jump').hidden = false;
    if (document.hidden) {
      unread++;
      document.title = '(' + unread + ') Telsiz';
      if (navigator.vibrate) navigator.vibrate(60);
    }
  }
  return true;
}
const sysLine = text => addMessage({ mid: 's' + rid(6), ts: Date.now(), sys: true, text }, true);
const wire = m => (m.file
  ? { mid: m.mid, ts: m.ts, from: m.from, file: m.file }
  : { mid: m.mid, ts: m.ts, from: m.from, text: m.text });
function cleanMsg(m) {
  if (!m || typeof m !== 'object' || !isId(m.mid)) return null;
  const ts = Number(m.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const f = m.from || {};
  const out = { mid: m.mid, ts: Math.min(ts, Date.now()), from: { id: str(f.id, 24) || '?', name: cleanName(f.name) || 'Cihaz' } };
  if (m.file) {
    const size = Number(m.file.size);
    if (!isId(m.file.id) || !Number.isFinite(size) || size < 0) return null;
    const mime = str(m.file.mime, 100);
    out.file = { id: m.file.id, name: cleanFileName(m.file.name), size, mime: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream' };
  } else {
    out.text = str(m.text, 4000);
    if (!out.text.trim()) return null;
  }
  return out;
}

function openLightbox(url, name) {
  const box = $('#lightbox');
  const img = $('img', box);
  img.src = url;
  img.alt = name;
  box.hidden = false;
}

/* ---------- aktarım şeridi ---------- */
function addTransfer(dir, name, onCancel) {
  const row = el('div', 'tr');
  const head = el('div', 'tr-head');
  const pct = el('span', 'tr-pct', '0%');
  head.append(el('span', 'tr-dir', dir === 'up' ? '↑' : '↓'), el('span', 'tr-name', name), pct);
  if (onCancel) {
    const x = el('button', 'tr-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Aktarımı iptal et');
    x.append(icon('close'));
    x.onclick = onCancel;
    head.append(x);
  }
  const bar = el('div', 'tr-bar');
  const fill = el('i');
  bar.append(fill);
  row.append(head, bar);
  $('#transfers').append(row);
  let last = 0;
  return {
    progress(p) {
      const now = performance.now();
      if (p < 1 && now - last < 100) return;
      last = now;
      fill.style.transform = 'scaleX(' + p + ')';
      pct.textContent = Math.round(p * 100) + '%';
    },
    done() { this.progress(1); row.classList.add('ok'); setTimeout(() => row.remove(), 900); },
    fail(text) { row.classList.add('bad'); pct.textContent = text; setTimeout(() => row.remove(), 5000); },
  };
}

/* ---------- eşleşme kodu (SDP'nin QR'a sığan özeti) ---------- */
class NoNetworkError extends Error {}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const SETUP = { actpass: 'x', active: 'a', passive: 'p' };
const SETUP_BACK = { x: 'actpass', a: 'active', p: 'passive' };

function encodeDesc(desc, kind) {
  const sdp = desc.sdp;
  const g = re => (sdp.match(re) || [])[1];
  const ufrag = g(/a=ice-ufrag:(\S+)/);
  const pwd = g(/a=ice-pwd:(\S+)/);
  const fp = g(/a=fingerprint:sha-256 (\S+)/i);
  const setup = SETUP[g(/a=setup:(\w+)/)] || (kind === 'O' ? 'x' : 'a');
  if (!ufrag || !pwd || !fp) throw new Error('SDP okunamadı');
  const cands = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/g)) {
    if (m[1].toLowerCase() !== 'udp' || m[4] !== 'host') continue;
    const c = m[2] + '@' + m[3];
    if (!cands.includes(c)) cands.push(c);
  }
  if (!cands.length) throw new NoNetworkError();
  // IPv4 önce, sonra .local (gizlenmiş yerel adres), en son IPv6
  const rank = c => (/^\d+\.\d+\.\d+\.\d+@/.test(c) ? 0 : c.includes('.local@') ? 1 : 2);
  cands.sort((a, b) => rank(a) - rank(b));
  // Gerçek IPv4 adresi varsa yalnız onları gönder: kod küçülür, kamerayla okumak kolaylaşır.
  const v4 = cands.filter(c => rank(c) === 0);
  const fpBytes = Uint8Array.from(fp.split(':').map(h => parseInt(h, 16)));
  return ['TLSZ1', kind, ufrag, pwd, b64url(fpBytes), setup, (v4.length ? v4 : cands).slice(0, 3).join(',')].join('|');
}
function decodeCode(text) {
  const p = String(text).replace(/\s+/g, '').split('|');
  if (p.length !== 7 || p[0] !== 'TLSZ1' || !/^[OA]$/.test(p[1])) return null;
  if (!/^[A-Za-z0-9+/]{4,256}$/.test(p[2]) || !/^[A-Za-z0-9+/]{16,256}$/.test(p[3])) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(p[4]) || !SETUP_BACK[p[5]]) return null;
  const cands = [];
  for (const c of p[6].split(',')) {
    const m = /^([0-9A-Za-z.:-]{2,80})@(\d{1,5})$/.exec(c);
    if (!m || Number(m[2]) > 65535) return null;
    cands.push({ addr: m[1], port: m[2] });
  }
  if (!cands.length || cands.length > 8) return null;
  let fp;
  try { fp = Array.from(unb64url(p[4]), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'); } catch { return null; }
  return { kind: p[1], ufrag: p[2], pwd: p[3], fp, setup: SETUP_BACK[p[5]], cands };
}
function buildSdp(d) {
  const L = [
    'v=0',
    'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ];
  d.cands.forEach((c, i) => L.push('a=candidate:' + (i + 1) + ' 1 udp ' + (2113937151 - i) + ' ' + c.addr + ' ' + c.port + ' typ host generation 0'));
  L.push(
    'a=ice-ufrag:' + d.ufrag,
    'a=ice-pwd:' + d.pwd,
    'a=fingerprint:sha-256 ' + d.fp,
    'a=setup:' + d.setup,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  );
  return L.join('\r\n') + '\r\n';
}

/* ---------- eş bağlantıları ---------- */
function newPeer() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const peer = { key: rid(4), pc, dc: null, id: '', name: 'Cihaz', kind: 'tel', open: false, dead: false, outQ: [], busy: false, rx: null, accept: new Map() };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !peer.open) pairFail(peer);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(peer, true);
  };
  return peer;
}
function gathered(pc) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); res(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, 4000);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
async function makeOffer() {
  const peer = newPeer();
  wireChannel(peer, peer.pc.createDataChannel('telsiz', { ordered: true }));
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await gathered(peer.pc);
    return { peer, code: encodeDesc(peer.pc.localDescription, 'O') };
  } catch (e) { dropPeer(peer, false); throw e; }
}
async function acceptOffer(d) {
  const peer = newPeer();
  peer.pc.ondatachannel = e => wireChannel(peer, e.channel);
  try {
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(d) });
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    await gathered(peer.pc);
    return { peer, code: encodeDesc(peer.pc.localDescription, 'A') };
  } catch (e) { dropPeer(peer, false); throw e; }
}
const acceptAnswer = (peer, d) => peer.pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(d) });

function wireChannel(peer, dc) {
  peer.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  dc.onopen = () => {
    peer.open = true;
    peers.set(peer.key, peer);
    sendJ(peer, { t: 'hi', id: me.id, name: me.name, kind: myKind });
    sendSync(peer);
    onPeerOpen(peer);
  };
  dc.onclose = () => dropPeer(peer, true);
  dc.onmessage = e => {
    if (typeof e.data === 'string') onJson(peer, e.data);
    else onChunk(peer, e.data);
  };
}
function sendJ(peer, obj) {
  if (!peer.open) return false;
  try { peer.dc.send(JSON.stringify(obj)); return true; } catch { return false; }
}
function dropPeer(peer, notify) {
  if (peer.dead) return;
  peer.dead = true;
  const wasOpen = peer.open;
  peer.open = false;
  try { if (peer.dc) peer.dc.close(); } catch { /* kapalı */ }
  try { peer.pc.close(); } catch { /* kapalı */ }
  peers.delete(peer.key);
  if (peer.rx) { peer.rx.tr.fail('KESİLDİ'); incoming.delete(peer.rx.msg.mid); peer.rx = null; }
  for (const w of peer.accept.values()) w.rej(new Error('closed'));
  peer.accept.clear();
  peer.outQ.length = 0;
  if (wasOpen && notify) sysLine(peer.name + ' ile bağlantı koptu');
  renderPeers();
}

function sendSync(peer) {
  const texts = msgs.filter(m => !m.sys && !m.file).slice(-SYNC_COUNT);
  for (const m of texts) sendJ(peer, { t: 'm', m: wire(m), old: true });
  let changed = false;
  for (const m of msgs) {
    if (!m.pending) continue;
    if (m.file) withBlob(m.file.id).then(b => { if (b) queueFile(peer, m, b); });
    m.pending = false;
    db.put(m);
    changed = true;
  }
  if (changed) queueRender();
}

function onJson(peer, raw) {
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'hi': {
      peer.id = str(d.id, 24);
      peer.name = cleanName(d.name) || 'Cihaz';
      peer.kind = d.kind === 'pc' ? 'pc' : 'tel';
      for (const p of Array.from(peers.values())) if (p !== peer && p.id === peer.id) dropPeer(p, false);
      sysLine(peer.name + ' bağlandı');
      renderPeers();
      break;
    }
    case 'nm': {
      const n = cleanName(d.name);
      if (n) { peer.name = n; renderPeers(); }
      break;
    }
    case 'm': {
      const m = cleanMsg(d.m);
      if (!m || m.file || known.has(m.mid)) return;
      addMessage(m, !!d.old);
      for (const p of openPeers()) if (p !== peer) sendJ(p, { t: 'm', m: wire(m), old: !!d.old });
      break;
    }
    case 'fo': {
      const m = cleanMsg(d.m);
      if (!m || !m.file) return;
      if (peer.rx || known.has(m.mid) || incoming.has(m.mid)) { sendJ(peer, { t: 'fa', id: m.file.id, ok: false }); return; }
      incoming.add(m.mid);
      peer.rx = { msg: m, chunks: [], got: 0, tr: addTransfer('down', m.file.name) };
      sendJ(peer, { t: 'fa', id: m.file.id, ok: true });
      break;
    }
    case 'fa': {
      const w = peer.accept.get(d.id);
      if (w) { peer.accept.delete(d.id); w.res(!!d.ok); }
      break;
    }
    case 'fe': finishReceive(peer, d.id); break;
    case 'fx': {
      if (peer.rx && peer.rx.msg.file.id === d.id) {
        peer.rx.tr.fail('İPTAL');
        incoming.delete(peer.rx.msg.mid);
        peer.rx = null;
      }
      break;
    }
  }
}
function onChunk(peer, data) {
  const rx = peer.rx;
  if (!rx) return;
  rx.chunks.push(data);
  rx.got += data.byteLength;
  if (rx.got > rx.msg.file.size) {   // söz verilenden büyük: bırak
    rx.tr.fail('HATALI');
    incoming.delete(rx.msg.mid);
    peer.rx = null;
    return;
  }
  rx.tr.progress(rx.msg.file.size ? rx.got / rx.msg.file.size : 1);
}
function finishReceive(peer, id) {
  const rx = peer.rx;
  if (!rx || rx.msg.file.id !== id) return;
  peer.rx = null;
  incoming.delete(rx.msg.mid);
  const f = rx.msg.file;
  if (rx.got !== f.size) { rx.tr.fail('EKSİK'); return; }
  const blob = new Blob(rx.chunks, { type: f.mime });
  blobs.set(f.id, blob);
  db.putFile(f.id, blob);
  rx.tr.done();
  if (addMessage(rx.msg)) {
    for (const p of openPeers()) if (p !== peer) queueFile(p, rx.msg, blob);
  }
}

function queueFile(peer, msg, blob) {
  if (!peer.open) return;
  peer.outQ.push({ msg, blob, cancelled: false });
  pump(peer);
}
function drained(peer) {
  return new Promise((res, rej) => {
    const dc = peer.dc;
    const check = () => {
      if (dc.readyState !== 'open') { clearInterval(t); rej(new Error('closed')); }
      else if (dc.bufferedAmount <= LOW_WATER) { clearInterval(t); res(); }
    };
    const t = setInterval(check, 50);
    dc.addEventListener('bufferedamountlow', check, { once: true });
  });
}
async function pump(peer) {
  if (peer.busy || !peer.open) return;
  const job = peer.outQ.shift();
  if (!job) return;
  peer.busy = true;
  const f = job.msg.file;
  const tr = addTransfer('up', f.name + ' → ' + peer.name, () => { job.cancelled = true; });
  try {
    const ok = await new Promise((res, rej) => {
      peer.accept.set(f.id, { res, rej });
      if (!sendJ(peer, { t: 'fo', m: wire(job.msg) })) rej(new Error('closed'));
    });
    if (ok) {
      const size = job.blob.size;
      let off = 0;
      while (off < size) {
        if (job.cancelled) { sendJ(peer, { t: 'fx', id: f.id }); throw new Error('cancel'); }
        const buf = await job.blob.slice(off, off + SLICE).arrayBuffer();
        for (let i = 0; i < buf.byteLength; i += CHUNK) {
          if (!peer.open) throw new Error('closed');
          if (peer.dc.bufferedAmount > HIGH_WATER) await drained(peer);
          peer.dc.send(buf.slice(i, i + CHUNK));
        }
        off += buf.byteLength;
        tr.progress(off / size);
      }
      if (!sendJ(peer, { t: 'fe', id: f.id })) throw new Error('closed');
    }
    tr.done();
  } catch (e) {
    tr.fail(e && e.message === 'cancel' ? 'İPTAL' : 'GÖNDERİLEMEDİ');
  }
  peer.busy = false;
  pump(peer);
}

/* ---------- gönderme ---------- */
function sendText(text) {
  const m = { mid: rid(8), ts: Date.now(), from: who(), text };
  const open = openPeers();
  if (!open.length) m.pending = true;
  addMessage(m);
  for (const p of open) sendJ(p, { t: 'm', m: wire(m) });
}
function sendFile(file) {
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
  const m = { mid: rid(8), ts: Date.now(), from: who(), file: { id: rid(8), name: cleanFileName(file.name), size: file.size, mime } };
  if (file.size > BIG_FILE) toast('Büyük dosya: telefonlarda bellek yetmeyebilir.', 5000);
  blobs.set(m.file.id, file);
  db.putFile(m.file.id, file);
  const open = openPeers();
  if (!open.length) m.pending = true;
  addMessage(m);
  for (const p of open) queueFile(p, m, file);
}
const sendFiles = list => { for (const f of Array.from(list || [])) sendFile(f); };

/* ---------- cihaz listesi ve durum ---------- */
let wakeLock = null;
async function syncWake() {
  const need = openPeers().length > 0 && document.visibilityState === 'visible';
  try {
    if (need && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!need && wakeLock) {
      const w = wakeLock;
      wakeLock = null;
      await w.release();
    }
  } catch { /* izin yok ya da desteklenmiyor */ }
}
function renderPeers() {
  const list = openPeers();
  const ul = $('#peers');
  ul.textContent = '';
  for (const p of list) {
    const li = el('li', 'peer');
    const x = el('button', 'icon-btn');
    x.type = 'button';
    x.setAttribute('aria-label', p.name + ' bağlantısını kes');
    x.append(icon('close'));
    x.onclick = () => dropPeer(p, true);
    li.append(icon(p.kind === 'pc' ? 'laptop' : 'phone'), el('span', 'peer-name', p.name), x);
    ul.append(li);
  }
  $('#peer-count').textContent = list.length ? '(' + list.length + ')' : '';
  $('#readout').classList.toggle('on', list.length > 0);
  $('#readout-text').textContent = list.length ? list.length + ' CİHAZ BAĞLI' : 'BAĞLI DEĞİL';
  syncWake();
}
function renderMe() { $('#me-name').textContent = me.name || '—'; }

/* ---------- eşleşme ekranı ---------- */
const pair = { open: false, pane: 'menu', offer: null, answer: null, timer: 0, working: false, diag: null };
let cam = null;
let scanning = false;
const SCAN_TEXT = 'Karşı cihazın ekranındaki kodu çerçeveye getir.';

function showPane(name) {
  pair.pane = name;
  for (const s of $$('#pair .pane')) s.hidden = s.dataset.pane !== name;
  if (name !== 'scan') scanning = false;
}
const busy = text => { $('#busy-text').textContent = text; showPane('busy'); };
function scanNote(text) {
  $('#scan-text').textContent = text;
  if (pair.pane !== 'scan') toast(text);
}
const addrsOf = code => {
  const d = decodeCode(code);
  return d ? d.cands.map(c => (c.addr.endsWith('.local') ? 'gizli ad' : c.addr)).join(', ') : '?';
};
// Eşleşme sırasında bağlantı kurulamadı: nedenini bulmaya yarayacak adresleri de göster.
function pairFail(peer) {
  const mine = (pair.offer && pair.offer.peer === peer) || (pair.answer && pair.answer.peer === peer);
  if (!pair.open || !mine) return;
  const state = peer.pc.iceConnectionState;
  const d = pair.diag;
  discardPending();
  const hidden = d && addrsOf(d.theirs) === 'gizli ad';
  pairError(hidden
    ? 'Bağlantı kurulamadı. Karşı cihaz adresini gizli gönderdi. O cihazda Telsiz\'e kamera izni verip baştan deneyin.'
    : 'Bağlantı kurulamadı. İki cihaz aynı Wi‑Fi\'da ya da aynı hotspot\'ta mı? Kontrol edip baştan deneyin.');
  if (d) $('#err-diag').textContent = 'Bu cihaz: ' + addrsOf(d.mine) + ' · Karşı cihaz: ' + addrsOf(d.theirs) + ' · durum: ' + state;
}
function pairError(e) {
  clearTimeout(pair.timer);
  $('#err-diag').textContent = '';
  $('#err-text').textContent = e instanceof NoNetworkError
    ? 'Bu cihaz bir ağa bağlı görünmüyor. Wi‑Fi\'ı aç, karşı cihazla aynı ağa ya da hotspot\'a bağlan ve tekrar dene.'
    : (typeof e === 'string' ? e : 'Kod işlenemedi. Baştan deneyin.');
  showPane('error');
}
function discardPending() {
  for (const k of ['offer', 'answer']) {
    const p = pair[k] && pair[k].peer;
    if (p && !p.open) dropPeer(p, false);
    pair[k] = null;
  }
}
function openPair() {
  closeRail();
  pair.open = true;
  $('#manual').open = false;
  $('#manual-own').hidden = true;
  $('#code-in').value = '';
  showPane('menu');
  $('#pair').hidden = false;
}
function closePair() {
  pair.open = false;
  clearTimeout(pair.timer);
  stopCamera();
  discardPending();
  $('#pair').hidden = true;
}
function onPeerOpen(peer) {
  renderPeers();
  const mine = (pair.offer && pair.offer.peer === peer) || (pair.answer && pair.answer.peer === peer);
  if (mine) { toast('Bağlantı kuruldu.'); closePair(); }
}
function armTimeout(peer, ms) {
  clearTimeout(pair.timer);
  pair.timer = setTimeout(() => { if (!peer.open) pairFail(peer); }, ms);
}

async function startCamera() {
  if (cam) return cam;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  if (!pair.open) { s.getTracks().forEach(t => t.stop()); throw new Error('closed'); }
  cam = s;
  return cam;
}
function stopCamera() {
  scanning = false;
  if (cam) { cam.getTracks().forEach(t => t.stop()); cam = null; }
  $('#cam').srcObject = null;
}

function renderQR(box, text) {
  const q = qrcode(0, 'L');   // ekrandan okunuyor; düşük hata payı = daha iri kareler
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const pad = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + pad) + ' ' + (r + pad) + 'h1v1h-1z';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + (n + pad * 2) + ' ' + (n + pad * 2));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Eşleşme kodu');
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  box.textContent = '';
  box.append(svg);
}
function showOwnCode(code, step) {
  renderQR($('#qr'), code);
  $('#code-out').value = code;
  $('#manual-own').hidden = false;
  $('#show-step').textContent = 'ADIM ' + step + ' / 2';
  $('#show-text').textContent = step === 1
    ? 'Karşı cihazda BAĞLAN → KOD OKUT\'a basıp bu kodu okutun. Sonra onun göstereceği cevap kodunu bu cihaza okut.'
    : 'Bu cevap kodunu ilk cihaza okutun. Bağlantı kendiliğinden kurulur.';
  $('#show-next').hidden = step !== 1;
  $('#show-wait').hidden = step === 1;
  const mine = addrsOf(code);
  const diag = $('#show-diag');
  diag.classList.toggle('warn', mine === 'gizli ad');
  diag.textContent = mine === 'gizli ad'
    ? 'Uyarı: bu cihazın adresi gizli, bağlantı kurulamayabilir. Kamera iznini verip BAĞLAN\'ı yeniden açın.'
    : 'Bu cihazın adresi: ' + mine;
  showPane('show');
}
async function goShow() {
  busy('Kod hazırlanıyor…');
  // Kamera izni varken tarayıcılar gerçek yerel adresi verir; bağlantı daha güvenilir kurulur.
  try { await startCamera(); } catch { /* kamerasız da devam */ }
  if (!pair.open) return;
  try {
    discardPending();
    pair.offer = await makeOffer();
    if (!pair.open) { discardPending(); return; }
    showOwnCode(pair.offer.code, 1);
  } catch (e) { pairError(e); }
}
async function goScan() {
  $('#scan-text').textContent = SCAN_TEXT;
  showPane('scan');
  const v = $('#cam');
  try {
    v.srcObject = await startCamera();
    await v.play().catch(() => {});
  } catch {
    if (!pair.open) return;
    $('#scan-text').textContent = 'Kamera açılamadı. Aşağıdan kodu elle girebilirsin.';
    $('#manual').open = true;
    return;
  }
  if (scanning || pair.pane !== 'scan') return;
  scanning = true;
  scanLoop(v);
}
async function scanLoop(v) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let detector = null;
  if ('BarcodeDetector' in window) {
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
  }
  let lastBad = '';
  let lastBadAt = 0;
  while (scanning && pair.open) {
    let text = null;
    if (v.readyState >= 2 && v.videoWidth) {
      if (detector) {
        try { const r = await detector.detect(v); if (r.length) text = r[0].rawValue; } catch { detector = null; }
      }
      if (!detector) {
        const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (r && r.data) text = r.data;
      }
    }
    if (text && !(text === lastBad && Date.now() - lastBadAt < 2500)) {
      if (await handleCode(text)) return;
      lastBad = text;
      lastBadAt = Date.now();
    }
    await sleep(140);
  }
}
async function handleCode(text) {
  if (pair.working) return false;
  const d = decodeCode(text);
  if (!d) { scanNote('Bu bir Telsiz kodu değil.'); return false; }
  const flat = String(text).replace(/\s+/g, '');
  if ((pair.offer && pair.offer.code === flat) || (pair.answer && pair.answer.code === flat)) {
    scanNote('Bu kendi kodun. Karşı cihazın kodunu okut.');
    return false;
  }
  if (d.kind === 'A' && !pair.offer) {
    scanNote('Bu bir cevap kodu. Önce bu cihazda KOD GÖSTER ile başlayın.');
    return false;
  }
  pair.working = true;
  try {
    if (d.kind === 'O') {
      busy('Cevap kodu hazırlanıyor…');
      discardPending();
      pair.answer = await acceptOffer(d);
      if (!pair.open) { discardPending(); return true; }
      pair.diag = { mine: pair.answer.code, theirs: flat };
      showOwnCode(pair.answer.code, 2);
      // Cevap kodunun karşı cihaza okutulması zaman alır; acele ettirme.
      armTimeout(pair.answer.peer, 180000);
    } else {
      busy('Bağlanıyor…');
      pair.diag = { mine: pair.offer.code, theirs: flat };
      await acceptAnswer(pair.offer.peer, d);
      armTimeout(pair.offer.peer, 30000);
    }
  } catch (e) {
    discardPending();
    pairError(e);
  } finally { pair.working = false; }
  return true;
}

/* ---------- menü, ad, kurulum ---------- */
function openRail() { $('#rail').classList.add('open'); $('#scrim').hidden = false; }
function closeRail() { $('#rail').classList.remove('open'); $('#scrim').hidden = true; }
function openName() {
  closeRail();
  $('#name-input').value = me.name;
  $('#namebox').hidden = false;
  setTimeout(() => $('#name-input').focus(), 50);
}
async function registerSW() {
  const st = $('#offline-state');
  const txt = st.lastElementChild;
  if (!('serviceWorker' in navigator)) { txt.textContent = 'Bu tarayıcıda çevrimdışı kurulum yok.'; return; }
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    st.classList.add('on');
    txt.textContent = 'Çevrimdışı kullanıma hazır';
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { txt.textContent = 'Çevrimdışı kurulum yapılamadı.'; }
}

/* ---------- olaylar ---------- */
function wireUi() {
  const text = $('#text');
  const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight + 2, 148) + 'px'; };
  const submit = () => {
    const v = text.value.trim();
    if (!v) return;
    sendText(v.slice(0, 4000));
    text.value = '';
    grow();
  };
  $('#composer').addEventListener('submit', e => { e.preventDefault(); submit(); text.focus(); });
  text.addEventListener('input', grow);
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); submit(); }
  });
  text.addEventListener('paste', e => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); sendFiles(files); }
  });
  $('#attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = e => { sendFiles(e.target.files); e.target.value = ''; };

  stream.addEventListener('scroll', () => { pinned = atBottom(); if (pinned) $('#jump').hidden = true; }, { passive: true });
  $('#jump').onclick = scrollToBottom;

  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#drop').hidden = false; } });
  addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    sendFiles(e.dataTransfer.files);
  });

  $('#bar-pair').onclick = openPair;
  $('#rail-pair').onclick = openPair;
  $('#pair-close').onclick = closePair;
  $('#pair').addEventListener('click', e => { if (e.target === e.currentTarget) closePair(); });
  $('#go-show').onclick = goShow;
  $('#go-scan').onclick = goScan;
  $('#show-next').onclick = goScan;
  $('#err-retry').onclick = () => { discardPending(); showPane('menu'); };
  $('#code-copy').onclick = e => copyText($('#code-out').value, e.currentTarget);
  $('#code-apply').onclick = async () => {
    const v = $('#code-in').value;
    if (!v.trim()) return;
    if (await handleCode(v)) $('#code-in').value = '';
  };

  $('#rail-open').onclick = openRail;
  $('#rail-close').onclick = closeRail;
  $('#scrim').onclick = closeRail;
  $('#me-edit').onclick = openName;
  $('#name-form').addEventListener('submit', e => {
    e.preventDefault();
    const n = cleanName($('#name-input').value);
    if (!n) return;
    me.name = n;
    store.set('telsiz.me', me);
    renderMe();
    for (const p of openPeers()) sendJ(p, { t: 'nm', name: n });
    $('#namebox').hidden = true;
  });
  $('#wipe').onclick = async () => {
    if (!confirm('Bu cihazdaki tüm mesajlar ve dosyalar silinsin mi? Diğer cihazlardaki kopyalar silinmez.')) return;
    await db.clear();
    msgs = [];
    known.clear();
    blobs.clear();
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    renderAll();
    closeRail();
  };
  $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
    else if (pair.open) closePair();
    else closeRail();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unread = 0; document.title = 'Telsiz'; }
    syncWake();
  });
  addEventListener('beforeunload', e => { if (openPeers().length) { e.preventDefault(); e.returnValue = ''; } });

  let installEvt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
  $('#install').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    $('#install').hidden = true;
  };
  addEventListener('appinstalled', () => { $('#install').hidden = true; });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) $('#ios-hint').hidden = false;
}

async function init() {
  wireUi();
  renderMe();
  renderPeers();
  if (!('RTCPeerConnection' in window)) {
    stream.append(el('div', 'empty', 'Bu tarayıcı cihazdan cihaza bağlantıyı desteklemiyor. Güncel Chrome, Safari ya da Firefox kullanın.'));
    return;
  }
  const saved = await db.all();
  saved.sort((a, b) => a.ts - b.ts);
  for (const m of saved) { if (m && m.mid && !known.has(m.mid)) { known.set(m.mid, m); msgs.push(m); } }
  renderAll();
  scrollToBottom();
  if (!me.name) openName();
  registerSW();
}

init();
})();
