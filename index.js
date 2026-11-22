// ============================================================================
// dsh-toolcall-guard — 拦截「模型把工具调用当正文文本吐出来」的翻车
// ============================================================================
// 背景（真实踩坑）：
//   走中转站 / 自建代理（openai-completions 兼容层）的模型，偶发不在 API 层
//   给出结构化 tool_calls，而是把调用整段写进 assistant 正文，形如：
//       <tool_call>{"id":"call_x","name":"ops_bash","arguments":{...}}</tool_call>
//   DSH 只认 message.content 里 type === "tool-call" 的结构化块，所以这段
//   文本既不会被执行，又会原样漏到聊天界面上——满屏标签，用户体验是灾难。
//
//   用会话日志确认过：这类翻车回合在日志里紧跟 step/end → turn/end，中间
//   没有任何 tool/call 事件。也就是说 DSH 从未执行过它们，这一整轮是纯浪费。
//
// 做法（只在运行时包一层，不改任何上游文件）：
//   1. 挂在 llm/stream waterfall 上，包裹模型流，累积 text-delta 文本；
//   2. 累积文本命中「工具调用标签」特征时，把这条响应的 finish 改写为
//      EMPTY_RESPONSE 失败 —— 语义正是「正常结束但没有任何可用内容块」，
//      而它又在内置 retryableCodes 里，可安全重跑；
//   3. dsh-llm-retry 按该 provider 的 retryPolicy 自动重跑本步骤。
//      重跑时 live.finish 是 error，那段畸形文本不会被提交进会话，
//      用户永远看不到它。
//
// 为什么用 EMPTY_RESPONSE 而不是自定义码：
//   自定义码不在 retryableCodes 里，会被 llm-retry 直接放行，等于没做。
//
// 误伤防护（这是本插件最重要的一条）：
//   只有「命中标签」且「本回合没有任何真实结构化 tool-call」时才改写。
//   如果模型一边解释 tool_call 是什么、一边又真的发起了结构化调用，那这轮
//   是完全可用的一轮，绝不能作废。检测规则本身也很严：标签后必须跟 JSON
//   负载，JSON 键后必须有 "name" 字段，普通行文提到 tool_call 不会命中。
//
// 成本：
//   检测是本地字符串扫描，不碰 prompt、不加 context，本身 0 token。
//   只有真正翻车的回合才会触发重试，而那种回合本来就产不出可用结果。
// ============================================================================

const name = 'toolcall-guard'
const inject = []
const PLUGIN = 'dsh-toolcall-guard'

const DEFAULTS = {
  enabled: true,
  // 只对名字匹配的 provider 生效（空 = 全部）。
  // 命中判定基于子串小写匹配，例如 'api' 会匹配 'api' 与 'my-api'。
  providerPattern: '',
  // 只对名字匹配的 model 生效（空 = 全部）
  modelPattern: '',
  // 命中后改写成的失败码。必须是 dsh-llm 内置的 retryableCodes 成员。
  targetCode: 'EMPTY_RESPONSE',
  // 累积文本超过该长度后放弃检测（防御异常长的流，0 = 不限制）
  maxScanChars: 200000,
  // 若本回合同时带了真实结构化工具调用，是否仍然改写。
  // 默认 false：那轮是可用的，不能作废。
  rewriteWhenRealToolCallsPresent: false,
  // 只记日志、不改写（先观察后启用时用）
  logOnly: false,
  verbose: true,
}

// 零宽字符：之前真实踩坑的形态里，标签与尖括号之间夹了 U+200B。
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0xfeff]

function stripZeroWidth(text) {
  let out = ''
  for (const ch of text) {
    if (!ZERO_WIDTH.includes(ch.codePointAt(0))) out += ch
  }
  return out
}

// 标签开头的各种写法（已去零宽、已转小写）
const TAG_FORMS = [
  '<tool_call', '<tool-call', '<toolcall', '<tool_calls', '<toolcalls',
  '<|tool_call', '<|tool-call', '<|toolcall',
]

// 裸 JSON 键的写法
const KEY_FORMS = [
  '"tool_call"', '"tool-call"', '"toolcall"', '"tool_calls"', '"toolcalls"',
]

// 方括号标记
const BRACKET_FORMS = ['[tool_call]', '[toolcall]', '[ tool_call ]', '[ toolcall ]']

// 标签后面必须是 JSON 负载才算数。跳过标签自身的闭合尖括号、空白与竖线，
// 这样 <tool_call>{...}、<tool_call> {...}、<|tool_call|>{...} 都能识别。
function payloadFollows(flat, from) {
  const tail = flat.slice(from, from + 16).replace(/[\s>|]/g, '')
  return tail.startsWith('{') || tail.startsWith('[') || tail.startsWith('"')
}

// 裸 JSON 键后面必须能见到工具名，否则「{"tool_call": {...}} 只是个普通字段」
// 这种正常数据也会被误判。
function namesATool(flat, from) {
  const tail = flat.slice(from, from + 400)
  return tail.includes('"name"') || tail.includes("'name'") || tail.includes('"function"')
}

/**
 * 判断一段文本是不是「模型把工具调用当正文吐了出来」。
 * @param {string} text 累积的 assistant 正文
 * @returns {string|null} 命中的形态片段；未命中返回 null
 */
function detect(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const flat = stripZeroWidth(text).toLowerCase()
  for (const form of TAG_FORMS) {
    const idx = flat.indexOf(form)
    if (idx !== -1 && payloadFollows(flat, idx + form.length)) return form
  }
  for (const form of KEY_FORMS) {
    const idx = flat.indexOf(form)
    if (idx === -1) continue
    const after = flat.slice(idx + form.length, idx + form.length + 4)
    if (!after.includes(':')) continue
    if (namesATool(flat, idx + form.length)) return form
  }
  for (const form of BRACKET_FORMS) {
    if (flat.indexOf(form) !== -1) return form
  }
  return null
}

function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS }
  if (rawConfig && typeof rawConfig === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (rawConfig[key] !== undefined) cfg[key] = rawConfig[key]
    }
  }

  function log(level, msg) {
    try {
      const l = ctx && ctx.logger
      if (l && typeof l[level] === 'function') l[level](msg)
    } catch { /* logger 是尽力而为，不能因为它抛错 */ }
  }

  function patternMatch(pattern, value) {
    if (!pattern) return true
    return String(value || '').toLowerCase().includes(String(pattern).toLowerCase())
  }

  function wrap(upstream, options) {
    let text = ''
    let sawRealToolCall = false
    let truncated = false
    let detected = null

    async function* gen() {
      for await (const chunk of upstream) {
        if (chunk && typeof chunk === 'object') {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            if (detected === null) {
              if (cfg.maxScanChars > 0 && text.length >= cfg.maxScanChars) {
                truncated = true
              } else {
                text += chunk.text
                detected = detect(text)
              }
            }
          }
          if (chunk.type === 'tool-call' || chunk.type === 'tool-call-delta') {
            sawRealToolCall = true
          }
          // 上游已经是错误结束：那是另一条路径，本插件不改写。
          if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            yield chunk
            continue
          }
          if (chunk.type === 'finish' && detected !== null && !truncated) {
            const eligible = cfg.rewriteWhenRealToolCallsPresent || !sawRealToolCall
            if (eligible && !cfg.logOnly) {
              if (cfg.verbose) {
                log('warn', PLUGIN + ': 工具调用被当正文吐出（命中 ' + JSON.stringify(detected)
                  + '），改写为 ' + cfg.targetCode + ' 触发重试（provider=' + String(options.provider)
                  + ', model=' + String(options.model) + ', 已有真实工具调用=' + sawRealToolCall + '）')
              }
              yield {
                ...chunk,
                reason: {
                  kind: 'error',
                  failure: {
                    code: cfg.targetCode,
                    message: 'model emitted a tool call as assistant text instead of a structured tool call'
                      + ' [dsh-toolcall-guard: detected ' + JSON.stringify(detected) + ']',
                  },
                },
              }
              return
            }
            if (cfg.verbose) {
              log('info', PLUGIN + ': 文本里检测到工具调用标签（命中 ' + JSON.stringify(detected)
                + '），但本轮带真实结构化工具调用或处于 logOnly，按原样放行')
            }
          }
        }
        yield chunk
      }
    }
    return gen()
  }

  const off = ctx.on('llm/stream', (options, next) => {
    if (!cfg.enabled) return next()
    if (!options || typeof options !== 'object') return next()
    if (!patternMatch(cfg.providerPattern, options.provider)) return next()
    if (!patternMatch(cfg.modelPattern, options.model)) return next()
    return wrap(next(), options)
  })

  ctx.effect(() => () => {
    try { off() } catch { /* 已经释放过了 */ }
  })
}

export {
  name, inject, apply, PLUGIN, DEFAULTS, detect,
  TAG_FORMS, KEY_FORMS, BRACKET_FORMS,
}
