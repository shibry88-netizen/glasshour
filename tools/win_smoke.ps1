# GlassHour · Windows 真机冒烟测试
#
# 在真 Windows 上验证沙盒里验不了的那几件事：
#   1. 桌面层到底落到哪一级（壁纸层 / 桌面窗口 / 兼容层）——读 glasshour.log
#   2. 钉完自检「鼠标点不点得到」的真机结论（点击图钉能不能改状态就是活体证据）
#   3. 固定→拖不动 / 解锁→能拖 / 再固定→锁在新位置
#   4. 托盘图标是否真的有图（不再是空图）
#   5. 开机自启读写往返（需要 -TestAutostart，会改注册表 Run 项）
#
# 用法（在 Windows 上以管理员身份跑 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File win_smoke.ps1
#   powershell -ExecutionPolicy Bypass -File win_smoke.ps1 -Exe "C:\path\GlassHour-Portable-1.3.1.exe"
#   powershell -ExecutionPolicy Bypass -File win_smoke.ps1 -TestAutostart
#
# 产出：桌面 \gh-smoke\ 下的分步截图 + smoke-report.txt

param(
  [string]$Exe = "",
  [string]$OutDir = "",
  [string]$ReleaseUrl = "https://github.com/shibry88-netizen/glasshour/releases/download/v1.3.1/GlassHour-Portable-1.3.1.exe",
  [switch]$TestAutostart,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Continue"
if (!$OutDir) { $OutDir = Join-Path ([Environment]::GetFolderPath("Desktop")) "gh-smoke" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Report = Join-Path $OutDir "smoke-report.txt"
$Json = Join-Path $OutDir "smoke-result.json"
$Findings = New-Object System.Collections.ArrayList
$AppData = Join-Path $env:APPDATA "GlassHour"
$CfgPath = Join-Path $AppData "config.json"
$LogPath = Join-Path $AppData "glasshour.log"

function Say($msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss')  $msg"
  Write-Host $line
  Add-Content -Path $Report -Value $line -Encoding UTF8
  $global:LastLine = $msg
}
function Note($k, $v) { [void]$Findings.Add(@{ key = $k; value = $v }) }

Add-Type -Namespace GhSmoke -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern System.IntPtr GetParent(System.IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool EnumWindows(System.IntPtr cb, System.IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Add-TypeDrawing {
  Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
}
Add-TypeDrawing

function Shot($name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $p = Join-Path $OutDir "$name.png"
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say "  截图 -> $name.png"
  } catch { Say "  截图失败：$($_.Exception.Message)" }
}
try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue } catch {}

# ---------- 工具 ----------
function Get-Cfg {
  if (!(Test-Path $CfgPath)) { return $null }
  try { return (Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Get-WidgetRect {
  $h = [GhSmoke.U]::FindWindow($null, "GlassHour")
  if ($h -eq [IntPtr]::Zero) { return $null }
  $r = New-Object GhSmoke.U+RECT
  if (![GhSmoke.U]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ H = $h; L = $r.Left; T = $r.Top; R = $r.Right; B = $r.Bottom; W = ($r.Right - $r.Left); Hh = ($r.Bottom - $r.Top) }
}
function Click-At($x, $y, $note) {
  [GhSmoke.U]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [GhSmoke.U]::SetCursorPos($x + 1, $y) | Out-Null   # 触发一次 mousemove，有些程序需要
  Start-Sleep -Milliseconds 80
  [GhSmoke.U]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [GhSmoke.U]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Say "  点击 ($x,$y) $note"
}
function Drag-From($x, $y, $dx, $dy, $note) {
  [GhSmoke.U]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [GhSmoke.U]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  $steps = 12
  for ($i = 1; $i -le $steps; $i++) {
    [GhSmoke.U]::SetCursorPos([int]($x + $dx * $i / $steps), [int]($y + $dy * $i / $steps)) | Out-Null
    Start-Sleep -Milliseconds 45
  }
  [GhSmoke.U]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 400
  Say "  拖动 从 ($x,$y) 位移 ($dx,$dy) $note"
}

# ---------- 落位点（按组件大小档位的 token 表；窗口内 CSS 坐标 → 用窗口物理宽度按比例换算，兼容 DPI）----------
function Pin-Point($rect, $scale) {
  switch ([string]$scale) {
    "0.5"  { $px = 144; $py = 8;  $s = 24 }
    "0.65" { $px = 187; $py = 10; $s = 31 }
    "0.8"  { $px = 262; $py = 22; $s = 22 }
    default { $px = 328; $py = 28; $s = 28 }
  }
  $cardW = [Math]::Round(420 * [double]$scale)
  $winW = $cardW + 40
  $fx = (20 + $px + $s / 2) / $winW
  $fy = (20 + $py + $s / 2) / $winW       # 窗口是正方形留白，X/Y 用同一比例
  return @{ X = [int]($rect.L + $fx * $rect.W); Y = [int]($rect.T + $fy * $rect.W) }
}

# ============================ 开始 ============================
Say "=== GlassHour 真机冒烟测试 ==="
Say "系统：$((Get-CimInstance Win32_OperatingSystem).Caption) / $([Environment]::OSVersion.Version)"
Say "用户：$env:USERNAME  输出目录：$OutDir"

# 1) 准备可执行文件
if (!$Exe) {
  $Exe = Join-Path $env:TEMP "GlassHour-Portable-1.3.1.exe"
  if (!(Test-Path $Exe)) {
    Say "下载安装包：$ReleaseUrl"
    try {
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $ReleaseUrl -OutFile $Exe -UseBasicParsing
    } catch { Say "下载失败：$($_.Exception.Message)"; exit 1 }
  }
}
Say "可执行文件：$Exe （$([Math]::Round((Get-Item $Exe).Length / 1MB, 1)) MB）"

# 2) 清一份干净配置（保留用户原有配置的备份）
Get-Process GlassHour -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path $AppData) {
  $bak = "$AppData.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $AppData $bak -Recurse -Force -ErrorAction SilentlyContinue
  Say "原配置已备份到 $bak"
  Remove-Item (Join-Path $AppData "glasshour.log") -Force -ErrorAction SilentlyContinue
}
Remove-Item $Report -Force -ErrorAction SilentlyContinue

# 3) 启动
Say "启动组件…"
Start-Process -FilePath $Exe | Out-Null
$waited = 0
while ($waited -lt 40 -and !(Get-Process GlassHour -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1; $waited++ }
Start-Sleep -Seconds 8
$proc = Get-Process GlassHour -ErrorAction SilentlyContinue
if (!$proc) { Say "❌ 组件没起来（40 秒内没有 GlassHour 进程）"; Shot "00-没起来"; exit 1 }
Say "✅ 进程已起，PID=$($proc.Id -join ',')，内存 $([Math]::Round(($proc | Measure-Object WorkingSet64 -Sum).Sum / 1MB)) MB"
Shot "01-启动后"

# 4) 桌面层结论（日志）
Start-Sleep -Seconds 3
Say "--- glasshour.log（桌面层/自检/自启关键行）---"
if (Test-Path $LogPath) {
  $key = Get-Content $LogPath -Encoding UTF8 | Where-Object { $_ -match "layer|probe|autostart|watchdog|drag|locked|scale" }
  $key | ForEach-Object { Say "   $_" }
} else { Say "  （还没有日志文件）" }

$rect = Get-WidgetRect
if ($rect) {
  Say "组件窗口矩形：($($rect.L),$($rect.T)) - ($($rect.R),$($rect.B))  尺寸 $($rect.W)x$($rect.Hh)"
  $par = [GhSmoke.U]::GetParent($rect.H)
  Say "窗口父句柄：0x$('{0:X}' -f [int64]$par)（0 = 顶层窗口；非 0 = 已挂到桌面层）"
  $pt = New-Object GhSmoke.U+POINT
  $pt.X = [int](($rect.L + $rect.R) / 2); $pt.Y = [int](($rect.T + $rect.B) / 2)
  $hit = [GhSmoke.U]::WindowFromPoint($pt)
  $ours = ($hit -eq $rect.H)
  Say "窗口中心点命中：0x$('{0:X}' -f [int64]$hit) → $(if ($ours) { '✅ 是我们自己（鼠标点得到）' } else { '❌ 不是我们（点不到，会被上层窗口吃掉）' })"
} else { Say "❌ 找不到标题为 GlassHour 的窗口" }

$cfg0 = Get-Cfg
$scale = if ($cfg0) { [string]$cfg0.uiScale } else { "0.5" }
Say "组件大小档位：$scale"

# 5) 固定链路：固定 → 试拖（应拖不动）→ 解锁 → 试拖（应能拖）→ 再固定
if ($rect -and $cfg0) {
  $pin = Pin-Point $rect $scale
  Say "图钉按钮落点：($($pin.X),$($pin.Y))"

  # 5.1 点固定
  Click-At $pin.X $pin.Y "（图钉 → 固定）"
  Start-Sleep -Seconds 2
  $cfg1 = Get-Cfg
  Say "  locked = $($cfg1.locked)  $(if ($cfg1.locked) { '✅ 真的锁定了' } else { '❌ 没锁上（按钮可能点不到）' })"
  Shot "02-已固定"
  $rect1 = Get-WidgetRect
  $posBefore = "$($rect1.L),$($rect1.T)"

  # 5.2 固定状态下拖 → 位置不该变
  Drag-From ([int](($rect1.L + $rect1.R) / 2)) ([int](($rect1.T + $rect1.B) / 2)) -160 -120 "（固定状态下，应拖不动）"
  $rect2 = Get-WidgetRect
  $posAfter = "$($rect2.L),$($rect2.T)"
  Say "  固定态拖动：$posBefore → $posAfter  $(if ($posBefore -eq $posAfter) { '✅ 拖不动（符合预期）' } else { '❌ 被拖动了（锁定失灵）' })"

  # 5.3 点解锁
  $pin2 = Pin-Point $rect2 $scale
  Click-At $pin2.X $pin2.Y "（图钉 → 解锁）"
  Start-Sleep -Seconds 2
  $cfg2 = Get-Cfg
  Say "  locked = $($cfg2.locked)  $(if (-not $cfg2.locked) { '✅ 已解锁' } else { '❌ 没解开' })"

  # 5.4 解锁后拖 → 位置应该变
  $rect3 = Get-WidgetRect
  Drag-From ([int](($rect3.L + $rect3.R) / 2)) ([int](($rect3.T + $rect3.B) / 2)) -200 -140 "（解锁后，应该拖得动）"
  $rect4 = Get-WidgetRect
  $moved = ($rect4.L -ne $rect3.L) -or ($rect4.T -ne $rect3.T)
  Say "  解锁态拖动：($($rect3.L),$($rect3.T)) → ($($rect4.L),$($rect4.T))  $(if ($moved) { '✅ 拖得动' } else { '❌ 拖不动（解锁失灵）' })"
  Shot "03-解锁后拖过"

  # 5.5 再固定 → 锁在新位置
  $pin3 = Pin-Point $rect4 $scale
  Click-At $pin3.X $pin3.Y "（图钉 → 再固定）"
  Start-Sleep -Seconds 2
  $cfg3 = Get-Cfg
  $cfgPos = "$($cfg3.x),$($cfg3.y)"
  Say "  再固定：locked=$($cfg3.locked)，配置里的位置 $cfgPos，窗口实际 ($($rect4.L),$($rect4.T))"
  Shot "04-再固定"

  Say "--- 追加日志 ---"
  Get-Content $LogPath -Encoding UTF8 | Select-Object -Last 12 | ForEach-Object { Say "   $_" }
}

# 6) 托盘图标（通知区域是否有我们的图标）
$tray = Get-Process explorer -ErrorAction SilentlyContinue
Say "托盘：explorer 在跑 = $([bool]$tray)；托盘图标是否为空图无法从这里静默判定，看截图 01 右下角通知区域"

# 7) 开机自启（可选）
if ($TestAutostart) {
  Say "--- 开机自启读写往返 ---"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $before = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).GlassHour
  Say "  改之前 Run 项：$before"
  Say "  请在弹出的窗口里勾选「开机自启」（10 秒后自动继续）…"
  $settings = Get-Process GlassHour -ErrorAction SilentlyContinue
  # 打开设置窗口：双击卡片中心
  $rect5 = Get-WidgetRect
  if ($rect5) {
    [GhSmoke.U]::SetCursorPos([int](($rect5.L + $rect5.R) / 2), [int](($rect5.T + $rect5.B) / 2)) | Out-Null
    Start-Sleep -Milliseconds 150
    [GhSmoke.U]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [GhSmoke.U]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    [GhSmoke.U]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [GhSmoke.U]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Seconds 3
    Shot "05-设置窗口"
  }
  Start-Sleep -Seconds 10
  $after = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).GlassHour
  Say "  改之后 Run 项：$after"
  Say "  （预期形如 \"<exe路径>\" --autostart；若为空说明写入没生效）"
} else {
  Say "（跳过开机自启测试：加 -TestAutostart 会去改注册表 Run 项）"
}

if (!$KeepRunning) {
  Say "关闭组件…"
  Get-Process GlassHour -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
$Findings | ConvertTo-Json -Depth 4 | Set-Content -Path $Json -Encoding UTF8
Say "=== 结束。报告：$Report ==="
Say "=== JSON：$Json ===" 
