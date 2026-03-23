# 环境检查 + 确保 CDP Proxy 就绪

# 1. Node.js 检查
$NodeExec = Get-Command node -ErrorAction SilentlyContinue
if ($NodeExec) {
    $NodeVer = node --version
    # 提取主版本号 (例如 v22.1.0 -> 22)
    $NodeMajor = [int]($NodeVer -replace 'v', '').Split('.')[0]

    if ($NodeMajor -ge 22) {
        Write-Host "node: ok ($NodeVer)"
    } else {
        Write-Host "node: warn ($NodeVer, 建议升级到 22+)" -ForegroundColor Yellow
    }
} else {
    Write-Host "node: missing — 请安装 Node.js 22+" -ForegroundColor Red
    exit 1
}

# 2. Chrome 调试端口 (9222) 探测
# 使用 PowerShell 原生能力探测端口，无需调用 node -e
$ChromePort = 9222
$TCPClient = New-Object System.Net.Sockets.TcpClient
$Connect = $TCPClient.BeginConnect("127.0.0.1", $ChromePort, $null, $null)
$Wait = $Connect.AsyncWaitHandle.WaitOne(2000, $false)

if (-not $Wait -or -not $TCPClient.Connected) {
    Write-Host "chrome: not connected — 请打开 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging" -ForegroundColor Red
    $TCPClient.Close()
    exit 1
}
$TCPClient.Close()
Write-Host "chrome: ok (port 9222)"

# 3. CDP Proxy 检查与启动
$ProxyUrl = "http://127.0.0.1:3456/health"
$ProxyScript = "$Home\.claude\skills\web-access\scripts\cdp-proxy.mjs"
$OutLog = "$env:TEMP\cdp-proxy-out.log"
$ErrLog = "$env:TEMP\cdp-proxy-err.log"

try {
    $Health = Invoke-RestMethod -Uri $ProxyUrl -TimeoutSec 2 -ErrorAction SilentlyContinue
} catch {
    $Health = $null
}

if ($Health -and $Health.connected -eq $true) {
    Write-Host "proxy: ready"
} else {
    if (-not $Health -or $Health.status -ne "ok") {
        Write-Host "proxy: starting..."

        # 在 Windows 下启动后台 Node 进程，不阻塞当前窗口
        Start-Process node -ArgumentList "`"$ProxyScript`"" -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden
    }

    # 等待连接就绪
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep -Seconds 1
        try {
            $Check = Invoke-RestMethod -Uri $ProxyUrl -ErrorAction SilentlyContinue
            if ($Check -and $Check.connected -eq $true) {
                Write-Host "proxy: ready"
                exit 0
            }
        } catch {}

        if ($i -eq 3) {
            Write-Host "⚠️ Chrome 可能有授权弹窗，请点击「允许」后等待连接..." -ForegroundColor Yellow
        }
    }

    Write-Host "❌ 连接超时，请检查 Chrome 调试设置" -ForegroundColor Red
    exit 1
}