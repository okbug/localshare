import type { ControlPanelState } from "./types";
export class PanelRecoveryView {
  private last: ControlPanelState | null = null;
  constructor(private fallback: () => ControlPanelState) {}
  select(
    current: ControlPanelState | null,
    native: { recovering?: boolean; recoveryFailed?: boolean; error?: string },
  ): ControlPanelState | null {
    if (current) this.last = { ...current, phase: "sharing", error: undefined };
    if (native.recovering || native.recoveryFailed) {
      this.last ??= this.fallback();
      return {
        ...this.last,
        phase: native.recovering ? "recovering" : "recovery-failed",
        error: native.error,
      };
    }
    if (!current) this.last = null;
    return this.last;
  }
}
