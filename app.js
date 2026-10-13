const DATA_DIR = '/home/web_user/.local/share';
const MEMCARD_DIR = DATA_DIR + '/Play Data Files/vfs/mc0';
const IMAGE_FILE = 'nfsu2.img';
const META_KEY = 'nfsu2.image';
const FORGET_KEY = 'nfsu2.forget';
const STRETCH_KEY = 'nfsu2.stretch';
const IMPORT_CHUNK = 32 * 1024 * 1024;
// Bumped by build.ps1 on every emulator build so browsers never mix an old Play.wasm with a new Play.js.
const BUILD = 'ffde8e04ba';

const $ = (id) => document.getElementById(id);
const ui = {
  screen: $('screen'),
  fps: $('fps'),
  setup: $('setup'),
  status: $('status'),
  drop: $('drop'),
  picker: $('picker'),
  progress: $('progress'),
  toolbar: $('toolbar'),
  help: $('help'),
  importFile: $('import-file'),
};

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
}

function fail(text) {
  ui.setup.hidden = false;
  ui.drop.hidden = true;
  ui.progress.hidden = true;
  setStatus(text, true);
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
    return { source: { opfsName: IMAGE_FILE }, bootName: meta.bootName };
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
      setStatus(`Guardando a ISO no navegador… ${Math.floor((done / file.size) * 100)}%`);
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

function askForImage() {
  return new Promise((resolve) => {
    ui.drop.hidden = false;
    setStatus('Escolha a ISO do jogo (ISO, CHD, CSO, ISZ ou BIN).');

    const accept = async (file) => {
      if (!file) return;
      ui.drop.hidden = true;
      try {
        if (await storeImage(file)) {
          resolve({ source: { opfsName: IMAGE_FILE }, bootName: bootNameFor(file.name) });
          return;
        }
        setStatus('Sem espaço para guardar a ISO no navegador. Ela vai rodar só nesta sessão.');
      } catch (err) {
        console.warn(err);
        setStatus('Não deu para guardar a ISO no navegador. Ela vai rodar só nesta sessão.');
      }
      resolve({ source: { file }, bootName: bootNameFor(file.name) });
    };

    ui.picker.onchange = () => accept(ui.picker.files[0]);
    ui.drop.ondragover = (event) => { event.preventDefault(); ui.drop.classList.add('over'); };
    ui.drop.ondragleave = () => ui.drop.classList.remove('over');
    ui.drop.ondrop = (event) => {
      event.preventDefault();
      ui.drop.classList.remove('over');
      accept(event.dataTransfer.files[0]);
    };
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
  try { localStorage.setItem(STRETCH_KEY, enabled ? '1' : ''); } catch {}
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
  $('btn-forget').onclick = () => {
    if (!confirm('Apagar a ISO guardada no navegador e escolher outra?')) return;
    syncSaves(module);
    localStorage.setItem(FORGET_KEY, '1');
    location.reload();
  };
}

// ---------------------------------------------------------------------------

async function main() {
  if (!window.crossOriginIsolated) {
    fail('O servidor não enviou os headers COOP/COEP. Sem eles o emulador não roda.');
    return;
  }
  if (typeof OffscreenCanvas === 'undefined' || !('transferToImageBitmap' in OffscreenCanvas.prototype)) {
    fail('Este navegador não suporta OffscreenCanvas. Use Chrome, Edge ou Firefox atualizados.');
    return;
  }

  if (localStorage.getItem(FORGET_KEY)) {
    localStorage.removeItem(FORGET_KEY);
    await forgetStoredImage();
  }

  // Start downloading/compiling the emulator while we look for the disc image.
  const emulator = createEmulator();
  emulator.catch(() => {});

  let image = await findStoredImage();
  if (!image) image = await askForImage();

  setStatus('Iniciando o emulador…');
  const module = await emulator;
  await startDiscWorker(module, image.source);

  ui.setup.hidden = true;
  setStretch(localStorage.getItem(STRETCH_KEY) === '1');
  fullscreenOnFirstInput();
  module.bootDiscImage(image.bootName);
  startStats(module);
  startSaveSync(module);
  setupToolbar(module);
}

main().catch((err) => {
  console.error(err);
  fail('Erro: ' + (err && err.message || err));
});
