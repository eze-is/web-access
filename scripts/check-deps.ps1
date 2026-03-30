#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

function Initialize-TerminalEncoding {
  $codePage = 0

  try {
    $codePage = [Console]::OutputEncoding.CodePage
  } catch {
    $codePage = 0
  }

  if ($codePage -le 0) {
    $codePage = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
  }

  try {
    $encoding = [System.Text.Encoding]::GetEncoding($codePage)
  } catch {
    $encoding = [System.Text.Encoding]::UTF8
  }

  [Console]::InputEncoding = $encoding
  [Console]::OutputEncoding = $encoding
  $OutputEncoding = $encoding
}

Initialize-TerminalEncoding

function Test-Port {
  param(
    [int]$Port
  )

  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(2000)) {
      $client.Close()
      return $false
    }

    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Get-ActivePortFiles {
  $userProfile = [Environment]::GetFolderPath('UserProfile')

  if ($IsMacOS) {
    return @(
      (Join-Path $userProfile 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      (Join-Path $userProfile 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      (Join-Path $userProfile 'Library/Application Support/Chromium/DevToolsActivePort')
    )
  }

  if ($IsLinux) {
    return @(
      (Join-Path $userProfile '.config/google-chrome/DevToolsActivePort'),
      (Join-Path $userProfile '.config/chromium/DevToolsActivePort')
    )
  }

  if ($env:OS -eq 'Windows_NT') {
    $localAppData = $env:LOCALAPPDATA
    return @(
      (Join-Path $localAppData 'Google/Chrome/User Data/DevToolsActivePort'),
      (Join-Path $localAppData 'Chromium/User Data/DevToolsActivePort')
    )
  }

  return @()
}

function Get-Targets {
  try {
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:3456/targets').Content
  } catch {
    return $null
  }
}

$nodeCmd = Get-Command -Name node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Output 'node: missing — 请安装 Node.js 22+'
  exit 1
}

$nodeVer = & node --version 2>$null
$nodeMajor = [int](($nodeVer.TrimStart('v')).Split('.')[0])
if ($nodeMajor -ge 22) {
  Write-Output "node: ok ($nodeVer)"
} else {
  Write-Output "node: warn ($nodeVer, 建议升级到 22+)"
}

$chromePort = $null
foreach ($filePath in Get-ActivePortFiles) {
  if (-not (Test-Path -LiteralPath $filePath)) {
    continue
  }

  try {
    $lines = Get-Content -LiteralPath $filePath -ErrorAction Stop
    if ($lines.Count -eq 0) {
      continue
    }

    $port = [int]$lines[0]
    if ($port -gt 0 -and $port -lt 65536 -and (Test-Port -Port $port)) {
      $chromePort = $port
      break
    }
  } catch {
    continue
  }
}

if (-not $chromePort) {
  foreach ($port in 9222, 9229, 9333) {
    if (Test-Port -Port $port) {
      $chromePort = $port
      break
    }
  }
}

if (-not $chromePort) {
  Write-Output 'chrome: not connected — 请打开 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging'
  exit 1
}

Write-Output "chrome: ok (port $chromePort)"

$targets = Get-Targets
if ($targets -and $targets.TrimStart().StartsWith('[')) {
  Write-Output 'proxy: ready'
  exit 0
}

Write-Output 'proxy: connecting...'
$scriptDir = $PSScriptRoot
$stdoutLog = Join-Path $env:TEMP 'cdp-proxy.out.log'
$stderrLog = Join-Path $env:TEMP 'cdp-proxy.err.log'
Start-Process -FilePath 'node' -ArgumentList @((Join-Path $scriptDir 'cdp-proxy.mjs')) -WorkingDirectory $scriptDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog | Out-Null
Start-Sleep -Seconds 2

for ($i = 1; $i -le 15; $i++) {
  $targets = Get-Targets
  if ($targets -and $targets.TrimStart().StartsWith('[')) {
    Write-Output 'proxy: ready'
    exit 0
  }

  if ($i -eq 1) {
    Write-Output '⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接...'
  }

  Start-Sleep -Seconds 1
}

Write-Output '❌ 连接超时，请检查 Chrome 调试设置'
exit 1
