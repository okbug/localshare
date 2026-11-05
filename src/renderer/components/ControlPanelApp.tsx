import { useEffect, useState } from "react";
import type { ControlPanelState } from "../../shared/types";

export default function ControlPanelApp() {
  const [state, setState] = useState<ControlPanelState | null>(null),
    [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!window.controlPanel) {
      setError("控制窗口不可用，请使用停止快捷键。");
      return;
    }
    let mounted = true,
      received = false;
    const off = window.controlPanel.subscribe((value) => {
      received = true;
      if (mounted) setState(value);
    });
    void window.controlPanel
      .snapshot()
      .then((value) => {
        if (mounted && !received) setState(value);
      })
      .catch(() => {
        if (mounted) setError("无法读取控制状态，请使用停止快捷键。");
      });
    return () => {
      mounted = false;
      off();
    };
  }, []);
  const stop = async () => {
    if (!state || stopping) return;
    setStopping(true);
    setError("");
    try {
      await window.controlPanel.stop(state.sessionId);
    } catch {
      setError("停止请求未完成，请使用快捷键停止。");
    } finally {
      setStopping(false);
    }
  };
  const recovering = state?.phase === "recovering",
    failed = state?.phase === "recovery-failed";
  return (
    <main className="control-overlay" aria-label="键鼠共享悬浮窗口">
      <div className="control-overlay-row">
        <div className="control-overlay-heading" title={state?.peer}>
          <span className="connection-dot" />
          <strong>
            {recovering
              ? "正在恢复本机键鼠"
              : failed
                ? "本机输入恢复未确认"
                : state
                  ? state.direction === "sending"
                    ? `正在控制 ${state.peer}`
                    : `${state.peer} 正在控制本机`
                  : "当前未在共享"}
          </strong>
        </div>
        <button
          className="control-overlay-stop"
          aria-label={failed ? "恢复本机鼠标" : "停止键鼠与文本共享"}
          disabled={!state || stopping || recovering}
          onClick={() => void stop()}
        >
          {recovering
            ? "恢复中…"
            : stopping
              ? "处理中…"
              : failed
                ? "恢复鼠标"
                : "停止共享"}
        </button>
      </div>
      <div className="control-overlay-row control-overlay-details">
        <span>
          {recovering || failed
            ? "键鼠转发已停止"
            : `本机文本同步：${state?.clipboard ? "开启" : "关闭"}`}
        </span>
        {state ? <kbd>{state.shortcut}</kbd> : null}
      </div>
      <p className="control-overlay-hint" role="status">
        {error ||
          (recovering
            ? "正在等待底层解除锁定，请稍候。"
            : failed
              ? "按快捷键或点击恢复鼠标重试；必要时完全退出应用。"
              : state?.direction === "sending"
                ? "本机鼠标已接管，可在对方屏幕点击停止，或使用上述快捷键。"
                : "点击停止或按快捷键，结束键鼠接管并暂停此设备的文本同步。")}
      </p>
    </main>
  );
}
