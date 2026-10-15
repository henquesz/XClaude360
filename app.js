const DATA_DIR = '/home/web_user/.local/share';
const MEMCARD_DIR = DATA_DIR + '/Play Data Files/vfs/mc0';
const IMAGE_FILE = 'nfsu2.img';
const META_KEY = 'nfsu2.image';
const FORGET_KEY = 'nfsu2.forget';
const STRETCH_KEY = 'nfsu2.stretch';
const IMPORT_CHUNK = 32 * 1024 * 1024;
// Bumped by build.ps1 on every emulator build so browsers never mix an old Play.wasm with a new Play.js.
const BUILD = '5d3527a58f';

// PlayStation 1 (PCSX-ReARMed via EmulatorJS, servido de vendor/ejs/)
const PS1_IMAGE_FILE = 'ps1.img';
const PS1_IMAGE_KEY = 'ps1.image';
const PS1_BIOS_FILE = 'ps1.bios';
const PS1_BIOS_KEY = 'ps1.bios';
const PS1_BIOS_SIZE = 512 * 1024;
const PS1_DATA_PATH = new URL('vendor/ejs/', location.href).pathname;
const PS1_ACCEPT = '.chd,.pbp,.bin,.img,.iso,.cue,.zip,.7z';
const PS2_ACCEPT = '.iso,.chd,.cso,.isz,.bin';

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
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
  play: $('t-play'),
  playSub: $('play-sub'),
  iso: $('t-iso'),
  isoMain: $('iso-main'),
  isoHint: $('iso-hint'),
  stretchLabel: $('stretch-label'),
  ps1Stage: $('ps1-stage'),
  ps1Play: $('t-ps1-play'),
  ps1PlaySub: $('ps1-play-sub'),
  ps1Iso: $('t-ps1-iso'),
  ps1IsoMain: $('ps1-iso-main'),
  ps1IsoHint: $('ps1-iso-hint'),
  ps1Progress: $('ps1-progress'),
  ps1Bios: $('t-ps1-bios'),
  ps1BiosLabel: $('ps1-bios-label'),
};

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
}

function fail(text) {
  ui.dash.hidden = false;
  ui.dash.classList.remove('busy');
  ui.play.classList.remove('booting');
  ui.ps1Play.classList.remove('booting');
  ui.progress.hidden = true;
  ui.ps1Progress.hidden = true;
  setStatus(text, true);
}

function formatSize(bytes) {
  if (!(bytes > 0)) return '';
  const gb = bytes / 2 ** 30;
  if (gb >= 1) return gb.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' GB';
  const mb = bytes / 2 ** 20;
  if (mb >= 1) return Math.round(mb).toLocaleString('pt-BR') + ' MB';
  return Math.round(bytes / 1024).toLocaleString('pt-BR') + ' KB';
}

function baseName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

// ---------------------------------------------------------------------------
// PS2 emulator (Play!)

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
// Arquivos grandes (imagens de disco, BIOS) guardados uma vez no Origin Private File System

function readMeta(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function bootNameFor(fileName) {
  const ext = extensionOf(fileName) || '.iso';
  return 'nfsu2' + ext;
}

async function opfsRoot() {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try { return await navigator.storage.getDirectory(); } catch { return null; }
}

async function forgetStored(opfsName, metaKey) {
  localStorage.removeItem(metaKey);
  const root = await opfsRoot();
  if (root) {
    try { await root.removeEntry(opfsName); } catch {}
  }
}

// Returns { meta, file } when the stored copy matches what we remember about it, else null.
async function findStored(opfsName, metaKey) {
  const meta = readMeta(metaKey);
  const root = await opfsRoot();
  if (!meta || !root) return null;
  try {
    const file = await (await root.getFileHandle(opfsName)).getFile();
    if (file.size !== meta.size) return null;
    return { meta, file };
  } catch {
    return null;
  }
}

async function storeFile(file, opfsName, metaKey, meta, progress, onProgress) {
  const root = await opfsRoot();
  if (!root) return false;
  if (navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota - usage < file.size + 64 * 1024 * 1024) return false;
  }
  if (navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }

  localStorage.removeItem(metaKey);
  const handle = await root.getFileHandle(opfsName, { create: true });
  const writable = await handle.createWritable();
  progress.hidden = false;
  try {
    for (let offset = 0; offset < file.size; offset += IMPORT_CHUNK) {
      const chunk = await file.slice(offset, offset + IMPORT_CHUNK).arrayBuffer();
      await writable.write(chunk);
      const done = Math.min(offset + IMPORT_CHUNK, file.size);
      progress.value = done / file.size;
      onProgress(`Guardando no navegador… ${Math.floor((done / file.size) * 100)}%`);
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch {}
    try { await root.removeEntry(opfsName); } catch {}
    throw err;
  } finally {
    progress.hidden = true;
  }
  localStorage.setItem(metaKey, JSON.stringify({ size: file.size, name: file.name, ...meta }));
  return true;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    ui.picker.value = '';
    ui.picker.accept = accept;
    ui.picker.onchange = () => resolve(ui.picker.files[0] || null);
    // Fechar o seletor sem escolher não dispara "change"; libera a promise quando a janela recupera o foco.
    const onFocus = () => setTimeout(() => { window.removeEventListener('focus', onFocus); resolve(ui.picker.files[0] || null); }, 500);
    window.addEventListener('focus', onFocus);
    ui.picker.click();
  });
}

// --- PS2: imagem do NFSU2 ---------------------------------------------------

async function findStoredImage() {
  const stored = await findStored(IMAGE_FILE, META_KEY);
  if (!stored) return null;
  const { meta } = stored;
  return { source: { opfsName: IMAGE_FILE }, bootName: meta.bootName, name: meta.name, size: meta.size };
}

// Takes a file the user picked or dropped and turns it into a bootable image (stored when possible).
async function acceptImageFile(file) {
  if (!file) return null;
  ui.iso.classList.remove('ready');
  ui.isoHint.textContent = file.name;
  ui.dash.classList.add('busy');
  try {
    const stored = await storeFile(file, IMAGE_FILE, META_KEY, { bootName: bootNameFor(file.name) }, ui.progress,
      (text) => { ui.isoMain.textContent = text; });
    if (stored) {
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

// --- PS1: jogo e BIOS -------------------------------------------------------

// The OPFS copy has a fixed name; wrap it back in a File with the original name because
// PCSX-ReARMed picks the loader by extension and only recognises BIOS files by name.
async function findStoredPs1(opfsName, metaKey) {
  const stored = await findStored(opfsName, metaKey);
  if (!stored) return null;
  const { meta, file } = stored;
  return { file: new File([file], meta.name), name: meta.name, size: meta.size };
}

async function acceptPs1File(file, opfsName, metaKey, progress, onProgress, what) {
  if (!file) return null;
  ui.dash.classList.add('busy');
  try {
    if (await storeFile(file, opfsName, metaKey, {}, progress, onProgress)) {
      return { file, name: file.name, size: file.size };
    }
    setStatus(`Sem espaço para guardar ${what} no navegador. Vai valer só nesta sessão.`);
  } catch (err) {
    console.warn(err);
    setStatus(`Não deu para guardar ${what} no navegador. Vai valer só nesta sessão.`);
  } finally {
    ui.dash.classList.remove('busy');
  }
  return { file, name: file.name, size: file.size, temporary: true };
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
    if (event.target && event.target.closest && event.target.closest('#toolbar, .ejs_menu_bar')) return;
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
// PS1 via EmulatorJS (PCSX-ReARMed). A runtime é carregada só quando o jogo começa.

// Mesmas teclas da tabela de controles (compartilhada com o PS2). Ids seguem o RetroPad.
const PS1_CONTROLS = {
  0: {
    0: { value: 'z', value2: 'BUTTON_2' },            // Cross
    8: { value: 'x', value2: 'BUTTON_1' },            // Circle
    1: { value: 'a', value2: 'BUTTON_4' },            // Square
    9: { value: 's', value2: 'BUTTON_3' },            // Triangle
    2: { value: 'backspace', value2: 'SELECT' },
    3: { value: 'enter', value2: 'START' },
    4: { value: 'up arrow', value2: 'DPAD_UP' },
    5: { value: 'down arrow', value2: 'DPAD_DOWN' },
    6: { value: 'left arrow', value2: 'DPAD_LEFT' },
    7: { value: 'right arrow', value2: 'DPAD_RIGHT' },
    10: { value: '1', value2: 'LEFT_TOP_SHOULDER' },   // L1
    12: { value: '2', value2: 'LEFT_BOTTOM_SHOULDER' }, // L2
    14: { value: '3', value2: 'LEFT_STICK' },           // L3
    11: { value: '8', value2: 'RIGHT_TOP_SHOULDER' },   // R1
    13: { value: '9', value2: 'RIGHT_BOTTOM_SHOULDER' }, // R2
    15: { value: '0', value2: 'RIGHT_STICK' },          // R3
    16: { value: 'h', value2: 'LEFT_STICK_X:+1' },
    17: { value: 'f', value2: 'LEFT_STICK_X:-1' },
    18: { value: 'g', value2: 'LEFT_STICK_Y:+1' },
    19: { value: 't', value2: 'LEFT_STICK_Y:-1' },
    20: { value: 'l', value2: 'RIGHT_STICK_X:+1' },
    21: { value: 'j', value2: 'RIGHT_STICK_X:-1' },
    22: { value: 'k', value2: 'RIGHT_STICK_Y:+1' },
    23: { value: 'i', value2: 'RIGHT_STICK_Y:-1' },
  },
  1: {}, 2: {}, 3: {},
};

// Opções do core voltadas a velocidade: sem logo de boot, sem frameskip, GPU em thread separada
// (o build com threads já está disponível porque a página é cross-origin isolated).
const PS1_CORE_OPTIONS = {
  pcsx_rearmed_show_bios_bootlogo: 'disabled',
  pcsx_rearmed_frameskip_type: 'disabled',
  pcsx_rearmed_gpu_thread_rendering: 'async',
  pcsx_rearmed_duping_enable: 'enabled',
  pcsx_rearmed_dithering: 'disabled',
  pcsx_rearmed_display_internal_fps: 'disabled',
  pcsx_rearmed_memcard2: 'enabled',
  pcsx_rearmed_pad1type: 'analog',
  pcsx_rearmed_pad2type: 'analog',
  pcsx_rearmed_vibration: 'enabled',
  pcsx_rearmed_show_input_settings: 'enabled',
};

// Aquece o cache HTTP do core enquanto o usuário ainda está no menu.
let ps1Prefetched = false;
function prefetchPs1Core() {
  if (ps1Prefetched) return;
  ps1Prefetched = true;
  const threads = typeof SharedArrayBuffer === 'function';
  const core = `pcsx_rearmed${threads ? '-thread' : ''}-wasm.data`;
  for (const path of ['emulator.min.js', 'emulator.min.css', `cores/${core}`, 'cores/reports/pcsx_rearmed.json', 'compression/extract7z.js']) {
    fetch(PS1_DATA_PATH + path, { priority: 'low' }).catch(() => {});
  }
}

function startPs1(game, bios) {
  window.EJS_player = '#ps1-player';
  window.EJS_core = 'psx';
  window.EJS_pathtodata = PS1_DATA_PATH;
  window.EJS_gameUrl = game.file;
  window.EJS_gameName = baseName(game.name); // chave dos saves/estados no IndexedDB do EmulatorJS
  window.EJS_biosUrl = bios ? bios.file : '';
  window.EJS_threads = typeof SharedArrayBuffer === 'function';
  window.EJS_language = 'pt-BR';
  window.EJS_startOnLoaded = true;
  window.EJS_color = '#2f6fd6';
  window.EJS_backgroundColor = '#000000';
  window.EJS_volume = 0.8;
  window.EJS_defaultControls = PS1_CONTROLS;
  window.EJS_defaultOptions = PS1_CORE_OPTIONS;
  window.EJS_Buttons = { netplay: false, cacheManager: false, screenRecord: false, exitEmulation: true };
  window.EJS_disableDatabases = false;
  window.EJS_ready = () => {
    // O botão de sair (e qualquer falha na inicialização) volta para o menu.
    window.EJS_emulator.on('exit', () => location.reload());
  };
  window.EJS_onGameStart = () => { setStatus(''); };

  const script = document.createElement('script');
  script.src = PS1_DATA_PATH + 'loader.js';
  script.onerror = () => fail('Não deu para carregar o emulador de PS1 (vendor/ejs/loader.js).');
  document.body.appendChild(script);
}

// ---------------------------------------------------------------------------
// Dashboard (menu inicial)

function activeTiles() {
  return ui.dash.querySelector('.pane.is-active .tiles');
}

function showPane(name) {
  for (const tab of ui.dash.querySelectorAll('#dash-nav .tab')) tab.classList.toggle('is-active', tab.dataset.pane === name);
  for (const pane of ui.dash.querySelectorAll('.pane')) pane.classList.toggle('is-active', pane.dataset.pane === name);
  const grid = activeTiles();
  if (!grid) return;
  const active = document.activeElement;
  const current = active && active.classList.contains('tile') && grid.contains(active) ? active : grid.querySelector('.tile-hero');
  focusTile(current);
  if (name === 'ps1') prefetchPs1Core();
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
  for (const other of ui.dash.querySelectorAll('.tile.is-focus')) other.classList.remove('is-focus');
  if (!tile) return;
  tile.classList.add('is-focus');
  tile.focus({ preventScroll: true });
}

// Move o foco no grid pela geometria, como o d-pad do Xbox.
function moveFocus(dx, dy) {
  const grid = activeTiles();
  if (!grid) return;
  const tiles = [...grid.querySelectorAll('.tile:not([disabled])')];
  const current = tiles.find((tile) => tile.classList.contains('is-focus')) || tiles.find((tile) => tile === document.activeElement);
  if (!current) { focusTile(grid.querySelector('.tile-hero')); return; }
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
  const grid = activeTiles();
  const tile = (grid && grid.querySelector('.tile.is-focus')) || document.activeElement;
  if (tile && tile.classList.contains('tile') && !tile.disabled) tile.click();
}

function setupDashInput() {
  // Teclado
  window.addEventListener('keydown', (event) => {
    if (ui.dash.hidden) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT') return;
    const inGrid = !!activeTiles();
    switch (event.key) {
      case 'ArrowLeft': if (inGrid) moveFocus(-1, 0); break;
      case 'ArrowRight': if (inGrid) moveFocus(1, 0); break;
      case 'ArrowUp': if (inGrid) moveFocus(0, -1); break;
      case 'ArrowDown': if (inGrid) moveFocus(0, 1); break;
      case 'Enter': case ' ':
        // preventDefault cancela o clique nativo do botão, então o tile só é ativado uma vez.
        if (inGrid && !ui.dash.classList.contains('busy')) activateFocused();
        break;
      case 'Escape': case 'Backspace': if (currentPane() !== 'inicio') showPane('inicio'); break;
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
  for (const tile of ui.dash.querySelectorAll('.tile')) {
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
    const inGrid = !!activeTiles();
    if ((dx || dy) && now - lastMove > 220) {
      lastMove = now;
      if (inGrid) moveFocus(dx, dx ? 0 : dy);
    } else if (!dx && !dy) {
      lastMove = 0;
    }
    if (edge(0) && inGrid && !ui.dash.classList.contains('busy')) activateFocused();
    if (edge(1) && currentPane() !== 'inicio') showPane('inicio');
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

function setPs1Info(game, bios) {
  if (game) {
    ui.ps1Iso.classList.add('ready');
    ui.ps1IsoMain.textContent = game.name;
    ui.ps1IsoHint.textContent = (game.temporary ? 'Só nesta sessão' : 'Guardado no navegador') +
      (game.size ? ` · ${formatSize(game.size)}` : '') + ' · clique para trocar';
  } else {
    ui.ps1Iso.classList.remove('ready');
    ui.ps1IsoMain.textContent = 'Nenhum jogo';
    ui.ps1IsoHint.textContent = 'Arraste o jogo aqui ou clique para escolher (CHD, PBP, BIN/IMG ou ZIP com BIN+CUE)';
  }
  if (bios) {
    ui.ps1Bios.classList.add('ready');
    ui.ps1BiosLabel.textContent = `BIOS ✓ ${bios.name}`;
    ui.ps1Bios.title = bios.temporary ? 'BIOS só nesta sessão' : 'BIOS guardada no navegador';
  } else {
    ui.ps1Bios.classList.remove('ready');
    ui.ps1BiosLabel.textContent = 'BIOS: escolher';
    ui.ps1Bios.title = 'Arquivo de 512 KB do console, ex. scph5501.bin';
  }
  ui.ps1PlaySub.textContent = !game ? 'Escolha o jogo primeiro' : !bios ? 'Sem BIOS: compatibilidade menor' : 'PlayStation 1';
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
    ui.ps1Play.disabled = true;
    return;
  }
  if (typeof OffscreenCanvas === 'undefined' || !('transferToImageBitmap' in OffscreenCanvas.prototype)) {
    fail('Este navegador não suporta OffscreenCanvas. Use Chrome, Edge ou Firefox atualizados.');
    ui.play.disabled = true;
    return;
  }

  if (localStorage.getItem(FORGET_KEY)) {
    localStorage.removeItem(FORGET_KEY);
    await forgetStored(IMAGE_FILE, META_KEY);
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
    if (!file) file = await pickFile(PS2_ACCEPT);
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
  $('t-ps1').onclick = () => showPane('ps1');
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

  // --- PlayStation 1 ---------------------------------------------------------
  let ps1Game = await findStoredPs1(PS1_IMAGE_FILE, PS1_IMAGE_KEY);
  let ps1Bios = await findStoredPs1(PS1_BIOS_FILE, PS1_BIOS_KEY);
  setPs1Info(ps1Game, ps1Bios);

  const choosePs1Game = async (file) => {
    if (ui.dash.classList.contains('busy')) return;
    if (!file) file = await pickFile(PS1_ACCEPT);
    if (!file) return;
    if (extensionOf(file.name) === '.cue') {
      alert('Um .cue sozinho não serve: ele só aponta para os .bin. Compacte o .cue e os .bin juntos num ZIP, ou use CHD/PBP.');
      return;
    }
    if (ps1Game && !ps1Game.temporary && !confirm(`Trocar o jogo guardado (${ps1Game.name}) por ${file.name}?`)) return;
    ui.ps1Iso.classList.remove('ready');
    ui.ps1IsoHint.textContent = file.name;
    const next = await acceptPs1File(file, PS1_IMAGE_FILE, PS1_IMAGE_KEY, ui.ps1Progress,
      (text) => { ui.ps1IsoMain.textContent = text; }, 'o jogo');
    if (next) ps1Game = next;
    setPs1Info(ps1Game, ps1Bios);
    focusTile(ui.ps1Play);
  };

  const choosePs1Bios = async (file) => {
    if (ui.dash.classList.contains('busy')) return;
    if (!file) file = await pickFile('.bin,.rom');
    if (!file) return;
    if (file.size !== PS1_BIOS_SIZE && !confirm(`Uma BIOS de PS1 tem 512 KB e ${file.name} tem ${formatSize(file.size)}. Usar mesmo assim?`)) return;
    ui.ps1BiosLabel.textContent = 'Guardando…';
    const next = await acceptPs1File(file, PS1_BIOS_FILE, PS1_BIOS_KEY, ui.ps1Progress, () => {}, 'a BIOS');
    if (next) ps1Bios = next;
    setPs1Info(ps1Game, ps1Bios);
    focusTile(ui.ps1Play);
  };

  const bootPs1 = async () => {
    if (ui.dash.classList.contains('busy')) return;
    if (!ps1Game) { await choosePs1Game(); if (!ps1Game) return; }
    if (!ps1Bios && !confirm('Nenhuma BIOS escolhida. O PCSX-ReARMed usa uma BIOS simulada, mas vários jogos travam ou perdem o save sem a original. Continuar sem BIOS?')) {
      await choosePs1Bios();
      if (!ps1Bios) return;
    }
    ui.dash.classList.add('busy');
    ui.ps1Play.classList.add('booting');
    setStatus('Carregando o PCSX-ReARMed…');
    if (dash.avatar) dash.avatar.stop();
    ui.stage.hidden = true;        // o canvas do PS2 fica fora do caminho
    ui.ps1Stage.hidden = false;
    ui.dash.hidden = true;
    fullscreenOnFirstInput();
    startPs1(ps1Game, ps1Bios);
  };

  ui.ps1Play.onclick = bootPs1;
  ui.ps1Iso.onclick = () => choosePs1Game();
  ui.ps1Bios.onclick = () => choosePs1Bios();
  $('t-ps1-back').onclick = () => showPane('inicio');
  $('t-ps1-help').onclick = () => showPane('controles');
  $('t-ps1-about').onclick = () => showPane('sobre');
  $('t-ps1-fullscreen').onclick = toggleFullscreen;
  $('t-ps1-forget').onclick = async () => {
    if (!ps1Game) { choosePs1Game(); return; }
    if (!confirm(`Apagar ${ps1Game.name} do navegador? Os saves ficam guardados.`)) return;
    await forgetStored(PS1_IMAGE_FILE, PS1_IMAGE_KEY);
    ps1Game = null;
    setPs1Info(ps1Game, ps1Bios);
  };
  $('t-ps1-forget-bios').onclick = async () => {
    if (!ps1Bios) { choosePs1Bios(); return; }
    if (!confirm(`Apagar a BIOS ${ps1Bios.name} do navegador?`)) return;
    await forgetStored(PS1_BIOS_FILE, PS1_BIOS_KEY);
    ps1Bios = null;
    setPs1Info(ps1Game, ps1Bios);
  };

  // Arrastar um arquivo para qualquer lugar do menu cai no tile certo da aba aberta.
  // Na aba PS1, um arquivo de exatamente 512 KB é tratado como BIOS.
  const dropTarget = () => (currentPane() === 'ps1' ? ui.ps1Iso : ui.iso);
  let dragDepth = 0;
  ui.dash.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; dropTarget().classList.add('drag'); });
  ui.dash.addEventListener('dragover', (event) => { event.preventDefault(); });
  ui.dash.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; ui.iso.classList.remove('drag'); ui.ps1Iso.classList.remove('drag'); }
  });
  ui.dash.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.iso.classList.remove('drag');
    ui.ps1Iso.classList.remove('drag');
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (currentPane() === 'ps1') {
      if (file.size === PS1_BIOS_SIZE) choosePs1Bios(file);
      else choosePs1Game(file);
    } else {
      chooseImage(file);
    }
  });
}

main().catch((err) => {
  console.error(err);
  fail('Erro: ' + (err && err.message || err));
});
