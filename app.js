const DATA_DIR = '/home/web_user/.local/share';
const MEMCARD_DIR = DATA_DIR + '/Play Data Files/vfs/mc0';
const IMAGE_FILE = 'nfsu2.img';
const META_KEY = 'nfsu2.image';
const FORGET_KEY = 'nfsu2.forget';
const STRETCH_KEY = 'nfsu2.stretch';
const IMPORT_CHUNK = 32 * 1024 * 1024;
// Bumped by build.ps1 on every emulator build so browsers never mix an old Play.wasm with a new Play.js.
const BUILD = '64a0346909';

const $ = (id) => document.getElementById(id);
const ui = {
  screen: $('screen'),
  fps: $('fps'),
  dash: $('dash'),
  status: $('status'),
  picker: $('picker'),
  progress: $('progress'),
  toolbar: $('toolbar'),
  help: $('help'),
  importFile: $('import-file'),
  avatar: $('avatar'),
  avatarWrap: $('avatar-wrap'),
  tiles: $('tiles'),
  play: $('t-play'),
  playSub: $('play-sub'),
  iso: $('t-iso'),
  isoMain: $('iso-main'),
  isoHint: $('iso-hint'),
  stretchLabel: $('stretch-label'),
};

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
}

function fail(text) {
  ui.dash.hidden = false;
  ui.dash.classList.remove('busy');
  ui.play.classList.remove('booting');
  ui.progress.hidden = true;
  setStatus(text, true);
}

function formatSize(bytes) {
  if (!(bytes > 0)) return '';
  const gb = bytes / 2 ** 30;
  if (gb >= 1) return gb.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' GB';
  return Math.round(bytes / 2 ** 20).toLocaleString('pt-BR') + ' MB';
}

// ---------------------------------------------------------------------------
// Emulator

async function createEmulator() {
  const { default: Play } = await import(`./Play.js?v=${BUILD}`);
  const output = ui.screen.getContext('bitmaprenderer');
  const module = await Play({
    locateFile: (path) => new URL(`${path}?v=${BUILD}`, location.href).href,
    mainScriptUrlOrBlob: new URL(`Play.js?v=${BUILD}`, location.href).href,
    // Frames rendered on the GS thread arrive here as ImageBitmaps (see nfsu2_library.js).
    nfsu2PresentFrame: (bitmap) => output.transferFromImageBitmap(bitmap),
  });

  // Config and memory cards live under DATA_DIR, keep them in IndexedDB.
  const { FS } = module;
  FS.mkdirTree(DATA_DIR);
  try {
    FS.mount(module.IDBFS || FS.filesystems.IDBFS, {}, DATA_DIR);
    await new Promise((resolve, reject) => FS.syncfs(true, (err) => (err ? reject(err) : resolve())));
  } catch (err) {
    console.warn('Saves will not persist:', err);
  }
  try { FS.mkdir('/work'); } catch {}

  module.ccall('initVm', '', [], []);
  window.nfsu2 = module; // handy from the devtools console
  return module;
}

function startDiscWorker(module, source) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('disc-worker.js', location.href));
    worker.onmessage = (event) => {
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(worker);
    };
    worker.onerror = (event) => reject(new Error(event.message || 'disc-worker failed'));
    worker.postMessage({
      memory: module.nfsu2GetMemory(),
      controlPtr: module.getDiscIoControl(),
      source,
    });
  });
}

function startStats(module) {
  setInterval(() => {
    const frames = module.getFrames();
    module.clearStats();
    ui.fps.textContent = `${frames} fps`;
  }, 1000);
}

// ---------------------------------------------------------------------------
// Disc image, stored once in the Origin Private File System

function readMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { return null; }
}

function bootNameFor(fileName) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot === -1 ? '.iso' : fileName.slice(dot).toLowerCase();
  return 'nfsu2' + ext;
}

async function opfsRoot() {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try { return await navigator.storage.getDirectory(); } catch { return null; }
}

async function forgetStoredImage() {
  localStorage.removeItem(META_KEY);
  const root = await opfsRoot();
  if (root) {
    try { await root.removeEntry(IMAGE_FILE); } catch {}
  }
}

async function findStoredImage() {
  const meta = readMeta();
  const root = await opfsRoot();
  if (!meta || !root) return null;
  try {
    const file = await (await root.getFileHandle(IMAGE_FILE)).getFile();
    if (file.size !== meta.size) return null;
    return { source: { opfsName: IMAGE_FILE }, bootName: meta.bootName, name: meta.name, size: meta.size };
  } catch {
    return null;
  }
}

async function storeImage(file) {
  const root = await opfsRoot();
  if (!root) return false;
  if (navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota - usage < file.size + 64 * 1024 * 1024) return false;
  }
  if (navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }

  localStorage.removeItem(META_KEY);
  const handle = await root.getFileHandle(IMAGE_FILE, { create: true });
  const writable = await handle.createWritable();
  ui.progress.hidden = false;
  try {
    for (let offset = 0; offset < file.size; offset += IMPORT_CHUNK) {
      const chunk = await file.slice(offset, offset + IMPORT_CHUNK).arrayBuffer();
      await writable.write(chunk);
      const done = Math.min(offset + IMPORT_CHUNK, file.size);
      ui.progress.value = done / file.size;
      ui.isoMain.textContent = `Guardando no navegador… ${Math.floor((done / file.size) * 100)}%`;
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch {}
    try { await root.removeEntry(IMAGE_FILE); } catch {}
    throw err;
  } finally {
    ui.progress.hidden = true;
  }
  localStorage.setItem(META_KEY, JSON.stringify({ size: file.size, bootName: bootNameFor(file.name), name: file.name }));
  return true;
}

// Takes a file the user picked or dropped and turns it into a bootable image (stored when possible).
async function acceptImageFile(file) {
  if (!file) return null;
  ui.iso.classList.remove('ready');
  ui.isoHint.textContent = file.name;
  ui.dash.classList.add('busy');
  try {
    if (await storeImage(file)) {
      return { source: { opfsName: IMAGE_FILE }, bootName: bootNameFor(file.name), name: file.name, size: file.size };
    }
    setStatus('Sem espaço para guardar a ISO no navegador. Ela vai rodar só nesta sessão.');
  } catch (err) {
    console.warn(err);
    setStatus('Não deu para guardar a ISO no navegador. Ela vai rodar só nesta sessão.');
  } finally {
    ui.dash.classList.remove('busy');
  }
  return { source: { file }, bootName: bootNameFor(file.name), name: file.name, size: file.size, temporary: true };
}

function pickImageFile() {
  return new Promise((resolve) => {
    ui.picker.value = '';
    ui.picker.onchange = () => resolve(ui.picker.files[0] || null);
    // Fechar o seletor sem escolher não dispara "change"; libera a promise quando a janela recupera o foco.
    const onFocus = () => setTimeout(() => { window.removeEventListener('focus', onFocus); resolve(ui.picker.files[0] || null); }, 500);
    window.addEventListener('focus', onFocus);
    ui.picker.click();
  });
}

// ---------------------------------------------------------------------------
// Saves (memory card), persisted with IDBFS and exportable as JSON

let syncing = false;
let syncAgain = false;
function syncSaves(module) {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  module.FS.syncfs(false, (err) => {
    syncing = false;
    if (err) console.warn('syncfs failed:', err);
    if (syncAgain) { syncAgain = false; syncSaves(module); }
  });
}

function startSaveSync(module) {
  setInterval(() => syncSaves(module), 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncSaves(module);
  });
  window.addEventListener('pagehide', () => syncSaves(module));
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function collectFiles(FS, dir, prefix, out) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = dir + '/' + name;
    if (FS.isDir(FS.stat(path).mode)) collectFiles(FS, path, prefix + name + '/', out);
    else out.push({ path: prefix + name, b64: toBase64(FS.readFile(path)) });
  }
}

function exportSaves(module) {
  const files = [];
  try { collectFiles(module.FS, MEMCARD_DIR, '', files); } catch {}
  if (files.length === 0) {
    alert('Ainda não há save no memory card. Salve no jogo primeiro.');
    return;
  }
  const blob = new Blob([JSON.stringify({ v: 1, files })], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `nfsu2-save-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

async function importSaves(module, file) {
  const { files } = JSON.parse(await file.text());
  const { FS } = module;
  for (const entry of files) {
    if (entry.path.includes('..')) continue;
    const full = MEMCARD_DIR + '/' + entry.path;
    FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    FS.writeFile(full, Uint8Array.from(atob(entry.b64), (c) => c.charCodeAt(0)));
  }
  await new Promise((resolve) => FS.syncfs(false, () => resolve()));
  location.reload();
}

// ---------------------------------------------------------------------------
// In-game UI

function enterFullscreen() {
  if (document.fullscreenElement) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else enterFullscreen();
}

// Browsers only allow fullscreen from a user gesture, so go fullscreen on the first key or click.
function fullscreenOnFirstInput() {
  const handler = (event) => {
    if (event.type === 'keydown' && event.key === 'Escape') return;
    window.removeEventListener('keydown', handler, true);
    window.removeEventListener('pointerdown', handler, true);
    if (event.target && event.target.closest && event.target.closest('#toolbar')) return;
    enterFullscreen();
  };
  window.addEventListener('keydown', handler, true);
  window.addEventListener('pointerdown', handler, true);
}

function setStretch(enabled) {
  document.body.classList.toggle('stretch', enabled);
  ui.stretchLabel.textContent = enabled ? 'Esticar 16:9 ✓' : 'Esticar 16:9';
  try { localStorage.setItem(STRETCH_KEY, enabled ? '1' : ''); } catch {}
}

function forgetAndReload(module) {
  if (!confirm('Apagar a ISO guardada no navegador e escolher outra?')) return;
  if (module) syncSaves(module);
  localStorage.setItem(FORGET_KEY, '1');
  location.reload();
}

function setupToolbar(module) {
  ui.toolbar.hidden = false;
  let idleTimer = 0;
  const wake = () => {
    document.body.classList.add('ui');
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!ui.help.hidden) return;
      document.body.classList.remove('ui');
      document.body.classList.add('idle');
    }, 2500);
  };
  window.addEventListener('mousemove', wake);
  wake();

  $('btn-fullscreen').onclick = toggleFullscreen;
  $('btn-stretch').onclick = () => setStretch(!document.body.classList.contains('stretch'));
  ui.screen.ondblclick = toggleFullscreen;
  $('btn-help').onclick = () => { ui.help.hidden = !ui.help.hidden; wake(); };
  $('btn-export').onclick = () => exportSaves(module);
  $('btn-import').onclick = () => ui.importFile.click();
  ui.importFile.onchange = () => {
    const file = ui.importFile.files[0];
    if (file) importSaves(module, file).catch((err) => alert('Save inválido: ' + err.message));
  };
  $('btn-forget').onclick = () => forgetAndReload(module);
}

// ---------------------------------------------------------------------------
// Dashboard (menu inicial)

function showPane(name) {
  for (const tab of ui.dash.querySelectorAll('#dash-nav .tab')) tab.classList.toggle('is-active', tab.dataset.pane === name);
  for (const pane of ui.dash.querySelectorAll('.pane')) pane.classList.toggle('is-active', pane.dataset.pane === name);
  if (name === 'inicio') focusTile(document.activeElement && document.activeElement.classList.contains('tile') ? document.activeElement : ui.play);
}

function currentPane() {
  const tab = ui.dash.querySelector('#dash-nav .tab.is-active');
  return tab ? tab.dataset.pane : 'inicio';
}

function stepPane(delta) {
  const tabs = [...ui.dash.querySelectorAll('#dash-nav .tab')];
  const index = tabs.findIndex((tab) => tab.classList.contains('is-active'));
  showPane(tabs[(index + delta + tabs.length) % tabs.length].dataset.pane);
}

function focusTile(tile) {
  for (const other of ui.tiles.querySelectorAll('.tile.is-focus')) other.classList.remove('is-focus');
  if (!tile) return;
  tile.classList.add('is-focus');
  tile.focus({ preventScroll: true });
}

// Move o foco no grid pela geometria, como o d-pad do Xbox.
function moveFocus(dx, dy) {
  const tiles = [...ui.tiles.querySelectorAll('.tile:not([disabled])')];
  const current = tiles.find((tile) => tile.classList.contains('is-focus')) || tiles.find((tile) => tile === document.activeElement);
  if (!current) { focusTile(ui.play); return; }
  const from = current.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const tile of tiles) {
    if (tile === current) continue;
    const rect = tile.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let primary;
    let secondary;
    if (dx) { primary = (cx - fx) * dx; secondary = Math.abs(cy - fy); }
    else { primary = (cy - fy) * dy; secondary = Math.abs(cx - fx); }
    if (primary <= 1) continue;
    const score = primary + secondary * 2;
    if (score < bestScore) { bestScore = score; best = tile; }
  }
  if (best) focusTile(best);
}

function activateFocused() {
  const tile = ui.tiles.querySelector('.tile.is-focus') || document.activeElement;
  if (tile && tile.classList.contains('tile') && !tile.disabled) tile.click();
}

function setupDashInput() {
  // Teclado
  window.addEventListener('keydown', (event) => {
    if (ui.dash.hidden) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT') return;
    const inGrid = currentPane() === 'inicio';
    switch (event.key) {
      case 'ArrowLeft': if (inGrid) moveFocus(-1, 0); break;
      case 'ArrowRight': if (inGrid) moveFocus(1, 0); break;
      case 'ArrowUp': if (inGrid) moveFocus(0, -1); break;
      case 'ArrowDown': if (inGrid) moveFocus(0, 1); break;
      case 'Enter': case ' ':
        // preventDefault cancela o clique nativo do botão, então o tile só é ativado uma vez.
        if (inGrid && !ui.dash.classList.contains('busy')) activateFocused();
        break;
      case 'Escape': case 'Backspace': if (!inGrid) showPane('inicio'); break;
      case 'q': case 'Q': stepPane(-1); break;
      case 'e': case 'E': stepPane(1); break;
      default: return;
    }
    event.preventDefault();
  });

  // Espaço dispara o clique nativo no keyup; cancela para não ativar duas vezes.
  window.addEventListener('keyup', (event) => {
    if (!ui.dash.hidden && event.key === ' ' && event.target && event.target.classList && event.target.classList.contains('tile')) event.preventDefault();
  });

  // Mouse: passar por cima já foca o tile, como no dashboard.
  for (const tile of ui.tiles.querySelectorAll('.tile')) {
    tile.addEventListener('pointerenter', () => { if (!tile.disabled && !ui.dash.classList.contains('busy')) focusTile(tile); });
  }
  for (const tab of ui.dash.querySelectorAll('#dash-nav .tab')) {
    tab.onclick = () => showPane(tab.dataset.pane);
  }

  // Controle (Gamepad API): d-pad/analógico navega, A seleciona, B volta, LB/RB trocam de aba.
  const held = new Set();
  let lastMove = 0;
  const poll = () => {
    if (ui.dash.hidden) return;
    requestAnimationFrame(poll);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return;
    const now = performance.now();
    const pressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const edge = (i) => { const on = pressed(i); const was = held.has(i); if (on) held.add(i); else held.delete(i); return on && !was; };
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const dx = pressed(15) || ax > 0.5 ? 1 : pressed(14) || ax < -0.5 ? -1 : 0;
    const dy = pressed(13) || ay > 0.5 ? 1 : pressed(12) || ay < -0.5 ? -1 : 0;
    const inGrid = currentPane() === 'inicio';
    if ((dx || dy) && now - lastMove > 220) {
      lastMove = now;
      if (inGrid) moveFocus(dx, dx ? 0 : dy);
    } else if (!dx && !dy) {
      lastMove = 0;
    }
    if (edge(0) && inGrid && !ui.dash.classList.contains('busy')) activateFocused();
    if (edge(1) && !inGrid) showPane('inicio');
    if (edge(4)) stepPane(-1);
    if (edge(5)) stepPane(1);
  };
  window.addEventListener('gamepadconnected', () => requestAnimationFrame(poll), { once: true });
  if (navigator.getGamepads && [...navigator.getGamepads()].some((p) => p)) requestAnimationFrame(poll);
}

function setImageInfo(image) {
  if (image) {
    ui.iso.classList.add('ready');
    ui.isoMain.textContent = image.name || 'ISO guardada';
    ui.isoHint.textContent = (image.temporary ? 'Só nesta sessão' : 'Guardada no navegador') +
      (image.size ? ` · ${formatSize(image.size)}` : '') + ' · clique para trocar';
    ui.playSub.textContent = 'Need for Speed: Underground 2';
  } else {
    ui.iso.classList.remove('ready');
    ui.isoMain.textContent = 'Nenhuma ISO';
    ui.isoHint.textContent = 'Arraste a ISO aqui ou clique para escolher (ISO, CHD, CSO, ISZ ou BIN)';
    ui.playSub.textContent = 'Escolha a ISO primeiro';
  }
}

function loadAvatar() {
  import('./avatar.js')
    .then(({ createAvatar }) => {
      const avatar = createAvatar(ui.avatar);
      if (!avatar) ui.avatarWrap.hidden = true;
      return avatar;
    })
    .catch((err) => {
      console.warn('Avatar não carregou:', err);
      ui.avatarWrap.hidden = true;
      return null;
    })
    .then((avatar) => { dash.avatar = avatar; });
}

const dash = { avatar: null };

// ---------------------------------------------------------------------------

async function main() {
  setupDashInput();
  loadAvatar();
  setStretch(localStorage.getItem(STRETCH_KEY) === '1');
  focusTile(ui.play);

  if (!window.crossOriginIsolated) {
    fail('O servidor não enviou os headers COOP/COEP. Sem eles o emulador não roda.');
    ui.play.disabled = true;
    return;
  }
  if (typeof OffscreenCanvas === 'undefined' || !('transferToImageBitmap' in OffscreenCanvas.prototype)) {
    fail('Este navegador não suporta OffscreenCanvas. Use Chrome, Edge ou Firefox atualizados.');
    ui.play.disabled = true;
    return;
  }

  if (localStorage.getItem(FORGET_KEY)) {
    localStorage.removeItem(FORGET_KEY);
    await forgetStoredImage();
  }

  // Start downloading/compiling the emulator while we look for the disc image.
  let emulatorReady = false;
  const emulator = createEmulator();
  emulator.then(() => { emulatorReady = true; if (!ui.dash.classList.contains('busy')) setStatus('Pronto. Aperte Jogar.'); })
    .catch((err) => { console.error(err); setStatus('Erro ao carregar o emulador: ' + (err && err.message || err), true); });

  setStatus('Carregando o emulador…');
  let image = await findStoredImage();
  setImageInfo(image);
  let module = null;

  const chooseImage = async (file) => {
    if (ui.dash.classList.contains('busy')) return;
    if (!file) file = await pickImageFile();
    if (!file) return;
    if (image && !image.temporary && !confirm(`Trocar a ISO guardada (${image.name}) por ${file.name}?`)) return;
    const next = await acceptImageFile(file);
    if (next) { image = next; setImageInfo(image); }
    focusTile(ui.play);
  };

  const boot = async () => {
    if (ui.dash.classList.contains('busy')) return;
    if (!image) { await chooseImage(); if (!image) return; }
    ui.dash.classList.add('busy');
    ui.play.classList.add('booting');
    try {
      setStatus(emulatorReady ? 'Iniciando…' : 'Carregando o emulador…');
      module = await emulator;
      setStatus('Abrindo a imagem do jogo…');
      await startDiscWorker(module, image.source);
    } catch (err) {
      console.error(err);
      fail('Erro: ' + (err && err.message || err));
      return;
    }

    if (dash.avatar) dash.avatar.stop();
    ui.dash.hidden = true;
    fullscreenOnFirstInput();
    module.bootDiscImage(image.bootName);
    startStats(module);
    startSaveSync(module);
    setupToolbar(module);
  };

  ui.play.onclick = boot;
  ui.iso.onclick = () => chooseImage();
  $('t-help').onclick = () => showPane('controles');
  $('t-about').onclick = () => showPane('sobre');
  $('t-export').onclick = async () => {
    try { exportSaves(await emulator); }
    catch (err) { alert('O emulador ainda não carregou: ' + (err && err.message || err)); }
  };
  $('t-import').onclick = () => {
    ui.importFile.onchange = async () => {
      const file = ui.importFile.files[0];
      if (!file) return;
      try {
        setStatus('Importando save…');
        await importSaves(await emulator, file);
      } catch (err) { alert('Save inválido: ' + err.message); setStatus('Pronto. Aperte Jogar.'); }
    };
    ui.importFile.click();
  };
  $('t-fullscreen').onclick = toggleFullscreen;
  $('t-stretch').onclick = () => setStretch(!document.body.classList.contains('stretch'));
  $('t-forget').onclick = () => forgetAndReload(module);

  // Arrastar a ISO para qualquer lugar do menu cai no tile da imagem.
  let dragDepth = 0;
  ui.dash.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; ui.iso.classList.add('drag'); });
  ui.dash.addEventListener('dragover', (event) => { event.preventDefault(); });
  ui.dash.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.iso.classList.remove('drag'); } });
  ui.dash.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.iso.classList.remove('drag');
    chooseImage(event.dataTransfer.files[0]);
  });
}

main().catch((err) => {
  console.error(err);
  fail('Erro: ' + (err && err.message || err));
});
