import * as http from "node:http";
import * as net from "node:net";
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxy(proxy: string): ProxyConfig {
  const parts = proxy.split(":");
  if (parts.length < 2) throw new Error(`Invalid proxy format: ${proxy} (expected ip:port[:username:password])`);

  const host = parts[0];
  const port = parseInt(parts[1]);
  if (isNaN(port)) throw new Error(`Invalid proxy port: ${parts[1]}`);

  const username = parts.length >= 3 ? parts[2] : undefined;
  const password = parts.length >= 4 ? parts.slice(3).join(":") : undefined;

  return { host, port, username, password };
}

export function proxyConfigToUrl(config: ProxyConfig): string {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@`
    : "";
  return `http://${auth}${config.host}:${config.port}`;
}

export function createProxyFetch(proxyConfig: ProxyConfig): typeof globalThis.fetch {
  const proxyUrl = proxyConfigToUrl(proxyConfig);
  const agent = new ProxyAgent(proxyUrl);

  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return undiciFetch(url, { ...init, dispatcher: agent } as UndiciRequestInit) as unknown as Promise<Response>;
  }) as typeof globalThis.fetch;
}

export function connectTcpProxy(
  host: string,
  port: number,
  proxyConfig: ProxyConfig,
): Promise<net.Socket> {
  const { host: proxyHost, port: proxyPort, username, password } = proxyConfig;

  return new Promise((resolve, reject) => {
    const reqOpts: http.RequestOptions = {
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${host}:${port}`,
    };

    if (username) {
      reqOpts.headers = {
        "Proxy-Authorization":
          "Basic " + Buffer.from(`${username}:${password ?? ""}`).toString("base64"),
      };
    }

    const req = http.request(reqOpts);
    req.on("connect", (_res, socket) => resolve(socket));
    req.on("error", reject);
    req.end();
  });
}
