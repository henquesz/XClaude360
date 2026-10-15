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

// Biblioteca: catálogo do site (library/games.json) + cópias baixadas no OPFS
const LIB_CATALOG_URL = 'library/games.json';
const LIB_FILE_PREFIX = 'lib-';    // nome do arquivo no OPFS
const LIB_META_PREFIX = 'lib.';    // chave no localStorage
const LIB_SORT_KEY = 'lib.sort';
const LIB_SORTS = [
  { key: 'titulos', label: 'títulos' },
  { key: 'sistema', label: 'sistema' },
  { key: 'navegador', label: 'no navegador' },
];

const PANES = ['ps2', 'ps1', 'config'];

// Fundo animado do menu (port do Gradient ASCII do React Bits): verde, discreto, atrás dos tiles.
// Dá para ajustar ao vivo no console: nfsuBackground.update({ glyphOpacity: 0.5 })
const BACKGROUND = {
  colors: ['#06260b', '#0f6b1a', '#1aa41a', '#7fdc6a'],
  shape: 'rise',
  characters: ' .:-=+x*#%@',
  cellSize: 16,
  density: 0.75,
  glyphOpacity: 0.8,
  gradientOpacity: 0.6,
  glow: 0.2,
  flicker: 0.15,
  softness: 0.6,
  flow: 0.45,
  speed: 0.6,
  grain: 0.04,
  scrambleRadius: 0.08,
  clickEffect: 'wave',
  dpr: 1.5,
};

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
  play: $('t-play'),
  playSub: $('play-sub'),
  iso: $('t-iso'),
  isoMain: $('iso-main'),
  isoHint: $('iso-hint'),
  stretchLabel: $('stretch-label'),
  cfgStretchLabel: $('cfg-stretch-label'),
  cfgStorageLabel: $('cfg-storage-label'),
  ps1Stage: $('ps1-stage'),
  ps1Play: $('t-ps1-play'),
  ps1PlaySub: $('ps1-play-sub'),
  ps1Iso: $('t-ps1-iso'),
  ps1IsoMain: $('ps1-iso-main'),
  ps1IsoHint: $('ps1-iso-hint'),
  ps1Progress: $('ps1-progress'),
  ps1Bios: $('t-ps1-bios'),
  ps1BiosLabel: $('ps1-bios-label'),
  dashBg: $('dash-bg'),
  stPads: $('st-pads'),
  stGames: $('st-games'),
  stClock: $('st-clock'),
  library: $('library'),
  libStrip: $('lib-strip'),
  libEmpty: $('lib-empty'),
  libSort: $('lib-sort'),
  libSortLabel: $('lib-sort-label'),
  libStatus: $('lib-status'),
};

// Estado compartilhado entre o menu, a biblioteca e os dois emuladores.
const state = {
  image: null,        // ISO do PS2 guardada no slot principal
  ps1Game: null,      // jogo de PS1 guardado no slot principal
  ps1Bios: null,
  emulator: null,     // Promise do módulo Play!
  emulatorReady: false,
  module: null,
  catalog: [],
  background: null,   // fundo animado do menu
};

function loadBackground() {
  import('./gradient-ascii.js')
    .then(({ createGradientAscii }) => {
      if (ui.dash.hidden) return;
      state.background = createGradientAscii(ui.dashBg, BACKGROUND);
      window.nfsuBackground = state.background;
    })
    .catch((err) => console.warn('Fundo animado indisponível:', err));
}

// O emulador precisa da GPU inteira: o fundo é destruído quando um jogo começa.
function stopBackground() {
  if (state.background) state.background.stop();
  state.background = null;
  window.nfsuBackground = null;
}

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

async function ensureSpace(bytes) {
  if (!navigator.storage) return true;
  if (navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota - usage < bytes + 64 * 1024 * 1024) return false;
  }
  if (navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
  return true;
}

async function storeFile(file, opfsName, metaKey, meta, progress, onProgress) {
  const root = await opfsRoot();
  if (!root) return false;
  if (!(await ensureSpace(file.size))) return false;

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

// Baixa um arquivo direto para o OPFS, em streaming (nunca segura o jogo inteiro na memória).
async function downloadToOpfs(url, opfsName, metaKey, meta, expectedSize, onProgress) {
  const root = await opfsRoot();
  if (!root) throw new Error('Este navegador não consegue guardar arquivos (OPFS indisponível).');
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('O servidor do arquivo não respondeu ou não permite download pelo navegador (CORS).');
  }
  if (!response.ok || !response.body) throw new Error(`O servidor do arquivo respondeu ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || expectedSize || 0;
  if (total && !(await ensureSpace(total))) throw new Error(`Sem espaço no navegador para ${formatSize(total)}.`);

  localStorage.removeItem(metaKey);
  const handle = await root.getFileHandle(opfsName, { create: true });
  const writable = await handle.createWritable();
  let done = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      await writable.write(value);
      done += value.byteLength;
      onProgress(done, total);
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch {}
    try { await root.removeEntry(opfsName); } catch {}
    throw err;
  }
  localStorage.setItem(metaKey, JSON.stringify({ ...meta, size: done }));
  return done;
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
  const label = enabled ? 'Esticar 16:9 ✓' : 'Esticar 16:9';
  ui.stretchLabel.textContent = label;
  ui.cfgStretchLabel.textContent = label;
  try { localStorage.setItem(STRETCH_KEY, enabled ? '1' : ''); } catch {}
}

function toggleStretch() {
  setStretch(!document.body.classList.contains('stretch'));
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
  $('btn-stretch').onclick = toggleStretch;
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
// Iniciar os jogos (chamado pelos tiles e pela biblioteca)

async function bootPs2(image) {
  if (ui.dash.classList.contains('busy')) return;
  if (!image) return;
  showPane('ps2');
  ui.dash.classList.add('busy');
  ui.play.classList.add('booting');
  try {
    setStatus(state.emulatorReady ? 'Iniciando…' : 'Carregando o emulador…');
    state.module = await state.emulator;
    setStatus('Abrindo a imagem do jogo…');
    await startDiscWorker(state.module, image.source);
  } catch (err) {
    console.error(err);
    fail('Erro: ' + (err && err.message || err));
    return;
  }

  const { module } = state;
  stopBackground();
  ui.dash.hidden = true;
  fullscreenOnFirstInput();
  module.bootDiscImage(image.bootName);
  startStats(module);
  startSaveSync(module);
  setupToolbar(module);
}

async function bootPs1(game) {
  if (ui.dash.classList.contains('busy')) return;
  if (!game) return;
  if (!state.ps1Bios && !confirm('Nenhuma BIOS escolhida. O PCSX-ReARMed usa uma BIOS simulada, mas vários jogos travam ou perdem o save sem a original. Continuar sem BIOS?')) {
    showPane('ps1');
    await choosePs1Bios();
    if (!state.ps1Bios) return;
  }
  showPane('ps1');
  ui.dash.classList.add('busy');
  ui.ps1Play.classList.add('booting');
  setStatus('Carregando o PCSX-ReARMed…');
  ui.stage.hidden = true;        // o canvas do PS2 fica fora do caminho
  ui.ps1Stage.hidden = false;
  stopBackground();
  ui.dash.hidden = true;
  fullscreenOnFirstInput();
  startPs1(game, state.ps1Bios);
}

async function chooseImage(file) {
  if (ui.dash.classList.contains('busy')) return;
  if (!file) file = await pickFile(PS2_ACCEPT);
  if (!file) return;
  const { image } = state;
  if (image && !image.temporary && !confirm(`Trocar a ISO guardada (${image.name}) por ${file.name}?`)) return;
  const next = await acceptImageFile(file);
  if (next) { state.image = next; setImageInfo(); }
  focusTile(ui.play);
  updateCounts();
}

async function choosePs1Game(file) {
  if (ui.dash.classList.contains('busy')) return;
  if (!file) file = await pickFile(PS1_ACCEPT);
  if (!file) return;
  if (extensionOf(file.name) === '.cue') {
    alert('Um .cue sozinho não serve: ele só aponta para os .bin. Compacte o .cue e os .bin juntos num ZIP, ou use CHD/PBP.');
    return;
  }
  const game = state.ps1Game;
  if (game && !game.temporary && !confirm(`Trocar o jogo guardado (${game.name}) por ${file.name}?`)) return;
  ui.ps1Iso.classList.remove('ready');
  ui.ps1IsoHint.textContent = file.name;
  const next = await acceptPs1File(file, PS1_IMAGE_FILE, PS1_IMAGE_KEY, ui.ps1Progress,
    (text) => { ui.ps1IsoMain.textContent = text; }, 'o jogo');
  if (next) state.ps1Game = next;
  setPs1Info();
  focusTile(ui.ps1Play);
  updateCounts();
}

async function choosePs1Bios(file) {
  if (ui.dash.classList.contains('busy')) return;
  if (!file) file = await pickFile('.bin,.rom');
  if (!file) return;
  if (file.size !== PS1_BIOS_SIZE && !confirm(`Uma BIOS de PS1 tem 512 KB e ${file.name} tem ${formatSize(file.size)}. Usar mesmo assim?`)) return;
  ui.ps1BiosLabel.textContent = 'Guardando…';
  const next = await acceptPs1File(file, PS1_BIOS_FILE, PS1_BIOS_KEY, ui.ps1Progress, () => {}, 'a BIOS');
  if (next) state.ps1Bios = next;
  setPs1Info();
  focusTile(ui.ps1Play);
}

// ---------------------------------------------------------------------------
// Dashboard: abas, foco e navegação

let paneIndex = 0;

function currentPane() {
  return PANES[paneIndex];
}

function activeTiles() {
  return ui.dash.querySelector('.pane.is-active .tiles');
}

function navTiles(grid) {
  return [...grid.querySelectorAll('button.tile:not([disabled])')];
}

function tileBox(tile) {
  return {
    left: tile.offsetLeft,
    right: tile.offsetLeft + tile.offsetWidth,
    top: tile.offsetTop,
    bottom: tile.offsetTop + tile.offsetHeight,
    cx: tile.offsetLeft + tile.offsetWidth / 2,
    cy: tile.offsetTop + tile.offsetHeight / 2,
  };
}

// edge: from which side the focus enters the pane ('left' | 'right'), anchorY keeps the row.
function showPane(name, edge, anchorY) {
  const index = PANES.indexOf(name);
  if (index < 0) return;
  paneIndex = index;
  ui.dash.style.setProperty('--pane', index);
  for (const tab of ui.dash.querySelectorAll('#dash-nav .tab')) tab.classList.toggle('is-active', tab.dataset.pane === name);
  ui.dash.querySelectorAll('.pane').forEach((pane, i) => {
    pane.classList.toggle('is-active', i === index);
    pane.classList.toggle('is-before', i < index);
    pane.classList.toggle('is-after', i > index);
  });

  const grid = activeTiles();
  const tiles = navTiles(grid);
  let target = grid.querySelector('.tile-hero') || tiles[0];
  if (edge && tiles.length) {
    const y = anchorY ?? 0;
    const score = (tile) => {
      const box = tileBox(tile);
      const x = edge === 'left' ? box.left : -box.right;
      return x + Math.abs(box.cy - y) * 2;
    };
    target = tiles.reduce((best, tile) => (score(tile) < score(best) ? tile : best));
  }
  focusTile(target);

  if (name === 'ps1') prefetchPs1Core();
  if (name === 'config') refreshStorage();
}

function stepPane(delta, edge, anchorY) {
  const next = paneIndex + delta;
  if (next < 0 || next >= PANES.length) return false;
  showPane(PANES[next], edge, anchorY);
  return true;
}

function focusTile(tile) {
  for (const other of ui.dash.querySelectorAll('.tile.is-focus')) other.classList.remove('is-focus');
  if (!tile) return;
  tile.classList.add('is-focus');
  tile.focus({ preventScroll: true });
}

// Move o foco no grid pela geometria, como o d-pad do Xbox; nas bordas, passa para a aba vizinha.
function moveFocus(dx, dy) {
  const grid = activeTiles();
  if (!grid) return;
  const tiles = navTiles(grid);
  const current = tiles.find((tile) => tile.classList.contains('is-focus')) || tiles.find((tile) => tile === document.activeElement);
  if (!current) { focusTile(grid.querySelector('.tile-hero') || tiles[0]); return; }
  const from = tileBox(current);
  let best = null;
  let bestScore = Infinity;
  for (const tile of tiles) {
    if (tile === current) continue;
    const box = tileBox(tile);
    // Só vale um tile que esteja inteiro do lado pedido (como o d-pad do 360).
    let primary;
    let secondary;
    if (dx > 0) { primary = box.left - from.right; secondary = Math.abs(box.cy - from.cy); }
    else if (dx < 0) { primary = from.left - box.right; secondary = Math.abs(box.cy - from.cy); }
    else if (dy > 0) { primary = box.top - from.bottom; secondary = Math.abs(box.cx - from.cx); }
    else { primary = from.top - box.bottom; secondary = Math.abs(box.cx - from.cx); }
    if (primary < -2) continue;
    const score = primary + secondary * 2;
    if (score < bestScore) { bestScore = score; best = tile; }
  }
  if (best) focusTile(best);
  else if (dx) stepPane(dx, dx > 0 ? 'left' : 'right', from.cy);
}

function activateFocused() {
  const grid = activeTiles();
  const tile = (grid && grid.querySelector('.tile.is-focus')) || document.activeElement;
  if (tile && tile.matches('button.tile') && !tile.disabled) tile.click();
}

function setImageInfo() {
  const { image } = state;
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

function setPs1Info() {
  const game = state.ps1Game;
  const bios = state.ps1Bios;
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
  ui.ps1PlaySub.textContent = !game ? 'Escolha o jogo primeiro' : baseName(game.name) + (bios ? '' : ' · sem BIOS');
}

async function refreshStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    ui.cfgStorageLabel.textContent = `Armazenamento · ${formatSize(usage) || '0 KB'} de ${formatSize(quota)}`;
  } catch {}
}

// --- Barra de status: controles, jogos guardados, relógio --------------------

function updatePads() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
  ui.stPads.textContent = String(pads.length);
}

async function updateCounts() {
  const entries = await libraryEntries();
  ui.stGames.textContent = String(entries.filter((entry) => entry.stored).length);
}

function startClock() {
  const tick = () => {
    ui.stClock.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15000);
}

// ---------------------------------------------------------------------------
// Biblioteca de jogos

const lib = { open: false, entries: [], focus: 0, sort: 'titulos', busy: false, returnFocus: null };

// Títulos raspados de páginas vêm com o sufixo do <title> ("... ROM (ISO) Download for ... - Site.com").
const CATALOG_TITLE_NOISE = /\s*ROM\s*\((?:ISO|BIN)\)\s*Download for .*$|\s+-\s+[\w.-]+\.(?:com|net|org)\s*$/i;
const CATALOG_PLACEHOLDER_COVER = /\/images\/128x128\.gif|^-?$/i;
// Só é arquivo de jogo (baixável) a URL que termina numa extensão de disco; o resto é página e não é baixado.
const GAME_FILE_EXT = /\.(chd|pbp|bin|img|iso|cue|zip|7z|cso|isz|mdf|ecm)$/i;

function isGameFile(url) {
  if (!url) return false;
  try { return GAME_FILE_EXT.test(new URL(url, location.href).pathname); } catch { return false; }
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return ''; }
}

function slugify(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'jogo';
}

function catalogSystem(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key === 'ps1' || key === 'psx' || key === 'psone' || key === 'playstation') return 'ps1';
  if (key === 'ps2' || key === 'playstation2') return 'ps2';
  return null;
}

// Normaliza uma entrada do catálogo. Campos aceitos (português ou inglês):
//   name|nome|title, image|foto|cover, url|arquivo, plataforma|system, tamanho|size, pagina, fonte, id, fileName.
// A plataforma também pode vir do nome da lista (gamesPS1, gamesPS2).
// url/arquivo só vira download quando aponta para um arquivo de disco; uma página (.php, .html...) não é baixada.
// Sem arquivo a entrada vira "Importar arquivo": o usuário escolhe a própria cópia do jogo.
function normalizeGame(raw, systemHint) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.nome || raw.name || '').replace(CATALOG_TITLE_NOISE, '').trim();
  const system = catalogSystem(raw.system || raw.plataforma) || systemHint;
  // Restos do scraping (ex.: o link "#" da navegação por letra) não têm letra nem número no título.
  if (!title || !/[\p{L}\p{N}]/u.test(title) || !system) return null;
  const link = String(raw.arquivo || raw.url || '').trim();
  const url = isGameFile(link) ? link : '';
  const page = String(raw.pagina || raw.page || (url ? '' : link));
  const pageId = /\/(\d+)\//.exec(page);
  const source = String(raw.fonte || raw.source || hostLabel(page) || '');
  const id = slugify(raw.id || (pageId ? `${source || 'jogo'}-${pageId[1]}` : title));
  const cover = String(raw.cover || raw.foto || raw.image || '').trim();
  let fileName = String(raw.fileName || '');
  if (!fileName && url) {
    try { fileName = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()); } catch {}
  }
  return {
    id, title, system, url, fileName,
    size: Number(raw.size || raw.tamanho) || 0,
    cover: CATALOG_PLACEHOLDER_COVER.test(cover) ? '' : cover,
    source,
  };
}

// Listas aceitas: um array solto, ou um objeto com arrays (games, jogos, gamesPS1, gamesPS2...).
// Quando o nome da lista diz o console, ele vale para as entradas que não dizem.
function catalogLists(data) {
  if (Array.isArray(data)) return [[data, null]];
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [value, /ps2|playstation2/i.test(key) ? 'ps2' : /ps1|psx|psone/i.test(key) ? 'ps1' : null]);
}

async function loadCatalog() {
  try {
    const response = await fetch(LIB_CATALOG_URL, { cache: 'no-cache' });
    if (!response.ok) return;
    const data = await response.json();
    const seen = new Set();
    state.catalog = [];
    for (const [games, systemHint] of catalogLists(data)) {
      for (const raw of games) {
        const game = normalizeGame(raw, systemHint);
        if (!game) continue;
        let { id } = game;
        for (let n = 2; seen.has(id); n++) id = `${game.id}-${n}`;
        seen.add(id);
        state.catalog.push({ ...game, id });
      }
    }
  } catch (err) {
    console.warn('Catálogo da biblioteca indisponível:', err);
  }
}

async function libraryEntries() {
  const entries = [];
  if (state.image) {
    entries.push({ key: 'local-ps2', local: true, system: 'ps2', title: 'Need for Speed: Underground 2',
      detail: state.image.name, size: state.image.size, stored: true, temporary: !!state.image.temporary });
  }
  if (state.ps1Game) {
    entries.push({ key: 'local-ps1', local: true, system: 'ps1', title: baseName(state.ps1Game.name),
      detail: state.ps1Game.name, size: state.ps1Game.size, stored: true, temporary: !!state.ps1Game.temporary });
  }
  for (const game of state.catalog) {
    const known = localStorage.getItem(LIB_META_PREFIX + game.id);
    const stored = known ? await findStored(LIB_FILE_PREFIX + game.id, LIB_META_PREFIX + game.id) : null;
    entries.push({ key: 'cat-' + game.id, game, system: game.system, title: game.title, cover: game.cover,
      size: stored ? stored.meta.size : game.size, stored: !!stored });
  }
  return entries;
}

function sortEntries(entries) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base' });
  const sorted = [...entries];
  if (lib.sort === 'sistema') sorted.sort((a, b) => b.system.localeCompare(a.system) || byTitle(a, b));
  else if (lib.sort === 'navegador') sorted.sort((a, b) => Number(b.stored) - Number(a.stored) || byTitle(a, b));
  else sorted.sort(byTitle);
  return sorted;
}

const PAD_PATH = 'M6 7h12a4 4 0 0 1 4 4v3a3 3 0 0 1-3 3 3 3 0 0 1-2.4-1.2L15.5 14h-7l-1.1 1.8A3 3 0 0 1 5 17a3 3 0 0 1-3-3v-3a4 4 0 0 1 4-4Zm1 3v1.5H5.5V13H7v1.5h1.5V13H10v-1.5H8.5V10H7Zm9.5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
const DISC_PATH = 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z';

function svgIcon(path, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (className) svg.setAttribute('class', className);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

function entryMeta(entry) {
  if (entry.local) return (entry.temporary ? 'Só nesta sessão' : 'No navegador') + (entry.size ? ` · ${formatSize(entry.size)}` : '');
  if (entry.stored) return 'No navegador' + (entry.size ? ` · ${formatSize(entry.size)}` : '');
  if (!entry.game.url) return 'Importar arquivo';
  return 'Baixar' + (entry.size ? ` · ${formatSize(entry.size)}` : '');
}

function buildCard(entry, index) {
  const card = document.createElement('button');
  card.className = 'card' + (entry.stored ? ' stored' : '');
  card.setAttribute('role', 'option');
  card.dataset.index = String(index);

  const badge = document.createElement('div');
  badge.className = 'card-badge ' + entry.system;
  badge.append(svgIcon(DISC_PATH), entry.system === 'ps2' ? 'PS2' : 'PS1');

  const art = document.createElement('div');
  art.className = 'card-art';
  art.append(svgIcon(PAD_PATH));
  if (entry.cover) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (new URL(entry.cover, location.href).origin !== location.origin) img.crossOrigin = 'anonymous';
    img.onerror = () => img.remove();
    img.src = entry.cover;
    art.append(img);
  }
  const progress = document.createElement('div');
  progress.className = 'card-progress';
  progress.append(document.createElement('i'));
  art.append(progress);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = entry.title;
  title.title = entry.detail || entry.title;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = entryMeta(entry);

  card.append(badge, art, title, meta, svgIcon(PAD_PATH, 'card-pad'));
  card.addEventListener('pointerenter', () => { if (!lib.busy) focusCard(index, false); });
  card.addEventListener('click', () => { focusCard(index, false); activateEntry(lib.entries[index], card); });
  return card;
}

function renderLibrary(keepKey) {
  ui.libStrip.textContent = '';
  lib.entries.forEach((entry, index) => ui.libStrip.append(buildCard(entry, index)));
  ui.libEmpty.hidden = lib.entries.length > 0;
  ui.libStrip.hidden = lib.entries.length === 0;
  ui.libSortLabel.textContent = (LIB_SORTS.find((s) => s.key === lib.sort) || LIB_SORTS[0]).label;
  let index = keepKey ? lib.entries.findIndex((entry) => entry.key === keepKey) : -1;
  if (index < 0) index = Math.min(lib.focus, lib.entries.length - 1);
  if (index >= 0) focusCard(index, false);
}

function focusCard(index, smooth = true) {
  const cards = ui.libStrip.children;
  if (!cards.length) return;
  index = Math.max(0, Math.min(cards.length - 1, index));
  lib.focus = index;
  for (const card of cards) card.classList.remove('is-focus');
  const card = cards[index];
  card.classList.add('is-focus');
  card.focus({ preventScroll: true });
  // Como no 360: o card focado fica perto da esquerda, com o anterior aparecendo pela metade.
  const strip = ui.libStrip;
  const pad = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
  const step = card.offsetWidth + (parseFloat(getComputedStyle(strip).columnGap) || 0);
  const target = Math.max(0, card.offsetLeft - pad - (index > 0 ? step * .55 : 0));
  strip.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
}

function setLibStatus(text, isError = false) {
  ui.libStatus.textContent = text;
  ui.libStatus.classList.toggle('error', isError);
}

async function refreshLibrary(keepKey) {
  lib.entries = sortEntries(await libraryEntries());
  renderLibrary(keepKey);
  updateCounts();
}

async function openLibrary() {
  if (lib.open || ui.dash.classList.contains('busy')) return;
  lib.open = true;
  lib.returnFocus = document.activeElement;
  ui.library.hidden = false;
  if (state.background) state.background.setActive(false);
  setLibStatus('');
  await refreshLibrary();
}

function closeLibrary() {
  if (!lib.open || lib.busy) return;
  lib.open = false;
  ui.library.hidden = true;
  if (state.background) state.background.setActive(true);
  const back = lib.returnFocus;
  if (back && back.classList && back.classList.contains('tile')) focusTile(back);
}

function cycleSort() {
  const index = LIB_SORTS.findIndex((s) => s.key === lib.sort);
  lib.sort = LIB_SORTS[(index + 1) % LIB_SORTS.length].key;
  try { localStorage.setItem(LIB_SORT_KEY, lib.sort); } catch {}
  const key = lib.entries[lib.focus] && lib.entries[lib.focus].key;
  lib.entries = sortEntries(lib.entries);
  renderLibrary(key);
}

async function downloadEntry(entry, card) {
  const { game } = entry;
  const bar = card.querySelector('.card-progress i');
  const meta = card.querySelector('.card-meta');
  lib.busy = true;
  card.classList.add('downloading');
  setLibStatus(`Baixando ${game.title}…`);
  try {
    await downloadToOpfs(game.url, LIB_FILE_PREFIX + game.id, LIB_META_PREFIX + game.id,
      { name: game.fileName, title: game.title, system: game.system }, game.size,
      (done, total) => {
        const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
        bar.style.width = total ? `${pct}%` : '100%';
        meta.textContent = total ? `Baixando… ${pct}% de ${formatSize(total)}` : `Baixando… ${formatSize(done)}`;
      });
    entry.stored = true;
    card.classList.add('stored');
    meta.textContent = entryMeta(entry);
    setLibStatus('');
    return true;
  } catch (err) {
    console.warn(err);
    meta.textContent = entryMeta(entry);
    setLibStatus(`Não deu para baixar ${game.title}: ${err && err.message || err}`, true);
    return false;
  } finally {
    card.classList.remove('downloading');
    lib.busy = false;
    updateCounts();
  }
}

// Entrada sem arquivo no catálogo: o usuário escolhe a própria cópia, que fica guardada no card.
// Returns { stored } when it went to the OPFS, { file } when it only fits in this session, or null.
async function importEntryFile(entry, card) {
  const { game } = entry;
  const file = await pickFile(game.system === 'ps2' ? PS2_ACCEPT : PS1_ACCEPT);
  if (!file) return null;
  if (extensionOf(file.name) === '.cue') {
    alert('Um .cue sozinho não serve: ele só aponta para os .bin. Compacte o .cue e os .bin juntos num ZIP, ou use CHD/PBP.');
    return null;
  }
  const bar = card.querySelector('.card-progress i');
  const meta = card.querySelector('.card-meta');
  const progress = { hidden: true, set value(v) { bar.style.width = `${Math.round(v * 100)}%`; } };
  lib.busy = true;
  card.classList.add('downloading');
  setLibStatus(`Guardando ${file.name}…`);
  try {
    const ok = await storeFile(file, LIB_FILE_PREFIX + game.id, LIB_META_PREFIX + game.id,
      { title: game.title, system: game.system }, progress, (text) => { meta.textContent = text; });
    if (!ok) {
      setLibStatus('Sem espaço para guardar no navegador. O jogo vai rodar só nesta sessão.');
      return { file };
    }
    entry.stored = true;
    entry.size = file.size;
    card.classList.add('stored');
    meta.textContent = entryMeta(entry);
    setLibStatus('');
    return { stored: true };
  } catch (err) {
    console.warn(err);
    setLibStatus('Não deu para guardar no navegador. O jogo vai rodar só nesta sessão.');
    return { file };
  } finally {
    card.classList.remove('downloading');
    lib.busy = false;
    updateCounts();
  }
}

async function activateEntry(entry, card) {
  if (!entry || lib.busy) return;
  if (entry.local) {
    lib.busy = false;
    closeLibrary();
    if (entry.system === 'ps2') bootPs2(state.image);
    else bootPs1(state.ps1Game);
    return;
  }
  const { game } = entry;
  if (!entry.stored && !game.url) {
    const result = await importEntryFile(entry, card);
    if (!result) return;
    if (result.file) {
      const { file } = result;
      closeLibrary();
      if (game.system === 'ps2') bootPs2({ source: { file }, bootName: bootNameFor(file.name), name: file.name, size: file.size, temporary: true });
      else bootPs1({ file, name: file.name, size: file.size, temporary: true });
      return;
    }
  } else if (!entry.stored && !(await downloadEntry(entry, card))) {
    return;
  }
  const opfsName = LIB_FILE_PREFIX + game.id;
  const stored = await findStored(opfsName, LIB_META_PREFIX + game.id);
  if (!stored) { setLibStatus('A cópia baixada sumiu do navegador. Tente baixar de novo.', true); refreshLibrary(entry.key); return; }
  closeLibrary();
  if (game.system === 'ps2') {
    bootPs2({ source: { opfsName }, bootName: bootNameFor(stored.meta.name), name: stored.meta.name, size: stored.meta.size });
  } else {
    bootPs1({ file: new File([stored.file], stored.meta.name), name: stored.meta.name, size: stored.meta.size });
  }
}

async function removeEntry(entry) {
  if (!entry || lib.busy) return;
  if (entry.local) {
    if (!confirm(`Apagar ${entry.detail} do navegador? Os saves ficam guardados.`)) return;
    if (entry.system === 'ps2') { await forgetStored(IMAGE_FILE, META_KEY); state.image = null; setImageInfo(); }
    else { await forgetStored(PS1_IMAGE_FILE, PS1_IMAGE_KEY); state.ps1Game = null; setPs1Info(); }
  } else {
    if (!entry.stored) { setLibStatus(`${entry.title} não tem cópia guardada no navegador.`); return; }
    if (!confirm(`Apagar a cópia de ${entry.title} do navegador? Dá para baixar de novo depois.`)) return;
    await forgetStored(LIB_FILE_PREFIX + entry.game.id, LIB_META_PREFIX + entry.game.id);
  }
  setLibStatus(`${entry.title} removido do navegador.`);
  await refreshLibrary(entry.local ? null : entry.key);
}

function libraryKey(event) {
  switch (event.key) {
    case 'ArrowLeft': focusCard(lib.focus - 1); break;
    case 'ArrowRight': focusCard(lib.focus + 1); break;
    case 'Home': focusCard(0); break;
    case 'PageUp': focusCard(lib.focus - 5); break;
    case 'PageDown': focusCard(lib.focus + 5); break;
    case 'End': focusCard(lib.entries.length - 1); break;
    case 'Enter': case ' ': activateEntry(lib.entries[lib.focus], ui.libStrip.children[lib.focus]); break;
    case 'x': case 'X': case 'Delete': removeEntry(lib.entries[lib.focus]); break;
    case 'y': case 'Y': cycleSort(); break;
    case 'Escape': case 'Backspace': closeLibrary(); break;
    default: return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entrada: teclado, mouse e controle

function setupInput() {
  window.addEventListener('keydown', (event) => {
    if (event.target && event.target.tagName === 'INPUT') return;
    if (lib.open) {
      if (libraryKey(event)) event.preventDefault();
      return;
    }
    if (ui.dash.hidden) return;
    const busy = ui.dash.classList.contains('busy');
    switch (event.key) {
      case 'ArrowLeft': moveFocus(-1, 0); break;
      case 'ArrowRight': moveFocus(1, 0); break;
      case 'ArrowUp': moveFocus(0, -1); break;
      case 'ArrowDown': moveFocus(0, 1); break;
      case 'Enter': case ' ':
        // preventDefault cancela o clique nativo do botão, então o tile só é ativado uma vez.
        if (event.target && event.target.matches && event.target.matches('#dash-nav .tab')) return;
        if (!busy) activateFocused();
        break;
      case 'q': case 'Q': stepPane(-1); break;
      case 'e': case 'E': stepPane(1); break;
      default: return;
    }
    event.preventDefault();
  });

  // Espaço dispara o clique nativo no keyup; cancela para não ativar duas vezes.
  window.addEventListener('keyup', (event) => {
    if (event.key === ' ' && event.target && event.target.classList &&
        (event.target.classList.contains('tile') || event.target.classList.contains('card'))) event.preventDefault();
  });

  // Mouse: passar por cima foca o tile (só na aba aberta). Clicar na aba que aparece na borda abre a aba.
  for (const tile of ui.dash.querySelectorAll('button.tile')) {
    tile.addEventListener('pointerenter', () => {
      if (tile.disabled || ui.dash.classList.contains('busy')) return;
      if (tile.closest('.pane').classList.contains('is-active')) focusTile(tile);
    });
  }
  for (const pane of ui.dash.querySelectorAll('.pane')) {
    pane.addEventListener('click', (event) => {
      if (pane.classList.contains('is-active')) return;
      event.stopPropagation();
      event.preventDefault();
      showPane(pane.dataset.pane);
    }, true);
  }
  for (const tab of ui.dash.querySelectorAll('#dash-nav .tab')) {
    tab.onclick = () => showPane(tab.dataset.pane);
  }
  ui.libSort.onclick = cycleSort;

  // Controle (Gamepad API): d-pad/analógico navega, A seleciona, B volta, X remove, Y ordena, LB/RB trocam de aba.
  const held = new Set();
  let lastMove = 0;
  let polling = false;
  const poll = () => {
    if (ui.dash.hidden && !lib.open) { polling = false; return; }
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
    const a = edge(0), b = edge(1), x = edge(2), y = edge(3), lb = edge(4), rb = edge(5);
    const move = (dx || dy) && now - lastMove > 200;
    if (move) lastMove = now;
    else if (!dx && !dy) lastMove = 0;

    if (lib.open) {
      if (move && dx) focusCard(lib.focus + dx);
      if (a) activateEntry(lib.entries[lib.focus], ui.libStrip.children[lib.focus]);
      if (b) closeLibrary();
      if (x) removeEntry(lib.entries[lib.focus]);
      if (y) cycleSort();
      if (lb) focusCard(lib.focus - 5);
      if (rb) focusCard(lib.focus + 5);
      return;
    }
    if (ui.dash.classList.contains('busy')) return;
    if (move) moveFocus(dx, dx ? 0 : dy);
    if (a) activateFocused();
    if (lb) stepPane(-1);
    if (rb) stepPane(1);
  };
  const startPolling = () => { if (!polling) { polling = true; requestAnimationFrame(poll); } };
  window.addEventListener('gamepadconnected', () => { updatePads(); startPolling(); });
  window.addEventListener('gamepaddisconnected', updatePads);
  if (navigator.getGamepads && [...navigator.getGamepads()].some((p) => p)) startPolling();
  // Reabrir a biblioteca depois que o polling parou (ex.: dash escondido) volta a ouvir o controle.
  ui.library.addEventListener('focusin', startPolling);
  ui.dash.addEventListener('focusin', startPolling);
}

// ---------------------------------------------------------------------------

async function main() {
  setupInput();
  loadBackground();
  startClock();
  updatePads();
  try { lib.sort = localStorage.getItem(LIB_SORT_KEY) || 'titulos'; } catch {}
  setStretch(localStorage.getItem(STRETCH_KEY) === '1');
  showPane('ps2');

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
  state.emulator = createEmulator();
  state.emulator
    .then(() => { state.emulatorReady = true; if (!ui.dash.classList.contains('busy')) setStatus('Pronto. Aperte Jogar.'); })
    .catch((err) => { console.error(err); setStatus('Erro ao carregar o emulador: ' + (err && err.message || err), true); });

  setStatus('Carregando o emulador…');
  const [image, ps1Game, ps1Bios] = await Promise.all([
    findStoredImage(),
    findStoredPs1(PS1_IMAGE_FILE, PS1_IMAGE_KEY),
    findStoredPs1(PS1_BIOS_FILE, PS1_BIOS_KEY),
    loadCatalog(),
  ]);
  Object.assign(state, { image, ps1Game, ps1Bios });
  setImageInfo();
  setPs1Info();
  updateCounts();

  // --- ps2 ---
  ui.play.onclick = async () => {
    if (!state.image) { await chooseImage(); if (!state.image) return; }
    bootPs2(state.image);
  };
  ui.iso.onclick = () => chooseImage();
  $('t-help').onclick = () => showPane('config');
  $('t-stretch').onclick = toggleStretch;
  $('t-fullscreen').onclick = toggleFullscreen;
  $('t-lib-ps2').onclick = openLibrary;
  $('t-export').onclick = async () => {
    try { exportSaves(await state.emulator); }
    catch (err) { alert('O emulador ainda não carregou: ' + (err && err.message || err)); }
  };
  $('t-import').onclick = () => {
    ui.importFile.onchange = async () => {
      const file = ui.importFile.files[0];
      if (!file) return;
      try {
        setStatus('Importando save…');
        await importSaves(await state.emulator, file);
      } catch (err) { alert('Save inválido: ' + err.message); setStatus('Pronto. Aperte Jogar.'); }
    };
    ui.importFile.click();
  };
  $('t-forget').onclick = () => {
    if (!state.image) { chooseImage(); return; }
    forgetAndReload(state.module);
  };

  // --- ps1 ---
  ui.ps1Play.onclick = async () => {
    if (!state.ps1Game) { await choosePs1Game(); if (!state.ps1Game) return; }
    bootPs1(state.ps1Game);
  };
  ui.ps1Iso.onclick = () => choosePs1Game();
  ui.ps1Bios.onclick = () => choosePs1Bios();
  $('t-ps1-help').onclick = () => showPane('config');
  $('t-ps1-about').onclick = () => showPane('config');
  $('t-ps1-fullscreen').onclick = toggleFullscreen;
  $('t-lib-ps1').onclick = openLibrary;
  $('t-ps1-forget').onclick = async () => {
    const game = state.ps1Game;
    if (!game) { choosePs1Game(); return; }
    if (!confirm(`Apagar ${game.name} do navegador? Os saves ficam guardados.`)) return;
    await forgetStored(PS1_IMAGE_FILE, PS1_IMAGE_KEY);
    state.ps1Game = null;
    setPs1Info();
    updateCounts();
  };
  $('t-ps1-forget-bios').onclick = async () => {
    const bios = state.ps1Bios;
    if (!bios) { choosePs1Bios(); return; }
    if (!confirm(`Apagar a BIOS ${bios.name} do navegador?`)) return;
    await forgetStored(PS1_BIOS_FILE, PS1_BIOS_KEY);
    state.ps1Bios = null;
    setPs1Info();
  };

  // --- configurações ---
  $('t-cfg-fullscreen').onclick = toggleFullscreen;
  $('t-cfg-stretch').onclick = toggleStretch;
  $('t-cfg-storage').onclick = openLibrary;

  // Arrastar um arquivo para qualquer lugar do menu cai no tile certo da aba aberta.
  // Na aba ps1, um arquivo de exatamente 512 KB é tratado como BIOS.
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
