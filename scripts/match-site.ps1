# 根据用户输入匹配站点经验文件
# 用法：.\match-site.ps1 "用户输入文本"

# 1. 设置目录路径（相对于脚本所在目录的 ../references/site-patterns）
$PSScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetDir = Join-Path $PSScriptDir "..\references\site-patterns"

# 2. 环境检查
if (-not (Test-Path $TargetDir)) { exit 0 }
if ([string]::IsNullOrWhiteSpace($args[0])) { exit 0 }

$UserInput = $args[0]

# 3. 遍历目录下的所有 .md 文件
$Files = Get-ChildItem -Path $TargetDir -Filter "*.md"

foreach ($f in $Files) {
    $FilePath = $f.FullName
    $Domain = $f.BaseName  # 获取文件名（不含扩展名）

    # 读取文件内容
    $Content = Get-Content -Path $FilePath -Raw

    # 4. 提取 aliases 及其对应的模式
    # 使用正则匹配 aliases: [alias1, alias2]
    $Aliases = ""
    if ($Content -match '(?m)^aliases:\s*\[?(.*?)\]?\s*$') {
        $RawAliases = $Matches[1]
        # 将逗号分隔符转为正则的竖线 |
        $Aliases = $RawAliases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    }

    # 构建匹配阵列：文件名 + 所有别名
    $PatternList = @($Domain)
    if ($Aliases) { $PatternList += $Aliases }

    # 构建正则表达式：(domain|alias1|alias2)
    $EscapedPatterns = $PatternList | ForEach-Object { [regex]::Escape($_) }
    $FinalRegex = "(" + ($EscapedPatterns -join "|") + ")"

    # 5. 匹配用户输入（不区分大小写）
    if ($UserInput -match $FinalRegex) {
        Write-Host "--- 站点经验: $Domain ---" -ForegroundColor Cyan

        # 6. 提取正文（跳过 Frontmatter）
        # 逻辑：匹配两个 --- 之间的内容并移除，只保留剩下的
        $Body = $Content -replace '(?s)^---.*?---\s*', ''
        Write-Output $Body
        Write-Output ""
    }
}