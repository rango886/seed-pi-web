// 音频 / 视频的自绘播放器。
//
// 回复是 v-html 塞进来的，不是 Vue 组件，所以和 diagram.js 一样：用 MutationObserver 盯着页面上
// 新出现的 <video> / <audio>，出现一个就给它套一层自己画的控件（原生 controls 去掉）。
// 不管是 markdown 的 ![](a.mp4)、模型手写的 <video src>，还是文件标签页里的播放器，都走这一套。
// 想保留原生控件的元素加 data-native 就不会被接管。

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
// 线条图标：24 单位画布，描边 1.8，圆头圆角，和 Icon.vue 一个风格
const svg = (d, cls, size = 16) =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" ${STROKE} aria-hidden="true"><path d="${d}"/></svg>`;
const P = {
  vol: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  fs: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  unfs: 'M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5',
  down: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
};
// 实心的播放三角 / 暂停条另外画：它们只有斜边和直角，用上面那套描边路径会糊。
// 这里换成 16 单位的小画布，坐标全是整数，渲染尺寸只取 16 / 32（1:1 和 2:1 整倍），
// 斜边就不会落到半个像素上——小尺寸下也就不会有锯齿。
// 居中按三角形的**重心**算：左边长 10、顶点在 (14,8)，重心正好是 (8,8)。
// 如果按外框（8.5~19）居中，三角形看起来会偏左。
const solid = (d, cls, size) => `<svg class="${cls}" viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const I_PLAY = (size = 16) => solid('M5 3v10l9-5z', 'i-play', size);
const I_PAUSE = (size = 16) => solid('M4 3h3v10H4zM9 3h3v10H9z', 'i-pause', size);
const btn = (act, inner, title) => `<button type="button" class="mp-btn" data-act="${act}" title="${title}" aria-label="${title}">${inner}</button>`;
const PLAY_BTN = (cls = '') =>
  `<button type="button" class="mp-btn mp-play ${cls}" data-act="play" title="播放 / 暂停（空格）" aria-label="播放 / 暂停">` +
  `${I_PLAY()}${I_PAUSE()}</button>`;
const MUTE_BTN = btn('mute', svg(P.vol, 'i-vol') + svg(P.mute, 'i-mute'), '静音（M）');
const SPEED_BTN = '<button type="button" class="mp-btn mp-speed" data-act="speed" title="播放速度">1×</button>';
const TRACK = '<span class="mp-track" data-act="seek"><span class="mp-rail"><span class="mp-buf"></span><span class="mp-fill"></span></span><span class="mp-thumb"></span></span>';
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
}
/** 显示用的文件名：优先 data-name；本地文件的地址是 /api/fs/raw?path=…，从 path 里取 */
function nameOf(el, src) {
  if (el.dataset.name) return el.dataset.name;
  try {
    const u = new URL(src, location.href);
    const p = u.searchParams.get('path') || decodeURIComponent(u.pathname);
    return p.split(/[\\/]/).filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

let current = null; // 正在播的那个：开始播另一个时把它停掉

function bind(el) {
  if (el.dataset.mp || el.hasAttribute('data-native')) return;
  el.dataset.mp = '1';
  el.controls = false;
  el.removeAttribute('controls');
  const isVideo = el.localName === 'video';
  // 外面已经有 .md-media（markdown 渲染出来的 / 文件标签页里的）就直接用；模型手写的裸 <video> 套一层
  let host = el.parentElement;
  if (!host?.classList.contains('md-media')) {
    host = document.createElement('span');
    host.className = 'md-media';
    el.before(host);
    host.append(el);
  }
  host.classList.add('mp', isVideo ? 'mp-video' : 'mp-audio');
  host.tabIndex = 0;
  const src = el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
  const name = nameOf(el, src);
  const dl = src ? `<a class="mp-btn" data-act="dl" href="${esc(src)}" download="${esc(name)}" title="下载" aria-label="下载">${svg(P.down, 'i-dl')}</a>` : '';

  const ui = document.createElement('span');
  ui.className = 'mp-ui';
  if (isVideo) {
    ui.innerHTML =
      `<span class="mp-cover" data-act="play"><span class="mp-big">${I_PLAY(32)}</span><span class="mp-spin"></span></span>` +
      '<span class="mp-msg"></span>' +
      `<span class="mp-ctrl">${TRACK}<span class="mp-row">${PLAY_BTN()}<span class="mp-time">0:00 / 0:00</span><span class="mp-grow"></span>` +
      `${SPEED_BTN}<span class="mp-vol">${MUTE_BTN}<span class="mp-vtrack" data-act="vol"><span class="mp-vfill"></span></span></span>` +
      `${dl}${btn('fs', svg(P.fs, 'i-fs') + svg(P.unfs, 'i-unfs'), '全屏（F）')}</span></span>`;
  } else {
    ui.innerHTML =
      PLAY_BTN('mp-round') +
      `<span class="mp-main"><span class="mp-top"><span class="mp-name" title="${esc(name)}">${esc(name || '音频')}</span>` +
      `<span class="mp-time">0:00 / 0:00</span></span>${TRACK}</span>` +
      `${SPEED_BTN}${MUTE_BTN}${dl}`;
  }
  host.append(ui);

  const $ = (s) => ui.querySelector(s);
  const track = $('.mp-track');
  const timeEl = $('.mp-time');
  const speedEl = $('.mp-speed');
  const msgEl = $('.mp-msg') || $('.mp-name');
  const vtrack = $('.mp-vtrack');
  let dragging = false;

  const dur = () => (isFinite(el.duration) ? el.duration : 0);
  const setP = (p) => track.style.setProperty('--p', Math.max(0, Math.min(1, p || 0)));
  function paintTime(t = el.currentTime) {
    timeEl.textContent = `${fmt(t)} / ${fmt(dur())}`;
    if (!dragging) setP(dur() ? t / dur() : 0);
  }
  function paintBuf() {
    const b = el.buffered;
    track.style.setProperty('--b', b.length && dur() ? b.end(b.length - 1) / dur() : 0);
  }
  function paintVol() {
    host.classList.toggle('muted', el.muted || el.volume === 0);
    vtrack?.style.setProperty('--v', el.muted ? 0 : el.volume);
  }
  // 播放的时候用 rAF 刷进度条（timeupdate 一秒才 4 次，条子会一跳一跳的）
  let raf = 0;
  const loop = () => {
    paintTime();
    raf = el.paused ? 0 : requestAnimationFrame(loop);
  };

  el.addEventListener('loadedmetadata', () => (paintTime(), paintBuf()));
  el.addEventListener('durationchange', () => paintTime());
  el.addEventListener('progress', paintBuf);
  el.addEventListener('timeupdate', () => raf || paintTime());
  el.addEventListener('volumechange', paintVol);
  el.addEventListener('play', () => {
    if (current && current !== el && !current.paused) current.pause();
    current = el;
    host.classList.add('playing', 'started');
    raf ||= requestAnimationFrame(loop);
    idleSoon();
  });
  el.addEventListener('pause', () => {
    host.classList.remove('playing', 'idle');
    paintTime();
  });
  el.addEventListener('waiting', () => host.classList.add('wait'));
  for (const ev of ['playing', 'canplay', 'seeked']) el.addEventListener(ev, () => host.classList.remove('wait'));
  const fail = () => {
    host.classList.add('error');
    msgEl.textContent = '没法播放：文件不在了，或者浏览器不支持这种格式';
  };
  el.addEventListener('error', fail);
  el.querySelector('source:last-of-type')?.addEventListener('error', fail);
  if (el.error) fail();

  const toggle = () => (el.paused || el.ended ? el.play().catch(() => {}) : el.pause());
  const seekBy = (s) => dur() && (el.currentTime = Math.max(0, Math.min(dur(), el.currentTime + s)));
  const toggleFs = () => (document.fullscreenElement === host ? document.exitFullscreen() : host.requestFullscreen?.())?.catch?.(() => {});

  // 进度条 / 音量条：按下就跳，按住能拖
  function slider(bar, apply) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const at = (ev) => {
        const r = bar.getBoundingClientRect();
        apply(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), ev.type);
      };
      at(e);
      const move = (ev) => at(ev);
      const up = (ev) => {
        at(ev);
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }
  slider(track, (p, type) => {
    dragging = type !== 'pointerup' && type !== 'pointercancel';
    host.classList.toggle('drag', dragging);
    setP(p);
    if (dur()) {
      el.currentTime = p * dur();
      timeEl.textContent = `${fmt(p * dur())} / ${fmt(dur())}`;
    }
  });
  if (vtrack)
    slider(vtrack, (v) => {
      el.volume = v;
      el.muted = v === 0;
    });

  ui.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'play') toggle();
    else if (a === 'mute') el.muted = !el.muted;
    else if (a === 'fs') toggleFs();
    else if (a === 'speed') {
      const r = SPEEDS[(SPEEDS.indexOf(el.playbackRate) + 1) % SPEEDS.length] || 1;
      el.playbackRate = r;
      speedEl.textContent = r + '×';
      host.classList.toggle('fast', r !== 1);
    }
  });
  if (isVideo) {
    el.addEventListener('click', toggle);
    el.addEventListener('dblclick', toggleFs);
  }
  host.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const onBtn = e.target !== host;
    if ((k === ' ' || k === 'k') && !onBtn) toggle();
    else if (k === 'arrowleft') seekBy(-5);
    else if (k === 'arrowright') seekBy(5);
    else if (k === 'm') el.muted = !el.muted;
    else if (k === 'f' && isVideo) toggleFs();
    else return;
    e.preventDefault();
    e.stopPropagation(); // 别让对话那边把方向键/空格当成滚动
  });

  // 视频播放时，鼠标不动两秒就把控件藏起来
  let idleT = 0;
  function idleSoon() {
    if (!isVideo) return;
    host.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => !el.paused && !dragging && host.classList.add('idle'), 2200);
  }
  if (isVideo) {
    host.addEventListener('pointermove', idleSoon);
    host.addEventListener('pointerleave', () => !el.paused && !dragging && host.classList.add('idle'));
  }

  paintVol();
  if (el.readyState >= 1) paintTime(), paintBuf();
}

function scan(root) {
  if (root.localName === 'video' || root.localName === 'audio') return bind(root);
  if (!root.getElementsByTagName) return;
  for (const tag of ['video', 'audio']) {
    const list = root.getElementsByTagName(tag);
    if (list.length) for (const el of [...list]) bind(el);
  }
}

export function startMediaBinder() {
  scan(document.body);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('fullscreenchange', () => {
    for (const h of document.querySelectorAll('.mp-video.fs')) h.classList.remove('fs');
    document.fullscreenElement?.classList.contains('mp') && document.fullscreenElement.classList.add('fs');
  });
}
