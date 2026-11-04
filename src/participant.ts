import * as vscode from "vscode";
import { ChatService } from "./chatService";
import { ChatMessage, OllamaError } from "./ollamaClient";

const MAX_REFERENCE_CHARS = 12000;
const PROGRESS_INTERVAL_MS = 2000;
const END_OF_LINE = "End Of Line";
const SUMMARY_LINE = /\n\n---\n\*[^\n]*\*\n\nEnd Of Line$/;

function toHistory(context: vscode.ChatContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const content = turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map((part) => part.value.value)
        .join("");
      if (content) {
        messages.push({ role: "assistant", content: content.replace(SUMMARY_LINE, "") });
      }
    }
  }
  return messages;
}

async function referenceText(reference: vscode.ChatPromptReference): Promise<string> {
  const value = reference.value;
  try {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof vscode.Uri) {
      const document = await vscode.workspace.openTextDocument(value);
      return `File ${vscode.workspace.asRelativePath(value)}:\n${document.getText()}`;
    }
    if (value instanceof vscode.Location) {
      const document = await vscode.workspace.openTextDocument(value.uri);
      return `From ${vscode.workspace.asRelativePath(value.uri)}, line ${value.range.start.line + 1}:\n${document.getText(value.range)}`;
    }
  } catch {
    // A reference that cannot be opened is left out of the prompt.
  }
  return "";
}

/**
 * The chat participant API is deprecated and stays only for Local harness
 * compatibility. Put new features in the panel and ChatService.
 */
export function registerParticipant(context: vscode.ExtensionContext, service: ChatService): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    if (request.command === "help") {
      stream.markdown(service.helpText());
      return {};
    }
    if (request.command === "refresh") {
      stream.markdown(`Loaded ${service.skills().length} skill(s).`);
      return {};
    }

    const prompt = request.prompt.trim();
    if (!prompt) {
      stream.markdown("Ask me something about the workspace, code or project workflow.");
      return {};
    }

    const references = (await Promise.all(request.references.map(referenceText))).filter(Boolean).join("\n\n").slice(0, MAX_REFERENCE_CHARS);
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    let lastProgress = 0;
    let started = false;

    try {
      const result = await service.runTurn({
        prompt: references ? `${prompt}\n\nContext:\n${references}` : prompt,
        history: toHistory(chatContext),
        signal: abort.signal,
        events: {
          onStatus: (text) => {
            const now = Date.now();
            if (!started && now - lastProgress >= PROGRESS_INTERVAL_MS) {
              lastProgress = now;
              stream.progress(text);
            }
          },
          onThinking: () => undefined,
          onContent: (text) => {
            started = true;
            stream.markdown(text);
          },
          onTool: (text) => stream.progress(text),
          onNotice: (text) => stream.progress(text),
        },
      });
      stream.markdown(`\n\n---\n*${result.model} · ${result.summary}*\n\n${END_OF_LINE}`);
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (error instanceof OllamaError && error.kind === "model-not-found") {
        stream.button({ command: "astuteChat.selectModel", title: "Select Model" });
      }
      if (error instanceof OllamaError && error.kind === "connection") {
        stream.button({ command: "astuteChat.setServerAddress", title: "Set Server Address" });
      }
      return { errorDetails: { message } };
    } finally {
      cancellation.dispose();
    }
  };

  const participant = vscode.chat.createChatParticipant("astute", handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "icons", "astute-tab.svg");
  context.subscriptions.push(participant);
}
