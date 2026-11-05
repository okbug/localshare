import type { DisplayInfo, DisplayLayout } from "./types";

export const validDisplayId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);

export function parseDisplayLayout(value: unknown): DisplayLayout {
  const v = value as Partial<DisplayLayout> | undefined;
  if (
    !v ||
    v.version !== 1 ||
    v.platform !== "windows" ||
    v.entrySelection !== true ||
    !Array.isArray(v.displays) ||
    !v.displays.length ||
    v.displays.length > 32
  )
    throw new Error("屏幕布局无效或版本不支持，请升级两端应用");
  const ids = new Set<string>(),
    rectangles = new Set<string>();
  const displays = v.displays.map((d): DisplayInfo => {
    if (
      !d ||
      !validDisplayId(d.id) ||
      typeof d.name !== "string" ||
      d.name.length > 128 ||
      /[\x00-\x1f]/.test(d.name) ||
      typeof d.primary !== "boolean" ||
      ![d.x, d.y, d.width, d.height].every(Number.isSafeInteger) ||
      Math.abs(d.x) > 1000000 ||
      Math.abs(d.y) > 1000000 ||
      d.width < 1 ||
      d.height < 1 ||
      d.width > 32768 ||
      d.height > 32768
    )
      throw new Error("屏幕布局参数无效");
    const rect = `${d.x},${d.y},${d.width},${d.height}`;
    if (ids.has(d.id) || rectangles.has(rect))
      throw new Error("屏幕布局包含重复显示器");
    ids.add(d.id);
    rectangles.add(rect);
    return {
      id: d.id,
      name: d.name,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      primary: d.primary,
    };
  });
  if (displays.filter((d) => d.primary).length !== 1)
    throw new Error("屏幕布局缺少唯一主屏");
  return { version: 1, platform: "windows", entrySelection: true, displays };
}

// Only offer a display edge if at least part of it is not an internal seam.
export function entryDisplays(
  layout: DisplayLayout,
  side: "left" | "right",
): DisplayInfo[] {
  return layout.displays.filter((d) => {
    const x = side === "left" ? d.x : d.x + d.width;
    const covered = layout.displays
      .filter(
        (m) =>
          m.id !== d.id &&
          (side === "left"
            ? m.x < x && m.x + m.width >= x
            : m.x <= x && m.x + m.width > x),
      )
      .map((m) => [
        Math.max(d.y, m.y),
        Math.min(d.y + d.height, m.y + m.height),
      ])
      .filter(([lo, hi]) => lo < hi)
      .sort((a, b) => a[0] - b[0]);
    let end = d.y;
    for (const [lo, hi] of covered) {
      if (lo > end) return true;
      end = Math.max(end, hi);
    }
    return end < d.y + d.height;
  });
}
