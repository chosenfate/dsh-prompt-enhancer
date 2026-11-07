/**
 * Rewrite a composer draft in place, before it is sent.
 *
 * POST /api/prompt-enhancer/enhance  returns the rewritten text for the
 *                                 composer button (conversation.input.right).
 * GET  /api/prompt-enhancer/config   returns the effective config, the
 *                                 built-in defaults, and the model that
 *                                 would be used right now.
 * POST /api/prompt-enhancer/config   validates and persists a config patch
 *                                 through the profile's config editor.
 *
 * The rewrite is one short LLM call through the session's default model
 * (or the model named in config). The composer button owns the UX: it
 * replaces the draft and keeps the original for one-click restore, and no
 * failure path ever writes a partial result over the user's text.
 */

const name = 'prompt-enhancer'

// `sessionQuery` is deliberately absent: the context feature degrades to
// "no context" when the service is missing, so a profile without it can still
// activate this plugin.
const inject = ['llm', 'agentDefaultModel', 'webServer', 'configEditor']

const ENHANCE_PATH = '/api/prompt-enhancer/enhance'
const CONFIG_PATH = '/api/prompt-enhancer/config'

/** Bodies above this size are refused before JSON parsing. */
const MAX_BODY_BYTES = 64 * 1024

/** Per-message and total caps for optional conversation context. */
const CONTEXT_MESSAGE_CHARS = 600
const CONTEXT_TOTAL_CHARS = 2400

/** Built-in defaults; the patch row carries the same values so users can edit them in cordis.patch.yml. */
const DEFAULTS = {
  enabled: true,
  model: '',
  temperature: 0.2,
  // A reasoning model spends the same budget on its hidden chain of thought
  // before any visible text exists, so 800 starved the answer into emptiness
  // on step-5-preview. 4096 leaves room for both.
  maxTokens: 4096,
  timeoutMs: 30000,
  // 0 = off. 1..10 = attach the last N user/assistant messages as context.
  contextTurns: 0,
  systemPrompt: `你是提示词润色助手。你把用户的草稿轻度改写成更清晰、更可执行的提示词——像帮朋友把意思说明白，而不是替他写一份规格文档。

铁律：
1. 保守第一：尽量保留用户的原句、用词和语气，只做必要的澄清与补全。
2. 长度克制：增强后的提示词通常不超过原文长度的 2 倍；原文很短时，输出也必须很短——十几个字的草稿，改写成一两句话即可。绝不把短草稿膨胀成结构化规格。
3. 不编造：不添加用户没有提过的具体信息——不指定技术栈、不编造数字、不补充需求清单、不添加验收标准。只澄清用户已经表达的意思。
4. 语言保持：用户用什么语言就用什么语言输出（中文进中文出，英文进英文出，混排保持混排），不得在输出中添加任何语言分析或标签。
5. 只输出增强后的提示词本身：不要解释、开场白、markdown 围栏、标签或包裹引号。
6. 不代答：用户是在提请求，不是让你回答；只改写请求本身。
7. 如果原文已经清晰，只做最小改动的润色，不要为了改而改。

示例（注意输出与输入的长度比例）：
用户输入：帮我写个登录页
增强后：帮我写一个登录页，说明技术栈和要实现的功能。

用户输入：把这个 bug 修一下
增强后：帮我修复这个 bug，先分析原因再给出修改。

用户输入：帮我把周报写了，这周做了登录模块和支付联调
增强后：帮我把本周周报写了，本周完成了登录模块开发和支付渠道联调，请分条概括进展、问题与下周计划。`,
}

/** User wrapper; `{input}` is the draft being enhanced, `{context}` the optional recent conversation. */
const USER_TEMPLATE = `{context}USER INPUT:
{input}

TASK: Lightly rewrite the user input above into a clearer, more actionable prompt, following the rules in your instructions. Stay close to the original wording and length — never expand a short draft into a specification. Reply with the enhanced prompt only. Match the input language exactly. Do not answer the request; rewrite it.`

/** Optional context block, placed ahead of the draft so the model reads it first. */
const CONTEXT_TEMPLATE = `RECENT CONVERSATION (context only — never repeat, summarize, or mention it in your output):
{context}

`

/** Clamp a number into range, falling back to the default for junk. */
function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Merge a raw row config over the defaults; never trust the file's shape. */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const timeoutMs = Math.round(clampNumber(source.timeoutMs, DEFAULTS.timeoutMs, 1000, 120000))
  return {
    // Only a literal true (or an absent field) enables; anything else a hand
    // edited file might contain — "no", 0, "false" — reads as off.
    enabled: source.enabled === undefined ? true : source.enabled === true,
    model: typeof source.model === 'string' ? source.model.trim() : '',
    temperature: clampNumber(source.temperature, DEFAULTS.temperature, 0, 2),
    maxTokens: Math.round(clampNumber(source.maxTokens, DEFAULTS.maxTokens, 1, 8192)),
    timeoutMs,
    contextTurns: Math.round(clampNumber(source.contextTurns, DEFAULTS.contextTurns, 0, 10)),
    systemPrompt: typeof source.systemPrompt === 'string' && source.systemPrompt.trim() !== ''
      ? source.systemPrompt
      : DEFAULTS.systemPrompt,
  }
}

/** `provider/model` or null. */
function parseModelSpec(spec) {
  if (typeof spec !== 'string') return null
  const at = spec.indexOf('/')
  if (at <= 0 || at === spec.length - 1) return null
  const provider = spec.slice(0, at)
  const model = spec.slice(at + 1)
  if (/\s/.test(provider) || /\s/.test(model)) return null
  return { provider, model }
}

/**
 * Visible text of one message's content blocks. Only `text` blocks carry
 * prompt text; reasoning, image, file, and tool blocks are not context a
 * rewrite should see.
 */
function contentText(blocks) {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * 'user' | 'assistant' | null.
 *
 * `readSurface` returns `SurfaceEvent[]`, a closed union keyed by `type`
 * (`SessionEventMap`): `user/message` data is the `UserMessage` itself, every
 * other variant wraps its message in `data.message`. System prompts, developer
 * context, and tool results are not conversation context, so only the two chat
 * roles survive.
 */
function eventRole(event) {
  if (event.type === 'user/message') return 'user'
  if (event.type === 'assistant/message') return 'assistant'
  return null
}

/** The message a surface event carries, or null for the non-chat variants. */
function eventMessage(event) {
  return event.type === 'user/message' ? event.data : event.data.message
}

/**
 * The last `turns` user/assistant messages from a session surface, oldest
 * first, each message and the total capped so a long reply cannot eat the
 * rewrite budget. An unreadable surface yields no context rather than an
 * error, and the rewrite proceeds without it.
 */
function extractRecentMessages(events, turns) {
  if (!Array.isArray(events) || turns <= 0) return []
  const picked = []
  for (let i = events.length - 1; i >= 0 && picked.length < turns * 2; i -= 1) {
    const event = events[i]
    const role = eventRole(event)
    if (role === null) continue
    const text = contentText(eventMessage(event).content)
      .trim()
      .slice(0, CONTEXT_MESSAGE_CHARS)
    if (text === '') continue
    picked.unshift({ role, text })
  }
  let total = 0
  const capped = []
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const message = picked[i]
    if (total + message.text.length > CONTEXT_TOTAL_CHARS) break
    total += message.text.length
    capped.unshift(message)
  }
  return capped
}

/** Read recent context for one session; any failure means "no context". */
async function readRecentContext(ctx, sessionId, turns) {
  if (turns <= 0 || typeof sessionId !== 'string' || sessionId === '') return []
  const query = ctx.get('sessionQuery') ?? ctx.sessionQuery
  if (query === undefined || typeof query.readSurface !== 'function') return []
  try {
    const surface = await query.readSurface(sessionId)
    return extractRecentMessages(surface?.events, turns)
  } catch {
    return []
  }
}

/** Render the context block; the labels are instructions to the model, not output. */
function renderContext(messages) {
  if (messages.length === 0) return ''
  const body = messages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`)
    .join('\n\n')
  return CONTEXT_TEMPLATE.replace('{context}', body)
}

/** The model an enhancement call would use right now, and where it came from. */
function effectiveSelection(ctx, resolved) {
  const own = parseModelSpec(resolved.model)
  if (own !== null) return { ...own, source: 'config' }
  const selection = ctx.agentDefaultModel.currentSelection()
  if (selection?.provider && selection?.model) {
    return { provider: selection.provider, model: selection.model, source: 'default' }
  }
  return null
}

/** Strip wrapping quotes before writing the result back. */
function stripWrappingQuotes(text) {
  return text.trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '')
}

/**
 * Some models emit the finished prompt twice, back to back. Keep one copy
 * when the two halves are the same paragraph.
 */
function collapseDuplicatedParagraph(text) {
  const trimmed = text.trim()
  const compact = trimmed.replace(/\s+/g, '')
  if (compact.length < 40 || compact.length % 2 !== 0) return trimmed
  const half = compact.length / 2
  if (compact.slice(0, half) !== compact.slice(half)) return trimmed
  const end = trimmed.indexOf(compact[half - 1], half - 1)
  const first = trimmed.slice(0, end + 1).trim()
  return first.replace(/\s+/g, '') === compact.slice(0, half) ? first : trimmed
}

/**
 * Collect visible text from one completion. `block-end` carries the assembled
 * block, so deltas are only a fallback when that block never arrives. The
 * chunk kinds come back too: an empty result is only diagnosable when the
 * caller can see what the stream actually carried.
 */
async function collectText(stream) {
  let text = ''
  let sawBlock = false
  const kinds = new Set()
  for await (const chunk of stream) {
    kinds.add(chunk.block?.type === undefined ? chunk.type : `${chunk.type}:${chunk.block.type}`)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      text += chunk.block.text ?? ''
      sawBlock = true
    } else if (!sawBlock && chunk.type === 'text-delta') {
      text += chunk.text ?? ''
    } else if (chunk.type === 'finish' && (chunk.reason === 'error' || chunk.reason === 'aborted')) {
      throw new Error(chunk.reason === 'aborted' ? '已取消' : '模型调用失败')
    }
  }
  return { text: collapseDuplicatedParagraph(stripWrappingQuotes(text)), kinds: [...kinds] }
}

/**
 * A rewrite is a short text task. A high reasoning effort makes it wait
 * through a long hidden chain of thought, so use the cheapest effort the
 * selected model actually offers.
 */
async function fastestEffort(ctx, selection, signal) {
  try {
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
    const efforts = info?.reasoning?.efforts ?? []
    const rank = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }
    return efforts.reduce((best, effort) => {
      const id = String(effort?.id ?? '')
      if (!(id in rank)) return best
      return best === undefined || rank[id] < rank[best] ? id : best
    }, undefined)
  } catch {
    return undefined
  }
}

/** One enhancement call. Returns { ok, text, contextMessages } or { ok: false, error, status }. */
async function executeEnhance(ctx, resolved, input, signal, sessionId) {
  const selection = effectiveSelection(ctx, resolved)
  if (selection === null) {
    return {
      ok: false,
      status: 503,
      error: '没有可用的模型。先在设置里选一个默认模型，或在插件设置里指定模型。',
    }
  }
  try {
    const context = await readRecentContext(ctx, sessionId, resolved.contextTurns)
    const reasoningEffort = await fastestEffort(ctx, selection, signal)
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: resolved.systemPrompt,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: USER_TEMPLATE
            .replace('{context}', renderContext(context))
            .replace('{input}', input),
        }],
      }],
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      signal,
    })
    const collected = await collectText(stream)
    const enhanced = collected.text
    if (enhanced.trim() === '') {
      // Name the model and what the stream carried: an empty completion is
      // usually a provider/key problem or a budget the hidden reasoning ate,
      // and both are only diagnosable with the model id and the chunk kinds.
      const detail = collected.kinds.length === 0 ? '' : `（流内容：${collected.kinds.join(', ')}）`
      return {
        ok: false,
        status: 502,
        error: `模型 ${selection.provider}/${selection.model} 返回了空结果${detail}，草稿没有变化。若该模型带推理能力，请调大 maxTokens——隐藏思考与可见回答共用同一配额。`,
      }
    }
    return { ok: true, text: enhanced, contextMessages: context.length }
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 502, error: `增强失败：${message}` }
  }
}

/**
 * Read a JSON body with a hard byte budget.
 *
 * An oversized request is answered, not dropped: the rest of the stream is
 * discarded so the client can still receive the 413. Destroying the socket
 * instead would surface as a transport error on the other side, which reads
 * like a crashed server rather than a rejected input.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        chunks.length = 0
        reject(new Error('too-large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    req.on('aborted', () => {
      if (settled) return
      settled = true
      reject(new Error('aborted'))
    })
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Validate a settings-page patch; every field is optional, junk is refused. */
function validateConfigPatch(payload) {
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求格式不对' }
  const next = {}
  if ('enabled' in payload) {
    if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是 true 或 false' }
    next.enabled = payload.enabled
  }
  if ('model' in payload) {
    if (typeof payload.model !== 'string') return { ok: false, error: 'model 必须是字符串' }
    const spec = payload.model.trim()
    if (spec !== '' && parseModelSpec(spec) === null) {
      return { ok: false, error: 'model 需要是 "provider/model" 格式，或留空表示跟随默认模型' }
    }
    next.model = spec
  }
  if ('temperature' in payload) {
    const n = Number(payload.temperature)
    if (!Number.isFinite(n) || n < 0 || n > 2) return { ok: false, error: 'temperature 需要在 0 到 2 之间' }
    next.temperature = n
  }
  if ('maxTokens' in payload) {
    const n = Number(payload.maxTokens)
    if (!Number.isInteger(n) || n < 1 || n > 8192) return { ok: false, error: 'maxTokens 需要在 1 到 8192 之间的整数' }
    next.maxTokens = n
  }
  if ('timeoutMs' in payload) {
    const n = Number(payload.timeoutMs)
    if (!Number.isInteger(n) || n < 1000 || n > 120000) return { ok: false, error: 'timeoutMs 需要在 1000 到 120000 之间的整数' }
    next.timeoutMs = n
  }
  if ('contextTurns' in payload) {
    const n = Number(payload.contextTurns)
    if (!Number.isInteger(n) || n < 0 || n > 10) return { ok: false, error: 'contextTurns 需要在 0 到 10 之间的整数（0 = 不附带上下文）' }
    next.contextTurns = n
  }
  if ('systemPrompt' in payload) {
    if (typeof payload.systemPrompt !== 'string' || payload.systemPrompt.trim() === '') {
      return { ok: false, error: 'systemPrompt 不能为空' }
    }
    if (payload.systemPrompt.length > 20000) return { ok: false, error: 'systemPrompt 不能超过 20000 个字符' }
    next.systemPrompt = payload.systemPrompt
  }
  if (Object.keys(next).length === 0) return { ok: false, error: '没有需要保存的配置项' }
  return { ok: true, value: next }
}

/** Persist a config patch through the profile's config editor. */
async function saveConfig(ctx, patch) {
  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor') ?? ctx.configEditor
  if (entry === undefined || editor === undefined) {
    return { ok: false, error: '当前 profile 不支持在应用内保存配置，请手动编辑 cordis.patch.yml 里的 config' }
  }
  try {
    await editor.edit(entry, (current) => ({
      ...(current !== null && typeof current === 'object' ? current : {}),
      ...patch,
    }))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function apply(ctx, config) {
  const resolved = normalizeConfig(config)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ENHANCE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只接受 POST' })
        return
      }
      if (!resolved.enabled) {
        sendJson(res, 403, { error: '提示词增强当前已停用，可在插件设置里开启。' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        if (error instanceof Error && error.message === 'too-large') {
          sendJson(res, 413, { error: '提示词太长（上限 64 KB），先精简再增强' })
          return
        }
        sendJson(res, 400, { error: '请求格式不对' })
        return
      }
      const input = typeof payload?.input === 'string' ? payload.input.trim() : ''
      if (input.length === 0) {
        sendJson(res, 400, { error: '先输入内容，再增强提示词' })
        return
      }
      // The composer button sends the session it is composing in; without it
      // the context feature has nothing to read and stays off.
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const outcome = await executeEnhance(ctx, resolved, input, AbortSignal.timeout(resolved.timeoutMs), sessionId)
      if (!outcome.ok) {
        sendJson(res, outcome.status ?? 502, { error: outcome.error })
        return
      }
      sendJson(res, 200, { text: outcome.text, contextMessages: outcome.contextMessages })
    },
  }), 'prompt-enhancer enhance route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          config: resolved,
          defaults: DEFAULTS,
          effectiveModel: effectiveSelection(ctx, resolved),
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只接受 GET 或 POST' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        if (error instanceof Error && error.message === 'too-large') {
          sendJson(res, 413, { error: '请求体太大' })
          return
        }
        sendJson(res, 400, { error: '请求格式不对' })
        return
      }
      const checked = validateConfigPatch(payload)
      if (!checked.ok) {
        sendJson(res, 400, { error: checked.error })
        return
      }
      const saved = await saveConfig(ctx, checked.value)
      if (!saved.ok) {
        sendJson(res, 502, { error: saved.error })
        return
      }
      sendJson(res, 200, { ok: true, saved: checked.value })
    },
  }), 'prompt-enhancer config route')
}

export { apply, inject, name }
