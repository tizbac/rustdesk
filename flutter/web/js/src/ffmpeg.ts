import * as globals from "./globals";

let _coreDir: string | null = null;

function coreDir(): string {
  if (_coreDir) return _coreDir;
  try {
    const tags = Array.from(document.querySelectorAll("script[src]")) as HTMLScriptElement[];
    const script = tags.map((s) => s.src || "").find((s) => s.includes("/dist/"));
    if (script) {
      _coreDir = new URL("../../ffmpeg-core/", script).href;
      return _coreDir;
    }
  } catch (e) {
    // ignore
  }
  _coreDir = new URL("ffmpeg-core/", document.baseURI).href;
  return _coreDir;
}

// Minimal classic worker that drives the Emscripten ffmpeg core directly.
// Built from a string (blob URL) so no extra static files or bundler wiring
// are needed; the core UMD exposes the createFFmpegCore factory via
// importScripts.
const WORKER_SRC = `
var mod = null, base = "";
var logErr = function (e) {
  var s = String(e && e.message || e || "");
  var st = "";
  try { if (e && e.stack) st = String(e.stack).slice(0, 400); } catch (_) {}
  return s + (st ? " | stack: " + st : "") + (logBuf.length ? " | ffmpeg: " + logBuf.join("\\n").slice(-600) : "");
};
var logBuf = [];
self.onmessage = function (e) {
  var id = e.data.id, type = e.data.type;
  Promise.resolve().then(async function () {
    var res;
    switch (type) {
      case "load": {
        base = e.data.base;
        importScripts(base + "ffmpeg-core.js");
        mod = await self.createFFmpegCore({
          wasmBinary: e.data.wasm,
          wasmMemory: new WebAssembly.Memory({ initial: 2048, maximum: 4096, shared: false }),
          locateFile: function (p) { return base + p; },
          print: function (m) { logBuf.push(m); },
          printErr: function (m) { logBuf.push(m); },
        });
        if (mod.setTimeout) mod.setTimeout(0);
        if (mod.setLogger) mod.setLogger(function () {});
        res = "ok";
        break;
      }
      case "write":
        mod.FS.writeFile(e.data.name, e.data.data);
        res = "ok";
        break;
      case "read":
        res = mod.FS.readFile(e.data.name);
        break;
      case "delete":
        mod.FS.unlink(e.data.name);
        res = "ok";
        break;
      case "exec": {
        if (mod.reset) mod.reset();
        logBuf = [];
        res = mod.exec.apply(mod, e.data.args);
        break;
      }
      default:
        res = "unknown";
    }
    self.postMessage({ id: id, ok: 1, value: res, log: logBuf.join("\\n") });
  }).catch(function (err) {
    self.postMessage({ id: id, ok: 0, error: logErr(err) });
  });
};
`;

// ffmpeg.wasm decode path (default). Each remote frame is an independent
// encoded picture; frames accumulate since the last key into a single
// elementary stream decoded in one exec(), keeping the freshest picture.

function isAvcc(b: Uint8Array): boolean {
  if (!b || b.length < 8) return false;
  if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 1) return false;
  if (b[0] == 0 && b[1] == 0 && b[2] == 1) return false;
  const len = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return len > 0 && len <= b.length - 4;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildIvf(parts: Uint8Array[]): Uint8Array {
  let total = 32;
  for (const p of parts) total += 12 + p.length;
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode("DKIF"), 0);
  out[6] = 32;
  out.set(new TextEncoder().encode("VP90"), 8);
  out[12] = 255;
  out[13] = 255;
  out[14] = 255;
  out[15] = 255;
  out[16] = 30;
  out[20] = 1;
  out[24] = parts.length;
  let off = 32;
  const dt = new DataView(out.buffer);
  parts.forEach((p, i) => {
    dt.setUint32(off, p.length, true);
    dt.setUint32(off + 4, i, true);
    dt.setUint32(off + 8, 0, true);
    off += 12;
    out.set(p, off);
    off += p.length;
  });
  return out;
}

// Convert AVC length-prefixed NALs to Annex B start codes so the raw h264
// demuxer can parse the stream (RustDesk frames use 4-byte lengths).
function avccToAnnexB(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total + parts.length * 4);
  let o = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length;) {
      if (i + 4 > part.length) return parts.length == 1 ? part : concat(parts);
      const len = part[i] * 0x1000000 + part[i + 1] * 0x10000 + part[i + 2] * 0x100 + part[i + 3];
      if (len <= 0 || i + 4 + len > part.length) return parts.length == 1 ? part : concat(parts);
      out[o++] = 0;
      out[o++] = 0;
      out[o++] = 0;
      out[o++] = 1;
      out.set(part.subarray(i + 4, i + 4 + len), o);
      o += len;
      i += 4 + len;
    }
  }
  return out.subarray(0, o);
}
export class FfmpegRenderer {
  display = 0;
  private _worker: Worker | null = null;
  private _id = 1;
  private _pending: Map<number, { ok: (v: any) => void; fail: (e: any) => void }> = new Map();
  private _loadPromise: Promise<boolean>;
  private _ready = false;
  private _haveKey = false;
  private _lastKey: Uint8Array | null = null;
  private _deltas: Uint8Array[] = [];
  private _chain: Promise<void> = Promise.resolve();
  private _codec = "";
  private _avcc: boolean | null = null;
  private _lastLog = "";
  private _uid = 0;
  private static _nextUid = 1;

  constructor(codec: string) {
    this._codec = codec;
    this._uid = FfmpegRenderer._nextUid++;
    this._loadPromise = this._load();
  }

  init(): boolean {
    return true;
  }

  private _invoke(type: string, data: any): Promise<any> {
    return new Promise((ok, fail) => {
      if (!this._worker) return fail(new Error("no worker"));
      const id = this._id++;
      this._pending.set(id, { ok, fail });
      this._worker.postMessage({ id, type, ...data });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          fail(new Error("ffmpeg worker timeout: " + type));
        }
      }, 30000);
    });
  }

  private async _load(): Promise<boolean> {
    try {
      this._worker = new Worker(
        URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }))
      );
      this._worker.onmessage = (e: any) => {
        const m = e.data;
        const p = this._pending.get(m.id);
        if (!p) return;
        this._pending.delete(m.id);
        if (m.ok) {
          if (m.log) this._lastLog = m.log;
          p.ok(m.value);
        } else p.fail(new Error(m.error || "ffmpeg worker error"));
      };
      this._worker.onerror = (e) => {
        console.warn("ffmpeg worker error event", (e as any).message);
      };
      await this._invoke("load", { base: coreDir(), wasm: await (await fetch(coreDir() + "ffmpeg-core.wasm")).arrayBuffer() });
      this._ready = true;
      if (globals.isDebug()) console.log("[lag] ffmpeg core loaded");
      return true;
    } catch (e) {
      console.warn("ffmpeg.wasm load failed", e);
      return false;
    }
  }

  processFrame(data: Uint8Array, key: boolean, display: number) {
    this.display = display;
    if (key) {
      this._haveKey = true;
      this._lastKey = data;
      this._deltas = [];
    }
    if (!key && !this._haveKey) return;
    if (key) {
      this._schedule();
      return;
    }
    this._deltas.push(data);
    if (this._deltas.length > 120) {
      this._deltas = [];
      this._schedule();
      return;
    }
    this._schedule();
  }

  private _schedule() {
    this._chain = this._chain
      .then(() => this._decodeOnce())
      .catch((e) => console.warn("ffmpeg decode error", e));
  }

  private async _decodeOnce() {
    if (!this._ready) {
      if (!(await this._loadPromise)) return;
    }
    const key = this._lastKey;
    if (!this._worker || !key) { console.warn("[ffm] skip: worker=" + !!this._worker + " key=" + !!key); return; }
    const deltas = this._deltas;
    this._deltas = [];
    const parts = [key, ...deltas];
    const t0 = performance.now();
    if (globals.isDebug())
      console.log("[ffm] decode codec=" + this._codec + " key=" + key.length + " deltas=" + deltas.length);
    try {
      let name: string;
      let input: Uint8Array;
      if (this._codec == "vp9") {
        name = "in.ivf";
        input = buildIvf(parts);
      } else {
        if (this._avcc === null) this._avcc = isAvcc(key);
        name = "in.h264";
        input = this._avcc ? avccToAnnexB(parts) : concat(parts);
      }
      await this._invoke("write", { name, data: input });
      const rc: number = await this._invoke("exec", {
        args: ["-i", name, "-update", "1", "-f", "image2", "out.png"],
      });
      const png: Uint8Array = await this._invoke("read", { name: "out.png" });
      await this._invoke("delete", { name });
      await this._invoke("delete", { name: "out.png" });
      if (rc != 0) {
        console.warn("[ffm] exec rc=" + rc + " in " + ((performance.now() - t0)|0) + "ms" + (this._lastLog ? ": " + this._lastLog.slice(-400) : ""));
        if (!deltas.length) {
          this._haveKey = false;
          this._lastKey = null;
          this._deltas = [];
        }
        return;
      }
      if (!png || !png.length) { console.warn("[ffm] no png, exec rc=" + rc); return; }
      (globalThis as any).__ffmIter = ((globalThis as any).__ffmIter || 0) + 1;
      await this._deliver(png);
      if (globals.isDebug())
        console.log("[ffm] decode #" + (globalThis as any).__ffmIter + " in " + (performance.now() - t0).toFixed(0) + "ms frames=" + parts.length);
    } catch (e) {
      console.warn("ffmpeg decode failed", e);
    }
  }

  private async _deliver(png: Uint8Array) {
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(bmp, 0, 0);
      const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
      globals.onRgba(this.display, new Uint8Array(imageData.data.buffer));
      globals.notifyVideoReceived();
    } catch (e) {
      console.warn("ffmpeg deliver failed", e);
    } finally {
      try {
        bmp?.close();
      } catch (e) {
        // ignore
      }
    }
  }

  flush() {}
}