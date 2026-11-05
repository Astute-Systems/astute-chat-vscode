import type { WebSettings } from "./webTools";
import * as vscode from "vscode";
import { DEFAULT_PORT, parseServerAddress, ServerAddress } from "./server";

export interface ChatSettings {
  model: string;
  visionModel: string;
  agentModel: string;
  temperature: number;
  numCtx: number;
  numThread: number;
  keepAlive: string;
  idleTimeoutMs: number;
  thinking: boolean;
  toolsEnabled: boolean;
  allowedCommands: string[];
  debugSkills: boolean;
  languageSkills: boolean;
  /** Set only when the user has turned web tools on. */
  web?: WebSettings;
}

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("astuteChat");
}

export function getServerAddress(): ServerAddress {
  const config = section();
  const hostIsSet = config.inspect<string>("server.host")?.globalValue !== undefined;
  const portIsSet = config.inspect<number>("server.port")?.globalValue !== undefined;
  const legacy = config.inspect<string>("serverUrl")?.globalValue;

  if (legacy && !hostIsSet && !portIsSet) {
    const parsed = parseServerAddress(legacy);
    if (typeof parsed !== "string") {
      return parsed;
    }
  }

  return {
    host: config.get<string>("server.host", "127.0.0.1").trim(),
    port: config.get<number>("server.port", DEFAULT_PORT),
    https: config.get<boolean>("server.https", false),
  };
}

export async function saveServerAddress(address: ServerAddress): Promise<void> {
  const config = section();
  await config.update("server.host", address.host, vscode.ConfigurationTarget.Global);
  await config.update("server.port", address.port, vscode.ConfigurationTarget.Global);
  await config.update("server.https", address.https, vscode.ConfigurationTarget.Global);
}

export async function saveModel(model: string): Promise<void> {
  await section().update("model", model, vscode.ConfigurationTarget.Global);
}

export function getChatSettings(): ChatSettings {
  const config = section();
  return {
    model: config.get<string>("model", ""),
    visionModel: config.get<string>("visionModel", ""),
    agentModel: config.get<string>("agentModel", ""),
    temperature: config.get<number>("temperature", 0.25),
    numCtx: config.get<number>("numCtx", 32768),
    numThread: config.get<number>("numThread", 0),
    keepAlive: config.get<string>("keepAlive", "30m"),
    idleTimeoutMs: config.get<number>("idleTimeoutSeconds", 600) * 1000,
    thinking: config.get<boolean>("thinking", true),
    toolsEnabled: config.get<boolean>("tools.enabled", true),
    allowedCommands: config.get<string[]>("approvals.allowedCommands", []),
    debugSkills: config.get<boolean>("debugSkills", false),
    languageSkills: config.get<boolean>("languageSkills", false),
    web: config.get<boolean>("web.enabled", false)
      ? { searchUrl: config.get<string>("web.searchUrl", "").trim(), allowPrivateAddresses: config.get<boolean>("web.allowPrivateAddresses", false) }
      : undefined,
  };
}
