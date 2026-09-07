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

const RS_PUB_KEY = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";

const TMP_ID = "RAndomTMPID";

let sodiumReady: Promise<any> | null = null;
function sodium(): Promise<any> {
  if (!sodiumReady) {
    sodiumReady = _sodium.ready.then(() => _sodium);
  }
  return sodiumReady!;
}

function getRdvWsUri(): string {
  let url = globals.getOption("custom-rendezvous-server");
  if (!url) {
    url = "rs.rustdesk.com:21116";
  }
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    url = (location.protocol === "https:" ? "wss://" : "ws://") + url;
  }
  return url;
}

// relay_server is normally "host:port" (tcp). The browser needs the ws
// endpoint, which by convention lives one port above the tcp relay port.
function relayWsUri(relayServer: string): string {
  let uri = relayServer.trim();
  if (uri.startsWith("ws://") || uri.startsWith("wss://")) return uri;
  const isHttps = location.protocol === "https:";
  if (uri.indexOf(":") >= 0 && uri.indexOf(":") == uri.lastIndexOf(":")) {
    const parts = uri.split(":");
    const port = parseInt(parts.pop() as any);
    if (!isNaN(port)) {
      uri = parts.join(":") + ":" + (port + 1);
    }
  }
  return (isHttps ? "wss://" : "ws://") + uri;
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

  setImageQuality(_v: string) {
    globals.setOption("image_quality", _v);
    if (this._connected) this.refresh();
  }

  setCustomImageQuality(v: number) {
    globals.setOption("custom_image_quality", String(v));
  }

  setCustomFps(v: number) {
    globals.setOption("custom_fps", String(v));
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
      },
    };
    await this._rdv.sendRendezvous(msg);
    const timeout = setTimeout(() => {
      globals.msgbox("error", "Failed to connect", "Timeout");
      this.close();
    }, 15000);
    while (true) {
      const msg_in = (await this._rdv.next()) as rendezvous.RendezvousMessage;
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
        if (!ph.relay_server) {
          globals.msgbox("error", "Failed to connect", "No relay server");
          this.close();
          return;
        }
        this._createRelay(ph.relay_server, ph.pk as any);
        return;
      } else if (u.relay_response) {
        clearTimeout(timeout);
        const rr = u.relay_response;
        if (!rr.relay_server) {
          globals.msgbox("error", "Failed to connect", "No relay server");
          this.close();
          return;
        }
        this._createRelay(rr.relay_server, rr.pk as any);
        return;
      } else if (u.fetch_local_addr) {
        clearTimeout(timeout);
        const fla = u.fetch_local_addr;
        this._createRelay(fla.relay_server as any, undefined);
        return;
      } else if (u.software_update) {
        continue;
      }
    }
  }

  async _createRelay(relayServer: string, signedIdPk?: Uint8Array) {
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
        request_relay: { id: this._id, uuid: randomUUID() },
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
      const rootPk = s.from_base64(RS_PUB_KEY, s.base64_variants.ORIGINAL);
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
      const msg_in = (await ws.next()) as message.Message;
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
    this._login();
    this._msgLoop();
  }

  async _msgLoop() {
    const ws = this._ws;
    while (this._connected && ws) {
      const msg = (await ws.next(15000)) as message.Message;
      if (!msg) continue;
      if (!this._connected) return;
      this._handleMessageType(msg);
    }
  }

  _login() {
    const login_request: any = {
      username: "",
      password: this._password ? new Uint8Array(this._password) : new Uint8Array(),
      my_id: TMP_ID,
      my_name: globals.getMyName(),
      video_ack_required: this._videoAckRequired,
      version: version,
      my_platform: "Web",
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
    this._login();
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

  inputKey(
    name: string,
    down: boolean,
    press: boolean,
    alt = false,
    ctrl = false,
    shift = false,
    command = false
  ) {
    const ck = this._nameToCk(name);
    const msg: message.DeepPartial<message.Message> = {
      key_event: {
        down,
        press,
        modifiers: this._modifiers(alt, ctrl, shift, command),
        mode: this._keyboardMode,
        ...(ck !== undefined
          ? { control_key: ck, seq: "" }
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
    const msg: message.DeepPartial<message.Message> = {
      key_event: {
        down: data.down == true,
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
          : {}),
      },
    };
    this._send(msg);
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
      F1: ControlKey.F1,
      F10: ControlKey.F10,
      F11: ControlKey.F11,
      F12: ControlKey.F12,
      F2: ControlKey.F2,
      F3: ControlKey.F3,
      F4: ControlKey.F4,
      F5: ControlKey.F5,
      F6: ControlKey.F6,
      F7: ControlKey.F7,
      F8: ControlKey.F8,
      F9: ControlKey.F9,
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
    const [x, y, mask] = data.split(",");
    this._send({
      mouse_event: {
        x: parseInt(x),
        y: parseInt(y),
        mask: parseInt(mask),
        modifiers: [],
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
    this._peerInfoEvent = JSON.stringify({
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
    });
    globals.pushEvent("peer_info", {
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
    });
  }

  handleLoginResponse(lr: message.LoginResponse) {
    if (lr.peer_info !== undefined) {
      this.handlePeerInfo(lr.peer_info);
      globals.pushEvent("login_response", {
        peer_info: JSON.stringify(lr.peer_info),
      });
    } else if (lr.error) {
      globals.msgbox("error", "Error", lr.error);
    }
  }

  handleAuth2FA(_auth: message.Auth2FA) {
    globals.pushEvent("auth_2fa", { message: "" });
  }

  handleVideoFrame(frame: message.VideoFrame) {
    const display = frame.display || 0;
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
    globals.pushEvent("cursor_data", {
      id: Number(cd.id || 0),
      hotx: cd.hotx,
      hoty: cd.hoty,
      width: cd.width,
      height: cd.height,
      data: cd.colors,
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

  _handleHash(_hash: message.Hash) {
    console.debug("hash request ignored");
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