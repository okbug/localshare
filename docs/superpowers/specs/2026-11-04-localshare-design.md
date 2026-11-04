# LocalShare 设计方案

日期：2026-11-04。按用户要求，先写方案、再连续实现；期间以进度消息同步，不设置方案审批停顿。

## 目标和选择

为一台 Mac 和一台 Windows 提供离线局域网文件传输、可信设备文本剪贴板、跨屏键鼠共享。产品暂名 LocalShare，中文界面。参考 LocalSend 的协议和实现，不复制商标及视觉素材。

比较方案：直接改 Flutter 版不能满足 Electron 技术栈；独创传输协议会失去 LocalSend 互通能力；选择 Electron + TypeScript + React + Bun，独立实现 LocalSend v2 上传协议，扩展功能走单独的鉴权接口。Bun 用于安装、构建、开发脚本和测试，Electron 使用自带 Node 运行时，避免给用户额外安装 Bun。

## 第一阶段：基础传输

- UDP 224.0.0.167:53317 组播发现，HTTPS register 双向确认；每个本地 IPv4 网卡加入组播，支持手动 IP 和端口补救。不扫描外网。
- 默认监听 TCP 53317，端口被占用时给出明确提示，可通过环境变量另选端口；不同端口仍在默认 UDP 发现组广播。
- 每个安装持久化 RSA 自签证书，指纹为 DER SHA-256；传输前在 TLS secureConnect 阶段验证目标指纹，再发送请求字节。TLS 客户端附带本机证书以兼容官方端点。
- v2/info、register、prepare-upload、upload、cancel。传输默认需要接收方逐次确认，支持拒绝、过期和取消；会话令牌绑定发送 IP。明确不声称支持所有 LocalSend 功能（网页下载、收藏、自动接收、PIN 不属于本阶段）。
- 文件/目录通过系统选择器及拖拽选择，递归目录保留相对路径、不跟随符号链接；文本作为 text/plain 文件发送。大文件逐块流式读写，校验声明长度与可选 SHA-256。
- 接收写入会话私有临时文件，再通过排他创建最终名称发布，不覆盖同名文件；拒绝绝对路径、父目录穿越、Windows 保留路径及 symlink 逃逸。每个会话使用独立接收目录。失败和取消清理临时文件，保留已完成文件。
- UI：左侧导航，发送页的投递区与附近设备，接收页的待确认请求，历史记录、设备与网络设置。真实数据驱动，空设备列表给出排障提示。
- tray 常驻，关闭窗口隐藏，可从菜单退出；历史保存元信息，不保存已发送正文。Electron renderer sandbox + contextIsolation，严格 IPC 白名单，UI 不持有文件系统权限。

## 第二阶段：文本剪贴板

LocalShare 扩展接口单独使用 /api/localshare/v1。双方界面确认配对后交换随机凭据，并把信任绑定到 TLS 证书指纹；用户可核对完整指纹，取消信任立即失效。没有接受配对的设备不能读取或写入剪贴板。每个设备提供独立文本同步开关，默认关闭。限制 UTF-8 文本为 1 MiB，空内容不发送，hash 去重，收到内容记入当前 hash 防止回环。不转发收到内容。剪贴板仅内存流转，不写历史日志。

## 第三阶段：跨屏键鼠

配置可信设备在本机左侧或右侧。控制方通过原生 helper 监听边缘、捕获和抑制本地输入；对方将事件注入操作系统。以主屏幕为第一版边界，纵向位置按比例映射；只支持单个活动控制会话，禁止环状控制。两台设备都显式打开键鼠开关后才能启用。

macOS helper 使用 CGEventTap + CGEventPost；Windows helper 使用低级输入钩子 + SendInput。helper 仅从本地主进程 stdin 接收指令，通过 stdout NDJSON 返回事件，网络不直接接触 helper。协议携带事件序号，HTTPS 长轮询批量传递；后续可以根据真实延迟评估切换 WebSocket。心跳 500ms，2 秒失联退出远控并释放修饰键。Ctrl+Alt+Escape 在双方均紧急恢复本机控制。点击、滚轮、常用键按统一 Windows VK 编码映射；国际布局、IME、UAC、安全桌面和多显示器需双机专项验证。

## 验收和边界

自动化测试先覆盖跨实例真实 HTTPS 传输、接收确认/拒绝、目录、安全路径、令牌和指纹拒绝、取消与校验失败，以及配对/撤销/剪贴板去重、键鼠会话超时。检查 TypeScript、renderer 构建和本机打包；启动 Electron 做界面/IPC 冒烟验证。Windows 安装包及 helper 在 Windows CI 原生构建；没有真实 Windows 会话时不能报告双机实测通过。

源码依据（2026-11-04 查阅）：
- https://github.com/localsend/localsend （Apache-2.0）
- https://github.com/localsend/protocol/blob/main/README.md （v2.2）
- packages/localsend_isolates/lib/src/task/discovery/discovery.dart
- packages/localsend_isolates/lib/src/task/server/http_server.dart
- packages/localsend_isolates/lib/src/task/upload/http_upload.dart
- packages/core/src/http/client/server_cert_verifier.rs
- https://www.electronjs.org/docs/latest/tutorial/security
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

## 扩展方案的风险与取舍

加密和设备发现不等于已验证对方身份，第一次配对仍需在两端比对指纹。基础传输维持逐次确认，持续剪贴板/输入仅向配对且启用的设备开放。跨屏控制的原生模块独立编译，传输和剪贴板在无权限时仍能工作。Mac 本地可完成构建和自动验证，Windows 和双机手感验证单独列出结果，避免把模拟测试当作实机成功。
