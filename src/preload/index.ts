import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAPI, DesktopSnapshot } from "../shared/types";
const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke("localshare:call", method, ...args);
const api: DesktopAPI = {
  snapshot: () => call("snapshot"),
  copyText: (text) => call("copyText", text),
  subscribe: (fn) => {
    const listener = (_: unknown, value: DesktopSnapshot) => fn(value);
    ipcRenderer.on("localshare:state", listener);
    return () => ipcRenderer.removeListener("localshare:state", listener);
  },
  selectFiles: (folder) => call("selectFiles", folder),
  addDropped: (paths) => call("addDropped", paths),
  droppedPath: (file) => webUtils.getPathForFile(file),
  removeSelection: (id) => call("removeSelection", id),
  send: (fp, text, pin) => call("send", fp, text, pin),
  respond: (id, yes) => call("respond", id, yes),
  cancel: (id) => call("cancel", id),
  discover: () => call("discover"),
  register: (ip, port, protocol) => call("register", ip, port, protocol),
  settings: (alias) => call("settings", alias),
  chooseReceiveDir: () => call("chooseReceiveDir"),
  openReceiveDir: () => call("openReceiveDir"),
  revealFile: (id, file) => call("revealFile", id, file),
  clearHistory: () => call("clearHistory"),
  pair: (fp) => call("pair", fp),
  respondPair: (id, yes) => call("respondPair", id, yes),
  unpair: (fp) => call("unpair", fp),
  peerSettings: (fp, patch) => call("peerSettings", fp, patch),
  extensionSettings: (clipboard, control) =>
    call("extensionSettings", clipboard, control),
  requestPermission: () => call("requestPermission"),
  emergencyStop: () => call("emergencyStop"),
  refreshDisplays: (fp) => call("refreshDisplays", fp),
};
contextBridge.exposeInMainWorld("localshare", api);
