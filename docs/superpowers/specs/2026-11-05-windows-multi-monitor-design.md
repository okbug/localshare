# Windows 多显示器键鼠共享方案

状态：已按用户指示实现，纳入 0.1.4 发布验证。目标是 Mac 控制 Windows 时，按照 Windows「设置 → 系统 → 显示」保存的排列，跨 Windows 自己的多个显示器移动、点击和使用键盘；同时正确返回 Mac。另合并 Mac 居中捕获与精确恢复原位置；自动化验证记录见 docs/verification.md。真实物理双机验证仍待完成。

## 已确认的代码限制

`native/windows.cpp` 在启动时只读取 `SM_CXSCREEN` / `SM_CYSCREEN`，移动目标也被裁剪到主屏的 `[0, width)` / `[0, height)`。SendInput 的绝对移动未设置 `MOUSEEVENTF_VIRTUALDESK`，返回及发起跨设备控制同样用主屏左右边界。没有拓扑变化刷新。这些限制足以解释无法进入副屏；尚未读取或实测用户 Windows 机器的实际排列。

## 选定方案

读取系统当前启用显示器的实际矩形，建立完整桌面坐标，按显示器相邻关系处理移动和边缘。单纯扩大到所有屏幕的包围矩形只能修复整齐排列，不能区分错位排列的空白区域及内部接缝；完整显示器矩形方案能覆盖本次需求。无需创建另一套 Windows 内部排列编辑器。

1. Windows helper 用 `EnumDisplayMonitors` 和 `GetMonitorInfo` 获取有效屏幕的坐标、分辨率及主屏标记；必要时用 `QueryDisplayConfig` / 设备信息获得显示名称、方向和可持久化标识。过滤镜像驱动伪显示器，对复制模式的重合桌面区域去重。
2. 使用 Windows 虚拟桌面原点、宽高，支持位于主屏左侧/上方的负坐标。输入辅助程序使用 Per-Monitor V2 DPI 感知，避免与 Electron 界面的逻辑坐标混用；拓扑和注入统一用物理像素。混合缩放下的鼠标速度手感另做验证，不承诺厘米级一致。
3. 绝对移动采用 `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`，按完整虚拟桌面坐标归一化。使用所有有效显示区域计算目标位置；移动路径经过共享边界时进入相邻屏幕。大步移动也检查路径，避免越过中间边界误触发返回。
4. Windows 屏幕之间共享的接缝不触发返回 Mac。错位屏幕只有实际连通的边界段可以直接穿越；落入没有显示器的空白区域时限制在有效边界，不停在空白处、不自动跳到远端屏幕。

## 进入 Windows 与返回 Mac

保持现有「Mac 在 Windows 左侧/右侧」设置。Windows 能读取自身显示器排列，但无法由此知道独立 Mac 的物理摆放位置；跨电脑的左右关系仍由现有设置指定。

默认入口取面向 Mac 一侧的最外层有效屏幕边界，根据 Mac 越界的纵向比例选择可用进入点；空白高度映射到最近的有效边界段。默认返回范围与这一面向 Mac 的外侧边界一致，只有继续向外移动时触发回穿。内部接缝始终优先进入 Windows 的相邻显示器。进入后加短暂防抖及边缘内缩，避免刚进入就返回。

可选高级设置允许指定入口显示器及其左/右边缘；仅允许该边缘实际暴露的部分作为跨电脑通道，被另一块 Windows 屏幕占据的部分仍属于内部接缝。自定义入口与返回使用同一通道规则。入口选择失效时先安全结束当前会话，回退自动入口并显示提示。

示例：`Mac | Windows 副屏 | Windows 主屏`。向右从 Mac 进入副屏，再向右进入主屏；向左从主屏进入副屏，继续从副屏最左侧越界才回 Mac。上下排列的 Windows 屏幕按系统排列上下移动，跨电脑入口本期仍保留左右方向。

Windows 发起对 Mac 的控制也使用同一外侧边缘规则，不再在任意主屏边界触发。Windows 捕获鼠标时，将锚点和恢复点保留在实际所在的有效显示器内，避免副屏或负坐标被强行拉回主屏。Mac 多显示器的捕获和接收本期不扩展。

## 布局变化与界面

- 启动、开启共享和每次建立会话前重新读取布局。使用隐藏消息窗口接收 `WM_DISPLAYCHANGE` 等变更通知，辅以低频检查，覆盖插拔、排列、分辨率、旋转与缩放变化。
- 活动会话期间布局改变：先释放键鼠、恢复本机控制，再重建布局；下一次跨屏使用新布局，避免旧坐标注入。
- 设备卡片展示按系统排列绘制的只读缩略图、主屏标记、有效跨电脑通道及自动/指定入口。Windows 自有屏幕排列仍在系统设置中调整；提供手动刷新。
- 如在 Mac 上展示 Windows 布局，仅对已配对设备通过现有证书/凭据鉴权连接同步布局元数据，不发送桌面截图。新增能力做版本协商，旧版本明确显示不支持，不静默忽略新入口设置。为布局数量、尺寸、坐标和消息体设置限制。

## 实施顺序与验收

1. 抽出可独立测试的显示器几何和坐标映射逻辑；先建立会失败的用例，再替换主屏限定与注入方式。
2. 接入系统排列、混合 DPI、正确进入/回穿、捕获锚点与布局变更安全恢复。初期界面沿用自动入口。
3. 接入只读布局预览、可选入口设置、配对设备的布局能力协商与提示。
4. 原生 Windows 构建和自检、Electron 界面检查，再做真实 Mac ↔ Windows 多屏验证。

必须覆盖：副屏在左/右/上/下，主屏位于中间，三屏和 L 形排列，错位/空白区域，负坐标，横竖屏，不同分辨率及 100%/150%/200% 混合缩放，复制/扩展模式，快速跨屏，插拔及更改主屏，拖动时跨屏、断线和紧急退出，单屏和现有滚轮/修饰键设置回归。自动化几何和构建验证不代替真实多屏鼠标注入测试。

## 参考资料

- [EnumDisplayMonitors](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdisplaymonitors)
- [GetMonitorInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmonitorinfow)
- [Windows Virtual Screen](https://learn.microsoft.com/en-us/windows/win32/gdi/the-virtual-screen)
- [MOUSEINPUT / MOUSEEVENTF_VIRTUALDESK](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
- [Per-Monitor DPI](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)
- [WM_DISPLAYCHANGE](https://learn.microsoft.com/en-us/windows/win32/gdi/wm-displaychange)
