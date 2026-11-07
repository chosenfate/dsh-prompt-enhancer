window.__ModuleLoader__.load({
  id: "@chosenfate/dsh-prompt-enhancer",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    // ------------------------------------------------------------------ strings
    // Mirrors locale/*.json. The host locale service overrides these when it
    // is reachable; the built-in zh dictionary is the fallback either way.
    const STRINGS = {
      zh: {
        "button.enhance": "增强提示词",
        "button.enhancing": "增强中…",
        "button.revert": "恢复原文",
        "button.empty": "先输入内容，再增强提示词",
        "button.busy": "发送中，暂不可增强",
        "button.hasRefs": "草稿含文件引用，暂不支持增强",
        "button.tooLong": "提示词太长（上限 64 KB）",
        "button.disabled": "提示词增强已停用",
        "button.timeout": "增强超时，原文未改动",
        "button.failed": "增强失败",
        "settings.title": "提示词增强",
        "settings.enabled": "启用输入栏增强按钮",
        "settings.model": "增强用模型",
        "settings.follow": "跟随会话默认模型",
        "settings.specify": "指定模型",
        "settings.provider": "提供商",
        "settings.modelId": "模型 ID",
        "settings.temperature": "随机性（temperature）",
        "settings.maxTokens": "最大输出长度（maxTokens）",
        "settings.timeout": "超时时间（毫秒）",
        "settings.systemPrompt": "元提示词（指导模型如何改写草稿）",
        "settings.reset": "恢复默认",
        "settings.save": "保存",
        "settings.saving": "保存中…",
        "settings.saved": "已保存",
        "settings.saveFailed": "保存失败",
        "settings.loading": "读取中…",
        "settings.loadFailed": "读取配置失败",
        "settings.effective": "当前生效模型",
        "settings.none": "未配置，增强时会提示没有可用的模型",
        "settings.invalid": "请检查表单：指定模型需要同时填写提供商和模型 ID",
      },
      en: {
        "button.enhance": "Enhance prompt",
        "button.enhancing": "Enhancing…",
        "button.revert": "Restore original",
        "button.empty": "Type something first, then enhance",
        "button.busy": "Sending — enhancement is paused",
        "button.hasRefs": "Drafts with file references can't be enhanced yet",
        "button.tooLong": "Prompt too long (64 KB limit)",
        "button.disabled": "Prompt enhancement is turned off",
        "button.timeout": "Enhancement timed out; the draft is unchanged",
        "button.failed": "Enhancement failed",
        "settings.title": "Prompt enhancer",
        "settings.enabled": "Enable the composer enhance button",
        "settings.model": "Enhancement model",
        "settings.follow": "Follow the session default model",
        "settings.specify": "Use a specific model",
        "settings.provider": "Provider",
        "settings.modelId": "Model ID",
        "settings.temperature": "Randomness (temperature)",
        "settings.maxTokens": "Max output tokens (maxTokens)",
        "settings.timeout": "Timeout (milliseconds)",
        "settings.systemPrompt": "Meta-prompt (how the model should rewrite the draft)",
        "settings.reset": "Restore defaults",
        "settings.save": "Save",
        "settings.saving": "Saving…",
        "settings.saved": "Saved",
        "settings.saveFailed": "Save failed",
        "settings.loading": "Loading…",
        "settings.loadFailed": "Failed to load settings",
        "settings.effective": "Effective model",
        "settings.none": "Not configured; enhancement will report that no model is available",
        "settings.invalid": "Check the form: a specific model needs both a provider and a model ID",
      },
    };

    let translate = (key) => STRINGS.zh[key] ?? key;

    // ---------------------------------------------------------------------- css
    // Control geometry and colors are copied from the host primitives
    // (ui-primitives Switch/Button): the button itself is the switch track,
    // aria-checked drives the appearance, and the --dsw-alias-button-* /
    // --dsw-alias-switch-thumb token families carry the colors. Only the
    // class names are ours.
    const css = [
      ".dshEnhance_button{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;display:inline-flex;height:28px;justify-content:center;padding:0;width:28px}",
      ".dshEnhance_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}",
      ".dshEnhance_button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,currentColor));outline-offset:2px}",
      ".dshEnhance_button:disabled{cursor:default;opacity:.45}",
      ".dshEnhance_button_revert{color:var(--dsw-alias-brand-primary,currentColor)}",
      ".dshEnhance_spin{animation:dshEnhanceSpin 1s linear infinite;display:inline-flex;transform-origin:center}",
      "@keyframes dshEnhanceSpin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.dshEnhance_spin{animation:none}}",
      ".dshEnhance_settings{display:flex;flex-direction:column;gap:18px;max-width:760px;padding:4px 0}",
      ".dshEnhance_field{display:flex;flex-direction:column;gap:6px}",
      ".dshEnhance_label{color:var(--dsw-alias-label-primary,currentColor);font-size:13px;font-weight:600}",
      ".dshEnhance_hint{color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:1.5}",
      ".dshEnhance_input{background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,8px);box-sizing:border-box;color:inherit;font:inherit;font-size:13px;padding:6px 8px;width:100%}",
      ".dshEnhance_input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,currentColor));outline-offset:1px}",
      ".dshEnhance_textarea{min-height:200px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}",
      ".dshEnhance_radios{display:flex;flex-wrap:wrap;gap:16px}",
      ".dshEnhance_radio{align-items:center;display:inline-flex;font-size:13px;gap:6px}",
      ".dshEnhance_switchRow{align-items:center;display:inline-flex;gap:8px}",
      ".dshEnhance_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}",
      ".dshEnhance_switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
      ".dshEnhance_switch:disabled{cursor:default;opacity:.5}",
      ".dshEnhance_switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      ".dshEnhance_thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease}",
      ".dshEnhance_switch[aria-checked='true'] .dshEnhance_thumb{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}",
      ".dshEnhance_actions{display:flex;gap:8px}",
      ".dshEnhance_primary{align-items:center;background:var(--dsw-alias-button-primary-fill);border:none;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;display:inline-flex;font:inherit;font-size:14px;gap:4px;height:36px;justify-content:center;line-height:22px;padding:0 14px}",
      ".dshEnhance_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
      ".dshEnhance_primary:disabled{cursor:not-allowed;opacity:.4}",
      ".dshEnhance_outline{align-items:center;background:transparent;border:0.5px solid transparent;border-radius:var(--dsw-radius-md,8px);box-shadow:inset 0 0 0 var(--dsh-hairline-width,0.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3));color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;font:inherit;font-size:14px;gap:4px;height:36px;justify-content:center;line-height:22px;padding:0 14px}",
      ".dshEnhance_outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshEnhance_outline:disabled{cursor:not-allowed;opacity:.4}",
      ".dshEnhance_status{font-size:12px;min-height:16px}",
      ".dshEnhance_status_ok{color:var(--dsw-alias-state-success-primary,#2ea44f)}",
      ".dshEnhance_status_error{color:var(--dsw-alias-state-error-primary,#d73a49)}",
    ].join("\n");

    const styleTagId = "@chosenfate/dsh-prompt-enhancer/style.css";
    let styleTag = null;
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null) {
      styleTag = document.createElement("style");
      styleTag.dataset.plugin = "@chosenfate/dsh-prompt-enhancer";
      styleTag.dataset.pluginCss = styleTagId;
      styleTag.textContent = css;
      document.head.appendChild(styleTag);
    }

    // -------------------------------------------------------------------- icons
    function WandIcon({ size = 14 }) {
      return h("svg", {
        viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": true,
        fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
      },
        h("path", { d: "M2.6 13.4 10.4 5.6" }),
        h("path", { d: "M10.4 5.6 9 4.1 M10.4 5.6 11.9 4.1 M10.4 5.6 9 7.1 M10.4 5.6 11.9 7.1" }),
        h("path", { d: "M12.9 1.9l.65 1.75 1.75.65-1.75.65-.65 1.75-.65-1.75-1.75-.65 1.75-.65z" }),
      );
    }

    function UndoIcon({ size = 15 }) {
      return h("svg", {
        viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": true,
        fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
      },
        h("path", { d: "M3.2 7.2h7.1a3.2 3.2 0 1 1 0 6.4H8" }),
        h("path", { d: "M3.2 7.2 5.8 4.6M3.2 7.2l2.6 2.6" }),
      );
    }

    // ------------------------------------------------------------------ helpers
    const ENHANCE_PATH = "/api/prompt-enhancer/enhance";
    const CONFIG_PATH = "/api/prompt-enhancer/config";
    const MAX_INPUT_BYTES = 64 * 1024;
    const FROZEN_PHASES = ["adjudicating", "submitting", "sending"];
    const COMMAND_PREFIX = /^(\/\S+)\s*/;

    function utf8Length(text) {
      try {
        return new TextEncoder().encode(text).length;
      } catch {
        return text.length * 3;
      }
    }

    /** Split a leading /command token off the draft so it never reaches the model. */
    function splitCommand(draft) {
      const match = COMMAND_PREFIX.exec(draft);
      if (match === null) return { token: null, text: draft.trim() };
      return { token: match[1], text: draft.slice(match[0].length).trim() };
    }

    /** Write the enhanced text back, rebuilding the command chip when there was one. */
    function writeDraft(inputActions, token, enhanced) {
      if (token === null) {
        inputActions.setDraft(enhanced);
        return;
      }
      inputActions.setDraft({ text: token + " " + enhanced, references: [], command: { token } });
    }

    // ------------------------------------------------------------- config store
    // One shared cache so the composer button and the settings page see the
    // same effective config without each owning a fetch loop.
    const configStore = { data: null, promise: null, listeners: new Set() };

    function publishConfig(data) {
      configStore.data = data;
      for (const fn of configStore.listeners) fn(data);
    }

    function loadConfig(force) {
      if (!force && configStore.data !== null) return Promise.resolve(configStore.data);
      if (!force && configStore.promise !== null) return configStore.promise;
      const pending = fetch(CONFIG_PATH)
        .then((response) => {
          if (!response.ok) throw new Error("config http " + response.status);
          return response.json();
        })
        .then((data) => {
          configStore.promise = null;
          publishConfig(data);
          return data;
        })
        .catch((error) => {
          configStore.promise = null;
          throw error;
        });
      configStore.promise = pending;
      return pending;
    }

    function subscribeConfig(fn) {
      configStore.listeners.add(fn);
      return () => configStore.listeners.delete(fn);
    }

    function refreshConfig() {
      return loadConfig(true).catch(() => {});
    }

    // ------------------------------------------------------------ enhance button
    /**
     * Composer control on conversation.input.right. The draft, the composer
     * phase, and setDraft arrive as the session's standard input props; the
     * rewrite itself is this plugin's POST /api/prompt-enhancer/enhance, so
     * nothing is patched into the shipped conversation bundle.
     */
    function EnhanceButton({ useInput, inputActions }) {
      const [phase, setPhase] = React.useState("idle"); // idle | loading | done
      const [backup, setBackup] = React.useState(null); // { before, after }
      const [error, setError] = React.useState(null);
      const [config, setConfig] = React.useState(configStore.data);
      const requestRef = React.useRef(0);
      const controllerRef = React.useRef(null);

      React.useEffect(() => subscribeConfig(setConfig), []);
      React.useEffect(() => {
        loadConfig().catch(() => {});
      }, []);

      /** Drop the in-flight request when the composer goes away. */
      React.useEffect(() => () => {
        requestRef.current += 1;
        const controller = controllerRef.current;
        controllerRef.current = null;
        if (controller !== null) controller.abort();
      }, []);

      /** An error is a hint, not a new resting state: clear it after a while. */
      React.useEffect(() => {
        if (error === null) return void 0;
        const timer = setTimeout(() => setError(null), 4000);
        return () => clearTimeout(timer);
      }, [error]);

      const usable = typeof useInput === "function";
      const draft = usable ? useInput((state) => state?.draft ?? "") : "";
      const composerPhase = usable ? useInput((state) => state?.phase ?? "plain") : "plain";
      const occurrences = usable ? useInput((state) => state?.occurrences ?? []) : [];

      const { token, text } = splitCommand(draft);
      const frozen = FROZEN_PHASES.includes(composerPhase);
      const enabled = config === null || config.config?.enabled !== false;
      const timeoutMs = (config?.config?.timeoutMs) || 30000;
      const hasRefs = occurrences.length > 0;
      const tooLong = utf8Length(text) > MAX_INPUT_BYTES;
      const revertMode = phase === "done" && backup !== null && draft === backup.after;
      const busy = phase === "loading";
      const disabled = !usable || inputActions === undefined || frozen || busy || !enabled || hasRefs
        || (!revertMode && (text.length === 0 || tooLong));

      const label = error !== null
        ? error
        : busy
          ? translate("button.enhancing")
          : revertMode
            ? translate("button.revert")
            : !enabled
              ? translate("button.disabled")
              : frozen
                ? translate("button.busy")
                : hasRefs
                  ? translate("button.hasRefs")
                  : text.length === 0
                    ? translate("button.empty")
                    : tooLong
                      ? translate("button.tooLong")
                      : translate("button.enhance");

      const onClick = () => {
        if (inputActions === undefined || frozen || busy) return;
        if (revertMode) {
          inputActions.setDraft(backup.before);
          setBackup(null);
          setPhase("idle");
          setError(null);
          return;
        }
        if (!enabled || hasRefs || tooLong || text.length === 0) return;
        const before = draft;
        const request = requestRef.current + 1;
        requestRef.current = request;
        setPhase("loading");
        setError(null);
        const previous = controllerRef.current;
        if (previous !== null) previous.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        fetch(ENHANCE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: text }),
          signal: controller.signal,
        })
          .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
            if (requestRef.current !== request) return;
            const enhanced = typeof body?.text === "string" ? body.text.trim() : "";
            if (!ok || enhanced.length === 0) {
              setError(typeof body?.error === "string" ? body.error : translate("button.failed"));
              setPhase("idle");
              return;
            }
            setBackup({ before, after: enhanced });
            writeDraft(inputActions, token, enhanced);
            setPhase("done");
          }, (reason) => {
            if (requestRef.current !== request) return;
            setError(reason instanceof Error && reason.name === "AbortError"
              ? translate("button.timeout")
              : reason instanceof Error ? reason.message : translate("button.failed"));
            setPhase("idle");
          })
          .finally(() => {
            clearTimeout(timer);
            if (controllerRef.current === controller) controllerRef.current = null;
          });
      };

      return h("button", {
        type: "button",
        className: "dshEnhance_button" + (revertMode ? " dshEnhance_button_revert" : ""),
        title: label,
        "aria-label": label,
        "aria-busy": busy,
        disabled,
        onMouseDown: (event) => event.preventDefault(),
        onClick,
      }, revertMode
        ? h(UndoIcon, {})
        : h("span", { className: busy ? "dshEnhance_spin" : void 0, style: { display: "inline-flex" } }, h(WandIcon, {})));
    }

    // -------------------------------------------------------------- settings page
    // Switch structure copied from the host primitive: the button itself is
    // the track, aria-checked drives the appearance, and one thumb span rides
    // inside it. The render site owns the visible label.
    function Switch({ checked, onChange, label, disabled = false, title }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        title,
        disabled,
        className: "dshEnhance_switch",
        onClick: () => onChange(!checked),
      }, h("span", { className: "dshEnhance_thumb" }));
    }

    /** Navigation glyph for the settings.section row; the shell colors it through currentColor. */
    function SectionIcon({ size = 16 }) {
      return h("svg", {
        viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": true,
        fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
      },
        h("path", { d: "M2.6 13.4 10.4 5.6" }),
        h("path", { d: "M10.4 5.6 9 4.1 M10.4 5.6 11.9 4.1 M10.4 5.6 9 7.1 M10.4 5.6 11.9 7.1" }),
        h("path", { d: "M12.9 1.9l.65 1.75 1.75.65-1.75.65-.65 1.75-.65-1.75-1.75-.65 1.75-.65z" }));
    }

    function Field({ label, hint, children }) {
      return h("div", { className: "dshEnhance_field" },
        h("div", { className: "dshEnhance_label" }, label),
        children,
        hint === undefined ? null : h("div", { className: "dshEnhance_hint" }, hint));
    }

    function SettingsPage() {
      const [status, setStatus] = React.useState("loading"); // loading | error | ready
      const [snapshot, setSnapshot] = React.useState(null); // { config, defaults, effectiveModel }
      const [form, setForm] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const load = React.useCallback(() => {
        setStatus("loading");
        return loadConfig(true)
          .then((data) => {
            setSnapshot(data);
            setForm({ ...data.config });
            setStatus("ready");
          })
          .catch(() => setStatus("error"));
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

      const onSave = () => {
        setNotice(null);
        const specify = form.model !== "";
        if (specify && !/^[^\s/]+\/\S+$/.test(form.model.trim())) {
          setNotice({ kind: "error", text: translate("settings.invalid") });
          return;
        }
        setSaving(true);
        fetch(CONFIG_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: form.enabled !== false,
            model: form.model.trim(),
            temperature: Number(form.temperature),
            maxTokens: Number(form.maxTokens),
            timeoutMs: Number(form.timeoutMs),
            systemPrompt: form.systemPrompt,
          }),
        })
          .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
            setSaving(false);
            if (!ok || body?.ok !== true) {
              setNotice({ kind: "error", text: typeof body?.error === "string" ? body.error : translate("settings.saveFailed") });
              return;
            }
            setNotice({ kind: "ok", text: translate("settings.saved") });
            refreshConfig().then(() => load());
          })
          .catch(() => {
            setSaving(false);
            setNotice({ kind: "error", text: translate("settings.saveFailed") });
          });
      };

      const onReset = () => {
        if (snapshot === null) return;
        setForm({ ...snapshot.defaults });
        setNotice(null);
      };

      if (status === "loading") {
        return h("div", { className: "dshEnhance_settings" }, h("div", { className: "dshEnhance_hint" }, translate("settings.loading")));
      }
      if (status === "error" || snapshot === null || form === null) {
        return h("div", { className: "dshEnhance_settings" },
          h("div", { className: "dshEnhance_hint" }, translate("settings.loadFailed")),
          h("div", { className: "dshEnhance_actions" },
            h("button", { type: "button", className: "dshEnhance_outline", onClick: () => load() }, translate("settings.reset"))));
      }

      const effective = snapshot.effectiveModel;
      const effectiveText = effective === null
        ? translate("settings.none")
        : effective.provider + "/" + effective.model + (effective.source === "config" ? "" : "（" + translate("settings.follow") + "）");

      return h("div", { className: "dshEnhance_settings" },
        h("div", { className: "dshEnhance_switchRow" },
          h(Switch, {
            checked: form.enabled !== false,
            onChange: (next) => setField("enabled", next),
            label: translate("settings.enabled"),
          }),
          h("span", { className: "dshEnhance_label" }, translate("settings.enabled"))),
        h(Field, { label: translate("settings.model"), hint: effectiveText },
          h("div", { className: "dshEnhance_radios" },
            h("label", { className: "dshEnhance_radio" },
              h("input", {
                type: "radio", name: "dshEnhance_modelMode", checked: form.model === "",
                onChange: () => setField("model", ""),
              }),
              translate("settings.follow")),
            h("label", { className: "dshEnhance_radio" },
              h("input", {
                type: "radio", name: "dshEnhance_modelMode", checked: form.model !== "",
                onChange: () => setField("model", " /"),
              }),
              translate("settings.specify"))),
          form.model === ""
            ? null
            : h("div", { style: { display: "flex", gap: "8px" } },
              h("input", {
                className: "dshEnhance_input", placeholder: translate("settings.provider"), value: form.model.split("/")[0] ?? "",
                onChange: (event) => {
                  const model = form.model.includes("/") ? form.model.slice(form.model.indexOf("/") + 1) : "";
                  setField("model", event.target.value + "/" + model);
                },
              }),
              h("input", {
                className: "dshEnhance_input", placeholder: translate("settings.modelId"), value: form.model.includes("/") ? form.model.slice(form.model.indexOf("/") + 1) : "",
                onChange: (event) => {
                  const provider = form.model.split("/")[0] ?? "";
                  setField("model", provider + "/" + event.target.value);
                },
              }))),
        h(Field, { label: translate("settings.temperature") },
          h("input", {
            className: "dshEnhance_input", type: "number", min: "0", max: "2", step: "0.1", style: { width: "120px" },
            value: String(form.temperature),
            onChange: (event) => setField("temperature", event.target.value),
          })),
        h(Field, { label: translate("settings.maxTokens") },
          h("input", {
            className: "dshEnhance_input", type: "number", min: "1", max: "8192", step: "1", style: { width: "120px" },
            value: String(form.maxTokens),
            onChange: (event) => setField("maxTokens", event.target.value),
          })),
        h(Field, { label: translate("settings.timeout") },
          h("input", {
            className: "dshEnhance_input", type: "number", min: "1000", max: "120000", step: "1000", style: { width: "140px" },
            value: String(form.timeoutMs),
            onChange: (event) => setField("timeoutMs", event.target.value),
          })),
        h(Field, { label: translate("settings.systemPrompt") },
          h("textarea", {
            className: "dshEnhance_input dshEnhance_textarea", value: form.systemPrompt,
            onChange: (event) => setField("systemPrompt", event.target.value),
          })),
        h("div", { className: "dshEnhance_actions" },
          h("button", { type: "button", className: "dshEnhance_primary", disabled: saving, onClick: onSave },
            saving ? translate("settings.saving") : translate("settings.save")),
          h("button", { type: "button", className: "dshEnhance_outline", disabled: saving, onClick: onReset }, translate("settings.reset"))),
        h("div", { className: "dshEnhance_status " + (notice?.kind === "ok" ? "dshEnhance_status_ok" : "dshEnhance_status_error") },
          notice === null ? "" : notice.text));
    }

    // --------------------------------------------------------------------- apply
    const inject = ["slots", "locale"];

    function apply(ctx) {
      // The style tag is injected once per page load (guarded above); the
      // effect owns its removal so disabling or unloading the plugin leaves
      // nothing behind.
      ctx.effect(() => () => {
        if (styleTag !== null && typeof styleTag.remove === "function") styleTag.remove();
      }, "prompt-enhancer style");

      try {
        ctx.locale.register("prompt-enhancer", "zh", STRINGS.zh);
        ctx.locale.register("prompt-enhancer", "en", STRINGS.en);
        const bound = ctx.locale.bind("prompt-enhancer");
        if (typeof bound === "function") {
          translate = (key) => {
            try {
              const value = bound(key);
              if (typeof value === "string" && value !== "") return value;
            } catch {
              /* fall through to the built-in dictionary */
            }
            return STRINGS.zh[key] ?? key;
          };
        }
      } catch {
        /* the built-in zh dictionary stays in charge */
      }

      ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
        name: "conversation.input.right",
        id: "prompt-enhancer",
        order: 5,
      }, EnhanceButton));

      // A settings page of its own in the settings navigation (order 20 sits
      // after the shipped sections -10/0/10/15), plus its nav glyph. The
      // icon registration id must equal the section id or it never renders.
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "prompt-enhancer",
        order: 20,
        label: () => translate("settings.title"),
      }, SettingsPage));

      ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
        name: "settings.section.icon",
        id: "prompt-enhancer",
      }, SectionIcon));
    }

    return { apply, inject };
  },
});
