import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import type { DeviceInfo } from "../shared/types";
export const DISCOVERY_PORT = 53317;
const GROUP = "224.0.0.167";
export function addresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap(
        (list) =>
          list
            ?.filter((a) => a.family === "IPv4" && !a.internal)
            .map((a) => a.address) ?? [],
      ),
    ),
  ];
}
export class Discovery {
  private socket?: dgram.Socket;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private info: () => DeviceInfo,
    private found: (info: unknown, ip: string) => Promise<void>,
    private error: (e: Error) => void,
  ) {}
  async start() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("message", (data, remote) => {
      if (data.length > 16384) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.fingerprint === this.info().fingerprint) return;
        void this.found(message, remote.address).catch(() => {});
      } catch {
        /* unrelated datagram */
      }
    });
    socket.on("error", (e) => this.error(e));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(DISCOVERY_PORT, () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });
    let joined = false;
    for (const ip of addresses()) {
      try {
        socket.addMembership(GROUP, ip);
        joined = true;
      } catch {
        /* interface may disappear */
      }
    }
    if (!joined) {
      try {
        socket.addMembership(GROUP);
      } catch (e) {
        this.error(e as Error);
      }
    }
    socket.setMulticastTTL(1);
    this.announce();
    this.timer = setInterval(() => this.announce(), 10000);
    this.timer.unref();
  }
  announce() {
    if (!this.socket) return;
    const data = Buffer.from(
      JSON.stringify({ ...this.info(), announce: true }),
    );
    for (const ip of addresses()) {
      try {
        this.socket.setMulticastInterface(ip);
        this.socket.send(data, DISCOVERY_PORT, GROUP, (e) => {
          if (e) this.error(e);
        });
      } catch (e) {
        this.error(e as Error);
      }
    }
  }
  stop() {
    clearInterval(this.timer);
    try {
      this.socket?.close();
    } catch {}
    this.socket = undefined;
  }
}
