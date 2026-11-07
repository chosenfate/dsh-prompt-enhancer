/**
 * Headless harness for lib/client.js.
 *
 * The client half is plain React without JSX, so a small hook shim is enough
 * to mount the components, drive their handlers, and observe the draft it
 * writes back. `fetch` is mocked per case. The plugin file is evaluated from
 * source for every load so a fresh module, fresh config store, and fresh
 * style injection are installed.
 *
 * Render model, mirroring the reference harness: a mount resets the hook
 * state; a rerender keeps the state and only replays the render, which is how
 * an async setState (the config load, an error fade) becomes observable.
 *
 *   node --test test/client.test.cjs
 */

const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const CLIENT_FILE = path.resolve(__dirname, "../lib/client.js");
const SOURCE = fs.readFileSync(CLIENT_FILE, "utf8");

const ENHANCE_PATH = "/api/prompt-enhancer/enhance";
const CONFIG_PATH = "/api/prompt-enhancer/config";

const BASE_CONFIG = {
  enabled: true,
  model: "",
  temperature: 0.2,
  maxTokens: 4096,
  timeoutMs: 30000,
  systemPrompt: "你是提示词工程专家。",
};

const DEFAULTS = { ...BASE_CONFIG, systemPrompt: "默认元提示词" };

// ---------------------------------------------------------------- react shim
let hookIndex = 0;
let hookState = [];
let pendingEffects = [];

const react = {
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    };
  },
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      hookState[i] = typeof next === "function" ? next(hookState[i]) : next;
    };
    return [hookState[i], set];
  },
  useRef(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = { current: initial };
    return hookState[i];
  },
  useEffect(fn) {
    const i = hookIndex++;
    if (!(i in hookState)) {
      hookState[i] = true;
      pendingEffects.push(fn);
    }
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
};

// ------------------------------------------------------------- module loader
function loadClient() {
  let captured = null;
  const styleTags = [];
  const effects = [];
  const sandboxWindow = {
    __ModuleLoader__: { load: (def) => void (captured = def) },
    localStorage: { getItem: () => null, setItem() {} },
  };
  const sandboxDocument = {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: "", appended: false, removed: false, remove() { this.removed = true; } };
      styleTags.push(tag);
      return tag;
    },
    head: { appendChild(tag) { tag.appended = true; } },
  };
  const requireStub = (name) => {
    if (name === "react") return react;
    throw new Error(`unexpected require: ${name}`);
  };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "require", "module", SOURCE)(sandboxWindow, sandboxDocument, requireStub, module);
  assert.ok(captured !== null, "client did not register with the module loader");

  const loaded = captured.factory(requireStub);
  const registrations = [];
  const components = {};
  loaded.apply({
    slots: {
      inject(name, fn) {
        fn();
      },
      register(meta, component) {
        registrations.push(meta);
        components[meta.name] = component;
        return () => {};
      },
    },
    locale: {
      register() {},
      bind() {
        return undefined; // exercise the built-in dictionary fallback
      },
    },
    effect(fn) {
      effects.push(fn());
    },
  });
  return { registrations, components, module: loaded, effects, styleTags };
}

// ------------------------------------------------------------------- helpers
/** Render a component; a mount resets the hooks, a rerender keeps their state. */
function renderInto(Component, props, { mount: fresh = true } = {}) {
  if (fresh) {
    hookIndex = 0;
    hookState = [];
    pendingEffects = [];
  } else {
    hookIndex = 0;
    pendingEffects = [];
  }
  const tree = Component(props);
  const cleanups = [];
  for (const fn of pendingEffects.splice(0)) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return { tree, cleanups };
}

function buttonProps(state, sink) {
  return {
    useInput: (select) => select({ draft: state.draft, phase: state.phase, occurrences: state.occurrences }),
    inputActions: {
      setDraft(next) {
        sink.push(next);
        state.draft = next;
      },
    },
  };
}

function mountButton(client, { draft = "", phase = "plain", occurrences = [], writes } = {}) {
  const sink = writes ?? [];
  const state = { draft, phase, occurrences };
  const view = renderInto(client.components["conversation.input.right"], buttonProps(state, sink), { mount: true });
  return { ...view, state, sink };
}

function rerenderButton(client, view) {
  const rendered = renderInto(client.components["conversation.input.right"], buttonProps(view.state, view.sink), { mount: false });
  return { ...view, ...rendered };
}

/** Walk the element tree, expanding function components so their output shows. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found);
    return found;
  }
  if (typeof node === "string" || typeof node === "number") return found;
  if (typeof node === "function") {
    findAll(node({}), predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (typeof node.type === "function") {
    if (predicate(node)) found.push(node);
    findAll(node.type(node.props ?? {}), predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => findAll(item, predicate, found));
    else if (value !== null && typeof value === "object") findAll(value, predicate, found);
  }
  return found;
}

const byClass = (tree, cls) =>
  findAll(tree, (n) => typeof n.props?.className === "string" && n.props.className.split(" ").includes(cls))[0];
const byType = (tree, type) => findAll(tree, (n) => n.type === type)[0];
const inputsOfType = (tree, type) => findAll(tree, (n) => n.type === "input" && n.props.type === type);

function mockApi({ config = BASE_CONFIG, defaults = DEFAULTS, effectiveModel = { provider: "p", model: "m", source: "default" }, onEnhance, onSave } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, init, method });
    if (url === CONFIG_PATH && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ config: { ...config }, defaults, effectiveModel }) };
    }
    if (url === CONFIG_PATH && method === "POST") {
      return onSave === undefined
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : onSave(JSON.parse(init.body), calls);
    }
    if (url === ENHANCE_PATH) {
      return onEnhance === undefined
        ? { ok: true, status: 200, json: async () => ({ text: "增强后的提示词" }) }
        : onEnhance(JSON.parse(init.body), init, calls);
    }
    throw new Error("unexpected fetch " + url);
  };
  return calls;
}

const jsonError = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

const realSetTimeout = globalThis.setTimeout;

/**
 * The plugin arms a per-request abort timer and a 4 s error fade. Unref those
 * so the suite exits as soon as the last assertion finishes.
 */
globalThis.setTimeout = (fn, ms, ...rest) => {
  const timer = realSetTimeout(fn, ms, ...rest);
  if (ms >= 1000 && typeof timer?.unref === "function") timer.unref();
  return timer;
};

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 10));

// --------------------------------------------------------------------- tests
test("registers the button on conversation.input.right and a settings section", () => {
  const client = loadClient();
  const button = client.registrations.find((r) => r.name === "conversation.input.right");
  const section = client.registrations.find((r) => r.name === "settings.section");
  const icon = client.registrations.find((r) => r.name === "settings.section.icon");
  assert.ok(button !== undefined, "the composer button must be registered");
  assert.equal(button.id, "prompt-enhancer");
  assert.equal(typeof button.order, "number");
  assert.ok(section !== undefined, "the settings section must be registered");
  assert.equal(section.id, "prompt-enhancer");
  assert.equal(section.order, 20, "the section sits after the shipped sections (-10/0/10/15)");
  assert.equal(typeof section.label, "function");
  assert.equal(section.label(), "提示词增强");
  assert.ok(icon !== undefined, "the nav icon must be registered");
  assert.equal(icon.id, "prompt-enhancer", "the icon id must equal the section id or it never renders");
  assert.equal(
    client.registrations.some((r) => r.name === "settings.plugins.tab"),
    false,
    "the page must not live inside the built-in plugins section any more",
  );
});

test("the switch is the host structure: the button is the track with one thumb", async () => {
  mockApi();
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const switches = findAll(loaded.tree, (n) => n.props?.role === "switch");
  assert.equal(switches.length, 1, "exactly one switch on the page");
  const control = switches[0];
  assert.equal(control.type, "button", "the button itself is the track");
  assert.equal(control.props["aria-checked"], true, "enabled by default");
  assert.equal(control.props["aria-label"], "启用输入栏增强按钮");
  const thumbs = findAll(control, (n) => n.props?.className === "dshEnhance_thumb");
  assert.equal(thumbs.length, 1, "one thumb span inside the track");
  const label = findAll(loaded.tree, (n) => n.props?.className === "dshEnhance_label");
  assert.ok(label.length >= 1, "the visible label renders beside the switch");
});

test("unload removes the injected style tag", () => {
  const client = loadClient();
  const tag = client.styleTags[0];
  assert.ok(tag !== undefined, "a style tag must be injected");
  assert.equal(tag.appended, true, "the style tag must reach the document head");
  assert.equal(tag.removed, false);
  assert.ok(client.effects.length >= 1, "the style effect must be registered");
  for (const cleanup of client.effects) {
    if (typeof cleanup === "function") cleanup();
  }
  assert.equal(tag.removed, true, "unload must remove the style tag");
});

test("a missing useInput prop does not break render", () => {
  const client = loadClient();
  const view = renderInto(client.components["conversation.input.right"], { inputActions: { setDraft() {} } });
  assert.equal(byClass(view.tree, "dshEnhance_button").props.disabled, true);
});

test("empty draft disables the button with the guidance label", async () => {
  mockApi();
  const client = loadClient();
  const view = mountButton(client, { draft: "   " });
  await tick();
  const button = byClass(view.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, "先输入内容，再增强提示词");
});

test("a busy composer phase freezes the button", async () => {
  mockApi();
  const client = loadClient();
  const view = mountButton(client, { draft: "写个登录页", phase: "submitting" });
  await tick();
  const button = byClass(view.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, "发送中，暂不可增强");
});

test("a draft with file references is refused before any request", async () => {
  const calls = mockApi();
  const client = loadClient();
  const view = mountButton(client, { draft: "看看 @src/app.ts", occurrences: [{ occurrenceId: "o1" }] });
  await tick();
  const button = byClass(view.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, "草稿含文件引用，暂不支持增强");
  await button.props.onClick();
  await tick();
  assert.equal(calls.filter((c) => c.url === ENHANCE_PATH).length, 0);
});

test("a disabled config freezes the button with its own label", async () => {
  mockApi({ config: { ...BASE_CONFIG, enabled: false } });
  const client = loadClient();
  const view = mountButton(client, { draft: "写个登录页" });
  await tick();
  const loaded = rerenderButton(client, view); // the config has landed by now
  const button = byClass(loaded.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, "提示词增强已停用");
});

test("successful rewrite posts the draft text and replaces it", async () => {
  const calls = mockApi({ onEnhance: () => ({ ok: true, status: 200, json: async () => ({ text: "增强后的提示词" }) }) });
  const client = loadClient();
  const view = mountButton(client, { draft: "帮我写个登录页" });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  const enhanceCalls = calls.filter((c) => c.url === ENHANCE_PATH);
  assert.equal(enhanceCalls.length, 1);
  assert.equal(enhanceCalls[0].method, "POST");
  assert.deepEqual(JSON.parse(enhanceCalls[0].init.body), { input: "帮我写个登录页" });
  assert.deepEqual(view.state.draft, "增强后的提示词");
});

test("after a rewrite the button becomes 恢复原文 and reverts on click", async () => {
  mockApi({ onEnhance: () => ({ ok: true, status: 200, json: async () => ({ text: "改写后" }) }) });
  const client = loadClient();
  const writes = [];
  const first = mountButton(client, { draft: "原文", writes });
  await tick();
  await byClass(first.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(writes, ["改写后"]);

  const second = rerenderButton(client, first);
  const revert = byClass(second.tree, "dshEnhance_button");
  assert.ok(revert.props.className.includes("dshEnhance_button_revert"), "expected the revert style");
  assert.equal(revert.props.title, "恢复原文");
  await revert.props.onClick();
  assert.deepEqual(writes, ["改写后", "原文"]);
});

test("editing the draft after a rewrite leaves revert mode", async () => {
  mockApi({ onEnhance: () => ({ ok: true, status: 200, json: async () => ({ text: "改写后" }) }) });
  const client = loadClient();
  const view = mountButton(client, { draft: "原文" });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  const edited = rerenderButton(client, { ...view, state: { ...view.state, draft: "改写后，再加一句" } });
  const button = byClass(edited.tree, "dshEnhance_button");
  assert.ok(!button.props.className.includes("dshEnhance_button_revert"), "a hand-edited draft must not be revertible");
  assert.equal(button.props.disabled, false);
});

test("server error leaves the draft untouched", async () => {
  mockApi({ onEnhance: () => jsonError(502, "模型调用失败") });
  const client = loadClient();
  const writes = [];
  const view = mountButton(client, { draft: "原文", writes });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(writes, []);
  const after = rerenderButton(client, view);
  assert.equal(byClass(after.tree, "dshEnhance_button").props.title, "模型调用失败");
});

test("an aborted request surfaces the timeout label", async () => {
  mockApi({ onEnhance: () => Promise.reject(abortError()) });
  const client = loadClient();
  const writes = [];
  const view = mountButton(client, { draft: "原文", writes });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(writes, [], "an aborted request must not write the draft");
  const after = rerenderButton(client, view);
  assert.equal(byClass(after.tree, "dshEnhance_button").props.title, "增强超时，原文未改动");
});

test("a network failure surfaces the reason", async () => {
  mockApi({ onEnhance: () => Promise.reject(new Error("network down")) });
  const client = loadClient();
  const writes = [];
  const view = mountButton(client, { draft: "原文", writes });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(writes, []);
  const after = rerenderButton(client, view);
  assert.equal(byClass(after.tree, "dshEnhance_button").props.title, "network down");
});

test("a leading /command token never reaches the model and is rebuilt after", async () => {
  const calls = mockApi({ onEnhance: () => ({ ok: true, status: 200, json: async () => ({ text: "增强后的提示词" }) }) });
  const client = loadClient();
  const writes = [];
  const view = mountButton(client, { draft: "/code 帮我写个登录页", writes });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  const enhanceCalls = calls.filter((c) => c.url === ENHANCE_PATH);
  assert.equal(enhanceCalls.length, 1);
  const sent = JSON.parse(enhanceCalls[0].init.body);
  assert.equal(sent.input, "帮我写个登录页", "the command token must be stripped before the model sees it");
  assert.ok(!sent.input.includes("/code"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    text: "/code 增强后的提示词",
    references: [],
    command: { token: "/code" },
  });
});

test("a draft that is only a command stays disabled", async () => {
  mockApi();
  const client = loadClient();
  const view = mountButton(client, { draft: "/code" });
  await tick();
  assert.equal(byClass(view.tree, "dshEnhance_button").props.disabled, true);
});

test("oversized drafts are refused before any request", async () => {
  const calls = mockApi();
  const client = loadClient();
  const view = mountButton(client, { draft: "字".repeat(30000) }); // 90 KB of UTF-8, over the 64 KB cap
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(calls.filter((c) => c.url === ENHANCE_PATH).length, 0);
  assert.equal(byClass(view.tree, "dshEnhance_button").props.title, "提示词太长（上限 64 KB）");
});

test("unmount aborts the in-flight request", async () => {
  let signal = null;
  mockApi({
    onEnhance: (body, init) => new Promise((resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener("abort", () => reject(abortError()));
    }),
  });
  const client = loadClient();
  const view = mountButton(client, { draft: "原文" });
  await tick();
  byClass(view.tree, "dshEnhance_button").props.onClick();
  assert.ok(signal !== null, "expected a request with an abort signal");
  assert.equal(signal.aborted, false);
  assert.ok(view.cleanups.length >= 1, "expected at least the unmount effect");
  for (const cleanup of view.cleanups) cleanup();
  assert.equal(signal.aborted, true, "unmount must abort the request");
});

test("after the busy state renders, a second click is blocked", async () => {
  const signals = [];
  mockApi({ onEnhance: (body, init) => new Promise(() => void signals.push(init.signal)) });
  const client = loadClient();
  const view = mountButton(client, { draft: "原文" });
  await tick();
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(signals.length, 1);
  const busy = rerenderButton(client, view);
  const button = byClass(busy.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true, "the button must be disabled while loading");
  assert.equal(button.props.title, "增强中…");
  await button.props.onClick();
  await tick();
  assert.equal(signals.length, 1, "a disabled button must not start a second request");
});

test("a click that slips past the busy guard aborts the previous request", async () => {
  const signals = [];
  mockApi({ onEnhance: (body, init) => new Promise(() => void signals.push(init.signal)) });
  const client = loadClient();
  const view = mountButton(client, { draft: "原文" });
  await tick();
  const button = byClass(view.tree, "dshEnhance_button");
  button.props.onClick();
  await tick();
  button.props.onClick(); // stale closure: the guard cannot see the new phase yet
  await tick();
  assert.equal(signals.length, 2, "expected a second request");
  assert.equal(signals[0].aborted, true, "the superseded request must be aborted");
  assert.equal(signals[1].aborted, false, "the newest request stays alive");
});

// --------------------------------------------------------------- settings page
function mountSettings(client) {
  return renderInto(client.components["settings.section"], {}, { mount: true });
}

function rerenderSettings(client, view) {
  const rendered = renderInto(client.components["settings.section"], {}, { mount: false });
  return { ...view, ...rendered };
}

test("the settings page renders the effective config from the host", async () => {
  mockApi({
    config: { ...BASE_CONFIG, model: "fast/cheap", temperature: 0.7 },
    effectiveModel: { provider: "fast", model: "cheap", source: "config" },
  });
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const numbers = inputsOfType(loaded.tree, "number");
  assert.equal(numbers.length, 3, "temperature, maxTokens and timeoutMs inputs");
  assert.equal(numbers[0].props.value, "0.7");
  const radios = inputsOfType(loaded.tree, "radio");
  assert.equal(radios.length, 2);
  assert.equal(radios[0].props.checked, false, "a configured model selects 指定模型");
  assert.equal(radios[1].props.checked, true);
  const textarea = byType(loaded.tree, "textarea");
  assert.ok(textarea !== undefined, "the meta-prompt textarea must render");
  assert.equal(textarea.props.value, BASE_CONFIG.systemPrompt);
  const hints = findAll(loaded.tree, (n) => typeof n.props?.children === "string" && n.props.children.includes("fast/cheap"));
  assert.ok(hints.length >= 1, "the effective model must be shown");
});

test("the settings page saves the merged config", async () => {
  const calls = mockApi({
    config: { ...BASE_CONFIG },
    onSave: (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, saved: body }) }),
  });
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const save = byClass(loaded.tree, "dshEnhance_primary");
  assert.ok(save !== undefined, "the save button must render");
  await save.props.onClick();
  await tick();
  const saveCalls = calls.filter((c) => c.url === CONFIG_PATH && c.method === "POST");
  assert.equal(saveCalls.length, 1);
  const body = JSON.parse(saveCalls[0].init.body);
  assert.equal(body.enabled, true);
  assert.equal(body.model, "");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.maxTokens, 4096);
  assert.equal(body.timeoutMs, 30000);
  assert.equal(body.systemPrompt, BASE_CONFIG.systemPrompt);
});

test("the settings page refuses a half-typed model without calling the host", async () => {
  const calls = mockApi();
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const radios = inputsOfType(loaded.tree, "radio");
  await radios[1].props.onChange(); // 指定模型, provider/model still " /"
  const afterRadio = rerenderSettings(client, loaded);
  const save = byClass(afterRadio.tree, "dshEnhance_primary");
  await save.props.onClick();
  await tick();
  assert.equal(calls.filter((c) => c.url === CONFIG_PATH && c.method === "POST").length, 0, "an invalid model must not be posted");
  const noticed = rerenderSettings(client, afterRadio);
  const status = byClass(noticed.tree, "dshEnhance_status");
  assert.ok(status !== undefined, "a notice row must exist");
  assert.ok(String(status.props.children).length > 0, "the notice must explain the refusal");
});

test("the settings page restores the defaults into the form", async () => {
  mockApi({ config: { ...BASE_CONFIG, temperature: 1.9 }, defaults: DEFAULTS });
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const reset = byClass(loaded.tree, "dshEnhance_outline");
  assert.ok(reset !== undefined, "the reset button must render");
  await reset.props.onClick();
  const afterReset = rerenderSettings(client, loaded);
  const numbers = inputsOfType(afterReset.tree, "number");
  assert.equal(numbers[0].props.value, "0.2", "temperature must fall back to the default");
  assert.equal(byType(afterReset.tree, "textarea").props.value, DEFAULTS.systemPrompt);
});

test("a failed config load shows the retry affordance", async () => {
  globalThis.fetch = async () => { throw new Error("boom"); };
  const client = loadClient();
  const view = mountSettings(client);
  await tick();
  const loaded = rerenderSettings(client, view);
  const hints = findAll(loaded.tree, (n) => typeof n.props?.children === "string" && n.props.children === "读取配置失败");
  assert.ok(hints.length >= 1, "the load failure must be visible");
  assert.ok(byClass(loaded.tree, "dshEnhance_outline") !== undefined, "a retry button must be offered");
});
