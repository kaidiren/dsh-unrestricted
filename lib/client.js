window.__ModuleLoader__.load({
	id: "dsh-unrestricted",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region src/client/store.ts
		/**
		* @param initial - first snapshot published to subscribers.
		* @returns a store whose identity changes only when {@link Store.set} is called.
		*/
		function createStore(initial) {
			let value = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => value,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set(next) {
					value = next;
					for (const listener of listeners) listener();
				},
				update(mutator) {
					const next = { ...value };
					mutator(next);
					value = next;
					for (const listener of listeners) listener();
				}
			};
		}
		//#endregion
		//#region src/client/controller.ts
		const RPC_CHANNEL = "/dsh-unrestricted";
		const SETTINGS_NS = "unrestricted";
		/** Human-readable error text for the banner. */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/** Whether two armed maps carry the same session flags. */
		function sameSessions(a, b) {
			const keys = Object.keys(a);
			if (keys.length !== Object.keys(b).length) return false;
			return keys.every((key) => a[key] === b[key]);
		}
		/**
		* Create the controller bound to the calling plugin's context.
		* @param ctx - the browser plugin context (connection + remote + configForms injected).
		* @returns the card face factory and the per-session composer factory.
		*/
		function createUnrestrictedController(ctx) {
			const connection = ctx.get("connection");
			const settings = ctx.configForms.get(SETTINGS_NS);
			let snapshot = {
				sessions: {},
				writable: false,
				settingsStatus: "loading",
				status: null,
				previews: {},
				busy: false
			};
			const listeners = /* @__PURE__ */ new Set();
			const previewRequests = /* @__PURE__ */ new Map();
			const composerStores = /* @__PURE__ */ new Map();
			let statusGeneration = 0;
			let pendingOperations = 0;
			const view = {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			};
			/** Mirror every composer switch from the same settings snapshot. */
			function publishComposers(armed, writable, loading) {
				for (const [sessionId, store] of composerStores) {
					const next = {
						enabled: armed[sessionId] === true,
						writable,
						loading
					};
					const previous = store.getSnapshot();
					if (previous.enabled !== next.enabled || previous.writable !== next.writable || previous.loading !== next.loading) store.set(next);
				}
			}
			function publish() {
				const settingsSnapshot = settings.getSnapshot();
				const armed = {};
				for (const [sessionId, value] of Object.entries(settingsSnapshot.value?.sessions ?? {})) if (value === true) armed[sessionId] = true;
				if (!sameSessions(armed, snapshot.sessions)) invalidatePreviews();
				snapshot = {
					sessions: armed,
					writable: settingsSnapshot.writable,
					settingsStatus: settingsSnapshot.status,
					status: snapshot.status,
					previews: snapshot.previews,
					busy: pendingOperations > 0,
					message: snapshot.message
				};
				for (const listener of listeners) listener();
				publishComposers(armed, settingsSnapshot.writable, settingsSnapshot.status !== "ready");
			}
			function invalidatePreviews() {
				previewRequests.clear();
				snapshot = {
					...snapshot,
					previews: {}
				};
			}
			async function call(endpoint, payload) {
				const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload);
				if (!result.ok) throw new Error(result.error.message);
				return result.value;
			}
			async function whileBusy(action) {
				pendingOperations++;
				publish();
				try {
					await action();
				} finally {
					pendingOperations--;
					publish();
				}
			}
			function readStatus(endpoint, clearPreviews) {
				const generation = ++statusGeneration;
				return whileBusy(async () => {
					try {
						const status = await call(endpoint, {});
						if (generation !== statusGeneration) return;
						if (clearPreviews) invalidatePreviews();
						snapshot = {
							...snapshot,
							status,
							message: void 0
						};
					} catch (error) {
						if (generation !== statusGeneration) return;
						snapshot = {
							...snapshot,
							message: messageOf(error)
						};
					}
				});
			}
			function refresh(clearPreviews = false) {
				return readStatus("status", clearPreviews);
			}
			/**
			* Write one session's flag. The settings service takes whole fields, so the
			* current map is merged into a fresh object; disarming deletes the key
			* instead of storing `false`, keeping the persisted map as the armed set.
			*/
			function setSessionEnabled(sessionId, enabled) {
				return whileBusy(async () => {
					try {
						const next = {};
						for (const [id, value] of Object.entries(settings.getSnapshot().value?.sessions ?? {})) if (value === true) next[id] = true;
						if (enabled) next[sessionId] = true;
						else delete next[sessionId];
						await settings.set("sessions", next);
						await refresh(true);
					} catch (error) {
						snapshot = {
							...snapshot,
							message: messageOf(error)
						};
					}
				});
			}
			function recheck() {
				return readStatus("recheck", true);
			}
			/**
			* Fetch one preset's deploy preview.
			* @param presetId - preset id from the card's row.
			*/
			async function loadPreview(presetId) {
				const request = Symbol(presetId);
				previewRequests.set(presetId, request);
				snapshot = {
					...snapshot,
					previews: {
						...snapshot.previews,
						[presetId]: { status: "loading" }
					}
				};
				publish();
				try {
					const preview = await call("preview", { presetId });
					if (previewRequests.get(presetId) !== request) return;
					snapshot = {
						...snapshot,
						previews: {
							...snapshot.previews,
							[presetId]: {
								status: "ready",
								preview
							}
						}
					};
				} catch (error) {
					if (previewRequests.get(presetId) !== request) return;
					snapshot = {
						...snapshot,
						previews: {
							...snapshot.previews,
							[presetId]: {
								status: "failed",
								errorCode: "preview-failed",
								message: messageOf(error)
							}
						}
					};
				}
				publish();
			}
			/** The store one composer occurrence renders from, created on first ask. */
			function composerStore(sessionId) {
				let store = composerStores.get(sessionId);
				if (store === void 0) {
					const settingsSnapshot = settings.getSnapshot();
					store = createStore({
						enabled: settingsSnapshot.value?.sessions?.[sessionId] === true,
						writable: settingsSnapshot.writable,
						loading: settingsSnapshot.status !== "ready"
					});
					composerStores.set(sessionId, store);
				}
				return store;
			}
			ctx.effect(() => settings.subscribe(publish), "dsh-unrestricted: settings mirror");
			ctx.effect(() => ctx.remote.$on("settings/document-updated", (namespace) => {
				if (namespace === void 0 || namespace === SETTINGS_NS) refresh(true);
			}), "dsh-unrestricted: settings invalidations");
			publish();
			refresh();
			return {
				face: () => ({
					hooks: { view },
					setSessionEnabled,
					recheck,
					refresh: () => refresh(true),
					loadPreview
				}),
				composer: (sessionId) => ({
					hooks: { unrestrictedSession: composerStore(sessionId) },
					sessionId,
					setEnabled: (enabled) => {
						setSessionEnabled(sessionId, enabled);
					}
				})
			};
		}
		//#endregion
		//#region src/client/composer-toggle.tsx
		/**
		* @param props - slot runtime, the `settings.unrestricted` dictionary, and the
		*   controller face for the session this occurrence belongs to.
		*/
		function UnrestrictedComposerToggle(props) {
			const state = props.useUnrestrictedSession((snapshot) => snapshot);
			if (props.sessionId === void 0 || props.sessionId === "") return null;
			const t = props.t;
			const label = t("composerLabel");
			const title = !state.writable ? t("composerReadOnly") : state.loading ? t("composerLoading") : state.enabled ? t("composerOnTitle") : t("composerOffTitle");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-unrestricted-composer",
				title,
				"data-enabled": state.enabled ? "true" : "false",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-unrestricted-composerLabel",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-unrestricted-composerSwitch",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
						checked: state.enabled,
						disabled: !state.writable || state.loading,
						label,
						onChange: (checked) => {
							props.setEnabled(checked);
						}
					})
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the unrestricted settings card and the composer switch. */
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			title: "破限模式",
			summaryEnabled: "有会话已开启",
			summaryDisabled: "全部关闭",
			summaryLoading: "读取中",
			summaryUnavailable: "只读模式",
			summaryValidationFailed: "部分模式未生效",
			description: "按会话开启：只影响被开启的那个会话的系统提示词，未开启的会话保持 DSH 原版提示词。开关在输入框工具栏（与「自动继续」同排），默认关闭；切换从下一轮请求生效，不改动正在执行的请求、工具定义、权限配置与会话历史。",
			scopeNote: "仅作用于由 DSH 组装的系统提示词；模型平台或外部网关的远端策略不在本插件覆盖范围内。",
			armedTitle: "已开启破限的会话",
			armedEmpty: "当前没有会话开启破限。在输入框工具栏打开「破限」开关即对本会话生效。",
			composerHint: "「破限」开关位于输入框工具栏，只对当前会话生效，默认关闭。",
			composerLabel: "破限",
			composerOffTitle: "本会话未开启破限（默认关闭），点击开启",
			composerOnTitle: "本会话已开启破限，点击恢复原版提示词",
			composerLoading: "正在读取配置…",
			composerReadOnly: "当前连接为只读模式，无法切换",
			statusTitle: "模式覆盖与提示词预览",
			statusSubtitle: "覆盖全部 4 种预设及委派子代理，可随时展开核对或复制融合后的完整提示词。",
			modeStandard: "Standard 标准模式",
			modeStandardDesc: "日常编码、逆向分析、脚本编写与综合问答",
			modePtc: "PTC 编程模式",
			modePtcDesc: "基于 run_code 工具链的程序化任务执行",
			modeCordis: "Cordis 创造模式",
			modeCordisDesc: "DSH 与 Cordis 插件生态开发调试",
			modeMinimal: "Minimal 极简模式",
			modeMinimalDesc: "零内置先验的纯净系统提示词与子代理基座",
			subagentNote: "子代理（含结构化输出子代理）随所属会话的开关一并生效。",
			stateActive: "已生效",
			stateOff: "待命",
			stateValidationFailed: "已跳过（缺少角色段落）",
			refresh: "刷新状态",
			presetStandard: "standard",
			presetPtc: "ptc",
			presetCordis: "cordis",
			presetMinimal: "minimal",
			showPreview: "查看提示词",
			hidePreview: "收起预览",
			copyPreview: "复制全文",
			copiedPreview: "已复制",
			previewLoading: "正在生成当前模式的提示词预览…",
			previewUnavailable: "暂无法生成预览：",
			previewSize: "行",
			previewSourceLive: "当前会话实时组装",
			previewSourceStanding: "预设基准组装",
			settingsUnavailable: "当前连接处于只读模式，无法修改设置。",
			settingsLoading: "正在读取配置…",
			operationFailed: "操作失败：",
			issuePersona: "未检测到预设角色前缀段落，已自动保留原版提示词",
			errorRpcDisconnected: "无法连接宿主服务，请确认 DSH 正在运行后刷新重试。",
			errorUnsupportedPreset: "不支持该预设模式的提示词预览。",
			errorMissingPersona: "当前预设未包含角色前缀段落，已自动保留原版提示词。",
			errorPreviewFailed: "生成提示词预览失败，请稍后刷新重试。"
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			title: "Unrestricted Mode",
			summaryEnabled: "Some sessions armed",
			summaryDisabled: "All off",
			summaryLoading: "Loading",
			summaryUnavailable: "Read-only",
			summaryValidationFailed: "Partial mode coverage",
			description: "Armed per session: only the armed conversation has its system prompt fused with the unrestricted execution contract; every other session keeps the stock DSH prompt. The switch sits in the composer tool row next to Auto-continue and is off by default. A change applies from the next request without altering in-flight turns, tool schemas, permissions, or session history.",
			scopeNote: "Applies only to system prompts assembled by DSH; upstream model provider policies outside the prompt are out of scope.",
			armedTitle: "Sessions with unrestricted mode on",
			armedEmpty: "No session is armed. Flip the “Unrestricted” switch in the composer tool row to arm this conversation.",
			composerHint: "The “Unrestricted” switch sits in the composer tool row and only affects the current session. Off by default.",
			composerLabel: "Unrestricted",
			composerOffTitle: "Unrestricted mode is off for this session (default). Click to arm it.",
			composerOnTitle: "Unrestricted mode is on for this session. Click to restore the stock prompt.",
			composerLoading: "Loading configuration…",
			composerReadOnly: "This connection is read-only; the switch cannot be changed.",
			statusTitle: "Mode Coverage & Prompt Preview",
			statusSubtitle: "Covers all 4 built-in presets and delegated subagents. Expand any mode to inspect or copy the full fused prompt.",
			modeStandard: "Standard",
			modeStandardDesc: "General coding, reverse engineering, scripting, and technical Q&A",
			modePtc: "PTC Mode",
			modePtcDesc: "Programmatic tool calling via the run_code execution environment",
			modeCordis: "Cordis Mode",
			modeCordisDesc: "DSH and Cordis plugin development and framework debugging",
			modeMinimal: "Minimal Mode",
			modeMinimalDesc: "Zero-prior minimal system prompt and subagent foundation",
			subagentNote: "Subagents (including structured-output subagents) follow their parent session switch.",
			stateActive: "Active",
			stateOff: "Standby",
			stateValidationFailed: "Skipped (missing persona section)",
			refresh: "Refresh",
			presetStandard: "standard",
			presetPtc: "ptc",
			presetCordis: "cordis",
			presetMinimal: "minimal",
			showPreview: "Preview prompt",
			hidePreview: "Hide preview",
			copyPreview: "Copy prompt",
			copiedPreview: "Copied",
			previewLoading: "Assembling prompt preview…",
			previewUnavailable: "Preview unavailable: ",
			previewSize: "lines",
			previewSourceLive: "Live session assembly",
			previewSourceStanding: "Preset baseline assembly",
			settingsUnavailable: "This connection is read-only and cannot modify settings.",
			settingsLoading: "Loading configuration…",
			operationFailed: "Operation failed: ",
			issuePersona: "Preset persona section not found — stock prompt kept",
			errorRpcDisconnected: "Cannot reach the host service. Please verify DSH is running and refresh.",
			errorUnsupportedPreset: "Prompt preview is not supported for this preset.",
			errorMissingPersona: "The preset is missing a persona prefix section; the stock prompt is kept.",
			errorPreviewFailed: "Could not assemble the prompt preview. Please try refreshing."
		};
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.unrestricted";
		//#endregion
		//#region src/client/styles.ts
		/**
		* Stylesheet for the unrestricted settings card. Injected once as a single
		* <style data-plugin="dsh-unrestricted"> tag; colors and geometry come from
		* DSH's shared --dsw-* design tokens so Web and Desktop (light & dark themes)
		* match native Settings cards.
		*/
		const CSS = `
.dsh-unrestricted-root {
  display: flex;
  flex-direction: column;
  gap: var(--dsw-space-3, 12px);
  width: 100%;
  max-width: 760px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
}

.dsh-unrestricted-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-xl, 12px);
  padding: 16px 18px;
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-3));
}

.dsh-unrestricted-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 14px;
}

.dsh-unrestricted-headerTitle {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dsh-unrestricted-headerControls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dsh-unrestricted-switchLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
  user-select: none;
}

.dsh-unrestricted-title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-unrestricted-subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-unrestricted-description {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-unrestricted-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-unrestricted-banner {
  margin: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 8px);
  padding: 9px 12px;
  font-size: 13px;
  line-height: 19px;
  overflow-wrap: anywhere;
}

.dsh-unrestricted-banner[data-tone='error'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.dsh-unrestricted-banner[data-tone='success'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.dsh-unrestricted-banner[data-tone='info'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
}

.dsh-unrestricted-modes {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}

.dsh-unrestricted-mode {
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
}

.dsh-unrestricted-mode + .dsh-unrestricted-mode {
  border-top: 1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}

.dsh-unrestricted-modeMain {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 14px;
}

.dsh-unrestricted-modeInfo {
  display: flex;
  flex: 1;
  min-width: 200px;
  flex-direction: column;
  gap: 3px;
}

.dsh-unrestricted-modeHeading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dsh-unrestricted-modeName {
  font-size: 13px;
  line-height: 19px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-unrestricted-modeDesc {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-unrestricted-mono {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}

.dsh-unrestricted-issues {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.dsh-unrestricted-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
}

.dsh-unrestricted-previewHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.dsh-unrestricted-previewMeta {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-unrestricted-previewText {
  max-height: 320px;
  margin: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 8px);
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 输入框工具行里的会话级开关：与相邻的「自动继续」保持同一行高、间距与
   字号，标签前置、胶囊开关后置。开关本体使用宿主原生 Switch，这里只负责
   摆放与命中区域。 */
.dsh-unrestricted-composer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  max-width: 100%;
  font: inherit;
}

.dsh-unrestricted-composerLabel {
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
}

.dsh-unrestricted-composer[data-enabled='true'] .dsh-unrestricted-composerLabel {
  color: var(--dsw-alias-label-primary);
}

.dsh-unrestricted-composerSwitch {
  display: inline-flex;
  align-items: center;
  flex: none;
  min-height: 32px;
}

.dsh-unrestricted-composerSwitch > button {
  position: relative;
}

/* 拉满 32px 的可点区域，但视觉上仍是 36x20 的胶囊。 */
.dsh-unrestricted-composerSwitch > button::before {
  content: '';
  position: absolute;
  inset: -6px -3px;
}

.dsh-unrestricted-armed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2, transparent);
}

.dsh-unrestricted-sessions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dsh-unrestricted-sessionTag {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .dsh-unrestricted-card {
    padding: 14px;
  }

  .dsh-unrestricted-modeDesc,
  .dsh-unrestricted-issues {
    padding-left: 0;
  }

  .dsh-unrestricted-composerLabel {
    display: none;
  }
}
`;
		/** Inject the stylesheet once; the tag id doubles as the re-evaluation guard. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin=\"dsh-unrestricted\"]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-unrestricted";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/UnrestrictedCard.tsx
		/**
		* The unrestricted settings view:
		* - Status card: armed sessions, per-session switch pointer, scope boundary notes
		* - Per-preset coverage list with StateDot, Tag, preview drawer, and one-click copy
		*/
		/** Mode rows in display order, with their locale label and description keys. */
		const MODE_ROWS = [
			{
				id: "standard",
				labelKey: "modeStandard",
				descKey: "modeStandardDesc",
				presetKey: "presetStandard"
			},
			{
				id: "ptc",
				labelKey: "modePtc",
				descKey: "modePtcDesc",
				presetKey: "presetPtc"
			},
			{
				id: "cordis",
				labelKey: "modeCordis",
				descKey: "modeCordisDesc",
				presetKey: "presetCordis"
			},
			{
				id: "minimal",
				labelKey: "modeMinimal",
				descKey: "modeMinimalDesc",
				presetKey: "presetMinimal"
			}
		];
		/** Known host issue strings/codes mapped to localized dictionary keys. */
		const ISSUE_LOCALE_KEYS = {
			"missing-persona": "issuePersona",
			"preset persona changed": "issuePersona"
		};
		/** Locale key for one mode state. */
		function stateKey(mode) {
			switch (mode?.state) {
				case "active": return "stateActive";
				case "failed": return "stateValidationFailed";
				default: return "stateOff";
			}
		}
		/** Map mode state to native StateDot state. */
		function dotStateOf(mode) {
			switch (mode?.state) {
				case "active": return "done";
				case "failed": return "error";
				default: return "idle";
			}
		}
		/** Map mode state to native Tag tone. */
		function modeTagTone(mode) {
			switch (mode?.state) {
				case "active": return "success";
				case "failed": return "danger";
				default: return "neutral";
			}
		}
		/** Friendly localized text for top-level RPC or settings errors. */
		function localizeBannerError(message, t) {
			const lower = message.toLowerCase();
			if (lower.includes("disconnect") || lower.includes("closed") || lower.includes("network") || lower.includes("timeout")) return t("errorRpcDisconnected");
			return `${t("operationFailed")}${message}`;
		}
		/** Friendly localized text for preview failures. */
		function localizePreviewError(entry, t) {
			const code = entry.preview?.errorCode ?? entry.errorCode;
			if (code === "unsupported-preset") return t("errorUnsupportedPreset");
			if (code === "missing-persona") return t("errorMissingPersona");
			if (code === "preview-failed") return t("errorPreviewFailed");
			const detail = entry.preview?.reason ?? entry.message;
			return detail !== void 0 && detail.trim() !== "" ? `${t("previewUnavailable")}${detail}` : t("errorPreviewFailed");
		}
		/**
		* Render the unrestricted configuration cards.
		*/
		function UnrestrictedCard(props) {
			const { t, loadPreview } = props;
			const view = props.useView((snapshot) => snapshot);
			const status = view.status;
			const [openPreview, setOpenPreview] = (0, react.useState)(null);
			const [copiedPreset, setCopiedPreset] = (0, react.useState)(null);
			const openEntry = openPreview === null ? void 0 : view.previews[openPreview];
			(0, react.useEffect)(() => {
				if (openPreview !== null && openEntry === void 0) loadPreview(openPreview);
			}, [
				openPreview,
				openEntry,
				loadPreview
			]);
			const armed = Object.keys(view.sessions);
			const hasFailedMode = status !== null && Object.values(status.modes).some((mode) => mode.state === "failed");
			const summaryKey = view.settingsStatus === "loading" ? "summaryLoading" : view.settingsStatus === "unavailable" ? "summaryUnavailable" : hasFailedMode ? "summaryValidationFailed" : armed.length > 0 ? "summaryEnabled" : "summaryDisabled";
			const summaryTone = view.settingsStatus !== "ready" ? "neutral" : hasFailedMode ? "warning" : armed.length > 0 ? "success" : "neutral";
			/** Toggle one preset's preview, fetching the current bytes on first open. */
			function togglePreview(presetId) {
				if (openPreview === presetId) {
					setOpenPreview(null);
					return;
				}
				setOpenPreview(presetId);
				const entry = view.previews[presetId];
				if (entry === void 0 || entry.status === "failed") props.loadPreview(presetId);
			}
			/** Copy one preset's preview prompt text to the clipboard. */
			async function handleCopyPreview(presetId, text) {
				if (text === void 0 || text === "") return;
				if (!await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text)) return;
				setCopiedPreset(presetId);
				setTimeout(() => {
					setCopiedPreset((current) => current === presetId ? null : current);
				}, 1800);
			}
			/** Localize known issues; fall back gracefully. */
			function formatIssues(issues) {
				return issues.map((issue) => {
					const key = ISSUE_LOCALE_KEYS[issue];
					return key !== void 0 ? t(key) : issue;
				}).join("；");
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-unrestricted-root",
				"aria-busy": view.busy,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dsh-unrestricted-card",
					"aria-labelledby": "dsh-unrestricted-main-title",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-unrestricted-header",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-unrestricted-headerTitle",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									id: "dsh-unrestricted-main-title",
									className: "dsh-unrestricted-title",
									children: t("title")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: summaryTone,
									children: t(summaryKey)
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-description",
							children: t("description")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-note",
							children: t("composerHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-unrestricted-armed",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-unrestricted-note",
								children: t("armedTitle")
							}), armed.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsh-unrestricted-note",
								children: t("armedEmpty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dsh-unrestricted-sessions",
								children: armed.map((sessionId) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: "success",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-unrestricted-sessionTag dsh-unrestricted-mono",
										children: sessionId
									})
								}) }, sessionId))
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-note",
							children: t("scopeNote")
						}),
						view.settingsStatus === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-note",
							role: "status",
							children: t("settingsLoading")
						}),
						view.settingsStatus === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-banner",
							"data-tone": "info",
							role: "status",
							children: t("settingsUnavailable")
						}),
						view.message !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-banner",
							"data-tone": "error",
							role: "alert",
							children: localizeBannerError(view.message, t)
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dsh-unrestricted-card",
					"aria-labelledby": "dsh-unrestricted-modes-title",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-unrestricted-header",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-unrestricted-headerTitle",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
									id: "dsh-unrestricted-modes-title",
									className: "dsh-unrestricted-subtitle",
									children: t("statusTitle")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-unrestricted-headerControls",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: view.busy,
									onClick: () => {
										props.refresh();
									},
									children: t("refresh")
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-note",
							children: t("statusSubtitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dsh-unrestricted-modes",
							children: MODE_ROWS.map((row) => {
								const mode = status?.modes[row.id];
								const entry = view.previews[row.id];
								const isOpen = openPreview === row.id;
								const previewText = entry?.preview?.text;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "dsh-unrestricted-mode",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-unrestricted-modeMain",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-unrestricted-modeInfo",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsh-unrestricted-modeHeading",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: dotStateOf(mode) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "dsh-unrestricted-modeName",
															children: t(row.labelKey)
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
															tone: "outline",
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: "dsh-unrestricted-mono",
																children: t(row.presetKey)
															})
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
															tone: modeTagTone(mode),
															children: t(stateKey(mode))
														})
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													className: "dsh-unrestricted-modeDesc",
													children: t(row.descKey)
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dsh-unrestricted-headerControls",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: isOpen ? "toolbar" : "outline",
													size: "sm",
													onClick: () => {
														togglePreview(row.id);
													},
													children: t(isOpen ? "hidePreview" : "showPreview")
												})
											})]
										}),
										mode !== void 0 && mode.issues.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsh-unrestricted-issues",
											children: formatIssues(mode.issues)
										}),
										isOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-unrestricted-preview",
											children: entry === void 0 || entry.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsh-unrestricted-note",
												role: "status",
												children: t("previewLoading")
											}) : entry.status === "failed" || entry.preview?.available === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsh-unrestricted-banner",
												"data-tone": "error",
												role: "alert",
												children: localizePreviewError(entry, t)
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsh-unrestricted-previewHeader",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
													className: "dsh-unrestricted-previewMeta",
													children: [
														entry.preview?.lines,
														" ",
														t("previewSize"),
														entry.preview?.bytes !== void 0 && ` · ${(0, _deepseek_ai_dsh_client_ui_primitives.fileSizeText)(entry.preview.bytes)}`,
														entry.preview?.source !== void 0 && ` · ${t(entry.preview.source === "live" ? "previewSourceLive" : "previewSourceStanding")}`
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "ghost",
													size: "sm",
													onClick: () => {
														handleCopyPreview(row.id, previewText);
													},
													children: t(copiedPreset === row.id ? "copiedPreview" : "copyPreview")
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
												className: "dsh-unrestricted-previewText",
												children: previewText
											})] })
										})
									]
								}, row.id);
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-unrestricted-note",
							children: t("subagentNote")
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** Services required by the registration and the controller. */
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"configForms"
		];
		/** 注册配置卡片与输入框内的会话级开关。 */
		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-unrestricted: dictionaries");
			const controller = createUnrestrictedController(ctx);
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-unrestricted",
				locale: NS,
				inject: () => controller.face()
			}, UnrestrictedCard));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-unrestricted-session",
				locale: NS,
				inject: (sessionId) => controller.composer(sessionId)
			}, UnrestrictedComposerToggle));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map