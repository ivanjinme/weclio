import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, getPowerShellConfig, getShellConfig, initTheme, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { Admission } from "./agent/admission";
import type { ComposerPart } from "./composer";
import { expandSkillParts } from "./skill-input";
import { invalidateModelsCache } from "./models-cache";
import { generateSessionTitle } from "./session-title";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import type { AgentSession, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";
import { getToolNamesForPreset, isToolPreset, type ShellAvailability, type ToolPreset } from "./tool-presets";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

const PROGRESS_UPDATE_INSTRUCTION = "You must always start with an intermediary update before any content in the analysis channel if the task will require calling tools. The user update should acknowledge the request and explain your first step.";

// Theme 构造时会展开颜色对象，必须显式提供可选 token 的回退源。
const PLAIN_TEXT_COLORS: Record<string, string> = {
  muted: "",
  text: "",
  selectedBg: "",
  thinkingXhigh: "",
};

class PlainTextTheme extends Theme {
  constructor() {
    super(
      PLAIN_TEXT_COLORS as ConstructorParameters<typeof Theme>[0],
      PLAIN_TEXT_COLORS as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override style(text: string): string { return text; }
  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const extensionToolNames = session
    .getAllTools()
    .filter((tool) => tool.sourceInfo.source !== "builtin")
    .map((tool) => tool.name);

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private manualCompactionRunning = false;
  private manualCompactionAbortRequested = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private refreshToolsHook: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  private _alive = true;
  private replySucceeded = false;
  private readonly admission = new Admission();

  constructor(
    public readonly inner: AgentSessionLike,
    private readonly shellAvailability: ShellAvailability,
    private autoNameOnFirstReply = false,
    private readonly hooks?: AgentRuntimeHooks,
  ) {}

  /** 首个 await 前占位；归属于当前 session 的 runtime。 */
  reserveTask(): () => void {
    return this.hooks?.reserveTask() ?? this.admission.reserve();
  }

  private notify(): void {
    this.hooks?.notifyRunningChange();
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "message_end") {
        const message = event.message as { role?: string; stopReason?: string } | undefined;
        if (message?.role === "assistant") {
          this.replySucceeded = message.stopReason === "stop" || message.stopReason === "length";
        }
      }
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        this.resetIdleTimer();
      } else if (event.type === "compaction_end") {
        this.resetIdleTimer();
      }
      // compact() aborts any active agent turn before it creates its own
      // AbortController. A Stop request can arrive during that gap, so retain
      // it and apply it as soon as compaction actually starts.
      if (event.type === "compaction_start" && this.manualCompactionAbortRequested) {
        this.inner.abortCompaction();
      }
      this.emit(event);
      // Streaming / compaction / tool events flow through here; re-broadcast
      // the running-status snapshot so the sidebar can update live.
      this.notify();
    });
    this.resetIdleTimer();
    this.notify();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  setToolPreset(preset: ToolPreset): void {
    const builtinToolNames = this.inner
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source === "builtin")
      .map((tool) => tool.name);
    const toolNames = getToolNamesForPreset(preset, this.shellAvailability, builtinToolNames);
    this.setToolNames(toolNames);
  }

  setToolNames(toolNames: string[]): void {
    this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
    this.setForceEmptySystemPrompt(toolNames.length === 0);
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[weclio] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    const finishBinding = this.reserveTask();
    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[weclio] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    }).finally(finishBinding);

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.notify();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (!this.forceEmptySystemPrompt) return;
    // 动态注册也会重建 loadout；保留 SDK 刷新，再恢复 Off，不改请求或转录。
    const runtime = this.inner.resourceLoader.getExtensions().runtime;
    if (runtime.refreshTools !== this.refreshToolsHook) {
      const refreshTools = runtime.refreshTools.bind(runtime);
      this.refreshToolsHook = () => {
        refreshTools();
        this.applyForcedEmptySystemPrompt();
      };
      runtime.refreshTools = this.refreshToolsHook;
    }
    this.inner.setActiveToolsByName([]);
    this.inner.extensionRunner.createCommandContext().getSystemPromptOptions().forceSystemPrompt = "";
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this._alive) return;
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() && !this.forceShutdownOnIdle) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[weclio] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, 10 * 60 * 1000);
  }

  // 首条 shell、空分支和 prompt 预检前也需可恢复；SDK 会延迟这些会话落盘。
  private persistPendingSession(manager = this.inner.sessionManager): void {
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // 由 SDK 公开接口接管后续 append；重新加载时保留当前分支，不修改私有 flushed。
    const leafId = manager.getLeafId();
    manager.setSessionFile(sessionFile);
    if (leafId === null) manager.resetLeaf();
    else manager.branch(leafId);
    cacheSessionPath(manager.getSessionId(), sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    const passive = type.startsWith("get_") || type === "abort" || type === "abort_compaction" || type === "abort_bash" || type === "extension_ui_response" || type === "extension_ui_input";
    const finish = passive ? undefined : this.reserveTask();
    try {
      return await this.sendCommand(command);
    } finally {
      finish?.();
    }
  }

  private async sendCommand(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    if (type !== "get_state") this.resetIdleTimer();
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    let message = command.message as string;
    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
      if (command.parts) {
        message = expandSkillParts(command.parts as ComposerPart[], this.inner.resourceLoader.getSkills().skills);
      }
    }

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        // 在 SDK 异步预检前让新会话可发现；首个 user message 后由 SDK 正常持久化。
        this.persistPendingSession();
        this.promptRunning = true;
        this.replySucceeded = false;
        invalidateSessionListCache();
        this.notify();
        const finishPrompt = this.reserveTask();
        let execution: Promise<void>;
        try {
          execution = this.inner.prompt(message, {
            ...(promptImages?.length ? { images: promptImages } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            source: "rpc",
          });
        } catch (error) {
          this.promptRunning = false;
          finishPrompt();
          this.notify();
          throw error;
        }
        execution.then(() => {
          this.promptRunning = false;
          this.resetIdleTimer();
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          this.notify();
          if (this.autoNameOnFirstReply && this.replySucceeded) {
            this.autoNameOnFirstReply = false;
            // 复用命名操作，后台执行；失败保留首条消息标题，不重试。
            void autoNameRpcSession(this, true).catch((error) => {
              console.warn("[weclio] automatic session title failed:", error instanceof Error ? error.message : error);
            });
          }
        }).catch((error) => {
          this.promptRunning = false;
          this.resetIdleTimer();
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          this.notify();
        }).finally(finishPrompt);
        return null;
      }

      case "abort":
        this.forceShutdownOnIdle = true;
        try {
          if (this.manualCompactionRunning || this.inner.isCompacting) {
            this.manualCompactionAbortRequested = true;
            this.inner.abortCompaction();
            // Before compact() creates its AbortController it may still be
            // waiting for the previous agent turn to abort.
            if (!this.inner.isCompacting) await this.inner.abort();
            return null;
          }
          await this.withFinalRunningNotification(() => this.inner.abort());
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        // User-message New chat keeps the existing behavior (branch before the
        // selected prompt). Assistant-message New chat includes the selected
        // response, so the new session can continue from that exact answer.
        const branchLeafId = command.includeEntry === true ? entry.id : entry.parentId;
        const sessionDir = sessionManager.getSessionDir();
        let newManager: SessionManager;

        if (!branchLeafId) {
          newManager = SessionManager.create(sessionManager.getCwd(), sessionDir, { parentSession: currentSessionFile });
        } else {
          newManager = SessionManager.open(currentSessionFile, sessionDir);
          if (!newManager.createBranchedSession(branchLeafId)) throw new Error("Failed to create forked session");
        }

        // 空分支或仅含 setup 的分支尚无文件；先落盘再交付 ID，避免 open 生成另一个身份。
        this.persistPendingSession(newManager);
        const newSessionFile = newManager.getSessionFile() as string;
        const newSessionId = newManager.getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await this.shutdown();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "navigate_before": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const entry = this.inner.sessionManager.getEntry(command.entryId as string);
        if (!entry) throw new Error("Invalid entry ID for navigation");
        if (!entry.parentId) throw new Error("Cannot edit before the first session entry");
        const result = await this.inner.navigateTree(entry.parentId, {});
        return { cancelled: result.cancelled, targetId: entry.parentId };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        if (this.manualCompactionRunning || this.inner.isCompacting) {
          throw new Error("Compaction already in progress");
        }
        this.manualCompactionRunning = true;
        this.manualCompactionAbortRequested = false;
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          this.manualCompactionRunning = false;
          this.manualCompactionAbortRequested = false;
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        if (typeof command.name !== "string") throw new Error("Session name must be a string");
        const name = command.name.trim();
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(message, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(message, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
          source: t.sourceInfo.source,
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        if (command.preset !== undefined) {
          if (!isToolPreset(command.preset)) throw new Error(`Invalid tool preset: ${String(command.preset)}`);
          this.setToolPreset(command.preset);
        } else {
          this.setToolNames(command.toolNames as string[]);
        }
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        await this.reloadResources();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        this.notify();
        try {
          const result = await execution;
          this.persistPendingSession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          this.notify();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        try {
          this.onDestroyCallback?.();
        } finally {
          this.notify();
        }
      }
    };

    // Direct destruction is used by process shutdown too. Start the extension
    // hook before invalidating the SDK session; shutdown() awaits it when the
    // caller can wait, while this path remains best-effort.
    if (this.sessionShutdownEmitted || typeof this.inner.extensionRunner.emit !== "function") {
      finishDispose();
      return;
    }
    this.sessionShutdownEmitted = true;
    void this.inner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
      .catch((error) => {
        console.error("[weclio] session_shutdown before dispose failed:", error instanceof Error ? error.message : error);
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error("[weclio] extension binding failed before session shutdown:", error instanceof Error ? error.message : error);
        }
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: () => this.reloadResources(),
    };
  }

  private async reloadResources(): Promise<void> {
    this.syncProjectTrust();
    const useLegacyBinding = typeof this.inner.bindExtensions !== "function";
    const beforeSessionStart = () => {
      // Pi 已经换掉旧扩展，新扩展还没开始注册界面状态。
      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.applyForcedEmptySystemPrompt();
    };
    await this.inner.reload({ beforeSessionStart });
    if (useLegacyBinding) {
      beforeSessionStart();
      this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
    }
    this.applyForcedEmptySystemPrompt();
    this.emit({ type: "session_reloaded" });
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// 自动命名保留在 facade，HTTP route 不接触 SDK session。
export async function autoNameRpcSession(session: AgentSessionWrapper, onlyIfUnnamed = false) {
  const finish = session.reserveTask();
  try {
    return await generateRpcSessionName(session, onlyIfUnnamed);
  } finally {
    finish();
  }
}

async function generateRpcSessionName(session: AgentSessionWrapper, onlyIfUnnamed: boolean) {
  await session.waitUntilReady();
  const hasTitleRecord = () => session.inner.sessionManager.getEntries().some((entry) => entry.type === "session_info");
  if (!session.isAlive() || (onlyIfUnnamed && hasTitleRecord())) return null;
  const result = await generateSessionTitle(session.inner as unknown as Pick<AgentSession, "agent">);
  if (!session.isAlive() || (onlyIfUnnamed && hasTitleRecord())) return null;
  session.inner.setSessionName(result.title);
  invalidateSessionListCache();
  return result;
}

// ============================================================================
// Agent runtime
// ============================================================================

// 由宿主拥有的 runtime 注入准入占位与运行态广播。
export interface AgentRuntimeHooks {
  reserveTask(): () => void;
  notifyRunningChange(): void;
}

/** 会话是否占用更新/维护门禁：运行中或还有排队消息。 */
export function isSessionBusy(session: AgentSessionWrapper): boolean {
  return session.isRunning() || (session.isAlive() && session.inner.pendingMessageCount > 0);
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

export interface StartSessionResult {
  session: AgentSessionWrapper;
  realSessionId: string;
}

/**
 * 运行期所有权：会话、启动锁、起始目录计数、运行态订阅与准入。
 * 实例化后只归一个宿主持有，由宿主显式管理生命周期。
 */
export class AgentRuntime implements AgentRuntimeHooks {
  private readonly sessions = new Map<string, AgentSessionWrapper>();
  private readonly locks = new Map<string, Promise<StartSessionResult>>();
  private readonly startingCwds = new Map<string, number>();
  private readonly runningListeners = new Set<(ids: string[]) => void>();
  private lastRunningSnapshot = "";
  private shellAvailability: ShellAvailability | undefined;
  private closing = false;

  constructor(readonly admission: Admission = new Admission()) {}

  reserveTask(): () => void {
    if (this.closing) throw new Error("Agent service is shutting down");
    return this.admission.reserve();
  }

  /** 接管一个已存在的 wrapper，并随其销毁自动移除。 */
  attachSession(session: AgentSessionWrapper): void {
    this.sessions.set(session.sessionId, session);
    session.onDestroy(() => this.sessions.delete(session.sessionId));
  }

  getSession(sessionId: string): AgentSessionWrapper | undefined {
    return this.sessions.get(sessionId);
  }

  /** 缓存一次自动 shell 探测结果；两种 shell 都不可用时仍允许读写工具。 */
  getShellAvailability(): ShellAvailability {
    if (this.shellAvailability) return this.shellAvailability;
    const availability: ShellAvailability = { bash: false, powershell: false };
    let bashError: unknown;
    let powerShellError: unknown;
    try {
      getShellConfig();
      availability.bash = true;
    } catch (error) {
      bashError = error;
    }
    try {
      getPowerShellConfig();
      availability.powershell = true;
    } catch (error) {
      powerShellError = error;
    }
    if (!availability.bash && !availability.powershell) {
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
      console.warn(
        `[weclio] No supported shell is available; shell tools are disabled and read/edit/write remain enabled. Bash: ${message(bashError)}; PowerShell: ${message(powerShellError)}`,
      );
    }
    this.shellAvailability = availability;
    return availability;
  }

  /** 记录一次会话启动（含扩展绑定前的窗口）；返回释放函数。 */
  trackStartingSession(cwd: string): () => void {
    const key = normalizeRpcCwd(cwd);
    this.startingCwds.set(key, (this.startingCwds.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.startingCwds.get(key) ?? 1) - 1;
      if (remaining > 0) this.startingCwds.set(key, remaining);
      else this.startingCwds.delete(key);
    };
  }

  hasBusyForCwds(cwds: Iterable<string>): boolean {
    const targetCwds = new Set(Array.from(cwds, normalizeRpcCwd));
    for (const cwd of targetCwds) {
      if (this.startingCwds.has(cwd)) return true;
    }
    return Array.from(this.sessions.values()).some(
      (session) => targetCwds.has(normalizeRpcCwd(session.cwd)) && session.isRunning(),
    );
  }

  hasBusyForCwd(cwd: string): boolean {
    return this.hasBusyForCwds([cwd]);
  }

  async destroyForCwds(cwds: Iterable<string>): Promise<number> {
    const targetCwds = new Set(Array.from(cwds, normalizeRpcCwd));
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => targetCwds.has(normalizeRpcCwd(session.cwd)),
    );
    await Promise.all(sessions.map((session) => session.shutdown()));
    return sessions.length;
  }

  hasBusyTasks(): boolean {
    return this.locks.size > 0 || this.startingCwds.size > 0
      || Array.from(this.sessions.values()).some(isSessionBusy);
  }

  runningIds(): string[] {
    const ids = new Set<string>();
    for (const [sessionId, session] of this.sessions) {
      if (session.isRunning()) ids.add(session.sessionId || sessionId);
    }
    return [...ids];
  }

  /** 订阅运行中会话集合的变化；返回取消订阅函数。 */
  subscribeRunning(listener: (ids: string[]) => void): () => void {
    this.runningListeners.add(listener);
    return () => { this.runningListeners.delete(listener); };
  }

  /** 集合变化时才广播，可高频调用。 */
  notifyRunningChange(): void {
    const ids = this.runningIds();
    const snapshot = JSON.stringify([...ids].sort());
    if (snapshot === this.lastRunningSnapshot) return;
    this.lastRunningSnapshot = snapshot;
    for (const listener of this.runningListeners) {
      try { listener(ids); } catch { /* 订阅方错误不应影响运行 */ }
    }
  }

  /** 同 ID 并发合并为一次启动；失败释放锁，允许重试。 */
  async startSession(
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames?: string[],
    toolPreset?: ToolPreset,
  ): Promise<StartSessionResult> {
    if (toolPreset !== undefined && !isToolPreset(toolPreset)) {
      throw new Error(`Invalid tool preset: ${String(toolPreset)}`);
    }
    if (this.closing) throw new Error("Agent service is shutting down");

    const existing = this.sessions.get(sessionId);
    if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

    const inflight = this.locks.get(sessionId);
    if (inflight) return inflight;

    const finishTask = this.reserveTask();
    const finishStartingSession = this.trackStartingSession(cwd);
    const starting = (async () => {
      // Some extensions access the SDK's global theme even outside the terminal UI.
      initTheme();
      const agentDir = getAgentDir();

      const sessionManager = sessionFile
        ? SessionManager.open(sessionFile, undefined)
        : SessionManager.create(cwd, undefined);

      // Off 只改变 active tools；创建时传空 allow-list 会永久阻止随后重新启用工具。
      const toolsDisabled = toolPreset === "none" || (toolPreset === undefined && toolNames?.length === 0);

      // Build services first so extension-registered providers are available
      // before the SDK restores the saved model from the session file.
      // Gate untrusted project extensions so opening a repository does not run
      // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
      const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          appendSystemPromptOverride: (base) => [...base, PROGRESS_UPDATE_INSTRUCTION],
        },
        ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
      });
      const shellAvailability = this.getShellAvailability();

      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
      });

      const wrapper = new AgentSessionWrapper(inner, shellAvailability, !sessionFile, this);
      if (toolPreset !== undefined) {
        wrapper.setToolPreset(toolPreset);
      } else if (toolNames !== undefined) {
        wrapper.setToolNames(toolNames);
      }
      wrapper.start();

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      wrapper.onDestroy(() => this.sessions.delete(realSessionId));
      this.sessions.set(realSessionId, wrapper);
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolsDisabled });

      return { session: wrapper, realSessionId };
    })().finally(() => {
      this.locks.delete(sessionId);
      finishStartingSession();
      finishTask();
    });

    this.locks.set(sessionId, starting);
    return starting;
  }

  /** 停止接收新任务，等待在管会话收尾；超过时限返回超时标记。 */
  async drain(timeoutMs = 10_000): Promise<{ sessions: number; timedOut: boolean }> {
    this.closing = true;
    const sessions = [...this.sessions.values()];
    if (sessions.length === 0) return { sessions: 0, timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        Promise.allSettled(sessions.map((session) => session.shutdown())).then(() => "settled" as const),
        timeout,
      ]);
      return { sessions: sessions.length, timedOut: outcome === "timeout" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 进程退出时的同步兜底；不等待扩展钩子。 */
  destroyAll(): void {
    for (const session of this.sessions.values()) session.destroy();
  }
}
