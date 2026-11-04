# 验证记录

日期：2026-11-04。执行环境：macOS arm64，Node 22.22.3，Bun 1.3.5，Electron 45.2.2。

## 0.1.1：Mac 签名故障回归

用户反馈“已损坏，无法打开”后，对旧包复现 `codesign --verify --deep --strict` 失败：`code has no resources but signature indicates they must be present`。0.1.0 的本机运行检查没有覆盖资源签名完整性，原记录中的“可启动”不能当作互联网下载后已获系统信任。

0.1.1 已验证：
- `LOCALSHARE_TEST_MAC_APP=... bun test`：14 项 Node 集成测试全部通过，包含真实发行 app 的严格签名回归。
- `bun run verify:mac release/LocalShare-0.1.1-arm64-mac.zip`：ZIP 解压后的 app、Bundle ID 与原生 helper 校验通过。
- `codesign` 显示正确标识 `org.localshare.desktop`、`adhoc,runtime` 和完整资源封装，Hardened Runtime 保留。
- 签名后构建钩子在生成 ZIP 前强制检查，CI 也增加打包检查。
- 对最终签名产物重新运行双实例 Electron 文件接收、配对、设置检查，通过。
- `spctl --assess` **仍返回 rejected**：本机没有有效的 Developer ID 发行证书，也未进行 Apple 公证。ad-hoc 签名不提供发行者信任，不能声称 Gatekeeper 已接受。首次打开可能需要用户按照 Apple 官方步骤在“隐私与安全性”中明确允许这个应用。

0.1.1 仅发布 Mac 签名修复包，Windows 用户继续使用 0.1.0 安装包。

## 0.1.0 基础功能检查

- `bun test`：13 项 Node 集成用例，Bun 负责编译和运行；核心在与 Electron 一致的 Node 运行时测试。
- `bun run typecheck`：严格 TypeScript 检查。
- `bun run build`：Electron main/preload、Vite renderer、macOS 原生输入模块均能构建。
- `bun run smoke`：同一台 Mac 上启动两份真实 Electron、独立临时配置和回环 HTTPS；验证手动 IP 连接、发送文件、对方点击接收、磁盘内容核对、配对校验码一致、双方确认配对、剪贴板总开关与设备名称修改；无 renderer 异常。测试结束关闭进程并清理临时数据。
- macOS helper 的 `--check` 返回 `permission: true`，原生模块可独立编译。没有通过测试流程控制用户的真实键盘或鼠标。
- `bun run pack`：macOS arm64 应用目录打包通过；不包含用户私钥或测试数据。
- 同一套双实例桌面流程也已对 `release/mac-arm64/LocalShare.app` 的打包产物运行并通过，验证应用内的 preload、网络服务与系统资源路径；不是只验证开发模式。
- Windows 原生 C++ 模块通过官方 Zig 0.14.1（下载校验 SHA-256）交叉编译，产物为 x86-64 PE 可执行文件；Windows 安装版与便携版构建通过。没有在 Windows 上运行这些产物。

## 核心测试范围

1. 两端 HTTPS 互相登记，确认后按原字节接收二进制、保留目录结构。
2. 拒收与发送方取消。
3. 父目录穿越、绝对路径、UNC、Windows 驱动器和保留文件名、控制字符拒绝。
4. 不匹配 TLS 指纹在发送元信息之前失败。
5. 冒用发送方证书身份、错误令牌、重复上传拒绝。
6. SHA-256 错误失败，未发布损坏文件。
7. 同名接收不覆盖、嵌套符号链接拒绝、短文件失败并清理临时文件。
8. 5 个延迟发送请求正文的并发 prepare 请求，仅 4 个进入等待确认；修复了仅在解析正文前检查容量的竞争条件。
9. 剪贴板接口要求双端配对和显式开关；相同内容去重；本地或远端修改后重新复制旧内容仍会同步；清空后也能重新接收；撤销双方信任。
10. 任一端拒绝配对，不产生信任。
11. 控制会话显式开启、按序交付键盘和移动事件、双方退出。
12. 无效键码拒绝、对方停止发送心跳后自动恢复本机状态。
13. 设备协同接口拒绝 HTTP 降级，持续共享凭据及内容只能走绑定配对指纹的 HTTPS。

## 尚未完成的实机验证

- Windows x64 上安装、运行、防火墙提示和原生输入注入。
- 两台物理 Mac / Windows 的 UDP 发现、文件吞吐与持续文本剪贴板共享。
- 与官方 LocalSend GUI 客户端实际互传。实现依据官方 v2.2 协议和证书校验源码，协议集成测试通过不等于官方客户端实测通过。
- 键鼠跨物理屏幕回穿、长时间输入、拖拽、键盘布局 / IME、睡眠唤醒、屏幕锁定、管理员窗口的行为。
- Intel Mac helper / 安装包运行。
- 代码签名、Apple 公证及 Windows SmartScreen 信誉。

设备卡片截图由两个测试实例产生，其中“Windows PC”是测试名称，实际两个实例均运行于本机 macOS。截图不代表已连接真实 Windows。
