# dsh-toolcall-guard

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的一个插件：**当模型把工具调用当成正文文本吐出来时**，
把这次坏掉的尝试改写成可重试的失败，让 DSH 自动重跑这一步，而不是把满屏的 XML 标签甩给用户。

```
没装守卫                                  装了守卫
────────────────────────────────────      ────────────────────────────────────
assistant: 好的！<tool_call>{"name":       assistant: 好的，本喵查一下。
          "ops_bash","arguments":          （工具正常执行）
          {"command":"ls"}}</tool_call>
                                          ↑ 那次坏掉的尝试被重试掉了，
（用户看到满屏标签，工具根本没执行）        从没到过界面
```

## 问题是什么

DSH 只执行以**结构化内容块**形式到达的工具调用（`message.content[].type === "tool-call"`）。
有些走中转站 / 代理端点（任何 OpenAI 兼容的 `chat/completions` 协议）的模型，偶尔会跳过这条通道，
把调用直接写进 assistant 正文里：

```
<tool_call>{"id":"call_x","name":"ops_bash","arguments":{"command":"pwd"}}</tool_call>
```

后果有三个：

- 这段标签**不会被执行** —— DSH 根本没看到 `tool-call` 块；
- 这段标签**原样显示给用户** —— 看起来像客户端坏了；
- 这一轮**完全浪费** —— 在会话日志里它以 `step/end → turn/end` 结束，中间没有任何 `tool/call` 事件。

DSH 本身（有意地）没有任何文本标签解析器。本插件补上这道守卫，且**不改动任何上游文件**。

## 原理

插件挂在 `llm/stream` 这个 waterfall 接缝上（每一次流式模型调用的外层），把 chunk 流包一层：

1. 累积这条回复的 `text-delta` 文本；
2. 累积文本命中「工具调用被写成文本」的特征时，把这条响应的 `finish` 改写成 `EMPTY_RESPONSE` 失败；
3. DSH 自带的 `dsh-llm-retry` 看到 `EMPTY_RESPONSE` 在 provider 的 `retryableCodes` 里，就自动重跑本步骤。
   因为这次尝试是以 `error` 结束的，它的文本**不会被提交进会话**，所以那些原始标签永远到不了屏幕。

为什么用 `EMPTY_RESPONSE`：它是 DSH 内置的、跨 provider 中立的失败码，官方语义正是
「正常结束但没有任何可用内容块」—— 而这正是一轮「工具调用写成文本」的实质。
换成自定义码就会掉出 `retryableCodes`，`dsh-llm-retry` 直接放行，等于没做。

## 检测刻意做得很严

一次误判就会扔掉一条本来完好的回复，所以只有同时满足才判定：

- 标签（`<tool_call>`、`<tool_calls>`、`<|tool_call|>`、`[TOOL_CALL]` 等）**后面必须跟 JSON 负载**（`{`、`[` 或 `"`）；
- 裸 `{"tool_call": …}` 键**后面必须出现 `"name"` 字段**；
- 本回合**没有任何真实结构化工具调用** —— 如果模型一边解释 `tool_call` 一边又真的发起了调用，这一轮不动。

匹配前会先剥掉标签名与尖括号之间的零宽字符（U+200B/200C/200D/FEFF），因为真实踩坑里就是这形态。

所以像「模型吐出了一个 `tool_call` 标签」这种正常行文**不会**被命中。

## 安装

前提：DSH 带 `llm-pi-ai` provider 与 `llm-retry` 执行器（标准桌面版都自带）。

### 方式 A —— clone 到插件目录再 link（推荐）

```bash
git clone https://github.com/caly250/dsh-toolcall-guard.git ~/dsh-plugins/dsh-toolcall-guard
```

在 profile 的 `package.json` 里加上（`<profile>` 在默认安装下是 `~/.dsh/profiles/desktop`）：

```jsonc
{
  "dependencies": {
    "dsh-toolcall-guard": "link:/绝对路径/dsh-toolcall-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        /* … 原有 bundles … */
        "dsh-toolcall-guard"
      ]
    }
  }
}
```

然后安装链接并重载 DSH：

```bash
cd <profile> && pnpm install
```

重启 DSH 应用（或触发一次 profile 重载）。DSH 会把 `dsh-toolcall-guard` 当 bundle 加载，
并应用它的 `cordis.patch.yml`（插入 `toolcall-guard` 行）。

### 方式 B —— 把行写进 profile 的 patch（模块必须已能被解析到）

`cordis.patch.yml` 里的行是**按模块名引用插件**的，所以这种方式的前提是
`dsh-toolcall-guard` 已经能从 profile 的 `node_modules` 里解析到（例如先 `pnpm add`，
或按方式 A link 好）。解析不到就用方式 A。

把下面这段追加到 `<profile>/cordis.patch.yml` 并保存（DSH 的 `patchReload: live` 会热加载，无需重启）：

```yaml
- insert:
    - id: toolcall-guard
      name: dsh-toolcall-guard
      config:
        enabled: true
        providerPattern: ''
        modelPattern: ''
        targetCode: EMPTY_RESPONSE
        maxScanChars: 200000
        rewriteWhenRealToolCallsPresent: false
        logOnly: false
        verbose: true
```

注意：**同一个 `id` 不要既写在 bundle 里又写在 patch 里** —— 会被插两次。

### 方式 C —— npm

这个包目前**还没发布到 npm**。如果你想发布自己的 fork：

```bash
npm publish   # 在仓库根目录，先 npm login
```

…然后在 `<profile>` 里 `pnpm add dsh-toolcall-guard`，并按方式 A 加进 `dsh.profile.bundles`。

## 验证是否真的在跑

在 DSH 里列出插件，看到这一行就是成功了：

```
entryId: include:toolcall-guard    moduleName: dsh-toolcall-guard
enabled: true                      fiberPhase: active
```

如果你有 Cordis 检视工具，`listConfigs` 里也能看到 `include:toolcall-guard`。
（那里显示 `status: absent` 是正常的 —— 本插件没有用户可见的 Config schema，完全由 patch 配置。）

## 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `providerPattern` | `''` | provider 名的子串（忽略大小写）；空 = 全部 |
| `modelPattern` | `''` | model 名的子串；空 = 全部 |
| `targetCode` | `'EMPTY_RESPONSE'` | 要抛出的失败码，必须是可重试的 dsh-llm 码 |
| `maxScanChars` | `200000` | 累积超过这么多字符后放弃检测（0 = 不限） |
| `rewriteWhenRealToolCallsPresent` | `false` | 已有真实调用的回合是否也改写 |
| `logOnly` | `false` | 只记日志，不改写 |
| `verbose` | `true` | 每次命中/放行都打日志 |

想先观察几天：把 `logOnly` 设为 `true`，它就只记录「本来会改写什么」，不改任何响应。

## Token 成本

守卫本身是**零 token** —— 它只是对已流出的 chunk 做本地字符串扫描，不往 prompt 里加一个字，
也不加任何 context。只有真正翻车的回合才会触发重试，而那种回合本来就产不出可用结果，
所以重试是「替换浪费」，不是「增加成本」。

## 局限

- 它只能**丢弃并重试**坏掉的一轮，不能**修复**它。如果某个上游模型每次都这样，重试会耗尽，
  本步最终失败 —— 这种情况要修模型或换路由。
- 重试次数取决于 provider 的 `retryPolicy`。如果该策略没把 `EMPTY_RESPONSE` 列为可重试，
  改写会以普通 `EMPTY_RESPONSE` 错误结束，而不是重试。
- 检测是启发式的，覆盖常见标签写法；罕见方言可能漏过。用 `logOnly: true` + `verbose: true`
  去发现漏掉的形态。

## 开发

```bash
npm test        # node:test，20 个用例，零依赖
```

## 许可证

MIT © 2026 caly250
