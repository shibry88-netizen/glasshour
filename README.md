<div align="center">

# GlassHour · 琉璃沙漏

**一块钉在 Windows 10 桌面上的液态玻璃倒计时组件**

鎏金 × 深黑 · 全局液态玻璃 · 不进任务栏 · 开机自启

![platform](https://img.shields.io/badge/platform-Windows%2010%20x64-0b0b0d?style=flat-square)
![electron](https://img.shields.io/badge/Electron-33-d8b678?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-8a6a2f?style=flat-square)

</div>

---

## 它是什么

GlassHour 不是那种"浮在所有窗口上面挡视线"的桌面时钟。

它把自己**钉在桌面壁纸层**——和你的壁纸活在同一层，被浏览器、编辑器、任何窗口盖住，**不进任务栏、不进 Alt+Tab**。你按 `Win+D` 回桌面时它还在；你干活时它安静地待在后面。

整块卡片是**液态玻璃**：分层模糊、镜面高光扫过、边缘高光折射、极细噪点、柔和投影。主色只有两个——**鎏金**和**深黑**。

## 特性

| | |
| :-- | :-- |
| 🪟 **钉桌面层** | `WorkerW` 子窗口方案，被其它窗口盖住、不进任务栏/Alt+Tab；失败自动回退兼容模式 |
| 🔮 **全局液态玻璃** | 卡片整体是玻璃，不是"半透明+模糊"的偷懒版：分层模糊 / 镜面高光 / 边缘折射 / 噪点 / 柔和投影 |
| ⏳ **双模式** | 目标日期倒计时（主数字 = 天）· 时长计时器（MM:SS），卡片上一键切换 |
| 🎨 **鎏金 × 黑** | 唯一强调色是鎏金；剩余不足 7 天自动进入「紧迫」态 |
| 🚀 **开机自启** | 写注册表 Run 项，开机静默出现在桌面右下角 |
| 🖱️ **可拖动 + 位置记忆** | 拖到哪就停在哪，重启后仍在原地 |
| 🧩 **托盘控制** | 托盘图标可切模式、开设置、开关自启、重置位置 |
| 🔒 **纯本地** | 零联网、零上报、零账户。配置只有一个 `%APPDATA%\GlassHour\config.json` |

## 截图

> `design/shots/` —— 打包前用 Chromium 在真实壁纸上渲染的实拍图（不是示意图）。

| 目标日期 · 默认 | 目标日期 · 紧迫（<7 天） | 时长计时器 · 计时中 |
| :--: | :--: | :--: |
| ![](design/shots/01-date-default.png) | ![](design/shots/03-date-urgent.png) | ![](design/shots/05-timer-running.png) |

## 下载

到 [Releases](../../releases) 取最新版：

- **`GlassHour-Setup-x.y.z.exe`** —— 安装向导，可勾选开机自启
- **`GlassHour-Portable-x.y.z.exe`** —— 免安装绿色版，双击即用

> Windows 10 x64。首次运行若被 SmartScreen 拦，点「更多信息 → 仍要运行」（未做代码签名）。

## 使用

**卡片上**

- 拖动卡片任意空白处 → 移动位置
- 左上角小胶囊 → 切换「日期 / 计时」两种模式
- 计时器模式：中间是 开始 / 暂停，右下角是 重置
- 右上角齿轮 → 打开设置窗口

**托盘图标**（右键）

- 显示 / 隐藏组件
- 切换模式
- 设置…
- 开机自启（勾选）
- 桌面层策略（自动 / 强制壁纸层 / 兼容模式 / 普通窗口）
- 重置窗口位置 · 关于 · 退出

### 如果它没被钉到桌面层

少数机器上 `WorkerW` 找不到（多显示器、第三方桌面美化工具、Explorer 被替换过），会自动回退成"不可激活的底层窗口"。若仍不对：

托盘右键 → **桌面层 → 兼容模式**，或在设置里把「桌面层策略」改成 **兼容模式**。

## 从源码构建

```bash
git clone https://github.com/shibry88-netizen/glasshour.git
cd glasshour
npm install
npm start          # 开发运行
npm run dist       # 打 Windows 包（Setup.exe + Portable.exe）
```

在 Linux 上交叉打 Windows 包需要 `wine`；仓库里的 `tools/build_vps.sh` 就是为 Linux 构建机准备的（含国内镜像加速）。

### 只想要 UI 截图

```bash
python3 scripts/make_wallpaper.py   # 生成模拟壁纸（液态玻璃需要背景）
node scripts/screenshot.js          # 输出到 design/shots/
```

## 目录结构

```
electron/
  main.js           主进程：窗口、托盘、开机自启、IPC
  desktop-pin.js    桌面层钉死（koffi 调 user32.dll → WorkerW）
  preload.js        contextBridge 安全桥
  store.js          JSON 配置持久化
renderer/
  index.html        组件卡片
  widget.css        液态玻璃样式（设计规范实现）
  widget.js         双模式倒计时逻辑（与视觉解耦）
  settings.html     设置窗口
design/
  设计规范.md        像素级 UI 规范（配色/玻璃分档/坐标表/反例）
  icon.svg          应用图标源文件
scripts/
  make_wallpaper.py 生成模拟壁纸
  screenshot.js     Playwright 截图
tools/
  build_vps.sh      Linux 构建机出包脚本
```

## 原理速览

**为什么能钉在壁纸层？** Windows 的桌面其实是一个叫 `WorkerW` 的窗口。给它发 `0x052C` 让 Explorer 派生出一个新的 `WorkerW`，把自己 `SetParent` 过去，就和壁纸同层了。`electron/desktop-pin.js` 用 `koffi` 直接调 `user32.dll` 完成这件事，纯 JS、无原生编译。

**为什么不会被任务栏/Alt+Tab 看到？** 窗口用 `skipTaskbar: true` + `focusable: false`，且是 `WorkerW` 的子窗口，本来就不属于顶层窗口。

## 设计

视觉规范见 [`design/设计规范.md`](design/设计规范.md)：完整色板、玻璃分档参数、逐元素坐标表、五种状态的差异、动效曲线、以及一份"不要这样做"的反例清单。

## License

[MIT](LICENSE) © 2026 Shibry
