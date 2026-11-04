# macOS 0.1.1 打包修复方案

2026-11-04：用户反馈“LocalShare 已损坏，无法打开”。本地对 0.1.0 发行产物执行 `codesign --verify --deep --strict`，复现 `code has no resources but signature indicates they must be present`。应用保留了 Electron 主程序的链接器签名，改名和写入应用资源后没有重新封装签名；仅在开发机上启动成功不足以验证下载后的可安装性。

执行步骤：
1. 先以真实旧包增加失败的签名回归检查。
2. 显式采用 ad-hoc 签名，签入 app、嵌套程序和原生 helper，保留 Hardened Runtime，并使用 Electron 所需的最小 JIT / 库验证兼容权限。
3. 增加签名后构建钩子，验证 app 严格完整性、正确 Bundle ID 和原生 helper；对最终 ZIP 解压后再次验证。
4. 对重新打包后的应用运行双实例传输和配对检查，确保签名后的运行能力没有回归。
5. 发布 0.1.1 Mac 修复包并更新说明；保留 0.1.0 Windows 下载。

边界：本机没有有效的 Developer ID 发行证书，无法完成 Apple 公证。ad-hoc 签名修复资源签名完整性，并不等于 Gatekeeper 的发行信任。验证记录必须分别报告 codesign 校验和 Gatekeeper 评估结果，不通过清除 quarantine 或修改系统安全策略伪装成已获 Apple 信任。
