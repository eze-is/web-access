# CDP Proxy API 参考

## 基础信息

- 地址：`http://localhost:3456`
- 检查、复用或后台启动：`node ~/.claude/skills/web-access/scripts/check-deps.mjs`
- 服务持续运行，没有时长或空闲退出计时器；检查超时不会停止服务
- 集中维护：`node <skill路径>/scripts/proxy-maintenance.mjs status|restart|stop`（Windows / macOS / Linux 相同）

## API 端点

### GET /health
健康检查，不建立浏览器连接。`status: "ok"` 表示服务响应正常；只有 `connected === true` 才表示已有连接可复用。已有服务断线时，前置检查通过 `/targets` 让原服务重新连接，不启动第二个进程。浏览器重启或撤销权限后，重连可能再次需要浏览器授权。
```bash
curl -s http://localhost:3456/health
```

| 字段 | 含义 |
|------|------|
| `instanceId` / `pid` / `startedAt` | 当前服务实例身份、进程号和启动时间 |
| `browser.id` / `browser.label` | 浏览器身份 = 规范化后的用户数据目录绝对路径；`label` 是取自目录名的显示名，只用于展示。升级前的实例可能报告旧值（如 `chrome`），维护与前置检查把它与对应标准路径视为同一浏览器 |
| `browser.source` | 浏览器选择来源（偏好或临时覆盖），不是端口进程身份的自动验证 |
| `runningRevision` | 启动时加载的 Proxy 与连接模块源码指纹，文件修改不会自动重启服务 |
| `connectionState` | `disconnected` → `discovering` → `connecting` → `connected`；失败退回 `disconnected` |
| `connectionAttempts` | 当前实例累计的连接尝试次数；并发等待不会增加次数 |
| `pendingCommands` | 未完成的 CDP 命令数 |
| `activeRequests` | 执行中的浏览器操作请求数，不含健康检查和维护请求 |
| `managedTabs` | 当前服务管理的 Agent 标签页数 |
| `maxTabs` | `CDP_MAX_TABS` 生效值，`0` 表示不限制；创建中的标签页也预留配额，但尚未计入 `managedTabs` |
| `maintenance` | 正在停止；前置检查不得把它当作可用或启动第二个实例 |

### POST /shutdown

维护 CLI 专用。JSON body 为 `{ "instanceId": "从健康检查读取的身份" }`。只接受不带 `Origin` 的本机 POST；实例不一致或仍有请求、命令、标签页、发现/握手时返回 `409`。接受后返回 `202`，进入维护状态，普通操作返回 `503`，退出只执行一次。健康检查仍可用于观察退出，CLI 不会因为实例被替换而停止新实例。

维护 CLI 的退出码：`0` 表示状态检查/停止完成或重启后连接确认就绪；`2` 表示忙碌、身份冲突、旧服务缺少维护接口或参数错误；`3` 表示新服务已启动但尚未连接（`waitingAuthorization`，也可能是调试设置或浏览器不可用）；其他错误为 `1`。旧服务的一次性迁移需要先确认没有任务使用它，不自动强停。普通任务不要在结束时停止服务，代码变更由集中维护升级一次。

连接模块 `scripts/cdp-connection.mjs` 唯一拥有 socket、连接尝试和命令响应。`connect()` 从浏览器发现开始共享同一个 Promise；`send()` 只在已有连接发送，不隐式连接；`close()` 立即拒绝该连接的等待者。每个 socket 的事件只作用于它自己的连接上下文，失败会清空该连接的命令等待，后续请求可重试。模块同时支持原生 WebSocket（EventTarget）和 `ws`（EventEmitter）。服务端 HTTP 和标签页职责保留在 Proxy，浏览器选择保留在 discovery 模块。

浏览器选择由 `scripts/browser-discovery.mjs` 负责：`WEB_ACCESS_BROWSER`（或 `--browser`）是浏览器用户数据目录路径，旧值 `chrome` / `chrome-canary` / `chromium` / `edge` 按平台映射到标准目录。值必须指向含 `Local State` 的 Chromium 用户数据目录，否则为配置错误；目录存在时身份取真实路径（软链接、大小写差异归一）。只读该目录根部的 `DevToolsActivePort`，不可用即报错，不扫描其他目录或固定端口；未设置时 Proxy 拒绝连接，由前置检查引导首次配置（`scripts/browser-probe.mjs`）。

`~/.web-access/config.env` 中可选的 `WEB_ACCESS_CDP_PORT` 明确绑定 `WEB_ACCESS_BROWSER`，只用于日常浏览器的端口文件读不到（如系统权限拒绝读取）时显式指定端口；用 `--remote-debugging-port` 单独启动的调试浏览器不在支持范围内。留空使用文件发现，非空必须是十进制 `1..65535`，且 `WEB_ACCESS_BROWSER` 是有效的数据目录路径或旧值。显式映射须先核对浏览器归属；发现只检测 TCP，不建立授权握手。不同浏览器覆盖不借用此端口，离线也不回退。端口文件的 `EPERM/EACCES` 会作为权限事实报告，不能据此断言未开启调试。

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

可在启动服务的环境中设置 `CDP_MAX_TABS` 限制本实例同时管理的 Agent 标签页数。未设置或设为 `0` 保持不限制；其他值必须是正的十进制安全整数，无效配置会在服务绑定端口、连接浏览器之前明确报错。该变量从进程环境读取，不从 `config.env` 读取；更改后须通过已有维护命令在服务空闲时重启，不会修改或抢替正在执行任务的共享服务。

达到上限时返回 `429` 和 `{ "error": "...", "hint": "...", "managedTabs": ["TARGET_ID", "..."] }`。配额包含正在创建、尚未取得 ID 的标签页，因此列表可能为空。请等待创建完成，或先 `/close` 列表中已不需要的 Agent 标签页再重试。创建失败、关闭成功或浏览器通知标签页已销毁后释放相应配额；关闭失败保留配额。仅统计此服务通过 `/new` 创建的标签页，不计用户已有标签页，不为腾出配额自动淘汰标签页。原有 15 分钟闲置清理规则保持不变。

此上限只限制当前追踪的 Agent 标签页加创建中的请求，并非浏览器实际标签页总数或内存的硬上限。沿用既有生命周期：WebSocket 断线会清空 `managedTabs`，重连不会认领之前留下的标签页。创建命令超时或连接中断时，即使请求失败，浏览器也可能已创建标签页；请先用 `/targets` 检查现状，不要直接重复创建。

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

可选 `frame=FRAME_ID`（取自 `/frames`）：在页面里的这个 iframe 中执行，跨站（跨进程）iframe 也可以，不必另开 iframe 的网址。代码在该 iframe 的隔离环境中运行：能读写 iframe 的 DOM，看不到页面自己的 JS 全局变量。`frameId` 不属于该页面主文档的 iframe 时返回 `400`。不带 `frame` 时行为与以前完全相同。
```bash
curl -s -X POST "http://localhost:3456/eval?target=ID&frame=FRAME_ID" -d 'document.body.innerText'
```

### GET /frames?target=ID
列出页面主文档里直接的 `<iframe>` / `<frame>`，按文档顺序返回数组。列举在隔离环境中进行，页面脚本改写 DOM API 不影响结果。

| 字段 | 含义 |
|---|---|
| `index` | 在主文档 `document.querySelectorAll('iframe, frame')` 结果中的位置（从 0 开始），可用 `/eval` 按同一顺序对上具体元素 |
| `frameId` | 用于 `/eval?frame=` 的标识；iframe 尚未加载出文档时为 `null`。只含字母数字等网址安全字符 |
| `url` | iframe 当前的网址（导航后会与 `src` 不同） |
| `crossProcess` | 是否在另一个进程（跨站 iframe）；父页面读不到这类 iframe 的 `contentDocument` |
| `id` / `name` / `src` | 可选，iframe 元素的属性原值，用来认出是哪一个 |

两步用法：先 `/frames` 按 `id`、`name`、`url` 或 `index` 认出目标 iframe，取它的 `frameId`，再 `/eval?target=ID&frame=FRAME_ID`。

范围：不含 shadow root 里的 iframe，也不递归嵌套。嵌套在跨进程 iframe 里的 iframe，以外层 iframe 的 `frameId` 作 `target` 再调用一次（`/frames?target=FRAME_ID`、`/eval?target=FRAME_ID&frame=INNER_ID`）。
```bash
curl -s "http://localhost:3456/frames?target=ID"
```

### GET /clickXY?target=ID&x=120&y=90
按页面视口坐标发送真实鼠标事件（移动、按下、松开），不激活标签页（在 headless 下验证；有界面浏览器上未实测）。坐标落在 iframe 的内容区时逐层进入，最多 5 层：
- 跨进程 iframe：换算成该 iframe 视口内的坐标后发给它（扣除 iframe 的边框与内边距，按 transform / zoom 的缩放比例换算）
- 同进程 iframe：照常由页面派发
- 坐标落在 iframe 的边框或内边距上：点的是 iframe 元素本身，不进入

`x`、`y` 必须是有限的非负数；坐标不在页面视口内时返回 `400`，不发出事件。返回 `{ clicked, x, y }`，进入了 iframe 时另含最内层的 `frameId`、`crossProcess` 与进入层数 `depth`。`clicked` 只表示鼠标事件已经发出，是否点中目标要再用 `/eval` 核对页面状态。

坐标取法：页面上的元素用 `/eval` 取 `getBoundingClientRect()` 的中心；iframe 里的元素，用 `/eval?frame=` 取它在 iframe 视口中的坐标，再加上 iframe 内容区在页面视口中的位置（iframe 元素的 `getBoundingClientRect()` 加 `clientLeft` / `clientTop` 再加内边距；iframe 被缩放时把 iframe 内坐标乘以缩放比例）。
```bash
curl -s "http://localhost:3456/clickXY?target=ID&x=120&y=90"
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
| `尚未设置浏览器` | `WEB_ACCESS_BROWSER` 为空 | 运行 `check-deps.mjs` 完成首次配置 |
| `…的浏览器 <显示名>（<数据目录>）没连上` | 浏览器未运行、远程调试开关未开启或端口已失效 | 按错误里的「Agent 处理顺序」：先打开该浏览器；仍失败请用户在地址栏打开 `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`）勾选 Allow |
| `配置错误 — WEB_ACCESS_BROWSER 的值无效` | 值不是绝对路径或旧值，目录不存在，或目录里没有 `Local State` | 改正配置（可用 `browser-probe.mjs` 确认路径）；不需要停止共享服务 |
| `attach 失败` | targetId 无效或 tab 已关闭 | 用 `/targets` 获取最新列表 |
| `CDP 命令超时` | 页面长时间未响应 | 重试或检查 tab 状态 |
| 启动时端口被占用 | 另一个 Proxy 已在运行 | 新进程确认已有健康实例后直接退出，复用已有实例 |
