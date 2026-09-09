import {
  getConn,
  getLocalOpt,
  isKeyboardGrabEntered,
  setKeyboardGrabEnteredListener,
} from "./globals";

const CODE_NAMES: Record<string, string> = {
  ControlLeft: "Control",
  ControlRight: "RControl",
  ShiftLeft: "Shift",
  ShiftRight: "RShift",
  AltLeft: "Alt",
  AltRight: "RAlt",
  MetaLeft: "Meta",
  MetaRight: "RWin",
  Space: " ",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  Insert: "Insert",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  Escape: "Escape",
  CapsLock: "CapsLock",
  NumLock: "NumLock",
  ScrollLock: "ScrollLock",
  ContextMenu: "ContextMenu",
  PrintScreen: "PrintScreen",
  Pause: "Pause",
  PauseBreak: "Pause",
  NumpadAdd: "VK_ADD",
  NumpadSubtract: "VK_SUBTRACT",
  NumpadMultiply: "VK_MULTIPLY",
  NumpadDivide: "VK_DIVIDE",
  NumpadDecimal: "VK_DECIMAL",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  IntlBackslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

const KEY_NAMES: Record<string, string> = {
  " ": " ",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  Insert: "Insert",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  Escape: "Escape",
  CapsLock: "CapsLock",
  NumLock: "NumLock",
  ScrollLock: "ScrollLock",
  ContextMenu: "ContextMenu",
  PrintScreen: "PrintScreen",
  Pause: "Pause",
  Control: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Meta: "Meta",
};

const mods = { ctrl: false, shift: false, alt: false, command: false };
const pressed = new Set<string>();

function isEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node.isContentEditable
  );
}

function shouldSkip(e: KeyboardEvent): boolean {
  if (e.isComposing) return true;
  return (
    isEditable(e.target as Element | null) ||
    isEditable(document.activeElement as Element | null)
  );
}

function grabConnection() {
  const c = getConn();
  if (!c || !c._connected || !isKeyboardGrabEntered()) return undefined;
  if ((getLocalOpt("input-source") || "Input source 1") !== "Input source 1") {
    return undefined;
  }
  return c;
}

function updateMods(code: string, down: boolean) {
  if (code === "ControlLeft" || code === "ControlRight") {
    mods.ctrl = down;
  } else if (code === "ShiftLeft" || code === "ShiftRight") {
    mods.shift = down;
  } else if (code === "AltLeft" || code === "AltRight") {
    mods.alt = down;
  } else if (code === "MetaLeft" || code === "MetaRight") {
    mods.command = down;
  }
}

function keyName(e: KeyboardEvent): string | undefined {
  const code = e.code;
  const mapped = CODE_NAMES[code];
  if (mapped !== undefined) return mapped;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return "Numpad" + code.slice(6);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const key = e.key;
  if (key && KEY_NAMES[key] !== undefined) return KEY_NAMES[key];
  if (key && /^F([1-9]|1[0-2])$/.test(key)) return key;
  if (key && key.length === 1) return key;
  return undefined;
}

function releaseAll() {
  const c = getConn();
  if (c && c._connected) {
    for (const name of Array.from(pressed)) {
      c.inputKey(name, false, false, false, false, false, false);
    }
  }
  pressed.clear();
  mods.ctrl = false;
  mods.shift = false;
  mods.alt = false;
  mods.command = false;
}

function handle(e: KeyboardEvent, down: boolean) {
  const c = grabConnection();
  if (!c) {
    releaseAll();
    return;
  }
  if (shouldSkip(e)) return;
  e.preventDefault();
  e.stopPropagation();
  updateMods(e.code, down);
  const name = keyName(e);
  if (!name) return;
  if (down) {
    pressed.add(name);
    c.inputKey(
      name,
      !e.repeat,
      e.repeat,
      mods.alt,
      mods.ctrl,
      mods.shift,
      mods.command
    );
  } else {
    pressed.delete(name);
    c.inputKey(
      name,
      false,
      false,
      mods.alt,
      mods.ctrl,
      mods.shift,
      mods.command
    );
  }
}

function onKeyDown(e: KeyboardEvent) {
  handle(e, true);
}

function onKeyUp(e: KeyboardEvent) {
  handle(e, false);
}

function onBlur() {
  releaseAll();
}

let installed = false;

export function installKeyboardGrab() {
  if (installed) return;
  installed = true;
  setKeyboardGrabEnteredListener((entered) => {
    if (!entered) releaseAll();
  });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur, true);
}
