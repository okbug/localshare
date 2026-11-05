import { contextBridge, ipcRenderer } from "electron";
import type { ControlPanelAPI, ControlPanelState } from "../shared/types";
const api: ControlPanelAPI = {
  snapshot: () => ipcRenderer.invoke("localshare:panel:get"),
  stop: (id) => ipcRenderer.invoke("localshare:panel:stop", id),
  subscribe: (fn) => {
    const listener = (_: unknown, state: ControlPanelState | null) => fn(state);
    ipcRenderer.on("localshare:panel:state", listener);
    return () => {
      ipcRenderer.removeListener("localshare:panel:state", listener);
    };
  },
};
contextBridge.exposeInMainWorld("controlPanel", api);
