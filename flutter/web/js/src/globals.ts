import _sodium from "libsodium-wrappers";
import { initZstd, sleep, getVersionNumber } from "./common";
import Connection from "./connection";
import { LANGS, version, KEY_MAP, checkIfRetry } from "./gen_js_from_hbb";
import * as message from "./message";
import { ConnType } from "./rendezvous";
import { files } from "./files";
import { terminal } from "./terminal";

export let curConn: Connection | undefined;
let lastAddedId = "";

export function setConn(conn: Connection | undefined) {
  curConn = conn;
  window.curConn = conn;
}

export function getConn() {
  return curConn;
}

type Fn = (...args: any[]) => any;

function _cb(name: string): Fn {
  return (window as any)[name];
}

export function onGlobalEvent(e: string) {
  const cb = _cb("onGlobalEvent");
  if (cb) cb(e);
}

export function onRegisteredEvent(e: string) {
  const cb = _cb("onRegisteredEvent");
  if (cb) cb(e);
}

export function onRgba(display: number, rgba: Uint8Array) {
  const cb = _cb("onRgba");
  if (cb) cb(display, rgba);
}

export function onVideoFrame(display: number, frame: any): boolean {
  const cb = _cb("onVideoFrame");
  if (cb && typeof cb === "function") {
    cb(display, frame);
    return true;
  }
  return false;
}

export function onFullscreenChanged(v: boolean) {
  const cb = _cb("onFullscreenChanged");
  if (cb) cb(v);
}

function jsonfyForDart(payload: any) {
  var tmp: any = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key) continue;
    tmp[key] =
      value instanceof Uint8Array
        ? "[" + value.toString() + "]"
        : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  }
  return tmp;
}

export function pushEvent(name: string, payload: any) {
  payload = jsonfyForDart(payload);
  payload.name = name;
  onGlobalEvent(JSON.stringify(payload));
}

export function pushRegisteredEvent(name: string, payload: any) {
  payload = jsonfyForDart(payload);
  payload.name = name;
  onRegisteredEvent(JSON.stringify(payload));
}

export function msgbox(type: string, title: string, text: string, retry = false) {
  if (!type || (type == "error" && !text)) return;
  const text2 = text.toLowerCase();
  var hasRetry = checkIfRetry(type, title, text2, retry) ? "true" : "";
  pushEvent("msgbox", { type, title, text, link: "", hasRetry });
}

let sodium: any;
async function ensureSodium(): Promise<any> {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  return sodium;
}

export async function verify(signed: Uint8Array, pk: Uint8Array) {
  const s = await ensureSodium();
  if (typeof pk == "string") {
    pk = decodeBase64(pk as any);
  }
  return s.crypto_sign_open(signed, pk);
}

export function decodeBase64(pk: string) {
  return _sodium.from_base64(pk, _sodium.base64_variants.ORIGINAL);
}

export async function genBoxKeyPair(): Promise<[Uint8Array, Uint8Array]> {
  const s = await ensureSodium();
  const pair = s.crypto_box_keypair();
  return [pair.privateKey, pair.publicKey];
}

export async function genSecretKey(): Promise<Uint8Array> {
  const s = await ensureSodium();
  return s.crypto_secretbox_keygen();
}

export async function seal(
  unsigned: Uint8Array,
  theirPk: Uint8Array,
  ourSk: Uint8Array
): Promise<Uint8Array> {
  const s = await ensureSodium();
  const nonce = Uint8Array.from(Array(24).fill(0));
  return s.crypto_box_easy(unsigned, nonce, theirPk, ourSk);
}

function makeOnce(value: number) {
  var byteArray = Array(24).fill(0);
  for (var index = 0; index < byteArray.length && value > 0; index++) {
    var byte = value & 0xff;
    byteArray[index] = byte;
    value = (value - byte) / 256;
  }
  return Uint8Array.from(byteArray);
}

export async function encrypt(unsigned: Uint8Array, nonce: number, key: Uint8Array) {
  const s = await ensureSodium();
  return s.crypto_secretbox_easy(unsigned, makeOnce(nonce), key);
}

export async function decrypt(signed: Uint8Array, nonce: number, key: Uint8Array) {
  const s = await ensureSodium();
  return s.crypto_secretbox_open_easy(signed, makeOnce(nonce), key);
}

export function use_ws() {
  return true;
}

// ----------------------------- storage -----------------------------

const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
  },
  json: (k: string, def: any) => {
    try {
      const s = localStorage.getItem(k);
      if (!s) return def;
      return JSON.parse(s);
    } catch (e) {
      return def;
    }
  },
  setJson: (k: string, v: any) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
  },
};

function randomID() {
  let id = "";
  for (let i = 0; i < 9; i++) {
    if (i == 3 || i == 6) id += " ";
    id += Math.floor(Math.random() * 10);
  }
  return id;
}

function randomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function myId() {
  let id = LS.get("my-id");
  if (!id || id.length < 9) {
    id = randomID();
    LS.set("my-id", id);
  }
  return id;
}

function myName() {
  let name = LS.get("my-name");
  if (!name) {
    name = navigator.userAgent.replace(/\s+/g, " ").substring(0, 20) || "Web Chrome";
    LS.set("my-name", name);
  }
  return name;
}

export function getMyName() {
  return myName();
}

export function getMyId() {
  return myId();
}

function getPeers(): { [id: string]: any } {
  return LS.json("peers", {});
}

function setPeers(peers: any) {
  LS.setJson("peers", peers);
  updateOnline();
}

function getFavs(): string[] {
  return LS.json("favs", []);
}

function setFavs(favs: string[]) {
  LS.setJson("favs", favs);
}

function getAb(): any {
  return LS.json("ab", {});
}

function setAb(ab: any) {
  LS.setJson("ab", ab);
}

function getGroups(): any {
  return LS.json("groups", {});
}

function setGroups(groups: any) {
  LS.setJson("groups", groups);
}

function getPeerOpt(id: string): any {
  const map = LS.json("peer-opt", {});
  return map[id] || {};
}

function setPeerOpt(id: string, name: string, value: string) {
  const map = LS.json("peer-opt", {});
  if (!map[id]) map[id] = {};
  if (value === undefined || value === null || value === "") {
    delete map[id][name];
  } else {
    map[id][name] = value;
  }
  if (Object.keys(map[id]).length == 0) delete map[id];
  LS.setJson("peer-opt", map);
}

function getFlutterPeerOpt(id: string): any {
  const map = LS.json("flutter-peer-opt", {});
  return map[id] || {};
}

function setFlutterPeerOpt(id: string, name: string, value: string) {
  const map = LS.json("flutter-peer-opt", {});
  if (!map[id]) map[id] = {};
  map[id][name] = value;
  LS.setJson("flutter-peer-opt", map);
}

function getLocalOpt(name: string): string {
  const map = LS.json("local-opt", {});
  const v = map[name];
  return v === undefined || v === null ? "" : String(v);
}

function setLocalOpt(name: string, value: string) {
  const map = LS.json("local-opt", {});
  if (value === undefined || value === null || value === "") {
    delete map[name];
  } else {
    map[name] = value;
  }
  LS.setJson("local-opt", map);
}

function getFlutterLocalOpt(name: string): string {
  const map = LS.json("flutter-local-opt", {});
  const v = map[name];
  return v === undefined || v === null ? "" : String(v);
}

function setFlutterLocalOpt(name: string, value: string) {
  const map = LS.json("flutter-local-opt", {});
  map[name] = value;
  LS.setJson("flutter-local-opt", map);
}

function getUserDefaultOpt(name: string): string {
  const map = LS.json("user-default-opt", {});
  const v = map[name];
  return v === undefined || v === null ? "" : String(v);
}

function setUserDefaultOpt(name: string, value: string) {
  const map = LS.json("user-default-opt", {});
  map[name] = value;
  LS.setJson("user-default-opt", map);
}

function getSessionOpt(name: string): string {
  const map = LS.json("session-opt", {});
  const v = map[name];
  return v === undefined || v === null ? "" : String(v);
}

function setSessionOpt(name: string, value: string) {
  const map = LS.json("session-opt", {});
  if (value === undefined || value === null || value === "") {
    delete map[name];
  } else {
    map[name] = value;
  }
  LS.setJson("session-opt", map);
}

function getServerOptions(): any {
  return LS.json("server-opt", {});
}

function setServerOptions(obj: any) {
  LS.setJson("server-opt", obj);
}

function getOption(name: string): string {
  return LS.get(name) || "";
}

function setOption(name: string, value: string) {
  if (value === undefined || value === null) {
    LS.set(name, "");
  } else {
    LS.set(name, value);
  }
}

// online peers state, only kept for the lifetime of the page
const online: { [id: string]: boolean } = {};

function updateOnline() {
  const peers = getPeers();
  for (const id of Object.keys(peers)) {
    if (id in online) peers[id]["online"] = online[id];
  }
}

export function setOnline(id: string, v: boolean) {
  online[id] = v;
  const peers = getPeers();
  peers[id] = peers[id] || {};
  peers[id]["online"] = v;
  LS.setJson("peers", peers);
}

function getPeersForDart() {
  const peers = [];
  for (const [id, value] of Object.entries(getPeers())) {
    if (!id) continue;
    const tm = value["tm"];
    const info = value["info"];
    if (!tm || !info) continue;
    peers.push([tm, id, info]);
  }
  return peers.sort().reverse().map((x: any) => x.slice(1));
}

function loadPeerEvents(name: string) {
  if (name == "load_recent_peers" || name == "load_recent_peers_sync") {
    const peers = getPeersForDart();
    pushRegisteredEvent("load_recent_peers", { peers: JSON.stringify(peers) });
  } else if (name == "load_fav_peers") {
    const peers = [];
    for (const id of getFavs()) {
      const p = getPeers()[id];
      if (p && p.info) peers.push([id, p.info]);
    }
    pushRegisteredEvent("load_fav_peers", { peers: JSON.stringify(peers) });
  } else if (name == "load_address_book_peers") {
    const list = getAb()["peers"] || [];
    const peers = [];
    for (const abp of list) {
      const id = abp.id;
      const p = getPeers()[id];
      const info = p && p.info ? p.info : { name: abp.alias || id };
      peers.push([id, info]);
    }
    pushRegisteredEvent("load_address_book_peers", { peers: JSON.stringify(peers) });
  } else if (name == "load_group_peers") {
    const groups = getGroups()["groups"] || [];
    const peers = [];
    for (const g of groups) {
      const id = g.id;
      const p = getPeers()[id];
      const info = p && p.info ? p.info : { name: id };
      peers.push([id, info]);
    }
    pushRegisteredEvent("load_group_peers", { peers: JSON.stringify(peers) });
  }
}

function doQueryOnlines(ids: string[]) {
  let changed: { [id: string]: boolean } = {};
  for (const id of ids) {
    let v = id in online ? online[id] : false;
    changed[id] = v;
  }
  pushRegisteredEvent("callback_query_onlines", { list: JSON.stringify(changed) });
}

function accountAuth(op: string, remember: boolean) {
  // Account login (OIDC) is not available from a self-hosted web client.
  // Report failure so the UI falls back to password login.
  pushEvent("auth_result", { ok: "false", error: "account_auth_not_supported", remember });
  return;
}

export function isPublicServer() {
  return !LS.get("custom-rendezvous-server");
}

// ----------------------------- events / api -----------------------------

function getDisplays() {
  return "[]";
}

export function pushInputSource() {}

function peerExists(id: string) {
  const p = getPeers()[id];
  return p && p.info ? true : false;
}

function getConnStatus() {
  const c = curConn;
  const connected = !!c;
  return JSON.stringify({
    status_num: connected ? 1 : 0,
    mouse_time: 0,
    video_conn_count: 0,
  });
}

function getByName(name: string, arg?: any): string {
  let v = _getByName(name, arg);
  if (typeof v == "string" || v instanceof String) return v as string;
  if (v == undefined || v == null) return "";
  return JSON.stringify(v);
}

function _getByName(name: string, arg: any): any {
  switch (name) {
    case "peers":
      return getPeersForDart();
    case "remember":
      return curConn?.getRemember() ? "true" : "";
    case "option:toggle":
      return curConn?.getOption(String(arg)) ? "true" : "";
    case "option:session":
      return getSessionOpt(String(arg));
    case "option:flutter:peer":
      return getFlutterPeerOpt(urlParams.get("id") || "")[String(arg)] || "";
    case "option:flutter:local":
      return getFlutterLocalOpt(String(arg));
    case "option:local":
      return getLocalOpt(String(arg));
    case "option:peer":
      arg = JSON.parse(arg);
      return getPeerOpt(arg.id)[arg.name] || "";
    case "option:user:default":
      return getUserDefaultOpt(String(arg));
    case "option":
      return getOption(String(arg));
    case "options":
      return JSON.stringify(getServerOptions());
    case "image_quality":
      return curConn?.getImageQuality() || "";
    case "my_name":
      return myName();
    case "my_id":
      return myId();
    case "uuid":
      return LS.get("uuid") || LS.set("uuid", randomUUID()) || LS.get("uuid") || "";
    case "app-name":
      return "RustDesk";
    case "version":
      return version;
    case "build_date":
      return BUILD_DATE;
    case "get_version_number":
      return getVersionNumber(String(arg));
    case "langs":
      return JSON.stringify(Object.keys(LANGS));
    case "translate":
      arg = JSON.parse(arg);
      return translateSync(arg.locale, arg.text);
    case "fav":
      return JSON.stringify(getFavs());
    case "get_conn_status":
      return getConnStatus();
    case "is_using_public_server":
      return isPublicServer() ? "true" : "false";
    case "api_server":
      return "";
    case "envvar":
      return String((window as any)[arg] || "");
    case "peer_has_password":
      return getPeerOpt(String(arg))["password"] ? "true" : "false";
    case "peer_exists":
      return peerExists(String(arg));
    case "load_recent_peers":
      loadPeerEvents("load_recent_peers");
      return "";
    case "load_recent_peers_sync":
      return JSON.stringify(getPeersForDart());
    case "load_fav_peers":
      loadPeerEvents("load_fav_peers");
      return "";
    case "load_address_book_peers":
      loadPeerEvents("load_address_book_peers");
      return "";
    case "load_group_peers":
      loadPeerEvents("load_group_peers");
      return "";
    case "main_display":
      return "0";
    case "platform":
      return "Web";
    case "get_version_number_args":
      return "";
    case "alternative_codecs":
      return "[]";
    case "audit_server":
      return "";
    case "account_auth_result":
      return "";
    case "conn_session_id":
      return curConn?._connSessionId || "";
    case "last_audit_note":
      return "";
    case "audit_guid":
      return "";
    case "enable_trusted_devices":
      return "N";
    case "resolve_avatar_url":
      return String(arg || "");
    case "peer_flutter_option":
      return "";
    case "session_id":
      return "0";
    case "peer_id":
      return curConn?._id || "";
    case "connected":
      return curConn?._connected ? "true" : "false";
    case "peer_info":
      return curConn?._peerInfoEvent || "{}";
    case "input_source":
      return getLocalOpt("input-source") || "Input source 1";
    case "vid":
      return curConn?._peerInfo?.displays ? String(curConn._peerInfo.current_display) : "0";
    default:
      return "";
  }
}

function setByName(name: string, value: any) {
  const c = curConn;
  switch (name) {
    case "session_add_sync":
      value = JSON.parse(value);
      // FFI.start calls _sync first (it carries the password) and then
      // session_start; skip the latter to avoid double connections.
      lastAddedId = value.id;
      return newConnection(value);
    case "session_start":
      value = JSON.parse(value);
      if (curConn && curConn._id === value.id && value.id === lastAddedId) {
        return "0";
      }
      return newConnection({ id: value.id, password: "" });
    case "login":
      value = JSON.parse(value);
      c?.setRemember(value.remember == true || value.remember == "true");
      c?.login(value["os_password"] || value["password"]);
      break;
    case "send_2fa":
      value = JSON.parse(value);
      c?.send2fa(value.code);
      break;
    case "session_close":
      close();
      break;
    case "refresh":
      c?.refresh();
      break;
    case "reconnect":
      c?.reconnect();
      break;
    case "option:toggle":
      c?.toggleOption(String(value));
      break;
    case "option:session":
      value = JSON.parse(value);
      if (value.name == "keyboard_mode" && c?._keyboardMode) {
        c._keyboardMode = value.value;
      }
      setSessionOpt(value.name, value.value);
      break;
    case "option:flutter:peer":
      value = JSON.parse(value);
      setFlutterPeerOpt(urlParams.get("id") || "", value.name, String(value.value));
      break;
    case "option:flutter:local":
      value = JSON.parse(value);
      setFlutterLocalOpt(value.name, String(value.value));
      break;
    case "option:local":
      value = JSON.parse(value);
      setLocalOpt(value.name, String(value.value));
      break;
    case "option:peer":
      value = JSON.parse(value);
      setPeerOpt(value.id, value.name, value.value);
      break;
    case "option:user:default":
      value = JSON.parse(value);
      setUserDefaultOpt(value.name, String(value.value));
      break;
    case "option":
      value = JSON.parse(value);
      setOption(value.name, String(value.value));
      break;
    case "options":
      if (typeof value == "string") {
        try {
          setServerOptions(JSON.parse(value));
        } catch (e) {
          console.warn(e);
        }
      }
      break;
    case "envvar":
      value = JSON.parse(value);
      (window as any)[value.name] = value.name == "download_dir" ? value.value : value.value;
      if (value.name == "download_dir") setLocalOpt("download_dir", value.value || "");
      break;
    case "image_quality":
      if (typeof value != "string") value = String(value);
      c?.setImageQuality(value);
      break;
    case "custom_image_quality":
      c?.setCustomImageQuality(parseInt(value));
      break;
    case "custom-fps":
      c?.setCustomFps(parseInt(value));
      break;
    case "lock_screen":
      c?.lockScreen();
      break;
    case "ctrl_alt_del":
      c?.ctrlAltDel();
      break;
    case "switch_display":
      value = JSON.parse(value);
      c?.switchDisplay(parseInt(value.value) || 0);
      break;
    case "flutter_key_event":
      value = JSON.parse(value);
      c?.flutterKeyEvent(value);
      break;
    case "enter_or_leave":
      c?.enterOrLeave(Boolean(value));
      break;
    case "input_key":
      value = JSON.parse(value);
      c?.inputKey(
        value.name,
        value.down == "true",
        value.press == "true",
        value.alt == "true",
        value.ctrl == "true",
        value.shift == "true",
        value.command == "true"
      );
      break;
    case "input_string":
      c?.inputString(String(value));
      break;
    case "send_mouse":
      c?.sendMouse(String(value));
      break;
    case "send_chat":
      c?.sendChat(String(value));
      break;
    case "input_os_password":
      c?.inputOsPassword(String(value));
      break;
    case "remove_peer":
      const peers = getPeers();
      delete peers[value];
      setPeers(peers);
      break;
    case "fav":
      setFavs(JSON.parse(value));
      break;
    case "save_ab":
      setAb(JSON.parse(value));
      break;
    case "clear_ab":
      setAb({});
      break;
    case "load_ab":
      (_cb("onLoadAbFinished") as Fn)?.(JSON.stringify(getAb()));
      break;
    case "save_group":
      setGroups(JSON.parse(value));
      break;
    case "clear_group":
      setGroups({});
      break;
    case "load_group":
      (_cb("onLoadGroupFinished") as Fn)?.(JSON.stringify(getGroups()));
      break;
    case "restart":
      c?.restartRemoteDevice();
      break;
    case "send_note":
      c?.sendChat(String(value));
      break;
    case "change_prefer_codec":
      c?.changePreferCodec();
      break;
    case "toggle_virtual_display":
      value = JSON.parse(value);
      c?.toggleVirtualDisplay(value.index, value.on);
      break;
    case "query_onlines":
      doQueryOnlines(JSON.parse(value));
      break;
    case "read_remote_dir":
      value = JSON.parse(value);
      files.readRemoteDir(value.path, value.include_hidden == true);
      break;
    case "send_files":
      value = JSON.parse(value);
      files.uploadFiles(value);
      break;
    case "confirm_override_file":
      value = JSON.parse(value);
      files.confirmOverride(value.id, value.need_override, value.remember == true, value.is_upload == true);
      break;
    case "remove_file":
      value = JSON.parse(value);
      files.removeFile(value);
      break;
    case "read_dir_to_remove_recursive":
      value = JSON.parse(value);
      files.readDirToRemoveRecursive(value);
      break;
    case "remove_all_empty_dirs":
      value = JSON.parse(value);
      files.removeAllEmptyDirs(value);
      break;
    case "cancel_job":
      files.cancelJob(parseInt(value));
      break;
    case "create_dir":
      value = JSON.parse(value);
      files.createDir(value);
      break;
    case "rename_file":
      value = JSON.parse(value);
      files.renameFile(value);
      break;
    case "select_files":
      files.selectFiles();
      break;
    case "elevate_direct":
      c?.elevateDirect();
      break;
    case "elevate_with_logon":
      value = JSON.parse(value);
      c?.elevateWithLogon(value.username, value.password);
      break;
    case "change_resolution":
      value = JSON.parse(value);
      c?.changeResolution(value.display, value.width, value.height);
      break;
    case "selected_sid":
      c?.setSelectedSid(String(value));
      break;
    case "open_terminal":
      value = JSON.parse(value);
      terminal.open(value.terminal_id, value.rows, value.cols);
      break;
    case "send_terminal_input":
      value = JSON.parse(value);
      terminal.sendInput(value.terminal_id, value.data);
      break;
    case "resize_terminal":
      value = JSON.parse(value);
      terminal.resize(value.terminal_id, value.rows, value.cols);
      break;
    case "close_terminal":
      value = JSON.parse(value);
      terminal.close(value.terminal_id);
      break;
    case "common":
      value = JSON.parse(value);
      setOption(value.name, String(value.value));
      break;
    case "audit_guid":
      LS.set("audit-guid", String(value));
      break;
    case "toggle_privacy_mode":
      value = JSON.parse(value);
      c?.togglePrivacyMode(value.impl_key, value.on == true);
      break;
    case "account_auth":
      value = JSON.parse(value);
      accountAuth(value.op, value.remember == true);
      break;
    case "account_auth_cancel":
      pushEvent("auth_cancel", {});
      break;
    case "option:toggle_kbd":
      break;
    case "set_audio":
      break;
    default:
      console.warn("setByName: unhandled " + name);
  }
  return "";
}

function newConnection(value: any) {
  if (curConn) {
    curConn.close();
  }
  const conn = new Connection();
  setConn(conn);
  conn._id = value.id;
  conn._password = value.password ? parsePassword(value.password) : undefined;
  let connType = ConnType.DEFAULT_CONN;
  if (value.isTerminal == true || value.isTerminal == "true") {
    connType = ConnType.TERMINAL;
  } else if (value.isFileTransfer == true || value.isFileTransfer == "true") {
    connType = ConnType.FILE_TRANSFER;
  } else if (value.isViewCamera == true || value.isViewCamera == "true") {
    connType = ConnType.VIEW_CAMERA;
  } else if (value.isPortForward == true || value.isPortForward == "true") {
    connType = ConnType.PORT_FORWARD;
  } else if (value.isRdp == true || value.isRdp == "true") {
    connType = ConnType.RDP;
  }
  conn.start(value.id, value.password || "", connType).catch((e: any) => {
    console.error(e);
  });
  return "0";
}

function parsePassword(p: string): Uint8Array | undefined {
  try {
    if (p.startsWith("[")) return Uint8Array.from(JSON.parse(p));
  } catch (e) {
    console.error(e);
  }
  return undefined;
}

export function close() {
  curConn?.close();
  setConn(undefined);
}

export function getPeersForDartExport() {
  return getPeersForDart();
}

// ----------------------------- init -----------------------------

const urlParams = new URLSearchParams(window.location.search);

const BUILD_DATE = "2026-01-01 00:00:00";

export function saveRdvWsUri(uri: string): string {
  LS.set("rdv-ws-uri", uri);
  return uri;
}

export function saveRelayWsUri(uri: string): string {
  LS.set("relay-ws-uri", uri);
  return uri;
}

let initialized = false;

const DEFAULT_PUB_KEY = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";

let pubKey = DEFAULT_PUB_KEY;

export function getPubKey(): string {
  return pubKey;
}

async function loadConfigFromJson() {
  try {
    const resp = await fetch("rustdeskWeb.json", { cache: "no-cache" });
    if (!resp.ok) return;
    const cfg = await resp.json();
    if (cfg.server) {
      LS.set("custom-rendezvous-server", String(cfg.server));
    }
    if (cfg.relay) {
      LS.set("custom-relay-server", String(cfg.relay));
    }
    if (cfg.key) {
      pubKey = String(cfg.key);
    }
  } catch (e) {
    console.warn("rustdeskWeb.json not applied", e);
  }
}

export async function init() {
  if (initialized) return;
  initialized = true;
  (globalThis as any).use_ws = use_ws;
  await loadConfigFromJson();
  if (!LS.get("uuid")) LS.set("uuid", randomUUID());
  await initZstd();
  const cb = _cb("onInitFinished");
  if (cb) cb();
  console.log("init done");
}

export function translateSync(locale: string, text: string): string {
  const dict: any =
    (LANGS as any)[locale] ||
    (LANGS as any)[locale.substring(locale.length - 2)] ||
    LANGS.en;
  const res = dict[text] || (LANGS.en as any)[text];
  return res || text;
}

function isMobile() {
  return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|ipad|iris|kindle|Android|Silk|lge |maemo|midp|mmp|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(navigator.userAgent)
    || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(navigator.userAgent.substr(0, 4));
}

window.isMobile = isMobile;
window.setByName = setByName;
window.getByName = getByName;
window.init = init;

export { message, KEY_MAP };
export { getPeers, setPeers, getPeerOpt, setPeerOpt, getOption, setOption };
export { getLocalOpt, setLocalOpt, sleep, getVersionNumber };