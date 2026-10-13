// Services disc read requests coming from the emulator thread (see Js_DiscImageDeviceStream.cpp).
// The emulator writes a request into a small control block inside the shared WebAssembly heap and
// waits on it with Atomics; this worker reads the bytes from the disc image (OPFS or a File) and
// writes them straight into the heap. The browser's main thread is never involved.

const STATE = 0, DST = 1, POS_LO = 2, POS_HI = 3, SIZE = 4, RESULT = 5, FILE_SIZE_LO = 6, FILE_SIZE_HI = 7;
const REQUEST = 1, DONE = 2;

let memory = null;
let heap = null;
let control = null;
let readInto = null;

function heapView(ptr, length) {
  if (ptr + length > heap.length) heap = new Uint8Array(memory.buffer);
  return heap.subarray(ptr, ptr + length);
}

function makeSyncAccessReader(access) {
  let direct = true;
  let temp = new Uint8Array(0);
  return (ptr, position, length) => {
    const view = heapView(ptr, length);
    if (direct) {
      try {
        return access.read(view, { at: position });
      } catch (err) {
        // Some browsers refuse SharedArrayBuffer-backed views, go through a bounce buffer instead.
        if (!(err instanceof TypeError)) throw err;
        direct = false;
      }
    }
    if (temp.length < length) temp = new Uint8Array(length);
    const bounce = temp.subarray(0, length);
    const read = access.read(bounce, { at: position });
    view.set(bounce.subarray(0, read));
    return read;
  };
}

function makeFileReader(file) {
  const reader = new FileReaderSync();
  return (ptr, position, length) => {
    const data = new Uint8Array(reader.readAsArrayBuffer(file.slice(position, position + length)));
    heapView(ptr, data.length).set(data);
    return data.length;
  };
}

function serve() {
  for (;;) {
    const state = Atomics.load(control, STATE);
    if (state !== REQUEST) {
      Atomics.wait(control, STATE, state);
      continue;
    }
    const ptr = control[DST] >>> 0;
    const length = control[SIZE] >>> 0;
    const position = (control[POS_LO] >>> 0) + (control[POS_HI] >>> 0) * 4294967296;
    let result;
    try {
      let done = 0;
      while (done < length) {
        const read = readInto(ptr + done, position + done, length - done);
        if (read <= 0) break;
        done += read;
      }
      if (done < length) heapView(ptr + done, length - done).fill(0);
      result = length;
    } catch (err) {
      console.error('disc-worker: read failed', err);
      result = -1;
    }
    control[RESULT] = result;
    Atomics.store(control, STATE, DONE);
    Atomics.notify(control, STATE);
  }
}

self.onmessage = async (event) => {
  const { memory: sharedMemory, controlPtr, source } = event.data;
  memory = sharedMemory;
  heap = new Uint8Array(memory.buffer);
  control = new Int32Array(memory.buffer, controlPtr, 8);

  let size;
  try {
    if (source.opfsName) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(source.opfsName);
      try {
        const access = await handle.createSyncAccessHandle();
        size = access.getSize();
        readInto = makeSyncAccessReader(access);
      } catch (err) {
        // Sync handle unavailable (already locked by another tab, old browser...), read through a File.
        const file = await handle.getFile();
        size = file.size;
        readInto = makeFileReader(file);
      }
    } else {
      size = source.file.size;
      readInto = makeFileReader(source.file);
    }
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
    return;
  }

  Atomics.store(control, FILE_SIZE_LO, size % 4294967296);
  Atomics.store(control, FILE_SIZE_HI, Math.floor(size / 4294967296));
  postMessage({ ready: true, size });
  serve();
};
