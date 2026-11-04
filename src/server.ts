import * as net from "net";

export const DEFAULT_PORT = 11434;

export interface ServerAddress {
  host: string;
  port: number;
  https: boolean;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function toBaseUrl(address: ServerAddress): string {
  return `${address.https ? "https" : "http"}://${urlHost(address.host)}:${address.port}`;
}

export function toLabel(address: ServerAddress): string {
  return `${urlHost(address.host)}:${address.port}`;
}

export function isLoopback(host: string): boolean {
  const value = host.toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

/** True when prompts would leave this machine without transport encryption. */
export function isInsecureRemote(address: ServerAddress): boolean {
  return !address.https && !isLoopback(address.host);
}

/**
 * Parses what a person types as a server address: an IP, hostname, host:port,
 * bracketed IPv6 or a full http(s) URL. Returns a message when it is invalid.
 */
export function parseServerAddress(input: string): ServerAddress | string {
  const text = input.trim();
  if (!text) {
    return "Enter an IP address or hostname.";
  }

  const candidate = net.isIPv6(text) ? `[${text}]` : text;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return `"${text}" is not a valid address. Try 192.168.1.20:11434.`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http and https are supported.";
  }
  if (url.username || url.password) {
    return "Do not include a username or password in the address.";
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return "Enter only the address and port, without a path.";
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    return "Enter an IP address or hostname.";
  }

  return {
    host,
    port: url.port ? Number(url.port) : DEFAULT_PORT,
    https: url.protocol === "https:",
  };
}
