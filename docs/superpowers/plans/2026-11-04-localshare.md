# LocalShare Implementation Plan

> 按用户授权在当前聊天内顺序执行，复用空工作目录，不另建工作树，不等待阶段审批。

**Goal:** 可运行的 Mac / Windows 局域网传输桌面应用，随后加入可信剪贴板和跨屏键鼠。

**Architecture:** Electron 主进程管理网络、系统能力和持久化；React 仅通过窄 IPC 接口访问。核心服务独立于 Electron，可用 Bun 启动两个实例进行真实 HTTPS 集成测试。

**Tech Stack:** Electron、Bun、TypeScript、React、Vite、electron-builder、macOS Swift / Windows C++ helper。

## Task 1：脚手架与协议约束
- [ ] 建立 package.json、严格 tsconfig、Vite、Electron 构建、bun.lock 和跨平台脚本。
- [ ] tests/transfer.test.ts 先定义两个服务实例的互发现、确认/拒绝、二进制及文本上传，运行看到缺失实现失败。
- [ ] src/shared/types.ts 定义 DeviceInfo、FileMeta、Transfer、AppSnapshot 和 IPC 合约。

## Task 2：基础网络与接收文件
- [ ] src/core/identity.ts 持久化 RSA 证书及 DER 指纹。
- [ ] src/core/transport.ts 在 TLS 握手后校验指纹，附带本机证书、超时和 abort。
- [ ] src/core/files.ts 递归选择、校验跨平台相对路径、原子发布、同名不覆盖。
- [ ] src/core/service.ts + discovery.ts 实现默认组播发现、手动 register、v2 上传会话、限流、进度和取消。测试使用 port:0、discovery:false 避免真实设备干扰。
- [ ] tests/security.test.ts 覆盖非法路径、符号链接、不匹配证书、IP/令牌绑定、hash/长度错误、上传中断和重复 token。

## Task 3：桌面交互
- [ ] src/main/index.ts 管理窗口、tray、设置、文件选择授权、历史、安全 IPC 和应用退出。
- [ ] src/preload/index.ts 只暴露合约中的方法。
- [ ] src/renderer/App.tsx 和 styles.css 实现发送、接收、历史、设置与状态，配对/控制单独页面。
- [ ] bun run typecheck / bun run build，启动真实 Electron 验证 IPC 和渲染。

## Task 4：配对和剪贴板
- [ ] tests/extensions.test.ts 先验证未知设备拒绝、双方确认、鉴权、撤销、去重。
- [ ] src/core/extensions.ts 实现配对凭据、持久化信任、显式开关和剪贴板事件接口。
- [ ] src/main/clipboard.ts 轮询文本变化、限制体积与防回环；renderer 允许启停和取消信任。

## Task 5：跨屏键鼠
- [ ] src/core/control.ts 实现独占会话、事件队列、序号、心跳、超时恢复，先写状态机测试。
- [ ] native/macos.swift / native/windows.cpp 负责输入捕获、注入和紧急退出；scripts/native.ts 构建对应 helper。
- [ ] src/main/control.ts 只把已鉴权、已启用会话接入 helper；renderer 提供左右位置和权限/当前控制状态。
- [ ] 编译本机 helper，模拟两实例会话；把 Windows CI 编译和真实双机测试边界明确记录。

## Task 6：交付
- [ ] 完整运行 bun test、typecheck、build、本机打包、Electron 冒烟；遇到故障先定位根因再改动。
- [ ] .github/workflows/build.yml 为 Mac arm64/x64 和 Windows x64 构建、测试、打包。
- [ ] README.md 写明安装、运行、双机操作、防火墙、权限和真实验证结果；NOTICE 保留参考项目出处。
- [ ] 完成状态回填本计划，提交本地 git；不推送或发布外部仓库。
