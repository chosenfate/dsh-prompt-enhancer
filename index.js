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

const inject = ['llm', 'agentDefaultModel', 'webServer', 'configEditor']

const ENHANCE_PATH = '/api/prompt-enhancer/enhance'
const CONFIG_PATH = '/api/prompt-enhancer/config'

/** Bodies above this size are refused before JSON parsing. */
const MAX_BODY_BYTES = 64 * 1024

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
  systemPrompt: `你是提示词工程专家。把用户的草稿改写成更清晰、更具体、更可执行的提示词，保持其原始意图、语言和约束不变。

规则：
1. 语言保持是最高优先级：用户用什么语言就用什么语言输出（中文进中文出，英文进英文出，混排保持混排），不得在输出中添加任何语言分析或标签。
2. 只输出增强后的提示词本身：不要解释、开场白、markdown 围栏、标签或包裹引号。
3. 保留用户原始意图、主题、约束和期望的输出形式；不要代答问题，只改写问题。
4. 做实质性增强：厘清任务、范围、约束和期望输出；原文已清晰时做轻度润色，不要原样返回。
5. 完整而简洁（约 300–600 字），不得以未完成的列表、悬空连词或冒号结尾。
6. 不添加无关要求、未经事实支持的内容或不必要的章节。
7. 增强后的提示词只输出一次，不得重复或追加第二份。

示例：
用户输入：帮我写个登录页
增强后：请实现一个登录页面，包含账号与密码输入、基础格式校验、错误提示以及登录成功后的跳转；未指定技术栈时使用项目现有栈，并说明需要覆盖的失败状态。`,
}

/** User wrapper; `{input}` is the draft being enhanced. */
const USER_TEMPLATE = `USER INPUT:
{input}

TASK: Rewrite the user input above into an enhanced prompt, following the rules in your instructions. Reply with the enhanced prompt only — no explanations, prefaces, quotes, or markdown fences. Match the input language exactly. Do not answer the request; rewrite it.`

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

/** One enhancement call. Returns { ok, text } or { ok: false, error, status }. */
async function executeEnhance(ctx, resolved, input, signal) {
  const selection = effectiveSelection(ctx, resolved)
  if (selection === null) {
    return {
      ok: false,
      status: 503,
      error: '没有可用的模型。先在设置里选一个默认模型，或在插件设置里指定模型。',
    }
  }
  try {
    const reasoningEffort = await fastestEffort(ctx, selection, signal)
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: resolved.systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: USER_TEMPLATE.replace('{input}', input) }] }],
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
    return { ok: true, text: enhanced }
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
      const outcome = await executeEnhance(ctx, resolved, input, AbortSignal.timeout(resolved.timeoutMs))
      if (!outcome.ok) {
        sendJson(res, outcome.status ?? 502, { error: outcome.error })
        return
      }
      sendJson(res, 200, { text: outcome.text })
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
