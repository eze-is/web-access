#!/usr/bin/env node
// web-access PreToolUse Hook
// 自动放行 CDP Proxy 操作和联网工具调用，解决子 Agent 权限不继承的平台限制
// Auto-approve CDP proxy operations and networking tools for sub-agents
// Addresses: anthropics/claude-code#18950, #37730, #25526

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name;
    const toolInput = data.tool_input || {};
    let allow = false;

    if (tool === 'Bash') {
      const cmd = toolInput.command || '';
      // CDP Proxy curl 命令（仅 localhost）
      // CDP proxy curl commands (localhost only)
      if (/^curl\s+.*https?:\/\/(localhost|127\.0\.0\.1):\d+\//.test(cmd)) allow = true;
      // skill 脚本（check-deps, cdp-proxy, match-site）
      // skill scripts
      if (/^node\s+.*\b(check-deps|cdp-proxy|match-site)\b/.test(cmd)) allow = true;
    } else if (tool === 'WebSearch') {
      allow = true;
    } else if (tool === 'WebFetch') {
      const url = toolInput.url || '';
      // Jina Markdown 转换服务
      if (/^https?:\/\/r\.jina\.ai\//.test(url)) allow = true;
    }

    if (allow) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'web-access: auto-approved CDP/networking operation',
        },
      }));
    }
    // 无输出 = 走默认权限流程（ask user）
    // no output = fall through to default permission flow
  } catch {
    // hook 异常不应阻塞操作
    // hook errors must not block operations
  }
  process.exit(0);
});
