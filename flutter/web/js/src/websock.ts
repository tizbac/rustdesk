import * as message from "./message";
import * as rendezvous from "./rendezvous";
import * as globals from "./globals";

export default class Websock {
  _websocket: WebSocket;
  _status: any;
  _latency: number;
  _secretKey: [Uint8Array, number, number] | undefined;
  _uri: string;
  _isRendezvous: boolean;
  _closed: boolean;

  constructor(uri: string, isRendezvous: boolean = true) {
    this._uri = uri;
    this._status = "";
    this._closed = false;
    this._websocket = new WebSocket(uri);
    this._websocket.onmessage = this._recv_message.bind(this);
    this._websocket.binaryType = "arraybuffer";
    this._latency = new Date().getTime();
    this._isRendezvous = isRendezvous;
  }

  latency(): number {
    return this._latency;
  }

  setSecretKey(key: Uint8Array) {
    this._secretKey = [key, 0, 0];
  }

  async sendMessage(json: message.DeepPartial<message.Message>) {
    let data = message.Message.encode(
      message.Message.fromPartial(json)
    ).finish();
    const k = this._secretKey;
    if (k) {
      k[1] += 1;
      data = await globals.encrypt(data, k[1], k[0]);
    }
    if (this._websocket.readyState === WebSocket.OPEN) {
      this._websocket.send(data as any);
    }
  }

  async sendRendezvous(data: rendezvous.DeepPartial<rendezvous.RendezvousMessage>) {
    this._websocket.send(
      rendezvous.RendezvousMessage.encode(
        rendezvous.RendezvousMessage.fromPartial(data)
      ).finish()
    );
  }

  parseMessage(data: Uint8Array) {
    return message.Message.decode(data);
  }

  parseRendezvous(data: Uint8Array) {
    return rendezvous.RendezvousMessage.decode(data);
  }

  async open(timeout: number = 12000): Promise<Websock> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this._status != "open") {
          reject(this._status || "Timeout");
        }
      }, timeout);
      this._websocket.onopen = () => {
        this._latency = new Date().getTime() - this._latency;
        this._status = "open";
        this._eventHandlers_open();
        resolve(this);
      };
      this._websocket.onclose = (e) => {
        if (this._status == "open") {
        }
        this._status = e;
        console.error("WebSock.onclose: ");
        console.error(e);
        this._eventHandlers_close(e);
        reject("Reset by the peer");
      };
      this._websocket.onerror = (e: any) => {
        if (!this._status) {
          reject(
            "Failed to connect to " +
              (this._isRendezvous ? "rendezvous" : "relay") +
              " server"
          );
          return;
        }
        this._status = e;
        console.error("WebSock.onerror: ");
        console.error(e);
        this._eventHandlers_error(e);
      };
    });
  }

  _eventHandlers_open() {}
  _eventHandlers_close(_e: any) {}
  _eventHandlers_error(_e: any) {}
  _eventHandlers_message(_data: any) {}

  async next(
    timeout = 12000
  ): Promise<rendezvous.RendezvousMessage | message.Message> {
    const func = (
      resolve: (
        value: rendezvous.RendezvousMessage | message.Message
      ) => void,
      reject: (reason: any) => void,
      tm0: number
    ) => {
      if (this._buf.length) {
        resolve(this._buf[0]);
        this._buf.splice(0, 1);
      } else {
        if (this._status != "open") {
          reject(this._status);
          return;
        }
        if (new Date().getTime() > tm0 + timeout) {
          reject("Timeout");
        } else {
          setTimeout(() => func(resolve, reject, tm0), 1);
        }
      }
    };
    return new Promise((resolve, reject) => {
      func(resolve, reject, new Date().getTime());
    });
  }

  _buf: (rendezvous.RendezvousMessage | message.Message)[] = [];

  close() {
    this._status = "";
    if (this._websocket) {
      if (
        this._websocket.readyState === WebSocket.OPEN ||
        this._websocket.readyState === WebSocket.CONNECTING
      ) {
        console.info("Closing WebSocket connection");
        this._websocket.close();
      }
      this._websocket.onmessage = () => {};
    }
  }

  async _recv_message(e: any) {
    if (e.data instanceof ArrayBuffer) {
      let bytes = new Uint8Array(e.data);
      const k = this._secretKey;
      if (k) {
        k[2] += 1;
        try {
          bytes = await globals.decrypt(bytes, k[2], k[0]);
        } catch (err) {
          console.error("decrypt failed", err);
          return;
        }
      }
      let msg: any;
      try {
        msg = this._isRendezvous
          ? this.parseRendezvous(bytes)
          : this.parseMessage(bytes);
      } catch (err) {
        console.error("parse failed", err);
        return;
      }
      this._buf.push(msg);
    }
    this._eventHandlers_message(e.data);
  }
}