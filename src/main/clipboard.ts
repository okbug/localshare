import { clipboard } from "electron";
import { Extensions } from "../core/extensions";
export class ClipboardSync {
  private last = "";
  private timer: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private polling = false;
  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch(() => {});
  }
  constructor(extensions: Extensions) {
    this.enqueue(async () => {
      this.last = await clipboard.readText();
      extensions.noteClipboardChange(this.last);
    });
    extensions.on("clipboard", (text: string) =>
      this.enqueue(async () => {
        this.last = text;
        await clipboard.writeText(text);
      }),
    );
    extensions.on("settingsChanged", () =>
      this.enqueue(async () => {
        this.last = await clipboard.readText();
        extensions.noteClipboardChange(this.last);
      }),
    );
    this.timer = setInterval(() => {
      if (!extensions.snapshot().clipboardEnabled || this.polling) return;
      this.polling = true;
      this.enqueue(async () => {
        try {
          const text = await clipboard.readText();
          if (text === this.last) return;
          this.last = text;
          extensions.noteClipboardChange(text);
          if (!text || Buffer.byteLength(text) > 1024 * 1024) return;
          await extensions.sendClipboard(text);
        } finally {
          this.polling = false;
        }
      });
    }, 650);
  }
  stop() {
    clearInterval(this.timer);
  }
}
