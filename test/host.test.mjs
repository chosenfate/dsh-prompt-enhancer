/**
 * Host-half tests for index.js.
 *
 * A fake cordis context stands in for llm, agentDefaultModel, webServer,
 * configEditor, the optional sessionQuery service, and effect, so the rewrite
 * pipeline and the config routes can be exercised without a running harness.
 *
 *   node --test test/host.test.mjs
 */

import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const INDEX_URL = pathToFileURL(path.resolve(import.meta.dirname, "../index.js")).href;

const ENHANCE_PATH = "/api/prompt-enhancer/enhance";
const CONFIG_PATH = "/api/prompt-enhancer/config";

/** A stream that emits the given chunks. */
function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

const textChunks = (text) => [
  { type: "block-end", block: { type: "text", text } },
  { type: "finish", reason: "stop" },
];

const BASE_CONFIG = {
  enabled: true,
  model: "",
  temperature: 0.2,
  maxTokens: 4096,
  timeoutMs: 30000,
  contextTurns: 0,
  systemPrompt: "你是提示词工程专家。",
};

// ------------------------------------------------------------ surface fixture
// Shaped like the real contract: `readSurface` resolves a
// `SessionSurfaceSnapshot` whose `events` are `SurfaceEvent`s from the closed
// `SessionEventMap` union — `user/message` carries the `UserMessage` itself as
// `data`, every other variant wraps its message in `data.message`.

const SESSION_HEADER = { version: 1, id: "sess-1", createdAt: 1760000000000, isSeeded: false };

const surfaceEvent = (seq, type, data) => ({ type, seq, time: 1760000000000 + seq, surfaceOp: "append", data });

const userEvent = (seq, text) => surfaceEvent(seq, "user/message", {
  id: `m${seq}`,
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

const assistantEvent = (seq, text) => surfaceEvent(seq, "assistant/message", {
  turn: 1,
  step: 0,
  message: {
    id: `m${seq}`,
    role: "assistant",
    source: { kind: "model", provider: "p", model: "m" },
    content: [{ type: "text", text }],
  },
  stream: [],
});

/** Four chat messages, plus the non-chat variants a real surface also carries. */
const RECENT_SURFACE = [
  surfaceEvent(1, "system/message", {
    turn: 0,
    step: 0,
    message: { id: "s1", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "系统提示词不是对话上下文" }] },
  }),
  userEvent(2, "第一轮：帮我看看登录为什么报错"),
  assistantEvent(3, "先看错误堆栈，再定位配置。"),
  surfaceEvent(4, "tool/result", {
    turn: 1,
    step: 1,
    message: { id: "t4", role: "tool", source: { kind: "tool", name: "read_file" }, toolCallId: "c1", content: [{ type: "text", text: "文件内容不是对话上下文" }] },
  }),
  userEvent(5, "堆栈显示是 token 过期"),
  assistantEvent(6, "那把刷新逻辑加上。"),
];

const snapshotOf = (events) => ({ session: SESSION_HEADER, inheritedEventCount: 0, capturedThroughSeq: null, events });

function makeCtx({
  text = "改写结果",
  selection = { provider: "p", model: "m" },
  efforts,
  config = {},
  editorMissing = false,
  surface,
  surfaceError = false,
} = {}) {
  const routes = {};
  const seen = {};
  const edits = [];
  const ctx = {
    llm: {
      async resolveModelInfo() {
        return efforts === undefined ? {} : { reasoning: { efforts: efforts.map((id) => ({ id })) } };
      },
      stream(options) {
        seen.stream = options;
        if (typeof text === "function") return text();
        return streamOf(textChunks(text));
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return selection;
      },
    },
    webServer: {
      register(route) {
        routes[route.path] = route;
        return () => {};
      },
    },
    fiber: { entry: { id: "prompt-enhancer" } },
    get(name) {
      if (name === "configEditor") return editorMissing ? undefined : ctx.configEditor;
      return ctx[name];
    },
    configEditor: editorMissing ? undefined : {
      async edit(entry, change) {
        const next = change({ ...BASE_CONFIG });
        edits.push({ entry, next });
        return next;
      },
    },
    effect(fn) {
      fn();
    },
    seen,
    routes,
    edits,
  };
  // `sessionQuery` is optional: a profile without it must still activate the
  // plugin, so only the cases that need a surface install the fake service.
  if (surface !== undefined || surfaceError) {
    ctx.sessionQuery = {
      calls: [],
      async readSurface(sessionId) {
        this.calls.push(sessionId);
        if (surfaceError) throw new Error("SESSION_QUERY_CORRUPT_SESSION");
        return snapshotOf(surface);
      },
    };
  }
  ctx.__config = { ...BASE_CONFIG, ...config };
  return ctx;
}

/** Minimal req/res pair for a route handler. */
function makeReq({ method = "POST", body = "" }) {
  const listeners = {};
  let destroyed = false;
  return {
    method,
    destroyed: () => destroyed,
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    destroy() {
      destroyed = true;
    },
    async start() {
      if (body !== "") {
        const buf = Buffer.from(body);
        const step = 16 * 1024;
        for (let at = 0; at < buf.length; at += step) {
          for (const fn of listeners.data ?? []) fn(buf.subarray(at, Math.min(at + step, buf.length)));
        }
      }
      for (const fn of listeners.end ?? []) fn();
    },
  };
}

function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(payload) {
      res.body = payload;
    },
  };
  return res;
}

async function callRoute(ctx, path, { method = "POST", payload } = {}) {
  const route = ctx.routes[path];
  assert.ok(route !== undefined, `route ${path} was not registered`);
  const body = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
  const req = makeReq({ method, body });
  const res = makeRes();
  const done = route.handler(req, res);
  await req.start();
  await done;
  return { status: res.status, json: res.body === "" ? null : JSON.parse(res.body), headers: res.headers, req };
}

const enhance = (ctx, options) => callRoute(ctx, ENHANCE_PATH, options);
const configRoute = (ctx, options) => callRoute(ctx, CONFIG_PATH, options);

const mod = await import(INDEX_URL);

// --------------------------------------------------------------------- shape

test("exports the cordis plugin shape and declared services", () => {
  assert.equal(mod.name, "prompt-enhancer");
  assert.deepEqual(mod.inject, ["llm", "agentDefaultModel", "webServer", "configEditor"]);
  assert.equal(typeof mod.apply, "function");
});

test("registers exactly the two routes, both exact", () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  assert.deepEqual(Object.keys(ctx.routes).sort(), [CONFIG_PATH, ENHANCE_PATH].sort());
  assert.equal(ctx.routes[ENHANCE_PATH].kind, "exact");
  assert.equal(ctx.routes[CONFIG_PATH].kind, "exact");
});

// ------------------------------------------------------------------- enhance

test("the request uses the documented model parameters", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  await enhance(ctx, { payload: { input: "写个登录页" } });
  const stream = ctx.seen.stream;
  assert.equal(stream.temperature, 0.2);
  assert.equal(stream.maxTokens, 4096);
  assert.equal(stream.provider, "p");
  assert.equal(stream.model, "m");
  const userText = stream.messages[0].content[0].text;
  assert.ok(userText.includes("写个登录页"), "the draft must reach the prompt");
  assert.ok(typeof stream.system === "string" && stream.system.length > 0, "a system prompt must be sent");
});

test("a configured model overrides the session default", async () => {
  const ctx = makeCtx({ config: { model: "myprovider/my-model" } });
  mod.apply(ctx, ctx.__config);
  await enhance(ctx, { payload: { input: "x" } });
  assert.equal(ctx.seen.stream.provider, "myprovider");
  assert.equal(ctx.seen.stream.model, "my-model");
});

test("a successful rewrite answers 200 with text", async () => {
  const ctx = makeCtx({ text: "更清晰的提示词" });
  mod.apply(ctx, ctx.__config);
  const { status, json, headers } = await enhance(ctx, { payload: { input: "帮我写个登录页" } });
  assert.equal(status, 200);
  assert.equal(json.text, "更清晰的提示词");
  assert.match(headers["content-type"], /application\/json/);
});

test("empty input answers 400 with guidance", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "   " } });
  assert.equal(status, 400);
  assert.match(json.error, /先输入内容/);
});

test("non-POST methods answer 405", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status } = await enhance(ctx, { method: "GET" });
  assert.equal(status, 405);
});

test("malformed JSON answers 400", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status } = await enhance(ctx, { payload: "{not json" });
  assert.equal(status, 400);
});

test("an oversized body answers 413, not a generic error", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const huge = JSON.stringify({ input: "字".repeat(40000) });
  const { status, json } = await enhance(ctx, { payload: huge });
  assert.equal(status, 413);
  assert.match(json.error, /64 KB/);
});

test("an oversized body keeps the connection open so the 413 can be read", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const huge = JSON.stringify({ input: "字".repeat(40000) });
  const { status, req } = await enhance(ctx, { payload: huge });
  assert.equal(status, 413);
  assert.equal(req.destroyed(), false);
});

test("a disabled plugin answers 403 before calling the model", async () => {
  const ctx = makeCtx({ config: { enabled: false } });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "x" } });
  assert.equal(status, 403);
  assert.match(json.error, /停用/);
  assert.equal(ctx.seen.stream, undefined, "the model must not be called");
});

test("a missing default model answers 503", async () => {
  const ctx = makeCtx({ selection: {} });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "x" } });
  assert.equal(status, 503);
  assert.match(json.error, /默认模型/);
});

test("an empty model answer is reported instead of wiping the draft", async () => {
  const ctx = makeCtx({ text: "   " });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "x" } });
  assert.equal(status, 502);
  assert.match(json.error, /空结果/);
  assert.match(json.error, /p\/m/, "the failing model must be named for diagnosis");
});

test("a failing stream answers 502 with the reason", async () => {
  const ctx = makeCtx({ text: () => streamOf([{ type: "finish", reason: "error" }]) });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "x" } });
  assert.equal(status, 502);
  assert.match(json.error, /增强失败/);
});

test("duplicated model output is collapsed to one copy", async () => {
  const single = "请为现有项目新增登录页：邮箱与密码输入框、记住我、提交按钮，并在成功后跳转。";
  const ctx = makeCtx({ text: single + single });
  mod.apply(ctx, ctx.__config);
  const { json } = await enhance(ctx, { payload: { input: "登录页" } });
  assert.equal(json.text, single);
});

test("wrapping quotes are stripped from the result", async () => {
  const ctx = makeCtx({ text: "“请说明这段代码的主流程与边界。”" });
  mod.apply(ctx, ctx.__config);
  const { json } = await enhance(ctx, { payload: { input: "解释这段代码" } });
  assert.equal(json.text, "请说明这段代码的主流程与边界。");
});

test("the cheapest reasoning effort the model offers is used", async () => {
  const ctx = makeCtx({ efforts: ["high", "low", "medium"] });
  mod.apply(ctx, ctx.__config);
  await enhance(ctx, { payload: { input: "x" } });
  assert.equal(ctx.seen.stream.reasoningEffort, "low");
});

test("a model with no reasoning tiers sends no reasoningEffort", async () => {
  const ctx = makeCtx({ efforts: [] });
  mod.apply(ctx, ctx.__config);
  await enhance(ctx, { payload: { input: "x" } });
  assert.equal("reasoningEffort" in ctx.seen.stream, false);
});

test("the enhance signal is bounded by the configured timeout", async () => {
  const ctx = makeCtx({ config: { timeoutMs: 1234 } });
  mod.apply(ctx, ctx.__config);
  await enhance(ctx, { payload: { input: "x" } });
  const signal = ctx.seen.stream.signal;
  assert.ok(signal instanceof AbortSignal, "an AbortSignal must bound the model call");
  assert.equal(signal.aborted, false);
});

// ------------------------------------------------------------------- context

test("contextTurns > 0 attaches the recent conversation ahead of the draft", async () => {
  const ctx = makeCtx({ config: { contextTurns: 2 }, surface: RECENT_SURFACE });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "那刷新逻辑怎么写", sessionId: "sess-1" } });
  assert.equal(status, 200);
  assert.equal(json.contextMessages, 4, "two turns of chat, oldest first");
  assert.deepEqual(ctx.sessionQuery.calls, ["sess-1"], "the surface is read once, for the composing session");
  const userText = ctx.seen.stream.messages[0].content[0].text;
  assert.ok(userText.includes("RECENT CONVERSATION"), "the context block must precede the draft");
  assert.ok(userText.indexOf("RECENT CONVERSATION") < userText.indexOf("USER INPUT"));
  assert.ok(userText.includes("堆栈显示是 token 过期"), "the newest messages survive");
  assert.ok(userText.includes("第一轮：帮我看看登录为什么报错"), "older messages fill the remaining turns");
  assert.ok(!userText.includes("系统提示词不是对话上下文"), "system prompts are not conversation context");
  assert.ok(!userText.includes("文件内容不是对话上下文"), "tool results are not conversation context");
});

test("contextTurns = 0 reads no surface and sends no context", async () => {
  const ctx = makeCtx({ surface: RECENT_SURFACE }); // BASE_CONFIG carries contextTurns: 0
  mod.apply(ctx, ctx.__config);
  const { json } = await enhance(ctx, { payload: { input: "写个登录页", sessionId: "sess-1" } });
  assert.equal(json.contextMessages, 0);
  assert.equal(ctx.sessionQuery.calls.length, 0, "an off switch must cost nothing");
  assert.ok(!ctx.seen.stream.messages[0].content[0].text.includes("RECENT CONVERSATION"));
});

test("a missing session id leaves the context off", async () => {
  const ctx = makeCtx({ config: { contextTurns: 3 }, surface: RECENT_SURFACE });
  mod.apply(ctx, ctx.__config);
  const { json } = await enhance(ctx, { payload: { input: "写个登录页" } });
  assert.equal(json.contextMessages, 0);
  assert.equal(ctx.sessionQuery.calls.length, 0, "without a session there is nothing to read");
});

test("an unreadable surface degrades to no context, the rewrite still lands", async () => {
  const ctx = makeCtx({ config: { contextTurns: 2 }, surfaceError: true });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "写个登录页", sessionId: "sess-1" } });
  assert.equal(status, 200);
  assert.equal(json.text, "改写结果");
  assert.equal(json.contextMessages, 0);
  assert.ok(!ctx.seen.stream.messages[0].content[0].text.includes("RECENT CONVERSATION"));
});

test("a profile without the sessionQuery service still enhances", async () => {
  const ctx = makeCtx({ config: { contextTurns: 2 } }); // no sessionQuery installed at all
  mod.apply(ctx, ctx.__config);
  const { status, json } = await enhance(ctx, { payload: { input: "写个登录页", sessionId: "sess-1" } });
  assert.equal(status, 200);
  assert.equal(json.contextMessages, 0);
});

// -------------------------------------------------------------------- config

test("the default system prompt asks for a conservative, length-aware rewrite", async () => {
  const ctx = makeCtx({ config: { systemPrompt: "   " } }); // blank falls back to the default
  mod.apply(ctx, ctx.__config);
  const { json } = await configRoute(ctx, { method: "GET" });
  const prompt = json.defaults.systemPrompt;
  assert.ok(prompt.includes("保守第一"), "staying close to the user's wording comes first");
  assert.ok(prompt.includes("长度克制"), "the output length must stay bounded");
  assert.ok(prompt.includes("不编造"), "no invented stack, numbers, or requirements");
  assert.ok(!prompt.includes("实质性增强"), "the old heavy-rewrite wording is gone");
});

test("GET config returns the effective config, defaults, and the model in use", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status, json } = await configRoute(ctx, { method: "GET" });
  assert.equal(status, 200);
  assert.equal(json.config.temperature, 0.2);
  assert.equal(json.defaults.maxTokens, 4096);
  assert.deepEqual(json.effectiveModel, { provider: "p", model: "m", source: "default" });
});

test("GET config reports a configured model as the effective source", async () => {
  const ctx = makeCtx({ config: { model: "fast/cheap" } });
  mod.apply(ctx, ctx.__config);
  const { json } = await configRoute(ctx, { method: "GET" });
  assert.deepEqual(json.effectiveModel, { provider: "fast", model: "cheap", source: "config" });
});

test("GET config reports null when no model is available at all", async () => {
  const ctx = makeCtx({ selection: {} });
  mod.apply(ctx, ctx.__config);
  const { json } = await configRoute(ctx, { method: "GET" });
  assert.equal(json.effectiveModel, null);
});

test("a junk row config is clamped into range instead of throwing", async () => {
  const ctx = makeCtx({ config: { temperature: 99, maxTokens: -5, timeoutMs: 1, contextTurns: 99, systemPrompt: "   ", enabled: "no" } });
  mod.apply(ctx, ctx.__config);
  const { json } = await configRoute(ctx, { method: "GET" });
  assert.equal(json.config.temperature, 2);
  assert.equal(json.config.maxTokens, 1);
  assert.equal(json.config.timeoutMs, 1000);
  assert.equal(json.config.contextTurns, 10, "contextTurns is clamped into 0..10");
  assert.ok(json.config.systemPrompt.length > 0, "an empty systemPrompt falls back to the default");
  assert.equal(json.config.enabled, false, 'enabled: "no" is not undefined, so it counts as off');
});

test("POST config persists a valid patch through the config editor", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status, json } = await configRoute(ctx, { payload: { temperature: 0.5, model: "a/b", enabled: false, contextTurns: 3 } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(ctx.edits.length, 1);
  assert.equal(ctx.edits[0].entry.id, "prompt-enhancer");
  assert.equal(ctx.edits[0].next.temperature, 0.5);
  assert.equal(ctx.edits[0].next.model, "a/b");
  assert.equal(ctx.edits[0].next.enabled, false);
  assert.equal(ctx.edits[0].next.contextTurns, 3);
  assert.equal(ctx.edits[0].next.systemPrompt, BASE_CONFIG.systemPrompt, "untouched fields survive the merge");
});

test("POST config rejects out-of-range and malformed values", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  for (const payload of [{ temperature: 9 }, { maxTokens: 0 }, { timeoutMs: 10 }, { model: "no-slash" }, { systemPrompt: "" }, { enabled: "yes" }, {}, { contextTurns: 11 }, { contextTurns: -1 }]) {
    const { status } = await configRoute(ctx, { payload });
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
  assert.equal(ctx.edits.length, 0, "no rejected value may reach the editor");
});

test("POST config reports a missing config editor instead of claiming success", async () => {
  const ctx = makeCtx({ editorMissing: true });
  mod.apply(ctx, ctx.__config);
  const { status, json } = await configRoute(ctx, { payload: { temperature: 1 } });
  assert.equal(status, 502);
  assert.match(json.error, /cordis\.patch\.yml/);
  assert.equal(ctx.edits.length, 0);
});

test("config route answers 405 for other methods", async () => {
  const ctx = makeCtx();
  mod.apply(ctx, ctx.__config);
  const { status } = await configRoute(ctx, { method: "DELETE" });
  assert.equal(status, 405);
});
