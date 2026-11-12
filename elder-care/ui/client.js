// 照护界面插件的浏览器半侧。
// 外面是 dsh 原样的聊天窗口；只有当前会话的智能体是"照护主智能体"（care-lead）时，界面才变成照护模式：
//   - 首屏：照护助手的标题、照护对象、快捷问题；
//   - 对话：每轮末尾把 present_care_answer 的结构化答复渲染成答复卡片（急症时是红色横幅 + 拨打 120）；
//   - 右侧栏：照护对象、本次答复依据、用到的档案记录、待确认的新情况、参与核查的子智能体；
//   - 老人档案页：盖在对话区上的整页档案。
// 不经过构建工具，按 dsh 客户端模块的格式手写（window.__ModuleLoader__.load）。改完保存会热重载，没生效就刷新。
//
// 数据从哪来：
//   - 当前智能体：会话摘要 projectionValues.agentPreset（useSessions）；
//   - 答复内容：对话数据里 present_care_answer 这次工具调用的参数（useChat）；
//   - 老人档案：宿主半侧 src/ui-host.ts 生成的数据分块 client.patients.js。
window.__ModuleLoader__.load({
	id: "dsh-elder-care",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;
		const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

		const PRESET = "care-lead"; // 进入照护模式的智能体
		const DEFAULT_PRESET = "standard"; // "返回普通对话"时切回的智能体（dsh 的默认）
		const ANSWER_TOOL = "present_care_answer";
		const SUBAGENT_TOOL = "subagent";
		const SUBAGENTS = [
			{ id: "care-med", label: "用药核查" },
			{ id: "care-plan", label: "照护计划" },
			{ id: "care-knowledge", label: "知识检索" }
		];
		const QUICK_QUESTIONS = [
			{ label: "这个药能不能吃", text: "他想吃（药名），和现在吃的药有没有冲突？" },
			{ label: "他有点不舒服", text: "他今天（症状），需要注意什么？" },
			{ label: "饮食和运动", text: "根据他的情况，平时饮食和运动要注意什么？" },
			{ label: "看看他的档案", text: "帮我看一下档案里记录了哪些疾病和在用的药。" }
		];
		const SIDE_WIDTH = 320; // 右侧栏宽度
		const WIDE_MIN = 980; // 对话区不小于这个宽度才显示右侧栏，否则依据并进答复卡片

		// ── 插件内共享状态：当前页面（对话/档案）和老人档案数据 ─────────────────────
		let snapshot = { page: "chat", patients: {} };
		const subscribers = new Set();
		const setCare = (patch) => {
			snapshot = { ...snapshot, ...patch };
			for (const fn of subscribers) fn();
		};
		const subscribeCare = (fn) => {
			subscribers.add(fn);
			return () => subscribers.delete(fn);
		};
		const useCare = () => useSyncExternalStore(subscribeCare, () => snapshot);

		// ── 从 dsh 的对话数据里取照护需要的内容 ─────────────────────────────────
		// 选择器只返回字符串：dsh 的 useChat 用返回值是否变化来决定要不要重绘。
		const chatNodes = (s) => {
			const byKey = s?.nodes?.byKey;
			if (!byKey) return [];
			return byKey instanceof Map ? [...byKey.values()] : Object.values(byKey);
		};
		const toolCall = (node) => {
			const root = node.data?.root;
			if (!root) return null;
			return {
				name: root.call?.name ?? root.name,
				raw: root.call?.argsRaw ?? root.argsRaw ?? "",
				turn: node.location?.turn?.turn,
				seq: node.anchorSeq ?? 0
			};
		};
		/** 某一轮（不传则整段对话）里最后一次 present_care_answer 的参数原文。 */
		function answerRaw(s, turnNo) {
			let best = null;
			for (const node of chatNodes(s)) {
				if (node.kind !== "tool-call") continue;
				const call = toolCall(node);
				if (call === null || call.name !== ANSWER_TOOL) continue;
				if (turnNo !== undefined && call.turn !== turnNo) continue;
				if (best === null || call.seq >= best.seq) best = call;
			}
			return best === null ? "" : best.raw;
		}
		/** 最后一条用户消息之后委派过的子智能体编号，逗号分隔。 */
		function participantsKey(s) {
			const nodes = chatNodes(s);
			let lastUser = -1;
			for (const node of nodes) if (node.kind === "user") lastUser = Math.max(lastUser, node.anchorSeq ?? 0);
			const used = new Set();
			for (const node of nodes) {
				if (node.kind !== "tool-call" || (node.anchorSeq ?? 0) < lastUser) continue;
				const call = toolCall(node);
				if (call === null || call.name !== SUBAGENT_TOOL) continue;
				try {
					const preset = JSON.parse(call.raw).agent_preset;
					if (typeof preset === "string") used.add(preset);
				} catch {
					// 参数还在流式生成，下次更新再看。
				}
			}
			return [...used].sort().join(",");
		}
		const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
		/** 把工具参数整理成界面用的答复；参数没生成完或不合法时返回 null。 */
		function parseAnswer(raw) {
			if (raw === "") return null;
			let a;
			try {
				a = JSON.parse(raw);
			} catch {
				return null;
			}
			if (a === null || typeof a !== "object" || typeof a.headline !== "string") return null;
			const objects = (value) => Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
			return {
				level: a.level === "emergency" || a.level === "caution" ? a.level : "info",
				headline: a.headline,
				summary: typeof a.summary === "string" ? a.summary : "",
				reasons: objects(a.reasons).filter((r) => typeof r.text === "string").map((r) => ({
					text: r.text,
					evidence: Array.isArray(r.evidence) ? r.evidence.filter((n) => Number.isInteger(n)) : []
				})),
				evidence: objects(a.evidence).filter((e) => typeof e.title === "string"),
				profileFacts: strings(a.profile_facts),
				actions: strings(a.actions),
				warnings: strings(a.warnings),
				needsDoctor: strings(a.needs_doctor),
				noEvidence: strings(a.no_evidence),
				newFacts: objects(a.new_facts).filter((f) => typeof f.content === "string"),
				followUp: a.follow_up !== null && typeof a.follow_up === "object" && typeof a.follow_up.question === "string"
					? { question: a.follow_up.question, options: strings(a.follow_up.options) }
					: null,
				safetyRule: typeof a.safety_rule === "string" ? a.safety_rule : ""
			};
		}
		const presetOf = (useSessions, sessionId) => useSessions((s) => s.byId[sessionId]?.projectionValues?.agentPreset);

		// ── 小部件 ─────────────────────────────────────────────────────────────
		const ICONS = {
			heart: ["M12 21s-8-5.2-8-11.2A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8 3.2C20 15.8 12 21 12 21z"],
			alert: ["M12 3l10 18H2z", "M12 10v5", "M12 18v.5"],
			check: ["M5 12l5 5 9-10"],
			phone: ["M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2z"],
			back: ["M15 5l-7 7 7 7"],
			arrow: ["M9 5l7 7-7 7"],
			chat: ["M4 5h16v11H8l-4 4z"],
			user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"]
		};
		function Icon({ name, size = 18 }) {
			return h("svg", {
				width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
				strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", className: "care-icon"
			}, ICONS[name].map((d, i) => h("path", { key: i, d })));
		}
		/** 心形 + 十字的标志。 */
		function CareMark({ size = 24 }) {
			return h("svg", { width: size, height: size, viewBox: "0 0 24 24", role: "img", "aria-label": "养老照护助手", className: "care-mark" },
				h("path", { d: ICONS.heart[0], style: { fill: "var(--care-accent)" } }),
				h("path", { d: "M12 9.2v5.6M9.2 12h5.6", style: { stroke: "var(--care-on-accent)" }, strokeWidth: 1.8, strokeLinecap: "round", fill: "none" }));
		}
		const Chip = ({ tone = "tint", children }) => h("span", { className: `care-chip care-chip-${tone}` }, children);
		const factsOfType = (patient, type) => (patient?.facts ?? []).filter((fact) => fact.type === type);
		const shortName = (patient) => (patient?.displayName ?? "").split(/[（(]/)[0].trim() || patient?.id || "";
		const patientMeta = (patient) => [typeof patient?.age === "number" ? `${patient.age} 岁` : "", patient?.sex ?? ""].filter(Boolean).join(" · ");
		/** 档案里药物记录的第一段是药名，例如"华法林，长期服用……"取"华法林"。 */
		const drugName = (fact) => fact.content.split(/[，,。；;]/)[0].trim();

		// ── 答复卡片（每轮末尾）───────────────────────────────────────────────
		function AnswerCard({ answer, onAsk }) {
			const a = answer;
			const [asked, setAsked] = useState(false);
			const refs = (numbers) => numbers.filter((n) => n >= 1 && n <= a.evidence.length)
				.map((n) => h("span", { key: n, className: "care-ref" }, `依据 ${n}`));
			const list = (items) => h("ul", { className: "care-list" }, items.map((text, i) => h("li", { key: i }, text)));
			const actionsTitle = a.level === "emergency" ? "去医院时" : "可以这样做";
			return h("article", { className: `care-card care-level-${a.level}` },
				h("header", { className: "care-verdict" },
					h(Icon, { name: a.level === "info" ? "check" : "alert", size: a.level === "emergency" ? 28 : 22 }),
					h("div", { className: "care-verdict-text" },
						h("div", { className: "care-headline" }, a.headline),
						a.summary === "" ? null : h("div", { className: "care-summary" }, a.summary)),
					a.level === "emergency"
						? h("a", { className: "care-call", href: "tel:120" }, h(Icon, { name: "phone", size: 20 }), "拨打 120")
						: null),
				h("div", { className: "care-card-body" },
					a.reasons.length === 0 ? null : h("section", null,
						h("h3", { className: "care-h" }, "为什么"),
						h("ul", { className: "care-list" }, a.reasons.map((reason, i) => h("li", { key: i }, reason.text, refs(reason.evidence))))),
					a.actions.length === 0 ? null : h("section", null, h("h3", { className: "care-h" }, actionsTitle), list(a.actions)),
					a.warnings.length === 0 ? null : h("section", { className: "care-box care-box-danger" },
						a.warnings.map((text, i) => h("div", { key: i, className: "care-box-line" }, text))),
					a.needsDoctor.length === 0 ? null : h("section", { className: "care-box" },
						h("h3", { className: "care-h" }, "需要医生或药师决定"), list(a.needsDoctor)),
					a.noEvidence.length === 0 ? null : h("section", { className: "care-muted" },
						h("div", null, "目前没有找到依据："), list(a.noEvidence)),
					// 窄屏没有右侧栏时，依据直接列在卡片里（由样式控制显示）。
					a.evidence.length === 0 ? null : h("section", { className: "care-inline-evidence" },
						h("h3", { className: "care-h" }, "本次答复依据"),
						a.evidence.map((item, i) => h(EvidenceItem, { key: i, index: i + 1, item }))),
					a.followUp === null ? null : h("section", { className: "care-follow" },
						h("div", { className: "care-follow-q" }, a.followUp.question),
						a.followUp.options.length === 0 ? null : h("div", { className: "care-options" },
							a.followUp.options.map((option) => h("button", {
								key: option, type: "button", className: "care-option", disabled: asked,
								onClick: () => {
									setAsked(true);
									onAsk(option);
								}
							}, option))))));
		}
		function EvidenceItem({ index, item }) {
			return h("div", { className: "care-evidence" },
				h("div", { className: "care-evidence-head" }, h("span", { className: "care-ref" }, `依据 ${index}`), h("span", { className: "care-evidence-title" }, item.title)),
				h("div", { className: "care-meta" }, [item.source, item.version].filter((v) => typeof v === "string" && v !== "").join(" · ")),
				typeof item.quote === "string" && item.quote !== "" ? h("div", { className: "care-quote" }, `“${item.quote}”`) : null);
		}
		/** 每轮末尾的插槽组件：这一轮有 present_care_answer 就渲染答复卡片。 */
		function CareTurnTail({ turn, sessionId, useSessions, useChat, ask }) {
			const preset = presetOf(useSessions, sessionId);
			const raw = useChat((s) => answerRaw(s, turn?.turn));
			const answer = useMemo(() => parseAnswer(raw), [raw]);
			if (preset !== PRESET || answer === null) return null;
			return h(AnswerCard, { answer, onAsk: ask });
		}
		/** 工作步骤列表里，这次工具调用只显示一行说明（内容已经在答复卡片里）。 */
		function AnswerToolRow({ block }) {
			// dsh 的工具调用数据：有 kind 字段表示已经有结果，否则参数还在生成中。
			const done = block !== undefined && block !== null && "kind" in block;
			return h("div", { className: "care-tool-row" },
				done ? h(Icon, { name: "check", size: 14 }) : null, done ? "已整理成答复卡片" : "正在整理答复……");
		}

		// ── 右侧栏 ─────────────────────────────────────────────────────────────
		function FactRow({ fact }) {
			return h("div", { className: "care-fact" },
				h(Chip, { tone: fact.status === "已确认" ? "tint" : "warn" }, fact.status),
				h("div", { className: "care-fact-text" },
					h("div", null, fact.content),
					h("div", { className: "care-meta" }, `来源：${fact.source} · ${fact.recordedAt}`)));
		}
		function PatientCard({ patient, onOpen }) {
			const drugs = factsOfType(patient, "用药").map(drugName);
			return h("section", { className: "care-panel" },
				h("div", { className: "care-patient" },
					h("span", { className: "care-avatar" }, shortName(patient).slice(-1)),
					h("div", null,
						h("div", { className: "care-patient-name" }, shortName(patient)),
						h("div", { className: "care-meta" }, patientMeta(patient)))),
				drugs.length === 0 ? null : h("div", { className: "care-meta" }, `在用药物：${drugs.join("、")}`),
				h("button", { type: "button", className: "care-link", onClick: onOpen }, "查看完整档案", h(Icon, { name: "arrow", size: 14 })));
		}
		function CareSide({ patient, answer, participants, onOpenProfile }) {
			const facts = answer === null ? [] : answer.profileFacts
				.map((id) => (patient?.facts ?? []).find((fact) => fact.id === id)).filter(Boolean);
			const monitor = factsOfType(patient, "监测");
			return h("aside", { className: "care-side", "aria-label": "照护信息" },
				patient === undefined
					? h("section", { className: "care-panel care-muted" }, "正在读取老人档案……")
					: h(PatientCard, { patient, onOpen: onOpenProfile }),
				answer !== null && answer.level === "emergency" && answer.safetyRule !== "" ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "触发的安全规则"),
					h("div", { className: "care-box care-box-danger care-rule" }, h(Icon, { name: "alert", size: 18 }),
						h("div", null, h("div", { className: "care-rule-name" }, answer.safetyRule), h("div", null, "先提示就医，再继续其他核查")))) : null,
				answer !== null && answer.evidence.length > 0 ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "本次答复依据"),
					answer.evidence.map((item, i) => h(EvidenceItem, { key: i, index: i + 1, item }))) : null,
				facts.length > 0 ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "用到的档案记录"),
					facts.map((fact) => h(FactRow, { key: fact.id, fact }))) : null,
				answer !== null && answer.newFacts.length > 0 ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "本次提到的新情况"),
					h("div", { className: "care-meta" }, "还没有写入档案，助手只把它们当作参考"),
					answer.newFacts.map((fact, i) => h("div", { key: i, className: "care-fact" },
						h(Chip, { tone: "warn" }, "待确认"),
						h("div", { className: "care-fact-text" }, h("div", null, fact.content), h("div", { className: "care-meta" }, fact.type ?? ""))))) : null,
				answer === null && monitor.length > 0 ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "最近监测"),
					monitor.map((fact) => h(FactRow, { key: fact.id, fact }))) : null,
				participants.length > 0 ? h("section", { className: "care-panel" },
					h("h2", { className: "care-panel-title" }, "参与核查"),
					SUBAGENTS.map((agent) => h("div", { key: agent.id, className: "care-row" },
						h("span", null, agent.label),
						participants.includes(agent.id) ? h("span", { className: "care-accent-text" }, "已参与") : h("span", { className: "care-meta" }, "未调用")))) : null);
		}

		// ── 左侧栏里的照护对象和导航（插在 dsh 侧边栏的标志行下面）─────────────────
		function CareNav({ patient, page, pending, onPage }) {
			const item = (id, icon, label, extra) => h("button", {
				type: "button", className: `care-nav-item${page === id ? " care-nav-on" : ""}`,
				"aria-current": page === id ? "page" : undefined, onClick: () => onPage(id)
			}, h(Icon, { name: icon, size: 18 }), h("span", null, label), extra);
			return h("nav", { className: "care-nav", "aria-label": "照护导航" },
				h("div", { className: "care-nav-label" }, "照护对象"),
				patient === undefined ? null : h("div", { className: "care-nav-patient" },
					h("span", { className: "care-avatar" }, shortName(patient).slice(-1)),
					h("div", null,
						h("div", { className: "care-patient-name" }, shortName(patient)),
						h("div", { className: "care-meta" }, patientMeta(patient)))),
				item("chat", "chat", "咨询对话", null),
				item("profile", "user", "老人档案", pending > 0 ? h(Chip, { tone: "warn" }, `${pending} 条待确认`) : null));
		}

		// ── 老人档案页（盖在对话区上）───────────────────────────────────────────
		function ProfilePage({ patient, answer, background, onClose }) {
			const [type, setType] = useState("全部");
			const facts = patient?.facts ?? [];
			const types = ["全部", ...new Set(facts.map((fact) => fact.type))];
			const shown = type === "全部" ? facts : facts.filter((fact) => fact.type === type);
			const pending = answer?.newFacts ?? [];
			const validity = (fact) => fact.validTo ? `${fact.validFrom ?? ""} 至 ${fact.validTo}` : fact.validFrom ? `${fact.validFrom} 起，有效` : "—";
			return h("div", { className: "care-profile", style: { background }, role: "region", "aria-label": "老人档案" },
				h("header", { className: "care-profile-head" },
					h("button", { type: "button", className: "care-btn", onClick: onClose }, h(Icon, { name: "back", size: 16 }), "返回对话"),
					h("span", { className: "care-avatar care-avatar-lg" }, shortName(patient).slice(-1)),
					h("div", null,
						h("h1", { className: "care-profile-title" }, `${shortName(patient)} 的档案`),
						h("div", { className: "care-meta" }, [patientMeta(patient), (patient?.displayName ?? "").replace(shortName(patient), "").replace(/^[（(]|[)）]$/g, "")].filter(Boolean).join(" · ")))),
				h("div", { className: "care-profile-body" },
					h("div", { className: "care-profile-main" },
						pending.length === 0 ? null : h("section", { className: "care-pending" },
							h("h2", { className: "care-panel-title" }, `待确认的新情况（${pending.length}）`),
							h("div", { className: "care-pending-note" }, "来自当前对话。确认写入档案的功能还没有实现，目前助手只把它们当作参考，不当作事实。"),
							pending.map((fact, i) => h("div", { key: i, className: "care-pending-item" },
								h("div", null, fact.content), h("div", { className: "care-meta" }, fact.type ?? "")))),
						h("div", { className: "care-tabs", role: "tablist", "aria-label": "记录分类" },
							types.map((name) => h("button", {
								key: name, type: "button", role: "tab", "aria-selected": name === type,
								className: `care-tab${name === type ? " care-tab-on" : ""}`, onClick: () => setType(name)
							}, `${name} ${name === "全部" ? facts.length : facts.filter((fact) => fact.type === name).length}`))),
						h("div", { className: "care-table-wrap" },
							h("table", { className: "care-table" },
								h("thead", null, h("tr", null, ["类别", "内容", "状态", "来源", "记录时间", "有效期"].map((name) => h("th", { key: name }, name)))),
								h("tbody", null, shown.map((fact) => h("tr", { key: fact.id },
									h("td", null, fact.type),
									h("td", { className: "care-strong" }, fact.content),
									h("td", null, h(Chip, { tone: fact.status === "已确认" ? "tint" : "warn" }, fact.status)),
									h("td", { className: "care-meta" }, fact.source),
									h("td", { className: "care-meta" }, fact.recordedAt),
									h("td", { className: "care-meta" }, validity(fact)))))))),
					h("div", { className: "care-profile-side" },
						h("section", { className: "care-panel" },
							h("h2", { className: "care-panel-title" }, "在用药物"),
							factsOfType(patient, "用药").map((fact) => h("div", { key: fact.id, className: "care-drug" },
								h("div", { className: "care-drug-name" }, drugName(fact)),
								h("div", { className: "care-meta" }, fact.content.slice(drugName(fact).length).replace(/^[，,]\s*/, ""))))),
						factsOfType(patient, "监测").length === 0 ? null : h("section", { className: "care-panel" },
							h("h2", { className: "care-panel-title" }, "最近监测"),
							factsOfType(patient, "监测").map((fact) => h(FactRow, { key: fact.id, fact }))),
						factsOfType(patient, "过敏").length === 0 ? null : h("section", { className: "care-panel" },
							h("h2", { className: "care-panel-title" }, "过敏"),
							factsOfType(patient, "过敏").map((fact) => h(FactRow, { key: fact.id, fact }))))));
		}

		// ── 输入框上方的插槽组件：照护模式的总开关 ─────────────────────────────────
		/** 向上找到第一个有实色背景的元素，给盖在对话区上的档案页用。 */
		function solidBackground(element) {
			for (let el = element; el !== null; el = el.parentElement) {
				const color = getComputedStyle(el).backgroundColor;
				if (color !== "" && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
			}
			return "Canvas";
		}
		function CareDock({ sessionId, useSessions, useSession, useChat, fill, enter, leave }) {
			const preset = presetOf(useSessions, sessionId);
			const blank = useSession((s) => s.blank === true && !s.running && !s.promptAttempted);
			const care = useCare();
			const anchor = useRef(null);
			const [host, setHost] = useState(null); // 对话区根元素：右侧栏和档案页挂在这里
			const [navHost, setNavHost] = useState(null); // 插在 dsh 左侧栏里的容器：照护对象和导航挂在这里
			const [layout, setLayout] = useState({ top: 0, wide: false, background: "Canvas" });
			const isCare = preset === PRESET;
			const raw = useChat((s) => isCare ? answerRaw(s, undefined) : "");
			const used = useChat((s) => isCare ? participantsKey(s) : "");
			const answer = useMemo(() => parseAnswer(raw), [raw]);
			const participants = useMemo(() => used === "" ? [] : used.split(","), [used]);
			const patient = Object.values(care.patients)[0];

			// 进入/离开照护模式：在 <body> 上打标记，样式只在有标记时生效。
			useEffect(() => {
				if (!isCare) return undefined;
				document.body.dataset.care = sessionId;
				return () => {
					if (document.body.dataset.care === sessionId) {
						delete document.body.dataset.care;
						delete document.body.dataset.careWide;
						document.body.style.removeProperty("--care-col");
					}
					setCare({ page: "chat" });
				};
			}, [isCare, sessionId]);

			// 找到对话区根元素，量出页头高度和可用宽度。类名带哈希前缀，所以按后缀匹配。
			useLayoutEffect(() => {
				if (!isCare) return undefined;
				const scroller = anchor.current?.closest('[class*="_scrollBody"]') ?? null;
				const root = scroller?.parentElement ?? null;
				setHost(root);
				if (root === null || scroller === null) return undefined;
				const measure = () => {
					const wide = root.clientWidth >= WIDE_MIN;
					if (wide) document.body.dataset.careWide = "1";
					else delete document.body.dataset.careWide;
					// 输入框有最大宽度并且居中；记下它的实际宽度，让快捷问题、安全提示和它左右对齐。
					const inputCard = root.querySelector('[class*="_composerStack"] [class*="_card"]');
					if (inputCard !== null && inputCard.offsetWidth > 0) document.body.style.setProperty("--care-col", `${inputCard.offsetWidth}px`);
					// 首屏没有页头，右上角是 dsh 自己的侧栏开关，至少留出 48px。
					setLayout({ top: Math.max(scroller.offsetTop, 48), wide, background: solidBackground(root) });
				};
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(root);
				return () => observer.disconnect();
			}, [isCare]);

			// 在 dsh 左侧栏的标志行下面插一个容器，放照护对象和导航；离开照护模式时移除。
			useLayoutEffect(() => {
				if (!isCare) return undefined;
				const logoRow = document.querySelector('[class*="_sidebarCol"] [class*="_logoRow"]');
				if (logoRow === null) return undefined;
				const element = document.createElement("div");
				element.className = "care-nav-host";
				logoRow.insertAdjacentElement("afterend", element);
				setNavHost(element);
				return () => {
					setNavHost(null);
					element.remove();
				};
			}, [isCare]);

			if (!isCare) {
				// 普通会话：只在还没开始的新会话里放一个入口，其余完全不动。
				if (!blank || preset === undefined) return null;
				return h("div", { className: "care-entry" },
					h("button", { type: "button", className: "care-entry-btn", onClick: enter },
						h(CareMark, { size: 18 }), "养老照护助手", h("span", { className: "care-entry-hint" }, "查用药、看档案、问照护")));
			}
			const openProfile = () => setCare({ page: "profile" });
			return h("div", { className: "care-dock", ref: anchor },
				blank ? h("div", { className: "care-hero" },
					h("div", { className: "care-hero-title" }, h(CareMark, { size: 34 }), h("span", null, "养老照护助手")),
					h("div", { className: "care-hero-sub" }, "今天想了解老人的什么情况？"),
					h("div", { className: "care-hero-row" },
						patient === undefined ? null : h("button", { type: "button", className: "care-patient-chip", onClick: openProfile },
							h("span", { className: "care-avatar care-avatar-sm" }, shortName(patient).slice(-1)),
							`${shortName(patient)} · ${patientMeta(patient)}`, h("span", { className: "care-meta" }, "查看档案")),
						h("button", { type: "button", className: "care-link", onClick: leave }, "返回普通对话"))) : null,
				blank ? h("div", { className: "care-quick" },
					QUICK_QUESTIONS.map((q) => h("button", { key: q.label, type: "button", className: "care-quick-btn", onClick: () => fill(q.text) }, q.label))) : null,
				!blank && !layout.wide && patient !== undefined ? h("div", null,
					h("button", { type: "button", className: "care-patient-chip", onClick: openProfile },
						h("span", { className: "care-avatar care-avatar-sm" }, shortName(patient).slice(-1)),
						`${shortName(patient)} · ${patientMeta(patient)}`, h("span", { className: "care-meta" }, "查看档案"))) : null,
				// 对话内容会从输入区下面滚过去，所以这一行要有和页面一样的底色，否则文字会叠在一起。
				h("div", { className: "care-safety", style: { background: layout.background } }, "助手提供的是参考信息，不能代替医生诊断。出现急症请立即拨打 120。"),
				navHost !== null ? ReactDOM.createPortal(
					h(CareNav, { patient, page: care.page, pending: answer?.newFacts.length ?? 0, onPage: (page) => setCare({ page }) }), navHost) : null,
				host !== null && layout.wide && care.page === "chat" ? ReactDOM.createPortal(
					h("div", { className: "care-side-wrap", style: { top: layout.top, width: SIDE_WIDTH } },
						h(CareSide, { patient, answer, participants, onOpenProfile: openProfile })), host) : null,
				host !== null && care.page === "profile" ? ReactDOM.createPortal(
					h(ProfilePage, { patient, answer, background: layout.background, onClose: () => setCare({ page: "chat" }) }), host) : null);
		}

		// ── 样式：除入口按钮外，全部只在 body[data-care] 下生效 ─────────────────────
		const CSS = `
body{--care-accent:#1B5B78;--care-on-accent:#FFFFFF;--care-tint:#E4EEF3;--care-tint-text:#1B5B78;--care-surface:#FFFFFF;--care-border:#DDE3E8;--care-warn-bg:#FCEFD9;--care-warn-text:#6B3A06;--care-warn-border:#F1DDB8;--care-danger:#A8231A;--care-danger-bg:#FBE9E7;--care-danger-text:#7E1A13;--care-text:var(--dsw-alias-label-primary,#16202A);--care-muted:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,#4E5B67))}
body[data-ds-dark-theme]{--care-accent:#8CCBE3;--care-on-accent:#0E2A36;--care-tint:#173A4A;--care-tint-text:#BFE3F1;--care-surface:#1F2428;--care-border:#3A4248;--care-warn-bg:#4A3410;--care-warn-text:#F5D9A8;--care-warn-border:#6B4E1C;--care-danger:#C0392F;--care-danger-bg:#4A1D19;--care-danger-text:#F6C9C4}
.care-mark{flex:none;display:block}
.care-entry{display:flex;padding:0 12px 8px}
.care-entry-btn{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border:1px solid var(--care-border);border-radius:999px;background:var(--care-surface);color:var(--care-text);font:inherit;font-size:14px;cursor:pointer}
.care-entry-btn:hover{border-color:var(--care-accent)}
.care-entry-hint{color:var(--care-muted);font-size:13px}
body[data-care]:not([data-ds-dark-theme]){--dsw-alias-button-info-fill:var(--care-accent)}
body[data-care] [class*="_composerHero"]>[class*="_root"]:first-child{display:none}
body[data-care] [class*="_composerStack"] [class*="_placeholder"]{font-size:0}
body[data-care] [class*="_composerStack"] [class*="_placeholder"]::before{content:"说说老人的情况，或直接提问。例如：我爸膝盖疼，能吃布洛芬吗？";font-size:14px}
body[data-care-wide] [class*="_mainPanel"] [class*="_scrollBody"]{padding-right:${SIDE_WIDTH}px;box-sizing:border-box}
.care-dock{display:contents;color:var(--care-text)}
.care-dock>*{width:min(var(--care-col,712px),calc(100% - 32px));align-self:center;margin:0 0 8px;box-sizing:border-box}
body[data-care] [class*="_sidebarCol"] [class*="_brandMark"]>*,body[data-care] [class*="_sidebarCol"] [class*="_brandName"]>*{display:none!important}
body[data-care] [class*="_sidebarCol"] [class*="_brandMark"]{width:24px;height:24px;background:center/contain no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21s-8-5.2-8-11.2A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8 3.2C20 15.8 12 21 12 21z' fill='%231B5B78'/%3E%3Cpath d='M12 9.2v5.6M9.2 12h5.6' stroke='%23FFFFFF' stroke-width='1.8' stroke-linecap='round' fill='none'/%3E%3C/svg%3E")}
body[data-care][data-ds-dark-theme] [class*="_sidebarCol"] [class*="_brandMark"]{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21s-8-5.2-8-11.2A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8 3.2C20 15.8 12 21 12 21z' fill='%238CCBE3'/%3E%3Cpath d='M12 9.2v5.6M9.2 12h5.6' stroke='%230E2A36' stroke-width='1.8' stroke-linecap='round' fill='none'/%3E%3C/svg%3E")}
body[data-care] [class*="_sidebarCol"] [class*="_brandName"]::after{content:"养老照护助手";font-size:17px;font-weight:700;line-height:24px;color:var(--care-text);white-space:nowrap}
.care-nav-host{display:none}
[class*="_logoRow"]:has([class*="_wide"])+.care-nav-host{display:block}
.care-nav{display:flex;flex-direction:column;gap:4px;padding:4px 8px 12px;color:var(--care-text);font-size:14px}
.care-nav-label{padding:0 8px;font-size:12px;color:var(--care-muted)}
.care-nav-patient{display:flex;align-items:center;gap:10px;margin-bottom:6px;padding:8px 10px;border:1.5px solid var(--care-accent);border-radius:12px;background:var(--care-tint)}
.care-nav-item{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 10px;border:none;border-radius:10px;background:none;color:var(--care-text);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.care-nav-item:hover{background:var(--care-tint)}
.care-nav-item .care-chip{margin-left:auto}
.care-nav-on{background:var(--care-tint);color:var(--care-tint-text);font-weight:700}
.care-nav-item:focus-visible{outline:2px solid var(--care-accent);outline-offset:2px}
.care-hero{order:-1;display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:16px}
.care-hero-title{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:700}
.care-hero-sub{font-size:16px;color:var(--care-muted)}
.care-hero-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 16px;margin-top:4px}
.care-patient-chip{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px 0 4px;border:1px solid var(--care-border);border-radius:999px;background:var(--care-surface);color:var(--care-text);font:inherit;font-size:14px;cursor:pointer;align-self:flex-start}
.care-patient-chip:hover{border-color:var(--care-accent)}
.care-avatar{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--care-accent);color:var(--care-on-accent);font-weight:700;flex:none}
.care-avatar-sm{width:28px;height:28px;font-size:13px}
.care-avatar-lg{width:52px;height:52px;font-size:20px}
.care-quick{display:flex;flex-wrap:wrap;gap:8px}
.care-quick-btn,.care-option{min-height:36px;padding:0 14px;border:1px solid var(--care-border);border-radius:999px;background:var(--care-surface);color:var(--care-text);font:inherit;font-size:14px;cursor:pointer}
.care-quick-btn:hover,.care-option:hover:not(:disabled){border-color:var(--care-accent);color:var(--care-accent)}
.care-option:disabled{opacity:.55;cursor:default}
.care-dock button:focus-visible,.care-card button:focus-visible,.care-card a:focus-visible,.care-side button:focus-visible,.care-profile button:focus-visible,.care-entry-btn:focus-visible{outline:2px solid var(--care-accent);outline-offset:2px}
.care-safety{font-size:12px;line-height:18px;color:var(--care-muted);padding:4px 8px;border-radius:6px}
.care-meta{font-size:13px;line-height:1.45;color:var(--care-muted)}
.care-link{display:inline-flex;align-items:center;gap:4px;padding:4px 0;border:none;background:none;color:var(--care-accent);font:inherit;font-size:14px;cursor:pointer;text-decoration:underline}
.care-accent-text{color:var(--care-accent)}
.care-strong{font-weight:500}
.care-chip{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12px;line-height:18px;white-space:nowrap}
.care-chip-tint{background:var(--care-tint);color:var(--care-tint-text)}
.care-chip-warn{background:var(--care-warn-bg);color:var(--care-warn-text)}
.care-ref{display:inline-block;margin-left:6px;padding:0 7px;border-radius:6px;background:var(--care-tint);color:var(--care-tint-text);font-size:12px;line-height:18px;white-space:nowrap}
.care-icon{flex:none}
.care-tool-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:var(--care-muted)}
.care-card{margin:12px 0 4px;border:1px solid var(--care-border);border-radius:14px;background:var(--care-surface);color:var(--care-text);overflow:hidden;font-size:15px;line-height:1.6}
.care-verdict{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:14px 18px;background:var(--care-tint);color:var(--care-tint-text)}
.care-verdict>.care-icon{margin-top:3px}
.care-verdict-text{flex:1 1 240px;min-width:0}
.care-headline{font-size:18px;font-weight:700;line-height:1.4}
.care-summary{font-size:15px}
.care-level-caution .care-verdict{background:var(--care-warn-bg);color:var(--care-warn-text)}
.care-level-emergency{border:2px solid var(--care-danger)}
.care-level-emergency .care-verdict{background:var(--care-danger);color:#FFFFFF;align-items:center}
.care-level-emergency .care-headline{font-size:22px}
.care-call{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:0 22px;border-radius:12px;background:#FFFFFF;color:#A8231A;font-size:18px;font-weight:700;text-decoration:none}
.care-card-body{display:flex;flex-direction:column;gap:14px;padding:16px 18px}
.care-card-body:empty{display:none}
.care-h{margin:0 0 6px;font-size:15px;font-weight:700}
.care-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.care-box{padding:12px 14px;border-radius:10px;background:var(--care-tint);color:var(--care-text)}
.care-box-danger{background:var(--care-danger-bg);color:var(--care-danger-text);font-weight:700}
.care-box-line+.care-box-line{margin-top:4px}
.care-muted{font-size:14px;color:var(--care-muted)}
.care-follow{padding-top:14px;border-top:1px solid var(--care-border)}
.care-follow-q{font-weight:700;margin-bottom:10px}
.care-options{display:flex;flex-wrap:wrap;gap:8px}
.care-option{min-height:40px;border-radius:10px}
.care-evidence{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--care-border);border-radius:10px}
.care-evidence+.care-evidence{margin-top:8px}
.care-evidence-head{display:flex;align-items:baseline;gap:8px}
.care-evidence-head .care-ref{margin-left:0}
.care-evidence-title{font-weight:500;font-size:14px}
.care-quote{font-size:13px;line-height:1.55}
body[data-care-wide] .care-inline-evidence{display:none}
.care-side-wrap{position:absolute;right:0;bottom:0;overflow-y:auto;box-sizing:border-box;padding:12px 16px 16px 0}
.care-side{display:flex;flex-direction:column;gap:12px;color:var(--care-text);font-size:14px;line-height:1.5}
.care-panel{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--care-border);border-radius:14px;background:var(--care-surface)}
.care-panel-title{margin:0;font-size:15px;font-weight:700}
.care-patient{display:flex;align-items:center;gap:10px}
.care-patient-name{font-weight:700;font-size:15px}
.care-fact{display:flex;align-items:flex-start;gap:8px}
.care-fact-text{min-width:0}
.care-row{display:flex;justify-content:space-between;gap:8px}
.care-rule{display:flex;gap:8px;font-weight:400;font-size:13px}
.care-rule-name{font-weight:700;font-size:14px}
.care-profile{position:absolute;inset:0;z-index:20;overflow-y:auto;color:var(--care-text);font-size:14px;line-height:1.55}
.care-profile-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:16px 24px;border-bottom:1px solid var(--care-border)}
.care-profile-title{margin:0;font-size:20px;font-weight:700}
.care-btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border:1px solid var(--care-border);border-radius:10px;background:var(--care-surface);color:var(--care-text);font:inherit;font-size:14px;cursor:pointer}
.care-btn:hover{border-color:var(--care-accent)}
.care-profile-body{display:flex;flex-wrap:wrap;align-items:flex-start;gap:20px;padding:20px 24px}
.care-profile-main{flex:999 1 520px;min-width:0;display:flex;flex-direction:column;gap:16px}
.care-profile-side{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:12px}
.care-pending{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--care-warn-border);border-radius:14px;background:var(--care-warn-bg);color:var(--care-warn-text)}
.care-pending-note{font-size:13px}
.care-pending-item{padding:10px 12px;border-radius:10px;background:var(--care-surface);color:var(--care-text)}
.care-tabs{display:flex;flex-wrap:wrap;gap:8px}
.care-tab{min-height:40px;padding:0 16px;border:1px solid var(--care-border);border-radius:999px;background:var(--care-surface);color:var(--care-text);font:inherit;font-size:14px;cursor:pointer}
.care-tab-on{border-color:var(--care-accent);background:var(--care-accent);color:var(--care-on-accent)}
.care-table-wrap{overflow-x:auto;border:1px solid var(--care-border);border-radius:14px;background:var(--care-surface)}
.care-table{width:100%;min-width:680px;border-collapse:collapse;font-size:14px}
.care-table th{padding:10px 14px;text-align:left;font-weight:500;color:var(--care-muted);background:var(--care-tint);white-space:nowrap}
.care-table td:first-child,.care-table td:nth-child(3),.care-table td:nth-child(5){white-space:nowrap}
.care-table td{padding:12px 14px;border-top:1px solid var(--care-border);vertical-align:top}
.care-drug+.care-drug{padding-top:8px;border-top:1px solid var(--care-border)}
.care-drug-name{font-size:16px;font-weight:700}
`;
		function mountStyle() {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-elder-care";
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		// ── 插件入口 ─────────────────────────────────────────────────────────
		// 远程接口要连同具体名字一起声明（remote.agentPresets：切换会话的智能体）。
		const inject = ["slots", "locale", "sessions", "remote", "remote.agentPresets"];

		function apply(ctx) {
			ctx.effect(mountStyle, "care-ui: style");

			// 老人档案：宿主半侧生成的数据分块。
			require.async("./client.patients.js").then(
				(chunk) => setCare({ patients: chunk.patients ?? {} }),
				(error) => ctx.logger?.warn?.("care-ui: patient data unavailable: %s", error));

			// 上一版曾把界面语言切到自定义的"中文（照护版）"。现在不再改全局文案，把存下来的选择改回中文。
			const restoreLocale = () => {
				try {
					window.localStorage.removeItem("care-ui.locale-applied");
					if (ctx.locale.preference === "zh-care") ctx.locale.setLocale("zh");
				} catch (error) {
					ctx.logger?.warn?.(error);
				}
			};
			restoreLocale();
			ctx.effect(() => {
				const timer = setTimeout(restoreLocale, 3000);
				return () => clearTimeout(timer);
			}, "care-ui: locale restore");

			const inputOf = (sessionId) => {
				const actx = ctx.sessions.scope(sessionId);
				const conversation = actx?.get("conversation");
				return conversation === undefined ? undefined : conversation.input.for(actx);
			};
			const select = (sessionId, preset) => {
				ctx.remote.agentPresets.select(sessionId, preset).catch((error) => ctx.logger?.warn?.(error));
			};

			// 输入框上方：普通会话里的入口；照护会话里的首屏、快捷问题、安全提示、右侧栏、档案页。
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "care",
				order: 30,
				inject: (sessionId) => ({
					fill: (text) => inputOf(sessionId)?.setDraft(text),
					enter: () => select(sessionId, PRESET),
					leave: () => select(sessionId, DEFAULT_PRESET)
				})
			}, CareDock));

			// 每轮末尾：答复卡片。点追问的选项会把它作为下一条消息发出去。
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "dsh-elder-care",
				inject: (sessionId) => ({
					ask: (text) => {
						const input = inputOf(sessionId);
						if (input === undefined) return;
						input.setDraft(text);
						setTimeout(() => input.actions.submit(), 80);
					}
				})
			}, CareTurnTail));

			// 工作步骤列表里的 present_care_answer：只显示一行。
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: ANSWER_TOOL
			}, AnswerToolRow));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
