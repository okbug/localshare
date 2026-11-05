export function ControlSetupGuide() {
  return (
    <section
      className="panel control-setup"
      aria-labelledby="control-setup-title"
    >
      <h2 id="control-setup-title">键鼠共享开启步骤</h2>
      <p>以下操作需要在 Mac 和 Windows 两边分别完成。</p>
      <ol>
        <li>
          <strong>先配对：</strong>在「设备协同」中配对，两端确认相同的校验码。
        </li>
        <li>
          <strong>打开总开关：</strong>两端都开启下方的「跨屏键盘与鼠标」。
        </li>
        <li>
          <strong>允许对方设备：</strong>
          在下方「已配对设备」里，找到对方的设备卡片，两端都打开「共享键鼠」。
        </li>
        <li>
          <strong>设置左右位置：</strong>Mac 在左、Windows 在右时，Mac 中选
          Windows 在「右侧」，Windows 中选 Mac 在「左侧」。Mac
          从主屏边缘跨出；Windows 多屏按系统排列移动，从面向 Mac
          的最外侧边缘返回。
        </li>
      </ol>
      <p>
        <strong>Mac 提示权限不足时：</strong>
        点击「检查权限」，按系统提示在「隐私与安全性 → 辅助功能」中允许
        LocalShare /
        localshare-input；如提示无法完整监听键盘，再检查「输入监控」，完全退出并重新打开应用后启用总开关。
      </p>
      <p className="setup-reminder">
        每次重启应用后，总开关需要重新开启。紧急恢复本机：Windows 按 Ctrl + Alt
        + Esc；Mac 按 Control + Option + Esc。
      </p>
    </section>
  );
}
