import { clipboard } from "electron";
import { Extensions } from "../core/extensions";
import { ClipboardSyncQueue } from "../core/clipboard-sync";

export class ClipboardSync extends ClipboardSyncQueue {
  constructor(extensions: Extensions) {
    super(extensions, {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    });
  }
}
