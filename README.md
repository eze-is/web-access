<div align="right">
  <details>
    <summary>🌐 Language</summary>
    <div>
      <div align="center">
        <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=en">English</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=zh-CN">简体中文</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=zh-TW">繁體中文</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=ja">日本語</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=ko">한국어</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=fr">Français</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=de">Deutsch</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=es">Español</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=pt">Português</a>
        | <a href="https://openaitx.github.io/view.html?user=eze-is&project=web-access&lang=ru">Русский</a>
      </div>
    </div>
  </details>
</div>

<img width="879" height="376" alt="image" src="https://github.com/user-attachments/assets/a87fd816-a0b5-4264-b01c-9466eae90723" />

<p align="center">
  <b>给 AI Agent 装上完整联网能力的 Skill。</b><br/>
  <a href="https://web-access.eze.is">🌐 官网</a> · <a href="https://mp.weixin.qq.com/s/rps5YVB6TchT9npAaIWKCw">📖 设计详解</a> · <a href="#安装">⚡ 快速安装</a>
</p>

AI Agent 原本的联网能力（WebSearch、WebFetch）缺少调度策略和浏览器自动化能力。这个 Agent Skill 补上的是：**联网策略 + CDP 浏览器操作 + 站点经验积累**。兼容所有支持 SKILL.md 的 Agent（Claude Code、Cursor、Gemini CLI、Codex CLI 等）。

> 推荐必读：[Web Access：一个 Skill，拉满 Agent 联网和浏览器能力](https://mp.weixin.qq.com/s/rps5YVB6TchT9npAaIWKCw) ，完整介绍了 Web-Access Skill 的开发细节与 Agent Skill 设计哲学，帮助你也能写出类似通用、高上限的 Skill

---

## v2.5.0 能力

| 能力 | 说明 |
|------|------|
| 联网工具自动选择 | WebSearch / WebFetch / curl / Jina / CDP，按场景自主判断，可任意组合 |
| CDP Proxy 浏览器操作 | 直连用户日常 Chrome，天然携带登录态，支持动态页面、交互操作、视频截帧 |
| 三种点击方式 | `/click`（JS click）、`/clickAt`（CDP 真实鼠标事件）、`/setFiles`（文件上传） |
| 本地 Chrome 书签/历史检索 | `find-url.mjs` 查询公网搜不到的目标（内部系统）或用户访问过的页面，支持关键词/时间窗/访问频度排序 |
| 并行分治 | 多目标时分发子 Agent 并行执行，共享一个 Proxy，tab 级隔离 |
| 站点经验积累 | 按域名存储操作经验（URL 模式、平台特征、已知陷阱），跨 session 复用 |
| 媒体提取 | 从 DOM 直取图片/视频 URL，或对视频任意时间点截帧分析 |

**v2.5.0 更新：**
- **本地 Chrome 资源检索** — 新增 `scripts/find-url.mjs`，从本地 Chrome 书签/历史按关键词/时间窗/访问频度定位 URL。典型场景：用户提到组织内部系统（"我们的 XX 平台"等公网搜不到的目标）、回查之前访问过但不记得地址的页面、查看最近高频访问网站等（场景感谢 @MVPGFC 在 #60 提出）

<details><summary>v2.4.3 更新</summary>

- **修复 CLAUDE_SKILL_DIR 路径问题** — bash 代码块改用 `${CLAUDE_SKILL_DIR}` 字符串替换语法，修复 Windows Git Bash 路径转换错误和变量未设置问题（#47 #46）
- **站点经验列表合并到前置检查** — 启动检查通过后自动输出已有站点经验列表，移除不可靠的 `!` 内联注入
</details>

<details><summary>v2.4.1 更新</summary>

- **跨平台支持** — 脚本从 bash 迁移到 Node.js，Windows / Linux / macOS 均可使用
- **DOM 边界穿透** — 新增技术事实：eval 递归遍历可穿透 Shadow DOM、iframe 等选择器不可跨越的边界
</details>

<details><summary>v2.4 更新</summary>

- **站点内 URL 可靠性** — 新增事实说明：站点生成的链接自带完整上下文，手动构造的 URL 可能缺失隐式必要参数
- **平台错误提示不可信** — 新增技术事实：平台返回的"内容不存在"等提示可能是访问方式问题而非内容本身问题
- **小红书站点经验增强** — xsec_token 机制、创作者平台状态校验、暂存草稿流程
</details>

<details><summary>v2.3 更新</summary>

- **浏览哲学重构** — 更清晰的「像人一样思考」框架，强调目标驱动而非步骤驱动
- **Jina 积极推荐** — 明确鼓励在合适场景主动使用 Jina 节省 token
- **子 Agent prompt 指引优化** — 明确加载写法，增加避免动词暗示执行方式的说明
</details>

## 安装

**方式一：npx skills 一键安装（推荐）**

```bash
npx skills add eze-is/web-access
```

> [skills CLI](https://github.com/vercel-labs/skills) 是开源的 Agent Skill 包管理器，自动检测你的 Agent 环境并安装到正确位置。

**方式二：让 Agent 自动安装**

```
帮我安装这个 skill：https://github.com/eze-is/web-access
```

**方式三：Plugin 安装（Claude Code）**

```bash
claude plugin marketplace add https://github.com/eze-is/web-access
claude plugin install web-access@web-access --scope user
```

**方式四：手动**

```bash
git clone https://github.com/eze-is/web-access ~/.claude/skills/web-access
```

## 前置配置（CDP 模式）

CDP 模式需要 **Node.js 22+** 和 Chrome 开启远程调试：

1. Chrome 地址栏打开 `chrome://inspect/#remote-debugging`
2. 勾选 **Allow remote debugging for this browser instance**（可能需要重启浏览器）

环境检查（Agent 运行时会自动完成前置检查，无需手动执行）：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
# $CLAUDE_SKILL_DIR 是 skill 加载时自动设置的环境变量
# 手动运行请替换为实际路径，如 ~/.claude/skills/web-access
```

## CDP Proxy API

Proxy 通过 WebSocket 直连 Chrome（兼容 `chrome://inspect` 方式，无需命令行参数启动），提供 HTTP API：

```bash
# 启动（Agent 会自动管理 Proxy 生命周期，无需手动启动）
node "${CLAUDE_SKILL_DIR}/scripts/cdp-proxy.mjs" &

# 页面操作
curl -s "http://localhost:3456/new?url=https://example.com"     # 新建 tab
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'  # 执行 JS
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'  # JS 点击
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d '.upload-btn'  # 真实鼠标点击
curl -s -X POST "http://localhost:3456/setFiles?target=ID" \
  -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'        # 文件上传
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"     # 截图
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"           # 滚动
curl -s "http://localhost:3456/close?target=ID"                             # 关闭 tab
```

## ⚠️ 使用前提醒

通过浏览器自动化操作社交平台（如小红书）存在账号被平台限流或封禁的风险。**强烈建议使用小号进行操作。**

## 使用

安装后直接让 Agent 执行联网任务，skill 自动接管：

- "帮我搜索 xxx 最新进展"
- "读一下这个页面：[URL]"
- "去小红书搜索 xxx 的账号"
- "帮我在创作者平台发一篇图文"
- "同时调研这 5 个产品的官网，给我对比摘要"

## 设计哲学

> Skill = 哲学 + 技术事实，不是操作手册。讲清 tradeoff 让 AI 自己选，不替它推理。

详见 [SKILL.md](./SKILL.md) 中的浏览哲学部分。

## License

MIT · 作者：[一泽 Eze](https://github.com/eze-is) · [官网](https://web-access.eze.is)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=eze-is/web-access&type=Date)](https://star-history.com/#eze-is/web-access&Date)

<img width="1280" height="306" alt="image" src="https://github.com/user-attachments/assets/2afa25c2-3730-413e-b40f-94e52567249d" />
