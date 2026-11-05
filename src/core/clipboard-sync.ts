import type { Extensions } from "./extensions";

export interface ClipboardBackend {
  readText(): string | Promise<string>;
  writeText(text: string): void | Promise<void>;
}

/** Serializes OS access; no Electron dependency or desktop access in tests. */
export class ClipboardSyncQueue {
  private last = "";
  private queue: Promise<void> = Promise.resolve();
  private polling = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private enqueue(fn: () => Promise<void>) {
    if (this.stopped) return Promise.resolve();
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped) await fn();
      })
      .catch(() => {});
    return this.queue;
  }
  private baseline = () =>
    this.enqueue(async () => {
      const text = await this.backend.readText();
      if (this.stopped) return;
      this.last = text;
      this.extensions.noteClipboardChange(text);
    });
  private receive = (text: string, permit: () => boolean = () => true) => {
    void this.enqueue(async () => {
      if (!permit()) return;
      // No await between the lease check and issuing the actual OS write.
      await this.backend.writeText(text);
      this.last = text;
      this.extensions.noteClipboardChange(text);
    });
  };
  constructor(
    private extensions: Extensions,
    private backend: ClipboardBackend,
    interval = 650,
  ) {
    void this.baseline();
    extensions.on("clipboard", this.receive);
    extensions.on("settingsChanged", this.baseline);
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.poll();
      }, interval);
      this.timer.unref();
    }
  }
  poll(): Promise<void> {
    if (
      this.stopped ||
      this.polling ||
      !this.extensions.snapshot().clipboardEnabled
    )
      return Promise.resolve();
    const send = this.extensions.prepareClipboardSend();
    this.polling = true;
    return this.enqueue(async () => {
      try {
        const text = await this.backend.readText();
        if (this.stopped || text === this.last) return;
        this.last = text;
        this.extensions.noteClipboardChange(text);
        if (!text || Buffer.byteLength(text) > 1024 * 1024) return;
        await send(text);
      } finally {
        this.polling = false;
      }
    });
  }
  /** Waits all work already issued, including writes that cannot be canceled. */
  flush(): Promise<void> {
    return this.queue;
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.extensions.off("clipboard", this.receive);
    this.extensions.off("settingsChanged", this.baseline);
  }
}
