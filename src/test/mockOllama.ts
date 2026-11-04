import * as http from "http";
import type { AddressInfo } from "net";

export interface MockRequest {
  path: string;
  body: any;
}

export type Responder = (request: MockRequest, response: http.ServerResponse) => void;

export async function startMock(chat: Responder, models = [{ name: "tiny:1b", size: 10 }, { name: "big:8b", size: 90 }]): Promise<{ url: string; requests: MockRequest[]; close(): Promise<void> }> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request = { path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined };
      requests.push(request);
      if (req.url === "/api/version") {
        res.end(JSON.stringify({ version: "9.9.9" }));
      } else if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models }));
      } else if (req.url === "/api/ps") {
        res.end(JSON.stringify({ models: [] }));
      } else if (req.url === "/api/show") {
        res.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], model_info: { "x.context_length": 4096 } }));
      } else {
        chat(request, res);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
