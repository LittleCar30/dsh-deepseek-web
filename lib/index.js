import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { readFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

//#region src/web-models.ts
/**
* 网页版模型清单（Host 与 Client 半侧共享的最小事实表）。
* 独立于 config.ts：客户端 bundle 的纯净度门禁禁止把 schemastery 等配置层依赖打进浏览器产物。
*
* @module dsh-deepseek-web/web-models
*/
/**
* 网页版模型清单。DeepSeek 网页端已把极速/专家/识图合并为一个入口，
* 模式与联网开关由页面自身管理。两个 id 的差别在发送方式：
* - deepseek-web：半自动——填入消息后由用户人工点击发送
* - deepseek-web-auto：全自动——填入消息后模拟回车自动发送
*/
const WEB_MODEL_IDS = ["deepseek-web", "deepseek-web-auto"];
const WEB_MODEL_CAPABILITIES = {
	"deepseek-web": {
		thinking: true,
		search: true,
		label: "DeepSeek 网页版（半自动）"
	},
	"deepseek-web-auto": {
		thinking: true,
		search: true,
		label: "DeepSeek 网页版（全自动）"
	}
};

//#endregion
//#region src/config.ts
const PROVIDER = "deepseek-web";
/** 历史模型 id：旧会话仍可能引用，解析时映射回单一入口。 */
const LEGACY_WEB_MODEL_IDS = [
	"deepseek-web-chat",
	"deepseek-web-reasoner",
	"deepseek-web-search"
];
/** 把任意历史模型 id 归一到当前唯一入口；不认识时返回 undefined。 */
function normalizeWebModel(model) {
	if (WEB_MODEL_IDS.includes(model)) return model;
	if (LEGACY_WEB_MODEL_IDS.includes(model)) return "deepseek-web";
}
/**
* 兼容垫片：给 schema 打上 volatile 标记。
*
* `.volatile()` 需要 schemastery ≥ 3.18.4（`Schema.prototype.volatile` 就是
* `extra('volatile', true)`）。当模块解析到 3.18.2（本仓库 vendored 副本、
* 0.1.5 宿主的 node_modules）时该方法不存在，直接链式调用会在模块加载时
* 抛 `volatile is not a function`，插件整体无法启动。这里按可用性降级：
*
* 1. 原生 `.volatile()`（3.18.4+）：完整语义，运行期解析为 `Volatile<T>` 引用，
*    由 `liveConfig()` 在 `apply()` 边界透明化解引用；
* 2. `extra('volatile', true)`（3.18.2 也有）：只设置 `meta.volatile` 标记，
*    值保持普通对象——0.1.5 宿主没有 0.2 的 volatile 投影机制，普通值即正确行为。
*
* dsh 0.2 的设置服务用 `volatileForm()` 只保留 `schema.meta.volatile` 的叶子字段，
* 因此“表单可见的字段必须经本助手标记”这一约定与原生 `.volatile()` 一致。
*/
function markVolatile(schema$1) {
	if (typeof schema$1.volatile === "function") return schema$1.volatile();
	if (typeof schema$1.extra === "function") return schema$1.extra("volatile", true);
	schema$1.meta = {
		...schema$1.meta,
		volatile: true
	};
	return schema$1;
}
/**
* 插件配置 schema。
*
* ⚠️ **表单可见的字段必须经 `markVolatile()` 标记（见上）。**
*
* dsh 0.2 的设置服务在 `SettingsForms.describe()` 里用 `volatileForm()` 过滤字段
* （见 `@deepseek-ai/dsh-settings` 的 `lib/index.js`）：
*
* ```js
* function volatileForm(schema) {
*   if (schema.meta.volatile) return plainSchema(schema);   // 只有 volatile 叶子保留
*   if (schema.type === 'object') { ...递归... }            // 对象含存活子字段则保留
*   // 其余标量 / 数组 / union → undefined，被丢弃
* }
* ```
*
* 被丢弃的字段不会进入表单；若一个 entry 的字段全被丢弃，该 entry 连
* `settings.describe().namespaces` 都不出现，插件配置页拿到的 `form` 就是 `undefined`。
*
* **代价**：原生 `.volatile()` 标记的字段在运行期解析为引用对象（`Volatile<T>`），
* 真值要 `.get()`。本插件在 `apply()` 边界用 `liveConfig()` 的 Proxy 统一透明化，
* 因此内部代码仍按普通值读写，同时保留 Loader 的原地热更新语义。
* 降级路径（`extra` / meta 直标）没有引用对象，`liveConfig()` 原样放行普通值。
*
* 未标记的字段保持普通值，只受 fiber 重启影响；它们不出现在配置页里，
* 需要调整时改 profile 的 `cordis.patch.yml`。
*/
const schema = z.object({
	url: markVolatile(z.string().default("https://chat.deepseek.com")),
	browser: z.union(["managed", "attach"]).default("managed"),
	channel: z.union(["msedge", "chrome"]).default("msedge"),
	debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9333)),
	autoStartKeeper: z.boolean().default(true),
	stateFile: z.string(),
	profileDir: z.string(),
	sendMode: markVolatile(z.union(["manual", "approved"]).default("manual")),
	model: markVolatile(z.union([...WEB_MODEL_IDS]).default("deepseek-web")),
	selectors: z.dict(z.string()),
	streamIdleTimeoutMs: z.number().step(1).min(1).default(6e5),
	rateLimit: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		retryDelayMs: markVolatile(z.number().step(1).min(1e3).default(3e4)),
		maxRetries: markVolatile(z.number().step(1).min(0).default(5))
	}).default({}),
	liveThinking: markVolatile(z.boolean().default(false)),
	maxReplyBytes: z.number().step(1).min(1024).default(4 * 1024 * 1024),
	protocolRefreshEvery: markVolatile(z.number().step(1).min(1).default(8)),
	protocolEveryRequest: markVolatile(z.boolean().default(false)),
	toolAllowlist: markVolatile(z.array(z.string()).default([
		"read",
		"write",
		"edit",
		"str_replace_editor",
		"glob",
		"grep",
		"bash",
		"pwsh",
		"todo_write",
		"mcp__taptap-maker__*"
	])),
	excludeToolNames: markVolatile(z.array(z.string()).default(["web_search"])),
	compactToolCatalog: z.boolean().default(true),
	maxToolResultChars: markVolatile(z.number().step(1).min(256).default(6e3)),
	maxGoalChars: z.number().step(1).min(64).default(2e3),
	focus: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		webWindow: markVolatile(z.boolean().default(true)),
		dshWindow: markVolatile(z.boolean().default(true)),
		dshProcessNames: z.array(z.string()).default([
			"electron",
			"dsh",
			"DeepSeek Harness"
		]),
		dshTitlePattern: z.string().default("DeepSeek Harness|dsh")
	}).default({}),
	review: z.object({
		enabled: markVolatile(z.boolean().default(false)),
		provider: markVolatile(z.union([
			"kimi",
			"deepseek-web",
			"glm"
		]).default("kimi")),
		url: z.string().default("https://www.kimi.com/"),
		debugPort: z.number().step(1).min(1024).max(65535).default(9334),
		profileDir: z.string(),
		streamIdleTimeoutMs: z.number().step(1).min(1).default(6e5),
		maxEvidenceChars: z.number().step(1).min(1e3).default(6e4),
		maxRounds: markVolatile(z.number().step(1).min(0).default(1)),
		glmUrl: z.string().default("https://chat.z.ai/"),
		glmDebugPort: z.number().step(1).min(1024).max(65535).default(9335),
		glmProfileDir: z.string()
	}).default({}),
	autoCorrectMalformed: z.boolean().default(true),
	delegatedTools: markVolatile(z.array(z.string()).default(["web_search", "web_fetch"]))
});
/**
* Loader 面向的 schema。标了 `.volatile()` 的字段在该类型里其实是 `Volatile<T>`；
* 这里断言成普通值形状，因为 `apply()` 边界会用 `liveConfig()` 把它还原成普通对象。
*/
const Config = schema;

//#endregion
//#region src/live-config.ts
/** 是否是一个 schemastery volatile 引用。 */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* 返回一个按普通值读取的配置视图。
*
* @param value - Loader 传入的配置（含 volatile 引用）。
* @returns 读取时自动解引用的等价配置。
*/
function liveConfig(value) {
	if (isVolatileRef(value)) return liveConfig(value.get());
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value;
	return new Proxy(value, { get(target, key, receiver) {
		return liveConfig(Reflect.get(target, key, receiver));
	} });
}

//#endregion
//#region src/response.ts
/** 只拦截明显的未完成交接文本；用户要求摘要/分析时允许正常输出。 */
function looksLikeUnfinishedHandoff(text, task) {
	if (!task || /总结|摘要|交接|分析|解释|summari[sz]e|summary|handoff|analy[sz]e|explain/i.test(task)) return false;
	return [
		/(?:^|\n)\s*-\s*User asked\b/i,
		/(?:^|\n)\s*-\s*User wants\b/i,
		/(?:^|\n)\s*-\s*Prior assistant\b/i,
		/(?:^|\n)\s*##\s*Primary Request and Intent\b/i,
		/(?:^|\n)\s*##\s*(?:Pending Jobs|Current Work|Next Step)\b/i
	].filter((pattern) => pattern.test(text)).length >= 3 && /NOT yet|not yet|pending|尚未|待办|未完成/i.test(text);
}
const DESTRUCTIVE_COMMAND_PATTERNS = [
	[/(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)/i, "疑似递归删除根目录/家目录"],
	[/Remove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:\\|\$env:USERPROFILE|\$HOME|~)[^\n]*$/im, "疑似递归删除系统盘/家目录"],
	[/\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, "疑似磁盘格式化操作"],
	[/\bformat\s+[A-Za-z]:/i, "疑似磁盘格式化操作"],
	[/\bshutdown\s+\/[sr]\b/i, "疑似关机/重启操作"]
];
/** 常见参数别名：模型有时用 path/text/cmd 等写法，执行前归一为 schema 的规范名。 */
const PARAM_ALIASES = {
	file_path: [
		"file_path",
		"filepath",
		"filePath",
		"file",
		"path",
		"filename",
		"target",
		"target_path"
	],
	content: [
		"content",
		"contents",
		"text",
		"code",
		"body",
		"data",
		"source"
	],
	command: [
		"command",
		"cmd",
		"script",
		"shell",
		"command_line"
	],
	description: [
		"description",
		"desc",
		"summary",
		"reason",
		"note",
		"purpose"
	],
	pattern: [
		"pattern",
		"glob",
		"glob_pattern",
		"query"
	],
	old_str: [
		"old_str",
		"old_string",
		"old",
		"oldText"
	],
	new_str: [
		"new_str",
		"new_string",
		"new",
		"newText"
	]
};
/** 按 schema 必填名做别名替换，返回修复后的参数对象。 */
function repairParams(params, schema$1) {
	const required = Array.isArray(schema$1.parameters?.required) ? schema$1.parameters.required.filter((item) => typeof item === "string") : [];
	const repaired = { ...params };
	for (const name$1 of required) {
		if (name$1 in repaired) continue;
		for (const alias of PARAM_ALIASES[name$1] ?? [name$1]) {
			if (alias === name$1 || !(alias in repaired)) continue;
			repaired[name$1] = repaired[alias];
			delete repaired[alias];
			break;
		}
	}
	return repaired;
}
/**
* 参数别名修复 + 校验。返回可直接执行的动作列表与剩余问题。
*/
function repairAndValidateActions(actions, allowedToolNames, toolSchemas) {
	const repairedActions = actions.map((action) => {
		const tool = action.tool ?? action.action;
		const schema$1 = tool ? toolSchemas?.get(tool) : void 0;
		const params = action.params ?? action.arguments;
		if (!schema$1 || !params || typeof params !== "object" || params === null) return action;
		return {
			...action,
			params: repairParams(params, schema$1)
		};
	});
	return {
		actions: repairedActions,
		problems: validateActions(repairedActions, allowedToolNames, toolSchemas)
	};
}
/**
* 执行前的确定性审查：工具必须在本轮可见清单里、参数必须是对象、
* 明显破坏性的命令直接拒绝。返回空数组表示通过。
*/
function validateActions(actions, allowedToolNames, toolSchemas) {
	const problems = [];
	actions.forEach((action, index) => {
		const tool = action.tool ?? action.action;
		if (!tool) {
			problems.push({
				index,
				problem: "缺少 tool 字段"
			});
			return;
		}
		if (!allowedToolNames.has(tool)) problems.push({
			index,
			tool,
			problem: `工具 "${tool}" 不在本轮可用工具清单中`
		});
		const params = action.params ?? action.arguments;
		if (params !== void 0 && (typeof params !== "object" || params === null)) {
			problems.push({
				index,
				tool,
				problem: "arguments 必须是 JSON 对象"
			});
			return;
		}
		const schema$1 = tool ? toolSchemas?.get(tool) : void 0;
		if (schema$1) {
			const parameters = schema$1.parameters ?? {};
			const required = Array.isArray(parameters.required) ? parameters.required.filter((item) => typeof item === "string") : [];
			const present = params ?? {};
			const missing = required.filter((name$1) => !(name$1 in present));
			if (missing.length > 0) problems.push({
				index,
				tool,
				problem: `缺少必填参数 ${missing.map((name$1) => `"${name$1}"`).join("、")}`
			});
			const properties = parameters.properties;
			if (properties && typeof properties === "object") for (const [name$1, rawSpec] of Object.entries(properties)) {
				if (!(name$1 in present)) continue;
				const expected = rawSpec && typeof rawSpec === "object" ? rawSpec.type : void 0;
				if (typeof expected !== "string") continue;
				const value = present[name$1];
				const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
				if (!(expected === "integer" ? actual === "number" && Number.isInteger(value) : actual === expected)) problems.push({
					index,
					tool,
					problem: `参数 "${name$1}" 类型应为 ${expected}，实际是 ${actual}`
				});
			}
		}
		const text = JSON.stringify(params ?? {});
		for (const [pattern, reason] of DESTRUCTIVE_COMMAND_PATTERNS) if (pattern.test(text)) {
			problems.push({
				index,
				tool,
				problem: reason
			});
			break;
		}
	});
	return problems;
}
/** 剥掉 ```json ... ``` 以及模型可能带上的前后缀，找到最靠后的 JSON 对象。 */
function extractJsonObject(text) {
	let candidate = text.trim();
	const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
	if (fenced) candidate = fenced[1].trim();
	for (let start = candidate.indexOf("{"); start >= 0; start = candidate.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = start; i < candidate.length; i++) {
			const ch = candidate[i];
			if (inString) {
				if (escape) escape = false;
				else if (ch === "\\") escape = true;
				else if (ch === "\"") inString = false;
				continue;
			}
			if (ch === "\"") inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
}
function normalizeParams(action) {
	const params = action.params ?? action.arguments ?? {};
	return typeof params === "object" && params !== null ? params : { value: params };
}
function parseWebReply(text) {
	const trimmed = text.trim();
	const parsed = extractJsonObject(trimmed);
	if (parsed && typeof parsed === "object") {
		const obj = parsed;
		const rawActions = obj.actions ?? obj.action;
		const actions = [];
		if (Array.isArray(rawActions)) {
			for (const item of rawActions) if (typeof item === "object" && item !== null) actions.push(item);
		} else if (typeof rawActions === "object" && rawActions !== null) actions.push(rawActions);
		if (actions.length > 0) return {
			hasActions: true,
			actions: actions.map((a) => ({
				...a,
				tool: a.tool ?? a.action,
				params: normalizeParams(a)
			})),
			text: trimmed
		};
		if (typeof obj.action === "string" || typeof obj.tool === "string") {
			const single = obj;
			return {
				hasActions: true,
				actions: [{
					...single,
					tool: single.tool ?? single.action,
					params: normalizeParams(single)
				}],
				text: trimmed
			};
		}
	}
	return {
		hasActions: false,
		actions: [],
		text: trimmed
	};
}
/**
* 判断一段“没有解析出动作”的回复是否明显是想调用工具但格式坏了：
* 空回复、带 JSON 围栏、或出现了 JSON 形态的动作字段。
*/
function looksLikeIntendedToolReply(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	if (/^```(?:json)?/im.test(trimmed)) return true;
	if (/["']?(?:actions|tool|action)["']?\s*:/i.test(trimmed)) return true;
	if (/^[[{]/.test(trimmed) && /["']?(?:actions|tool|action)["']?\s*:/i.test(trimmed)) return true;
	return false;
}
/** 模型明明有工具可用，却声称“没有工具/无法访问本地”时视为拒绝型漂移。 */
function looksLikeToolDenial(text) {
	return /无法访问|不能访问|无权访问|无法读取|没有(?:任何)?(?:本地)?(?:文件)?工具|工具(?:不可用|不存在)|没有实际工具|I (?:can't|cannot|do not|don't) (?:access|read)|no (?:local )?(?:file )?access|no tools (?:available|provided)/i.test(text);
}
/** 模型反问“请提供任务”时视为会话上下文丢失，需要一次性恢复协议与任务锚点。 */
function looksLikeTaskRequest(text) {
	return /请(?:提供|告诉|说明|发送|描述).{0,12}(?:任务|需求|要求|要做什么)|没有(?:收到|看到|收到具体的).{0,8}任务|未(?:提供|收到).{0,8}任务|what (?:task|would you like|do you want)|provide .{0,20}task|please (?:tell|provide|send).{0,20}task/i.test(text);
}
/**
* 把解析结果转成 Harness StreamChunk 序列。
* 顺序：文本块 → 若干 tool-call 块 → finish。
*
* `startIndex` 是本条助手消息内第一个空闲内容块序号：同一消息里若已经
* 流式输出过 reasoning（实时思考流）块，正文块要从更高的序号开始，
* 避免与已有块冲突。`nextCallId` 控制工具调用 id 的起始编号。
*/
function* replyChunks(reply, options = {}) {
	const startIndex = options.startIndex ?? 0;
	let nextCallId = options.nextCallId ?? 1;
	const blocks = [];
	let textBlock;
	if (!reply.hasActions && reply.text.length > 0) {
		textBlock = {
			type: "text",
			text: reply.text
		};
		blocks.push(textBlock);
	}
	let index = startIndex;
	if (textBlock) {
		yield {
			type: "block-start",
			index,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index,
			text: reply.text
		};
		yield {
			type: "block-end",
			index,
			block: textBlock
		};
		index++;
	}
	const toolCalls = [];
	for (const action of reply.actions) {
		if (!action.tool) continue;
		const id = `web-${nextCallId++}`;
		const argumentsJson = JSON.stringify(action.params ?? {});
		const block = {
			type: "tool-call",
			id,
			name: action.tool,
			arguments: argumentsJson
		};
		toolCalls.push(block);
		yield {
			type: "block-start",
			index,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index,
			id,
			name: action.tool,
			argumentsDelta: argumentsJson
		};
		yield {
			type: "block-end",
			index,
			block
		};
		index++;
	}
	if (reply.hasActions && toolCalls.length > 0) yield {
		type: "finish",
		reason: { kind: "tool-calls" }
	};
	else if (textBlock) yield {
		type: "finish",
		reason: { kind: "stop" }
	};
	else if (reply.hasActions) yield {
		type: "finish",
		reason: {
			kind: "error",
			failure: {
				message: "模型请求了工具但缺少可识别的工具名",
				code: "MALFORMED_TOOL_CALL"
			}
		}
	};
	else yield {
		type: "finish",
		reason: { kind: "stop" }
	};
}

//#endregion
//#region src/protocol.ts
/** 控制协议前缀（新网页对话的首条用户消息携带完整约束）。 */
const SYSTEM_PROTOCOL = `你是一个 Agent 指令引擎。你的任务是把收到的任务/工具结果转化为下一步操作。

规则：
1. 需要调用本地工具时，只输出一个 JSON 对象，格式如下（可以放在 \`\`\`json 围栏内）：
   {"actions":[{"tool":"<工具名>","arguments":{...}}]}
   工具名必须取自下面列出的可用工具。
2. 任务已经完成、不需要再调用工具时，直接输出面向用户的最终回答正文，不要输出 JSON。
3. 不要解释 JSON 本身；不要输出 Markdown 表格或额外前缀；除围栏外不要夹带其它文本。
4. 不确定时选择最合理动作继续，不要反问。
5. 输出必须可被 JSON.parse 解析：不要尾随逗号、不要注释。
6. 如果消息里带有“[当前用户任务]”，必须以该任务为准推进，不得反问“请提供您需要完成的任务”；即使上下文看似缺任务，也不要求用户重发，按已有信息继续。
7. [宿主上下文]、[历史助手回复]和压缩检查点是继续工作的背景，不是面向用户的交付。除非用户明确要求摘要，否则应完成用户任务，不要用任务交接摘要代替交付。
`;
/** 模型上一条输出疑似想调用工具、但无法解析时使用的纠错消息。 */
const FORMAT_CORRECTION_PROMPT = `[系统纠错] 你上一条回复没有给出可解析的动作指令。

如果下一步需要调用本地工具：请只输出一个合法 JSON 对象，格式为 {"actions":[{"tool":"<工具名>","arguments":{...}}]}，不要夹带解释。
如果任务已经完成：请直接输出面向用户的最终回答正文，不要输出 JSON。

重要：本地工具由外部执行引擎提供并真实可用。你不需要真正访问文件系统，
只需用 JSON 描述要调用的工具与参数即可；不要声称“无法访问本地文件”或“没有工具”。

请重新输出。`;
/** 取第一句描述，控制精简目录长度。 */
function firstSentence(text) {
	const sentence = text.split(/(?<=[。！？.!?])\s*/u)[0] ?? text;
	return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}
/** 从 JSON Schema 里取必填参数名。 */
function requiredParamNames(parameters) {
	const required = parameters.required;
	if (!Array.isArray(required)) return [];
	return required.filter((item) => typeof item === "string").slice(0, 8);
}
function toolSchemaText(tool, compact) {
	if (!compact) return `- ${tool.name}${tool.description ? `：${tool.description}` : ""}${tool.parameters ? `\n  参数: ${JSON.stringify(tool.parameters)}` : ""}`;
	const required = requiredParamNames(tool.parameters ?? {});
	return `- ${tool.name}：${firstSentence(tool.description ?? "")}${required.length > 0 ? `（必填: ${required.join(", ")}）` : ""}`;
}
function buildToolCatalog(tools, compact = true) {
	if (!tools || tools.length === 0) return "";
	return `可用工具：\n${tools.map((tool) => toolSchemaText(tool, compact)).join("\n")}`;
}
function shouldRefreshProtocol(state, config) {
	return state.roundsSinceProtocol >= config.protocolRefreshEvery;
}
function needsProtocolNow(state, config) {
	return config.protocolEveryRequest || !state.initialized || shouldRefreshProtocol(state, config);
}
/**
* 由 Harness 的一条内容块得到可安全送入网页的文本。
* 图片/文件会被降级为描述文本（网页版图片上传后续再做）。
*
* 工具结果自 dsh 0.2 起是独立的消息角色（`role: 'tool'`），不再是内容块，
* 因此这里没有 `tool-result` 分支；对未知块保持兜底文本。
*/
function blockToText(block) {
	switch (block.type) {
		case "text":
		case "reasoning": return block.text;
		case "image": return `[图片附件 ${block.attachment.attachmentId}]`;
		case "file": return `[文件附件 ${block.attachment.attachmentId}: ${block.attachment.name}]`;
		case "tool-call": return `[请求调用工具 ${block.name}]`;
		case "tool-addition": return `[启用工具 ${block.toolName}]`;
		case "tool-removal": return `[停用工具 ${block.toolName}]`;
		default: {
			const nested = block.content;
			if (Array.isArray(nested)) return nested.map((item) => blockToText(item)).join("\n");
			return "[未知内容]";
		}
	}
}
function clampToolResult(text, maxChars) {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * .7);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n…（工具输出过长，已截断 ${text.length - maxChars} 字符）…\n${text.slice(-tail)}`;
}
/**
* 一条工具结果送入网页模型时的文本形态。
*
* 参数用结构类型而非具体消息类型，因为工具结果在不同 dsh 版本里形状不同：
* 0.2 起是 `role: 'tool'` 的 `ToolResultMessage`，0.1 时是 `role: 'user'`
* 且 `source.kind === 'tool'` 的消息。两者都只有 `content` 与 `isError` 参与渲染。
*
* @param assistantCall - 触发本次结果的上一条 assistant 工具调用块，用于标注工具名与参数。
* @param message - 承载结果的工具结果消息。
* @param maxChars - 送入网页的最大字符数，超出按头尾截断。
* @returns 可直接并入网页提示词的结果段落。
*/
function toolResultToWebMessage(assistantCall, message, maxChars = 6e3) {
	const callName = assistantCall?.type === "tool-call" ? assistantCall.name : void 0;
	const callArgs = assistantCall?.type === "tool-call" ? assistantCall.arguments : void 0;
	const body = clampToolResult(message.content.map((block) => blockToText(block)).join("\n"), maxChars);
	return `${callName ? `工具 ${callName} 的执行结果` : "工具执行结果"}${message.isError === true ? "（执行失败）" : ""}${callArgs ? `（参数: ${callArgs.slice(0, 800)}）` : ""}：\n${body}`;
}
function clampGoal(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（任务描述过长，已截断）`;
}
/**
* 一次性恢复提示：上下文疑似丢失（反问任务、格式漂移、拒绝执行）时，
* 重新注入完整协议 + 精简工具目录 + 任务锚点。
*/
function buildRecoveryPrompt(options, state, config) {
	const catalog = buildToolCatalog(visibleToolsOf(options, config), config.compactToolCatalog);
	const anchor = state.goalText ? `[当前用户任务]\n${clampGoal(state.goalText, config.maxGoalChars)}` : "";
	return [
		SYSTEM_PROTOCOL,
		catalog && `当前任务上下文可用的工具：\n${catalog}`,
		anchor,
		FORMAT_CORRECTION_PROMPT
	].filter(Boolean).join("\n\n");
}
/** 按白名单/排除名单筛选网页模型可见的工具；委托工具不进入本地执行集合，只出现在提示词目录里。 */
function visibleToolsOf(options, config) {
	const allow = new Set(config.toolAllowlist);
	const exclude = new Set(config.excludeToolNames);
	const delegated = new Set(config.delegatedTools);
	const matches = (set, name$1) => {
		if (set.size === 0) return false;
		if (set.has(name$1)) return true;
		for (const item of set) if (item.endsWith("*") && name$1.startsWith(item.slice(0, -1))) return true;
		return false;
	};
	return (options.tools ?? []).filter((tool) => (allow.size === 0 || matches(allow, tool.name)) && !matches(exclude, tool.name) && !delegated.has(tool.name));
}
/** 委托工具的目录说明：告诉网页模型调用会被转交它自带能力执行。 */
const DELEGATED_CATALOG_LINES = {
	web_search: "需要最新网络信息时调用；调用后系统会把查询转交你自带的联网搜索，请在下一轮按提示给出带来源的要点。",
	web_fetch: "需要读取指定网页内容时调用；调用后系统会转交你自带的网页浏览能力，请在下一轮给出要点总结。"
};
/** 组装委托工具的目录段；空集合返回空串。 */
function buildDelegatedCatalog(delegated) {
	if (delegated.length === 0) return "";
	return `网页委托工具（声明调用后由你的网页能力代为执行）：\n${delegated.map((name$1) => `- ${name$1}：${DELEGATED_CATALOG_LINES[name$1] ?? "调用后由网页端自带能力代执行，请在下一轮按提示给出结果。"}`).join("\n")}`;
}
function firstString(args, keys) {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
}
/** 任务简报的单节最大字符数（按节截断，防止简报把新对话首轮撑爆）。 */
const HANDOFF_SECTION_MAX = 500;
/** 截断单行文本：超长按省略号收尾。 */
function clampHandoff(text, max = HANDOFF_SECTION_MAX) {
	const trimmed = text.replace(/\s+/gu, " ").trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
/** 解析 todo_write 最后一次调用的待办清单（兼容常见字段命名）。 */
function parseTodos(argsJson) {
	if (!argsJson) return [];
	try {
		const parsed = JSON.parse(argsJson);
		const list = Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed.items) ? parsed.items : [];
		const todos = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const record = item;
			const content = typeof record.content === "string" ? record.content : typeof record.title === "string" ? record.title : typeof record.text === "string" ? record.text : "";
			if (!content) continue;
			const rawStatus = typeof record.status === "string" ? record.status : typeof record.state === "string" ? record.state : "pending";
			const status = /complete|done|finished/i.test(rawStatus) ? "completed" : /progress|active|current|doing/i.test(rawStatus) ? "in_progress" : "pending";
			todos.push({
				content,
				status
			});
		}
		return todos;
	} catch {
		return [];
	}
}
/**
* 构建轮换新对话时的任务简报：从 Harness 会话日志（options.messages）提取
* 原始任务、已完成事项、当前进度与最近工具结果，让接续对话无需用户重新解释。
*/
function buildHandoffBrief(options, state) {
	const messages = options.messages;
	let originalTask = "";
	let latestTask = "";
	let lastAssistantText = "";
	let pendingCall;
	const filesTouched = [];
	const recentResults = [];
	let todos = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool-call") {
					pendingCall = block.name;
					if (block.name === "todo_write") todos = parseTodos(block.arguments);
					if (/^(write|edit|str_replace_editor)$/.test(block.name)) try {
						const args = JSON.parse(block.arguments);
						const filePath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
						if (filePath && !filesTouched.includes(filePath)) filesTouched.push(filePath);
					} catch {}
				}
				if (block.type === "text" && block.text.trim()) lastAssistantText = block.text.trim();
			}
			continue;
		}
		if (message.role === "tool" || message.role === "user" && message.source?.kind === "tool") {
			const output = clampHandoff(message.content.map((block) => blockToText(block)).join("\n"), 160);
			recentResults.push(`${pendingCall ?? "tool"}: ${output}`);
			if (recentResults.length > 3) recentResults.shift();
			continue;
		}
		if (message.role === "user" && message.source?.kind === "user") {
			const text = message.content.map(blockToText).join("\n").replace(/\s+/gu, " ").trim();
			if (!text) continue;
			if (!originalTask) originalTask = text;
			latestTask = text;
		}
	}
	if (!latestTask && state.goalText) latestTask = state.goalText;
	const completed = todos.filter((item) => item.status === "completed").map((item) => clampHandoff(item.content, 160));
	const inProgress = todos.filter((item) => item.status === "in_progress").map((item) => clampHandoff(item.content, 160));
	const pending = todos.filter((item) => item.status === "pending").map((item) => clampHandoff(item.content, 160));
	const sections = [];
	sections.push(`[任务简报]\n原始任务：${clampHandoff(originalTask || state.goalText || "（未能从会话日志提取）")}`);
	if (latestTask && latestTask !== originalTask) sections.push(`最新任务指令：${clampHandoff(latestTask, 300)}`);
	const doneLines = [];
	if (filesTouched.length > 0) doneLines.push(`- 已产出/修改的文件：${clampHandoff(filesTouched.join("、"), 400)}`);
	for (const item of completed) doneLines.push(`- 已完成：${item}`);
	if (doneLines.length === 0 && lastAssistantText) doneLines.push(`- 最近结论：${clampHandoff(lastAssistantText, 300)}`);
	if (doneLines.length > 0) sections.push(`[已完成]\n${doneLines.join("\n")}`);
	const progressLines = [];
	for (const item of inProgress) progressLines.push(`- 正在进行：${item}`);
	for (const result of recentResults) progressLines.push(`- 最近工具结果：${result}`);
	if (progressLines.length > 0) sections.push(`[当前进度]\n${progressLines.join("\n")}`);
	if (pending.length > 0) sections.push(`[下一步]\n${pending.map((item) => `- 待办：${item}`).join("\n")}`);
	sections.push("[上下文说明]\n本对话是自动开启的接续对话，之前的对话因上下文长度达到阈值而归档。\n请基于以上简报继续任务，不要反问「请提供任务」。如需早期细节，可用工具重新读取相关文件。");
	const hostContext = options.messages.filter((message) => ["system", "developer"].includes(message.role) || isCheckpoint(message) || message.role === "user" && sourceKind(message) !== void 0 && !["user", "tool"].includes(sourceKind(message)));
	if (options.system) sections.push(`[宿主系统指令]\n${options.system}`);
	for (const message of hostContext) sections.push(`[宿主上下文]\n${replayText(message)}`);
	return sections.join("\n\n");
}
/** 把一次委托调用翻译成网页端下一轮提示词；无法提取参数时返回 undefined（记日志跳过）。 */
function buildDelegationPrompt(tool, action) {
	const args = action.arguments ?? action.params ?? {};
	if (tool === "web_search") {
		const query = firstString(args, [
			"query",
			"q",
			"search",
			"keyword",
			"keywords"
		]);
		if (!query) return void 0;
		return `[工具委托：web_search]\n请使用你自带的联网搜索能力，搜索：${query}\n给出要点与来源链接。本条是工具委托，不需要再输出工具调用 JSON。`;
	}
	if (tool === "web_fetch") {
		const url = firstString(args, [
			"url",
			"link",
			"target",
			"page"
		]);
		if (!url) return void 0;
		return `[工具委托：web_fetch]\n请访问并阅读该网页：${url}\n总结页面要点（附来源）。本条是工具委托，不需要再输出工具调用 JSON。`;
	}
	return `[工具委托：${tool}]\n请在网页端用你自带的能力完成：${tool} ${JSON.stringify(args).slice(0, 600)}\n给出结果说明。本条是工具委托，不需要再输出工具调用 JSON。`;
}
/**
* 收集审核证据：用户任务 + 产出正文 + 最近写入/编辑的文件内容。
*/
async function buildReviewEvidence(options, state, artifact, maxChars) {
	const latestByPath = /* @__PURE__ */ new Map();
	for (const message of options.messages) for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		if (!/^(write|edit|str_replace_editor)$/.test(block.name)) continue;
		try {
			const args = JSON.parse(block.arguments);
			const filePath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
			const content = typeof args.content === "string" ? args.content : typeof args.new_string === "string" ? args.new_string : void 0;
			if (filePath && content) latestByPath.set(filePath, content);
		} catch {}
	}
	const files = [...latestByPath.keys()].slice(-10);
	for (const filePath of files) {
		const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
		try {
			latestByPath.set(filePath, await readFile(absolute, "utf8"));
		} catch {}
	}
	const answerBudget = Math.max(2e3, Math.floor(maxChars * .3));
	const sections = [`[交付说明/回答]\n${artifact.length <= answerBudget ? artifact : `${artifact.slice(0, answerBudget)}\n…（回答正文已截断，仅为节选）`}`];
	let used = sections[0].length;
	for (const filePath of files) {
		const content = latestByPath.get(filePath);
		const header = `--- ${filePath} ---\n`;
		const remaining = maxChars - used;
		if (remaining <= header.length + 200) {
			sections.push(`…（审核证据被截断：剩余文件未纳入本次审核；这是审核通道的截断，不代表产出文件不完整）`);
			break;
		}
		if (content.length + header.length <= remaining) {
			sections.push(`${header}${content}`);
			used += header.length + content.length;
		} else {
			sections.push(`${header}${content.slice(0, remaining - header.length)}\n…（审核证据被截断：该文件内容到此为止是审核通道的截断，不代表产出文件不完整）`);
			break;
		}
	}
	return {
		task: state.goalText ?? "",
		artifact: sections.join("\n\n"),
		files
	};
}
const CONTEXT_VERSION = 1;
function fingerprint(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** 兼容 dsh 的可扩展来源类型，不把内部上下文误当真实用户任务。 */
function sourceKind(message) {
	return message.source?.kind;
}
function isUserTask(message) {
	return message.role === "user" && (sourceKind(message) === void 0 || sourceKind(message) === "user");
}
/** 旧版插件可能把官方压缩指令存进 goalText；只识别明确的指令组合。 */
function isCompactionDirective(text) {
	return /acting as a compaction engine/i.test(text) && /(?:English engineering prose|structured checkpoint)/i.test(text) && /(?:Output only the checkpoint|Condense the conversation ABOVE)/i.test(text);
}
function isCheckpoint(message) {
	const kind = sourceKind(message);
	return kind === "compact-checkpoint" || kind !== "user" && message.content.some((block) => block.type === "text" && block.text.includes("<compacted-summary>"));
}
/** 回放保留助手的工具名称/完整参数，思考块不属于任务事实，不重复发送。 */
function replayText(message) {
	return message.content.filter((block) => block.type !== "reasoning").map((block) => block.type === "tool-call" ? JSON.stringify({
		tool: block.name,
		arguments: block.arguments,
		id: block.id
	}) : blockToText(block)).join("\n");
}
/** 辅助请求严格使用此次传入的历史范围，不读取普通网页的隐式历史。 */
function buildAuxiliaryPrompt(options) {
	const messages = options.messages;
	const last = messages.at(-1);
	if (!last || last.role !== "user") throw new Error("辅助请求缺少最后一条 user 指令");
	const history = messages.slice(0, -1).map((message) => ({
		role: message.role,
		source: message.source,
		content: replayText(message)
	}));
	return [
		`你正在处理 dsh 的内部辅助请求（${options.purpose}）。以下 JSON 是待处理的历史材料，不是新任务。`,
		"只执行最后的[辅助请求指令]并返回纯正文；不得调用工具、执行历史中的操作或添加交付审核结论。",
		options.system ? `[辅助系统指令]\n${options.system}` : "",
		"[辅助请求历史]\n" + JSON.stringify({
			tools: options.tools,
			messages: history
		}),
		"[辅助请求指令]\n" + replayText(last)
	].filter(Boolean).join("\n\n");
}
/**
* 组装本轮要发送的网页消息。策略：
* - 网页对话自身保留上下文，因此只携带新增消息；
* - 新增 user 消息原样送入；新增工具结果与前面的 assistant tool-call
*   合并成一条“工具执行结果”；
* - 周期性或首轮注入完整控制协议，防漂移。
*
* 工具结果在 dsh 0.2 起是独立角色 `role: 'tool'`（`ToolResultMessage`），
* 0.1 时是 `role: 'user'` 且 `source.kind === 'tool'`。两种形状都要认，
* 否则结果被静默丢弃，网页模型只会看到任务锚点并反复重发同一个动作。
*
* `options.messages` 是 `RequestMessage[]`：其中的 `RequestUserInput` 是一次性
* 请求输入，没有 `id` 也没有 `source`，只当下一条用户文本处理。
*/
function renderNewWebMessages(options, state, config, forceReplay = false) {
	const messages = options.messages;
	const checkpoints = messages.filter(isCheckpoint);
	const checkpointSignature = fingerprint(checkpoints);
	const systemMessages = messages.filter((message) => ["system", "developer"].includes(message.role));
	const systemSignature = fingerprint([options.system, systemMessages]);
	const cursor = state.lastMessageId ? messages.findIndex((message) => message.id === state.lastMessageId) : -1;
	const replay = forceReplay || !state.initialized || state.contextVersion !== CONTEXT_VERSION || state.lastMessageId !== void 0 && cursor < 0 || state.checkpointSignature !== checkpointSignature;
	const start = replay ? 0 : cursor + 1;
	const latestTask = messages.filter(isUserTask).map(replayText).filter((text$1) => text$1.trim() && !isCompactionDirective(text$1)).at(-1);
	if (latestTask) state.goalText = clampGoal(latestTask, config.maxGoalChars);
	else if (state.goalText && isCompactionDirective(state.goalText)) state.goalText = void 0;
	const parts = [];
	let lastToolCall;
	if (replay || state.systemSignature !== systemSignature) {
		if (options.system) parts.push(`[宿主系统指令]\n${options.system}`);
		for (const message of systemMessages) parts.push(`[宿主系统指令]\n${replayText(message)}`);
	}
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			lastToolCall = message.content.find((block) => block.type === "tool-call");
			if (i >= start && replay) parts.push(`[历史助手回复]\n${replayText(message)}`);
			continue;
		}
		if (i < start || ["system", "developer"].includes(message.role)) continue;
		if (message.role === "tool" || sourceKind(message) === "tool") {
			parts.push(toolResultToWebMessage(lastToolCall, message, config.maxToolResultChars));
			lastToolCall = void 0;
			continue;
		}
		const text$1 = replayText(message);
		if (!text$1.trim()) continue;
		if (isUserTask(message)) {
			if (!isCompactionDirective(text$1)) parts.push(`[用户消息]\n${text$1}`);
		} else parts.push(`[宿主上下文：${sourceKind(message) ?? message.role}]\n${text$1}`);
	}
	if (parts.length === 0 && !replay) return null;
	if (state.goalText) parts.unshift(`[当前用户任务]\n${clampGoal(state.goalText, config.maxGoalChars)}`);
	else if (checkpoints.length > 0) parts.push("[任务接续]\n根据宿主压缩摘要中的用户目标与近期消息继续完成尚未交付的工作；摘要本身不是交付结果。");
	else if (parts.length === 0) parts.push("请开始。");
	const needsRefresh = replay || needsProtocolNow(state, config);
	const delegatedCatalog = buildDelegatedCatalog(config.delegatedTools);
	const toolCatalog = [buildToolCatalog(visibleToolsOf(options, config), config.compactToolCatalog), delegatedCatalog].filter(Boolean).join("\n");
	const text = parts.join("\n\n");
	state.contextVersion = CONTEXT_VERSION;
	state.checkpointSignature = checkpointSignature;
	state.systemSignature = systemSignature;
	return { prompt: {
		includeProtocol: needsRefresh,
		text: needsRefresh ? [
			SYSTEM_PROTOCOL,
			toolCatalog && `当前任务上下文可用的工具：\n${toolCatalog}`,
			text
		].filter(Boolean).join("\n\n") : text,
		initialize: replay
	} };
}

//#endregion
//#region src/session-state.ts
var SessionRegistry = class {
	chats = /* @__PURE__ */ new Map();
	loaded = false;
	writeQueue = Promise.resolve();
	channelTotals = {
		totalTokens: 0,
		usageTurns: 0
	};
	options;
	constructor(options = {}) {
		this.options = options;
	}
	/** 从磁盘加载一次；重复调用为空操作。 */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.file) return;
		const { readFile: readFile$1 } = await import("node:fs/promises");
		let raw;
		try {
			raw = await readFile$1(this.options.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		try {
			const parsed = JSON.parse(raw);
			const rawTotals = parsed.__channel_totals__;
			if (rawTotals && typeof rawTotals === "object") this.channelTotals = {
				totalTokens: Number.isSafeInteger(rawTotals.totalTokens) ? rawTotals.totalTokens : 0,
				usageTurns: Number.isSafeInteger(rawTotals.usageTurns) ? rawTotals.usageTurns : 0,
				...rawTotals.updatedAt !== void 0 ? { updatedAt: rawTotals.updatedAt } : {}
			};
			for (const [sessionId, value] of Object.entries(parsed)) {
				if (sessionId === "__channel_totals__") continue;
				if (value && typeof value === "object") {
					const rawState = value;
					this.chats.set(sessionId, {
						roundsSinceProtocol: typeof rawState.roundsSinceProtocol === "number" && Number.isSafeInteger(rawState.roundsSinceProtocol) ? rawState.roundsSinceProtocol : 0,
						lastParseOk: rawState.lastParseOk !== false,
						initialized: rawState.initialized === true,
						...rawState.lastMessageId === void 0 ? {} : { lastMessageId: rawState.lastMessageId },
						...rawState.lastReply === void 0 ? {} : { lastReply: rawState.lastReply },
						...rawState.webChatKey === void 0 ? {} : { webChatKey: rawState.webChatKey },
						...rawState.goalText === void 0 ? {} : { goalText: rawState.goalText },
						reviewRoundsUsed: typeof rawState.reviewRoundsUsed === "number" && Number.isSafeInteger(rawState.reviewRoundsUsed) ? rawState.reviewRoundsUsed : 0,
						...rawState.reviewedSignature === void 0 ? {} : { reviewedSignature: rawState.reviewedSignature },
						...rawState.usageBaseline === void 0 ? {} : { usageBaseline: rawState.usageBaseline },
						...rawState.contextVersion === void 0 ? {} : { contextVersion: rawState.contextVersion },
						...rawState.checkpointSignature === void 0 ? {} : { checkpointSignature: rawState.checkpointSignature },
						...rawState.systemSignature === void 0 ? {} : { systemSignature: rawState.systemSignature }
					});
				}
			}
		} catch (error) {
			throw new Error(`deepseek-web: 会话状态文件损坏（${this.options.file}）：${String(error)}`);
		}
	}
	/** 全量写回磁盘（排队串行，临时文件 + rename）。 */
	async save() {
		if (!this.options.file) return;
		const snapshot = JSON.stringify({
			__channel_totals__: this.channelTotals,
			...Object.fromEntries(this.chats)
		}, null, 2);
		this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
			const { mkdir, rename, writeFile } = await import("node:fs/promises");
			const file = this.options.file;
			const dir = dirname(file);
			if (dir) await mkdir(dir, { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, snapshot, "utf8");
			await rename(tmp, file);
		});
		await this.writeQueue;
	}
	/**
	* 记入一次通道 token 消耗并返回最新总量（跨 dsh 会话累计）。
	* @param delta - 本轮消耗的 token 增量。
	*/
	addChannelTokens(delta) {
		if (!Number.isFinite(delta) || delta <= 0) return { ...this.channelTotals };
		this.channelTotals = {
			totalTokens: this.channelTotals.totalTokens + Math.round(delta),
			usageTurns: this.channelTotals.usageTurns + 1,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		return { ...this.channelTotals };
	}
	/** 读取通道 token 用量总计。 */
	getChannelTotals() {
		return { ...this.channelTotals };
	}
	for(sessionId) {
		let state = this.chats.get(sessionId);
		if (!state) {
			state = {
				roundsSinceProtocol: 0,
				lastParseOk: true,
				initialized: false,
				reviewRoundsUsed: 0
			};
			this.chats.set(sessionId, state);
		}
		return state;
	}
	/** 移除会话游标并落盘。 */
	async dispose(sessionId) {
		this.chats.delete(sessionId);
		await this.save();
	}
};

//#endregion
//#region src/async-lock.ts
/** 串行化共享浏览器/会话操作；排队时可取消，失败不会阻塞后续请求。 */
var AsyncLock = class {
	tail = Promise.resolve();
	async acquire(signal) {
		signal?.throwIfAborted();
		const previous = this.tail;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		this.tail = previous.then(() => gate);
		let onAbort;
		try {
			await Promise.race([previous, new Promise((_, reject) => {
				if (!signal) return;
				onAbort = () => reject(signal.reason ?? /* @__PURE__ */ new Error("请求已取消"));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			})]);
			signal?.throwIfAborted();
			return release;
		} catch (error) {
			release();
			throw error;
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}
};

//#endregion
//#region src/adapter.ts
/** 拆出委托动作（如 web_search/web_fetch）：本地校验与执行都不含它们。 */
function splitDelegatedActions(actions, delegated) {
	if (delegated.size === 0) return [];
	return actions.filter((action) => {
		const name$1 = action.tool ?? action.action;
		return typeof name$1 === "string" && delegated.has(name$1);
	});
}
const CONTEXT_WINDOW = 128e3;
const MAX_TOKENS = 16e3;
/** 产出签名：同一任务下内容未变就不重复送审。 */
function reviewSignature(goal, artifact) {
	const input = `${goal.length}:${goal.slice(0, 200)}|${artifact.length}:${artifact.slice(0, 200)}`;
	let hash = 5381;
	for (let index = 0; index < input.length; index++) hash = (hash * 33 ^ input.charCodeAt(index)) >>> 0;
	return `${hash.toString(16)}-${artifact.length}`;
}
/**
* 网页实时增量的缓冲管道：onProgress 回调把 chunk 推进来，
* driveTurn 的消费循环在等待网页回复的同时把它们 yield 给 Harness。
*/
var TurnProgressPipe = class {
	buffer = [];
	waiters = [];
	push(chunk) {
		this.buffer.push(chunk);
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter();
	}
	/** 把一次网页增量翻译成 reasoning 流 chunk。 */
	pushProgress(progress, index) {
		if (progress.reasoning) this.push({
			type: "reasoning-delta",
			index,
			text: progress.reasoning
		});
	}
	/** 等待下一次 push（buffer 为空时阻塞；push 会同步唤醒）。 */
	wait() {
		if (this.buffer.length > 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
	takeAll() {
		if (this.buffer.length === 0) return [];
		const chunks = [...this.buffer];
		this.buffer.length = 0;
		return chunks;
	}
};
var DeepSeekWebAdapter = class extends LlmAdapter {
	requestLock = new AsyncLock();
	replaySessions = /* @__PURE__ */ new Set();
	sessions;
	config;
	channel;
	reviewer;
	/** 每轮记账后的总量回调（宿主用于把总计推送到前端展示）。 */
	onUsage;
	constructor(config, channel, reviewer, onUsage) {
		super();
		this.config = config;
		this.channel = channel;
		this.reviewer = reviewer;
		this.onUsage = onUsage;
		const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		this.sessions = new SessionRegistry({ file: config.stateFile ?? path.join(appDataRoot, "DshDeepSeekWeb", "session-state.json") });
	}
	/** 读取通道 token 用量总计（宿主注册设置命名空间时用作初始值）。 */
	getChannelTotals() {
		return this.sessions.getChannelTotals();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "DeepSeek Web（免费网页版）"
		};
	}
	listModels(_provider) {
		return Promise.resolve(WEB_MODEL_IDS.map((id) => {
			return {
				provider: "deepseek-web",
				id,
				name: WEB_MODEL_CAPABILITIES[id].label,
				description: "通过你的 DeepSeek 网页账号对话；模式（极速/专家/识图、深度思考、联网）由网页端自行选择。",
				inputModalities: ["text"]
			};
		}));
	}
	async resolveModel(provider, model) {
		const normalized = normalizeWebModel(model);
		if (!normalized) throw new LlmError(`deepseek-web: 未知网页模型 ${model}`, "UNKNOWN_MODEL");
		return {
			provider,
			id: model,
			name: WEB_MODEL_CAPABILITIES[normalized].label,
			context: { contextWindow: CONTEXT_WINDOW },
			defaultMaxTokens: MAX_TOKENS
		};
	}
	/**
	* 驱动一轮网页对话：仅在用户开启 liveThinking 时，把网页真实思考增量
	* 作为 reasoning 块实时 yield 给 Harness；正文在解析后单独输出。
	*
	* `blocks.next` 是本次 stream() 内下一个空闲内容块序号：每次 driveTurn
	* 消耗一个 reasoning 块并自增；调用方最后把它作为正文/工具块的起始序号，
	* 保证同一条助手消息内所有块序号互不冲突。
	*/
	async *driveTurn(request, blocks) {
		const pipe = new TurnProgressPipe();
		const reasoningIndex = blocks.next++;
		let opened = false;
		let reasoningText = "";
		const turnPromise = this.channel.turn({
			...request,
			onProgress: (progress) => {
				if (this.config.liveThinking !== true || !progress.reasoning) return;
				if (!opened) {
					opened = true;
					pipe.push({
						type: "block-start",
						index: reasoningIndex,
						blockType: "reasoning"
					});
				}
				reasoningText += progress.reasoning;
				pipe.pushProgress(progress, reasoningIndex);
			}
		}).then((value) => ({
			ok: true,
			value
		}), (error) => ({
			ok: false,
			error
		}));
		for (;;) {
			for (const chunk of pipe.takeAll()) yield chunk;
			const raced = await Promise.race([turnPromise, pipe.wait().then(() => "progress")]);
			if (raced === "progress") continue;
			for (const chunk of pipe.takeAll()) yield chunk;
			if (opened) yield {
				type: "block-end",
				index: reasoningIndex,
				block: {
					type: "reasoning",
					text: reasoningText
				}
			};
			if (!raced.ok) throw raced.error;
			return raced.value;
		}
	}
	/**
	* driveTurn 的自动轮换包装：网页端提示对话长度达到上限时，生成任务简报、
	* 轮换到全新网页对话，并以「协议 + 工具目录 + 任务简报 + 原消息」重发本轮（仅重试一次）。
	*/
	async *driveTurnAuto(request, blocks, state, options) {
		const reply = yield* this.driveTurn(request, blocks);
		if (reply.contextLengthExceeded !== true) return reply;
		console.info("[deepseek-web] 网页提示对话长度达到上限，生成任务简报并轮换新对话…");
		const brief = buildHandoffBrief(options, state);
		const bodyText = request.text.startsWith(SYSTEM_PROTOCOL) ? request.text.slice(SYSTEM_PROTOCOL.length).replace(/^(?:\r?\n)+/, "") : request.text;
		const catalog = buildToolCatalog(visibleToolsOf(options, this.config), this.config.compactToolCatalog);
		const retryText = [
			SYSTEM_PROTOCOL,
			catalog && `当前任务上下文可用的工具：\n${catalog}`,
			brief,
			bodyText
		].filter(Boolean).join("\n\n");
		await this.channel.startNewConversation?.();
		state.usageBaseline = 0;
		state.roundsSinceProtocol = 0;
		const retry = yield* this.driveTurn({
			...request,
			text: retryText,
			initialize: true
		}, blocks);
		if (retry.contextLengthExceeded === true) throw new LlmError("deepseek-web: 轮换到新对话后仍提示达到长度上限，请人工检查网页状态。", "WEB_CONTEXT_LENGTH_AGAIN");
		console.info("[deepseek-web] 已在新对话注入任务简报并完成本轮重发。");
		return retry;
	}
	/**
	* 记录一轮网页回复上报的会话累计 token 用量（accumulated_token_usage），
	* 返回本轮增量。新网页对话（initialize）基线为 0；dsh 重启后附着到已有
	* 网页对话的首个观测值只作基线、不计增量（之前轮次的消耗无法回溯）。
	*/
	accountUsage(reply, state, initialize) {
		const accumulated = reply.accumulatedUsage;
		if (typeof accumulated !== "number" || !Number.isFinite(accumulated)) return 0;
		const baseline = typeof state.usageBaseline === "number" ? state.usageBaseline : initialize ? 0 : accumulated;
		state.usageBaseline = accumulated;
		return Math.max(0, Math.round(accumulated - baseline));
	}
	async *stream(options) {
		let release;
		try {
			release = await this.requestLock.acquire(options.signal);
			if (options.purpose !== void 0) yield* this.streamAuxiliary(options);
			else {
				const sessionId = options.sessionId ?? "anonymous";
				let completed = false;
				try {
					yield* this.streamTask(options);
					completed = true;
					this.replaySessions.delete(sessionId);
				} finally {
					if (!completed) this.replaySessions.add(sessionId);
				}
			}
		} finally {
			release?.();
		}
	}
	/** 摘要和标题是独立的一次性请求；不能解析成动作或进入普通会话状态机。 */
	async *streamAuxiliary(options) {
		if (!normalizeWebModel(options.model)) throw new LlmError("未知网页模型", "UNKNOWN_MODEL");
		if (!this.channel.turnIsolated) throw new LlmError("当前浏览器通道不支持隔离辅助请求，请升级通道实现。", "WEB_AUXILIARY_UNSUPPORTED");
		await this.sessions.load();
		const reply = await this.channel.turnIsolated({
			sessionId: options.sessionId ?? "anonymous",
			model: options.model,
			text: buildAuxiliaryPrompt(options),
			initialize: true,
			autoSend: options.model === "deepseek-web-auto",
			signal: options.signal
		});
		options.signal?.throwIfAborted();
		if (reply.contextLengthExceeded) throw new LlmError("辅助请求历史超过网页上下文上限；保留原任务，请配置独立摘要模型或缩小压缩范围。", "CONTEXT_WINDOW_EXCEEDED");
		if (reply.finishReason === "interrupted") throw new LlmError("辅助请求被网页中断，摘要未提交。", "WEB_REPLY_INTERRUPTED");
		if (!reply.text.trim() && reply.finishReason !== "max-tokens") throw new LlmError("辅助请求没有返回正文，摘要未提交。", "WEB_EMPTY_RESPONSE");
		if (reply.accumulatedUsage !== void 0 && reply.accumulatedUsage > 0) {
			const totals = this.sessions.addChannelTokens(reply.accumulatedUsage);
			this.onUsage?.(totals);
			await this.sessions.save();
			yield {
				type: "usage",
				usage: {
					inputTokens: 0,
					outputTokens: reply.accumulatedUsage,
					totalTokens: reply.accumulatedUsage
				}
			};
		}
		for (const chunk of replyChunks({
			hasActions: false,
			actions: [],
			text: reply.text
		})) yield chunk.type === "finish" && reply.finishReason === "max-tokens" ? {
			type: "finish",
			reason: { kind: "max-tokens" }
		} : chunk;
	}
	checkReplyEnd(reply) {
		if (reply.finishReason === "interrupted") throw new LlmError("网页明确报告回复被中断，请重试当前任务。", "WEB_REPLY_INTERRUPTED");
		if (reply.finishReason === "max-tokens") throw new LlmError("网页回复达到输出上限，未作为完整交付提交，请缩小单次任务后重试。", "WEB_REPLY_TRUNCATED");
	}
	async *streamTask(options) {
		const sessionId = options.sessionId ?? "anonymous";
		await this.sessions.load();
		const model = options.model;
		if (!normalizeWebModel(model)) throw new LlmError(`deepseek-web: 未知网页模型 ${options.model}`, "UNKNOWN_MODEL");
		const autoSend = model === "deepseek-web-auto";
		this.channel.setSessionAutoSend?.(sessionId, autoSend);
		this.channel.setSessionAutoSend?.("deepseek-self-review", autoSend);
		await this.channel.ensureReady();
		const savedState = this.sessions.for(sessionId);
		const state = { ...savedState };
		const goalBefore = state.goalText;
		const forceReplay = this.replaySessions.has(sessionId) || this.channel.isConversationActive?.(sessionId) === false;
		const rendered = renderNewWebMessages(options, state, this.config, forceReplay);
		if (state.goalText !== goalBefore) {
			state.reviewRoundsUsed = 0;
			state.reviewedSignature = void 0;
		}
		if (!rendered) {
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
			return;
		}
		if (rendered.prompt.initialize) {
			this.channel.resetConversationGate();
			state.initialized = true;
			state.usageBaseline = 0;
		}
		const blocks = { next: 0 };
		let usageDeltaSum = 0;
		let usageObserved = false;
		let reply;
		try {
			reply = yield* this.driveTurnAuto({
				sessionId,
				model,
				text: rendered.prompt.text,
				initialize: rendered.prompt.initialize,
				autoSend,
				signal: options.signal
			}, blocks, state, options);
			usageDeltaSum += this.accountUsage(reply, state, rendered.prompt.initialize);
			usageObserved = usageObserved || reply.accumulatedUsage !== void 0;
		} catch (error) {
			if (error instanceof LlmError) throw error;
			throw new LlmError(`deepseek-web: 网页对话失败: ${error instanceof Error ? error.message : String(error)}`, "WEB_TURN_FAILED", { cause: error });
		}
		this.checkReplyEnd(reply);
		let parsed = parseWebReply(reply.text);
		const visibleTools = visibleToolsOf(options, this.config);
		const allowedToolNames = new Set(visibleTools.map((tool) => tool.name));
		const toolSchemas = new Map(visibleTools.map((tool) => [tool.name, tool]));
		const delegatedNames = new Set(this.config.delegatedTools);
		let delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames);
		let problems = [];
		let correctedChars = 0;
		let delegatedChars = 0;
		let delegatedTurns = 0;
		const revalidate = () => {
			delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames);
			const delegatedSet = new Set(delegatedActions);
			const local = parsed.actions.filter((action) => !delegatedSet.has(action));
			const outcome = parsed.hasActions && (local.length > 0 || delegatedActions.length === 0) ? repairAndValidateActions(local, allowedToolNames, toolSchemas) : {
				actions: local,
				problems: []
			};
			parsed = {
				...parsed,
				actions: outcome.actions,
				hasActions: local.length > 0
			};
			problems = outcome.problems;
		};
		revalidate();
		/**
		* 游标只在完整 chunk 流交给上层之后再落盘：
		* 进程若在回合中途被杀，游标不会超前于 Harness 会话日志。
		*/
		const advanceAndSave = async () => {
			options.signal?.throwIfAborted();
			state.lastMessageId = [...options.messages].reverse().find((message) => message.id)?.id;
			state.roundsSinceProtocol = rendered.prompt.includeProtocol ? 0 : state.roundsSinceProtocol + 1;
			state.lastReply = reply.text;
			Object.assign(savedState, state);
			await this.sessions.save();
		};
		if (this.config.autoCorrectMalformed !== false && delegatedActions.length === 0 && (problems.length > 0 || !parsed.hasActions && (looksLikeIntendedToolReply(reply.text) || looksLikeUnfinishedHandoff(reply.text, state.goalText ?? "") || looksLikeTaskRequest(reply.text) || (options.tools?.length ?? 0) > 0 && looksLikeToolDenial(reply.text)))) {
			const reviewNote = problems.length > 0 ? `\n\n本地审查未通过，请修正后重新输出：\n${problems.map((item) => `- actions[${item.index}]${item.tool ? ` (${item.tool})` : ""}: ${item.problem}`).join("\n")}` : "";
			let correctedReply;
			try {
				correctedReply = yield* this.driveTurnAuto({
					sessionId,
					model,
					text: `${buildRecoveryPrompt(options, state, this.config)}${reviewNote}`,
					initialize: false,
					autoSend,
					signal: options.signal
				}, blocks, state, options);
			} catch (error) {
				throw new LlmError("deepseek-web: 已请求模型纠正输出格式，但等待网页发送超时。请在浏览器中点击发送以完成纠错。", "WEB_CORRECTION_TIMEOUT", { cause: error });
			}
			usageDeltaSum += this.accountUsage(correctedReply, state, false);
			usageObserved = usageObserved || correctedReply.accumulatedUsage !== void 0;
			reply = correctedReply;
			this.checkReplyEnd(reply);
			parsed = parseWebReply(correctedReply.text);
			revalidate();
			correctedChars += correctedReply.text.length + reviewNote.length;
		}
		if (problems.length > 0) {
			console.warn("[deepseek-web] 本地审查拒绝执行，模型原始输出：", reply.text.slice(0, 800));
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: `本地审查拒绝执行：${problems.map((item) => `actions[${item.index}]${item.tool ? ` (${item.tool})` : ""} ${item.problem}`).join("；")}`,
						code: "WEB_ACTION_REJECTED"
					}
				}
			};
			return;
		}
		if (delegatedActions.length > 0) {
			const sections = [];
			for (const action of delegatedActions) {
				const name$1 = action.tool ?? action.action ?? "";
				const prompt = buildDelegationPrompt(name$1, action);
				if (!prompt) {
					console.warn("[deepseek-web] 委托动作缺少可识别参数，已跳过：", name$1);
					continue;
				}
				let outcome;
				try {
					outcome = yield* this.driveTurnAuto({
						sessionId,
						model,
						text: prompt,
						initialize: false,
						autoSend,
						signal: options.signal
					}, blocks, state, options);
				} catch (error) {
					throw new LlmError(`deepseek-web: 工具委托轮失败（${name$1}）。请在浏览器中点击发送以完成委托。: ${error instanceof Error ? error.message : String(error)}`, "WEB_DELEGATION_FAILED", { cause: error });
				}
				usageDeltaSum += this.accountUsage(outcome, state, false);
				this.checkReplyEnd(outcome);
				usageObserved = usageObserved || outcome.accumulatedUsage !== void 0;
				const outcomeParsed = parseWebReply(outcome.text);
				sections.push(`[${name$1} 委托结果]\n${outcomeParsed.text}`);
				delegatedChars += prompt.length + outcome.text.length;
				delegatedTurns += 1;
			}
			if (sections.length > 0) parsed = {
				...parsed,
				text: sections.join("\n\n")
			};
		}
		const reviewLabel = this.config.review.provider === "kimi" ? "Kimi" : this.config.review.provider === "glm" ? "GLM" : "DeepSeek";
		let reviewSummary;
		if (!parsed.hasActions && this.reviewer && this.config.review.enabled && this.config.review.maxRounds > 0 && state.reviewRoundsUsed < this.config.review.maxRounds && state.reviewedSignature !== reviewSignature(state.goalText ?? "", parsed.text)) {
			let reviewRound = 0;
			while (reviewRound < this.config.review.maxRounds) {
				reviewRound++;
				const signature = reviewSignature(state.goalText ?? "", parsed.text);
				const evidence = this.reviewer.needsEvidence ? await buildReviewEvidence(options, state, parsed.text, this.config.review.maxEvidenceChars) : {
					task: state.goalText ?? "",
					artifact: "",
					files: []
				};
				let verdict;
				try {
					verdict = await this.reviewer.review(evidence);
				} catch (error) {
					console.warn(`[deepseek-web] ${reviewLabel} 审核失败，跳过本轮审核：`, error instanceof Error ? error.message : error);
					break;
				}
				state.reviewRoundsUsed += 1;
				state.reviewedSignature = signature;
				console.info(`[deepseek-web] ${reviewLabel} 审核结果：ok=${verdict.ok} issues=${verdict.issues.length}`);
				if (verdict.ok) {
					reviewSummary = [`✅ ${reviewLabel} 审核：通过`, verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join("；")}` : ""].filter(Boolean).join("\n");
					break;
				}
				reviewSummary = [
					`⚠️ ${reviewLabel} 审核（首版）：未通过，已回注修正`,
					verdict.issues.length > 0 ? `问题：${verdict.issues.slice(0, 3).join("；")}` : "",
					verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join("；")}` : ""
				].filter(Boolean).join("\n");
				const feedback = [
					"[审核反馈] 独立审核员认为当前产出未通过审核，请修正后重新输出。",
					verdict.issues.length > 0 ? `问题：\n${verdict.issues.map((item) => `- ${item}`).join("\n")}` : "",
					verdict.suggestions.length > 0 ? `建议：\n${verdict.suggestions.map((item) => `- ${item}`).join("\n")}` : "",
					state.goalText ? `[当前用户任务]\n${state.goalText}` : "",
					"若需要调用工具，请只输出 JSON 动作；否则输出修正后的最终正文。"
				].filter(Boolean).join("\n\n");
				const revised = yield* this.driveTurnAuto({
					sessionId,
					model,
					text: feedback,
					initialize: false,
					autoSend,
					signal: options.signal
				}, blocks, state, options);
				usageDeltaSum += this.accountUsage(revised, state, false);
				usageObserved = usageObserved || revised.accumulatedUsage !== void 0;
				reply = revised;
				this.checkReplyEnd(reply);
				parsed = parseWebReply(revised.text);
				revalidate();
				correctedChars += revised.text.length + feedback.length;
				if (problems.length > 0) break;
				if (parsed.hasActions) break;
			}
		}
		if (reviewSummary && !parsed.hasActions) parsed = {
			...parsed,
			text: `${parsed.text}\n\n---\n${reviewSummary}`
		};
		if (!parsed.hasActions && looksLikeUnfinishedHandoff(parsed.text, state.goalText ?? "")) throw new LlmError("网页仍返回未完成的任务交接摘要，未作为最终交付提交；请重试当前任务。", "WEB_UNFINISHED_HANDOFF");
		if (!parsed.hasActions) if (autoSend) {} else {
			await this.channel.setWebWindowTopmost?.(sessionId, false).catch(() => {});
			if (this.config.focus?.enabled !== false && this.config.focus?.dshWindow !== false) await this.channel.focusHarness().catch(() => {});
		}
		if (parsed.hasActions) state.lastParseOk = true;
		else state.lastParseOk = false;
		if (usageObserved) {
			const totals = usageDeltaSum > 0 ? this.sessions.addChannelTokens(usageDeltaSum) : this.sessions.getChannelTotals();
			this.onUsage?.(totals);
			console.info(`[deepseek-web] 本轮 token 用量：${usageDeltaSum}（网页会话累计 ${String(state.usageBaseline)}），通道总计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`);
			if (usageDeltaSum > 0) yield {
				type: "usage",
				usage: {
					inputTokens: 0,
					outputTokens: usageDeltaSum,
					totalTokens: usageDeltaSum
				}
			};
		}
		yield* replyChunks(parsed, {
			startIndex: blocks.next,
			nextCallId: 1
		});
		await advanceAndSave();
	}
};

//#endregion
//#region src/browser-shared.ts
const KEEPER_FILE = fileURLToPath(new URL("../tools/browser-keeper.mjs", import.meta.url));
/** 输入区候选选择器（textarea / contenteditable / role=textbox）。 */
const EDITOR_CANDIDATES = [
	"textarea",
	"div[contenteditable=\"true\"]",
	"div[contenteditable=\"plaintext-only\"]",
	"div[role=\"textbox\"]",
	"[data-lexical-editor=\"true\"]"
];
function locateEditor(page) {
	return page.locator(EDITOR_CANDIDATES.join(", ")).filter({ visible: true }).last();
}
/** 网页端“发送过于频繁/稍后重试”一类频控提示的匹配模式。 */
const RATE_LIMIT_PATTERN = /过于频繁|太频繁|发送太快|发送太快了|请.{0,4}稍后.{0,4}(重试|再试)|稍后再试|操作频繁|请求过于|too\s+(many|frequent)|rate[._\s-]?limit(?:ed)?|try\s+again\s+(later|soon)/i;
/** 判断一段文本（toast 文案或响应体）是否是频控提示。 */
function looksLikeRateLimitText(text) {
	return RATE_LIMIT_PATTERN.test(text);
}
/**
* 页面里是否正显示频控 toast。
*
* 只看“短小可见”的叶子元素（toast 的典型形态），并排除输入区本身——
* 避免把用户/协议文本里恰好包含“请稍后重试”的正文误判成频控。
*/
async function hasRateLimitToast(page) {
	return await page.evaluate((patternSource) => {
		const pattern = new RegExp(patternSource, "i");
		const editors = Array.from(document.querySelectorAll("textarea, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [role=\"textbox\"]"));
		const elements = Array.from(document.querySelectorAll("div, span, p, section, aside"));
		for (const element of elements) {
			if (!element.isConnected) continue;
			if (editors.some((editor) => editor.contains(element))) continue;
			const style = window.getComputedStyle(element);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
			const text = (element.textContent ?? "").trim();
			if (text.length === 0 || text.length > 120) continue;
			if (element.childElementCount > 2) continue;
			if (pattern.test(text)) return true;
		}
		return false;
	}, RATE_LIMIT_PATTERN.source).catch(() => false);
}
async function ensureChatPage(page, url) {
	if (!page.url().startsWith(new URL(url).origin)) await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 6e4
	});
	else await page.bringToFront();
}
async function looksLoggedOut(page, markers = [
	"sign_in",
	"sign-in",
	"login",
	"auth"
]) {
	const current = new URL(page.url());
	if (await locateEditor(page).isVisible().catch(() => false)) return false;
	return markers.some((marker) => current.pathname.includes(marker) || current.search.includes(marker));
}
/**
* 发送控件是否处于不可用状态。
*
* 登录墙的典型形态之一：输入框可见、也能填入文字，但发送按钮是 disabled
* （chat.z.ai 未登录时正是如此），表现是“填进去了、回车/点发送都没反应”。
* 找不到发送控件时返回 false（例如只认回车的站点），不误判正常页面。
*/
async function looksSendBlocked(page) {
	const control = page.locator([
		"button[class*=\"sendMessage\" i]",
		"button[aria-label*=\"发送\"]",
		"button[aria-label*=\"send\" i]",
		"button[title*=\"发送\"]",
		"button[title*=\"send\" i]",
		"[role=\"button\"][aria-label*=\"发送\"]",
		"[role=\"button\"][aria-label*=\"send\" i]"
	].join(", ")).first();
	if (await control.count().catch(() => 0) === 0) return false;
	if (!await control.isVisible().catch(() => false)) return false;
	return await control.evaluate((element) => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className)).catch(() => false);
}
/**
* 登录墙判定：URL 命中登录标记，或“输入框可见 + 页面有登录入口 + 发送控件被禁用”。
*
* 只按 URL 判断会漏掉 chat.z.ai 这类站点：未登录时停在首页、输入框照样可见，
* 直到用户点发送才发现发不出去。把“发不出去”的信号也纳入判定后，通道可以
* 立刻抛出“请先登录”的明确错误，而不是让用户等满一轮超时。
*/
async function looksLoginWall(page, markers = [
	"sign_in",
	"sign-in",
	"login",
	"auth",
	"passport"
]) {
	const current = new URL(page.url());
	if (markers.some((marker) => current.pathname.includes(marker) || current.search.includes(marker))) return true;
	if (!await locateEditor(page).isVisible().catch(() => false)) return false;
	if (!await page.getByText(/^\s*(登录|登入|立即登录|Sign in|Sign in \/ Sign up|Log in|Login)\s*$/i).first().isVisible().catch(() => false)) return false;
	return await looksSendBlocked(page);
}
/**
* 尝试点击“开启新对话/New chat”入口。返回是否成功触发点击。
*
* 全自动模式下 DeepSeek 标签页常处于后台，`locator.click()` 依赖元素可命中
* （visible/stable/receives events），后台标签页里侧栏可能未布局，点击会静默失败，
* 从而沿用上一次网页对话。因此除定位器点击外，追加页面内原生 DOM 点击兜底：
* 它不要求标签页在前台，也不要求元素可命中。
*/
async function bestEffortNewChat(page) {
	const labels = [
		"开启新对话",
		"新建对话",
		"新对话",
		"新话题",
		"New chat",
		"New Chat",
		"New topic"
	];
	for (const label of labels) {
		const candidate = page.getByText(label, { exact: true }).first();
		if (await candidate.isVisible().catch(() => false)) {
			if (await candidate.click({ timeout: 3e3 }).then(() => true).catch(() => false)) return true;
		}
	}
	const roleButton = page.getByRole("button", { name: /新建对话|新对话|新话题|New chat|New topic/i }).first();
	if (await roleButton.isVisible().catch(() => false)) {
		if (await roleButton.click({ timeout: 3e3 }).then(() => true).catch(() => false)) return true;
	}
	return await page.evaluate((texts) => {
		const norm = (value) => (value ?? "").replace(/\s+/gu, " ").trim();
		const elements = Array.from(document.querySelectorAll("button, a, [role=\"button\"], div, span"));
		for (const label of texts) {
			const exact = elements.find((el) => norm(el.textContent) === label);
			if (exact) {
				exact.click();
				return true;
			}
		}
		for (const label of texts) {
			const partial = elements.find((el) => {
				const aria = norm(el.getAttribute("aria-label"));
				const title = norm(el.getAttribute("title"));
				const text = norm(el.textContent);
				return aria.includes(label) || title.includes(label) || text.includes(label) && text.length <= label.length + 4;
			});
			if (partial) {
				partial.click();
				return true;
			}
		}
		return false;
	}, labels).catch(() => false);
}
/** 用标题前缀提示当前状态（等待人工点击/生成中/需要选择）。 */
async function markPageTitle(page, marker, state) {
	if (state.original === void 0) state.original = await page.title();
	const clean = state.original.replace(/^\[[^\]]*\]\s*/u, "");
	await page.evaluate(({ title, prefix }) => {
		document.title = prefix ? `${prefix} ${title}` : title;
	}, {
		title: clean,
		prefix: marker
	}).catch(() => {});
}
/** 启动/复用脱离本进程的浏览器常驻守护。 */
function spawnKeeper(options) {
	spawn(process.execPath, [
		KEEPER_FILE,
		"--profile",
		options.profileDir,
		"--port",
		String(options.port),
		"--url",
		options.url
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
function browserCandidates(channel) {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
		if (channel === "msedge") return [
			path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
		];
		return [
			path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
		];
	}
	if (process.platform === "darwin") return channel === "msedge" ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
	return channel === "msedge" ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"] : [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium"
	];
}
function resolveBrowserExecutable(channel) {
	return browserCandidates(channel).find((candidate) => existsSync(candidate));
}
/** 选择 preferredPort；被占用时改用系统分配的本地空闲端口。 */
async function findAvailablePort(preferredPort) {
	const probe = (port) => new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(void 0));
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			const selected = typeof address === "object" && address ? address.port : void 0;
			server.close(() => resolve(selected));
		});
	});
	return await probe(preferredPort) ?? await probe(0) ?? preferredPort;
}
/**
* 启动插件自有的真实 Edge/Chrome，再通过 CDP 连接。
*
* 这里刻意不使用 Playwright 的 launchPersistentContext：直接启动用户安装的
* 浏览器可以避免 Playwright 自动注入的启动参数，同时仍保留独立 profile 和
* 可控的浏览器生命周期。
*/
async function launchManagedBrowser(options) {
	const executable = resolveBrowserExecutable(options.channel);
	if (!executable) throw new LlmError(`${options.label}: 找不到 ${options.channel === "msedge" ? "Microsoft Edge" : "Google Chrome"} 可执行文件。`, "BROWSER_NOT_FOUND");
	const port = await findAvailablePort(options.preferredPort);
	const child = spawn(executable, [
		`--user-data-dir=${options.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${port}`,
		...options.channel === "msedge" ? ["--disable-features=msEdgeSidebarV2"] : []
	], {
		detached: false,
		stdio: "ignore",
		windowsHide: false
	});
	const endpoint = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 60; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1e3));
		try {
			const browser = await chromium.connectOverCDP(endpoint);
			const context = browser.contexts()[0];
			if (context) return {
				browser,
				context,
				process: child,
				port
			};
			await browser.close().catch(() => {});
		} catch {}
	}
	child.kill();
	throw new LlmError(`${options.label}: ${options.channel} 已启动，但 CDP ${port} 在 60 秒内未就绪。`, "BROWSER_MANAGED_START_FAILED");
}
/** 连接（必要时拉起守护）CDP 浏览器。 */
async function connectBrowser(options) {
	const endpoint = `http://127.0.0.1:${options.port}`;
	try {
		const browser = await chromium.connectOverCDP(endpoint);
		const context = browser.contexts()[0];
		if (!context) throw new LlmError(`${options.label}: CDP 浏览器没有可用 context`, "BROWSER_ATTACH_FAILED");
		return {
			browser,
			context
		};
	} catch (error) {
		if (!options.autoStartKeeper) throw error;
		spawnKeeper({
			profileDir: options.profileDir,
			port: options.port,
			url: options.url
		});
		for (let attempt = 0; attempt < 60; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1e3));
			try {
				const browser = await chromium.connectOverCDP(endpoint);
				const context = browser.contexts()[0];
				if (context) return {
					browser,
					context
				};
			} catch {}
		}
		throw new LlmError(`${options.label}: 无法连接浏览器常驻进程（CDP ${options.port} 60 秒内未就绪）。`, "BROWSER_ATTACH_FAILED");
	}
}
/** 默认的浏览器 profile 目录（工作区外）。 */
function defaultProfileDir(name$1) {
	const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
	return path.join(appDataRoot, "DshDeepSeekWeb", name$1);
}
/**
* 把 dsh 宿主窗口提到最前（“放在屏幕最上端”）。
*
* 仅在 Windows 上生效：用 PowerShell 枚举顶层窗口，按进程名或标题正则
* 匹配第一个可见窗口并调用 SetForegroundWindow。找不到匹配时静默返回 false，
* 不抛异常，避免影响主流程。
*/
async function focusDshWindow(options) {
	if (process.platform !== "win32") return false;
	const names = (options.processNames ?? []).map((name$1) => String(name$1).trim()).filter((name$1) => name$1.length > 0);
	const pattern = (options.titlePattern ?? "").trim();
	if (names.length === 0 && !pattern) return false;
	const script = buildFocusScript(names, pattern);
	return await new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			console.warn("[deepseek-web] focusDshWindow: 聚焦脚本执行超时（5s），已放弃并继续主流程。");
			resolve(false);
		}, 5e3);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			console.warn("[deepseek-web] focusDshWindow: 无法启动 powershell.exe：", error.message);
			resolve(false);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const ok = out.trim() === "1";
			if (!ok) console.warn(`[deepseek-web] focusDshWindow: 未匹配到 dsh 窗口，已静默跳过。 进程名候选=${JSON.stringify(names)} 标题正则=${JSON.stringify(pattern)}`);
			resolve(ok);
		});
	});
}
/**
* 生成聚焦脚本。
*
* 注意：窗口枚举与匹配全部放在 C# 内完成（包括用 .NET 的 Process 取进程名），
* 不依赖 PowerShell 委托回调的 runspace 与 $script: 作用域——后者在
* EnumWindows 回调里写回外层变量并不可靠，会静默失败。
*/
function buildFocusScript(processNames, titlePattern) {
	const namesJson = JSON.stringify(processNames);
	const patternJson = JSON.stringify(titlePattern);
	return [
		"$ErrorActionPreference='SilentlyContinue'",
		"Add-Type @\"",
		"using System;",
		"using System.Text;",
		"using System.Diagnostics;",
		"using System.Runtime.InteropServices;",
		"public class DshFocus {",
		"  [DllImport(\"user32.dll\")] static extern bool SetForegroundWindow(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int c);",
		"  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
		"  [DllImport(\"user32.dll\")] static extern int GetWindowTextLength(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
		"  delegate bool EnumProc(IntPtr h, IntPtr l);",
		"  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr l);",
		"  public static IntPtr Target = IntPtr.Zero;",
		"  static string[] Names = new string[0];",
		"  static string Pattern = \"\";",
		"  public static string Find(string[] names, string pattern) {",
		"    Names = names ?? new string[0];",
		"    Pattern = pattern ?? \"\";",
		"    Target = IntPtr.Zero;",
		"    EnumWindows(delegate(IntPtr h, IntPtr l) {",
		"      if (!IsWindowVisible(h)) return true;",
		"      int len = GetWindowTextLength(h);",
		"      if (len <= 0) return true;",
		"      var sb = new StringBuilder(len + 1);",
		"      GetWindowText(h, sb, sb.Capacity);",
		"      string text = sb.ToString();",
		"      uint pid = 0;",
		"      GetWindowThreadProcessId(h, out pid);",
		"      string pname = \"\";",
		"      try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {}",
		"      bool hit = false;",
		"      foreach (var n in Names) {",
		"        if (!string.IsNullOrEmpty(n) && string.Equals(n, pname, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }",
		"      }",
		"      if (!hit && Pattern.Length > 0) {",
		"        try { if (System.Text.RegularExpressions.Regex.IsMatch(text, Pattern)) hit = true; } catch {}",
		"      }",
		"      if (hit) { Target = h; return false; }",
		"      return true;",
		"    }, IntPtr.Zero);",
		"    return Target.ToString();",
		"  }",
		"  public static void Activate() {",
		"    ShowWindow(Target, 9);",
		"    SetForegroundWindow(Target);",
		"  }",
		"}",
		"\"@",
		`[string[]]$names = @(ConvertFrom-Json '${namesJson}')`,
		`[string]$pattern = [string](ConvertFrom-Json '${patternJson}')`,
		"$found = [DshFocus]::Find($names, $pattern)",
		"if ($found -ne \"0\") {",
		"  [DshFocus]::Activate()",
		"  Write-Output '1'",
		"} else {",
		"  Write-Output '0'",
		"}"
	].join("\n");
}
/**
* 设置插件浏览器窗口是否置顶（屏幕最上方）。
*
* 仅 Windows 生效：按命令行里的 profile 目录特征定位插件专用的 msedge 窗口，
* SetWindowPos(HWND_TOPMOST/NOTOPMOST)，置顶时同时 SetForegroundWindow。
* 进程匹配放在 PowerShell 管道里完成（Get-CimInstance 提供 CommandLine，
* Get-Process 提供 MainWindowHandle），只把句柄交给 P/Invoke。
* 找不到匹配时静默返回 false，不影响主流程。
*/
async function setBrowserWindowTopmost(options) {
	if (process.platform !== "win32") return false;
	const marker = String(options.profileDir ?? "").trim();
	if (!marker) return false;
	const markerJson = JSON.stringify(marker);
	const topmostJson = JSON.stringify(options.topmost === true);
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		`[string]$marker = [string](ConvertFrom-Json '${markerJson}')`,
		`[bool]$topmost = [bool](ConvertFrom-Json '${topmostJson}')`,
		`$pattern = '*' + $marker + '*'`,
		`$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like $pattern } | ForEach-Object { $_.ProcessId })`,
		"if ($ids.Count -eq 0) { Write-Output \"0\"; exit }",
		"Add-Type @\"",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public class DshTop {",
		"  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);",
		"  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
		"  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
		"  public static void Apply(IntPtr h, bool topmost) {",
		"    IntPtr after = topmost ? new IntPtr(-1) : new IntPtr(-2);",
		"    SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);",
		"    if (topmost) SetForegroundWindow(h);",
		"  }",
		"}",
		"\"@",
		"$hit = 0",
		"Get-Process -Name msedge | Where-Object { $ids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | ForEach-Object {",
		"  if ([DshTop]::IsWindowVisible($_.MainWindowHandle)) { [DshTop]::Apply($_.MainWindowHandle, $topmost); $hit++ }",
		"}",
		"if ($hit -gt 0) { Write-Output \"1\" } else { Write-Output \"0\" }"
	].join("\n");
	return await new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			console.warn("[deepseek-web] setBrowserWindowTopmost: 脚本执行超时（5s），已放弃并继续主流程。");
			resolve(false);
		}, 5e3);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			console.warn("[deepseek-web] setBrowserWindowTopmost: 无法启动 powershell.exe：", error.message);
			resolve(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 && out.trim() === "1");
		});
	});
}

//#endregion
//#region src/playwright-channel.ts
/** 频控 toast / 实时增量的轮询间隔。 */
const POLL_INTERVAL_MS = 800;
/** 增量里的原始流特征（SSE 帧 / DeepSeek 网页协议字段），出现即说明捕获错了流。 */
const POLLUTION_PATTERN = /(^|\n)\s*(event:\s*\w+|data:\s*\{)|request_message_id/;
function matchesCompletionUrl(url) {
	return /\/chat\/completion\b/i.test(url) || /\/chat\/completions?$/i.test(url) || /\/conversation\/(chat|completion)/i.test(url);
}
/** 从 SSE / JSON body 里抽取模型可见正文与思考内容。 */
function parseCompletionBody(body) {
	const fragments = [];
	let untrackedText = "";
	let untrackedReasoning = "";
	let lastPatchPath;
	let lastPatchOp = "APPEND";
	let accumulatedUsage;
	let contextLengthExceeded = false;
	let finishReason;
	function observeFinish(value) {
		if (typeof value !== "string") return;
		const reason = value.toLowerCase();
		if (reason === "context_length_exceeded") contextLengthExceeded = true;
		else if ([
			"length",
			"max_tokens",
			"max-tokens",
			"max_output_tokens"
		].includes(reason)) finishReason = "max-tokens";
		else if ([
			"interrupted",
			"aborted",
			"cancelled",
			"canceled",
			"content_filter",
			"error"
		].includes(reason)) finishReason = "interrupted";
		else if (["stop", "finished"].includes(reason) && !finishReason) finishReason = "stop";
	}
	/** 记录网页端上报的会话累计 token 用量（只增不减时取最新）。 */
	function observeUsage(value) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) accumulatedUsage = value;
	}
	function upsertFragment(fragment, mode) {
		const index = fragment.id === void 0 ? -1 : fragments.findIndex((item) => item.id === fragment.id);
		if (index >= 0) {
			const current = fragments[index];
			current.type = fragment.type || current.type;
			current.content = mode === "replace" ? fragment.content : current.content + fragment.content;
		} else fragments.push({ ...fragment });
	}
	function collectFullResponse(json) {
		const root = json;
		if (root.v?.response?.accumulated_token_usage !== void 0) observeUsage(root.v.response.accumulated_token_usage);
		const fragmentList = root.v?.response?.fragments;
		observeFinish(root.v?.response?.finish_reason);
		if (!Array.isArray(fragmentList)) return;
		for (const fragment of fragmentList) {
			if (typeof fragment.content !== "string") continue;
			upsertFragment({
				id: fragment.id,
				type: String(fragment.type ?? ""),
				content: fragment.content
			}, "replace");
		}
	}
	function lastFragmentIndex() {
		for (let i = fragments.length - 1; i >= 0; i--) if ((fragments[i]?.type ?? "").toUpperCase() !== "THINK") return i;
		return fragments.length - 1;
	}
	function applyPatch(payload) {
		const pointer = typeof payload.p === "string" ? payload.p : lastPatchPath;
		const op = typeof payload.o === "string" ? payload.o : lastPatchOp;
		const value = payload.v;
		if (!pointer) return;
		lastPatchPath = pointer;
		lastPatchOp = op;
		if (pointer === "response/finish_reason") observeFinish(value);
		if (pointer === "response/fragments" && op === "APPEND" && Array.isArray(value)) {
			for (const fragment of value) if (fragment && typeof fragment === "object" && typeof fragment.content === "string") upsertFragment(fragment, "replace");
			return;
		}
		if (pointer === "response/fragments/-1/content") {
			const index = lastFragmentIndex();
			if (index >= 0 && typeof value === "string") {
				const fragment = fragments[index];
				fragment.content += value;
			}
			return;
		}
		if (op === "BATCH" && Array.isArray(value)) {
			for (const item of value) {
				if (item && item.p === "accumulated_token_usage") observeUsage(item.v);
				if (item && item.p === "finish_reason") observeFinish(item.v);
			}
			return;
		}
	}
	function consumeFragments() {
		for (const fragment of fragments) {
			const type = String(fragment.type ?? "").toUpperCase();
			if (type === "RESPONSE" || type === "TEXT" || type === "CONTENT" || type === "") untrackedText += fragment.content;
			else if (type === "THINK" || type === "THINKING" || type === "REASONING" || type === "THOUGHT") untrackedReasoning += fragment.content;
		}
	}
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		const dataIdx = line.indexOf("data:");
		if (dataIdx < 0) continue;
		const payload = line.slice(dataIdx + 5).trim();
		if (!payload || payload === "[DONE]") continue;
		let json;
		try {
			json = JSON.parse(payload);
		} catch {
			continue;
		}
		if (!json || typeof json !== "object") continue;
		observeFinish(json.finish_reason);
		if (json && typeof json === "object" && "p" in json) {
			applyPatch(json);
			continue;
		}
		if (json.finish_reason === "context_length_exceeded" || json.type === "error" && String(json.content ?? "").includes("对话长度上限")) {
			contextLengthExceeded = true;
			continue;
		}
		if (json.v && typeof json.v === "object" && json.v.response) {
			collectFullResponse(json);
			continue;
		}
		if (!("p" in json) && Object.keys(json).length <= 1 && "v" in json && lastPatchPath) {
			applyPatch({ ...json });
			continue;
		}
		if (Array.isArray(json.choices)) {
			const choiceJson = json;
			for (const choice of choiceJson.choices ?? []) {
				observeFinish(choice.finish_reason);
				const delta = choice.delta;
				const message = choice.message;
				if (typeof message?.content === "string") untrackedText += message.content;
				if (typeof message?.reasoning_content === "string") untrackedReasoning += message.reasoning_content;
				if (typeof delta?.content === "string") untrackedText += delta.content;
				const think = delta?.reasoning_content ?? delta?.reasoner;
				if (typeof think === "string") untrackedReasoning += think;
			}
		}
	}
	consumeFragments();
	if (untrackedText || untrackedReasoning) return {
		text: untrackedText.trim(),
		...untrackedReasoning.trim() ? { reasoning: untrackedReasoning.trim() } : {},
		reliable: true,
		...finishReason ? { finishReason } : {},
		...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
		...contextLengthExceeded ? { contextLengthExceeded: true } : {}
	};
	try {
		const json = JSON.parse(body);
		let fallbackText = "";
		let fallbackReasoning = "";
		observeFinish(json.finish_reason);
		for (const choice of json.choices ?? []) {
			observeFinish(choice.finish_reason);
			if (typeof choice.message?.content === "string") fallbackText += choice.message.content;
			if (typeof choice.message?.reasoning_content === "string") fallbackReasoning += choice.message.reasoning_content;
			if (typeof choice.text === "string") fallbackText += choice.text;
		}
		if (typeof json.content === "string") fallbackText += json.content;
		if (fallbackText.trim() || fallbackReasoning.trim()) return {
			text: fallbackText.trim(),
			...fallbackReasoning.trim() ? { reasoning: fallbackReasoning.trim() } : {},
			reliable: true,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {}
		};
		return {
			text: "",
			reliable: false,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {}
		};
	} catch {
		return {
			text: body.trim(),
			reliable: false,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {}
		};
	}
}
var PlaywrightBrowserChannel = class {
	browser;
	context;
	page;
	turnLock = new AsyncLock();
	activeSessionId;
	/** 当前页面是否已经承载过 agent 对话；同一浏览器进程内只新建一次对话。 */
	conversationStarted = false;
	/** 页面原始标题，用于状态标记前缀的清除/还原。 */
	originalTitles = /* @__PURE__ */ new WeakMap();
	options;
	profileDir;
	managedConnection;
	constructor(options) {
		this.options = options;
		this.profileDir = options.profileDir ?? options.config.profileDir ?? defaultProfileDir("edge-profile");
	}
	async ensureReady() {
		if (this.browser && this.page && !this.page.isClosed()) return;
		if (this.browser?.isConnected() && this.context) {
			this.page = await this.context.newPage();
			this.conversationStarted = false;
			this.activeSessionId = void 0;
			await ensureChatPage(this.page, this.options.config.url);
			return;
		}
		if (this.options.config.browser === "attach") {
			const { browser, context } = await connectBrowser({
				port: this.options.config.debugPort,
				profileDir: this.profileDir,
				url: this.options.config.url,
				autoStartKeeper: this.options.config.autoStartKeeper,
				label: "deepseek-web"
			});
			this.browser = browser;
			this.context = context;
		} else {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(this.profileDir, { recursive: true });
			this.managedConnection = await launchManagedBrowser({
				channel: this.options.config.channel,
				profileDir: this.profileDir,
				preferredPort: this.options.config.debugPort,
				url: this.options.config.url,
				label: "deepseek-web"
			});
			this.browser = this.managedConnection.browser;
			this.context = this.managedConnection.context;
		}
		const pages = this.context.pages();
		this.page = pages.find((p) => p.url().startsWith(new URL(this.options.config.url).origin)) ?? pages[0] ?? await this.context.newPage();
		if (this.options.config.browser === "managed") await Promise.all(pages.filter((page) => page !== this.page).map((page) => page.close().catch(() => {})));
		await ensureChatPage(this.page, this.options.config.url);
		await this.page.waitForTimeout(1500);
		if (await looksLoggedOut(this.page)) throw new LlmError("deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。", "WEB_LOGIN_REQUIRED");
	}
	resetConversationGate() {
		this.conversationStarted = false;
	}
	isConversationActive(sessionId) {
		return this.activeSessionId === sessionId && this.page !== void 0 && !this.page.isClosed();
	}
	/** 轮换到全新网页对话（上下文长度达到上限时由 adapter 调用）。 */
	async startNewConversation() {
		if (!this.page) await this.ensureReady();
		const page = this.page;
		this.originalTitles.delete(page);
		await this.startFreshConversation(page);
		this.conversationStarted = true;
	}
	/**
	* 确保网页端切到一个全新对话。
	*
	* 先尝试点击侧栏入口；若点击失败或 URL 未变化，则回退为重新打开入口页，
	* 强制落到全新对话，避免沿用上一次的网页会话（全自动模式下的典型问题）。
	*/
	async startFreshConversation(page, entryUrl = this.options.config.url) {
		const beforeUrl = page.url();
		const existingPages = new Set(page.context().pages());
		const clicked = await bestEffortNewChat(page);
		await page.waitForTimeout(800);
		await Promise.all(page.context().pages().filter((candidate) => candidate !== page && !existingPages.has(candidate)).map((candidate) => candidate.close().catch(() => {})));
		if (clicked && page.url() !== beforeUrl) console.info("[deepseek-web] 已切换到新对话。");
		else {
			console.warn("[deepseek-web] 未能确认切换到新对话，回退为重新打开入口页以强制新会话。");
			await page.goto(entryUrl, {
				waitUntil: "domcontentloaded",
				timeout: 6e4
			}).catch(() => {});
			await page.waitForTimeout(1e3);
		}
		await locateEditor(page).waitFor({
			state: "visible",
			timeout: 15e3
		}).catch(() => {});
	}
	async markPageStatus(page, marker) {
		if (!this.originalTitles.has(page)) this.originalTitles.set(page, await page.title());
		const clean = this.originalTitles.get(page).replace(/^\[dsh[^\]]*\]\s*/u, "");
		await page.evaluate(({ title, prefix }) => {
			document.title = prefix ? `${prefix} ${title}` : title;
		}, {
			title: clean,
			prefix: marker
		});
	}
	async turn(request) {
		const release = await this.turnLock.acquire(request.signal);
		try {
			if (!this.page) await this.ensureReady();
			const page = this.page;
			console.info(`[deepseek-web] turn 入口 session=${request.sessionId} initialize=${String(request.initialize)} conversationStarted=${String(this.conversationStarted)}`);
			if (request.initialize && !this.conversationStarted) {
				await this.startFreshConversation(page);
				this.conversationStarted = true;
			}
			if (!request.preserveConversation) this.activeSessionId = request.sessionId;
			return await this.turnOnPage(page, request);
		} finally {
			release();
		}
	}
	async turnIsolated(request) {
		const release = await this.turnLock.acquire(request.signal);
		let page;
		try {
			await this.ensureReady();
			request.signal?.throwIfAborted();
			page = await this.context.newPage();
			const entryUrl = new URL("/", this.options.config.url).href;
			await page.goto(entryUrl, {
				waitUntil: "domcontentloaded",
				timeout: 6e4
			});
			await this.startFreshConversation(page, entryUrl);
			return await this.turnOnPage(page, request);
		} finally {
			await page?.close().catch(() => {});
			await this.setWebWindowTopmost(request.sessionId, false).catch(() => {});
			release();
		}
	}
	async turnOnPage(page, request) {
		const rateLimit = this.options.config.rateLimit;
		const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 5;
		for (let attempt = 0;; attempt++) {
			request.signal?.throwIfAborted();
			const outcome = await this.sendAndWait(page, request);
			if (outcome.kind === "completed") {
				const parsed = parseCompletionBody(outcome.completion.body);
				if (outcome.completion.status >= 400) throw new LlmError(`网页返回 HTTP ${outcome.completion.status}，未作为有效回复提交。`, "WEB_HTTP_ERROR");
				if (!parsed.text && !parsed.reasoning && parsed.contextLengthExceeded !== true && !outcome.completion.interrupted && !["max-tokens", "interrupted"].includes(parsed.finishReason ?? "")) throw new LlmError(`deepseek-web: 网页响应没有可解析正文（HTTP ${outcome.completion.status}，${outcome.completion.url}）`, "WEB_EMPTY_RESPONSE");
				if (!parsed.reliable && !parsed.contextLengthExceeded && !parsed.finishReason && !outcome.completion.interrupted) throw new LlmError("网页响应格式无法识别，原始网络内容未作为正文提交。", "WEB_UNPARSEABLE_RESPONSE");
				return {
					text: parsed.text,
					...parsed.reasoning !== void 0 ? { reasoning: parsed.reasoning } : {},
					...parsed.accumulatedUsage !== void 0 ? { accumulatedUsage: parsed.accumulatedUsage } : {},
					...parsed.contextLengthExceeded === true ? { contextLengthExceeded: true } : {},
					...outcome.completion.interrupted ? { finishReason: "interrupted" } : parsed.finishReason ? { finishReason: parsed.finishReason } : {}
				};
			}
			if (attempt >= maxRetries) throw new LlmError(`deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功。请稍后在网页端手动发送，或稍后重试本任务。`, "WEB_RATE_LIMITED");
			const delayMs = rateLimit?.retryDelayMs ?? 3e4;
			console.info(`[deepseek-web] 网页提示发送频繁，${Math.round(delayMs / 1e3)}s 后自动重发同一条消息（第 ${attempt + 1}/${maxRetries} 次）…`);
			await this.markPageStatus(page, `[dsh 频控：${Math.round(delayMs / 1e3)}s 后自动重发]`);
			await this.sleep(delayMs, request.signal);
			await this.markPageStatus(page, void 0).catch(() => {});
		}
	}
	/**
	* 一轮“填入 → 发送 → 等回复”。检测到频控（toast / 429 / 响应体提示）时
	* 返回 rate-limited，由 turn() 的重发循环接手；其余情况返回完整响应。
	* 同时把网页端的流式增量经 onProgress 回调上抛（实时思考流）。
	*/
	async sendAndWait(page, request) {
		const autoSend = request.autoSend ?? this.autoSendSessions.get(request.sessionId) ?? this.options.config.sendMode === "approved";
		let waiterActive = true;
		const waiter = page.waitForResponse(async (response) => {
			if (response.request().method() !== "POST") return false;
			if (!matchesCompletionUrl(response.url())) return false;
			return true;
		}, { timeout: this.options.config.streamIdleTimeoutMs }).then(async (response) => {
			await this.markPageStatus(page, "[dsh 网页生成中]").catch(() => {});
			const interrupted = await response.finished().then((error) => error !== null, () => true);
			const body = await response.body().catch(() => "");
			if (!waiterActive) return void 0;
			return {
				url: response.url(),
				request: { postData: response.request().postData()?.slice(0, 4e3) },
				status: response.status(),
				body: body.toString(),
				interrupted
			};
		}, (error) => {
			if (!waiterActive) return void 0;
			throw error;
		});
		waiter.catch(() => {});
		let abortListener;
		const aborted = new Promise((_, reject) => {
			if (!request.signal) return;
			abortListener = () => reject(new LlmError("网页回合已取消。", "WEB_TURN_ABORTED"));
			request.signal.addEventListener("abort", abortListener, { once: true });
			if (request.signal.aborted) abortListener();
		});
		aborted.catch(() => {});
		let progressTimer;
		let toastTimer;
		try {
			request.signal?.throwIfAborted();
			let rateLimitedNow;
			const rateLimited = new Promise((resolve) => {
				rateLimitedNow = () => resolve({ kind: "rate-limited" });
			});
			const editor = locateEditor(page);
			if (!await editor.isVisible().catch(() => false)) {
				if (!await editor.waitFor({
					state: "visible",
					timeout: 15e3
				}).then(() => true).catch(() => false)) {
					waiterActive = false;
					if (await looksLoggedOut(page)) throw new LlmError("deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。", "WEB_LOGIN_REQUIRED");
					throw new LlmError("deepseek-web: 未找到聊天输入框。请确认浏览器停留在 chat.deepseek.com 的对话页；若刚切换过页面请稍等片刻后重试。", "WEB_EDITOR_NOT_FOUND");
				}
			}
			progressTimer = request.onProgress ? await this.startProgressPolling(page, request) : void 0;
			toastTimer = setInterval(() => {
				hasRateLimitToast(page).then((hit) => {
					if (hit) rateLimitedNow?.();
				});
			}, POLL_INTERVAL_MS);
			request.signal?.throwIfAborted();
			await editor.click();
			await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
			await page.keyboard.press("Backspace");
			await page.keyboard.insertText(request.text);
			if (page === this.page) this.conversationStarted = true;
			if (autoSend) {
				await editor.focus();
				await page.keyboard.press("Enter");
				await this.markPageStatus(page, "[dsh 自动发送中]");
				console.info("[deepseek-web] 全自动：已输入并回车发送…");
			} else {
				await page.bringToFront();
				const focus = this.options.config.focus;
				if (focus?.enabled !== false && focus?.webWindow !== false) await setBrowserWindowTopmost({
					profileDir: this.profileDir,
					topmost: true
				}).catch(() => {});
				await editor.focus();
				await this.markPageStatus(page, "[dsh 等待你在网页点击发送]");
				console.info("[deepseek-web] 消息已填入 Edge 并置顶聚焦，请回车或点击“发送”…");
			}
			const winner = await Promise.race([
				waiter,
				rateLimited,
				aborted
			]);
			if (winner === void 0) return { kind: "rate-limited" };
			if ("kind" in winner) return winner;
			if (winner.status === 429 || looksLikeRateLimitText(winner.body.slice(0, 2e3))) {
				console.warn(`[deepseek-web] 响应判定为频控（HTTP ${winner.status}）。`);
				return { kind: "rate-limited" };
			}
			console.info("[deepseek-web] 已收到网页完整回复，正在解析…");
			return {
				kind: "completed",
				completion: winner
			};
		} catch (error) {
			if (request.signal?.aborted) throw new LlmError("网页回合已取消。", "WEB_TURN_ABORTED");
			if (error instanceof LlmError) throw error;
			if (page.isClosed()) throw new LlmError("deepseek-web: 浏览器页面被关闭", "WEB_PAGE_CLOSED");
			if (await hasRateLimitToast(page)) return { kind: "rate-limited" };
			throw new LlmError(autoSend ? "deepseek-web: 全自动发送后未收到网页响应。可能回车未触发发送（输入框为空或页面结构变化），请人工检查网页后重试。" : "deepseek-web: 已把消息填入浏览器，等待你点击“发送”超时。请确认输入框内容后点击页面上的发送按钮重试。", autoSend ? "WEB_AUTO_SEND_TIMEOUT" : "WEB_MANUAL_SEND_TIMEOUT");
		} finally {
			waiterActive = false;
			clearInterval(toastTimer);
			if (progressTimer) clearInterval(progressTimer);
			if (abortListener) request.signal?.removeEventListener("abort", abortListener);
			await this.markPageStatus(page, void 0).catch(() => {});
		}
	}
	/** 可中断的等待（AbortSignal 触发时抛 WEB_TURN_ABORTED）。 */
	async sleep(ms, signal) {
		const step = 200;
		for (let waited = 0; waited < ms; waited += step) {
			if (signal?.aborted) throw new LlmError("deepseek-web: 等待频控重发期间回合被取消。", "WEB_TURN_ABORTED");
			await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
		}
	}
	/**
	* 注入页面网络镜像（fetch + XHR）：把匹配 chat/completion 的 POST 响应体
	* 累积到 window.__dshWebCapture，供实时思考流轮询。幂等，页面导航后重装。
	*/
	async ensureCapture(page) {
		await page.evaluate(() => {
			const w = window;
			if (w.__dshWebCapture) {
				w.__dshWebCapture.entries = w.__dshWebCapture.entries.slice(-20);
				return;
			}
			const state = { entries: [] };
			w.__dshWebCapture = state;
			const matches = (url, method) => {
				if (method !== void 0 && method.toUpperCase() !== "POST") return false;
				return /\/chat\/completion/i.test(url);
			};
			const keep = (entry) => {
				state.entries.push(entry);
				if (state.entries.length > 20) state.entries.splice(0, state.entries.length - 20);
			};
			const originalFetch = w.fetch.bind(w);
			w.fetch = async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
				const method = init?.method ?? (input instanceof Request ? input.method : void 0);
				if (!matches(String(url), method)) return originalFetch(input, init);
				const entry = {
					at: Date.now(),
					body: "",
					done: false
				};
				keep(entry);
				try {
					const response = await originalFetch(input, init);
					const reader = response.clone().body?.getReader();
					if (reader) {
						const decoder = new TextDecoder();
						(async () => {
							for (;;) {
								const { done, value } = await reader.read();
								if (value) entry.body += decoder.decode(value, { stream: true });
								if (done) break;
							}
							entry.done = true;
						})().catch(() => {
							entry.done = true;
						});
					} else entry.done = true;
					return response;
				} catch (error) {
					entry.done = true;
					throw error;
				}
			};
			const originalOpen = XMLHttpRequest.prototype.open;
			const originalSend = XMLHttpRequest.prototype.send;
			XMLHttpRequest.prototype.open = function(method, url, ...rest) {
				this.__dshUrl = String(url);
				this.__dshMethod = String(method);
				return originalOpen.apply(this, [
					method,
					url,
					...rest
				]);
			};
			XMLHttpRequest.prototype.send = function(...args) {
				if (matches(this.__dshUrl ?? "", this.__dshMethod)) {
					const entry = {
						at: Date.now(),
						body: "",
						done: false
					};
					keep(entry);
					this.addEventListener("progress", () => {
						try {
							entry.body = this.responseText ?? "";
						} catch {}
					});
					this.addEventListener("loadend", () => {
						entry.done = true;
					});
				}
				return originalSend.apply(this, args);
			};
		}).catch((error) => {
			console.warn("[deepseek-web] 实时思考流镜像注入失败（不影响最终回复）：", error instanceof Error ? error.message : error);
		});
	}
	/** 启动实时增量轮询；返回要清理的 timer（仅当 liveThinking 开启）。 */
	async startProgressPolling(page, request) {
		if (this.options.config.liveThinking !== true) return void 0;
		await this.ensureCapture(page);
		const startedAt = Date.now() - 1e3;
		const onProgress = request.onProgress;
		let emittedText = "";
		let emittedReasoning = "";
		return setInterval(() => {
			page.evaluate((since) => {
				const state = window.__dshWebCapture;
				if (!state) return void 0;
				const latest = state.entries.filter((entry) => entry.at >= since && entry.body.length > 0).at(-1);
				return latest === void 0 ? void 0 : {
					body: latest.body,
					done: latest.done
				};
			}, startedAt).then((captured) => {
				if (captured === void 0) return;
				const parsed = parseCompletionBody(captured.body);
				if (parsed.reliable !== true) return;
				if (parsed.text.length < emittedText.length) emittedText = parsed.text;
				const reasoning = parsed.reasoning ?? "";
				if (reasoning.length < emittedReasoning.length) emittedReasoning = reasoning;
				const textDelta = parsed.text.length > emittedText.length ? parsed.text.slice(emittedText.length) : "";
				const reasoningDelta = reasoning.length > emittedReasoning.length ? reasoning.slice(emittedReasoning.length) : "";
				emittedText = parsed.text;
				emittedReasoning = reasoning;
				if (textDelta === "" && reasoningDelta === "") return;
				if (POLLUTION_PATTERN.test(textDelta) || POLLUTION_PATTERN.test(reasoningDelta)) {
					console.warn("[deepseek-web] 实时增量里检测到原始流特征，已丢弃本批增量。");
					return;
				}
				if (textDelta.length > 8e3 || reasoningDelta.length > 8e3) {
					console.warn("[deepseek-web] 实时增量异常巨大，已丢弃本批增量。");
					return;
				}
				try {
					onProgress?.({
						text: textDelta,
						reasoning: reasoningDelta
					});
				} catch (error) {
					console.warn("[deepseek-web] 实时思考流回调异常（已忽略）：", error instanceof Error ? error.message : error);
				}
			}).catch(() => {});
		}, POLL_INTERVAL_MS);
	}
	/** 填入消息 / 首次请求：把网页窗口提到最前（受 config.focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.webWindow === false) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/** 回合（含审核）结束、正文交给 Harness：把 dsh 宿主窗口提到最前。 */
	async focusHarness() {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus?.dshProcessNames,
			titlePattern: focus?.dshTitlePattern
		}).catch(() => {});
	}
	autoSendSessions = /* @__PURE__ */ new Map();
	/** 记录会话的发送方式：全自动会话的后续轮次与自审轮次都自动发送。 */
	setSessionAutoSend(sessionId, auto) {
		this.autoSendSessions.set(sessionId, auto);
	}
	/** 置顶/取消置顶插件专用的 Edge 窗口（按 profile 目录定位）。 */
	async setWebWindowTopmost(_sessionId, topmost) {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.webWindow === false) return;
		await setBrowserWindowTopmost({
			profileDir: this.profileDir,
			topmost
		}).catch(() => {});
	}
	async status() {
		if (!this.browser || !this.page) return {
			ready: false,
			message: "浏览器尚未启动"
		};
		const modelLabel = WEB_MODEL_CAPABILITIES[this.options.config.model]?.label;
		return {
			ready: !this.page.isClosed(),
			url: this.page.url(),
			message: `浏览器已连接${modelLabel ? `，目标模型：${modelLabel}` : ""}`
		};
	}
	async dispose() {
		if (this.options.config.browser === "attach") return;
		const managed = this.managedConnection;
		this.managedConnection = void 0;
		await managed?.browser.close().catch(() => {});
		if (managed?.process && !managed.process.killed) managed.process.kill();
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
		this.conversationStarted = false;
		this.activeSessionId = void 0;
	}
};

//#endregion
//#region src/kimi-channel.ts
/** Kimi 对话接口（Connect-RPC，`application/connect+json`）。 */
function matchesKimiCompletion(url) {
	return /ChatService\/Chat/i.test(url);
}
/**
* 解析 Kimi Connect-RPC 流：5 字节帧头（1 字节 flags + 4 字节大端长度）+ JSON 载荷。
*
* 事件形态（实测样本）：
* - `{"op":"set","mask":"block.text","block":{"id","text":{"content"}}}` 建立正文块
* - `{"op":"append","mask":"block.text.content","block":{"id","text":{"content"}}}` 追加正文
* - `block.think` / `block.think.content` 同理，属于思考内容
* - `{"op":"set","mask":"message.status","message":{"status":"MESSAGE_STATUS_COMPLETED"}}` 结束
* - flags=2 的帧是 Connect 的 end-of-stream 哨兵
*/
function parseKimiCompletion(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "binary");
	const textBlocks = /* @__PURE__ */ new Map();
	const thinkBlocks = /* @__PURE__ */ new Map();
	const textOrder = [];
	const thinkOrder = [];
	const upsert = (store, order, id, content, append) => {
		if (!store.has(id)) order.push(id);
		store.set(id, append ? `${store.get(id) ?? ""}${content}` : content);
	};
	let offset = 0;
	while (offset + 5 <= buffer.length) {
		const flags = buffer[offset];
		const length = buffer.readUInt32BE(offset + 1);
		if (offset + 5 + length > buffer.length) break;
		let payload = buffer.subarray(offset + 5, offset + 5 + length);
		offset += 5 + length;
		if ((flags & 2) !== 0) break;
		if ((flags & 1) !== 0) try {
			payload = gunzipSync(payload);
		} catch {}
		let event;
		try {
			event = JSON.parse(payload.toString("utf8"));
		} catch {
			continue;
		}
		const append = event.op === "append";
		const mask = event.mask ?? "";
		const blockId = event.block?.id ?? mask;
		if (mask.startsWith("block.text")) {
			const content = event.block?.text?.content;
			if (typeof content === "string") upsert(textBlocks, textOrder, blockId, content, append);
		} else if (mask.startsWith("block.think")) {
			const content = event.block?.think?.content;
			if (typeof content === "string") upsert(thinkBlocks, thinkOrder, blockId, content, append);
		} else if (mask === "message" && event.message?.role === "assistant" && Array.isArray(event.message.blocks)) for (const raw of event.message.blocks) {
			const block = raw;
			const id = block.id ?? `${textOrder.length}`;
			if (typeof block.text?.content === "string") upsert(textBlocks, textOrder, id, block.text.content, false);
			if (typeof block.think?.content === "string") upsert(thinkBlocks, thinkOrder, id, block.think.content, false);
		}
	}
	const collect = (store, order) => order.map((id) => store.get(id) ?? "").join("").trim();
	const text = collect(textBlocks, textOrder);
	const reasoning = collect(thinkBlocks, thinkOrder);
	if (!text && !reasoning) {
		const dir = path.join(process.env.LOCALAPPDATA ?? "", "DshDeepSeekWeb", "calibration");
		const file = path.join(dir, `kimi-unparsed-${Date.now()}.bin`);
		import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer))).catch(() => {});
		throw new LlmError("kimi: Connect-RPC 流里没有解析出正文", "KIMI_EMPTY_RESPONSE");
	}
	return {
		text,
		...reasoning ? { reasoning } : {}
	};
}
var KimiBrowserChannel = class {
	browser;
	context;
	page;
	conversationStarted = false;
	titleState = {};
	options;
	profileDir;
	label;
	constructor(options) {
		this.options = options;
		this.profileDir = options.profileDir ?? options.config.profileDir ?? defaultProfileDir("kimi-profile");
		this.label = options.label ?? "kimi";
	}
	async ensureReady() {
		if (this.browser && this.page) return;
		const { browser, context } = await connectBrowser({
			port: this.options.config.debugPort,
			profileDir: this.profileDir,
			url: this.options.config.url,
			autoStartKeeper: true,
			label: this.label
		});
		this.browser = browser;
		this.context = context;
		const pages = context.pages();
		this.page = pages.find((item) => item.url().startsWith(new URL(this.options.config.url).origin)) ?? pages[0] ?? await context.newPage();
		await ensureChatPage(this.page, this.options.config.url);
		await this.page.waitForTimeout(1500);
		if (await looksLoginWall(this.page)) throw new LlmError("kimi: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。请先运行 node tools/open-login-kimi.mjs 完成一次登录。", "KIMI_LOGIN_REQUIRED");
	}
	resetConversationGate() {
		this.conversationStarted = false;
	}
	async turn(request) {
		if (!this.page) await this.ensureReady();
		const page = this.page;
		if (request.initialize && !this.conversationStarted) {
			await bestEffortNewChat(page);
			await page.waitForTimeout(800);
			this.conversationStarted = true;
		}
		const completionPromise = page.waitForResponse((response) => response.request().method() === "POST" && matchesKimiCompletion(response.url()), { timeout: this.options.config.streamIdleTimeoutMs }).then(async (response) => {
			await markPageTitle(page, "[dsh Kimi 审核生成中]", this.titleState);
			await response.finished().catch(() => {});
			return {
				url: response.url(),
				status: response.status(),
				body: await response.body().catch(() => Buffer.alloc(0))
			};
		});
		const editor = locateEditor(page);
		if (!await editor.isVisible().catch(() => false)) throw new LlmError("kimi: 未找到对话输入框。请确认浏览器停留在 Kimi 的对话页。", "KIMI_EDITOR_NOT_FOUND");
		await editor.click();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		await page.keyboard.press("Backspace");
		await page.keyboard.insertText(request.text);
		let sendBlocked = await looksSendBlocked(page);
		if (sendBlocked) {
			await page.waitForTimeout(600);
			sendBlocked = await looksSendBlocked(page);
		}
		if (sendBlocked) throw new LlmError("kimi: 发送按钮不可用，消息发不出去——通常是尚未登录 www.kimi.com。请先运行 node tools/open-login-kimi.mjs 登录；若已登录请确认页面没有正在生成的回复。", "KIMI_SEND_BLOCKED");
		await page.bringToFront();
		this.conversationStarted = true;
		await markPageTitle(page, "[dsh 等待你在 Kimi 点击发送]", this.titleState);
		console.info("[kimi] 消息已填入 Edge，请在 Kimi 页面点击“发送”…");
		let completion;
		try {
			completion = await completionPromise;
			console.info("[kimi] 已收到 Kimi 完整回复，正在解析…");
		} catch (error) {
			if (page.isClosed()) throw new LlmError("kimi: 浏览器页面被关闭", "KIMI_PAGE_CLOSED");
			throw new LlmError("kimi: 已把消息填入浏览器，等待你点击“发送”超时。请点击发送后重试。", "KIMI_MANUAL_SEND_TIMEOUT", { cause: error });
		} finally {
			await markPageTitle(page, void 0, this.titleState);
		}
		return parseKimiCompletion(completion.body);
	}
	/** 填入消息：把 Kimi 窗口提到最前（受注入的 focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.focus;
		if (focus && (focus.enabled === false || focus.webWindow === false)) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/**
	* 仅用于满足 BrowserChannel 接口的一致性占位：
	* 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发，
	* 本方法当前没有调用点，保留是为了让两条通道实现同一接口时不出现方法缺失。
	*/
	async focusHarness() {
		const focus = this.options.focus;
		if (!focus || focus.enabled === false || focus.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus.dshProcessNames,
			titlePattern: focus.dshTitlePattern
		}).catch(() => {});
	}
	async status() {
		if (!this.browser || !this.page) return {
			ready: false,
			message: "Kimi 浏览器尚未启动"
		};
		return {
			ready: !this.page.isClosed(),
			url: this.page.url(),
			message: "Kimi 审核通道已连接"
		};
	}
	async dispose() {
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
	}
};

//#endregion
//#region src/glm-channel.ts
/** GLM 对话接口（SSE，`text/event-stream`）。 */
function matchesGlmCompletion(url) {
	return /chat\/completions/i.test(url);
}
/**
* 解析 GLM SSE 流。
*
* 事件形态（2026-09 真实样本，`calibration/glm-chat-*.bin`）：
* - `{"phase":"thinking","delta_content":"…"}` 思考过程 —— **不是正文**，单独归到 reasoning
* - `{"phase":"answer","delta_content":"…"}` 增量正文
* - `{"phase":"other","usage":{…}}` 用量统计等非正文事件
* - `{"phase":"done","done":true}` 结束
* - `data: [DONE]` 流结束哨兵
*
* 注意：thinking 与 answer 用的是同一个 `delta_content` 字段，只有 `phase` 能区分。
* 早期版本把两者一律并入正文，导致思考过程混进交付文本（会污染审核输入与结论展示）。
*/
function parseGlmCompletion(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
	const raw = buffer.toString("utf8");
	let text = "";
	let reasoning = "";
	let sawAny = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		sawAny = true;
		if (event.type === "chat:completion") {
			const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
			const content = typeof event.data?.delta_content === "string" ? event.data.delta_content : "";
			const deltaReasoning = typeof event.data?.delta_reasoning === "string" ? event.data.delta_reasoning : "";
			if (deltaReasoning) reasoning += deltaReasoning;
			if (content) {
				if (phase === "thinking") reasoning += content;
				else if (phase === "answer" || phase === "") text += content;
			}
		}
	}
	if (!text && !reasoning && sawAny) return { text: "" };
	if (!text && !reasoning) {
		const dir = path.join(process.env.LOCALAPPDATA ?? "", "DshDeepSeekWeb", "calibration");
		const file = path.join(dir, `glm-unparsed-${Date.now()}.bin`);
		import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer))).catch(() => {});
		throw new LlmError("glm: SSE 流里没有解析出正文", "GLM_EMPTY_RESPONSE");
	}
	return {
		text,
		...reasoning ? { reasoning } : {}
	};
}
var GLMChannel = class {
	browser;
	context;
	page;
	conversationStarted = false;
	titleState = {};
	options;
	profileDir;
	label;
	constructor(options) {
		this.options = options;
		this.profileDir = options.profileDir ?? options.config.glmProfileDir ?? defaultProfileDir("glm-profile");
		this.label = options.label ?? "glm";
	}
	async ensureReady() {
		if (this.browser && this.page) return;
		const { browser, context } = await connectBrowser({
			port: this.options.config.glmDebugPort,
			profileDir: this.profileDir,
			url: this.options.config.glmUrl,
			autoStartKeeper: true,
			label: this.label
		});
		this.browser = browser;
		this.context = context;
		const pages = context.pages();
		this.page = pages.find((item) => item.url().startsWith(new URL(this.options.config.glmUrl).origin)) ?? pages[0] ?? await context.newPage();
		await ensureChatPage(this.page, this.options.config.glmUrl);
		await this.page.waitForTimeout(1500);
		if (await looksLoginWall(this.page)) throw new LlmError("glm: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。请先运行 node tools/open-login-glm.mjs 完成一次登录，再重试审核。", "GLM_LOGIN_REQUIRED");
	}
	resetConversationGate() {
		this.conversationStarted = false;
	}
	async turn(request) {
		if (!this.page) await this.ensureReady();
		const page = this.page;
		if (request.initialize && !this.conversationStarted) {
			await bestEffortNewChat(page);
			await page.waitForTimeout(800);
			this.conversationStarted = true;
		}
		const completionPromise = page.waitForResponse((response) => response.request().method() === "POST" && matchesGlmCompletion(response.url()), { timeout: this.options.config.streamIdleTimeoutMs }).then(async (response) => {
			await markPageTitle(page, "[dsh GLM 审核生成中]", this.titleState);
			await response.finished().catch(() => {});
			return {
				url: response.url(),
				status: response.status(),
				body: await response.body().catch(() => Buffer.alloc(0))
			};
		});
		const editor = locateEditor(page);
		if (!await editor.isVisible().catch(() => false)) throw new LlmError("glm: 未找到对话输入框。请确认浏览器停留在 chat.z.ai 的对话页。", "GLM_EDITOR_NOT_FOUND");
		await editor.click();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		await page.keyboard.press("Backspace");
		await page.keyboard.insertText(request.text);
		let sendBlocked = await looksSendBlocked(page);
		if (sendBlocked) {
			await page.waitForTimeout(600);
			sendBlocked = await looksSendBlocked(page);
		}
		if (sendBlocked) throw new LlmError("glm: 发送按钮不可用，消息发不出去——通常是尚未登录 chat.z.ai。请先运行 node tools/open-login-glm.mjs 登录；若已登录请确认页面没有正在生成的回复。", "GLM_SEND_BLOCKED");
		if (request.autoSend) {
			await markPageTitle(page, "[dsh 自动发送中]", this.titleState);
			await page.keyboard.press("Enter");
			console.info("[glm] 全自动：已输入并回车发送…");
		} else {
			await page.bringToFront();
			this.conversationStarted = true;
			await markPageTitle(page, "[dsh 等待你在 GLM 点击发送]", this.titleState);
			console.info("[glm] 消息已填入 Edge，请在 GLM 页面点击“发送”…");
		}
		let completion;
		try {
			completion = await completionPromise;
			console.info("[glm] 已收到 GLM 完整回复，正在解析…");
		} catch (error) {
			if (page.isClosed()) throw new LlmError("glm: 浏览器页面被关闭", "GLM_PAGE_CLOSED");
			throw new LlmError(request.autoSend ? "glm: 全自动发送后未收到网页响应。可能回车未触发发送（输入框为空或页面结构变化），请人工检查网页后重试。" : "glm: 已把消息填入浏览器，等待你点击“发送”超时。请点击发送后重试。", request.autoSend ? "GLM_AUTO_SEND_TIMEOUT" : "GLM_MANUAL_SEND_TIMEOUT", { cause: error });
		} finally {
			await markPageTitle(page, void 0, this.titleState);
		}
		return parseGlmCompletion(completion.body);
	}
	/** 填入消息：把 GLM 窗口提到最前（受注入的 focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.focus;
		if (focus && (focus.enabled === false || focus.webWindow === false)) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/**
	* 仅用于满足 BrowserChannel 接口的一致性占位：
	* 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发。
	*/
	async focusHarness() {
		const focus = this.options.focus;
		if (!focus || focus.enabled === false || focus.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus.dshProcessNames,
			titlePattern: focus.dshTitlePattern
		}).catch(() => {});
	}
	async status() {
		if (!this.browser || !this.page) return {
			ready: false,
			message: "GLM 浏览器尚未启动"
		};
		return {
			ready: !this.page.isClosed(),
			url: this.page.url(),
			message: "GLM 审核通道已连接"
		};
	}
	async dispose() {
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
	}
};

//#endregion
//#region src/reviewer.ts
const KIMI_REVIEW_SESSION = "kimi-review";
const GLM_REVIEW_SESSION = "glm-review";
const REVIEW_PROTOCOL = `你是独立的代码与交付质量审核员。请审核给定任务的目标与产出是否一致。

只输出一个 JSON 对象，格式：
{"ok": true 或 false, "issues": ["问题1", "问题2"], "suggestions": ["建议1"]}

审核要点：
1. 产出是否真正满足任务目标，是否有遗漏或跑题；
2. 代码/文件是否存在明显错误、路径错误、未完成占位；
3. 是否缺少必要的验证（测试、运行结果、边界处理）；
4. 不要吹毛求疵，只报会导致返工的问题；没有问题时 ok=true、issues=[]。

重要：如果证据里出现“审核证据被截断”字样，那是审核通道自身的截断，不代表产出文件不完整；
不要因为该截断判定文件被截断或未完成。`;
/** DeepSeek 同对话自审：不携带文件内容，直接要求它复查刚才的交付。 */
const SELF_REVIEW_PROTOCOL = `[自审] 请审查你刚才给出的交付结果，不要重新实现任务。

只输出一个 JSON 对象：{"ok": true 或 false, "issues": ["问题1"], "suggestions": ["建议1"]}

自审要点：
1. 是否真正满足上一条用户任务的目标，有没有遗漏或跑题；
2. 交付的代码/文件是否完整、可运行，有没有截断、占位、路径错误；
3. 是否做过必要验证（运行结果、语法检查、边界情况）；
4. 没有会导致返工的问题就输出 ok=true、issues=[]。`;
function clamp(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`;
}
function buildReviewPrompt(evidence, maxEvidenceChars) {
	const files = evidence.files && evidence.files.length > 0 ? `\n\n涉及文件：\n${evidence.files.map((file) => `- ${file}`).join("\n")}` : "";
	return [
		REVIEW_PROTOCOL,
		`[任务目标]\n${clamp(evidence.task, Math.floor(maxEvidenceChars / 3))}`,
		`[待审核产出]\n${clamp(evidence.artifact, maxEvidenceChars)}${files}`
	].join("\n\n");
}
function parseReviewVerdict(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start >= 0 && end > start) try {
		const parsed = JSON.parse(candidate.slice(start, end + 1));
		return {
			ok: parsed.ok === true,
			issues: Array.isArray(parsed.issues) ? parsed.issues.filter((v) => typeof v === "string") : [],
			suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((v) => typeof v === "string") : [],
			raw: text
		};
	} catch {}
	return {
		ok: false,
		issues: ["审核回复无法解析为 JSON"],
		suggestions: [],
		raw: text
	};
}
var KimiReviewer = class {
	/** Kimi 审核需要外部证据（任务 + 产出 + 文件内容）。 */
	needsEvidence = true;
	channel;
	config;
	constructor(channel, config) {
		this.channel = channel;
		this.config = config;
	}
	/** 提交一次审核；需要用户在 Kimi 页面人工点击发送。 */
	async review(evidence) {
		await this.channel.ensureReady();
		return parseReviewVerdict((await this.channel.turn({
			sessionId: KIMI_REVIEW_SESSION,
			model: "kimi-web",
			text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
			initialize: false
		})).text);
	}
};
var GlmReviewer = class {
	/** GLM 审核需要外部证据（任务 + 产出 + 文件内容）。 */
	needsEvidence = true;
	channel;
	config;
	constructor(channel, config) {
		this.channel = channel;
		this.config = config;
	}
	/** 提交一次审核；需要用户在 GLM 页面人工点击发送。 */
	async review(evidence) {
		await this.channel.ensureReady();
		return parseReviewVerdict((await this.channel.turn({
			sessionId: GLM_REVIEW_SESSION,
			model: "glm-web",
			text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
			initialize: false
		})).text);
	}
};
/**
* DeepSeek 同对话自审：复用正在工作的网页对话，只发一条自审指令。
* 不需要新窗口，也不需要重复粘贴文件内容——上下文里已经有产出。
*/
var DeepSeekSelfReviewer = class {
	/** 自审不需要构造外部证据。 */
	needsEvidence = false;
	channel;
	constructor(channel) {
		this.channel = channel;
	}
	async review(evidence) {
		const goal = evidence.task.trim().slice(0, 300);
		const text = goal ? `${SELF_REVIEW_PROTOCOL}\n\n[任务目标（供对照）]\n${goal}` : SELF_REVIEW_PROTOCOL;
		return parseReviewVerdict((await this.channel.turn({
			sessionId: "deepseek-self-review",
			preserveConversation: true,
			model: "deepseek-web",
			text,
			initialize: false
		})).text);
	}
};

//#endregion
//#region src/index.ts
const name = "llm-deepseek-web";
const inject = ["llm"];
/**
* 装配免费网页版主通道与可选审核通道。
*
* @param ctx - 插件上下文；`llm` 由 `inject` 保证就绪。
* @param config - Loader 传入的配置；标 `.volatile()` 的字段此时是引用对象。
*/
function apply(ctx, config) {
	const live = liveConfig(config);
	const channel = new PlaywrightBrowserChannel({ config: live });
	const kimiChannel = new KimiBrowserChannel({
		config: live.review,
		focus: live.focus
	});
	const glmChannel = new GLMChannel({
		config: live.review,
		focus: live.focus
	});
	const kimiReviewer = new KimiReviewer(kimiChannel, live.review);
	const glmReviewer = new GlmReviewer(glmChannel, live.review);
	const selfReviewer = new DeepSeekSelfReviewer(channel);
	const adapter = new DeepSeekWebAdapter(live, channel, {
		get needsEvidence() {
			return live.review.provider !== "deepseek-web";
		},
		review: (evidence) => {
			switch (live.review.provider) {
				case "kimi": return kimiReviewer.review(evidence);
				case "glm": return glmReviewer.review(evidence);
				default: return selfReviewer.review(evidence);
			}
		}
	}, (totals) => {
		console.info(`[llm-deepseek-web] 通道 token 累计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`);
	});
	ctx.effect(() => {
		const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
		return () => {
			unregister();
			channel.dispose().catch(() => {});
			kimiChannel.dispose().catch(() => {});
			glmChannel.dispose().catch(() => {});
		};
	}, "llm-deepseek-web");
	ctx.logger.info(`[llm-deepseek-web] provider "${PROVIDER}" registered (browser=${live.browser}, sendMode=${live.sendMode}, review=${live.review.enabled ? live.review.provider : "off"})`);
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.js.map