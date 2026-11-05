export interface DeviceInfo {
  alias: string;
  version: string;
  deviceModel: string;
  deviceType: string;
  fingerprint: string;
  port: number;
  protocol: "https" | "http";
  download?: boolean;
  localshare?: boolean;
}
export interface Device extends DeviceInfo {
  ip: string;
  lastSeen: number;
}
export interface FileMeta {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
  sha256?: string | null;
  preview?: string | null;
}
export type TransferStatus =
  | "pending"
  | "transferring"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";
export interface TransferFile extends FileMeta {
  bytes: number;
  savedPath?: string;
  status: "pending" | "transferring" | "completed" | "failed";
}
export interface Transfer {
  id: string;
  direction: "send" | "receive";
  peer: string;
  peerFingerprint: string;
  files: TransferFile[];
  status: TransferStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export interface Source {
  name: string;
  path?: string;
  data?: Buffer;
}
export interface Selection {
  id: string;
  name: string;
  size: number;
}
export interface TrustedPeer {
  fingerprint: string;
  alias: string;
  clipboard: boolean;
  control: boolean;
  side: "left" | "right";
  invertScroll: boolean;
  swapAltWin: boolean;
}
export interface PairRequest {
  id: string;
  peer: Device;
  code: string;
  outgoing: boolean;
}
export interface ExtensionState {
  trusted: TrustedPeer[];
  pairing: PairRequest[];
  control: { mode: "local" | "sending" | "receiving"; peer?: string };
  clipboardEnabled: boolean;
  controlEnabled: boolean;
}
export interface Snapshot {
  info: DeviceInfo;
  addresses: string[];
  devices: Device[];
  transfers: Transfer[];
  receiveDir: string;
  networkError?: string;
  extensions: ExtensionState;
}
export interface DesktopSnapshot extends Snapshot {
  selection: Selection[];
  native: {
    available: boolean;
    permission: boolean;
    error?: string;
    accessibility?: boolean;
    inputMonitoring?: boolean;
  };
}
export interface DesktopAPI {
  snapshot(): Promise<DesktopSnapshot>;
  copyText(text: string): Promise<void>;
  subscribe(fn: (state: DesktopSnapshot) => void): () => void;
  selectFiles(folder?: boolean): Promise<void>;
  addDropped(paths: string[]): Promise<void>;
  droppedPath(file: File): string;
  removeSelection(id?: string): Promise<void>;
  send(fingerprint: string, text?: string, pin?: string): Promise<void>;
  respond(id: string, accept: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  discover(): Promise<void>;
  register(ip: string, port: number, protocol: "https" | "http"): Promise<void>;
  settings(alias: string): Promise<void>;
  chooseReceiveDir(): Promise<void>;
  openReceiveDir(): Promise<void>;
  revealFile(transferId: string, fileId: string): Promise<void>;
  clearHistory(): Promise<void>;
  pair(fingerprint: string): Promise<void>;
  respondPair(id: string, accept: boolean): Promise<void>;
  unpair(fingerprint: string): Promise<void>;
  peerSettings(
    fingerprint: string,
    settings: Partial<
      Pick<
        TrustedPeer,
        "clipboard" | "control" | "side" | "invertScroll" | "swapAltWin"
      >
    >,
  ): Promise<void>;
  extensionSettings(clipboard: boolean, control: boolean): Promise<void>;
  requestPermission(): Promise<void>;
  emergencyStop(): Promise<void>;
}
declare global {
  interface Window {
    localshare: DesktopAPI;
  }
}
