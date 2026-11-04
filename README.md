# LocalShare

Electron + Bun 的局域网共享桌面应用。中文界面，面向 macOS 与 Windows。

参考 [LocalSend 源码](https://github.com/localsend/localsend)和 [v2 协议](https://github.com/localsend/protocol)，独立实现传输核心，并加入可信设备协同。

[下载安装包](https://github.com/okbug/localshare/releases) · [源码仓库](https://github.com/okbug/localshare)

**Mac 用户请使用 0.1.1 或更新版本。** 0.1.0 的 Mac 包资源签名不完整，会触发“已损坏，无法打开”；0.1.1 修复应用与原生模块签名，并增加 ZIP 解压后的严格校验。

![发送界面](docs/images/localshare.png)

## 功能

- 局域网自动发现、手动 IP / 端口连接、文件、递归文件夹、文本发送。
- 接收确认 / 拒绝、传输进度、取消、历史、接收位置设置、后台托盘。
- HTTPS 流式传输、持久化证书、传输前核对证书指纹、会话令牌、SHA-256 验证、同名文件不覆盖。
- 双端确认配对、文本剪贴板同步（最多 1 MiB、防回环、不记录正文）、撤销信任。
- 实验性跨屏键鼠：相邻设备位于主屏左侧或右侧、鼠标回穿、事件顺序、心跳断线恢复、`Ctrl + Alt + Esc` 紧急退出。

基础传输实现 LocalSend v2 上传接口；没有宣称涵盖官方所有功能。网页下载分享、断点续传、空目录、自动接收、图片/文件剪贴板、多显示器和跨设备文件拖拽不属于当前版本。LocalSend 客户端无需安装 LocalShare 即可使用基础传输协议；剪贴板和键鼠扩展需要双方安装 LocalShare。官方客户端互通尚待实机验证。

## 开发与运行

需要 Bun 1.3.5+、Node 22+。macOS 构建输入模块需要 Command Line Tools；Windows 构建输入模块需要 Visual Studio Build Tools 的 C++ 工具链（在 x64 Native Tools 命令行运行）。打包后的使用者不需要安装 Bun、Node 或开发工具。

```sh
bun install --frozen-lockfile
bun run native
bun run dev
```

`dev` 支持界面热更新；主进程或 preload 改动后重启。生产模式：

```sh
bun run build
bun run start
```

关闭窗口后继续在系统托盘 / 菜单栏运行。要退出应用，使用托盘的“退出 LocalShare”或应用菜单。

## 在 Mac 与 Windows 上使用

1. 两端打开 LocalShare 并连接同一个局域网。首次运行，按系统提示允许本地网络访问。
2. 在发送页选择文件或拖入文件夹，点击附近的设备；对方在接收页确认。
3. 自动发现不可用时，点击“手动添加”，填写对方接收页的 IP 与端口。
4. 剪贴板：在“设备协同”中配对，核对两端 6 位校验码与完整指纹，双端确认；两端都打开“文本剪贴板共享”，并打开对应设备的“文本同步”。随后新复制的文本会同步。开启时不会发送之前已经存在的剪贴板文本。
5. 键鼠：两端都开启键鼠总开关和对应设备开关。在 Mac 上将 Windows 设置到“右侧”，在 Windows 上将 Mac 设置到“左侧”。Mac 鼠标越过主屏右边缘进入 Windows；向左越过 Windows 边缘返回。反向也可从 Windows 发起。
6. 需要时按 **Ctrl + Alt + Esc**（Mac：Control + Option + Escape）恢复本机控制。断线后约 2 秒自动恢复，原生模块在父进程失去响应时也有独立超时保护。

每次启动后，剪贴板与键鼠总开关默认关闭；设备信任及左右位置保留。取消配对会撤销本机信任，并在对方在线时通知其撤销；对方离线时请在其界面也取消旧配对，再重新建立。

**系统权限与限制：** macOS 在“设备协同 → 检查权限”中查看并为应用 / `localshare-input` 授予辅助功能权限。未授权时，文件和文本剪贴板仍可使用。Windows 普通权限进程不能控制管理员权限窗口、UAC 或安全桌面。第一版按常用 Windows VK 键码映射；不同键盘布局、IME、拖动与多屏、休眠唤醒需实机回归。本机编译检查通过不等于 Mac / Windows 跨机手感验证通过。

## 网络排障

- 默认 TCP 与 UDP 端口为 **53317**，允许应用在专用局域网接收连接。Windows 将当前家庭网络设为“专用”。
- 路由器访客网络 / AP 隔离、VPN 的禁止局域网选项可能阻止设备互通。
- 本机与 LocalSend 同时运行可能占用相同 TCP 端口。可先退出另一应用，或为 LocalShare 选择其他端口；UDP 发现仍使用标准 53317。

macOS / Linux 临时更换端口：

```sh
LOCALSHARE_PORT=53318 bun run start
```

Windows PowerShell：

```powershell
$env:LOCALSHARE_PORT = '53318'
bun run start
```

`LOCALSHARE_DATA_DIR` 可指定独立配置目录，`LOCALSHARE_RECEIVE_DIR` 覆盖接收位置，`LOCALSHARE_ALIAS` 覆盖本机名称。仅测试使用 `LOCALSHARE_NO_DISCOVERY=1` 和 `LOCALSHARE_PORT=0`（随机可用端口）。

默认接收到“下载 / LocalShare / 会话ID”目录；目录结构保留。同名文件增加后缀，不静默覆盖。空目录与符号链接会被跳过；跨 Windows 不可用的名称会明确拒绝。

## 构建安装包

在对应平台：

```sh
bun run dist:mac
# 或在 Windows C++ 工具链命令行：
bun run dist:win
```

输出位于 `release/`。macOS 输出应用 ZIP，Windows 输出安装版与便携 EXE。原生 helper 是独立可执行文件，随安装包携带。

本次已在 Mac 上产出 macOS arm64 ZIP、Windows x64 安装 EXE 和便携 EXE。Windows 输入模块使用官方 Zig 交叉编译（SHA-256 校验下载）；这验证了编译和打包，还没有验证 Windows 实际运行。Mac 上需要复现交叉构建时，先运行 `bun run native:win:cross`，再运行 `bunx electron-builder --win --x64 -c.win.signExecutable=false`；正常 Windows 原生构建仍推荐上面的 `dist:win`。

GitHub Actions 包含 macOS arm64 / x64、Windows x64 原生构建任务，可手动触发或推送版本标签后构建。当前 Mac 预览版使用 ad-hoc 签名，尚未获得 Developer ID 发行签名与 Apple 公证；正式分发前应配置开发者证书。预览版安装包在本仓库的 [Releases](https://github.com/okbug/localshare/releases) 中提供。

首次打开新包时，如果系统提示无法验证开发者，可在确认下载来源为本仓库后，按照 [Apple 官方说明](https://support.apple.com/zh-cn/102445)，在“系统设置 → 隐私与安全性”中为 LocalShare 选择“仍要打开”。签名完整性校验与 Apple 公证是两个独立检查；本地 ad-hoc 签名不会消除未公证应用的首次信任提示。

## 验证

```sh
bun test
bun run typecheck
bun run build
bun run smoke
bun run verify:mac
# 校验实际 ZIP 的解压结果：
bun run verify:mac release/LocalShare-0.1.1-arm64-mac.zip
```

Bun 管理工具链；集成测试由 Bun 构建后在 Node 运行，使用与 Electron 一致的 TLS 行为。桌面检查也在 Node 中启动真正的 Electron，避免 Bun 与调试协议实现的差异。测试仅使用临时目录、回环地址和测试内容，不向真实网络设备发送文件。

已验证和待验证项目见 [验证记录](docs/verification.md)。方案见 [设计文档](docs/superpowers/specs/2026-11-04-localshare-design.md) 与 [执行计划](docs/superpowers/plans/2026-11-04-localshare.md)。

## 结构与协议

```text
src/core/        证书、发现、HTTPS、文件会话、配对、控制会话
src/main/        Electron 窗口、安全 IPC、托盘、剪贴板、原生模块桥
src/preload/     固定 IPC 白名单
src/renderer/    React 中文界面
native/          macOS Objective-C / Windows C++ 输入模块
tests/          真实 HTTPS 和状态机集成测试
scripts/        开发、构建、原生编译、双实例桌面检查
```

LocalSend 上传接口：`/api/localsend/v2/{info,register,prepare-upload,upload,cancel}`。LocalShare 扩展接口：`/api/localshare/v1/`，配对后使用客户端证书指纹与随机 Bearer 凭据双重鉴权。键鼠事件通过鉴权 HTTPS 长轮询传递，不落日志或历史；后续根据双机延迟数据评估改用长连接。

配对密钥和 TLS 私钥保存在系统用户配置目录，文件权限限制为当前用户；renderer 不接触它们。第一次发现属于首次信任，需在两端核对指纹，避免对未知同网设备授予共享权限。

Apache-2.0。参考项目及依赖出处见 [NOTICE](NOTICE)。
