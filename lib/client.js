window.__ModuleLoader__.load({ id: "dsh-deepseek-web", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/config-page.tsx
/** 本包在 profile 里的 npm 包名。 */
const PACKAGE_NAME = "dsh-deepseek-web";
/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
const ROW_ENTRY_ID = "llm-deepseek-web";
/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`;
/**
* 配置页暴露的字段集合。
*
* 只列真正需要在部署间调整的项；安全不变量（如协议常量）与纯代码常量不在此列。
* 未在此列出的字段仍可通过 profile 的 `cordis.patch.yml` 覆盖。
*/
const FIELDS = [
	{
		path: ["browser"],
		label: "浏览器连接模式",
		hint: "managed = 插件启动独立浏览器；attach = 连接外部 CDP 浏览器。",
		kind: "select",
		options: ["managed", "attach"]
	},
	{
		path: ["channel"],
		label: "独立浏览器类型",
		hint: "仅 managed 模式生效；使用已安装的真实 Edge 或 Chrome。",
		kind: "select",
		options: ["msedge", "chrome"]
	},
	{
		path: ["profileDir"],
		label: "独立浏览器 profile",
		hint: "留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile。",
		kind: "text"
	},
	{
		path: ["review", "enabled"],
		label: "启用审核",
		hint: "交付前用审核器复核最终正文；中间工具轮次不审。",
		kind: "boolean"
	},
	{
		path: ["review", "provider"],
		label: "审核器",
		hint: "独立窗口审核（Kimi / GLM）需要对应浏览器已登录。",
		kind: "select",
		options: [
			"deepseek-web",
			"kimi",
			"glm"
		]
	},
	{
		path: ["review", "maxRounds"],
		label: "单任务审核轮数",
		hint: "未通过时回注意见修正，最多这么多轮。",
		kind: "number",
		min: 0,
		max: 10
	},
	{
		path: ["model"],
		label: "网页版模型入口",
		kind: "select",
		options: ["deepseek-web", "deepseek-web-auto"]
	},
	{
		path: ["sendMode"],
		label: "发送模式",
		hint: "manual = 每条消息填入后由你点击发送；approved 为预留。",
		kind: "select",
		options: ["manual", "approved"]
	},
	{
		path: ["liveThinking"],
		label: "显示网页思考过程",
		hint: "默认关闭，只返回最终正文或工具调用；开启后展示网页真实思考，不重复展示正文。此设置不改变网页的思考模式。",
		kind: "boolean"
	},
	{
		path: ["rateLimit", "enabled"],
		label: "频控自动重发",
		hint: "网页提示「发送过于频繁」时等待后自动重发同一条。",
		kind: "boolean"
	},
	{
		path: ["rateLimit", "retryDelayMs"],
		label: "重发等待（毫秒）",
		kind: "number",
		min: 1e3
	},
	{
		path: ["rateLimit", "maxRetries"],
		label: "单轮最大重发次数",
		kind: "number",
		min: 0,
		max: 20
	},
	{
		path: ["toolAllowlist"],
		label: "工具白名单",
		hint: "每行一个；支持 `mcp__xxx__*` 前缀通配。留空表示不限制。",
		kind: "list"
	},
	{
		path: ["excludeToolNames"],
		label: "工具排除名单",
		hint: "每行一个；在白名单之后生效。",
		kind: "list"
	},
	{
		path: ["delegatedTools"],
		label: "委托工具",
		hint: "每行一个；只写进提示词交给网页端自带能力，不在本地执行。",
		kind: "list"
	},
	{
		path: ["focus", "enabled"],
		label: "窗口自动聚焦",
		kind: "boolean"
	},
	{
		path: ["focus", "webWindow"],
		label: "　└ 填入时聚焦网页窗口",
		kind: "boolean"
	},
	{
		path: ["focus", "dshWindow"],
		label: "　└ 回合结束时聚焦 dsh 窗口",
		kind: "boolean"
	},
	{
		path: ["protocolEveryRequest"],
		label: "每轮都注入协议",
		hint: "开启后每条消息都带完整控制协议；代价是提示词更长。",
		kind: "boolean"
	},
	{
		path: ["protocolRefreshEvery"],
		label: "协议刷新间隔（轮）",
		hint: "未开启「每轮都注入」时，每隔这么多轮重新注入一次控制协议快照。",
		kind: "number",
		min: 1
	},
	{
		path: ["maxToolResultChars"],
		label: "工具结果输入上限（字符）",
		hint: "只限制送入网页模型的工具结果；最终正文和网页委托结果完整展示。",
		kind: "number",
		min: 256
	},
	{
		path: ["url"],
		label: "DeepSeek 网页地址",
		kind: "text"
	},
	{
		path: ["debugPort"],
		label: "CDP 调试端口",
		hint: "attach 模式使用此端口；managed 模式把它作为首选端口，冲突时自动选择空闲端口。",
		kind: "number",
		min: 1024,
		max: 65535
	}
];
/** 按路径读取嵌套值；任一段缺失返回 undefined。 */
function readPath(source, path) {
	let node = source;
	for (const key of path) {
		if (node === null || typeof node !== "object") return void 0;
		node = node[key];
	}
	return node;
}
/** 把列表字段的草稿写回数组。 */
function parseList(raw) {
	return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}
/** 是否相等（配置值都是 JSON 形状，按序列化比较足够）。 */
function sameValue(left, right) {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
const labelStyle = {
	display: "block",
	fontSize: 13,
	lineHeight: "20px",
	marginBottom: 4
};
const hintStyle = {
	fontSize: 12,
	lineHeight: "18px",
	opacity: .7,
	margin: "2px 0 0"
};
const rowStyle = {
	marginBottom: 14,
	maxWidth: 560
};
const inputStyle = {
	font: "inherit",
	padding: "6px 8px",
	width: "100%",
	boxSizing: "border-box"
};
/**
* 渲染本插件的配置页。
*
* @param props - 槽位宿主传入的 `view` 与页面表单句柄。
* @returns `summary` 为卡片一行说明；`page` 为可编辑表单。
*/
function DeepSeekWebConfigPage({ view, form }) {
	const [draft, setDraft] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: "审核通道、网页版模型入口、工具白名单、频控与窗口聚焦。" });
	const accepted = form?.state.value ?? {};
	const revision = form?.state.revision;
	const writable = form?.state.writable === true && form?.state.mode === "host";
	const current = draft ?? accepted;
	/** 暂存一次字段修改。 */
	const edit = (path, value) => {
		setNotice(null);
		setDraft((previous) => {
			const next = { ...previous ?? accepted };
			let node = next;
			for (const key of path.slice(0, -1)) {
				const existing = node[key];
				const child = existing !== null && typeof existing === "object" ? { ...existing } : {};
				node[key] = child;
				node = child;
			}
			node[path[path.length - 1]] = value;
			return next;
		});
	};
	/** 提交与本页字段相关的全部改动。 */
	const save = async () => {
		if (!form || draft === null) return;
		const ops = FIELDS.flatMap((field) => {
			const next = readPath(draft, field.path);
			if (sameValue(next, readPath(accepted, field.path))) return [];
			return [{
				op: "set",
				path: [...field.path],
				value: next ?? null
			}];
		});
		if (ops.length === 0) {
			setNotice("没有改动。");
			return;
		}
		setBusy(true);
		try {
			const ok = await form.mutate(ops, revision);
			setNotice(ok ? "已保存。" : "保存被宿主拒绝，已恢复宿主值。");
			if (ok) setDraft(null);
		} catch (error) {
			setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setBusy(false);
		}
	};
	if (form === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: hintStyle,
		children: "宿主未提供该条目的配置句柄，无法在此编辑。"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
		style: hintStyle,
		children: [
			"宿主的 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "formFor()" }),
			" 只在 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "settings.describe().namespaces" }),
			"含 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
				"ns === '",
				ROW_ENTRY_ID,
				"'"
			] }),
			" 时给出表单，而该清单只收录 Config 里标了 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".volatile()" }),
			" 的字段所在的条目。 若此提示仍出现，请确认该 entry 的 id、以及其字段是否都标了 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".volatile()" }),
			"； 亦可改走 profile 的 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "cordis.patch.yml" }),
			" 覆盖 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "config" }),
			"。"
		]
	})] });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		!writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: {
				...hintStyle,
				marginBottom: 12
			},
			children: "当前部署不接受写入（只读或非 Host 持久化），字段仅供参考；请改用 profile 的 cordis.patch.yml。"
		}),
		FIELDS.map((field) => {
			const value = readPath(current, field.path);
			const id = field.path.join(".");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						style: labelStyle,
						htmlFor: id,
						children: field.label
					}),
					field.kind === "boolean" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "checkbox",
						disabled: !writable,
						checked: value === true,
						onChange: (event) => edit(field.path, event.target.checked)
					}),
					field.kind === "select" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						id,
						style: inputStyle,
						disabled: !writable,
						value: typeof value === "string" ? value : "",
						onChange: (event) => edit(field.path, event.target.value),
						children: (field.options ?? []).map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option,
							children: option
						}, option))
					}),
					field.kind === "number" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "number",
						style: inputStyle,
						disabled: !writable,
						min: field.min,
						max: field.max,
						value: typeof value === "number" ? String(value) : "",
						onChange: (event) => {
							const raw = event.target.value;
							edit(field.path, raw === "" ? void 0 : Number(raw));
						}
					}),
					field.kind === "text" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "text",
						style: inputStyle,
						disabled: !writable,
						value: typeof value === "string" ? value : "",
						onChange: (event) => edit(field.path, event.target.value)
					}),
					field.kind === "list" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						id,
						style: {
							...inputStyle,
							minHeight: 88,
							fontFamily: "monospace"
						},
						disabled: !writable,
						value: Array.isArray(value) ? value.filter((item) => typeof item === "string").join("\n") : "",
						onChange: (event) => edit(field.path, parseList(event.target.value))
					}),
					field.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: hintStyle,
						children: field.hint
					})
				]
			}, id);
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				marginTop: 20
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: !writable || busy || draft === null,
					onClick: () => {
						save();
					},
					children: busy ? "保存中…" : "保存"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy || draft === null,
					onClick: () => {
						setDraft(null);
						setNotice(null);
					},
					children: "放弃修改"
				}),
				notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: hintStyle,
					children: notice
				})
			]
		})
	] });
}

//#endregion
//#region src/client/conversation-recovery.ts
/** 会话列表变化后第一次自检的延迟。 */
const FIRST_CHECK_MS = 600;
/** 事件落地后自检的延迟。 */
const FEED_CHECK_MS = 400;
/** 激活后复查的延迟。 */
const RETRY_CHECK_MS = 2e3;
function monitorConversationBlank(ctx) {
	const timers = /* @__PURE__ */ new Set();
	/** sessionId → 事件源退订函数；只为当前持有 binding 的会话建立。 */
	const watched = /* @__PURE__ */ new Map();
	const conversationOf = (sessionId) => {
		try {
			return ctx.uiConversation.binding(sessionId);
		} catch {
			return;
		}
	};
	const schedule = (fn, delay) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, delay);
		timers.add(timer);
	};
	/** chat 视图快照；undefined = 目标从未构建。 */
	const chatSnapshotOf = (sessionId) => {
		const conversation = conversationOf(sessionId);
		if (conversation === void 0) return void 0;
		try {
			return conversation.snapshot.getSnapshot().views.get("chat");
		} catch {
			return;
		}
	};
	const isRendered = (sessionId) => {
		const chat = chatSnapshotOf(sessionId);
		return chat !== void 0 && (chat.order?.length ?? 0) > 0;
	};
	/**
	* 核心自愈：会话确有内容、不是从未使用的空会话、而 chat 视图未渲染时，
	* 补激活 chat 目标；激活后仍未渲染（快照构建了但内容为空）再 rebuild 一次。
	* activate 幂等：视图已正常时是无害空操作；非活动会话在建 binding 前就返回。
	*/
	const ensureRendered = (sessionId) => {
		try {
			const binding = ctx.sessions.binding(sessionId);
			if (binding === void 0) return;
			if (binding.eventSource.getSnapshot().entries.length === 0) return;
			if (binding.session.getSnapshot().blank === true) return;
			if (isRendered(sessionId)) return;
			const conversation = conversationOf(sessionId);
			if (conversation === void 0) return;
			conversation.activate("chat");
			try {
				conversation.flush();
			} catch (error) {
				console.warn("[deepseek-web] 强制 flush 失败：", error);
			}
			schedule(() => {
				if (isRendered(sessionId)) return;
				console.info("[deepseek-web] 激活后仍未渲染，重建对话视图快照…");
				try {
					conversation.rebuild();
					conversation.flush();
				} catch (error) {
					console.warn("[deepseek-web] 重建失败：", error);
				}
			}, RETRY_CHECK_MS);
		} catch (error) {
			console.warn("[deepseek-web] 对话视图自检失败：", error);
		}
	};
	/**
	* 把订阅集合对齐到“列表里可见且已持有 Session binding”的会话：
	* 新增订阅，消失的退订。没有当前会话信号，就用“有 binding”近似“可能正在显示”。
	*/
	const syncWatches = () => {
		const ids = new Set(ctx.sessions.list.getSnapshot().ids);
		for (const [sessionId, unsubscribe] of [...watched]) {
			if (ids.has(sessionId)) continue;
			unsubscribe();
			watched.delete(sessionId);
		}
		for (const sessionId of ids) {
			if (watched.has(sessionId)) continue;
			const binding = ctx.sessions.binding(sessionId);
			if (binding === void 0) continue;
			watched.set(sessionId, binding.eventSource.subscribe(() => {
				schedule(() => ensureRendered(sessionId), FEED_CHECK_MS);
			}));
		}
	};
	ctx.effect(() => {
		const listUnsubscribe = ctx.sessions.list.subscribe(() => {
			syncWatches();
			for (const sessionId of [...watched.keys()]) schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS);
		});
		syncWatches();
		for (const sessionId of [...watched.keys()]) schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS);
		return () => {
			listUnsubscribe();
			for (const unsubscribe of watched.values()) unsubscribe();
			watched.clear();
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		};
	}, "dsh-deepseek-web: conversation blank recovery");
}

//#endregion
//#region src/client/index.ts
/** Services this client module needs from the page's client context. */
const inject = [
	"slots",
	"sessions",
	"uiConversation"
];
/**
* Register the plugin's configuration page and the conversation-view safeguard.
* @param ctx - the client context.
*/
function apply(ctx) {
	ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
		name: "plugins.row.config",
		key: ROW_CONFIG_KEY
	}, DeepSeekWebConfigPage));
	monitorConversationBlank(ctx);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map