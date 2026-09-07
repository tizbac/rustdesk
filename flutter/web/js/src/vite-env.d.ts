declare module "libsodium-wrappers";

declare function use_ws(): boolean;

interface Window {
  curConn: any;
  setByName: any;
  getByName: any;
  init: any;
  isMobile: () => boolean;
}