# prompt-enhancer

DeepSeek Harness 的输入栏插件：把你随手敲的草稿改写成一条更清晰、更具体的提示词。改写结果**直接写回输入框**，不满意**一键还原**——发送前完成，不弹窗、不复制粘贴。

- **原地改写**：按钮挂在输入栏工具行右侧，不改动内置界面。
- **一键还原**：改写后按钮变成「恢复原文」，原文始终保留。
- **可配置**：增强用哪个模型、temperature、maxTokens、超时、元提示词全文，全部在设置页里改，也写在 `cordis.patch.yml` 里。
- **出错不毁稿**：超时、模型失败、空结果、无可用模型，都不会用半截结果覆盖你的原文。

## 用法

1. 在输入框里写你要做的事，哪怕只有一句话。
2. 点输入栏右侧的 ✦ 按钮，按钮变成「增强中…」；完成后草稿被替换，按钮变成「恢复原文」。
3. 觉得改得不好，再点一下还原。

边界情况：输入框为空（或只有一个 `/命令`）时按钮置灰；正在发送、命令判定中时按钮临时禁用；草稿里含文件引用（`@文件`）时按钮置灰并提示——这类草稿替换会丢失引用芯片，暂不支持；一次改写最多等 30 秒（可配），超时提示而原文不动；上限 64 KB。

草稿以 `/命令` 开头时（如 `/code 帮我写个登录页`），命令前缀不会送给模型，改写结果会带上前缀写回，命令芯片保留。

## 安装

三种方式，任选其一：

**npm（发布后）**：

```sh
dsh plugin --profile desktop add @chosenfate/dsh-prompt-enhancer
```

**git（源码）**：

```sh
dsh plugin --profile desktop add git+https://github.com/chosenfate/dsh-prompt-enhancer.git
```

**本地目录（开发）**：在 DSH 里说一句「装上 <绝对目录> 这个插件」，Agent 会调用插件管理器链接安装。

装完输入栏右侧即出现增强按钮；设置列表里会多出独立的「提示词增强」一项（位于内置设置项之后），图标与开关样式照抄宿主控件。

> 桌面版安装前先完全退出应用，否则 profile 会被占用。

## 配置

所有配置项在插件行的 `config` 里（`cordis.patch.yml`），也可以用设置页在应用内修改（设置页通过 config editor 写回同一处，改普通字段会重启插件）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后按钮置灰显示「已停用」 |
| `model` | `""` | `""` = 跟随会话默认模型；否则 `"provider/model"` |
| `temperature` | `0.2` | 低随机性，改写要稳 |
| `maxTokens` | `4096` | 推理模型的隐藏思考与可见回答共用这一配额，800 会把回答饿空 |
| `timeoutMs` | `30000` | 单次改写超时 |
| `systemPrompt` | 内置默认 | 元提示词全文，设置页可编辑、可恢复默认 |

改写走指定模型（或会话默认模型）时，**推理档位自动取该模型可选的最低档**，避免高推理档把 30 秒耗在看不见的思考上。输出严格跟随输入语言：中文进中文出，英文进英文出，混排保持混排。

## 接口

`POST /api/prompt-enhancer/enhance`

```json
{ "input": "要增强的草稿文本" }
```

成功返回 `{ "text": "增强后的提示词" }`；失败返回 `{ "error": "..." }`，状态码 400（空输入 / 格式错）、403（已停用）、413（超过 64 KB）、502（模型侧失败 / 空结果）、503（没有可用的模型）。

`GET /api/prompt-enhancer/config` 返回 `{ config, defaults, effectiveModel }`；`POST` 同一路径保存配置（经 config editor）。

## 实现

- 按钮注册在 `conversation.input.right` 插槽，由插件自己的前端入口渲染，没有改动 `@deepseek-ai/dsh-client-ui-conversation` 里的任何东西。
- 草稿读写走插槽 props 的 `useInput` / `inputActions.setDraft`，不碰 DOM。
- 改写是 Host 侧的一次 `llm.stream()` 调用；结果经过去引号、去重复段后处理再返回。
- 控件与样式全部自绘，只用 `--dsw-alias-*` 主题 token，不依赖 primitives 包。
- 界面文案走客户端 locale 服务（内置 zh/en 字典，宿主缺省时回退中文）。

## 兼容性

- 在 DSH `0.2.2-rc.1` 桌面版上开发；`engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`。
- Node ≥ 22.19.0，DeepSeek Harness 自带的 Node 已满足。

## 已知限制（v1）

- 草稿含文件引用芯片（`@文件`）或引用选区（Quote）时不增强：纯文本替换会丢失这些芯片。
- 没有 `export const Config`：配置 schema 不出现在插件管理页，校验由插件代码负责；设置页可在应用内改全部字段。
- Host 侧错误文案为中文；界面标签跟随宿主 locale（zh/en）。

## 开发

```sh
npm test                 # 52 项：Host 27 + Client 25，无需启动 Harness
npm run check:install    # 安装后自检：manifest / patch / exports / 图标 / locale / 源码标记
node scripts/release.cjs --dry-run   # 发布前全流程演练（不发布）
node scripts/release.cjs             # 发布：测试 → 自检 → publish → 拉回线上包再自检
```

发布用 `pnpm`（Harness 运行时自带）或 `npm`：先 `pnpm login` 一次（凭据落在 `~/.npmrc`，脚本不碰它），改完 `package.json` 的 version 再跑 `node scripts/release.cjs`。脚本会把 registry 上的 tarball 拉回来解包，对**发布出来的字节**跑一遍安装自检——防止「本地绿、线上缺文件」。

前端用例用一个最小 hook shim 直接渲染插槽组件，覆盖空输入、三相冻结、含引用拒绝、改写成功、还原、编辑后不还原、失败不改稿、超时、命令保留、超限、卸载中止、连点守卫、设置项注册、开关结构、设置页渲染/保存/拒绝/恢复默认/加载失败、样式清理；Host 用例用假 cordis 上下文覆盖参数、状态码、配置校验、config editor 持久化与缺失路径。

## 许可

MIT
