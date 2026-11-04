import { useEffect, useState, type ReactNode } from "react";
import { version as appVersion } from "../../package.json";
import {
  ArrowUpRight,
  ArrowDownLeft,
  ArrowRight,
  ArrowLeft,
  Check,
  Clipboard,
  Copy,
  Download,
  File,
  FileText,
  Folder,
  History,
  Inbox,
  Laptop,
  Link,
  LoaderCircle,
  Monitor,
  MousePointer2,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Unlink,
  Upload,
  Wifi,
  X,
} from "lucide-react";
import type { DesktopSnapshot, Device, Transfer } from "../shared/types";

type Page = "send" | "receive" | "history" | "connect" | "settings";
const pages = [
  { id: "send", label: "发送", icon: Send },
  { id: "receive", label: "接收", icon: Inbox },
  { id: "history", label: "传输记录", icon: History },
  { id: "connect", label: "设备协同", icon: MousePointer2 },
  { id: "settings", label: "设置", icon: Settings },
] as const;
const sizes = ["B", "KB", "MB", "GB", "TB"];
function size(n: number) {
  if (!n) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`;
}
const statusLabel = {
  pending: "等待确认",
  transferring: "传输中",
  completed: "已完成",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "传输失败",
};
function DeviceIcon({
  device,
}: {
  device: { deviceType: string; deviceModel: string };
}) {
  return device.deviceType === "mobile" ? (
    <Smartphone />
  ) : /mac|apple/i.test(device.deviceModel) ? (
    <Laptop />
  ) : (
    <Monitor />
  );
}
function Toggle({
  on,
  change,
  label,
}: {
  on: boolean;
  change: () => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${on ? "on" : ""}`}
      onClick={change}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span />
    </button>
  );
}
function Empty({
  icon,
  heading,
  children,
}: {
  icon: ReactNode;
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{heading}</h3>
      <p>{children}</p>
    </div>
  );
}
export default function App() {
  const [state, setState] = useState<DesktopSnapshot>();
  const [page, setPage] = useState<Page>("send");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"files" | "text">("files");
  const [text, setText] = useState("");
  const [manual, setManual] = useState(false);
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("53317");
  const [http, setHttp] = useState(false);
  const [alias, setAlias] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    }
  };
  useEffect(() => {
    if (!window.localshare) {
      setError("请在 LocalShare 桌面应用中打开此界面。");
      return;
    }
    void window.localshare
      .snapshot()
      .then((s) => {
        setState(s);
        setAlias(s.info.alias);
      })
      .catch((e) => setError(e.message));
    return window.localshare.subscribe(setState);
  }, []);
  useEffect(() => {
    if (!error && !notice) return;
    const timer = setTimeout(() => {
      setError("");
      setNotice("");
    }, 6500);
    return () => clearTimeout(timer);
  }, [error, notice]);
  const copy = (value: string) =>
    run(async () => {
      await window.localshare.copyText(value);
      setNotice("已复制");
    });
  if (!state)
    return (
      <div className="loading">
        <div className="brand-mark">
          <Radio />
        </div>
        <h2>LocalShare</h2>
        <p>{error || "正在连接本地服务…"}</p>
      </div>
    );
  const pending = state.transfers.filter(
    (t) => t.direction === "receive" && t.status === "pending",
  );
  const active = state.transfers.filter((t) =>
    ["pending", "transferring"].includes(t.status),
  );
  const total = state.selection.reduce((n, f) => n + f.size, 0);
  const send = async (device: Device) => {
    if (busy) return;
    setBusy(device.fingerprint);
    await run(() =>
      window.localshare.send(
        device.fingerprint,
        mode === "text" ? text : undefined,
        pin || undefined,
      ),
    );
    setBusy(undefined);
  };
  const transferCard = (t: Transfer) => {
    const bytes = t.files.reduce((n, f) => n + f.bytes, 0),
      total = t.files.reduce((n, f) => n + f.size, 0);
    const progress = total
      ? Math.min(100, Math.round((bytes / total) * 100))
      : t.status === "completed"
        ? 100
        : 0;
    return (
      <div className="transfer" key={t.id}>
        <div className={`transfer-icon ${t.direction}`}>
          {t.direction === "send" ? <ArrowUpRight /> : <ArrowDownLeft />}
        </div>
        <div className="transfer-body">
          <div className="transfer-heading">
            <strong>
              {t.files.length === 1
                ? t.files[0].fileName
                : `${t.files.length} 个文件`}
            </strong>
            <span className={`status ${t.status}`}>
              {statusLabel[t.status]}
            </span>
          </div>
          <p>
            {t.direction === "send" ? "发送给" : "来自"} {t.peer}
            <span>·</span>
            {size(total)}
            <span>·</span>
            {new Date(t.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          {t.status === "transferring" ? (
            <>
              <div className="progress">
                <i style={{ width: `${progress}%` }} />
              </div>
              <small>
                {size(bytes)} / {size(total)} · {progress}%
              </small>
            </>
          ) : null}
          {t.error ? <small className="error-text">{t.error}</small> : null}
          {t.direction === "receive" && t.status === "completed" ? (
            <button
              className="text-button"
              onClick={() =>
                run(() =>
                  window.localshare.revealFile(
                    t.id,
                    t.files.find((f) => f.savedPath)?.id ?? "",
                  ),
                )
              }
            >
              <Folder size={14} />
              显示文件
            </button>
          ) : null}
        </div>
        {["pending", "transferring"].includes(t.status) &&
        !(t.direction === "receive" && t.status === "pending") ? (
          <button
            className="icon-button"
            title="取消传输"
            onClick={() => run(() => window.localshare.cancel(t.id))}
          >
            <X size={17} />
          </button>
        ) : null}
      </div>
    );
  };
  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths = [...e.dataTransfer.files]
          .map((f) => window.localshare.droppedPath(f))
          .filter(Boolean);
        if (paths.length) {
          setMode("files");
          setPage("send");
          void run(() => window.localshare.addDropped(paths));
        }
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Radio size={21} />
          </div>
          <span>
            LocalShare<small>让设备，近一点。</small>
          </span>
        </div>
        <div className="workspace-label">你的工作空间</div>
        <nav>
          {pages.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? "selected" : ""}
              onClick={() => setPage(p.id)}
            >
              <p.icon size={18} />
              {p.label}
              {p.id === "receive" && pending.length ? (
                <b className="badge">{pending.length}</b>
              ) : null}
              {p.id === "connect" ? (
                <span className="new-label">扩展</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={17} />
            <div>
              只在你的局域网<small>无需云端 · 无需账号</small>
            </div>
          </div>
          <div className="self-device">
            <div className="self-icon">
              <DeviceIcon device={state.info} />
              <i />
            </div>
            <div>
              <strong>{state.info.alias}</strong>
              <small>{state.addresses[0] || "暂无局域网地址"}</small>
            </div>
            <button
              className="icon-button"
              title="本机设置"
              onClick={() => setPage("settings")}
            >
              <Settings size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="connection-dot" />
            本地连接<span className="topbar-separator">/</span>
            <span>{pages.find((p) => p.id === page)?.label}</span>
          </div>
          <span className="version">
            v{appVersion}
            <span>桌面预览版</span>
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "send"
                  ? "SHARE SOMETHING GOOD"
                  : page === "connect"
                    ? "BETTER TOGETHER"
                    : "YOUR LOCAL WORKSPACE"}
              </div>
              <h1>
                {page === "send"
                  ? "分享，从这里开始。"
                  : page === "receive"
                    ? "准备好，接收美好。"
                    : page === "history"
                      ? "每一次传递，都在这里。"
                      : page === "connect"
                        ? "两台设备，一个工作空间。"
                        : "调成你喜欢的样子。"}
              </h1>
              <p>
                {page === "send"
                  ? "文件、文件夹或一段文字，直接送达身边的设备。"
                  : page === "receive"
                    ? "保持应用运行，即可接收同一局域网内的文件。"
                    : page === "history"
                      ? "查看已发送、已接收与正在进行的传输。"
                      : page === "connect"
                        ? "配对你的设备，接着复制，再接着工作。"
                        : "管理设备名称、接收位置和本地网络。"}
              </p>
            </div>
            <div className="local-pill">
              <Wifi size={14} />
              局域网直连
            </div>
          </div>
          {state.networkError ? (
            <div className="info-banner">
              <Wifi size={17} />
              {state.networkError}
            </div>
          ) : null}
          {page === "send" ? (
            <>
              <section className="panel compose-panel">
                <div className="panel-header">
                  <div className="section-title">
                    <span className="step-number">1</span>
                    <h2>选择要发送的内容</h2>
                  </div>
                  <div className="segmented">
                    <button
                      className={mode === "files" ? "active" : ""}
                      onClick={() => setMode("files")}
                    >
                      <Folder size={14} />
                      文件
                    </button>
                    <button
                      className={mode === "text" ? "active" : ""}
                      onClick={() => setMode("text")}
                    >
                      <FileText size={14} />
                      文本
                    </button>
                  </div>
                </div>
                {mode === "files" ? (
                  <>
                    <div
                      className="dropzone"
                      role="button"
                      tabIndex={0}
                      onClick={() => run(() => window.localshare.selectFiles())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          void run(() => window.localshare.selectFiles());
                      }}
                    >
                      <div className="upload-illustration">
                        <span className="paper back" />
                        <span className="paper front">
                          <ArrowUpRight size={28} />
                        </span>
                      </div>
                      <h3>把文件放在这里</h3>
                      <p>拖放文件或文件夹，或者点击选择</p>
                      <div className="drop-hint">
                        所有文件类型<span>·</span>直接传输到对方设备
                      </div>
                    </div>
                    <div className="compose-footer">
                      <div className="button-group">
                        <button
                          className="button primary"
                          onClick={() =>
                            run(() => window.localshare.selectFiles())
                          }
                        >
                          <Plus size={16} />
                          选择文件
                        </button>
                        <button
                          className="button"
                          onClick={() =>
                            run(() => window.localshare.selectFiles(true))
                          }
                        >
                          <Folder size={16} />
                          选择文件夹
                        </button>
                      </div>
                      <span className="muted">
                        {state.selection.length
                          ? `${state.selection.length} 个文件 · ${size(total)}`
                          : "支持多文件与文件夹"}
                      </span>
                    </div>
                    {state.selection.length ? (
                      <div className="selection-list">
                        {state.selection.slice(0, 8).map((f) => (
                          <div key={f.id}>
                            <File size={16} />
                            <span title={f.name}>{f.name}</span>
                            <small>{size(f.size)}</small>
                            <button
                              className="icon-button"
                              title={`移除 ${f.name}`}
                              onClick={() =>
                                run(() =>
                                  window.localshare.removeSelection(f.id),
                                )
                              }
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                        {state.selection.length > 8 ? (
                          <small>
                            还有 {state.selection.length - 8} 个文件
                          </small>
                        ) : null}
                        <button
                          className="text-button"
                          onClick={() =>
                            run(() => window.localshare.removeSelection())
                          }
                        >
                          清空选择
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="text-compose">
                    <textarea
                      aria-label="要发送的文字"
                      placeholder="写点什么，或粘贴一条链接…"
                      value={text}
                      maxLength={1000000}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <div>
                      <Clipboard size={14} />
                      文字会作为文本文件发送<span>{text.length} 字符</span>
                    </div>
                  </div>
                )}
              </section>
              <section className="devices-section">
                <div className="panel-header">
                  <div className="section-title">
                    <span className="step-number">2</span>
                    <h2>选择附近的设备</h2>
                    <span className="count">{state.devices.length}</span>
                  </div>
                  <div className="button-group">
                    <button
                      className="text-button"
                      onClick={() => setManual(true)}
                    >
                      <Plus size={14} />
                      手动添加
                    </button>
                    <button
                      className="icon-button"
                      title="刷新附近设备"
                      onClick={() => run(() => window.localshare.discover())}
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>
                </div>
                {state.devices.length ? (
                  <div className="device-grid">
                    {state.devices.map((d) => (
                      <button
                        className="device-card"
                        key={d.fingerprint}
                        onClick={() => send(d)}
                        disabled={
                          !!busy ||
                          (mode === "files"
                            ? !state.selection.length
                            : !text.trim())
                        }
                      >
                        <div
                          className={`device-avatar ${/windows/i.test(d.deviceModel) ? "blue" : ""}`}
                        >
                          <DeviceIcon device={d} />
                          <i />
                        </div>
                        <strong>{d.alias}</strong>
                        <small>
                          {d.deviceModel} · {d.ip}
                        </small>
                        <span className="device-action">
                          {busy === d.fingerprint ? (
                            <>
                              <LoaderCircle size={14} className="spin" />
                              等待传输完成
                            </>
                          ) : (
                            <>
                              发送到此设备
                              <ArrowRight size={14} />
                            </>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="discovery-empty">
                    <div className="radar">
                      <Radio size={24} />
                    </div>
                    <div>
                      <h3>正在寻找附近的设备</h3>
                      <p>
                        在另一台设备上打开 LocalShare 或
                        LocalSend，并连接同一网络。
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setManual(true)}
                      >
                        找不到设备？试试手动连接 <ArrowRight size={13} />
                      </button>
                    </div>
                    <span className="listening">
                      <i />
                      正在发现
                    </span>
                  </div>
                )}
                <div className="device-help">
                  <ShieldCheck size={14} />
                  选择设备后，对方确认接收，传输才会开始。
                  <details>
                    <summary>接收方需要 PIN？</summary>
                    <input
                      aria-label="接收 PIN"
                      placeholder="填写对方的接收 PIN"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                    />
                  </details>
                </div>
              </section>
              {active.length ? (
                <section>
                  <div className="panel-header">
                    <h2>正在传输</h2>
                    <button
                      className="text-button"
                      onClick={() => setPage("history")}
                    >
                      查看全部
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {active.map(transferCard)}
                </section>
              ) : null}
              <div className="bottom-note">
                <div className="mini-symbol">
                  <Link size={17} />
                </div>
                <p>
                  <strong>你的文件，走最短的路。</strong>
                  <span>无需上传到云端，设备间通过 HTTPS 直接传输。</span>
                </p>
                <ShieldCheck size={26} />
              </div>
            </>
          ) : null}
          {page === "receive" ? (
            <>
              <section className="receive-ready panel">
                <div className="ready-icon">
                  <Download size={30} />
                </div>
                <div>
                  <span className="live-label">
                    <i />
                    随时可以接收
                  </span>
                  <h2>{state.info.alias}</h2>
                  <p>
                    {state.addresses.join(" / ") || "未连接局域网"} · 端口{" "}
                    {state.info.port}
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() => copy(state.addresses[0] ?? "")}
                >
                  <Copy size={15} />
                  复制地址
                </button>
              </section>
              {pending.length ? (
                pending.map((t) => (
                  <section className="panel incoming-panel" key={t.id}>
                    <span className="eyebrow">新的传输请求</span>
                    <h2>
                      {t.peer} 想给你发送 {t.files.length} 个文件
                    </h2>
                    <div className="incoming-files">
                      {t.files.slice(0, 12).map((f) => (
                        <p key={f.id}>
                          <File size={15} />
                          {f.fileName}
                          <small>{size(f.size)}</small>
                        </p>
                      ))}
                    </div>
                    <div className="button-group">
                      <button
                        className="button"
                        onClick={() =>
                          run(() => window.localshare.respond(t.id, false))
                        }
                      >
                        <X size={16} />
                        拒绝
                      </button>
                      <button
                        className="button primary"
                        onClick={() =>
                          run(() => window.localshare.respond(t.id, true))
                        }
                      >
                        <Check size={16} />
                        接收文件
                      </button>
                    </div>
                  </section>
                ))
              ) : (
                <Empty icon={<Inbox />} heading="暂时没有待接收的内容">
                  有新的传输请求时，会显示在这里。
                </Empty>
              )}
              <div className="save-location">
                <Folder size={17} />
                <div>
                  <strong>文件保存到</strong>
                  <span>{state.receiveDir}</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => run(() => window.localshare.openReceiveDir())}
                >
                  打开文件夹
                  <ArrowUpRight size={14} />
                </button>
              </div>
              {state.transfers
                .filter(
                  (t) => t.direction === "receive" && t.status !== "pending",
                )
                .slice(-5)
                .reverse()
                .map(transferCard)}
            </>
          ) : null}
          {page === "history" ? (
            <>
              <div className="panel-header">
                <h2>
                  所有传输{" "}
                  <span className="count">{state.transfers.length}</span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => run(() => window.localshare.clearHistory())}
                >
                  清除已结束记录
                </button>
              </div>
              {state.transfers.length ? (
                [...state.transfers].reverse().map(transferCard)
              ) : (
                <Empty icon={<History />} heading="等待第一次分享">
                  你的传输记录会留在本机。
                </Empty>
              )}
            </>
          ) : null}
          {page === "connect" ? (
            <>
              <div className="extension-intro">
                <div>
                  <span className="feature-label">LOCALSHARE CONNECT</span>
                  <h2>复制一下，另一台就能粘贴。</h2>
                  <p>让 Mac 和 Windows 成为一个连续的工作空间。</p>
                </div>
                <div className="two-screens">
                  <Laptop size={62} />
                  <span>···</span>
                  <Monitor size={65} />
                </div>
              </div>
              <section className="panel settings-panel">
                <div className="setting-row">
                  <div className="setting-icon">
                    <Clipboard />
                  </div>
                  <div>
                    <h3>文本剪贴板共享</h3>
                    <p>
                      仅同步到已配对且开启同步的设备；每次启动后需重新开启。
                    </p>
                  </div>
                  <Toggle
                    on={state.extensions.clipboardEnabled}
                    label="文本剪贴板共享"
                    change={() =>
                      run(() =>
                        window.localshare.extensionSettings(
                          !state.extensions.clipboardEnabled,
                          state.extensions.controlEnabled,
                        ),
                      )
                    }
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-icon">
                    <MousePointer2 />
                  </div>
                  <div>
                    <h3>
                      跨屏键盘与鼠标 <span className="beta">实验功能</span>
                    </h3>
                    <p>移动到主屏幕边缘后切换到相邻设备。</p>
                  </div>
                  <Toggle
                    on={state.extensions.controlEnabled}
                    label="跨屏键盘与鼠标"
                    change={() =>
                      run(() =>
                        window.localshare.extensionSettings(
                          state.extensions.clipboardEnabled,
                          !state.extensions.controlEnabled,
                        ),
                      )
                    }
                  />
                </div>
                {!state.native.permission || state.native.error ? (
                  <div className="permission-note">
                    <ShieldCheck size={18} />
                    <div>
                      {state.native.error ||
                        "跨屏输入需要系统辅助功能权限。文件传输和剪贴板不受影响。"}
                    </div>
                    <button
                      className="button"
                      onClick={() =>
                        run(() => window.localshare.requestPermission())
                      }
                    >
                      检查权限
                    </button>
                  </div>
                ) : null}
                <div className="control-status">
                  <span className="connection-dot" />
                  {state.extensions.control.mode === "local"
                    ? "当前控制本机"
                    : `${state.extensions.control.mode === "sending" ? "正在控制" : "正由其他设备控制"} · ${state.extensions.control.peer ?? ""}`}
                  <button
                    className="text-button"
                    onClick={() => run(() => window.localshare.emergencyStop())}
                  >
                    恢复本机控制
                  </button>
                  <kbd>Ctrl + Alt + Esc</kbd>
                </div>
              </section>
              <div className="panel-header">
                <h2>已配对设备</h2>
                <small className="muted">两端均需开启对应功能</small>
              </div>
              {state.extensions.trusted.length ? (
                state.extensions.trusted.map((p) => (
                  <section className="panel trusted-card" key={p.fingerprint}>
                    <div className="trusted-heading">
                      <div className="device-avatar">
                        <Monitor />
                      </div>
                      <div>
                        <h3>{p.alias}</h3>
                        <small>
                          {state.devices.some(
                            (d) => d.fingerprint === p.fingerprint,
                          )
                            ? "在线"
                            : "离线"}{" "}
                          · 指纹 {p.fingerprint.slice(0, 12)}…
                        </small>
                      </div>
                      <button
                        className="icon-button"
                        title="取消配对"
                        onClick={() =>
                          run(() => window.localshare.unpair(p.fingerprint))
                        }
                      >
                        <Unlink size={17} />
                      </button>
                    </div>
                    <div className="peer-options">
                      <label>
                        文本同步
                        <Toggle
                          label={`${p.alias} 文本同步`}
                          on={p.clipboard}
                          change={() =>
                            run(() =>
                              window.localshare.peerSettings(p.fingerprint, {
                                clipboard: !p.clipboard,
                              }),
                            )
                          }
                        />
                      </label>
                      <label>
                        共享键鼠
                        <Toggle
                          label={`${p.alias} 共享键鼠`}
                          on={p.control}
                          change={() =>
                            run(() =>
                              window.localshare.peerSettings(p.fingerprint, {
                                control: !p.control,
                              }),
                            )
                          }
                        />
                      </label>
                      <label>
                        设备位于本机
                        <select
                          aria-label={`${p.alias} 位置`}
                          value={p.side}
                          onChange={(e) =>
                            run(() =>
                              window.localshare.peerSettings(p.fingerprint, {
                                side: e.target.value as "left" | "right",
                              }),
                            )
                          }
                        >
                          <option value="left">← 左侧</option>
                          <option value="right">右侧 →</option>
                        </select>
                      </label>
                    </div>
                    <div className="screen-layout">
                      {p.side === "left" ? (
                        <span>
                          <Monitor size={24} />
                          {p.alias}
                        </span>
                      ) : null}
                      <div>
                        <Laptop size={27} />
                        本机
                      </div>
                      {p.side === "right" ? (
                        <span>
                          <Monitor size={24} />
                          {p.alias}
                        </span>
                      ) : null}
                    </div>
                  </section>
                ))
              ) : (
                <Empty icon={<Link />} heading="先配对你的另一台设备">
                  两端核对相同的 6 位校验码，即可建立信任。
                </Empty>
              )}
              <h2 className="section-spacing">可配对的设备</h2>
              {state.devices
                .filter(
                  (d) =>
                    d.localshare &&
                    !state.extensions.trusted.some(
                      (p) => p.fingerprint === d.fingerprint,
                    ),
                )
                .map((d) => (
                  <div className="available-peer" key={d.fingerprint}>
                    <Monitor size={23} />
                    <div>
                      <strong>{d.alias}</strong>
                      <small>
                        {d.ip} · {d.deviceModel}
                      </small>
                    </div>
                    <button
                      className="button"
                      onClick={() =>
                        run(() => window.localshare.pair(d.fingerprint))
                      }
                    >
                      <Link size={15} />
                      配对
                    </button>
                  </div>
                ))}
              {!state.devices.some(
                (d) =>
                  d.localshare &&
                  !state.extensions.trusted.some(
                    (p) => p.fingerprint === d.fingerprint,
                  ),
              ) ? (
                <p className="muted">
                  暂无可配对设备。请在另一台电脑打开 LocalShare。
                </p>
              ) : null}
            </>
          ) : null}
          {page === "settings" ? (
            <>
              <section className="panel settings-panel">
                <div className="settings-title">
                  <Laptop size={19} />
                  <h2>本机设备</h2>
                </div>
                <div className="field">
                  <label htmlFor="alias">设备名称</label>
                  <div className="input-action">
                    <input
                      id="alias"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      maxLength={100}
                    />
                    <button
                      className="button primary"
                      onClick={() =>
                        run(async () => {
                          await window.localshare.settings(alias);
                          setNotice("设备名称已更新");
                        })
                      }
                    >
                      保存名称
                    </button>
                  </div>
                  <small>其他设备会通过这个名称找到你。</small>
                </div>
                <div className="field">
                  <label>接收位置</label>
                  <div className="path-field">
                    <Folder size={17} />
                    <span>{state.receiveDir}</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        run(() => window.localshare.chooseReceiveDir())
                      }
                    >
                      更改
                    </button>
                  </div>
                </div>
              </section>
              <section className="panel settings-panel">
                <div className="settings-title">
                  <Wifi size={19} />
                  <h2>连接信息</h2>
                </div>
                <div className="details-grid">
                  <span>本机地址</span>
                  <strong>{state.addresses.join(" / ") || "未连接"}</strong>
                  <span>监听端口</span>
                  <strong>{state.info.port} · HTTPS</strong>
                  <span>发现协议</span>
                  <strong>LocalSend v2 · UDP 53317</strong>
                  <span>证书指纹</span>
                  <button
                    className="fingerprint"
                    onClick={() => copy(state.info.fingerprint)}
                    title="复制完整证书指纹"
                  >
                    {state.info.fingerprint}
                    <Copy size={13} />
                  </button>
                </div>
              </section>
              <section className="panel settings-panel">
                <div className="settings-title">
                  <ShieldCheck size={19} />
                  <h2>关于 LocalShare</h2>
                </div>
                <p className="settings-description">
                  为附近的设备设计。文件直接在设备间传输，不经过第三方服务器。基础传输参考
                  LocalSend 开源协议；扩展功能需要双方安装 LocalShare。
                </p>
                <div className="about-tags">
                  <span>Electron + Bun</span>
                  <span>Apache-2.0</span>
                  <span>v{appVersion}</span>
                </div>
              </section>
            </>
          ) : null}
        </div>
        <footer>
          <span>
            <span className="connection-dot" />
            本机服务已就绪
          </span>
          <span>LOCAL FIRST. ALWAYS.</span>
        </footer>
      </main>
      {pending.length && page !== "receive" ? (
        <button className="incoming-toast" onClick={() => setPage("receive")}>
          <Download size={20} />
          <div>
            <strong>有 {pending.length} 个新的传输请求</strong>
            <span>点击查看并确认接收</span>
          </div>
          <ArrowRight size={18} />
        </button>
      ) : null}
      {manual ? (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await window.localshare.register(
                  ip.trim(),
                  Number(port),
                  http ? "http" : "https",
                );
                setManual(false);
                setNotice("已连接设备");
              });
            }}
          >
            <button
              type="button"
              className="icon-button modal-close"
              title="关闭"
              onClick={() => setManual(false)}
            >
              <X />
            </button>
            <div className="modal-icon">
              <Wifi />
            </div>
            <h2>直接连接设备</h2>
            <p>填写对方“接收”页面显示的局域网地址。</p>
            <label>
              IP 地址
              <input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="192.168.1.100"
                required
                autoFocus
              />
            </label>
            <label>
              端口
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                required
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={http}
                onChange={(e) => setHttp(e.target.checked)}
              />
              对方关闭了加密（使用 HTTP）
            </label>
            <button className="button primary wide" type="submit">
              连接设备
              <ArrowRight size={16} />
            </button>
          </form>
        </div>
      ) : null}
      {state.extensions.pairing[0]
        ? (() => {
            const p = state.extensions.pairing[0];
            return (
              <div className="modal-backdrop">
                <div className="modal pair-modal">
                  <div className="modal-icon">
                    <Link />
                  </div>
                  <h2>与 {p.peer.alias} 配对</h2>
                  <p>请确认两端显示的校验码一致。确认后才会建立设备信任。</p>
                  <div className="pair-code">
                    {p.code.slice(0, 3)} {p.code.slice(3)}
                  </div>
                  <small>对方证书指纹</small>
                  <code className="pair-fingerprint">{p.peer.fingerprint}</code>
                  <div className="button-group">
                    <button
                      className="button"
                      onClick={() =>
                        run(() => window.localshare.respondPair(p.id, false))
                      }
                    >
                      取消
                    </button>
                    <button
                      className="button primary"
                      onClick={() =>
                        run(() => window.localshare.respondPair(p.id, true))
                      }
                    >
                      <Check size={16} />
                      校验码相同
                    </button>
                  </div>
                  <p className="tiny">
                    双方确认后自动关闭；90 秒内未完成将取消。
                  </p>
                </div>
              </div>
            );
          })()
        : null}
      {error || notice ? (
        <div className={`toast ${error ? "error" : ""}`} role="alert">
          {error ? <X size={16} /> : <Check size={16} />}
          <span>{error || notice}</span>
          <button
            className="icon-button"
            title="关闭提示"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {dragging ? (
        <div className="drag-overlay">
          <Upload size={48} />
          <h2>松开，添加到发送列表</h2>
        </div>
      ) : null}
    </div>
  );
}
