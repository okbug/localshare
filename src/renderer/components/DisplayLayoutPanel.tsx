import { useEffect, useState } from "react";
import type { DisplayLayout, TrustedPeer } from "../../shared/types";
import { entryDisplays } from "../../shared/displays";

export function DisplayLayoutPanel({
  peer,
  layout,
  change,
}: {
  peer: TrustedPeer;
  layout?: DisplayLayout;
  change: (patch: Partial<TrustedPeer>) => Promise<unknown>;
}) {
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      await window.localshare.refreshDisplays(peer.fingerprint);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [peer.fingerprint]);
  const side = peer.side === "right" ? "left" : "right";
  const choices = layout ? entryDisplays(layout, side) : [];
  const missing =
    !!peer.entryDisplay && !choices.some((d) => d.id === peer.entryDisplay);
  const ds = layout?.displays ?? [];
  const x = ds.length ? Math.min(...ds.map((d) => d.x)) : 0,
    y = ds.length ? Math.min(...ds.map((d) => d.y)) : 0;
  const w = ds.length ? Math.max(...ds.map((d) => d.x + d.width)) - x : 1,
    h = ds.length ? Math.max(...ds.map((d) => d.y + d.height)) - y : 1;
  const font = Math.max(w / 55, h / 20),
    margin = font;
  return (
    <section
      className="display-layout-panel"
      aria-label={`${peer.alias} 屏幕排列与入口`}
    >
      <div className="display-layout-heading">
        <h4>屏幕排列与入口</h4>
        <button
          className="button subtle small"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "正在读取…" : "刷新排列"}
        </button>
      </div>
      <p>
        跟随 Windows
        显示设置的排列，屏幕之间正常穿越；从面向本机的外侧边缘返回。
      </p>
      {layout ? (
        <>
          <svg
            className="monitor-map"
            role="img"
            aria-label={`${peer.alias} 的 ${ds.length} 块屏幕排列`}
            viewBox={`${x - margin} ${y - margin} ${w + margin * 2} ${h + margin * 2}`}
          >
            {ds.map((d) => (
              <g key={d.id}>
                <title>
                  {d.name} · {d.width} × {d.height}
                  {d.primary ? " · 主屏" : ""}
                </title>
                <rect
                  x={d.x + 2}
                  y={d.y + 2}
                  width={Math.max(1, d.width - 4)}
                  height={Math.max(1, d.height - 4)}
                  rx={Math.min(font / 3, d.width / 8, d.height / 8)}
                  fill={peer.entryDisplay === d.id ? "#dcebcf" : "#f3f6ee"}
                  stroke={d.primary ? "#6d9466" : "#a1b291"}
                  strokeWidth={font / 12}
                />
                <text
                  x={d.x + d.width / 2}
                  y={d.y + d.height / 2}
                  textAnchor="middle"
                  fontSize={font}
                  fill="#364d3c"
                >
                  {d.name.length > 16 ? `${d.name.slice(0, 15)}…` : d.name}
                </text>
                {d.primary ? (
                  <text
                    x={d.x + d.width / 2}
                    y={d.y + d.height / 2 + font * 1.5}
                    textAnchor="middle"
                    fontSize={font * 0.8}
                    fill="#6c805e"
                  >
                    主屏
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          <label className="display-entry-select">
            进入 Windows 的屏幕
            <select
              aria-label={`${peer.alias} 进入屏幕`}
              value={peer.entryDisplay}
              onChange={(e) =>
                void change({ entryDisplay: e.target.value }).catch((e) =>
                  setError((e as Error).message),
                )
              }
            >
              <option value="">自动 · 靠近本机一侧的外边缘</option>
              {missing ? (
                <option value={peer.entryDisplay} disabled>
                  原入口不可用，请选择自动或其他屏幕
                </option>
              ) : null}
              {choices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.primary ? "（主屏）" : ""} ·{" "}
                  {side === "left" ? "左" : "右"}边缘
                </option>
              ))}
            </select>
          </label>
          <p>指定入口只使用未被其他屏幕挡住的边缘。修改后，下次跨屏生效。</p>
        </>
      ) : (
        <p>
          {loading
            ? "正在读取对方的屏幕排列…"
            : "尚未读取屏幕排列；自动入口可直接使用。"}
        </p>
      )}
      {error ? (
        <p role="status" className="display-layout-error">
          {error}
          {layout ? "；当前预览可能已过期，请刷新。" : ""}
        </p>
      ) : null}
      {!layout && peer.entryDisplay ? (
        <button
          className="button subtle small"
          onClick={() =>
            void change({ entryDisplay: "" }).catch((e) =>
              setError((e as Error).message),
            )
          }
        >
          恢复自动入口
        </button>
      ) : null}
    </section>
  );
}
