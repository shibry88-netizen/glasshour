#!/bin/bash
# GlassHour · 在 Linux 构建机上打 Windows 包（Windows 目标交叉构建）
# 用法： bash tools/build_vps.sh [版本号]
#   bash tools/build_vps.sh            # 用 package.json 里的版本
#   bash tools/build_vps.sh 1.0.1      # 先改版本再打包
#
# 产出（dist/）：
#   GlassHour-Setup-<v>.exe        安装向导（NSIS）
#   GlassHour-Portable-<v>.exe     免安装绿色版（自解压单文件）
#   GlassHour-Portable-<v>.zip     免安装绿色版（解压即用）
set -euo pipefail

cd "$(dirname "$0")/.."
echo "== 工作目录: $(pwd) =="

VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  echo "== 设置版本: $VERSION =="
  npm version "$VERSION" --no-git-tag-version --allow-same-version
fi
VER="$(node -p "require('./package.json').version")"

# 国内机器走镜像，明显更快；要直连就 export 覆盖掉
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

# ---- 代码签名（可选）----
# electron-builder 原生认这两个环境变量，不需要改配置：
#   CSC_LINK          .pfx/.p12 文件路径，或它的 base64 字符串
#   CSC_KEY_PASSWORD  证书密码
# 详见 docs/代码签名.md
if [ -n "${CSC_LINK:-}" ]; then
  echo "== 检测到 CSC_LINK，产物将用证书签名 =="
else
  echo "== 未提供 CSC_LINK，产物为未签名（用户首次运行会被 SmartScreen 拦，点『仍要运行』）=="
fi

echo "== 生成图标资产（托盘 16/32、app 512、多尺寸 ico） =="
# 这些文件必须存在于 assets/ 与 build/：曾经因为 assets/tray.png 没进仓库，
# 运行时托盘图标是空图，用户在通知区域找不到恢复入口。
python3 scripts/make_small_icons.py || true
python3 scripts/make_tray.py
python3 scripts/make_icons.py || echo "（make_icons.py 跳过：需要 design/icon-1024.png）"
for f in assets/tray.png assets/tray@2x.png assets/icon.png build/icon.ico; do
  [ -s "$f" ] || { echo "缺少图标资产: $f" >&2; exit 1; }
done

echo "== 安装依赖 =="
npm install --no-audit --no-fund

echo "== 打包 (win x64: nsis + portable) =="
npx electron-builder --win --x64 --publish never

echo "== 追加免安装 ZIP（解压即用） =="
if [ -d dist/win-unpacked ]; then
  rm -f "dist/GlassHour-Portable-${VER}.zip"
  ( cd dist && zip -qr "GlassHour-Portable-${VER}.zip" win-unpacked )
fi

echo "== 产物 =="
ls -la dist/ | grep -Ei '\.(exe|zip)$' || ls -la dist/
