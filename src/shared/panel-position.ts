export interface PanelRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function controlPanelBounds(area: PanelRectangle): PanelRectangle {
  const width = Math.min(440, Math.max(1, area.width));
  const height = Math.min(130, Math.max(1, area.height));
  return {
    x: Math.max(area.x, area.x + area.width - width - 16),
    y: Math.min(area.y + 16, area.y + Math.max(0, area.height - height)),
    width,
    height,
  };
}
