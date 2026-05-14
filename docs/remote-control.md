# 用手机远程控制 Claude Code — 技术报告

> 项目:**claude-rc**(`~/work/dev/claude-rc`)
> 目标:在手机/网页里跟跑在自己开发机上的 Claude Code 对话,通过 Tailscale 走私有网络,不暴露公网。
> 设计前提:**所有权属于自己**(YOLO,跳所有 approval),Max 订阅,单用户。

本文按时间顺序记录了我们尝试的三种 remote control 实现方式,以及一个独立的 generative UI 章节。**重点是 remote control 的实现 —— UI 驱动作为附加章节放在最后。**

---

## 目录

1. [背景 / 目标](#1-背景--目标)
2. [整体架构 / 共享部件](#2-整体架构--共享部件)
3. [方式 A:Print Mode(`claude --print stream-json` 长进程)](#3-方式-aprint-modeclaude---print-stream-json-长进程)
4. [方式 B:Channel Mode(tmux 交互 + MCP 通道)](#4-方式-bchannel-modetmux-交互--mcp-通道)
5. [方式 C:Oneshot Mode(每个 turn 一个 `claude --print` 子进程)](#5-方式-coneshot-mode每个-turn-一个-claude---print-子进程)
6. [三种方式横向对比](#6-三种方式横向对比)
7. [关键坑 / 教训](#7-关键坑--教训)
8. [Generative UI(模型驱动卡片)— 附加章节](#8-generative-ui模型驱动卡片-附加章节)

---

## 1. 背景 / 目标

我们之前给 **codex** 做了同款的 `codex-rc`:Bun + React + Tailscale,phone → daemon → `codex app-server --listen stdio` → 反向 JSON-RPC。那套很顺,因为 codex 自己暴露了一个干净的双向协议。

到 Claude Code 这边事情就麻烦多了 —— Claude Code 没有同样的 `app-server` 形态。它有几条**入口**可走,但每条都有自己的怪癖:

| 入口 | 协议形态 | 双向交互 | 工具调用可见 | 适合长进程 |
|---|---|---|---|---|
| `claude --print` | 一次性输出(可加 `stream-json`) | 否(stdin 流式输入算半个) | ✅(stream-json) | 一般 |
| `claude` 交互模式 | TUI | TUI 本身 | TUI 屏幕 | ✅ |
| `--dangerously-load-development-channels` + Channels API | MCP `notifications/claude/channel` | ✅ 双向 | ✅(可通过 hooks) | ✅ |
| `app-server`(Codex 同款) | 不存在 | — | — | — |

目标侧:
- 手机/网页能发消息,看到回复
- 工具调用过程要看见(Bash / Read / Edit / WebSearch ...)
- 重启 bridge 后历史不丢
- 任意机器登同一个 URL 都能接管同一个会话
- `/rc`(Anthropic 自带的 Remote Control)依然要能工作(我们的 daemon 是叠在它之上的一层)

按这套目标我们最终造了**三种独立后端**,跑在不同端口上,可同时存在用于体验对比:

| 端口 | 模式 | 文件 |
|---|---|---|
| 9896 | print | `server/session.ts` |
| 9897 | channel | `server/channel-session.ts` |
| 9898 | oneshot | `server/oneshot-session.ts` |

---

## 2. 整体架构 / 共享部件

不管哪种模式,顶层 daemon 长这样(`server/index.ts`):

```
phone / web ──HTTPS+WebSocket──▶  Tailscale  ──▶  bridge daemon (Bun)
                                                       │
                                                       ▼
                                                  Session backend
                                                  (print/channel/oneshot)
                                                       │
                                                       ▼
                                                   claude (CLI)
```

共用基础设施:

- **Bun + TypeScript**:服务端 + 工具,启动快、单二进制
- **WebSocket 协议**(`shared/protocol.ts`):`ClientMsg` / `ServerMsg`、`ChatItem` 联合类型
- **Tailscale**:私有覆盖网,phone 和 dev 机互通,完全不需要公网
- **Token + Cookie auth**:`?t=<token>` 首次访问写 cookie,后续走 cookie。每个 mode 有独立 token(`~/.arche/claude-rc-<mode>.token`),不会串
- **持久化**:每个 mode 一份 JSON 存 thread 列表(标题/cwd/sessionId/preview),消息内容**不存** —— 我们用 Claude Code 自己写的 JSONL transcript 做 hydration 源

JSONL hydration 是个关键设计选择,放第 4 节讲。

---

## 3. 方式 A:Print Mode(`claude --print stream-json` 长进程)

**文件**:`server/session.ts`、`server/claude/process.ts`

### 想法

`claude --print` 配合 `--input-format stream-json --output-format stream-json --verbose --include-partial-messages`,本来设计是给 SDK/工具链做 batch 用的。但实际上它 stdin 是流式 NDJSON —— 可以一直喂消息进去,claude 也一直返回事件流,从来不退出。

所以可以这样:一个 thread 一个 `claude --print` 子进程,长期跑着,通过 stdin 推 user 消息,stdout 解析事件流(`system` / `stream_event` / `assistant` / `user` / `result`)。

### 协议形态

输入(我们写到 stdin):
```json
{"type":"user","message":{"role":"user","content":"..."},"session_id":"..."}
```

输出(NDJSON 流):
```
{"type":"system","subtype":"init","session_id":"..."}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"..."}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}
...
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use",...}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"..."}}}
...
{"type":"user","message":{"content":[{"type":"tool_result",...}]}}
{"type":"result","subtype":"success"}
```

会话 ID 我们自己生成(`--session-id <uuid>`),第二个 turn 起换成 `--resume <sessionId>` —— 这样 claude 内部的 rollout 文件就是 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,可预测。

### 优点

- ✅ **协议干净**:NDJSON 事件流,字段稳定,我们直接 dispatch 到 `ChatItem` 不需要 ANSI 抓屏
- ✅ **工具调用可见**:`content_block_start` 给 tool name + id,`input_json_delta` 流式输入,`tool_result` 配套
- ✅ **streaming 体验**:`text_delta` 一个字一个字到,UI 可以打字效果
- ✅ **`/rc` 不受影响**:我们不污染 claude 的内部状态,Anthropic 自带的 Remote Control 在 claude 这一边仍可用

### 缺点 / 坑

- ❌ **`--dangerously-load-development-channels` 被静默忽略**:这个 flag 只在 interactive TUI 模式生效。print mode 下 claude 完全无视,我们最初想用 Channels API 推送的方案直接被堵死。
- ❌ **不能 tmux attach**:子进程没有 PTY,在手机上无路可走 —— 要回答 plan mode、AskUserQuestion 这类 TUI 对话框,**只能放弃这条 turn**
- ❌ **半交互的奇怪状态**:claude --print 在等输入时不会显式 "ready" 信号,我们靠 `result` frame 推断"上一 turn 结束了,可以发下一条"
- ❌ **slash commands(`/usage` `/login` `/clear`)无法使用** —— print mode 不挂载这些

### 何时用

- 想纯走 SDK 形态、不需要 channels、不需要 attach 看进度 → print mode 足够
- 我们最后保留它作为基线,但**主线退场**了

---

## 4. 方式 B:Channel Mode(tmux 交互 + MCP 通道)

**文件**:`server/channel-session.ts`、`server/claude/channel-process.ts`、`server/claude/channel-mcp.ts`、`server/claude/hook-emit.ts`、`server/control-plane.ts`

### 想法

既然 print mode 拿不到 Channels,那就**让 claude 跑在 interactive 模式**,我们从外面通过两条独立的路驱动它:

- **输入路**:`tmux send-keys` 直接往 prompt 里"打字"(完全模拟用户)
- **输出路**:claude 调一个我们自己实现的 MCP 工具 `mcp__claude-rc-channel__reply` 把回复发回来

外加 PreToolUse / PostToolUse / UserPromptSubmit hooks,把工具调用过程也推回 bridge,phone UI 实时显示。

### 拓扑

```
                    +-- env CLAUDE_RC_THREAD_ID / CP_PORT / CP_TOKEN
                    |
                    ▼
    tmux session (claude-rc-ch-<id><suffix>)
       │
       │  spawns:
       │
       └─▶ claude --dangerously-load-development-channels server:claude-rc-channel
                    --dangerously-skip-permissions
                    --session-id <threadId>           ← pin transcript filename
                    --settings <hooks.json>           ← per-thread tempdir
                    --append-system-prompt "<...>"   ← force every answer through reply()
                    │
                    │  loads:
                    │
                    ├─▶ MCP server (claude-rc-channel)            ─┐
                    │   = bun run server/claude/channel-mcp.ts     │ TCP localhost
                    │   • exposes `reply(text|blocks)` tool        │ (control plane)
                    │   • forwards reply → bridge                  │
                    │   • receives `push` from bridge (unused)     │
                    │                                              │
                    └─▶ hooks (Pre/Post/UserPromptSubmit)          │
                        = bun run server/claude/hook-emit.ts        │
                        • forward tool_call / tool_result /         │
                          user_prompt to bridge                     ┘
                                                                    │
                                                                    ▼
                                                       bridge daemon
                                                       (channel-session.ts)
```

### 关键决策

1. **MCP server 注册到 user scope**:`claude mcp add claude-rc-channel -s user -- bun run <path>`。注册到 user 而不是 `--mcp-config`,因为后者 claude 会问"是否信任",手机上没法回答。
2. **`--dangerously-load-development-channels server:claude-rc-channel` 绕过 allowlist**:Anthropic 默认只允许少数 channel server,这个 flag 跳检查,让我们的 channel server 能注入。
3. **send-keys 而不是 channel push**:我们一开始试过用 `notifications/claude/channel` push 用户消息进 claude —— 失败,因为 welcome 屏幕、setup screen 不会 flush 这个队列。后来全改成 `tmux send-keys -l` 模拟键盘输入,welcome 屏幕一样能进。
4. **`--session-id <threadId>` 锁定 transcript 文件名**:这样 `~/.claude/projects/<encoded-cwd>/<threadId>.jsonl` 路径可预测,bridge 重启后能根据 threadId 直接读回历史。
5. **每个 thread 一个 tmux session + INSTANCE 后缀**:`claude-rc-ch-<8chars>-<instance>`,两个 channel bridge 同时跑互不干扰。
6. **Hooks 用 PreToolUse + PostToolUse + UserPromptSubmit**:工具调用流 + 在 tmux 里直接打字的 prompt 都能转推到 bridge → phone UI。

### 控制平面(control plane)

`server/control-plane.ts` 是个 token-auth localhost TCP server:

- bridge 启动时监听一个随机端口
- 把 `(THREAD_ID, CP_PORT, CP_TOKEN)` 通过 tmux `-e` 注入 claude 环境
- claude spawn MCP child(channel-mcp.ts),继承环境
- MCP child 启动时连 TCP,发 `{type:"register", threadId, token}`
- 之后所有 `{type:"reply"|"tool_call"|"tool_result"|"user_prompt"|...}` 走这个 socket

为啥单独一个 TCP plane?因为 MCP 协议本身是 claude ↔ MCP child 的 stdio,bridge 不在这条链路里,无法直接接收 MCP child 的事件。开个 TCP 是最干净的旁路。

### 历史恢复(hydration from JSONL)

bridge 重启后,我们**不读自己的存储** —— claude 自己已经把完整对话写到 JSONL 里了:

```
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

每行一个事件,包含 user/assistant 消息、tool_use、tool_result。`channel-session.ts:hydrateFromTranscript` 解析这个文件投影成 ChatItem 数组,在 `open_thread` 时按需 hydrate。

附带做了**一次性 migration**:老 thread 没 pin `--session-id`,JSONL 文件名是 claude 自动生成的 UUID,跟我们的 threadId 不一致。bridge 启动时按 `(cwd, first user message prefix)` 匹配 JSONL 文件,把发现的 sessionId 写回 `threads-channel.json`。一次性,跑过就别再跑。

### Tool 调用 hijack(手机上没 TUI 选择器)

`AskUserQuestion` / `ExitPlanMode` 在手机上没法应答 —— TUI 弹框,光标键选项,phone 用户没办法。

方案:`PreToolUse` hook 直接 `permissionDecision: "deny"`,reason 里告诉 claude:

> AskUserQuestion is disabled in claude-rc (phone/web UI has no TUI selector). Instead, send your question to the user via the mcp__claude-rc-channel__reply tool (include all options inline, e.g. as a numbered list), then end your turn — the user will answer in the next message.

claude 收到这个错误,会自然改用 reply 工具发问、附上选项列表,继续等下一条用户消息。后来 generative UI 加了 `actions` block,这个 fallback 进化成"出按钮直接点"。

### 优点

- ✅ **`/rc` 工作**:claude 是普通 interactive 模式,Anthropic 的 Remote Control 完全不受影响
- ✅ **slash commands、`/usage`、`/login` 都能用**(通过 tmux attach 或我们的 channel)
- ✅ **可以 ssh + `tmux attach`**:在台式机上 attach 到那个 tmux session,直接接管,跟手机端共享同一个 claude 进程
- ✅ **工具调用过程清晰可见**(hooks)
- ✅ **历史跨重启不丢**(JSONL hydration)
- ✅ **多机访问同步**:bridge 是单例,所有客户端连同一个,看的是同一份状态

### 缺点 / 坑

- ❌ **复杂度高**:5 个独立文件、控制平面 socket、tmux 状态机、hook 进程、MCP child 子进程...任何一环坏了都难诊断
- ❌ **tmux 状态难管理**:bridge 重启时 tmux 不死,但 MCP child 已经连不上旧 control plane → 我们在 bridge 启动时强杀所有匹配前缀的 orphan tmux session
- ❌ **MCP socket 半开问题**:claude 偶尔会让 MCP child 的 TCP socket 进入 half-open 状态,bridge 这边检测不到挂掉。我们后来不再用 `cp.isConnected` 来判断,改成只要 tmux 在就 send-keys
- ❌ **窗口期问题**:claude 启动需要 1-2 秒画完 TUI,这时候 send-keys 进去会丢字 —— 我们 buffer 第一条消息为 `pendingPush`,等 MCP child onConnect 回调后再 inject
- ❌ **TUI 弹框还是有死角**:除了 AskUserQuestion / ExitPlanMode 我们 hijack 掉以外,其他偶发的弹框(feedback survey、project mcp.json trust prompt)需要靠 `feedbackSurveyRate: 0` / `enableAllProjectMcpServers: true` 这些设置预防

### 何时用

**主线推荐路径** —— 唯一一种能保留 Claude Code 完整能力的方式,但代价是工程复杂度。

---

## 5. 方式 C:Oneshot Mode(每个 turn 一个 `claude --print` 子进程)

**文件**:`server/oneshot-session.ts`

### 想法

print mode 的子进程是**长期跑**的;channel mode 是**完全交互式**。Oneshot 是第三条:每个 user turn 起一个**全新**的 `claude --print "..."` 子进程,跑完就退。像在调一个无状态的 API。

### 拓扑

```
phone send "..." ─▶ bridge ─▶ spawn claude -p
                                  --output-format stream-json --verbose
                                  --include-partial-messages
                                  --session-id <threadId>       (first turn)
                                  --resume <threadId>           (subsequent turns)
                                  --dangerously-skip-permissions
                                  --append-system-prompt "<...>"
                                  "<user text>"

                              ─▶ stdout 流 NDJSON events
                              ─▶ exit code=0
                              ─▶ bridge 标记 idle
```

历史还是从 JSONL 读回。流式事件用跟 print mode 一样的解析代码。

### 与方式 A 的关键区别

- print mode:**一个长期 claude 进程喂 NDJSON 输入**
- oneshot:**每次发消息 fork 一个 claude,跑完 exit**

### 跟 channel mode 怎么配合

我们让 oneshot 也能用 `mcp__claude-rc-channel__reply` 工具(因为是 user-scope 注册的,任何 claude 调用都看得到)—— **但 oneshot 这边没有 control plane**(每个 turn 起新进程,没有持久 socket 接收方)。

解决:给 `channel-mcp.ts` 加 **stub 模式**:如果环境变量(`CLAUDE_RC_CP_PORT` 等)缺失,就跳过 control plane 连接,仅暴露 `reply` 工具的 schema。oneshot 直接从 stream-json 的 `tool_use` 事件里抽 `reply` 的 input,根本不需要 socket 回路。

### Markdown ``` ui ``` 兜底

不是每次 claude 都肯调 reply 工具,有时候模型决定直接 markdown 输出。我们再加一道兜底:让模型在 `\`\`\`ui` fenced block 里写 JSON,bridge 用正则把 fenced block 抽出来转 blocks。后来发现模型会用 `\`\`\`json` 或者裸 `\`\`\`` —— 把解析器改成**所有 fence 都试一遍**,第一个 body 能 parse 成 blocks 数组的就用。

### 流式 UX 修复

走兜底路径时,JSON 会一个字一个字流到 UI 里非常难看。修法:

- agent item 多一个隐藏字段 `_rawText` 存原始累积流
- `it.text` 实时通过 `displayDuringStream(raw)` 计算 —— 检测到任何 ` ``` ` 开启就替换成 `🎴 rendering cards…`
- turn 结束 `watchExit` 才从 `_rawText` 抽 blocks,把 agent item 替换/拆分成 `[agent(before), blocks, agent(after)]`

reply-tool 路径不受这个影响 —— input 通过 `input_json_delta` 流,bridge 完全不暴露给前端,用户根本看不到任何中间形态。

### 优点

- ✅ **没有"卡住"状态**:子进程退出 = turn 完成,任何错误都最多影响一个 turn,下一个 turn fork 全新进程
- ✅ **资源开销低**:idle 时零进程,只有 bridge daemon
- ✅ **代码量小**:单文件 ~700 行,自包含
- ✅ **跟 channel mode 共享 generative UI 路径**(通过 stub 模式的 MCP)
- ✅ **重启友好**:本来就是无状态的,bridge 重启不影响"正在跑的 turn"概念 —— 没有"正在跑"
- ✅ **UX 实验载体**:跟 channel mode 完全独立、可同时跑,直接对比手机交互手感

### 缺点 / 坑

- ❌ **每个 turn 1-2 秒 spawn 开销**(claude binary 启动 + tool 列表加载)
- ❌ **不能 tmux attach**:无持久进程,desktop 用户也没法接管
- ❌ **markdown 兜底脆弱**:模型不是每次都听话用 reply 工具 —— 我们靠 system prompt + 多 fence 容错来兜底,实测命中率 ~80%
- ❌ **slash commands 仍然不行**(print mode 同样问题)

### 何时用

实验性轻量方案,适合"一问一答"型 use case(找餐馆、查文档、问问题);**不适合长任务、写代码、多步调试**(那些场景应该走 channel mode)。

---

## 6. 三种方式横向对比

| 维度 | A: Print | B: Channel | C: Oneshot |
|---|---|---|---|
| 进程模型 | 1 长期 / thread | 1 长期 tmux / thread + MCP child | 1 fork / turn |
| 输入路径 | stdin NDJSON | tmux send-keys | argv 位置参数 |
| 输出路径 | stdout NDJSON | MCP `reply` tool + hooks | stdout NDJSON |
| `/rc` 兼容 | ✅(独立) | ✅(独立) | ✅(独立,但每 turn 重新生效) |
| `/usage` 等 slash commands | ❌ | ✅(tmux 内) | ❌ |
| tmux attach 接管 | ❌(无 PTY) | ✅ | ❌ |
| 工具调用可见 | ✅ stream-json | ✅ hooks | ✅ stream-json |
| `AskUserQuestion` 等 TUI 弹框 | 卡死 | hijack 到 reply | 同 channel(stub 也走 hijack hook 时) |
| 历史持久化 | JSONL hydration | JSONL hydration | JSONL hydration |
| 多机同步 | ✅(同 bridge) | ✅(同 bridge) | ✅(同 bridge) |
| 工程复杂度 | 中 | **高** | 低 |
| 启动延迟 | 一次(spawn 时) | 一次(spawn 时) | **每 turn 都有** |
| 内存占用 idle | 1 个 claude 进程 / thread | 1 tmux + 1 claude / thread | 0 |
| 适合长任务 | ✅ | ✅✅ | ❌ |
| 适合一问一答 | ✅ | ✅ | ✅✅ |

最终我们**三种都保留**了,在不同端口同时跑,用于:
- **9897 (channel)** — 日常驱动写代码,主线
- **9898 (oneshot)** — 一问一答场景实验、性能对比
- **9896 (print)** — 历史基线,基本不动

---

## 7. 关键坑 / 教训

时间顺序记录,踩了就长记性的那些:

### `--print` 静默忽略 `--dangerously-load-development-channels`
最初想"print mode + Channels"一招通吃,失败。flag 只在 interactive TUI 模式生效。这一个发现把我们从 A 推到 B。

### `meta` 字段必须 stringify
MCP 通道的 `notifications/claude/channel` 接受一个 `meta: Record<string, string>` —— **必须全是字符串**。我们最初传了一个 `push_n: 0`(number),Zod 校验失败,整个 MCP transport 被 close,channel 链路死透。解决:`stringifyMeta` 帮 numbers / booleans / Dates 全转字符串。

### MCP server 必须用 user scope,不能用 `--mcp-config`
`--mcp-config <file>` 启动时 claude 会弹"是否信任这个 MCP server"对话框,手机上无法应答。改用 `claude mcp add ... -s user` 写入 `~/.claude.json` 后 claude 直接信任,跳过对话框。

### `--session-id` 和 `--resume` 不能一起传
"can only be used with --continue or --resume if --fork-session is also specified"。首次创建 thread 用 `--session-id`,后续 turn 用 `--resume`。

### `--print stream-json` 需要 `--verbose`
不加这个 flag,event stream 是简化版,我们解析不出 tool_use / tool_result。

### channel push 在 welcome 屏幕被丢弃
push 进了 `notifications/claude/channel` 队列,但 claude 没进 chat mode 不 flush。改成 send-keys。

### bridge 重启 = tmux orphan
旧 tmux session 还在,新 bridge 不知道,直接 `tmux new-session` 失败"duplicate session"。修法:bridge 启动时按 `claude-rc-ch-*<instance suffix>` 前缀强杀所有 orphan。

### MCP socket 半开 → 第二条消息卡住
bridge 把 user prompt 缓存为 `pendingPush`,等 `cp.isConnected(threadId)` 才 inject。问题是 claude 偶尔让 MCP child 的 TCP socket 进入 half-open,bridge 仍以为"未连接"。修法:完全不依赖 `cp.isConnected` 判断输入路径 —— send-keys 跟 MCP socket 独立,只要 tmux 在就直接发。

### 跨重启历史:不要自己存,用 claude 的 JSONL
最初我们想把 ChatItem 自己 dump 到 disk,后来发现 claude 自己已经把更完整的 transcript 写到 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` 了 —— 直接读就行。**省得我们维护一份冗余、可能跟 claude 状态漂移的存储。**

### 老 thread 的 sessionId 跟我们 threadId 对不上
还没 pin `--session-id` 之前创建的 thread,claude 自动生成了 UUID。修法:一次性 migration 扫所有 JSONL,按 `(cwd, first user prompt prefix)` 匹配回 thread,把发现的 sessionId 写回 thread 摘要。

### Anthropic tool input_schema 拒绝顶层 `oneOf` / `allOf` / `anyOf`
我们在 review 修复里给 `reply` 工具加了 `anyOf: [{required:["text"]}, {required:["blocks"]}]`。Anthropic 验证器直接拒绝:

```
API Error: 400 tools.26.custom.input_schema:
input_schema does not support oneOf, allOf, or anyOf at the top level
```

所有 turn 都挂。改成 schema 不约束 + 运行时 handler 校验返回 `isError: true`,claude 收到错误自己重试。

### `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 会破坏 `/rc`
跟我们这个项目没直接关系但是一直在隔壁踩 —— 这个 env var 关掉 GrowthBook 抓取,而 `tengu_ccr_bridge` gate 依赖它判定,最终 `/rc` 静默禁用。**别在跑 claude-rc 的进程环境里设这个变量。**

### `--include-partial-messages` 才有 `input_json_delta`
不加这个,tool 的 input 是一次性到达,没法流式渲染"正在打字"。加上就能从 partial JSON 逐步 reconstruct。

### tmux send-keys 多行
直接 `-l` 模式塞包含 `\n` 的字符串,claude 会把 Enter 当回车键提交。要插入实际多行,按行 split,每行之间 `S-Enter`(shift-enter)。

---

## 8. Generative UI(模型驱动卡片)— 附加章节

> 这一章是 UI 驱动,**不是 remote control 实现的一部分**,但 claude-rc 大部分价值兑现在这上面 —— 手机屏小,文字密度低,卡片化大幅提升体验。

### 想法

模型自己决定 UI 形状。同一个 `reply` 工具接受两种参数:

```ts
reply({ text: "markdown..." })                  // 普通文字气泡
reply({ blocks: [{type:"card", title:"..."}] })  // 一组 React 组件
```

`blocks` 是 typed union,前端有对应组件:

| type | 渲染成 |
|---|---|
| `text` | markdown 段落 |
| `card` | 单卡片(image/title/subtitle/rating/badges/meta/actions) |
| `cards_row` | 横向滚动卡片列表 |
| `map` | OSM iframe 嵌入(免 API key) |
| `stats` | 指标 tile 网格(支持 good/bad/neutral 色调) |
| `actions` | 按钮组 — 点击 = 自动作为下一条 user 消息发 |
| `code` | 代码块(暂无 syntax highlight) |

### 关键设计

1. **Schema 嵌在 MCP 工具 description 里**:claude 列工具的时候自己看 schema 决定字段
2. **System prompt 提示用例**:"recommend places → cards_row","ask user to pick → actions" 之类
3. **`actions` 取代 `AskUserQuestion`**:点按钮 = 发 user 消息,关闭交互回路,完全在网页里搞定
4. **图片必须真实**:system prompt 要求"用 WebSearch / WebFetch 得到的 URL,不要编造"。前端 `referrerPolicy="no-referrer"` 避免泄漏 token-bearing URL
5. **OSM iframe 加 sandbox**:`sandbox="allow-scripts allow-same-origin allow-popups"` + `referrerPolicy="no-referrer"`
6. **Lat/lng/zoom 防御性 clamp**:模型瞎填 999 度也不会爆 bbox

### Channel mode 路径

claude 直接调 `mcp__claude-rc-channel__reply({blocks: [...]})`,MCP 工具校验 schema(strict),通过 control plane 发到 bridge,bridge 建一个 `ChatItem` (`kind:"blocks"`) 推到前端。前端 lazy-load `BlocksView` 渲染。

### Oneshot mode 路径

`channel-mcp.ts` 在 stub 模式跑(没 control plane),只暴露工具 schema。claude 调 reply 工具,bridge 从 stream-json `tool_use` 事件直接抽 `input.blocks` —— 不走 socket。

**Fallback**:模型偶尔不用 reply 工具,直接 markdown 输出 fenced JSON。bridge 的 `extractUiBlocks` 容忍 ` ```ui ` / ` ```json ` / 裸 ` ``` ` 任何 fence,只要 body 能 parse 出有 `type` 字段的对象就成 blocks。

### 流式 UX

走 reply 工具路径:`input_json_delta` 完全不暴露给前端,只有 `content_block_stop` 时一次性 emit blocks。用户看不到任何中间 JSON。

走 markdown 兜底路径:agent item 隐藏 `_rawText`,展示 `it.text` 是经 `displayDuringStream()` 替换过的版本 —— 任何 ` ``` ` 开启都替换成 `🎴 rendering cards…`,turn 结束才换成真卡片。

### 评价

- ✅ 视觉密度大幅提升,手机屏更适合卡片
- ✅ 完全模型驱动 —— 我们没写"日本旅游用什么 UI",模型 zero-shot 推
- ✅ `actions` 闭环替代了所有 TUI 选择器问题
- ⚠️ 模型有时候会过度卡片化(简单事实问题也整一堆卡片),靠 prompt 校准
- ⚠️ 图片来源依赖模型主动 WebSearch,有时候得明确要求"用真实图片"

---

## 9. 仓库地图(供后续维护者)

```
claude-rc/
├── server/
│   ├── index.ts                # 入口:按 CLAUDE_RC_MODE 派发
│   ├── session.ts              # mode=print 实现
│   ├── channel-session.ts      # mode=channel state hub
│   ├── oneshot-session.ts      # mode=oneshot state hub
│   ├── control-plane.ts        # TCP localhost server,bridge ↔ MCP child
│   └── claude/
│       ├── process.ts          # print mode 的 ClaudeProcess wrapper
│       ├── channel-process.ts  # channel mode 的 tmux + claude 启动
│       ├── channel-mcp.ts      # 我们自己的 MCP server(reply 工具)
│       └── hook-emit.ts        # PreToolUse / PostToolUse / UserPromptSubmit 钩子
├── web/
│   └── src/
│       ├── components/
│       │   └── Blocks.tsx      # 卡片渲染
│       └── routes/
│           ├── Chat.tsx
│           └── ChatList.tsx
├── shared/
│   └── protocol.ts             # ClientMsg / ServerMsg / ChatItem / Block
└── docs/
    └── remote-control.md       # ← 本文
```

启动:
```
bun run start         # print mode, port 9896
bun run start:ch      # channel mode, port 9897
bun run start:os      # oneshot mode, port 9898
```

每个 mode 独立 token,在 `~/.arche/claude-rc-<mode>.token`。

---

## 10. 还没解决 / 待办

- 一些偶发 TUI 弹框我们没拦(比如 reauth、long-press notification)—— 当前的 hijack 是 hook 级的,如果将来 Claude Code 加新弹框,需要补
- channel mode 的 MCP child socket half-open 现在靠"不依赖 isConnected"绕过,治本应该用 TCP keepalive
- generative UI 远程图片直接渲染会泄漏 IP/User-Agent。生产化前要加 server-side image proxy
- oneshot 启动延迟 1-2 秒,有用户感知;可以用 claude 的 `--continue` 加预热进程池缓解
- print mode 长期处于半弃状态,如果不再用应当删掉以减少维护面

---

*文档由 Claude Opus 4.7 协助整理,2026-05*
