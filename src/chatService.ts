import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findAgentsFile } from "./agentsFile";
import type { ChangeJournal } from "./changeJournal";
import { boundConversation, summaryPrompt, summaryTokens } from "./chatSummary";
import { chooseToolModel, EngineEvents, EngineResult, estimateTokens, localModels, nextTokenScale, PROMPT_SHARE, resolveModel, runChat, ToolRunner } from "./chatEngine";
import { hostDescription } from "./hostInfo";
import { detectLanguages, LANGUAGE_SKILLS } from "./languageSkills";
import { ChatMode, MCP_RULE, ModeDefinition, MODES, skillReminder, WEB_REMINDER, WEB_RULE } from "./modes";
import { ChatSettings, getChatSettings, getServerAddress, saveModel } from "./config";
import { ChatMessage, ModelDetails, ModelInfo, OllamaClient, OllamaError } from "./ollamaClient";
import { describeLocation, findRepo } from "./repoInfo";
import { isLoopback, toBaseUrl } from "./server";
import { summariseProject } from "./projectSummary";
import { buildSkillSystemPrompt, findSkills, matchSkill, Skill } from "./skillLoader";
import { autoThreadCount, countPhysicalCores } from "./threads";
import type { TerminalLog } from "./terminalLog";
import type { McpManager } from "./mcpManager";
import { MAX_TOOLS } from "./mcpPool";
import { ConfirmChange, createToolRunner, ImageReader } from "./tools";

const READ_IMAGE_PROMPT = "Describe this image in detail. Transcribe all visible text, code and error messages exactly, character for character.";
const VISION_NUM_CTX = 8192;

export interface ImageInput {
  name: string;
  /** Base64 data with no data URI prefix. */
  data: string;
}

/** The model that will answer, which isn't known until the turn starts. */
export interface SummaryTarget {
  model: string;
  /** The real window, sent to Ollama as num_ctx. */
  contextLimit: number;
  /** The window to plan with, allowing for how this model counts tokens. */
  usableLimit: number;
}

export interface HistoryBudget extends SummaryTarget {
  /** The system prompt, tools and current request, before any history. */
  reservedTokens: number;
}

export interface PreparedHistory {
  history: ChatMessage[];
  /** Added to the system prompt, which is never trimmed. */
  systemSection?: string;
  /** Added to this request only, and not stored in the chat. */
  requestNote?: string;
}

export interface TurnRequest {
  images?: ImageInput[];
  prompt: string;
  history?: ChatMessage[];
  /** Chooses the history once the size of everything else is known. Replaces history. */
  prepareHistory?: (budget: HistoryBudget) => Promise<PreparedHistory>;
  /** Ask is the default, so a caller can never change files by accident. */
  mode?: ChatMode;
  confirm?: ConfirmChange;
  journal?: ChangeJournal;
  skill?: Skill;
  signal?: AbortSignal;
  events: EngineEvents;
}

type NoticeEvents = Pick<EngineEvents, "onNotice">;

async function workspaceContext(): Promise<string> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const repo = folders[0] ? await findRepo(folders[0]) : undefined;
  const lines: string[] = [hostDescription(vscode.env.shell), ...describeLocation(folders, repo)];
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") {
    lines.push(`Active file: ${vscode.workspace.asRelativePath(editor.document.uri)}.`);
  }
  return lines.join("\n");
}

function chooseThreads(configured: number): number | undefined {
  if (configured > 0) {
    return configured;
  }
  // Only this machine's CPU can be measured, so remote servers keep their own default.
  if (!isLoopback(getServerAddress().host)) {
    return undefined;
  }
  try {
    return autoThreadCount(countPhysicalCores(fs.readFileSync("/proc/cpuinfo", "utf8")));
  } catch {
    return undefined;
  }
}

/** File names at the workspace root and in src, enough to recognise a project's language. */
async function projectFileNames(): Promise<string[]> {
  const names: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const directory of [folder.uri.fsPath, path.join(folder.uri.fsPath, "src")]) {
      names.push(...(await fs.promises.readdir(directory).catch(() => [])));
    }
  }
  return names;
}

/** Everything both chat surfaces share. The panel and @astute only render it. */
export class ChatService {
  /** Each cloud model is mentioned once, so the warning stays noticeable. */
  private readonly warnedCloud = new Set<string>();
  /** How each model counts tokens against the estimate, learned as it runs. */
  private readonly tokenScales = new Map<string, number>();
  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly terminal?: TerminalLog,
    private readonly mcp?: McpManager,
  ) {}

  client(): OllamaClient {
    return new OllamaClient(toBaseUrl(getServerAddress()));
  }

  skills(): Skill[] {
    return vscode.workspace.isTrusted ? findSkills(vscode.workspace.workspaceFolders ?? []) : [];
  }

  /** Finds a model for Agent mode when the selected one can't use tools. */
  private async pickToolModel(client: OllamaClient): Promise<string | undefined> {
    const installed = await client.listModels();
    const details = await Promise.all(installed.map(async (model) => ({ ...model, capabilities: (await client.showModel(model.name).catch(() => undefined))?.capabilities ?? [] })));
    return chooseToolModel(details);
  }

  /** Uses the chat model if it can see. Otherwise picks the vision setting, or the smallest model with vision. */
  private async pickVisionModel(client: OllamaClient, model: string, details: ModelDetails, configured: string): Promise<{ name: string; helper: boolean }> {
    if (details.capabilities.includes("vision")) {
      return { name: model, helper: false };
    }
    const installed = await client.listModels();
    if (configured) {
      if (!installed.some((entry) => entry.name === configured)) {
        throw new OllamaError("model-not-found", `Vision model "${configured}" isn't installed on this server.`);
      }
      return { name: configured, helper: true };
    }
    for (const entry of localModels(installed).sort((a, b) => a.size - b.size)) {
      const info = await client.showModel(entry.name).catch(() => undefined);
      if (info?.capabilities.includes("vision")) {
        return { name: entry.name, helper: true };
      }
    }
    throw new OllamaError("unsupported", "No installed model can read images. Install one with vision support, such as gemma3, on this server.");
  }

  private imageReader(client: OllamaClient, model: string, details: ModelDetails, events: EngineEvents): ImageReader {
    const settings = getChatSettings();
    return async (name, data, question, signal) => {
      const vision = await this.pickVisionModel(client, model, details, settings.visionModel);
      if (vision.helper) {
        events.onNotice(`${vision.name} is reading ${name}.`);
      }
      const outcome = await client.chat(
        {
          model: vision.name,
          messages: [{ role: "user", content: question ? `${READ_IMAGE_PROMPT}\n\n${question}` : READ_IMAGE_PROMPT, images: [data] }],
          think: false,
          // A helper is unloaded straight away, so it doesn't crowd out the chat model.
          keep_alive: vision.helper ? "0" : settings.keepAlive,
          options: { temperature: 0.1, num_ctx: VISION_NUM_CTX },
        },
        {},
        { signal, idleTimeoutMs: settings.idleTimeoutMs },
      );
      return outcome.content.trim();
    };
  }

  /** The model a turn in this mode would use, and the window to plan with. */
  async summaryTarget(mode: ChatMode): Promise<SummaryTarget> {
    const client = this.client();
    const { model, details } = await this.turnModel(client, MODES[mode], getChatSettings(), { onNotice: () => undefined });
    return this.targetFor(model, details);
  }

  private targetFor(model: string, details: Pick<ModelDetails, "contextLength">): SummaryTarget {
    const { numCtx } = getChatSettings();
    const contextLimit = Math.min(numCtx, details.contextLength ?? numCtx);
    return { model, contextLimit, usableLimit: Math.floor(contextLimit / (this.tokenScales.get(model) ?? 1)) };
  }

  /** Condenses older messages. Returns undefined if that fails, so the chat can carry on. */
  async summarise(messages: ChatMessage[], earlier: string | undefined, target: SummaryTarget, signal?: AbortSignal): Promise<string | undefined> {
    const settings = getChatSettings();
    const client = this.client();
    try {
      const intro = `${summaryPrompt(summaryTokens(target.usableLimit))}\n\n${earlier ? `Earlier notes:\n${earlier}\n\n` : ""}`;
      const room = Math.floor(target.usableLimit * PROMPT_SHARE) - estimateTokens(intro);
      const outcome = await client.chat(
        {
          model: target.model,
          messages: [{ role: "user", content: `${intro}${boundConversation(messages, room)}` }],
          think: false,
          keep_alive: settings.keepAlive,
          options: { temperature: 0.1, num_ctx: target.contextLimit },
        },
        {},
        { signal, idleTimeoutMs: settings.idleTimeoutMs },
      );
      return outcome.content.trim() || undefined;
    } catch (error) {
      this.log.warn(`Could not summarise the chat: ${String(error)}`);
      return undefined;
    }
  }

  /** Saves the model and frees the previous one, so two models don't compete for memory. */
  async switchModel(model: string): Promise<void> {
    const previous = getChatSettings().model;
    await saveModel(model);
    if (previous && previous !== model && isLoopback(getServerAddress().host)) {
      await this.client()
        .unload(previous)
        .catch((error: unknown) => this.log.warn(`Could not unload ${previous}: ${String(error)}`));
    }
  }

  /** Logs how each tool ended. Only the first line, because output can hold private details. */
  private tracedTools(tools: ToolRunner): ToolRunner {
    return {
      definitions: tools.definitions,
      run: async (call, signal) => {
        const result = await tools.run(call, signal);
        this.log.info(`Tool ${call.function.name}: ${result.split("\n")[0].slice(0, 120)}`);
        return result;
      },
    };
  }

  /** Workspace skills, plus the built-in ones that a workspace skill hasn't replaced. */
  commandSkills(): Skill[] {
    const skills = this.skills();
    const builtIn = Object.entries(LANGUAGE_SKILLS)
      .filter(([name]) => !skills.some((skill) => skill.name === name))
      .map(([name, language]) => ({ name, title: language.title, description: `Built-in ${language.title} guidance.`, keywords: [], filePath: "", content: language.content }));
    return [...skills, ...builtIn];
  }

  /** A mistyped skill must not reach the model, which would answer without it. */
  unknownCommandText(name: string): string {
    const names = this.commandSkills().map((skill) => `\`/${skill.name}\``).join(", ");
    return `There's no skill or command called \`/${name}\`, so nothing was sent. Skills: ${names}. Run \`/help\` for commands, or \`/refresh\` if you've just added a skill. To send this as a message, put a word before it.`;
  }

  helpText(): string {
    const skills = this.skills();
    const list = skills.length ? skills.map((skill) => `- \`/${skill.name}\`: ${skill.description}`).join("\n") : vscode.workspace.isTrusted ? "No skills found in `.astute/skills`." : "Skills are disabled until you trust this workspace.";
    return [
      "**Commands**",
      "",
      "- `/help`: show this list",
      "- `/refresh`: reload workspace skills",
      "- `/clear`: start a new chat",
      "- `/ask`, `/plan`, `/agent`: switch mode, optionally followed by your request",
      "- `/<skill-name>`: use that skill for this message, optionally followed by your request. Add a mode first with `/agent /<skill-name>`.",
      "",
      "**Modes**",
      "",
      "- **Ask** answers questions and can read the workspace.",
      "- **Plan** researches the workspace and writes a plan. It can't change anything.",
      "- **Agent** changes files and runs commands. You approve each change.",
      "",
      "**Skills**",
      "",
      list,
      "",
      "`/c`, `/cpp` and `/python` use the built-in language guidance.",
      "",
      "A skill also starts automatically when your question matches it. Select code in the editor to include it in your next message.",
    ].join("\n");
  }

  private async pickModel(client: OllamaClient, configured: string, events: NoticeEvents): Promise<string> {
    const installed: ModelInfo[] = await client.listModels();
    if (installed.length === 0) {
      throw new OllamaError("model-not-found", "This Ollama server has no models. Run `ollama pull <model>` on a connected machine, or copy its `~/.ollama/models` folder to the server.");
    }
    const { name, reason } = resolveModel(configured, installed);
    if (!name && !configured.trim()) {
      throw new OllamaError("model-not-found", "No local model is installed. Run `ollama pull <model>`, or choose a cloud model in the model list if you're happy for your prompts and code to go to its server.");
    }
    if (!name) {
      throw new OllamaError("model-not-found", `Model "${configured}" isn't installed on this server. Choose one of: ${installed.map((model) => model.name).join(", ")}.`);
    }
    if (reason === "default") {
      events.onNotice(`Using ${name}, the smallest local model. You can choose another in the model list.`);
    }
    return name;
  }

  private async turnModel(client: OllamaClient, mode: ModeDefinition, settings: ChatSettings, events: NoticeEvents): Promise<{ model: string; details: ModelDetails }> {
    let model = await this.pickModel(client, mode.requiresTools && settings.agentModel ? settings.agentModel : settings.model, events);
    let details: ModelDetails = await client.showModel(model).catch(() => ({ capabilities: [], contextLength: undefined }));
    if (mode.requiresTools && !details.capabilities.includes("tools")) {
      const replacement = await this.pickToolModel(client);
      if (replacement) {
        events.onNotice(`Using ${replacement} for Agent mode, because ${model} can't use tools.`);
        model = replacement;
        details = await client.showModel(model).catch(() => details);
      }
    }
    return { model, details };
  }

  async runTurn(request: TurnRequest): Promise<EngineResult & { model: string; imageText: string }> {
    const settings = getChatSettings();
    const mode = MODES[request.mode ?? "ask"];
    const client = this.client();
    const { model, details } = await this.turnModel(client, mode, settings, request.events);

    if ((await client.listModels().catch(() => [])).some((entry) => entry.name === model && entry.remote) && !this.warnedCloud.has(model)) {
      this.warnedCloud.add(model);
      request.events.onNotice(`${model} is a cloud model, so your prompts and code leave this computer.`);
    }

    const running = await client.loadedModels().catch(() => []);
    const others = running.filter((entry) => entry.name !== model).map((entry) => entry.name);
    if (others.length) {
      request.events.onNotice(`Also loaded: ${others.join(", ")}. Models running at the same time slow each other down.`);
    }

    const skills = this.skills();
    const skill = request.skill ?? matchSkill(request.prompt, skills);
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sections = [buildSkillSystemPrompt(skills, settings.debugSkills), mode.instructions, await workspaceContext(), vscode.workspace.isTrusted && projectRoot ? summariseProject(projectRoot) : ""];
    if (skill) {
      sections.push(`Follow this skill for the current request:\n${skill.title}\n${skill.content}`);
      this.log.info(`Using the ${skill.title} skill.`);
      if (request.skill) {
        request.events.onNotice(`Read the ${skill.title} skill${skill.filePath ? ` from ${vscode.workspace.asRelativePath(skill.filePath)}` : ""}.`);
      }
    }
    if (settings.languageSkills) {
      const activeFile = vscode.window.activeTextEditor?.document.fileName;
      for (const language of detectLanguages(request.prompt, activeFile, await projectFileNames())) {
        const builtIn = LANGUAGE_SKILLS[language];
        // A workspace skill with the same name replaces the built-in one.
        const own = skills.find((candidate) => candidate.name === language);
        if (!own || own !== skill) {
          sections.push(`Follow these ${builtIn.title} rules:\n${own?.content ?? builtIn.content}`);
          this.log.info(`Using the ${builtIn.title} skill${own ? " from the workspace" : ""}.`);
        }
      }
    }
    if (vscode.workspace.isTrusted) {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      const agents = await findAgentsFile(roots, vscode.window.activeTextEditor?.document.fileName);
      if (agents) {
        sections.push(`Follow these project instructions from AGENTS.md:\n${agents.content}`);
        const name = vscode.workspace.asRelativePath(agents.file);
        this.log.info(agents.shortened ? `Using the first part of ${name}, because it's long.` : `Using ${name}.`);
      }
    }

    const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const modelHasTools = details.capabilities.includes("tools");
    if (mode.requiresTools) {
      if (!vscode.workspace.isTrusted) {
        throw new OllamaError("unsupported", "Agent mode is off until you trust this workspace.");
      }
      if (!hasFolder) {
        throw new OllamaError("unsupported", "Agent mode needs an open folder.");
      }
      if (!settings.toolsEnabled) {
        throw new OllamaError("unsupported", "Agent mode needs astuteChat.tools.enabled to be on.");
      }
      if (!modelHasTools) {
        throw new OllamaError("unsupported", `${model} doesn't support tools, so it can't run Agent mode. Choose another model.`);
      }
    }
    const readImage = this.imageReader(client, model, details, request.events);
    const images = request.images ?? [];
    const directImages = details.capabilities.includes("vision") ? images.map((image) => image.data) : [];
    let imageText = "";
    if (images.length && !directImages.length) {
      for (const image of images) {
        request.events.onStatus(`Reading ${image.name}…`);
        imageText += `\n\nImage ${image.name} shows:\n${await readImage(image.name, image.data, request.prompt, request.signal)}`;
      }
    }

    const useTools = settings.toolsEnabled && vscode.workspace.isTrusted && modelHasTools && hasFolder;
    if (!useTools && mode.id === "plan") {
      request.events.onNotice("This plan can't use workspace files, so it relies only on what you tell it.");
    }
    const mcpTools = useTools && mode.canChange && this.mcp ? await this.mcp.definitions() : undefined;
    for (const server of mcpTools?.failed ?? []) {
      request.events.onNotice(`MCP server ${server} didn't start. Astute Chat: Show Logs has the details.`);
    }
    if (mcpTools?.skipped.length) {
      request.events.onNotice(`Only ${MAX_TOOLS} MCP tools can be offered to a model, so ${mcpTools.skipped.length} were left out. Astute Chat: Show Logs lists them.`);
    }
    if (mcpTools?.tools.length) {
      sections.push(MCP_RULE);
    }
    if (useTools && settings.web) {
      sections.push(WEB_RULE);
    }
    const target = this.targetFor(model, details);
    const { contextLimit } = target;
    this.log.info(`Chat: mode=${mode.id} model=${model} num_ctx=${contextLimit} tools=${useTools} skill=${skill?.name ?? "none"} folder=${path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "")}`);

    const tools = useTools ? this.tracedTools(createToolRunner(mode.id, {
          confirm: request.confirm,
          readImage,
          journal: request.journal,
          readTerminal: this.terminal ? () => this.terminal?.describe() ?? "" : undefined,
          mcp: this.mcp,
          mcpTools: mcpTools?.tools,
          web: settings.web,
          skills,
        })) : undefined;
    const reminders = `${useTools ? (mode.requestReminder ?? "") : ""}${useTools && settings.web ? WEB_REMINDER : ""}${request.skill ? skillReminder(request.skill.title) : ""}`;
    const systemPrompt = sections.filter(Boolean).join("\n\n");
    const prepared = request.prepareHistory
      ? await request.prepareHistory({
          ...target,
          reservedTokens: estimateTokens(systemPrompt) + estimateTokens(`${request.prompt}${imageText}${reminders}`) + (tools ? estimateTokens(JSON.stringify(tools.definitions)) : 0),
        })
      : { history: request.history ?? [] };

    const result = await runChat({
      client,
      model,
      messages: [{ role: "system", content: [systemPrompt, prepared.systemSection].filter(Boolean).join("\n\n") }, ...prepared.history, { role: "user", content: `${request.prompt}${imageText}${prepared.requestNote ?? ""}${reminders}`, images: directImages.length ? directImages : undefined }],
      contextLimit,
      tokenScale: this.tokenScales.get(model),
      numThread: chooseThreads(settings.numThread),
      temperature: settings.temperature,
      keepAlive: settings.keepAlive,
      idleTimeoutMs: settings.idleTimeoutMs,
      think: settings.thinking && details.capabilities.includes("thinking"),
      tools,
      maxToolRounds: mode.maxToolRounds,
      retryWithoutTools: mode.retryPrompt,
      fixFailures: mode.fixPrompt,
      signal: request.signal,
      events: request.events,
    });
    this.tokenScales.set(model, nextTokenScale(this.tokenScales.get(model) ?? 1, result.tokenRatio));
    this.log.info(`Chat finished: ${result.summary}`);
    return { ...result, model, imageText };
  }
}
