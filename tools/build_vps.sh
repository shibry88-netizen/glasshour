#!/bin/bash
# GlassHour · 在 Linux 构建机上打 Windows 包（Windows 目标交叉构建）
# 用法： bash tools/build_vps.sh [版本号]
#   bash tools/build_vps.sh            # 用 package.json 里的版本
#   bash tools/build_vps.sh 1.0.1      # 先改版本再打包
set -euo pipefail

cd "$(dirname "$0")/.."
echo "== 工作目录: $(pwd) =="

VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  echo "== 设置版本: $VERSION =="
  npm version "$VERSION" --no-git-tag-version --allow-same-version
fi

# 国内机器走镜像，明显更快；要直连就 export 覆盖掉
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "== 安装依赖 =="
npm install --no-audit --no-fund

echo "== 打包 (win x64: nsis + portable) =="
npx electron-builder --win --x64 --publish never

echo "== 产物 =="
ls -la dist/ || true
