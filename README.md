# dsh-native-codex-cli — 用 DSH 的聊天界面直接驱动 Codex

**简体中文** · [English](README.en.md)

[![check](https://github.com/447662/dsh-native-codex-cli/actions/workflows/check.yml/badge.svg)](https://github.com/447662/dsh-native-codex-cli/actions/workflows/check.yml)
[![release](https://img.shields.io/github/v/release/447662/dsh-native-codex-cli)](https://github.com/447662/dsh-native-codex-cli/releases)
[![license](https://img.shields.io/github/license/447662/dsh-native-codex-cli)](LICENSE)

DSH 负责聊天界面，**Codex CLI 负责整个任务执行与原生历史**。你在 DSH 里输入的任务会**原样**交给 Codex 的 `turn/start`，没有任何第二个 AI 转述、总结或"读聊天档案模拟续接"的环节；界面里渲染的每一个字都来自 Codex 自己推送的协议帧。

```
DSH Web GUI (本插件 client 半)
   │  POST /dsh-native-codex-cli/rpc      ← 一次性请求/响应
   │  GET  /dsh-native-codex-cli/events   ← SSE：流式输出 / 审批 / 通知
   ▼
本插件 host 半（跑在 DSH 宿主进程里）
   │  newline-delimited JSON-RPC over stdio
   ▼
codex app-server  ←→  Codex CLI 原生线程（唯一历史来源）
```

---

## 1. 八项要求的落地位置

| # | 要求 | 实现 | 代码 |
|---|------|------|------|
| 1 | 打开旧对话：查线程列表、读取并恢复 | `thread/list`（搜索/分页）+ `thread/resume` + `thread/turns/list`(`itemsView:"full"`) + `thread/items/list` 回填 | `lib/bridge.js` `listThreads` / `attachThread` / `hydrateHistory` |
| 2 | 新建任务：原生线程 + 工作目录/模型/权限 | `thread/start`（`cwd`/`model`/`approvalPolicy`/`sandbox`）；模型与权限目录来自 `model/list`、`permissionProfile/list` | `createThread`、`listModels`、`listPermissionProfiles` |
| 3 | 发送消息：直接进 Codex 的 turn | `turn/start`，文本原样作为 `input:[{type:"text",text}]`；执行中追加则走 `turn/steer` | `startTurn`、`steerTurn` |
| 4 | 流式输出 | `item/started`/`item/completed` 建立骨架，`item/agentMessage/delta`、`item/reasoning/*Delta`、`item/plan/delta` 逐帧累加 | `_onNotification`、`applyItemDelta` |
| 5 | 工具展示 | `commandExecution`（命令/状态/exit code/输出/耗时）、`fileChange`（文件清单 + unified diff）、`mcpToolCall`/`dynamicToolCall`/`webSearch`/`functionCallOutput`、`error`/`warning` 通知 | `client/client.js` 各 `*Item` 组件 |
| 6 | 停止任务 | `turn/interrupt`（真中断，不是停动画）；并先回绝 Codex 正在等待的审批，避免中断排在审批后面 | `interruptTurn` |
| 7 | 审批与提问 | 服务端请求 → 界面卡片 → 选择回传：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` | `_onServerRequest`、`buildApprovalResponse`、`ApprovalCard`/`QuestionCard` |
| 8 | 刷新与重启 | 线程↔会话关联持久化到 `~/.dsh/storages/dsh-native-codex-cli/bindings.json`；`clientMessageId` 幂等去重；SSE 断线自动重连并重新 `snapshot`；app-server 重启后自动 `thread/resume` | `lib/bindings.js`、`startTurn` 去重、`connectEvents` |

---

## 2. 界面落点

安装后会多出四个入口（全部走 DSH 官方 Slot 扩展点，不改动 DSH 自带 UI）：

| Slot | 作用 |
|------|------|
| `main[codex]` + `sidebar.panellist[codex]` | 侧边栏的 **Codex** 图标 → 独立 Codex 工作台：线程列表 / 搜索 / 新建任务（cwd、模型、权限策略、沙箱）/ 对话流 / 输入框 / 停止按钮 / 重命名 / 重启 Codex |
| `conversation.view[codex]` | 普通 DSH 会话里与「对话 / 轨迹」并列的 **Codex** 视图：显示该会话绑定的 Codex 线程 |
| `conversation.composer` | 会话一旦绑定 Codex，**接管该会话的输入框**：此后该会话的每条输入都直接进 Codex |
| `conversation.input.right[codex]` | 原生输入框右侧的 **Codex** 按钮：把当前草稿直接交给 Codex（草稿以 `@Codex` 开头时高亮为「交给 Codex」） |

### `@Codex` 的语义

按你的选择实现为**接管式**：

1. 在会话里输入 `@Codex <任务>`（或用输入框右侧的 Codex 按钮），该会话即被绑定到一个 Codex 线程，任务直接下发；
2. 绑定之后，**该会话的输入框被 Codex 接管**，后续消息无需再写 `@Codex`，全部直接进 Codex；
3. 想交还给 DSH，点输入框上方的「交还 DSH」即可（不会删除 Codex 那边的线程）。

---

## 3. 配置

配置走一个 JSON 文件（**不是** `cordis.patch.yml` 里的 `config:`）：

```
~/.dsh/storages/dsh-native-codex-cli/config.json
```

```json
{
  "codexBin": "codex",              // Codex 可执行文件；留在 PATH 上就用 codex
  "codexArgs": [],                  // 追加在 app-server 之后的参数
  "transport": "stdio",             // stdio（已实现）；daemon 为预留适配层
  "experimentalApi": true,          // 打开 app-server 实验性方法与字段
  "approvalPolicy": "on-request",   // 新建线程默认审批策略
  "sandbox": "workspace-write",     // 新建线程默认沙箱
  "model": "",                      // 新建线程默认模型；空 = 用 Codex 自己的默认
  "traceWire": false                // true 时把每一帧协议写进插件日志
}
```

文件不存在或写坏了都会退回代码里的默认值，绝不影响插件启动。

> **为什么不放在 patch 的 `config:` 里？**
> cordis 的 `resolveConfig` 会拿插件导出的 `Config` **schema** 去校验 patch 里的 config：
> ```js
> function resolveConfig(runtime, config) {
>   if (!runtime.Config) return config
>   const result = runtime.Config["~standard"].validate(config)   // ←
>   ...
> }
> ```
> 本插件没有 schema 库可用（pnpm 隔离布局下 `@deepseek-ai/cordis` 不可从插件包内解析），
> 一旦导出普通对象当 `Config`、或在 patch 里提供 config，条目就会以
> `TypeError: Cannot read properties of undefined (reading 'validate')` **激活失败**，
> `apply()` 根本不会执行。这正是本插件第一次装进真实 DSH 时踩到的坑
> （`Config` 检查器当时报的唯一异常状态 `unsupported`）。所以插件既不导出 `Config`，
> patch 里也不带 config，与两个可用的第三方插件保持一致。
> 若以后要恢复 loader 托管配置，导出符合 Standard Schema 的对象即可：
> `export const Config = { '~standard': { version: 1, vendor: 'dsh-native-codex-cli', validate: (v) => ({ value: ... }) } }`。

插件日志：`~/.dsh/logs/dsh-native-codex-cli.log`，也可以在浏览器里 `GET /dsh-native-codex-cli/log` 看最近 300 行。
客户端把关键诊断（Slot 注册、输入框 hook 形状）POST 到 `/dsh-native-codex-cli/diag`，同样落在这个文件里。

---

## 4. 安装 / 卸载

### 前置条件

| 需要 | 说明 |
|---|---|
| **DSH**（带 Web GUI：桌面端或 `dsh web`） | 插件依赖 `webServer` 与 Slot 扩展点 |
| **Codex CLI** | **不需要手动配置 PATH** —— 桌面端自带的 CLI、npm 全局安装、`~/.codex/packages/standalone/...` 都会被自动找到（见下面的「排查」一节）。只要 `codex --version` 能跑就行 |
| **已登录的 Codex** | 插件不碰认证，直接用你本机 Codex 已有登录态 |
| Node 18+ | 仅自检脚本需要 |

> 验证环境：**Codex CLI 0.153.4 + DSH Desktop 0.2.0-rc.2（Windows 11）**，CI 在 Linux 上跑同一套自检。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile desktop add git+https://github.com/447662/dsh-native-codex-cli.git
```

然后**重启 DSH**。`dsh plugin add` 会把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，插件自带的 `cordis.patch.yml` 会把自己插进加载树。

> **必须重启**：profile 的 bundle 列表不会在运行中热加载；`plugin-manager` 的启用/停用只切条目的 `disabled` 位，不会重新导入模块。

### 升级

重跑同一条 `add` 命令，然后重启 DSH 即可：

```bash
dsh plugin --profile desktop add git+https://github.com/447662/dsh-native-codex-cli.git
```

`~/.dsh/storages/dsh-native-codex-cli/bindings.json` 保存着"会话 ↔ Codex 线程"的关联，升级不会丢。

> 从 **0.2.0 / 0.2.1** 升级请务必升到 **0.2.2 或更高**：旧版本在找不到 Codex CLI 时会让 DSH 宿主进程直接退出；同时它们**看不见桌面端自带的 CLI**，会误报"未找到 Codex CLI"。

### 从本地克隆安装（开发用）

```powershell
git clone https://github.com/447662/dsh-native-codex-cli.git <仓库路径>

# 1) 让 profile 能解析到本包（junction 等价于 pnpm link）
New-Item -ItemType Junction -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-native-codex-cli" -Target "<仓库路径>"

# 2) 在 profile 的 package.json 里加上：
#    dependencies."dsh-native-codex-cli" = "link:<仓库路径>"
#    dsh.profile.bundles      += "dsh-native-codex-cli"
#    不要在 cordis.patch.yml 里给 dsh-native-codex-cli 写 config（原因见第 3 节）
```

### 卸载

```powershell
# 从 profile package.json 的 dsh.profile.bundles 与 dependencies 里删掉 dsh-native-codex-cli，
# 再删掉 junction（或 dsh plugin --profile desktop remove dsh-native-codex-cli），然后重启 DSH。
Remove-Item "$env:DSH_PROFILE_DIR\node_modules\dsh-native-codex-cli" -Force
```

插件的两个半边都是**失败安全**的：host 半不硬依赖任何 DSH 服务（`ctx.inject` 拿不到 `webServer` 只记日志），client 半对每个 Slot 注册单独 try/catch，注册失败只上报不抛错，并且 **load 期不会启动 Codex 进程**（第一次调用才拉起）。

### 排查"插件没生效"

按这个顺序看，一步就能定位到层次：

1. `~/.dsh/logs/dsh-native-codex-cli.log` 里有 `[boot] module imported` → 模块被解析到了；没有 → 包名/exports 解析失败。
2. 有 `[boot]` 但没有 `[host] dsh-native-codex-cli host loaded` → 条目创建了但**没有激活**，几乎一定是 `Config` schema 的问题（见第 3 节）。
3. 有 `[host]` 但没有 `[routes] routes mounted` → `webServer` 服务没拿到，检查 `ctx.inject` 日志。
4. 前三步都有、但 `POST /dsh-native-codex-cli/rpc` 仍 404 → 路由注册到了另一个 web 服务实例。

### 面板提示"未找到 Codex CLI"

**从 v0.2.1 起这种情况只会显示提示，不会让 DSH 崩溃**（早期版本会让宿主进程直接死掉，见下面的说明）。

插件**不只依赖 PATH**，它会自己去常见位置找：

| 平台 | 搜索位置（顺序） |
|---|---|
| Windows | `PATH` → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`（**桌面端自带的 CLI**）→ `%LOCALAPPDATA%\OpenAI\Codex\bin` → `%ProgramFiles%\OpenAI\Codex\bin` → `%APPDATA%\npm` → `%LOCALAPPDATA%\pnpm` → `~/.codex/packages/standalone/current/bin`、`~/.codex/bin`、`~/.codex/plugins/.plugin-appserver` |
| macOS / Linux | `PATH` → `~/.codex/packages/standalone/current/bin` → `~/.codex/bin` → `~/.local/bin` → `/usr/local/bin` → `/opt/homebrew/bin` → `/usr/bin` |

> 为什么必须自己找：**DSH 是 Electron 应用**。Codex 桌面端安装时把 CLI 目录写进的是*用户环境变量*，而已经在运行的进程、以及由 `explorer.exe` 启动的程序，沿用的是**登录时的旧环境** —— 于是"Codex 明明装了"和"Codex 没装"表现完全一样。

如果还是找不到，错误信息里会列出**所有搜过的目录**，然后：

1. 在终端确认 `codex --version` 能跑；
2. 或者直接写死路径：`~/.dsh/storages/dsh-native-codex-cli/config.json` 里设 `"codexBin": "C:\\Users\\<你>\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"`。

`codexBin` 的两种写法：**完整路径** → 原样使用（不会偷偷换成别的二进制）；**裸名字**（如 `codex`）→ 在上面那些位置里搜索这个名字。

> 历史问题：0.2.0 及更早版本里，spawn 失败会走 `emit('error')`，而 `EventEmitter` 在没有 `error` 监听者时会**同步重抛** —— 路由的 try/catch 拦不住，整个 DSH 宿主进程随之退出（表现为"应用无法启动或已意外停止"）。v0.2.1 修复，并由 `test/spawn-failure-check.mjs` 在 CI 里长期守住。

---

## 5. 自检与验证

前四项（**CI 每次提交都会跑**）不需要 DSH、不需要浏览器、**也不需要装 Codex**，秒级完成：

```bash
npm run check          # 全部六套
npm run check:utf8     # 编码守卫（每个被跟踪文件都必须是干净的 UTF-8）
npm run check:load     # 加载期自检
npm run check:spawn    # 缺 CLI 时宿主不许崩
npm run check:resolve  # CLI 搜索路径是否覆盖桌面端目录
npm run check:smoke    # 协议级端到端（会真起 codex app-server，几分钟）
npm run check:http     # HTTP 边界
```

| 脚本 | 覆盖什么 | 为什么存在 |
|---|---|---|
| `tools/check-utf8.mjs` | 每个被跟踪文件都是干净 UTF-8、无 BOM | 一次 Windows 的 `Get-Content`/`Set-Content` 往返把源码按 CP936 读回，**毁掉了整份中文 README** |
| `test/load-check.mjs` | client bundle 的 module 前导、6 个 Slot 声明、composer selector 纯度、host 路由挂载、`/codex` 命令形状、**会话镜像事件形状**、**Markdown 渲染器** | 一次 `Config` schema 事故让插件**完全不激活**，且没有任何提示 |
| `test/spawn-failure-check.mjs` | 用一个不存在的二进制名启动：必须干净地 reject、给出可操作信息，**不许有任何 unhandled rejection / uncaught exception 逃逸** | 曾经 `emit('error')` 无监听者时同步重抛，**整个 DSH 宿主进程随之退出** |
| `test/resolve-bin-check.mjs` | Windows/POSIX 的 CLI 候选目录顺序（注入假环境，跨平台可跑） | 桌面端自带的 CLI 在"过期 PATH"下不可见，曾被误判为"没装 Codex" |
| `test/smoke-bridge.mjs` | 真起 `codex app-server`，覆盖要求 1–8：线程列表 / 新建（cwd + 权限）/ 提交 turn / 流式增量 / 命令与文件改动 / 真中断 / **真实审批往返** / 去重与历史恢复 | —— |
| `test/http-check.mjs` | 浏览器实际用的那条通道：`POST /dsh-native-codex-cli/rpc` + `GET /dsh-native-codex-cli/events`（SSE） | —— |

当前实测：**utf8 全绿 / load-check 全绿 / spawn-failure 6/6 / resolve-bin 全绿 / smoke-bridge 25/25 / http-check 22/22**。

> 这个仓库里的两个 `test/*-check.mjs` 都是**从真实事故倒推出来的**：每一个都对应一次已经发生过的故障。CI 见 [`.github/workflows/check.yml`](.github/workflows/check.yml)。

### 维护用的调研工具

- [`docs/CODEX_PROTOCOL.md`](docs/CODEX_PROTOCOL.md) —— 逐字段的 `codex app-server` 协议参考
- `tools/asar-extract.mjs` —— 从 DSH 的 `app.asar` 里抽出单个文件（排查 loader 激活行为时用的就是它）
- `tools/session-shape.mjs` —— 解开 DSH 的 `session.v4.jsonl.zstd`，查看真实会话事件形状
- `test/method-map.mjs` / `test/schema-digest.mjs` / `test/schema-def.mjs` —— 把 `codex app-server generate-json-schema` 的产物压成可检索摘要（先跑 `npm run recon:schema`）

---

## 6. 已知限制

1. **`transport: daemon` 尚未实现**（`lib/app-server.js` 的 `createDaemonTransport` 会明确抛错，而不是偷偷再起一个 Codex 实例）。要接常驻 daemon，只需实现它并复用同一套 `LineRpc` —— 协议帧与载体无关。
2. **Codex 线程是进程作用域的**：app-server 重启后旧 threadId 需要 `thread/resume` 才能继续。插件在 `turn/start` 收到 `thread not found` 时会自动 resume 重试一次。
3. **历史只能靠 `thread/resume` 拿**：在 Codex CLI 0.153.4 上 `thread/turns/list` 返回 `list_turns is not supported yet`，`thread/read` 带 `includeTurns` 也会报同一个错。插件会检测到并**不再重试分页**，改用 `resume` 返回的 turns；因此历史分页代码是死路径，等 Codex 实装后自动生效。
4. **`assistant/message` 无法由插件写入**：真实事件的 `data` 需要内嵌 provider 原始流（`usage` / `stream`），缺失时 DSH 的会话投影会抛 `Cannot read properties of undefined (reading 'length')` 并导致该会话历史加载失败。所以会话镜像只写 `user/message` + turn 生命周期，Codex 的回复由主页面 dock 渲染。
5. **生成的协议绑定落后于运行时**：0.153.4 实际会在线上多发一些绑定里没有的字段（如 `canAcceptDirectInput`、`availableDecisions`）。本插件只读取自己需要的字段，多余字段一律忽略。
6. **`conversation.input.right` 的 `useInput`/`inputActions` 形状**是运行期探测的：首次在真实 GUI 里加载后，`~/.dsh/logs/dsh-native-codex-cli.log` 会记录 `composer-hooks` 一行，里面是宿主实际传入的字段名。如果与你看到的不一致，按那一行改 `ComposerCodexAction` 里的 `liveDraft` / 清空草稿分支即可。
7. **上传的图片会落盘**在 `~/.dsh/storages/dsh-native-codex-cli/uploads/`，由 `GET /dsh-native-codex-cli/image?p=<路径>` 提供（路径被限制在该目录内）。文件不会自动清理。
8. `turn/start` 的返回值是 **stub**（`itemsView:"notLoaded"`，时间戳为空），`turn/completed` 也只带 `itemsView:"summary"` 的切片。插件的镜像以 `item/started` / `item/completed` / delta 为准。

---

## 7. 参与开发

```bash
git clone https://github.com/447662/dsh-native-codex-cli.git
cd dsh-native-codex-cli
npm run check          # 三套自检都应全绿
```

约定：

- **host 半**（`lib/`）只做协议与状态，**绝不**把任务内容交给任何模型；用户输入原样进 `turn/start`。
- **client 半**（`client/client.js`）是手写的单文件 module-loader bundle，**没有构建步骤** —— 前提是保留 `window.__ModuleLoader__.load({ id, factory })` 包装和 factory 内的 `module`/`exports` 前导（缺了它整个 bundle 会在加载期抛错）。
- 每个 Slot 注册都必须走 `slots.inject(slot, ...)` 并单独 try/catch；DSH 宿主声明槽位的时机晚于插件 apply。
- 新增行为请同时补 `test/load-check.mjs` 的断言（协议形状、纯函数、声明）—— 它不需要 DSH 或浏览器。

---

## 8. 许可

[MIT](LICENSE) © dsh-native-codex-cli contributors

本项目是独立社区项目，与 DeepSeek 官方及 OpenAI 均无隶属关系。Codex 是 OpenAI 的产品；本插件只是通过其公开的 `codex app-server` 协议驱动本机已安装的 CLI。
