import { randomUUID } from "node:crypto";
export interface NativeLifecycleBackend<Owner> {
  request(
    owner: Owner,
    command: string,
    ack: "captured" | "receiving" | "released",
    id?: string,
    payload?: Record<string, unknown>,
  ): Promise<void>;
  cancelActivation(): void;
  isLive(owner: Owner): boolean;
  terminate(owner: Owner): Promise<void>;
  recoverAfterExit(): Promise<void>;
  disable(): void | Promise<void>;
  changed(): void;
  fallback?(error: unknown): void;
}
/** Owns a native lease independently of reservations in the network control layer. */
export class NativeInputLifecycle<Owner> {
  recovering = false;
  recoveryFailed = false;
  private current?: Owner;
  private owned?: Owner;
  private desiredActive = false;
  private releaseId?: string;
  private barrier?: Promise<void>;
  private activationGeneration = 0;
  constructor(private backend: NativeLifecycleBackend<Owner>) {}
  attach(owner: Owner): void {
    if (this.recovering || this.recoveryFailed || this.owned)
      throw new Error("本机输入尚未完成恢复");
    this.current = owner;
  }
  waitForRelease(): Promise<void> {
    return (
      this.barrier ??
      (this.recoveryFailed
        ? Promise.reject(new Error("本机指针恢复失败，请重试恢复"))
        : Promise.resolve())
    );
  }
  async activate(
    owner: Owner | undefined,
    command: string,
    ack: "captured" | "receiving",
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const generation = this.activationGeneration;
    await this.waitForRelease();
    if (generation !== this.activationGeneration)
      throw new Error("输入切换已取消");
    if (
      owner === undefined ||
      this.current !== owner ||
      !this.backend.isLive(owner)
    )
      throw new Error("原生输入模块已退出");
    this.desiredActive = true;
    this.owned = owner;
    try {
      await this.backend.request(owner, command, ack, undefined, payload);
      if (!this.desiredActive || this.current !== owner)
        throw new Error("输入切换已取消");
    } catch (error) {
      // A command can take effect even when its ACK is lost.
      await this.release().catch(() => {});
      throw error;
    }
  }
  release(): Promise<void> {
    ++this.activationGeneration;
    this.desiredActive = false;
    this.backend.cancelActivation();
    if (this.barrier) return this.barrier;
    if (!this.owned && !this.recoveryFailed) return Promise.resolve();
    return this.begin(false);
  }
  recover(): Promise<void> {
    ++this.activationGeneration;
    this.desiredActive = false;
    this.backend.cancelActivation();
    if (this.barrier) {
      this.disableSharing();
      return this.barrier;
    }
    if (
      !this.owned &&
      !this.recoveryFailed &&
      (!this.current || !this.backend.isLive(this.current))
    ) {
      this.disableSharing();
      return Promise.resolve();
    }
    if (!this.owned) this.owned = this.current;
    return this.begin(true);
  }
  exited(owner: Owner): Promise<void> {
    if (this.current === owner) this.current = undefined;
    if (this.owned !== owner) return Promise.resolve();
    this.desiredActive = false;
    return this.barrier ?? this.begin(true);
  }
  heartbeat(): { cmd: string; active: boolean; releaseRequestId?: string } {
    return {
      cmd: "heartbeat",
      active: this.desiredActive,
      ...(this.releaseId ? { releaseRequestId: this.releaseId } : {}),
    };
  }
  private begin(force: boolean): Promise<void> {
    const owner = this.owned;
    if (!owner)
      return Promise.reject(new Error("无法确定需要恢复的原生输入模块"));
    this.recovering = true;
    this.releaseId = randomUUID();
    // Defer execution until barrier is installed, including synchronous backend failures.
    const task = Promise.resolve().then(async () => {
      if (force) this.disableSharing();
      try {
        try {
          if (!this.backend.isLive(owner))
            throw new Error("原生输入模块已退出");
          await this.backend.request(
            owner,
            force ? "recover" : "release",
            "released",
            this.releaseId,
          );
        } catch (error) {
          try {
            this.backend.fallback?.(error);
          } catch {
            /* Diagnostics must not delay cleanup. */
          }
          if (!force) this.disableSharing();
          await this.backend.terminate(owner);
          if (this.current === owner) this.current = undefined;
          await this.backend.recoverAfterExit();
        }
        if (this.owned === owner) this.owned = undefined;
        this.recoveryFailed = false;
      } catch (error) {
        this.recoveryFailed = true;
        throw error;
      } finally {
        this.recovering = false;
        this.releaseId = undefined;
        this.notify();
      }
    });
    this.barrier = task;
    this.notify();
    void task
      .finally(() => {
        if (this.barrier === task) this.barrier = undefined;
      })
      .catch(() => {});
    return task;
  }
  private disableSharing(): void {
    try {
      void Promise.resolve(this.backend.disable()).catch(() => {});
    } catch {
      // Revoking sharing must never block the actual pointer cleanup.
    }
  }
  private notify(): void {
    try {
      this.backend.changed();
    } catch {
      /* Physical cleanup must survive UI notification errors. */
    }
  }
}
