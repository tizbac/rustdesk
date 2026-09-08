import * as globals from "./globals";
import PCMPlayer from "pcm-player";

type VideoCodec = "h264" | "h265" | "vp8" | "vp9" | "av1";

function webcodecFor(codec: VideoCodec): string | undefined {
  switch (codec) {
    case "h264":
      return "avc1.42E01E";
    case "h265":
      return "hvc1.1.6.L120.90";
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp09.00.10.08";
    case "av1":
      return "av01.0.04M.08";
  }
}

export class VideoRenderer {
  _codec: VideoCodec;
  _decoder: any;
  display = 0;
  _ready = false;
  _failed = false;
  _canvas: HTMLCanvasElement | undefined;
  _canvasCtx: CanvasRenderingContext2D | undefined;
  _pending: Uint8Array[] = [];
  _pendingKeys: boolean[] = [];
  _haveKey = false;
  _latestChunk: any = null;
  _nextTs = 0;
  _lastOut = 0;
  _outGap = 0;
  _flushing = false;
  _needsKey = false;
  _heldBuffer: any[] = [];

  constructor(codec: VideoCodec) {
    this._codec = codec;
  }

  init(): boolean {
    if (typeof (window as any).VideoDecoder != "function") {
      console.error("WebCodecs VideoDecoder not supported");
      this._failed = true;
      return false;
    }
    const codecStr = webcodecFor(this._codec);
    if (!codecStr) {
      this._failed = true;
      return false;
    }
    try {
      const decoder = new (window as any).VideoDecoder({
        output: (frame: any) => this._onOutput(frame),
        error: (e: any) => {
          console.error("VideoDecoder error", e);
          this._failed = true;
        },
      });
      decoder.configure({ codec: codecStr });
      this._decoder = decoder;
      this._ready = true;
      return true;
    } catch (e) {
      console.warn("WebCodecs init failed for " + this._codec, e);
      this._decoder?.close();
      this._finallyFailed();
      return false;
    }
  }

  _finallyFailed() {
    this._failed = true;
  }

  processFrame(data: Uint8Array, key: boolean, display: number) {
    if (this.display != display) this.display = display;
    if (key && data.length > 64) this._lastKeyData = data;
    if (!this._ready || !this._decoder) {
      this._pending.push(data);
      this._pendingKeys.push(key);
      return;
    }
    if (key) this._haveKey = true;
    if (!key && !this._haveKey) return;
    if (!key && data.length < 32) return;
    if (globals.isDebug()) this._feedTs = performance.now();
    this._feed(data, key);
    if (this._checkProbe()) this._probeLatency();
  }

  _lastKeyData: Uint8Array | null = null;
  _lastProbe = 0;
  _feedTs = 0;
  _traceN = 0;

  _checkProbe() {
    const g: any = globalThis;
    const now = performance.now();
    if (!globals.isDebug() || !this._lastKeyData || now - this._lastProbe < 8000) return false;
    if (g.__probeRunning) return false;
    g.__probeRunning = true;
    this._lastProbe = now;
    return true;
  }

  async _probeLatency() {
    try {
      const data = this._lastKeyData;
      if (!data) return;
      const codecStr = webcodecFor(this._codec);
      const seen: number[] = [];
      const dec = new (window as any).VideoDecoder({
        output: () => seen.push(performance.now()),
        error: () => seen.push(-1),
      });
      dec.configure({ codec: codecStr });
      const t0 = performance.now();
      dec.decode(new (window as any).EncodedVideoChunk({ type: "key", timestamp: 0, data }));
      try {
        await dec.flush();
      } catch (e) {}
      const t1 = performance.now();
      dec.close();
      console.log("[lag] probe fresh-decoder out=" + (seen[0] ? (seen[0] - t0).toFixed(0) + "ms" : "NONE") + " flush=" + (t1 - t0).toFixed(0) + "ms bytes=" + data.length);
    } catch (e) {
      console.warn("probe failed", e);
    } finally {
      (globalThis as any).__probeRunning = false;
    }
  }

  _feed(data: Uint8Array, key: boolean) {
    const decoder: any = this._decoder;
    if (!decoder || decoder.state == "closed") return;
    if (globals.isDebug()) {
      const g: any = globalThis;
      g.__fed = (g.__fed || 0) + 1;
      (g.__fedT = g.__fedT || []).push([performance.now(), data.length, key ? 1 : 0]);
      if (g.__fedT.length > 400) g.__fedT.shift();
      if (g.__fed == 1 || g.__fed % 30 == 0) {
        console.log("[lag] fed #" + g.__fed + " size=" + data.length + " key=" + key + " q=" + decoder.decodeQueueSize + " latest=" + (this._latestChunk ? 1 : 0));
      }
    }
    if (decoder.state == "unconfigured") {
      decoder.configure({ codec: webcodecFor(this._codec) });
    }
    if (this._lastOut && this._latestChunk && performance.now() - this._lastOut > 2000) {
      this._rebuildDecoder(data);
      return;
    }
    const chunk = new (window as any).EncodedVideoChunk({
      type: key ? "key" : "delta",
      timestamp: this._nextTs++,
      data: new Uint8Array(data),
    });
    try {
      if (this._flushing) {
        if (chunk.type == "key") this._heldBuffer.length = 0;
        this._heldBuffer.push(chunk);
        return;
      }
      if (decoder.decodeQueueSize >= 2) {
        if (!this._latestChunk || chunk.type == "key" || this._latestChunk.type != "key") {
          this._latestChunk = chunk;
        }
      } else {
        if (this._needsKey) {
          if (!this._lastKeyData) return;
          decoder.decode(new (window as any).EncodedVideoChunk({
            type: "key",
            timestamp: this._nextTs++,
            data: this._lastKeyData,
          }));
        }
        decoder.decode(chunk);
        this._needsKey = false;
        if (chunk.type == "key") {
          this._needsKey = true;
          this._flushing = true;
          decoder.flush().then(() => {
            this._flushing = false;
            this._drainHeld();
          }).catch(() => {
            this._flushing = false;
          });
        }
      }
    } catch (e) {
      console.warn("decode error", e);
      this._failed = true;
    }
  }

  _drainHeld() {
    const decoder: any = this._decoder;
    if (!decoder || decoder.state == "closed") return;
    const held = this._heldBuffer;
    this._heldBuffer = [];
    if (!held.length) {
      this._needsKey = true;
      return;
    }
    try {
      if (this._lastKeyData) {
        decoder.decode(new (window as any).EncodedVideoChunk({
          type: "key",
          timestamp: this._nextTs++,
          data: this._lastKeyData,
        }));
      }
      for (const c of held) {
        if (decoder.state != "configured") break;
        decoder.decode(c);
      }
      this._needsKey = false;
    } catch (e) {
      console.warn("decode error", e);
      this._failed = true;
    }
  }

  _rebuildDecoder(_data: Uint8Array) {
    const hadKey = this._haveKey;
    try {
      this._decoder?.close();
    } catch (e) {
      // ignore
    }
    this._decoder = null;
    this._ready = false;
    this._latestChunk = null;
    this._haveKey = hadKey;
    if (this.init() && this._lastKeyData) {
      this._feed(this._lastKeyData, true);
    }
  }

  _dequeue() {
    const decoder: any = this._decoder;
    if (!this._latestChunk || !decoder || decoder.state == "closed") return;
    while (this._latestChunk && decoder.decodeQueueSize < 2) {
      const chunk = this._latestChunk;
      this._latestChunk = null;
      try {
        if (chunk.type != "key" && this._needsKey) {
          if (!this._lastKeyData) return;
          decoder.decode(new (window as any).EncodedVideoChunk({
            type: "key",
            timestamp: this._nextTs++,
            data: this._lastKeyData,
          }));
        }
        decoder.decode(chunk);
        this._needsKey = false;
      } catch (e) {
        console.warn("decode error", e);
        this._failed = true;
        return;
      }
    }
  }

  _ensureCanvas() {
    if (!this._canvas) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      this._canvas = canvas;
      this._canvasCtx = ctx;
    }
  }

  async _onOutput(frame: any) {
    if (this._lastOut) this._outGap = performance.now() - this._lastOut;
    this._lastOut = performance.now();
    this._dequeue();
    const g: any = globalThis;
    g.__out = (g.__out || 0) + 1;
    g.__outT = (g.__outT || []).concat([performance.now()]);
    if (g.__outT.length > 400) g.__outT.shift();
    const now = performance.now();
    const feedLag = this._feedTs ? now - this._feedTs : -1;
    if (globals.isDebug() && this._traceN < 8) {
      g.__tN = (g.__tN || 0) + 1;
      console.log("[lag] trace" + g.__tN + " feedToOut=" + feedLag.toFixed(0) + "ms");
      this._traceN++;
    }
      g.__dl = (g.__dl || 0) + 1;
      g.__lagRend = (g.__lagRend || 0) + 1;
      if (!g.__dln) g.__dln = now;
      if (!g.__dlt) g.__dlt = now;
      if (g.__lprev) g.__outGap = (g.__outGap || 0) + (now - g.__lprev >= 1000 ? 1 : 0);
      g.__lprev = now;
      if (now >= g.__dlt + 4999) {
        const arr = g.__lagArr || [];
        const dec = g.__lagDec || [];
        let db = dec.length ? " decLat=" + (now - dec.shift()).toFixed(0) + "ms" : "";
        let lat = " inLat=" + (now - arr.shift()).toFixed(0) + "ms";
        if (arr.length > 0) lat = " inLatM=" + (arr as number[]).map((x: number) => (now - x).toFixed(0)).join(",");
        console.log("[lag] rendered " + g.__dl + " in " + ((now - g.__dln) / 1000).toFixed(1) + "s, q=" + (this._decoder ? this._decoder.decodeQueueSize : "-") + lat + db + " vis=" + (typeof document !== "undefined" ? document.visibilityState + (document.hidden ? "!" : "") : "?") + " slow=" + (g.__slow || 0) + " tex=" + (g.__tex || 0) + " rba=" + (g.__rba || 0) + " outGap>=1s x" + (g.__outGap || 0));
        g.__dlt = now;
        g.__dl = 0;
        g.__dln = now;
        g.__outGap = 0;
        delete (g as any).__lagArr;
        delete (g as any).__lagDec;
      }
    const display = this.display;
    const tg = performance.now();
    const viaTex = globals.onVideoFrame(display, frame);
    const bodyMs = performance.now() - tg;
    if (globals.isDebug() && bodyMs >= 20) {
      const g: any = globalThis;
      g.__slow = (g.__slow || 0) + 1;
    }
    if (viaTex) {
      (globalThis as any).__tex = ((globalThis as any).__tex || 0) + 1;
      globals.notifyVideoReceived();
      return;
    }
    (globalThis as any).__rba = ((globalThis as any).__rba || 0) + 1;
    try {
      this._ensureCanvas();
      const ctx = this._canvasCtx;
      const canvas = this._canvas;
      if (canvas && ctx) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const rgba = new Uint8Array(imageData.data.buffer);
        globals.onRgba(display, rgba);
        globals.notifyVideoReceived();
      }
    } catch (e) {
      console.warn("RGBA readback failed", e);
    } finally {
      try {
        frame.close();
      } catch (e) {
        // already closed
      }
    }
  }

  flush() {
    try {
      this._decoder?.flush();
    } catch (e) {
      // ignore
    }
  }
}

export class AudioRenderer {
  _player: any;
  _decoder: any;
  _silent = false;

  init(): boolean {
    if (typeof (window as any).AudioDecoder != "function") {
      console.warn("WebCodecs AudioDecoder not supported, audio disabled");
      this._silent = true;
      return false;
    }
    try {
      this._player = new PCMPlayer({
        inputCodec: "Int16",
        channels: 2,
        sampleRate: 48000,
        flushTime: 1000,
      });
      const decoder = new (window as any).AudioDecoder({
        output: (frame: any) => this._onAudioOutput(frame),
        error: (e: any) => console.error("AudioDecoder error", e),
      });
      decoder.configure({
        codec: "opus",
        sampleRate: 48000,
        numberOfChannels: 2,
      });
      this._decoder = decoder;
      return true;
    } catch (e) {
      console.warn("Audio init failed, audio disabled", e);
      this._silent = true;
      return false;
    }
  }

  async _onAudioOutput(frame: any) {
    try {
      const ndata = 120 * 2 * 48000; // guard against huge frames
      if (frame.numberOfFrames * frame.numberOfChannels > ndata) {
        frame.close();
        return;
      }
      if (frame.numberOfPlanes === 1) {
        const len = frame.allocationSize({ format: "s16" });
        const buf = new ArrayBuffer(len);
        frame.copyTo(new DataView(buf), { format: "s16" });
        frame.close();
        this._player?.feed(new Int16Array(buf));
        return;
      }
      const channels = frame.numberOfChannels;
      const frames = frame.numberOfFrames;
      const interleaved = new Int16Array(frames * channels);
      for (let p = 0; p < frame.numberOfPlanes; p++) {
        const len = frame.allocationSize({ planeIndex: p, format: "s16" });
        const plane = new ArrayBuffer(len);
        frame.copyTo(new DataView(plane), { planeIndex: p, format: "s16" });
        const samples = new Int16Array(plane);
        for (let i = 0; i < frames; i++) {
          interleaved[i * channels + p] = samples[i];
        }
      }
      frame.close();
      this._player?.feed(interleaved);
    } catch (e) {
      console.warn("audio output failed", e);
    }
  }

  processAudioData(data: Uint8Array) {
    if (this._silent || !this._decoder) return;
    if (this._decoder.state == "closed") return;
    if (this._decoder.state == "unconfigured") return;
    try {
      const chunk = new (window as any).EncodedAudioChunk({
        type: "key",
        timestamp: 0,
        data: new Uint8Array(data),
      });
      this._decoder.decode(chunk);
    } catch (e) {
      console.warn("audio decode error", e);
    }
  }

  close() {
    try {
      this._decoder?.close();
      this._player?.destroy();
    } catch (e) {
      // ignore
    }
  }
}