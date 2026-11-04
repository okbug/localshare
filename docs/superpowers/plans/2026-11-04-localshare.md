# LocalShare Implementation Plan

> 按用户授权在当前聊天内顺序执行，复用空工作目录，不另建工作树，不等待阶段审批。

**Goal:** 可运行的 Mac / Windows 局域网传输桌面应用，随后加入可信剪贴板和跨屏键鼠。

**Architecture:** Electron 主进程管理网络、系统能力和持久化；React 仅通过窄 IPC 接口访问。核心服务独立于 Electron，可用 Bun 启动两个实例进行真实 HTTPS 集成测试。

**Tech Stack:** Electron、Bun、TypeScript、React、Vite、electron-builder、macOS Objective-C / Windows C++ helper。

## Task 1：脚手架与协议约束
- [x] 建立 package.json、严格 tsconfig、Vite、Electron 构建、bun.lock 和跨平台脚本。
- [x] tests/transfer.case.ts 先定义两个服务实例的互发现、确认/拒绝、二进制及文本上传，运行看到缺失实现失败。
- [x] src/shared/types.ts 定义 DeviceInfo、FileMeta、Transfer、AppSnapshot 和 IPC 合约。

## Task 2：基础网络与接收文件
- [x] src/core/identity.ts 持久化 RSA 证书及 DER 指纹。
- [x] src/core/transport.ts 在 TLS 握手后校验指纹，附带本机证书、超时和 abort。
- [x] src/core/files.ts 递归选择、校验跨平台相对路径、原子发布、同名不覆盖。
- [x] src/core/service.ts + discovery.ts 实现默认组播发现、手动 register、v2 上传会话、连接与并发上限、进度和取消。测试使用 port:0、discovery:false 避免真实设备干扰。
- [x] tests/security.case.ts 覆盖非法路径、符号链接、不匹配证书、IP/令牌绑定、hash/长度错误、上传中断和重复 token。

## Task 3：桌面交互
- [x] src/main/index.ts 管理窗口、tray、设置、文件选择授权、历史、安全 IPC 和应用退出。
- [x] src/preload/index.ts 只暴露合约中的方法。
- [x] src/renderer/App.tsx 和 styles.css 实现发送、接收、历史、设置与状态，配对/控制单独页面。
- [x] bun run typecheck / bun run build，启动真实 Electron 验证 IPC 和渲染。

## Task 4：配对和剪贴板
- [x] tests/extensions.case.ts 先验证未知设备拒绝、双方确认、鉴权、撤销、去重。
- [x] src/core/extensions.ts 实现配对凭据、持久化信任、显式开关和剪贴板事件接口。
- [x] src/main/clipboard.ts 轮询文本变化、限制体积与防回环；renderer 允许启停和取消信任。

## Task 5：跨屏键鼠
- [x] src/core/control.ts 实现独占会话、事件队列、序号、心跳、超时恢复，先写状态机测试。
- [x] native/macos.m / native/windows.cpp 负责输入捕获、注入和紧急退出；scripts/native.ts 构建对应 helper。
- [x] src/main/native.ts 只把已鉴权、已启用会话接入 helper；renderer 提供左右位置和权限/当前控制状态。
- [x] 编译本机 helper，模拟两实例会话；把 Windows CI 编译和真实双机测试边界明确记录。

## Task 6：交付
- [x] 完整运行 bun test、typecheck、build、本机打包、Electron 冒烟；遇到故障先定位根因再改动。
- [x] .github/workflows/build.yml 为 Mac arm64/x64 和 Windows x64 构建、测试、打包。
- [x] README.md 写明安装、运行、双机操作、防火墙、权限和真实验证结果；NOTICE 保留参考项目出处。
- [x] 完成状态回填本计划，提交本地 git；不推送或发布外部仓库。

## 实际交付说明

- 按顺序完成了基础传输、可信文本剪贴板、实验性跨屏键鼠模块；没有向用户插入审批问答。
- 为避开本机 Swift SDK 不匹配，Mac 输入模块采用 Objective-C；使用相同 CoreGraphics 系统接口。
- Bun 负责工具链，网络集成测试与桌面自动检查使用 Node 执行，保持与 Electron 的运行时一致。
- Windows C++ helper 通过官方 Zig 交叉编译，并生成安装版、便携版；Windows 原生 CI 配置已提供，尚未在远端运行。
- 待实机验证的项目完整列于 docs/verification.md；不将同机双实例测试描述成 Mac/Windows 实机通过。
