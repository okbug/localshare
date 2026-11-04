import { randomUUID } from "node:crypto";
type Ack = "captured" | "receiving";
export class NativeCommands {
  private pending = new Map<
    Ack,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      requestId: string;
    }
  >();
  constructor(
    private write: (command: Record<string, unknown>) => void,
    private timeout = 800,
  ) {}
  request(command: Record<string, unknown>, ack: Ack): Promise<void> {
    if (this.pending.has(ack))
      return Promise.reject(new Error("原生输入模块正在切换状态"));
    return new Promise<void>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(ack);
        reject(new Error("原生输入模块确认超时，已恢复本机控制"));
      }, this.timeout);
      this.pending.set(ack, { resolve, reject, timer, requestId });
      try {
        this.write({ ...command, requestId });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  accept(event: { type?: unknown; requestId?: unknown }): boolean {
    if (event.type !== "captured" && event.type !== "receiving") return false;
    const item = this.pending.get(event.type);
    if (!item || event.requestId !== item.requestId) return false;
    clearTimeout(item.timer);
    this.pending.delete(event.type);
    item.resolve();
    return true;
  }
  fail(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}
