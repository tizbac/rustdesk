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
    if (!this._ready || !this._decoder) {
      this._pending.push(data);
      this._pendingKeys.push(key);
      return;
    }
    if (key) this._haveKey = true;
    if (!key && !this._haveKey) return;
    this._feed(data, key);
  }

  _feed(data: Uint8Array, key: boolean) {
    try {
      const decoder: any = this._decoder;
      if (!decoder || decoder.state == "closed") return;
      if (decoder.state == "unconfigured") {
        decoder.configure({ codec: webcodecFor(this._codec) });
      }
      const chunk = new (window as any).EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp: 0,
        data: new Uint8Array(data),
      });
      decoder.decode(chunk);
    } catch (e) {
      console.warn("decode error", e);
      this._failed = true;
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
    const display = this.display;
    if (globals.onVideoFrame(display, frame)) return;
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
      const len = frame.allocationSize({ format: "s16" });
      const buf = new ArrayBuffer(len);
      frame.copyTo(new DataView(buf), { format: "s16" });
      frame.close();
      this._player?.feed(new Int16Array(buf));
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