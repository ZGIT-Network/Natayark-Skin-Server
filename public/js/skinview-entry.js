import { SkinViewer, WalkingAnimation, RunningAnimation } from 'skinview3d';

// Interactive preview controls: walk/run, rotation, pause, stop, colors and scenes.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const defaultSkin = '/app/default-skin.png';
const cleanups = [];
function unmount(){cleanups.splice(0).forEach(cleanup=>cleanup());}
function mount(){
unmount();

for (const container of document.querySelectorAll('[data-skin-viewer]')) {
  const viewport = container.querySelector('[data-viewer-viewport]');
  const flat = container.querySelector('[data-viewer-flat]');
  const status = container.querySelector('[data-viewer-status]');
  let skin = container.dataset.skinUrl || defaultSkin;
  let cape = container.dataset.capeUrl || '';
  let model = container.dataset.model === 'slim' ? 'slim' : 'default';
  let flatSkin = container.dataset.flatSkin || '/preview/default?v=4&png';
  let flatCape = container.dataset.flatCape || '';
  let viewer, canvas, generation = 0, visible = false, mode = '3d', failed3d = false, objectUrl;
  const state = { run: false, paused: reducedMotion.matches, rotate: !reducedMotion.matches, stopped: false, scene: -1 };
  const readImage = url => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image unavailable'));
    image.src = url;
  });

  function flatImages() {
    for (const [selector, url] of [['[data-viewer-flat-skin]', flatSkin], ['[data-viewer-flat-cape]', flatCape]]) {
      const img = container.querySelector(selector);
      img.hidden = !url;
      if (url && img.getAttribute('src') !== url) img.src = url;
      if (!url) img.removeAttribute('src');
    }
  }
  function synchronize() {
    container.dataset.animation = state.stopped ? 'stopped' : state.run ? 'run' : 'walk';
    container.dataset.paused = String(state.paused);
    container.dataset.rotating = String(state.rotate && !state.paused && !state.stopped);
    container.dataset.mode = mode;
    for (const action of ['run', 'rotate', 'pause']) {
      const active = state[action === 'pause' ? 'paused' : action];
      container.querySelector(`[data-viewer-action="${action}"]`).setAttribute('aria-pressed', String(active));
    }
    const pause = container.querySelector('[data-viewer-action="pause"]');
    pause.setAttribute('aria-label', state.paused ? '播放动画' : '暂停动画');
    container.querySelector('[data-viewer-play-icon]').hidden = !state.paused;
    container.querySelector('[data-viewer-pause-icon]').hidden = state.paused;
    if (!viewer) return;
    if (state.stopped) viewer.animation = null;
    else if (state.run && !(viewer.animation instanceof RunningAnimation)) {
      viewer.animation = new RunningAnimation(); viewer.animation.speed = 0.6;
    } else if (!state.run && !(viewer.animation instanceof WalkingAnimation)) viewer.animation = new WalkingAnimation();
    if (viewer.animation) viewer.animation.paused = state.paused;
    viewer.autoRotate = state.rotate && !state.paused && !state.stopped;
    viewer.renderPaused = !visible || mode !== '3d' || document.hidden;
  }
  function setMode(next) {
    mode = failed3d ? '2d' : next;
    viewport.hidden = mode === '2d'; flat.hidden = mode !== '2d';
    container.querySelectorAll('[data-viewer-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.viewerMode === mode)));
    if (mode === '2d') flatImages();
    else initialize();
    synchronize();
  }
  async function loadSources() {
    if (!viewer) return;
    const version = ++generation;
    container.dataset.ready = 'false';
    container.dataset.loading = 'true';
    status.hidden = false; status.textContent = '正在加载预览…';
    try {
      const [skinImage, capeImage] = await Promise.all([readImage(skin || defaultSkin), cape ? readImage(cape) : null]);
      if (version !== generation) return;
      viewer.loadSkin(skinImage, { model });
      if (capeImage) viewer.loadCape(capeImage); else viewer.resetCape();
      if (version !== generation) return;
      status.hidden = true;
      container.dataset.loading = 'false';
      container.dataset.ready = 'true';
      synchronize();
    } catch {
      if (version !== generation) return;
      container.dataset.loading = 'false';
      status.textContent = '材质无法加载，请重新选择文件或刷新页面。';
      container.dataset.ready = 'false';
    }
  }
  function initialize() {
    if (viewer || failed3d || !viewport.clientWidth) return;
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', '可拖动和缩放的角色三维预览');
    viewport.appendChild(canvas);
    try {
      viewer = new SkinViewer({ canvas, width: viewport.clientWidth, height: viewport.clientHeight || 380, zoom: 0.7, pixelRatio: Math.min(devicePixelRatio || 1, 2) });
      viewer.controls.enablePan = false;
      viewer.controls.enableRotate = true; viewer.controls.enableZoom = true;
      container.__viewer = viewer;
      synchronize();
      void loadSources();
    } catch {
      failed3d = true;
      canvas.remove();
      container.dataset.fallback = '2d';
      container.dataset.loading = 'false';
      status.textContent = '当前设备无法显示 3D，已切换为 2D 预览。';
      setMode('2d');
    }
  }
  const resize = new ResizeObserver(() => {
    if (viewport.clientWidth && !viewport.hidden) {
      initialize();
      if (viewer) { viewer.width = viewport.clientWidth; viewer.height = viewport.clientHeight || 380; }
    }
  });
  resize.observe(viewport);
  const visibility = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (visible && mode === '3d') initialize(); synchronize(); });
  visibility.observe(container);
  const onPageVisibility = () => synchronize();
  document.addEventListener('visibilitychange', onPageVisibility);
  const onMotion = () => { if (reducedMotion.matches) { state.paused = true; state.rotate = false; synchronize(); } };
  reducedMotion.addEventListener('change', onMotion);

  container.addEventListener('click', async event => {
    const modeButton = event.target.closest('[data-viewer-mode]');
    if (modeButton) { setMode(modeButton.dataset.viewerMode); return; }
    const background = event.target.closest('[data-viewer-background]');
    const action = event.target.closest('[data-viewer-action]')?.dataset.viewerAction;
    if (!viewer) initialize();
    if (background && viewer) {
      const color = background.dataset.viewerBackground;
      viewer.background = color === 'auto' ? null : color;
      container.querySelector('.viewer-stage').style.background = color === 'auto' ? '' : color;
      state.scene = -1;
      container.querySelector('[data-viewer-scene]').textContent = '';
      container.querySelectorAll('[data-viewer-background]').forEach(button => button.setAttribute('aria-pressed', String(button === background)));
    }
    if (action === 'run') { state.run = !state.run; state.stopped = false; }
    else if (action === 'rotate') state.rotate = !state.rotate;
    else if (action === 'pause') { state.paused = !state.paused; if (!state.paused) state.stopped = false; }
    else if (action === 'reset') {
      state.stopped = true; state.paused = true; state.rotate = false;
      if (viewer) { viewer.resetCameraPose(); viewer.zoom = 0.7; viewer.playerObject.rotation.set(0, 0, 0); }
    } else if ((action === 'next-background' || action === 'previous-background') && viewer) {
      state.scene = action === 'next-background' ? (state.scene >= 6 ? 0 : state.scene + 1) : (state.scene <= 0 ? 6 : state.scene - 1);
      try {
        await viewer.loadBackground(`/app/preview-backgrounds/${state.scene + 1}.webp`);
        container.querySelector('.viewer-stage').style.background = `url('/app/preview-backgrounds/${state.scene + 1}.webp') center / cover`;
        container.querySelector('[data-viewer-scene]').textContent = `${state.scene + 1} / 7`;
        container.querySelectorAll('[data-viewer-background]').forEach(button => button.setAttribute('aria-pressed', 'false'));
      } catch { window.UI?.toast('预览背景无法加载', 'error'); }
    }
    synchronize();
  });

  const upload = container.closest('[data-upload-viewer]') && document.getElementById('upload-form');
  if (upload) {
    const update = () => {
      const file = upload.elements.file.files?.[0];
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = file ? URL.createObjectURL(file) : undefined;
      const isCape = upload.elements.type.value === 'cape';
      skin = !isCape && objectUrl ? objectUrl : defaultSkin;
      cape = isCape && objectUrl ? objectUrl : '';
      model = upload.elements.model.value === 'slim' ? 'slim' : 'default';
      flatSkin = !isCape && objectUrl ? objectUrl : '';
      flatCape = isCape && objectUrl ? objectUrl : '';
      container.dataset.model = model;
      flatImages();
      initialize();
      void loadSources();
    };
    upload.addEventListener('change', update);
    cleanups.push(() => upload.removeEventListener('change', update));
  }
  synchronize();
  cleanups.push(() => {
    generation++; resize.disconnect(); visibility.disconnect(); viewer?.dispose();
    document.removeEventListener('visibilitychange', onPageVisibility);
    reducedMotion.removeEventListener('change', onMotion);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
}
}
window.SkinPreviews={mount,unmount};
if(!window.SiteNavigation?.isRendering)mount();
window.addEventListener('pagehide', event => { if (!event.persisted) unmount(); });
