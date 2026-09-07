import * as message from "./message";
import * as globals from "./globals";

function send(msg: message.DeepPartial<message.Message>) {
  globals.getConn()?._send(msg);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; ++i) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function handleResponse(re: message.TerminalResponse) {
  if (re.opened !== undefined) {
    globals.pushEvent("terminal_response", {
      terminal_id: re.opened.terminal_id,
      type: "opened",
      success: re.opened.success,
      message: re.opened.message,
      service_id: re.opened.service_id,
    });
  } else if (re.data !== undefined) {
    globals.pushEvent("terminal_response", {
      terminal_id: re.data.terminal_id,
      type: "data",
      data: toBase64(new Uint8Array(re.data.data)),
    });
  } else if (re.closed !== undefined) {
    globals.pushEvent("terminal_response", {
      terminal_id: re.closed.terminal_id,
      type: "closed",
      exit_code: re.closed.exit_code,
    });
  } else if (re.error !== undefined) {
    globals.pushEvent("terminal_response", {
      terminal_id: re.error.terminal_id,
      type: "error",
      message: re.error.message,
    });
  }
}

export const terminal = {
  open(terminalId: number, rows: number, cols: number) {
    send({
      terminal_action: {
        open: {
          terminal_id: terminalId,
          rows,
          cols,
        },
      },
    });
  },

  sendInput(terminalId: number, data: string) {
    send({
      terminal_action: {
        data: {
          terminal_id: terminalId,
          data: new TextEncoder().encode(data),
          compressed: false,
        },
      },
    });
  },

  resize(terminalId: number, rows: number, cols: number) {
    send({
      terminal_action: {
        resize: { terminal_id: terminalId, rows, cols },
      },
    });
  },

  close(terminalId: number) {
    send({
      terminal_action: {
        close: { terminal_id: terminalId },
      },
    });
  },

  handleResponse,
};