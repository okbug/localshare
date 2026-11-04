const { join } = require("node:path");
const { verifyMacBundle } = require("../dist/tools/mac-signature.cjs");
exports.default = function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const result = verifyMacBundle(appPath);
  console.log(
    `Verified macOS resource seal and native helper (${result.signature}).`,
  );
};
