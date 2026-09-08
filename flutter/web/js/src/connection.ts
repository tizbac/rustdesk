import Websock from "./websock";
import * as message from "./message";
import * as rendezvous from "./rendezvous";
import * as globals from "./globals";
import { VideoRenderer, AudioRenderer } from "./codec";
import { files } from "./files";
import { terminal } from "./terminal";
import { version } from "./gen_js_from_hbb";
import { ControlKey } from "./message";
import { NatType, ConnType } from "./rendezvous";
import _sodium from "libsodium-wrappers";

const TMP_ID = "RAndomTMPID";

let sodiumReady: Promise<any> | null = null;
function sodium(): Promise<any> {
  if (!sodiumReady) {
    sodiumReady = _sodium.ready.then(() => _sodium);
  }
  return sodiumReady!;
}

function getRdvWsUri(): string {
  let url = globals.getRdvServerFromJson();
  if (!url) {
    url = "rs.rustdesk.com:21116";
  }
  url = normalizeServer(url);
  return wsBase(url) + "/ws/id";
}

function wsBase(authority: string): string {
  if (/^wss?:\/\//i.test(authority)) return authority;
  if (/^https?:\/\//i.test(authority)) {
    return authority.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  }
  return "wss://" + authority;
}

function normalizeServer(uri: string): string {
  return uri
    .replace(/\/+$/, "")
    .replace(/\/ws\/[^/]*$/, "");
}

// relay_server is normally "host:port" (tcp). The browser needs the ws
// endpoint at the same authority, under the `/ws/relay` path.
function relayWsUri(relayServer: string): string {
  const uri = normalizeServer(relayServer.trim());
  return wsBase(uri) + "/ws/relay";
}

function relayServerOverride(): string | undefined {
  const relay = globals.getRelayServerFromJson();
  return relay || undefined;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return buf;
}

async function sha256(...chunks: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concatBytes(...chunks)));
}

export default class Connection {
  _rdv!: Websock;
  _ws: Websock | undefined;
  _id = "";
  _status = "";
  _connected = false;
  _secretKey: Uint8Array | undefined;
  _remember = false;
  _keyboardMode = 3; // KeyboardMode.Auto
  _peerId = "";
  _peerInfo: any;
  _peerInfoEvent = "";
  _isSasEnabled = false;
  _password: Uint8Array | undefined;
  _hash: message.Hash | undefined;
  _video: VideoRenderer | undefined;
  _videoCodec = "";
  _audio: AudioRenderer | undefined;
  _videoAckRequired = false;
  _msgs: message.DeepPartial<message.Message>[] = [];
  _msgQueueTimer: any;
  _sessionId = 1;
  _connSessionId = "";
  _display = 0;
  _lastVideoTs = 0;
  _connType = ConnType.DEFAULT_CONN;

  constructor() {
    this._msgQueueTimer = setInterval(() => this._pump(), 10);
  }

  getRemember() {
    return this._remember;
  }

  setRemember(v: boolean) {
    this._remember = v;
  }

  getOption(_name: string) {
    return globals.getOption(_name);
  }

  toggleOption(name: string) {
    const v = globals.getOption(name) == "true";
    globals.setOption(name, v ? "" : "true");
    if (name == "show_remote_cursor") {
      this.sendMisc({
        option: {
          show_remote_cursor: !v
            ? message.OptionMessage_BoolOption.Yes
            : message.OptionMessage_BoolOption.No,
        },
      });
    }
  }

  getImageQuality() {
    return globals.getOption("image_quality") || "balance";
  }

  _qualityOption() {
    const o: any = {};
    const q = globals.getOption("image_quality");
    if (q == "low") {
      o.image_quality = message.ImageQuality.Low;
    } else if (q == "best") {
      o.image_quality = message.ImageQuality.Best;
    } else if (q == "custom") {
      const v = parseInt(globals.getOption("custom_image_quality") || "");
      if (v > 0) o.custom_image_quality = v << 8;
    } else if (q) {
      o.image_quality = message.ImageQuality.Balanced;
    }
    const fps = parseInt(globals.getOption("custom_fps") || "");
    if (fps > 0) o.custom_fps = fps;
    return o;
  }

  _supportedDecoding() {
    return {
      ability_vp8: 1,
      ability_vp9: 1,
      ability_h264: 0,
      ability_h265: 0,
      ability_av1: 1,
      prefer: 0,
    };
  }

  setImageQuality(v: string) {
    globals.setOption("image_quality", v);
    const q = this._qualityOption();
    if (this._connected) {
      this.sendMisc({ option: q });
      this.refresh();
    }
  }

  setCustomImageQuality(v: number) {
    globals.setOption("custom_image_quality", String(v));
    if (this._connected && v > 0) {
      this.sendMisc({ option: { custom_image_quality: v << 8 } });
    }
  }

  setCustomFps(v: number) {
    globals.setOption("custom_fps", String(v));
    if (this._connected && v > 0) {
      this.sendMisc({ option: { custom_fps: v } });
    }
  }

  async start(
    peerId: string,
    password: string,
    connType?: ConnType
  ) {
    this._id = peerId;
    this._peerId = peerId;
    if (connType !== undefined) this._connType = connType;
    if (password) {
      this._password = new TextEncoder().encode(password);
    }
    globals.msgbox("toast", "", "Connecting ...");
    try {
      await this._createRendezvous();
    } catch (e) {
      this._msgs = [];
      console.error(e);
      globals.msgbox("error", "Failed to connect", String(e));
    }
  }

  async _createRendezvous() {
    this._rdv = new Websock(getRdvWsUri(), true);
    await this._rdv.open();
    this._punchHole();
  }

  async _punchHole() {
    const msg: rendezvous.DeepPartial<rendezvous.RendezvousMessage> = {
      punch_hole_request: {
        id: this._id,
        nat_type: NatType.SYMMETRIC,
        conn_type: this._connType,
        force_relay: true,
        version: version,
        licence_key: globals.getPubKey(),
      },
    };
    await this._rdv.sendRendezvous(msg);
    const timeout = setTimeout(() => {
      globals.msgbox("error", "Failed to connect", "Timeout");
      this.close();
    }, 15000);
    while (true) {
      let msg_in: rendezvous.RendezvousMessage;
      try {
        msg_in = (await this._rdv.next()) as rendezvous.RendezvousMessage;
      } catch (e) {
        clearTimeout(timeout);
        globals.msgbox("error", "Failed to connect", String(e));
        this.close();
        return;
      }
      if (!msg_in) continue;
      const key = firstKey(msg_in);
      if (!key) continue;
      const u: any = msg_in;
      if (u.punch_hole_response) {
        const ph = u.punch_hole_response;
        if (!ph.socket_addr || ph.socket_addr.length == 0) {
          clearTimeout(timeout);
          if (ph.other_failure) {
            globals.msgbox("error", "Failed to connect", ph.other_failure);
          } else if (ph.failure) {
            let reason = "Failed to connect";
            if (ph.failure == 2) reason = "Remote desktop is offline";
            else if (ph.failure == 3) reason = "Key mismatch";
            else if (ph.failure == 4) reason = "Key overuse";
            globals.msgbox("error", "Failed to connect", reason);
          }
          this.close();
          return;
        }
        clearTimeout(timeout);
        if (!ph.relay_server && !relayServerOverride()) {
          globals.msgbox("error", "Failed to connect", "No relay server");
          this.close();
          return;
        }
        this._createRelay(ph.relay_server || relayServerOverride()!, ph.pk as any, ph.uuid as any);
        return;
      } else if (u.relay_response) {
        clearTimeout(timeout);
        const rr = u.relay_response;
        if (!rr.relay_server && !relayServerOverride()) {
          globals.msgbox("error", "Failed to connect", "No relay server");
          this.close();
          return;
        }
        this._createRelay(rr.relay_server || relayServerOverride()!, rr.pk as any, rr.uuid as any);
        return;
      } else if (u.fetch_local_addr) {
        clearTimeout(timeout);
        const fla = u.fetch_local_addr;
        this._createRelay(fla.relay_server as any, undefined, fla.uuid as any);
        return;
      } else if (u.software_update) {
        continue;
      }
    }
  }

  async _createRelay(relayServer: string, signedIdPk?: Uint8Array, relayUuid?: string) {
    const uri = relayWsUri(relayServer);
    this._ws = new Websock(uri, false);
    try {
      await this._ws.open();
    } catch (e) {
      console.error(e);
      globals.msgbox("error", "Failed to connect", String(e));
      this.close();
      return;
    }
    try {
      await this._ws.sendRendezvous({
        request_relay: {
          id: this._id,
          uuid: relayUuid || randomUUID(),
          licence_key: globals.getPubKey(),
          conn_type: this._connType,
        },
      });
    } catch (e) {
      console.error(e);
      this.close();
      return;
    }
    await this._secureHandshake(signedIdPk);
  }

  async _secureHandshake(signedIdPk?: Uint8Array) {
    const ws = this._ws!;
    const theirPkB = await this._exchange(ws, signedIdPk);
    if (!theirPkB) {
      // peer has no registered identity; fall back to plaintext relay
      await ws.sendMessage({});
      this._afterLogin();
      return;
    }
    const s = await sodium();
    const nonce = new Uint8Array(24);
    const pair = s.crypto_box_keypair();
    const key = s.crypto_secretbox_keygen();
    const sealed_key = s.crypto_box_easy(
      key,
      nonce,
      new Uint8Array(theirPkB),
      pair.privateKey
    );
    await ws.sendMessage({
      public_key: { asymmetric_value: pair.publicKey, symmetric_value: sealed_key },
    });
    ws.setSecretKey(key);
    this._afterLogin();
  }

  // returns the peer's box public key, or undefined when the peer is not
  // identity-registered (fall back to an unencrypted session).
  async _exchange(
    ws: Websock,
    signedIdPk?: Uint8Array
  ): Promise<Uint8Array | undefined> {
    // verify the rendezvous-signed IdPk (RelayResponse.pk) with the root key
    let peerSignPk: Uint8Array | undefined;
    if (signedIdPk && signedIdPk.length) {
      const s = await sodium();
      const rootPk = s.from_base64(globals.getPubKey(), s.base64_variants.ORIGINAL);
      try {
        const opened = s.crypto_sign_open(new Uint8Array(signedIdPk), rootPk);
        if (opened) {
          const idpk = message.IdPk.decode(opened);
          if (idpk.id == this._peerId) {
            peerSignPk = new Uint8Array(idpk.pk);
          }
        }
      } catch (e) {
        console.warn("failed to verify rendezvous-signed id", e);
      }
    }
    const timeout = setTimeout(() => {
      this.close();
    }, 15000);
    for (let i = 0; i < 100; i++) {
      let msg_in: message.Message;
      try {
        msg_in = (await ws.next()) as message.Message;
      } catch (e) {
        console.warn("relay closed before signed_id", e);
        break;
      }
      if (!msg_in) continue;
      const u: any = msg_in;
      if (u.signed_id && u.signed_id.id && peerSignPk) {
        const s = await sodium();
        try {
          const opened = s.crypto_sign_open(
            new Uint8Array(u.signed_id.id),
            peerSignPk
          );
          if (opened) {
            const idpk = message.IdPk.decode(opened);
            if (idpk.id == this._peerId) {
              clearTimeout(timeout);
              return new Uint8Array(idpk.pk);
            }
          }
        } catch (e) {
          console.warn("failed to verify SignedId", e);
        }
      }
      if (i > 20) break;
    }
    clearTimeout(timeout);
    return undefined;
  }

  _afterLogin() {
    globals.setConn(this);
    this._connected = true;
    this._msgLoop();
  }

  async _msgLoop() {
    const ws = this._ws;
    while (this._connected && ws) {
      let msg: message.Message;
      try {
        msg = (await ws.next(15000)) as message.Message;
      } catch (e) {
        console.warn("relay closed", e);
        this.close();
        return;
      }
      if (!msg) continue;
      if (!this._connected) return;
      this._handleMessageType(msg);
    }
  }

  _login(password?: Uint8Array) {
    const login_request: any = {
      username: this._peerId,
      password: password
        ? password
        : this._password
          ? new Uint8Array(this._password)
          : new Uint8Array(),
      my_id: TMP_ID,
      my_name: globals.getMyName(),
      video_ack_required: this._videoAckRequired,
      version: version,
      my_platform: "Web",
      option: {
        ...this._qualityOption(),
        supported_decoding: this._supportedDecoding(),
      },
    };
    if (this._connType == ConnType.FILE_TRANSFER) {
      login_request.file_transfer = { dir: "", show_hidden: false };
    } else if (this._connType == ConnType.TERMINAL) {
      login_request.terminal = { service_id: "" };
    } else if (
      this._connType == ConnType.PORT_FORWARD ||
      this._connType == ConnType.RDP
    ) {
      login_request.port_forward = {
        host: "",
        port: 0,
        multiplex: false,
      };
    } else if (this._connType == ConnType.VIEW_CAMERA) {
      login_request.view_camera = {};
    }
    const msg: message.DeepPartial<message.Message> = { login_request };
    this._send(msg);
  }

  login(password: string) {
    this._password = new TextEncoder().encode(password);
    if (!this._connected) return;
    if (this._hash) {
      this._loginWithHash();
    }
  }

  async _loginWithHash() {
    const h = this._hash;
    if (!h || !this._password || !this._connected) return;
    const salt = new TextEncoder().encode(h.salt);
    const challenge = new TextEncoder().encode(h.challenge);
    const h1 = await sha256(this._password, salt);
    const h2 = await sha256(h1, challenge);
    this._login(h2);
  }

  send2fa(code: string) {
    this._send({ auth_2fa: { code } });
  }

  refresh() {
    this.sendMisc({ refresh_video: true });
  }

  reconnect() {
    const pw = this._password ? new TextDecoder().decode(this._password) : "";
    this.close();
    this._password = undefined;
    this._status = "";
    this.start(this._id, pw);
  }

  close() {
    try {
      clearInterval(this._msgQueueTimer);
    } catch (e) {
    }
    const wasClear = this._connected;
    this._connected = false;
    if (this._video) {
      try {
        this._video.flush();
      } catch (e) {
      }
      this._video = undefined;
    }
    if (this._audio) {
      this._audio.close();
      this._audio = undefined;
    }
    try {
      this._ws?.close();
      this._rdv?.close();
    } catch (e) {
    }
    this._ws = undefined;
    globals.setConn(undefined);
    globals.pushEvent("on_connection_close", {});
  }

  _send(msg: message.DeepPartial<message.Message>) {
    if (this._connected && this._ws) {
      this._msgs.push(msg);
    }
  }

  _pump() {
    if (this._msgs.length && this._ws) {
      const msg = this._msgs.shift()!;
      this._ws.sendMessage(msg || {}).catch((e) => {
        console.warn("send failed", e);
      });
    }
  }

  sendMisc(misc: message.DeepPartial<message.Misc>) {
    this._send({ misc: misc });
  }

  private _lastVideoRecvTime = 0;
  sendVideoReceived() {
    const now = Date.now();
    if (now - this._lastVideoRecvTime < 1000) return;
    this._lastVideoRecvTime = now;
    this._send({ misc: { video_received: true } });
  }

  inputKey(
    name: string,
    down: boolean,
    press: boolean,
    alt = false,
    ctrl = false,
    shift = false,
    command = false
  ) {
    const msg: message.DeepPartial<message.Message> = {
      key_event: {
        down,
        press,
        modifiers: this._modifiers(alt, ctrl, shift, command),
        mode: this._keyboardMode,
        ...(this._nameToCk(name) !== undefined
          ? { control_key: this._nameToCk(name) }
          : this._nameToChar(name) !== undefined
          ? { chr: this._shiftedCharCode(this._nameToChar(name)!, shift) }
          : name.length == 1
          ? { chr: name.charCodeAt(0) }
          : { seq: name }),
      },
    };
    this._send(msg);
  }

  flutterKeyEvent(data: any) {
    const modifiers: ControlKey[] = [];
    if (data.alt) modifiers.push(ControlKey.Alt);
    if (data.ctrl) modifiers.push(ControlKey.Control);
    if (data.shift) modifiers.push(ControlKey.Shift);
    if (data.command) modifiers.push(ControlKey.Meta);
    const ck = this._usbHidToCk(data.usb_hid);
    const char = this._nameToChar(String(data.name || ""));
    const msg: message.DeepPartial<message.Message> = {
      key_event: {
        down: data.down == true || data.down === "true",
        press: data.press == true,
        modifiers,
        mode: this._keyboardMode,
        ...(data.control_key !== undefined
          ? { control_key: data.control_key }
          : data.chr !== undefined
          ? { chr: data.chr }
          : data.unicode !== undefined
          ? { unicode: data.unicode }
          : data.seq !== undefined
          ? { seq: data.seq }
          : ck !== undefined
          ? { control_key: ck }
          : char !== undefined
          ? { chr: char.charCodeAt(0) }
          : String(data.name || "").length == 1
          ? { chr: String(data.name).charCodeAt(0) }
          : String(data.name || "").length
          ? { seq: String(data.name) }
          : {}),
      },
    };
    this._send(msg);
  }

  // Map a key name to a printable base character (lowercase/unshifted).
  _nameToChar(name: string): string | undefined {
    if (name.length == 1) return name;
    const map: any = {
      VK_SPACE: " ",
      VK_0: "0", VK_1: "1", VK_2: "2", VK_3: "3", VK_4: "4",
      VK_5: "5", VK_6: "6", VK_7: "7", VK_8: "8", VK_9: "9",
      VK_A: "a", VK_B: "b", VK_C: "c", VK_D: "d", VK_E: "e",
      VK_F: "f", VK_G: "g", VK_H: "h", VK_I: "i", VK_J: "j",
      VK_K: "k", VK_L: "l", VK_M: "m", VK_N: "n", VK_O: "o",
      VK_P: "p", VK_Q: "q", VK_R: "r", VK_S: "s", VK_T: "t",
      VK_U: "u", VK_V: "v", VK_W: "w", VK_X: "x", VK_Y: "y",
      VK_Z: "z",
      VK_QUOTE: "'", VK_COMMA: ",", VK_MINUS: "-", VK_SLASH: "/",
      VK_SEMICOLON: ";", VK_LBRACKET: "[", VK_RBRACKET: "]",
      VK_BACKSLASH: "\\", VK_PLUS: "+", VK_BACKTICK: "`",
      VK_PERIOD: ".", VK_EQUALS: "=",
    };
    return map[name];
  }

  _shiftedCharCode(base: string, shift: boolean): number {
    if (shift && base.length == 1) {
      const upper = base.toUpperCase();
      if (upper != base) return upper.charCodeAt(0);
      const shifted: any = { "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
        "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
        "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
        ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~" };
      if (shifted[base] !== undefined) return shifted[base].charCodeAt(0);
    }
    return base.charCodeAt(0);
  }

  _usbHidToCk(usbHid: number): ControlKey | undefined {
    const map: any = {
      0x29: ControlKey.Escape,
      0x2a: ControlKey.Backspace,
      0x2b: ControlKey.Tab,
      0x2c: ControlKey.Space,
      0x39: ControlKey.CapsLock,
      0x3a: ControlKey.F1, 0x3b: ControlKey.F2, 0x3c: ControlKey.F3,
      0x3d: ControlKey.F4, 0x3e: ControlKey.F5, 0x3f: ControlKey.F6,
      0x40: ControlKey.F7, 0x41: ControlKey.F8, 0x42: ControlKey.F9,
      0x43: ControlKey.F10, 0x44: ControlKey.F11, 0x45: ControlKey.F12,
      0x46: ControlKey.Snapshot,
      0x47: ControlKey.Scroll,
      0x48: ControlKey.Pause,
      0x49: ControlKey.Insert,
      0x4a: ControlKey.Home,
      0x4b: ControlKey.PageUp,
      0x4c: ControlKey.Delete,
      0x4d: ControlKey.End,
      0x4e: ControlKey.PageDown,
      0x4f: ControlKey.RightArrow,
      0x50: ControlKey.LeftArrow,
      0x51: ControlKey.DownArrow,
      0x52: ControlKey.UpArrow,
      0x53: ControlKey.NumLock,
      0x55: ControlKey.Multiply,
      0x56: ControlKey.Subtract,
      0x57: ControlKey.Add,
      0x58: ControlKey.NumpadEnter,
      0x59: ControlKey.Numpad1, 0x5a: ControlKey.Numpad2, 0x5b: ControlKey.Numpad3,
      0x5c: ControlKey.Numpad4, 0x5d: ControlKey.Numpad5, 0x5e: ControlKey.Numpad6,
      0x5f: ControlKey.Numpad7, 0x60: ControlKey.Numpad8, 0x61: ControlKey.Numpad9,
      0x62: ControlKey.Numpad0,
      0x63: ControlKey.Decimal,
      0x65: ControlKey.Apps,
      0x66: ControlKey.Power,
      0x7f: ControlKey.VolumeMute,
      0x80: ControlKey.VolumeUp,
      0x81: ControlKey.VolumeDown,
      0xe0: ControlKey.Control,
      0xe1: ControlKey.Shift,
      0xe2: ControlKey.Alt,
      0xe3: ControlKey.Meta,
      0xe4: ControlKey.RControl,
      0xe5: ControlKey.RShift,
      0xe6: ControlKey.RAlt,
      0xe7: ControlKey.Meta,
    };
    return map[usbHid];
  }

  _nameToCk(name: string): ControlKey | undefined {
    const map: any = {
      Alt: ControlKey.Alt,
      Backspace: ControlKey.Backspace,
      CapsLock: ControlKey.CapsLock,
      Control: ControlKey.Control,
      Delete: ControlKey.Delete,
      ArrowDown: ControlKey.DownArrow,
      End: ControlKey.End,
      Escape: ControlKey.Escape,
      F1: ControlKey.F1, F2: ControlKey.F2, F3: ControlKey.F3,
      F4: ControlKey.F4, F5: ControlKey.F5, F6: ControlKey.F6,
      F7: ControlKey.F7, F8: ControlKey.F8, F9: ControlKey.F9,
      F10: ControlKey.F10, F11: ControlKey.F11, F12: ControlKey.F12,
      Home: ControlKey.Home,
      ArrowLeft: ControlKey.LeftArrow,
      Meta: ControlKey.Meta,
      PageDown: ControlKey.PageDown,
      PageUp: ControlKey.PageUp,
      Enter: ControlKey.Return,
      ArrowRight: ControlKey.RightArrow,
      Shift: ControlKey.Shift,
      " ": ControlKey.Space,
      Tab: ControlKey.Tab,
      ArrowUp: ControlKey.UpArrow,
      Numpad0: ControlKey.Numpad0,
      Numpad1: ControlKey.Numpad1,
      Numpad2: ControlKey.Numpad2,
      Numpad3: ControlKey.Numpad3,
      Numpad4: ControlKey.Numpad4,
      Numpad5: ControlKey.Numpad5,
      Numpad6: ControlKey.Numpad6,
      Numpad7: ControlKey.Numpad7,
      Numpad8: ControlKey.Numpad8,
      Numpad9: ControlKey.Numpad9,
      Insert: ControlKey.Insert,
      Pause: ControlKey.Pause,
      PrintScreen: ControlKey.Snapshot,
      ScrollLock: ControlKey.Scroll,
      NumLock: ControlKey.NumLock,
      ContextMenu: ControlKey.Apps,
      CtrlAltDel: ControlKey.CtrlAltDel,
      RWin: ControlKey.RWin,
      Command: ControlKey.Meta,
      VK_SPACE: ControlKey.Space,
      VK_BACK: ControlKey.Backspace,
      VK_TAB: ControlKey.Tab,
      VK_ENTER: ControlKey.Return,
      VK_ESCAPE: ControlKey.Escape,
      VK_DELETE: ControlKey.Delete,
      VK_CAPITAL: ControlKey.CapsLock,
      VK_DOWN: ControlKey.DownArrow,
      VK_LEFT: ControlKey.LeftArrow,
      VK_RIGHT: ControlKey.RightArrow,
      VK_UP: ControlKey.UpArrow,
      VK_END: ControlKey.End,
      VK_HOME: ControlKey.Home,
      VK_NEXT: ControlKey.PageDown,
      VK_PRIOR: ControlKey.PageUp,
      VK_CLEAR: ControlKey.Clear,
      VK_INSERT: ControlKey.Insert,
      VK_PAUSE: ControlKey.Pause,
      VK_PRINT: ControlKey.Snapshot,
      VK_F1: ControlKey.F1, VK_F2: ControlKey.F2, VK_F3: ControlKey.F3,
      VK_F4: ControlKey.F4, VK_F5: ControlKey.F5, VK_F6: ControlKey.F6,
      VK_F7: ControlKey.F7, VK_F8: ControlKey.F8, VK_F9: ControlKey.F9,
      VK_F10: ControlKey.F10, VK_F11: ControlKey.F11, VK_F12: ControlKey.F12,
      VK_CONTROL: ControlKey.Control,
      RControl: ControlKey.RControl,
      VK_SHIFT: ControlKey.Shift,
      RShift: ControlKey.RShift,
      VK_MENU: ControlKey.Alt,
      RAlt: ControlKey.RAlt,
      Apps: ControlKey.Apps,
      VK_ADD: ControlKey.Add,
      VK_SUBTRACT: ControlKey.Subtract,
      VK_MULTIPLY: ControlKey.Multiply,
      VK_DIVIDE: ControlKey.Divide,
      VK_DECIMAL: ControlKey.Decimal,
      VK_NUMPAD0: ControlKey.Numpad0,
      VK_NUMPAD1: ControlKey.Numpad1,
      VK_NUMPAD2: ControlKey.Numpad2,
      VK_NUMPAD3: ControlKey.Numpad3,
      VK_NUMPAD4: ControlKey.Numpad4,
      VK_NUMPAD5: ControlKey.Numpad5,
      VK_NUMPAD6: ControlKey.Numpad6,
      VK_NUMPAD7: ControlKey.Numpad7,
      VK_NUMPAD8: ControlKey.Numpad8,
      VK_NUMPAD9: ControlKey.Numpad9,
      VK_CANCEL: ControlKey.Cancel,
      VK_EXECUTE: ControlKey.Execute,
      VK_HELP: ControlKey.Help,
      VK_SELECT: ControlKey.Select,
      VK_SLEEP: ControlKey.Sleep,
      VK_SEPARATOR: ControlKey.Separator,
      VK_CONVERT: ControlKey.Convert,
      VK_FINAL: ControlKey.Final,
      VK_HANGUL: ControlKey.Hangul,
      VK_HANJA: ControlKey.Hanja,
      VK_JUNJA: ControlKey.Junja,
      VK_KANA: ControlKey.Kana,
      VK_KANJI: ControlKey.Kanji,
      VK_NUMLOCK: ControlKey.NumLock,
      VK_SCROLL: ControlKey.Scroll,
      VK_APPS: ControlKey.Apps,
    };
    return map[name];
  }

  _modifiers(alt: boolean, ctrl: boolean, shift: boolean, command: boolean) {
    const modifiers: ControlKey[] = [];
    if (alt) modifiers.push(ControlKey.Alt);
    if (ctrl) modifiers.push(ControlKey.Control);
    if (shift) modifiers.push(ControlKey.Shift);
    if (command) modifiers.push(ControlKey.Meta);
    return modifiers;
  }

  inputString(data: string) {
    this._send({
      key_event: {
        down: false,
        press: true,
        mode: this._keyboardMode,
        seq: data,
      },
    });
  }

  sendMouse(data: string) {
    let m: any;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return;
    }
    let mask = 0;
    switch (String(m.type || "")) {
      case "down":
        mask = 1;
        break;
      case "up":
        mask = 2;
        break;
      case "wheel":
        mask = 3;
        break;
      case "trackpad":
        mask = 4;
        break;
      case "move_relative":
        mask = 5;
        break;
    }
    switch (String(m.buttons || "")) {
      case "left":
        mask |= 1 << 3;
        break;
      case "right":
        mask |= 2 << 3;
        break;
      case "wheel":
        mask |= 4 << 3;
        break;
      case "back":
        mask |= 8 << 3;
        break;
      case "forward":
        mask |= 16 << 3;
        break;
    }
    const modifiers = this._modifiers(
      m.alt === true || m.alt === "true",
      m.ctrl === true || m.ctrl === "true",
      m.shift === true || m.shift === "true",
      m.command === true || m.command === "true"
    );
    this._send({
      mouse_event: {
        x: parseInt(m.x) || 0,
        y: parseInt(m.y) || 0,
        mask,
        modifiers,
      },
    });
  }

  sendChat(chat: string) {
    this.sendMisc({ chat_message: { text: chat } });
  }

  inputOsPassword(password: string) {
    this._send({
      login_request: { os_login: { username: "", password } },
    });
  }

  ctrlAltDel() {
    this._send({
      key_event: {
        down: false,
        press: true,
        mode: this._keyboardMode,
        control_key: ControlKey.CtrlAltDel,
      },
    });
  }

  lockScreen() {
    this._send({
      key_event: {
        down: false,
        press: true,
        mode: this._keyboardMode,
        control_key: ControlKey.LockScreen,
      },
    });
  }

  changePreferCodec() {
    this.refresh();
  }

  enterOrLeave(_v: boolean) {}

  switchDisplay(display: number) {
    this._display = display;
    this.sendMisc({ switch_display: { display } });
  }

  changeResolution(display: number, width: number, height: number) {
    this.sendMisc({
      change_display_resolution: { display, resolution: { width, height } },
    });
  }

  toggleVirtualDisplay(display: number, on: boolean) {
    this.sendMisc({ toggle_virtual_display: { display, on } });
  }

  togglePrivacyMode(impl_key: string, on: boolean) {
    this.sendMisc({ toggle_privacy_mode: { impl_key, on } });
  }

  restartRemoteDevice() {
    this.sendMisc({ restart_remote_device: true });
  }

  elevateDirect() {
    this.sendMisc({ elevation_request: { direct: true } });
  }

  elevateWithLogon(username: string, password: string) {
    this.sendMisc({ elevation_request: { logon: { username, password } } });
  }

  setSelectedSid(sid: string) {
    this.sendMisc({ selected_sid: parseInt(sid) });
  }

  testDelay(data: message.TestDelay) {
    data.from_client = false;
    this._send({ test_delay: data });
  }

  handlePeerInfo(pi: message.PeerInfo) {
    this._peerInfo = pi;
    this._isSasEnabled = pi.sas_enabled;
    const event = {
      username: pi.username,
      hostname: pi.hostname,
      platform: pi.platform,
      version: pi.version,
      sas_enabled: pi.sas_enabled,
      current_display: pi.current_display,
      displays: JSON.stringify(pi.displays.map((d) => ({
        width: d.width,
        height: d.height,
        x: d.x,
        y: d.y,
        cursor_embedded: d.cursor_embedded,
      }))),
      features: JSON.stringify({
        privacy_mode: pi.features?.privacy_mode === true,
        terminal: pi.features?.terminal === true,
        port_forward_mux: pi.features?.port_forward_mux === true,
      }),
      resolutions: JSON.stringify({
        resolutions: (pi.resolutions?.resolutions ?? []).map((r) => ({
          width: r.width,
          height: r.height,
        })),
      }),
    };
    this._peerInfoEvent = JSON.stringify(event);
    globals.pushEvent("peer_info", event);
  }

  handleLoginResponse(lr: message.LoginResponse) {
    if (lr.peer_info !== undefined) {
      this.handlePeerInfo(lr.peer_info);
      globals.pushEvent("login_response", {
        peer_info: JSON.stringify(lr.peer_info),
      });
    } else if (lr.error) {
      if (lr.error == "Wrong Password") {
        globals.msgbox("re-input-password", lr.error, "Do you want to enter again?", true);
      } else if (lr.error == "No Password Access") {
        globals.msgbox(
          "wait-remote-accept-nook",
          "Prompt",
          "Please wait for the remote side to accept your session request...",
          false
        );
      } else {
        globals.msgbox("error", "Error", lr.error);
      }
    }
  }

  handleAuth2FA(_auth: message.Auth2FA) {
    globals.pushEvent("auth_2fa", { message: "" });
  }

  handleVideoFrame(frame: message.VideoFrame) {
    const display = frame.display || 0;
    if (globals.isDebug()) {
      const g: any = globalThis;
      const now = performance.now();
      g.__lag = g.__lag || { n: 0, t0: now, prev: now, next: now, max: 0 };
      const l = g.__lag;
      const gap = now - l.prev;
      if (gap > l.max) l.max = gap;
      l.n++;
      l.prev = now;
      if (now >= l.next) {
        const secs = (now - l.t0) / 1000;
        console.log(
          "[lag] rcv " + l.n + " frames in " + secs.toFixed(1) + "s, " + (l.n / secs).toFixed(2) + "fps, maxGap " + (l.max / 1000).toFixed(1) + "s, sincePrev " + (gap / 1000).toFixed(1) + "s"
        );
        l.n = 0;
        l.t0 = now;
        l.max = 0;
        l.next = now + 5000;
      }
    }
    const u: any = frame;
    let codec = "";
    let frames: message.EncodedVideoFrame[] = [];
    if (u.vp9s) {
      codec = "vp9";
      frames = u.vp9s.frames || [];
    } else if (u.av1s) {
      codec = "av1";
      frames = u.av1s.frames || [];
    } else if (u.h264s) {
      codec = "h264";
      frames = u.h264s.frames || [];
    } else if (u.h265s) {
      codec = "h265";
      frames = u.h265s.frames || [];
    } else if (u.vp8s) {
      codec = "vp8";
      frames = u.vp8s.frames || [];
    } else if (u.rgb || u.yuv) {
      console.warn("raw RGB/YUV video frames are not supported on web");
      return;
    }
    if (!codec) return;
    if (!this._video || this._videoCodec != codec) {
      const v = new VideoRenderer(codec as any);
      v.init();
      this._video = v;
      this._videoCodec = codec;
    }
    this._video.display = display;
    for (const f of frames) {
      this._video.processFrame(
        new Uint8Array(f.data),
        f.key === true,
        display
      );
    }
  }

  handleAudioFrame(frame: message.AudioFrame) {
    if (!this._audio) {
      this._audio = new AudioRenderer();
      this._audio.init();
    }
    this._audio.processAudioData(new Uint8Array(frame.data as any));
  }

  handleCursorData(cd: message.CursorData) {
    if (!cd.colors || cd.colors.length === 0) return;
    globals.pushEvent("cursor_data", {
      id: Number(cd.id || 0),
      hotx: cd.hotx,
      hoty: cd.hoty,
      width: cd.width,
      height: cd.height,
      colors: cd.colors,
    });
  }

  handleCursorPosition(cp: message.CursorPosition) {
    globals.pushEvent("cursor_position", { x: cp.x, y: cp.y });
  }

  handleCursorId(id: number) {
    globals.pushEvent("cursor_id", { id: Number(id) });
  }

  handleClipboard(clip: message.Clipboard) {
    globals.pushEvent("clipboard", {
      clip: clip.content as any,
      compress: clip.compress,
    });
  }

  handleSwitchDisplay(sd: message.SwitchDisplay) {
    this._display = sd.display;
    globals.pushEvent("switch_display", { display: sd.display });
  }

  handleMisc(misc: message.Misc & any) {
    if (misc.close_reason !== undefined) {
      globals.pushEvent("on_disconnect", {
        close_reason: String(misc.close_reason),
      });
      this.close();
    } else if (misc.chat_message) {
      globals.pushEvent("chat_message", { text: misc.chat_message.text });
    } else if (misc.permission_info) {
      globals.pushEvent("permission_info", {
        reason: misc.permission_info.reason || "",
      });
    } else if (misc.toggle_virtual_display) {
      globals.pushEvent("toggle_virtual_display", {
        on: misc.toggle_virtual_display.on,
        display: misc.toggle_virtual_display.display,
      });
    } else if (misc.restart_remote_device !== undefined) {
      globals.pushEvent("restart_remote_device", {});
    } else if (misc.switch_display) {
      this.handleSwitchDisplay(misc.switch_display);
    } else if (misc.portable_service_running) {
      globals.pushEvent("portable_service_running", {});
    } else if (misc.switch_back) {
      globals.pushEvent("switch_back", {});
    } else if (misc.option) {
      // ignore
    } else {
      console.debug("unhandled misc", Object.keys(misc));
    }
  }

  _handleMessageBox(box: message.MessageBox) {
    globals.msgbox(
      box.msgtype as any,
      box.title,
      box.text,
      false
    );
  }

  _handleMessageType(msg: message.Message) {
    const key = firstKey(msg);
    if (!key) return;
    switch (key) {
      case "test_delay":
        const td = (msg as any).test_delay;
        if (globals.isDebug() && !td.from_client) {
          console.log("[lag] host test_delay last_delay=" + td.last_delay + "ms tb=" + td.target_bitrate);
        }
        this.testDelay(message.TestDelay.fromPartial(td));
        break;
      case "peer_info":
        this.handlePeerInfo((msg as any).peer_info);
        break;
      case "login_response":
        this.handleLoginResponse((msg as any).login_response);
        break;
      case "video_frame":
        this.handleVideoFrame((msg as any).video_frame);
        break;
      case "audio_frame":
        this.handleAudioFrame((msg as any).audio_frame);
        break;
      case "cursor_data":
        this.handleCursorData((msg as any).cursor_data);
        break;
      case "cursor_position":
        this.handleCursorPosition((msg as any).cursor_position);
        break;
      case "cursor_id":
        this.handleCursorId((msg as any).cursor_id);
        break;
      case "clipboard":
        this.handleClipboard((msg as any).clipboard);
        break;
      case "file_response":
        files.handleFileResponse((msg as any).file_response);
        break;
      case "terminal_response":
        terminal.handleResponse((msg as any).terminal_response);
        break;
      case "message_box":
        this._handleMessageBox((msg as any).message_box);
        break;
      case "auth_2fa":
        this.handleAuth2FA((msg as any).auth_2fa);
        break;
      case "misc":
        this.handleMisc((msg as any).misc);
        break;
      case "hash":
        this._handleHash((msg as any).hash);
        break;
      default:
        console.debug("unhandled message type", key);
    }
  }

  async _handleHash(hash: message.Hash) {
    this._hash = hash;
    if (this._password) {
      await this._loginWithHash();
    } else {
      // login without password, the remote side can click accept
      this._login();
      globals.msgbox("input-password", "Password Required", "", false);
    }
  }
}

function randomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function firstKey(o: any): string {
  for (const k in o) {
    if (o[k] !== undefined && o[k] !== null) return k;
  }
  return "";
}