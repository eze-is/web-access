# CDP Proxy API 参考

## 基础信息

- 地址：`http://localhost:3456`
- 启动：`node ~/.claude/skills/web-access/scripts/cdp-proxy.mjs &`
- 启动后持续运行，不建议主动停止（重启需 Chrome 重新授权）
- 强制停止：`pkill -f cdp-proxy.mjs`

## API 端点

### GET /health
健康检查，返回连接状态。
```bash
curl -s http://localhost:3456/health
```

### GET /targets
列出所有已打开的页面 tab。返回数组，每项含 `targetId`、`title`、`url`。
```bash
curl -s http://localhost:3456/targets
```

### POST /new
创建新后台 tab。Proxy 会先创建 `about:blank`、完成 CDP attach，再显式导航并等待目标 URL 的 DOM 至少进入 `interactive`，避免把新标签页初始的空白文档误判为目标页面。**URL 通过 POST body 原样传入**，无需 URL-encode、不会因 query 中含 `&` 被切分。返回 `{ targetId }`。
```bash
curl -s -X POST --data-raw 'https://example.com' http://localhost:3456/new
# 含 query 的目标 URL（如带 token 的小红书笔记）也直接原样传：
curl -s -X POST --data-raw 'https://www.xiaohongshu.com/explore/xxx?xsec_source=app_share&xsec_token=ABC&type=normal' http://localhost:3456/new
```
> v2.5.3 起改为 POST。旧的 `GET /new?url=...` 返回 400 + 迁移指引，详见 `migration-2.5.3.md`。

### GET /close?target=ID
关闭指定 tab。
```bash
curl -s "http://localhost:3456/close?target=TARGET_ID"
```

### POST /navigate?target=ID
在已有 tab 中导航到新 URL，自动等待加载。**target 走 query（不带特殊字符的不透明 ID），URL 走 POST body**。
```bash
curl -s -X POST --data-raw 'https://example.com' "http://localhost:3456/navigate?target=ID"
```
> v2.5.3 起改为 POST。旧的 `GET /navigate?target=...&url=...` 返回 400 + 迁移指引，详见 `migration-2.5.3.md`。

> `/new` 和 `/navigate` 的等待是浏览器文档层的基础保证，不是业务内容完成保证。验证页、登录跳转、SPA 异步渲染等仍可能继续变化；调用后必须按主 Skill 的“页面就绪与完成判断”检查目标内容，不能只看 `readyState`。

### GET /back?target=ID
后退一页。
```bash
curl -s "http://localhost:3456/back?target=ID"
```

### GET /info?target=ID
获取页面基础信息（title、url、readyState）。
```bash
curl -s "http://localhost:3456/info?target=ID"
```

### POST /eval?target=ID
执行 JavaScript 表达式，POST body 为 JS 代码。
```bash
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'
```

### POST /click?target=ID
JS 层面点击（`el.click()`），POST body 为 CSS 选择器。自动 scrollIntoView 后点击。简单快速，覆盖大多数场景。
```bash
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'
```

### POST /clickAt?target=ID
CDP 浏览器级真实鼠标点击（`Input.dispatchMouseEvent`），POST body 为 CSS 选择器。先获取元素坐标，再模拟鼠标按下/释放。算真实用户手势，能触发文件对话框、绕过部分反自动化检测。
```bash
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'
```

### POST /drag?target=ID
CDP 浏览器级真实鼠标拖拽。`source` 是起点元素的 CSS 选择器；终点可用 `target` 元素选择器，或用 `deltaX` / `deltaY` 指定相对于起点中心的位移。

拖到目标元素中心：

```bash
curl -s -X POST "http://localhost:3456/drag?target=ID" \
  -d '{"source":".card","target":".drop-zone","steps":12,"durationMs":300}'
```

按相对位移拖动：

```bash
curl -s -X POST "http://localhost:3456/drag?target=ID" \
  -d '{"source":".slider-handle","deltaX":240,"deltaY":0,"steps":12,"durationMs":300}'
```

- `target` 与 `deltaX` / `deltaY` 不能同时使用。
- `steps` 默认 `12`，范围为 `1` 到 `100`。
- `durationMs` 默认 `300`，范围为 `0` 到 `10000`。
- 拖拽前会通过 `Page.bringToFront` 激活目标标签页，以避免 Chromium 对后台连续输入事件进行节流；这会改变浏览器当前标签页，接口不会自动恢复先前标签页。
- 源元素和目标元素必须有非零尺寸、中心点未被遮挡，并位于当前页面视口中；相对位移的终点也必须位于视口中。
- `/drag` 与 `/clickAt` 的真实鼠标事件会串行执行，避免并发请求互相释放按键。

成功时返回起点、终点、步数和持续时间：

```json
{
  "dragged": true,
  "from": { "x": 120, "y": 200 },
  "to": { "x": 360, "y": 200 },
  "steps": 12,
  "durationMs": 300
}
```

### POST /setFiles?target=ID
给 file input 设置本地文件路径（`DOM.setFileInputFiles`），完全绕过文件对话框。POST body 为 JSON。
```bash
curl -s -X POST "http://localhost:3456/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file1.png","/path/to/file2.png"]}'
```

### GET /scroll?target=ID&y=3000&direction=down
滚动页面。`direction` 可选 `down`（默认）、`up`、`top`、`bottom`。滚动后自动等待 800ms 供懒加载触发。
```bash
curl -s "http://localhost:3456/scroll?target=ID&y=3000"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"
```

### GET /screenshot?target=ID&file=/tmp/shot.png
截图。指定 `file` 参数保存到本地文件；不指定则返回图片二进制。可选 `format=jpeg`。
```bash
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"
```

## /eval 使用提示

- POST body 为任意 JS 表达式，返回 `{ value }` 或 `{ error }`
- 支持 `awaitPromise`：可以写 async 表达式
- 返回值必须是可序列化的（字符串、数字、对象），DOM 节点不能直接返回，需要提取属性
- 提取大量数据时用 `JSON.stringify()` 包裹，确保返回字符串
- 根据页面实际 DOM 结构编写选择器，不要套用固定模板

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `Chrome 未开启远程调试端口` | Chrome 未开启远程调试 | 提示用户打开 `chrome://inspect/#remote-debugging` 并勾选 Allow |
| `attach 失败` | targetId 无效或 tab 已关闭 | 用 `/targets` 获取最新列表 |
| `CDP 命令超时` | 页面长时间未响应 | 重试或检查 tab 状态 |
| `端口已被占用` | 另一个 proxy 已在运行 | 已有实例可直接复用 |
