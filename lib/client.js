window.__ModuleLoader__.load({ id: "dsh-deepseek-web-littlecar30", factory: (require) => {
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

//#region src/client/config-form.ts
const CONFIG_FIELDS = [
	{
		key: "sendMode",
		label: "消息发送方式",
		hint: "可覆盖宿主当前选择的模型入口，保存后从下一轮消息生效。",
		kind: "choice",
		defaultValue: "model",
		options: [
			{
				value: "model",
				label: "跟随模型入口",
				hint: "按 dsh 中选择的入口决定是否自动发送"
			},
			{
				value: "manual",
				label: "半自动发送",
				hint: "填好内容后，由你在网页点击发送"
			},
			{
				value: "auto",
				label: "全自动发送",
				hint: "填入消息后自动发送，连续执行任务"
			}
		]
	},
	{
		key: "liveThinking",
		label: "显示网页思考过程",
		hint: "在对话中展开网页的真实思考过程；关闭后只展示结果。",
		kind: "boolean",
		defaultValue: false
	},
	{
		key: "compactionLanguage",
		label: "长任务摘要语言",
		hint: "长对话压缩时，接续摘要使用的语言。",
		kind: "choice",
		defaultValue: "task",
		options: [
			{
				value: "task",
				label: "跟随任务"
			},
			{
				value: "zh",
				label: "中文"
			},
			{
				value: "en",
				label: "English"
			},
			{
				value: "host",
				label: "跟随 dsh"
			}
		]
	},
	{
		key: "browser",
		label: "浏览器连接方式",
		hint: "保存后重启 dsh 生效，当前浏览器连接会继续保留。",
		kind: "choice",
		defaultValue: "managed",
		options: [{
			value: "managed",
			label: "独立浏览器",
			hint: "插件自动启动，单独保存登录状态"
		}, {
			value: "attach",
			label: "已有浏览器",
			hint: "连接已开启远程调试的浏览器"
		}]
	},
	{
		key: "channel",
		label: "使用的浏览器",
		kind: "choice",
		defaultValue: "msedge",
		options: [{
			value: "msedge",
			label: "Microsoft Edge"
		}, {
			value: "chrome",
			label: "Google Chrome"
		}]
	},
	{
		key: "profileDir",
		label: "浏览器数据目录",
		hint: "留空使用默认目录，保留网页登录状态。更改后使用新的目录。",
		kind: "text",
		defaultValue: ""
	},
	{
		key: "review.enabled",
		label: "交付前审核",
		hint: "最终结果交付前复核一次，工具执行过程不触发审核。",
		kind: "boolean",
		defaultValue: false
	},
	{
		key: "review.provider",
		label: "审核通道",
		kind: "choice",
		defaultValue: "kimi",
		options: [
			{
				value: "deepseek-web",
				label: "DeepSeek 自审",
				hint: "沿用当前对话，无需额外登录"
			},
			{
				value: "kimi",
				label: "Kimi",
				hint: "独立窗口，需要登录 Kimi"
			},
			{
				value: "glm",
				label: "GLM",
				hint: "独立窗口，需要登录 GLM"
			}
		]
	},
	{
		key: "review.maxRounds",
		label: "最多审核轮数",
		hint: "未通过时将意见交回修正；设为 0 跳过审核。",
		kind: "number",
		defaultValue: 1,
		min: 0,
		max: 10,
		unit: "轮"
	},
	{
		key: "rateLimit.enabled",
		label: "频控后自动重试",
		hint: "网页提示发送过于频繁时，等待后重发同一条消息。",
		kind: "boolean",
		defaultValue: true
	},
	{
		key: "rateLimit.retryDelayMs",
		label: "重试等待时间",
		kind: "number",
		defaultValue: 3e4,
		min: 1e3,
		unit: "毫秒"
	},
	{
		key: "rateLimit.maxRetries",
		label: "单轮重试上限",
		kind: "number",
		defaultValue: 5,
		min: 0,
		max: 20,
		unit: "次"
	},
	{
		key: "focus.enabled",
		label: "自动切换窗口",
		hint: "填入消息时切到网页，完成后回到 dsh。",
		kind: "boolean",
		defaultValue: true
	},
	{
		key: "focus.webWindow",
		label: "填入消息时切到网页",
		kind: "boolean",
		defaultValue: true
	},
	{
		key: "focus.dshWindow",
		label: "完成后回到 dsh",
		kind: "boolean",
		defaultValue: true
	},
	{
		key: "toolAllowlist",
		label: "允许使用的工具",
		hint: "留空允许全部宿主工具。支持前缀通配，例如 mcp__server__*。",
		kind: "list",
		defaultValue: []
	},
	{
		key: "excludeToolNames",
		label: "排除的工具",
		hint: "即使已加入允许列表，这些工具也不会交给网页模型。",
		kind: "list",
		defaultValue: ["web_search"]
	},
	{
		key: "delegatedTools",
		label: "由网页完成的工具",
		hint: "交由网页自身能力处理；这里的工具不会在本地执行。",
		kind: "list",
		defaultValue: ["web_search", "web_fetch"]
	},
	{
		key: "protocolEveryRequest",
		label: "每轮刷新工具协议",
		hint: "网页容易忘记工具规则时开启，会增加每轮输入长度。",
		kind: "boolean",
		defaultValue: false
	},
	{
		key: "protocolRefreshEvery",
		label: "协议刷新间隔",
		kind: "number",
		defaultValue: 8,
		min: 1,
		unit: "轮"
	},
	{
		key: "maxToolResultChars",
		label: "工具结果输入上限",
		hint: "超过上限的本地工具结果保留头尾；最终回复仍完整展示。",
		kind: "number",
		defaultValue: 6e3,
		min: 256,
		unit: "字符"
	},
	{
		key: "url",
		label: "DeepSeek 网页地址",
		kind: "text",
		defaultValue: "https://chat.deepseek.com"
	},
	{
		key: "debugPort",
		label: "浏览器调试端口",
		hint: "连接已有浏览器时须与其端口一致；独立浏览器遇到占用会自动换用空闲端口。",
		kind: "number",
		defaultValue: 9333,
		min: 1024,
		max: 65535
	}
];
function readConfigPath(source, key) {
	let current = source;
	for (const part of key.split(".")) {
		if (current === null || typeof current !== "object") return void 0;
		current = current[part];
	}
	return current;
}
function fieldValue(source, field) {
	const value = readConfigPath(source, field.key) ?? field.defaultValue;
	return field.key === "sendMode" && value === "approved" ? "model" : value;
}
function editConfig(draft, accepted, revision, key, value) {
	return {
		base: draft?.base ?? accepted,
		revision: draft ? draft.revision : revision,
		edits: {
			...draft?.edits,
			[key]: value
		}
	};
}
/** Keep raw number/list input while typing; normalize only at the persistence boundary. */
function normalizeField(field, raw) {
	if (field.kind === "number") return typeof raw === "string" && raw.trim() === "" ? void 0 : Number(raw);
	if (field.kind === "list" && typeof raw === "string") return [...new Set(raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
	return raw;
}
function validateField(field, raw) {
	const value = normalizeField(field, raw);
	if (field.kind === "number" && (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))) return "请输入完整的整数。";
	if (typeof value === "number" && field.min !== void 0 && value < field.min) return `不能小于 ${field.min}。`;
	if (typeof value === "number" && field.max !== void 0 && value > field.max) return `不能大于 ${field.max}。`;
	if (field.kind === "choice" && !field.options?.some((option) => option.value === value)) return "请选择有效的选项。";
	if (field.key === "url") try {
		if (!["https:", "http:"].includes(new URL(String(value)).protocol)) return "请输入 http 或 https 网页地址。";
	} catch {
		return "请输入完整的网页地址。";
	}
}
function draftErrors(draft) {
	return Object.fromEntries(CONFIG_FIELDS.flatMap((field) => {
		if (!draft || !Object.hasOwn(draft.edits, field.key)) return [];
		const error = validateField(field, draft.edits[field.key]);
		return error ? [[field.key, error]] : [];
	}));
}
function draftOperations(draft) {
	if (!draft) return [];
	return CONFIG_FIELDS.flatMap((field) => {
		if (!Object.hasOwn(draft.edits, field.key) || validateField(field, draft.edits[field.key])) return [];
		const value = normalizeField(field, draft.edits[field.key]);
		if (JSON.stringify(value) === JSON.stringify(fieldValue(draft.base, field))) return [];
		return [{
			op: "set",
			path: field.key.split("."),
			value
		}];
	});
}

//#endregion
//#region src/client/config-page-style.ts
/** Scoped styles: the host provides React, no additional stylesheet loader is required. */
const CONFIG_PAGE_STYLE = `
.dsw-settings{--dsw-bg:var(--dsw-alias-bg-base,#fff);--dsw-ink:var(--dsw-alias-label-primary,#223043);--dsw-muted:var(--dsw-alias-label-secondary,#697586);--dsw-line:var(--dsw-alias-border-l3,#e4e8ec);--dsw-soft:var(--dsw-alias-bg-module-platform,#f6f8fa);--dsw-accent:#148577;--dsw-tint:#edf8f5;color:var(--dsw-ink);font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:6px 2px 20px;box-sizing:border-box;color-scheme:light dark}
.dsw-settings *{box-sizing:border-box}.dsw-settings button,.dsw-settings input,.dsw-settings textarea{font:inherit}.dsw-settings button{cursor:pointer}.dsw-settings button:disabled{cursor:default;opacity:.48}.dsw-settings :is(button,input,textarea,summary):focus-visible{outline:3px solid #68bcb1;outline-offset:3px}.dsw-settings input:disabled,.dsw-settings textarea:disabled{opacity:.55}.dsw-settings h2,.dsw-settings h3,.dsw-settings p{margin:0}.dsw-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin:0 0 24px}.dsw-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.8px;color:var(--dsw-accent);margin-bottom:5px!important}.dsw-heading h2{font-size:26px;line-height:1.35;letter-spacing:-.8px;font-weight:650}.dsw-heading p:last-child{color:var(--dsw-muted);font-size:13px;margin-top:7px}.dsw-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-line);border-radius:20px;font-size:12px;white-space:nowrap;padding:5px 10px;margin-top:6px;color:var(--dsw-muted)}.dsw-dot{height:6px;width:6px;background:var(--dsw-accent);border-radius:50%}.dsw-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}.dsw-card{background:var(--dsw-bg);border:1px solid var(--dsw-line);border-radius:16px;padding:21px;min-width:0}.dsw-wide{grid-column:1/-1}.dsw-section-title{display:flex;align-items:center;gap:10px;margin-bottom:19px}.dsw-section-title h3{font-size:15px;font-weight:650}.dsw-section-title p{font-size:12px;color:var(--dsw-muted);margin-top:1px}.dsw-icon{width:32px;height:32px;display:grid;place-items:center;border-radius:10px;background:var(--dsw-tint);color:var(--dsw-accent);font-size:16px;flex-shrink:0}.dsw-field+.dsw-field{margin-top:19px}.dsw-label{display:block;font-size:13px;font-weight:550;line-height:1.5}.dsw-hint{font-size:12px;color:var(--dsw-muted);line-height:1.65;margin-top:5px!important}.dsw-choice-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.dsw-choice{flex:1;min-width:100px;text-align:left;border:1px solid var(--dsw-line);border-radius:10px;padding:10px 12px;background:var(--dsw-bg);color:var(--dsw-ink);transition:border-color .15s,background .15s}.dsw-choice[aria-pressed=true]{border-color:var(--dsw-accent);background:var(--dsw-tint);box-shadow:inset 0 0 0 1px var(--dsw-accent)}.dsw-choice-title{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;font-weight:550}.dsw-choice-check{color:var(--dsw-accent);height:16px;min-width:12px}.dsw-choice-hint{display:block;font-size:11px;color:var(--dsw-muted);line-height:1.55;margin-top:5px}.dsw-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.dsw-toggle-copy{flex:1}.dsw-toggle{position:relative;width:36px;height:21px;border:0;border-radius:20px;padding:0;flex-shrink:0;background:#b3bdc5;transition:background .15s}.dsw-toggle[aria-checked=true]{background:var(--dsw-accent)}.dsw-toggle span{display:block;position:absolute;width:15px;height:15px;left:3px;top:3px;background:#fff;box-shadow:0 1px 3px #0002;border-radius:50%;transition:transform .15s}.dsw-toggle[aria-checked=true] span{transform:translateX(15px)}.dsw-divider{height:1px;background:var(--dsw-line);margin:19px 0}.dsw-subsection{border-left:2px solid var(--dsw-line);margin-top:17px;padding-left:15px}.dsw-input{display:block;width:100%;border:1px solid var(--dsw-line);border-radius:8px;color:var(--dsw-ink);background:var(--dsw-bg);padding:8px 10px;margin-top:8px;min-height:37px}.dsw-input[aria-invalid=true]{border-color:#c44848}.dsw-number{display:flex;align-items:center;gap:9px;margin-top:8px}.dsw-number .dsw-input{width:105px;margin:0;text-align:center;appearance:textfield;-moz-appearance:textfield}.dsw-number .dsw-input::-webkit-inner-spin-button{appearance:none}.dsw-step{border:1px solid var(--dsw-line);background:var(--dsw-bg);color:var(--dsw-ink);height:36px;width:33px;border-radius:8px;font-size:18px!important}.dsw-unit{font-size:12px;color:var(--dsw-muted)}.dsw-error{font-size:12px;color:#c44848;margin-top:5px!important}.dsw-empty{font-size:12px;color:var(--dsw-muted);padding:13px 15px;border:1px dashed var(--dsw-line);border-radius:10px;margin-top:15px!important;background:var(--dsw-soft)}.dsw-tools{display:grid;grid-template-columns:1fr 1fr;gap:22px}.dsw-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.dsw-chip{background:var(--dsw-soft);border:1px solid var(--dsw-line);border-radius:6px;padding:2px 7px;color:var(--dsw-muted);font:11px/1.8 ui-monospace,Consolas,monospace;overflow-wrap:anywhere;max-width:100%}.dsw-list-editor{margin-top:9px}.dsw-list-editor summary{font-size:12px;color:var(--dsw-accent);cursor:pointer;display:list-item;list-style-position:inside;width:fit-content}.dsw-list-editor textarea{resize:vertical;min-height:104px;font:12px/1.8 ui-monospace,Consolas,monospace}.dsw-link{border:0;background:transparent;color:var(--dsw-accent);font-size:12px!important;margin-top:7px;padding:0;text-decoration:underline}.dsw-advanced{grid-column:1/-1;border:1px solid var(--dsw-line);border-radius:14px;background:var(--dsw-bg)}.dsw-advanced>summary{padding:16px 21px;cursor:pointer;list-style-position:inside;font-size:13px;font-weight:550}.dsw-advanced>summary span{font-weight:400;font-size:12px;color:var(--dsw-muted);margin-left:10px}.dsw-advanced-body{padding:2px 21px 22px;display:grid;grid-template-columns:1fr 1fr;gap:24px}.dsw-alert{padding:12px 15px;border:1px solid #d7b977;border-radius:10px;background:#fff8e9;color:#805b16;font-size:12px;margin-bottom:16px}.dsw-alert button{border:0;background:transparent;color:inherit;text-decoration:underline;padding:0;font-size:12px;margin-left:8px}.dsw-footer{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;padding:14px 0 6px;background:var(--dsw-bg);border-top:1px solid var(--dsw-line)}.dsw-footer-status{font-size:12px;color:var(--dsw-muted)}.dsw-footer-actions{display:flex;gap:8px;flex-shrink:0}.dsw-button{border:1px solid var(--dsw-line);border-radius:8px;background:var(--dsw-bg);color:var(--dsw-ink);padding:8px 15px;font-size:12px!important;font-weight:550}.dsw-primary{background:var(--dsw-accent);border-color:var(--dsw-accent);color:white}.dsw-readonly .dsw-dot{background:#9aa3ad}
@media(prefers-color-scheme:dark){.dsw-settings{--dsw-bg:var(--dsw-alias-bg-base,#1e2329);--dsw-ink:var(--dsw-alias-label-primary,#e3e8ed);--dsw-muted:var(--dsw-alias-label-secondary,#a0abb6);--dsw-line:var(--dsw-alias-border-l3,#3b434c);--dsw-soft:var(--dsw-alias-bg-module-platform,#272e36);--dsw-accent:#53b9a8;--dsw-tint:#213a36}.dsw-alert{background:#3a3121;color:#ebd29e;border-color:#6d5935}.dsw-primary{color:#112d27}}
@media(max-width:650px){.dsw-layout,.dsw-tools,.dsw-advanced-body{grid-template-columns:1fr}.dsw-settings{padding:2px 0 12px}.dsw-card{padding:17px}.dsw-heading{margin-bottom:18px}.dsw-heading h2{font-size:23px}.dsw-badge{display:none}.dsw-footer{align-items:flex-start;flex-direction:column;gap:10px}.dsw-footer-actions{width:100%}.dsw-footer-actions .dsw-primary{flex:1}.dsw-advanced>summary span{display:block;margin:4px 0 0 15px}.dsw-advanced-body{gap:19px}}
`;

//#endregion
//#region src/client/config-page.tsx
const PACKAGE_NAME = "dsh-deepseek-web-littlecar30";
const ROW_ENTRY_ID = "llm-deepseek-web";
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`;
function Section({ icon, title, description, wide, children }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `dsw-card${wide ? " dsw-wide" : ""}`,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsw-section-title",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsw-icon",
				"aria-hidden": "true",
				children: icon
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: description })] })]
		}), children]
	});
}
function DeepSeekWebConfigPage({ view, form }) {
	const instanceId = (0, react.useId)();
	const [draft, setDraft] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: "选择发送方式、浏览器与审核通道，管理工具和重试偏好。" });
	const accepted = form?.state.value ?? {};
	const revision = form?.state.revision;
	const writable = form?.state.writable === true && form.state.mode === "host";
	const conflict = draft !== null && draft.revision !== revision;
	const errors = draftErrors(draft);
	const changes = draftOperations(draft);
	const invalid = Object.keys(errors).length > 0;
	const value = (key) => {
		const field = CONFIG_FIELDS.find((field$1) => field$1.key === key);
		return draft && Object.hasOwn(draft.edits, key) ? draft.edits[key] : fieldValue(draft?.base ?? accepted, field);
	};
	const edit = (key, next) => {
		if (!writable || busy) return;
		setNotice(null);
		setDraft((previous) => editConfig(previous, accepted, form.state.revision, key, next));
	};
	const reset = () => {
		setDraft(null);
		setNotice(null);
	};
	const save = async () => {
		if (!form || !draft || !writable || busy || invalid || conflict || changes.length === 0) return;
		setBusy(true);
		setNotice(null);
		try {
			if (await form.mutate(changes, draft.revision)) {
				setDraft(null);
				setNotice("已保存。连接设置需重启 dsh 后生效。");
			} else setNotice("宿主未接受修改。草稿已保留，请检查配置或重新载入。");
		} catch (error) {
			setNotice(`保存失败，草稿已保留：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setBusy(false);
		}
	};
	const renderField = (key) => {
		const field = CONFIG_FIELDS.find((field$1) => field$1.key === key);
		const current = value(key);
		const id = `${instanceId}-${key}`;
		const error = errors[key];
		const disabled = !writable || busy;
		const hint = field.hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "dsw-hint",
			id: `${id}-hint`,
			children: field.hint
		});
		const describedBy = [field.hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || void 0;
		let control;
		if (field.kind === "boolean") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsw-field dsw-toggle-row",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsw-toggle-copy",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					className: "dsw-label",
					htmlFor: id,
					children: field.label
				}), hint]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				id,
				type: "button",
				role: "switch",
				"aria-checked": current === true,
				"aria-describedby": describedBy,
				"aria-label": field.label,
				className: "dsw-toggle",
				disabled,
				onClick: () => edit(key, current !== true),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
			})]
		}, key);
		if (field.kind === "choice") control = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "dsw-choice-grid",
			role: "group",
			"aria-labelledby": `${id}-label`,
			"aria-describedby": describedBy,
			children: field.options?.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dsw-choice",
				"aria-pressed": current === option.value,
				disabled,
				onClick: () => edit(key, option.value),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dsw-choice-title",
					children: [option.label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsw-choice-check",
						"aria-hidden": "true",
						children: current === option.value ? "✓" : ""
					})]
				}), option.hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsw-choice-hint",
					children: option.hint
				})]
			}, option.value))
		});
		else if (field.kind === "number") {
			const numeric = Number(current);
			const step = key.endsWith("Ms") ? 1e3 : key === "maxToolResultChars" ? 1e3 : 1;
			control = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsw-number",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsw-step",
						"aria-label": `减少${field.label}`,
						disabled: disabled || !Number.isFinite(numeric) || numeric <= (field.min ?? -Infinity),
						onClick: () => edit(key, Math.max(field.min ?? -Infinity, numeric - step)),
						children: "−"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						className: "dsw-input",
						type: "number",
						inputMode: "numeric",
						step: 1,
						min: field.min,
						max: field.max,
						value: String(current ?? ""),
						"aria-describedby": describedBy,
						"aria-invalid": Boolean(error),
						disabled,
						onChange: (event) => edit(key, event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsw-step",
						"aria-label": `增加${field.label}`,
						disabled: disabled || !Number.isFinite(numeric) || numeric >= (field.max ?? Infinity),
						onClick: () => edit(key, Math.min(field.max ?? Infinity, numeric + step)),
						children: "+"
					}),
					field.unit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsw-unit",
						children: field.unit
					})
				]
			});
		} else if (field.kind === "list") {
			const raw = Array.isArray(current) ? current.join("\n") : String(current ?? "");
			const items = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
			control = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsw-chips",
					children: items.length ? items.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsw-chip",
						children: item
					}, `${item}-${index}`)) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsw-hint",
						children: key === "toolAllowlist" ? "全部宿主工具" : "未设置"
					})
				}),
				key === "toolAllowlist" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsw-link",
					disabled: disabled || items.length === 0,
					onClick: () => edit(key, []),
					children: "使用宿主全部工具"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
					className: "dsw-list-editor",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: "编辑工具列表" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "dsw-hint",
							htmlFor: id,
							children: "每行一个工具名称"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							id,
							className: "dsw-input",
							value: raw,
							disabled,
							"aria-describedby": describedBy,
							spellCheck: false,
							onChange: (event) => edit(key, event.target.value)
						})
					]
				})
			] });
		} else control = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			id,
			className: "dsw-input",
			type: key === "url" ? "url" : "text",
			value: String(current ?? ""),
			placeholder: key === "profileDir" ? "使用默认数据目录" : void 0,
			disabled,
			spellCheck: false,
			"aria-invalid": Boolean(error),
			"aria-describedby": describedBy,
			onChange: (event) => edit(key, event.target.value)
		});
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsw-field",
			children: [
				field.kind === "choice" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsw-label",
					id: `${id}-label`,
					children: field.label
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					className: "dsw-label",
					htmlFor: id,
					children: field.label
				}),
				control,
				hint,
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsw-error",
					id: `${id}-error`,
					role: "alert",
					children: error
				})
			]
		}, key);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: `dsw-settings${writable ? "" : " dsw-readonly"}`,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: CONFIG_PAGE_STYLE }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: "dsw-heading",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsw-eyebrow",
						children: "DEEPSEEK WEB"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "让网页配合你的工作方式" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "连接已登录的浏览器，使用 dsh 的任务与工具。" })
				] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dsw-badge",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsw-dot" }), writable ? "设置可编辑" : "当前为只读"]
				})]
			}),
			!form ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsw-alert",
				children: "暂时无法读取配置。请确认插件已启用，并重新打开此页面。"
			}) : !writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsw-alert",
				children: "当前连接不允许保存设置。请在拥有此插件的 dsh 桌面端编辑。"
			}),
			conflict && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsw-alert",
				role: "alert",
				children: ["设置已在其他位置更新。请先重新载入，再编辑和保存。", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy,
					onClick: reset,
					children: "重新载入并放弃草稿"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsw-layout",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						icon: "↗",
						title: "发送与显示",
						description: "决定每轮消息如何发出",
						wide: true,
						children: [
							renderField("sendMode"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsw-divider" }),
							renderField("liveThinking"),
							renderField("compactionLanguage")
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						icon: "▣",
						title: "浏览器连接",
						description: "在熟悉的浏览器里继续工作",
						children: [renderField("browser"), value("browser") === "managed" ? renderField("channel") : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsw-empty",
							children: "请先启动开启远程调试的浏览器，并在高级设置中填写对应端口。"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						icon: "✓",
						title: "交付审核",
						description: "在最终结果交付前，再检查一次",
						children: [renderField("review.enabled"), value("review.enabled") === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsw-subsection",
							children: [renderField("review.provider"), renderField("review.maxRounds")]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsw-empty",
							children: "审核已关闭，网页结果将直接交付。"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						icon: "↻",
						title: "发送重试",
						description: "遇到短暂频控，自动稍后再试",
						children: [renderField("rateLimit.enabled"), value("rateLimit.enabled") === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsw-subsection",
							children: [renderField("rateLimit.retryDelayMs"), renderField("rateLimit.maxRetries")]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						icon: "⇄",
						title: "窗口切换",
						description: "在网页和 dsh 之间自然衔接",
						children: [renderField("focus.enabled"), value("focus.enabled") === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsw-subsection",
							children: [renderField("focus.webWindow"), renderField("focus.dshWindow")]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						icon: "⌘",
						title: "工具范围",
						description: "选择网页模型可以调用的宿主工具，仍遵循 dsh 权限与审批",
						wide: true,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsw-tools",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: renderField("toolAllowlist") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [renderField("excludeToolNames"), renderField("delegatedTools")] })]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "dsw-advanced",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: ["高级设置", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "连接地址、数据目录和长任务参数" })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsw-advanced-body",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								renderField("url"),
								renderField("profileDir"),
								renderField("debugPort")
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								renderField("protocolEveryRequest"),
								value("protocolEveryRequest") !== true && renderField("protocolRefreshEvery"),
								renderField("maxToolResultChars")
							] })]
						})]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
				className: "dsw-footer",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsw-footer-status",
					role: "status",
					"aria-live": "polite",
					children: notice ?? (invalid ? "请修正标红的字段后保存。" : conflict ? "设置有更新，请重新载入。" : changes.length > 0 ? `${changes.length} 项修改尚未保存` : "仅点击保存后生效")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsw-footer-actions",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsw-button",
						disabled: !draft || busy,
						onClick: reset,
						children: "放弃修改"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsw-button dsw-primary",
						disabled: !writable || busy || invalid || conflict || changes.length === 0,
						onClick: () => {
							save();
						},
						children: busy ? "保存中…" : "保存设置"
					})]
				})]
			})
		]
	});
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