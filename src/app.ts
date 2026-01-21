/**
 * 应用入口组装
 *
 * 负责创建和配置 HTTP 服务器，注册所有路由。
 * 核心职责：
 * 1. 路由分发 (Router)：将请求分发给对应的 Handler。
 * 2. 中间件集成：集成日志 (Logging)、CORS、鉴权 (Auth) 等中间件。
 * 3. 管理 API：提供系统配置、密钥池管理、仪表盘统计等管理接口。
 * 4. 静态资源服务：服务前端 SPA 页面和静态资源。
 */

import { handleChatCompletions } from "./handlers/chat.ts";
import { handleImagesGenerations } from "./handlers/images.ts";
import { handleImagesEdits } from "./handlers/edits.ts";
import { handleImagesBlend } from "./handlers/blend.ts";
import {
  addLogStream,
  debug,
  error,
  getRecentLogs,
  info,
  type LogEntry,
  LogLevel,
} from "./core/logger.ts";
import { type RequestContext, withLogging } from "./middleware/logging.ts";
import * as Config from "./config/manager.ts";
import {
  getAppVersion,
  getKeyPool,
  getRuntimeConfig,
  type ProviderTaskDefaults,
  replaceRuntimeConfig,
  type RuntimeConfig,
  type RuntimeProviderConfig,
  setProviderEnabled,
  setProviderTaskDefaults,
  type SystemConfig,
  updateKeyPool,
} from "./config/manager.ts";
import { providerRegistry } from "./providers/registry.ts";
console.log("Loading app.ts...");
import { promptOptimizerService } from "./core/prompt-optimizer.ts";
import { storageService } from "./core/storage.ts";
import type { ProviderName } from "./providers/base.ts";
import { join } from "@std/path";

// 调试日志：确保 promptOptimizerService 已加载
console.log("[App] promptOptimizerService loaded:", !!promptOptimizerService);

// GitHub 更新检查缓存
interface UpdateCache {
  data: unknown;
  timestamp: number;
}
let updateCache: UpdateCache | null = null;
const UPDATE_CACHE_TTL = 3600 * 1000; // 1 hour
const CACHE_FILE_PATH = "./data/update_cache.json";

// 从磁盘加载缓存
async function loadCacheFromDisk() {
  try {
    const text = await Deno.readTextFile(CACHE_FILE_PATH);
    const cache = JSON.parse(text) as UpdateCache;
    if (cache && cache.timestamp) {
      updateCache = cache;
      info("Update", "Loaded update cache from disk");
    }
  } catch (_e) {
    // Ignore error (file not found or invalid)
  }
}

// 保存缓存到磁盘
async function saveCacheToDisk(cache: UpdateCache) {
  try {
    await Deno.writeTextFile(CACHE_FILE_PATH, JSON.stringify(cache));
  } catch (e) {
    error("Update", `Failed to save cache to disk: ${e}`);
  }
}

async function updateDockerComposePort(port: number) {
  const composePath = join(Deno.cwd(), "docker-compose.yml");

  try {
    const content = await Deno.readTextFile(composePath);
    const lines = content.split(/\r?\n/);
    let changed = false;
    let matched = false;

    const updatedLines = lines.map((line) => {
      const envMatch = line.match(/^(\s*-\s*PORT\s*=\s*)(\d+)(\s*)$/);
      if (envMatch) {
        changed = true;
        matched = true;
        return `${envMatch[1]}${port}${envMatch[3]}`;
      }

      const quotedPortMatch = line.match(/^(\s*-\s*")\s*(\d+)\s*:\s*(\d+)\s*("\s*)$/);
      if (quotedPortMatch) {
        changed = true;
        matched = true;
        return `${quotedPortMatch[1]}${port}:${port}${quotedPortMatch[4]}`;
      }

      const plainPortMatch = line.match(/^(\s*-\s*)(\d+)\s*:\s*(\d+)\s*$/);
      if (plainPortMatch) {
        changed = true;
        matched = true;
        return `${plainPortMatch[1]}${port}:${port}`;
      }

      return line;
    });

    if (changed) {
      await Deno.writeTextFile(composePath, updatedLines.join("\n"));
    }

    if (!matched) {
      return { updated: false, path: composePath, error: "未找到PORT或端口映射配置" };
    }

    return { updated: changed, path: composePath };
  } catch (e) {
    return { updated: false, path: composePath, error: e instanceof Error ? e.message : String(e) };
  }
}

type RestartDockerComposeAttempt = {
  cmd: string;
  args: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type RestartDockerComposeResult =
  | {
    ok: true;
    cmd: string;
    args: string[];
    code: number;
    stdout: string;
    stderr: string;
    attempted: RestartDockerComposeAttempt[];
  }
  | {
    ok: false;
    error: string;
    attempted: RestartDockerComposeAttempt[];
  };

async function dockerSocketRequest(
  method: string,
  path: string,
  body?: unknown,
  options?: { timeoutMs?: number },
): Promise<{ status: number; bodyText: string }> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const socketPath = "/var/run/docker.sock";
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn.close();
    } catch (e) {
      void e;
    }
  }, timeoutMs);

  try {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const bodyBytes = encoder.encode(bodyText);

    const headerLines: string[] = [
      `${method} ${path} HTTP/1.1`,
      "Host: docker",
      "Connection: close",
    ];

    if (body === undefined) {
      headerLines.push("Content-Length: 0");
    } else {
      headerLines.push("Content-Type: application/json");
      headerLines.push(`Content-Length: ${bodyBytes.byteLength}`);
    }

    const requestHead = headerLines.join("\r\n") + "\r\n\r\n";
    await conn.write(encoder.encode(requestHead));
    if (bodyBytes.byteLength > 0) {
      await conn.write(bodyBytes);
    }

    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(64 * 1024);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }

    const raw = decoder.decode(concatChunks(chunks));
    const sep = "\r\n\r\n";
    const idx = raw.indexOf(sep);
    const head = idx >= 0 ? raw.slice(0, idx) : raw;
    let bodyOut = idx >= 0 ? raw.slice(idx + sep.length) : "";

    const headLines = head.split("\r\n");
    const statusLine = headLines[0] || "";
    const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
    const status = match ? Number(match[1]) : 0;

    const headers: Record<string, string> = {};
    for (const line of headLines.slice(1)) {
      const p = line.indexOf(":");
      if (p <= 0) continue;
      const key = line.slice(0, p).trim().toLowerCase();
      const value = line.slice(p + 1).trim();
      headers[key] = value;
    }

    const transferEncoding = headers["transfer-encoding"] || "";
    if (transferEncoding.toLowerCase().includes("chunked")) {
      bodyOut = decodeChunkedBody(bodyOut);
    }

    return { status, bodyText: bodyOut };
  } catch (e) {
    if (timedOut) {
      throw new Error(`Docker Socket 请求超时（${timeoutMs}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch (e) {
      void e;
    }
  }
}

function decodeChunkedBody(body: string) {
  let i = 0;
  let out = "";
  while (i < body.length) {
    const lineEnd = body.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const sizeLine = body.slice(i, lineEnd).trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) break;
    i = lineEnd + 2;
    if (size === 0) break;
    out += body.slice(i, i + size);
    i = i + size + 2;
  }
  return out;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const firstObj = text.indexOf("{");
    const firstArr = text.indexOf("[");
    const start = firstObj >= 0 && firstArr >= 0
      ? Math.min(firstObj, firstArr)
      : (firstObj >= 0 ? firstObj : firstArr);

    const lastObj = text.lastIndexOf("}");
    const lastArr = text.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);

    if (start >= 0 && end > start) {
      const sliced = text.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        return null;
      }
    }

    return null;
  }
}

function getComposeProjectFromInspect(inspect: Record<string, unknown>): string | null {
  const config = (inspect.Config as Record<string, unknown> | undefined) || {};
  const labels = config.Labels;
  if (!labels || typeof labels !== "object") return null;
  const project = (labels as Record<string, unknown>)["com.docker.compose.project"];
  return typeof project === "string" && project.length > 0 ? project : null;
}

function getComposeProjectFromLabels(labels: unknown): string | null {
  if (!labels || typeof labels !== "object") return null;
  const project = (labels as Record<string, unknown>)["com.docker.compose.project"];
  return typeof project === "string" && project.length > 0 ? project : null;
}

function getComposeServiceFromInspect(inspect: Record<string, unknown>): string | null {
  const config = (inspect.Config as Record<string, unknown> | undefined) || {};
  const labels = config.Labels;
  if (!labels || typeof labels !== "object") return null;
  const service = (labels as Record<string, unknown>)["com.docker.compose.service"];
  return typeof service === "string" && service.length > 0 ? service : null;
}

function getImageFromInspect(inspect: Record<string, unknown>): string | null {
  const config = (inspect.Config as Record<string, unknown> | undefined) || {};
  const image = config.Image;
  return typeof image === "string" && image.length > 0 ? image : null;
}

function normalizeDockerNames(names: unknown): string[] {
  const raw = Array.isArray(names) ? (names as unknown[]) : [];
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== "string") continue;
    out.push(n.startsWith("/") ? n.slice(1) : n);
  }
  return out;
}

function isOldContainerName(names: string[]): boolean {
  const re = /-old-\d+$/;
  return names.some((n) => re.test(n));
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

async function inspectSelfContainer(): Promise<
  | { inspect: Record<string, unknown>; containerId: string; ref: string }
  | null
> {
  const candidates = compactStrings([
    Deno.env.get("HOSTNAME"),
    "proxy",
    "img-router-proxy",
  ]);

  for (const ref of candidates) {
    try {
      const resp = await dockerSocketRequest("GET", `/containers/${ref}/json`, undefined, {
        timeoutMs: 10_000,
      });
      if (resp.status !== 200) continue;
      const parsed = tryParseJson(resp.bodyText);
      if (!parsed || typeof parsed !== "object") continue;
      const inspect = parsed as Record<string, unknown>;
      const id = typeof inspect.Id === "string" && inspect.Id.length > 0 ? inspect.Id : "";
      if (!id) continue;
      return { inspect, containerId: id, ref };
    } catch (e) {
      void e;
    }
  }

  return null;
}

async function cleanupOldContainersInScope(
  scope: {
    project?: string | null;
    image?: string | null;
    excludeIds?: Set<string>;
    baseNames?: string[];
  },
): Promise<{ removedIds: string[]; attempted: number; matched: number }> {
  const removedIds: string[] = [];
  let attempted = 0;
  let matched = 0;

  let listResp: { status: number; bodyText: string };
  try {
    listResp = await dockerSocketRequest("GET", "/containers/json?all=1", undefined, {
      timeoutMs: 10_000,
    });
  } catch (e) {
    info(
      "Docker",
      `Old container list failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { removedIds, attempted, matched };
  }
  if (listResp.status !== 200) {
    info(
      "Docker",
      `Old container list failed: status=${listResp.status} body=${
        listResp.bodyText.slice(0, 200)
      }`,
    );
    return { removedIds, attempted, matched };
  }

  const parsed = tryParseJson(listResp.bodyText);
  if (!Array.isArray(parsed)) {
    info(
      "Docker",
      `Old container list parse failed: body=${listResp.bodyText.slice(0, 200)}`,
    );
    return { removedIds, attempted, matched };
  }
  const list = parsed as Array<Record<string, unknown>>;
  const excludeIds = scope.excludeIds ?? new Set<string>();
  const baseNames = (scope.baseNames ?? []).filter((s) => typeof s === "string" && s.length > 0);
  const project = scope.project ?? null;
  const image = scope.image ?? null;

  for (const c of list) {
    const id = typeof c.Id === "string" ? c.Id : "";
    if (!id || excludeIds.has(id)) continue;

    const labelsProject = getComposeProjectFromLabels(c.Labels);
    const names = normalizeDockerNames(c.Names);
    if (!isOldContainerName(names)) continue;

    const matchByProject = !!project && labelsProject === project;
    const matchByNamePrefix = baseNames.length > 0 &&
      baseNames.some((base) => names.some((n) => n.startsWith(`${base}-old-`)));
    const matchByImage = !!image && typeof c.Image === "string" && c.Image === image;
    if (!matchByProject && !matchByNamePrefix) continue;
    if (!matchByProject && image && !matchByImage) continue;

    matched++;

    try {
      attempted++;
      const delResp = await dockerSocketRequest(
        "DELETE",
        `/containers/${id}?force=1`,
        undefined,
        {
          timeoutMs: 20_000,
        },
      );
      if (delResp.status === 204) {
        removedIds.push(id);
      } else {
        info(
          "Docker",
          `Old container delete failed: status=${delResp.status} id=${id} name=${
            names[0] ?? ""
          } body=${delResp.bodyText.slice(0, 200)}`,
        );
      }
    } catch (e) {
      info(
        "Docker",
        `Old container delete exception: id=${id} name=${names[0] ?? ""} err=${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return { removedIds, attempted, matched };
}

export async function cleanupOldContainers(): Promise<void> {
  if (Deno.build.os === "windows") return;

  try {
    const self = await inspectSelfContainer();
    if (!self) {
      info("Docker", "Old container cleanup skipped: cannot inspect self container");
      return;
    }

    const inspect = self.inspect;
    const project = getComposeProjectFromInspect(inspect);
    const service = getComposeServiceFromInspect(inspect);
    const image = getImageFromInspect(inspect);

    const currentNameRaw = typeof inspect.Name === "string" ? inspect.Name : "";
    const currentName = currentNameRaw.startsWith("/") ? currentNameRaw.slice(1) : currentNameRaw;
    const baseNames = compactStrings([currentName, service]);

    const result = await cleanupOldContainersInScope({
      project,
      image,
      excludeIds: new Set([self.containerId]),
      baseNames,
    });

    info(
      "Docker",
      `Old container cleanup done: ref=${self.ref} id=${self.containerId.slice(0, 12)} project=${
        project ?? ""
      } service=${service ?? ""} image=${image ?? ""} base=${
        baseNames.join(",")
      } matched=${result.matched} attempted=${result.attempted} removed=${result.removedIds.length}`,
    );
  } catch (e) {
    info(
      "Docker",
      `Old container cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function scheduleCleanupAfterRestart(detail: unknown) {
  if (Deno.build.os === "windows") return;

  const d = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const oldId = typeof d.oldContainerId === "string" ? d.oldContainerId : "";
  const newId = typeof d.newId === "string" ? d.newId : "";

  setTimeout(async () => {
    if (newId) {
      const start = Date.now();
      const waitMs = 30_000;
      while (Date.now() - start < waitMs) {
        try {
          const r = await dockerSocketRequest("GET", `/containers/${newId}/json`, undefined, {
            timeoutMs: 10_000,
          });
          if (r.status === 200) {
            const ins = JSON.parse(r.bodyText) as Record<string, unknown>;
            const state = (ins.State as Record<string, unknown> | undefined) || {};
            if (state && typeof state === "object" && state.Running === true) break;
          }
        } catch (e) {
          void e;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    try {
      await cleanupOldContainers();
    } catch (e) {
      info(
        "Docker",
        `Old container cleanup after restart failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (oldId) {
      try {
        const del = await dockerSocketRequest(
          "DELETE",
          `/containers/${oldId}?force=1`,
          undefined,
          { timeoutMs: 30_000 },
        );
        info(
          "Docker",
          `Old self delete after restart: status=${del.status} id=${oldId.slice(0, 12)}`,
        );
      } catch (e) {
        info(
          "Docker",
          `Old self delete after restart failed: id=${oldId.slice(0, 12)} err=${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }, 8_000);
}

function concatChunks(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function upsertPortEnv(env: string[] | undefined, port: number) {
  const list = Array.isArray(env) ? [...env] : [];
  const idx = list.findIndex((s) => s.startsWith("PORT="));
  const next = `PORT=${port}`;
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  return list;
}

async function restartViaDockerSocket(
  containerName: string,
  port: number,
): Promise<{ ok: true; detail: unknown } | { ok: false; error: string; detail?: unknown }> {
  try {
    const ping = await dockerSocketRequest("GET", "/_ping", undefined, { timeoutMs: 5_000 });
    if (ping.status !== 200 || !ping.bodyText.includes("OK")) {
      return { ok: false, error: "Docker Socket 不可用" };
    }

    const selfId = Deno.env.get("HOSTNAME") || containerName;
    const inspectResp = await dockerSocketRequest(
      "GET",
      `/containers/${selfId}/json`,
      undefined,
      { timeoutMs: 10_000 },
    );
    if (inspectResp.status !== 200) {
      return {
        ok: false,
        error: `无法 inspect 当前容器: ${selfId}`,
        detail: inspectResp.bodyText,
      };
    }
    const inspect = JSON.parse(inspectResp.bodyText) as Record<string, unknown>;

    const project = getComposeProjectFromInspect(inspect);
    const service = getComposeServiceFromInspect(inspect);
    const image = getImageFromInspect(inspect);
    const containerId = typeof inspect.Id === "string" && inspect.Id.length > 0
      ? inspect.Id
      : selfId;

    const currentNameRaw = typeof inspect.Name === "string" ? inspect.Name : "";
    const currentName = currentNameRaw.startsWith("/") ? currentNameRaw.slice(1) : currentNameRaw;
    const oldName = `${currentName || selfId}-old-${Date.now()}`;

    try {
      const baseNames = compactStrings([currentName, service]);
      await cleanupOldContainersInScope({
        project,
        image,
        excludeIds: new Set([containerId]),
        baseNames,
      });
    } catch (e) {
      void e;
    }

    const renameResp = await dockerSocketRequest(
      "POST",
      `/containers/${selfId}/rename?name=${encodeURIComponent(oldName)}`,
      undefined,
      { timeoutMs: 10_000 },
    );
    if (renameResp.status !== 204) {
      return { ok: false, error: "重命名旧容器失败", detail: renameResp.bodyText };
    }

    await dockerSocketRequest(
      "POST",
      `/containers/${selfId}/update`,
      { RestartPolicy: { Name: "no" } },
      { timeoutMs: 10_000 },
    );

    const config = (inspect.Config as Record<string, unknown> | undefined) || {};
    const hostConfig = (inspect.HostConfig as Record<string, unknown> | undefined) || {};

    if (!image) {
      return { ok: false, error: "无法从 inspect 获取 Image" };
    }

    const env = upsertPortEnv(config.Env as string[] | undefined, port);
    const portKey = `${port}/tcp`;

    const createBody: Record<string, unknown> = {
      Image: image,
      Env: env,
      ExposedPorts: { [portKey]: {} },
      Labels: config.Labels ?? undefined,
      WorkingDir: config.WorkingDir ?? undefined,
      Cmd: config.Cmd ?? undefined,
      Entrypoint: config.Entrypoint ?? undefined,
      HostConfig: {
        Binds: hostConfig.Binds ?? undefined,
        RestartPolicy: hostConfig.RestartPolicy ?? undefined,
        NetworkMode: hostConfig.NetworkMode ?? undefined,
        PortBindings: { [portKey]: [{ HostPort: String(port) }] },
      },
    };

    const createResp = await dockerSocketRequest(
      "POST",
      `/containers/create?name=${encodeURIComponent(currentName || containerName)}`,
      createBody,
      { timeoutMs: 30_000 },
    );
    if (createResp.status !== 201) {
      return { ok: false, error: "创建容器失败", detail: createResp.bodyText };
    }
    const created = JSON.parse(createResp.bodyText) as Record<string, unknown>;
    const newId = typeof created.Id === "string" ? created.Id : "";
    if (!newId) {
      return { ok: false, error: "创建容器成功但未返回 Id", detail: created };
    }

    const startResp = await dockerSocketRequest("POST", `/containers/${newId}/start`, undefined, {
      timeoutMs: 20_000,
    });
    if (startResp.status !== 204) {
      return { ok: false, error: "启动容器失败", detail: startResp.bodyText };
    }

    return {
      ok: true,
      detail: {
        oldContainerId: containerId,
        oldContainerName: oldName,
        newContainerName: currentName || containerName,
        newId,
        port,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function restartDockerCompose(port: number): Promise<RestartDockerComposeResult> {
  const decoder = new TextDecoder();
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "docker", args: ["compose", "up", "-d", "--remove-orphans"] },
    { cmd: "docker-compose", args: ["up", "-d", "--remove-orphans"] },
  ];

  const attempted: RestartDockerComposeAttempt[] = [];

  if (Deno.build.os !== "windows") {
    const socket = await restartViaDockerSocket("img-router-proxy", port);
    if (socket.ok) {
      return {
        ok: true,
        cmd: "docker.sock",
        args: ["rolling-recreate", "self", String(port)],
        code: 0,
        stdout: JSON.stringify(socket.detail),
        stderr: "",
        attempted,
      };
    }
    attempted.push({
      cmd: "docker.sock",
      args: ["rolling-recreate", "self", String(port)],
      error: socket.error,
    });
  }

  for (const a of attempts) {
    try {
      const command = new Deno.Command(a.cmd, {
        args: a.args,
        cwd: Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      });
      const out = await command.output();
      const stdout = decoder.decode(out.stdout);
      const stderr = decoder.decode(out.stderr);
      attempted.push({ cmd: a.cmd, args: a.args, code: out.code, stdout, stderr });

      if (out.code === 0) {
        return {
          ok: true,
          cmd: a.cmd,
          args: a.args,
          code: out.code,
          stdout,
          stderr,
          attempted,
        };
      }
    } catch (e) {
      attempted.push({
        cmd: a.cmd,
        args: a.args,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: false,
    error:
      "无法执行重启。docker 命令不可用，且 Docker Socket 方案也失败。请确认 docker-compose.yml 已挂载 /var/run/docker.sock 并重新创建容器。",
    attempted,
  };
}

/**
 * 处理更新检查请求
 * 通过后端代理请求 GitHub API，避免前端直接请求导致的 CORS 和限流问题
 */
async function handleUpdateCheck(req: Request): Promise<Response> {
  const now = Date.now();
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  // 尝试加载磁盘缓存（如果内存缓存为空）
  if (!updateCache) {
    await loadCacheFromDisk();
  }

  // 检查有效缓存 (非强制刷新且缓存有效)
  if (!force && updateCache && (now - updateCache.timestamp < UPDATE_CACHE_TTL)) {
    return new Response(JSON.stringify(updateCache.data), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await fetch("https://api.github.com/repos/lianwusuoai/img-router/releases/latest", {
      headers: {
        "User-Agent": req.headers.get("User-Agent") || "img-router/1.0",
        "Accept": "application/vnd.github.v3+json",
      },
    });

    if (!res.ok) {
      // 403 限流或其他错误
      info("Update", `GitHub API failed (${res.status}), trying fallback.`);

      // 如果有缓存（即使过期），作为降级返回
      if (updateCache) {
        info("Update", "Serving stale cache due to API error.");
        return new Response(
          JSON.stringify({
            ...(updateCache.data as object),
            _cached: true,
            _stale: true,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // 明确返回限流错误，状态码 200 以便前端解析
      return new Response(
        JSON.stringify({
          error: "rate_limit",
          message: `GitHub API error: ${res.status}`,
        }),
        {
          status: res.status === 403 ? 429 : 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const data = await res.json();
    const newCache = { data, timestamp: now };
    updateCache = newCache;
    await saveCacheToDisk(newCache); // 持久化

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    error("Update", `Check update failed: ${e}`);
    // 降级：如果有缓存，返回陈旧缓存
    if (updateCache) {
      return new Response(
        JSON.stringify({
          ...(updateCache.data as object),
          _cached: true,
          _stale: true,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function isProviderName(name: string): name is ProviderName {
  return providerRegistry.getNames().includes(name as ProviderName);
}

// CORS 响应头配置
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

// 密钥池更新请求载荷定义
interface KeyPoolUpdatePayload {
  provider: string;
  action: "add" | "batch_add" | "update" | "delete";
  keyItem?: { key: string; name?: string; [key: string]: unknown };
  id?: string;
  keys?: string;
  format?: "csv" | "text" | "auto";
}

/**
 * 鉴权中间件
 *
 * 验证 Authorization Header 是否包含有效的 Global Access Key。
 * 仅当系统配置了 GLOBAL_ACCESS_KEY 时才生效。
 */
function checkAuth(req: Request): boolean {
  const runtime = getRuntimeConfig();
  const runtimeKey = runtime.system?.globalAccessKey;
  const globalKey = typeof runtimeKey === "string" && runtimeKey.length > 0
    ? runtimeKey
    : Config.GLOBAL_ACCESS_KEY;
  if (!globalKey) return true;
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const [type, token] = auth.split(" ");
  if (type !== "Bearer") return false;
  return token === globalKey;
}

/** 健康检查响应 */
function handleHealthCheck(): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "img-router",
      endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** CORS 预检响应 */
function handleCorsOptions(): Response {
  return new Response(null, {
    headers: corsHeaders,
  });
}

/** 404 响应 */
function handleNotFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/** 405 响应 */
function handleMethodNotAllowed(method: string): Response {
  info("HTTP", `不支持 ${method}`);
  return new Response("Method Not Allowed", { status: 405 });
}

/**
 * 内部路由处理函数（带日志上下文）
 *
 * 这是实际的路由逻辑，由 withLogging 中间件包装。
 *
 * 路由表：
 * - `/health`: 健康检查
 * - `/`: 系统信息
 * - `/v1/*`: OpenAI 兼容 API (Chat, Images)
 * - `/api/*`: 管理 API (Config, Key Pool, Logs, Dashboard)
 * - `/admin`, `/ui`, ...: 前端 SPA 页面
 * - `/css/*`, `/js/*`: 静态资源
 */
async function routeRequest(req: Request, ctx: RequestContext): Promise<Response> {
  const { pathname } = ctx.url;
  const { method } = req;

  debug("HTTP", `Request: ${method} ${pathname}`);
  
  // 特别记录 key-pool 相关的请求
  if (pathname.includes("key-pool")) {
    debug("KeyPool", `Received request - method: ${method}, pathname: "${pathname}", exact match: ${pathname === "/api/key-pool"}`);
  }

  // 健康检查端点（允许 GET）
  if (pathname === "/health" && method === "GET") {
    if (!Config.ENABLE_HEALTH_CHECK) {
      return handleNotFound();
    }
    return handleHealthCheck();
  }

  // 静态页面（SPA 路由）
  // 所有前端路由都返回 index.html，由前端 Router 处理页面显示
  const spaRoutes = [
    "/admin",
    "/setting",
    "/channel",
    "/keys",
    "/index",
    "/ui",
    "/",
    "/update",
    "/prompt-optimizer",
    "/pic",
  ];
  const spaPath = (pathname.length > 1 && pathname.endsWith("/"))
    ? pathname.slice(0, -1)
    : pathname;
  debug(
    "Router",
    `Checking SPA route: path=${pathname}, spaPath=${spaPath}, match=${
      spaRoutes.includes(spaPath)
    }`,
  );
  if (spaRoutes.includes(spaPath) && method === "GET") {
    try {
      const html = await Deno.readTextFile("web/index.html");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    } catch (e) {
      error("HTTP", `无法加载设置页面: ${e}`);
      return handleNotFound();
    }
  }

  // 静态资源文件（CSS、JS）
  if (pathname.startsWith("/css/") || pathname.startsWith("/js/")) {
    try {
      const filePath = `web${pathname}`;
      const content = await Deno.readTextFile(filePath);
      const contentType = pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : pathname.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/plain";
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      error("HTTP", `无法加载静态资源 ${pathname}: ${e}`);
      return handleNotFound();
    }
  }

  // 图片存储静态资源
  if (pathname.startsWith("/storage/")) {
    try {
      // 解码 URL 路径，处理空格等特殊字符
      const decodedPath = decodeURIComponent(pathname);
      const filePath = `data${decodedPath}`; // 映射到 data/storage/xxx
      const file = await Deno.open(filePath, { read: true });
      const stat = await file.stat();

      const ext = pathname.split(".").pop()?.toLowerCase();
      let contentType = "application/octet-stream";
      if (ext === "png") contentType = "image/png";
      else if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
      else if (ext === "webp") contentType = "image/webp";
      else if (ext === "json") contentType = "application/json";

      return new Response(file.readable, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(stat.size),
        },
      });
    } catch (_e) {
      // info("HTTP", `无法加载存储资源 ${pathname}: ${e}`);
      return handleNotFound();
    }
  }

  // 画廊 API
  if (pathname === "/api/gallery") {
    if (method === "GET") {
      try {
        const images = await storageService.listImages();
        return new Response(JSON.stringify(images), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (method === "DELETE") {
      try {
        const body = await req.json();
        if (!body || !Array.isArray(body.filenames)) {
          return new Response(
            JSON.stringify({ error: "Invalid body: filenames must be an array" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const deleted = await storageService.deleteImages(body.filenames);

        return new Response(JSON.stringify({ ok: true, deleted }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  }

  // 系统信息 API
  if ((pathname === "/api/info" || pathname === "/api/info/") && method === "GET") {
    return new Response(
      JSON.stringify({
        service: "img-router",
        version: getAppVersion(),
        docs: "https://github.com/lianwusuoai/img-router",
        ui: "/admin",
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 系统更新检查 API
  if (pathname === "/api/update/check" && method === "GET") {
    return handleUpdateCheck(req);
  }

  // CORS 预检请求
  if (method === "OPTIONS") {
    return handleCorsOptions();
  }

  // 统一鉴权
  // 排除不需要鉴权的路径：/health, /admin, /index, /ui, /css/*, /js/*, /
  // 仅对 OpenAI 兼容的 API 接口进行鉴权
  if (pathname.startsWith("/v1/") && pathname !== "/v1/models") {
    const apiKey = req.headers.get("Authorization")?.replace("Bearer ", "").trim() || "";
    // 如果既不是全局 Access Key，也不是已知的 Provider Key，则拒绝访问
    if (!checkAuth(req) && !providerRegistry.isRecognizedApiKey(apiKey)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 日志流 SSE 端点
  // 允许前端实时订阅后端日志
  if (pathname === "/api/logs/stream" && method === "GET") {
    // 从 URL 参数获取最小日志级别，默认 INFO
    const levelParam = ctx.url.searchParams.get("level") || "INFO";
    const minLevel = LogLevel[levelParam.toUpperCase() as keyof typeof LogLevel] ?? LogLevel.INFO;

    // 用于存储取消订阅函数
    let unsubscribe: (() => void) | null = null;

    // 创建 SSE 流
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // 发送初始连接消息
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "connected", level: levelParam })}\n\n`),
        );

        // 发送最近的历史日志
        const recentLogs = getRecentLogs();
        for (const entry of recentLogs) {
          if (entry.level >= minLevel) {
            try {
              const data = JSON.stringify({
                type: "log",
                timestamp: entry.timestamp,
                level: entry.levelName,
                module: entry.module,
                message: entry.message,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch { /* ignore */ }
          }
        }

        // 订阅日志流
        unsubscribe = addLogStream((entry: LogEntry) => {
          // 根据日志级别过滤
          if (entry.level >= minLevel) {
            try {
              const data = JSON.stringify({
                type: "log",
                timestamp: entry.timestamp,
                level: entry.levelName,
                module: entry.module,
                message: entry.message,
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch {
              // 忽略编码错误
            }
          }
        });
      },
      cancel() {
        // 连接关闭时取消订阅日志流
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders,
      },
    });
  }

  // 路由分发
  switch (pathname) {
    // OpenAI 兼容 API
    case "/v1/chat/completions":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleChatCompletions(req);
    case "/v1/images/generations":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesGenerations(req);
    case "/v1/images/edits":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesEdits(req);
    case "/v1/images/blend":
      if (method !== "POST") return handleMethodNotAllowed(method);
      return await handleImagesBlend(req);

    // 管理 API：系统配置
    case "/api/config":
      if (method === "GET") {
        const runtimeConfig = getRuntimeConfig();
        const runtimeSystem = runtimeConfig.system || {};
        const resolvedPort = typeof runtimeSystem.port === "number"
          ? runtimeSystem.port
          : Config.PORT;
        const resolvedTimeout = typeof runtimeSystem.apiTimeout === "number"
          ? runtimeSystem.apiTimeout
          : Config.API_TIMEOUT_MS;
        const resolvedMaxBody = typeof runtimeSystem.maxBodySize === "number"
          ? runtimeSystem.maxBodySize
          : Config.MAX_REQUEST_BODY_SIZE;
        const resolvedCors = typeof runtimeSystem.cors === "boolean"
          ? runtimeSystem.cors
          : Config.ENABLE_CORS;
        const resolvedLogging = typeof runtimeSystem.requestLogging === "boolean"
          ? runtimeSystem.requestLogging
          : Config.ENABLE_REQUEST_LOGGING;
        const resolvedHealth = typeof runtimeSystem.healthCheck === "boolean"
          ? runtimeSystem.healthCheck
          : Config.ENABLE_HEALTH_CHECK;

        const providers = providerRegistry.getNames().flatMap((name) => {
          const p = providerRegistry.get(name, true);
          if (!p) return [];
          const isEnabled = providerRegistry.has(name);

          if (name === "Gitee") {
            debug(
              "App",
              `[API/Config] Gitee Config Snapshot: ${
                JSON.stringify({
                  textModelsCount: p.config.textModels?.length,
                  editModelsCount: p.config.editModels?.length,
                  blendModelsCount: p.config.blendModels?.length,
                  firstTextModel: p.config.textModels?.[0],
                })
              }`,
            );
          }

          return [{
            name: p.name,
            enabled: isEnabled,
            capabilities: p.capabilities,
            textModels: p.config.textModels,
            editModels: p.config.editModels || [],
            defaultModel: p.config.defaultModel,
            defaultEditModel: p.config.defaultEditModel || p.config.defaultModel,
            defaultSize: p.config.defaultSize,
            defaultEditSize: p.config.defaultEditSize || p.config.defaultSize,
            blendModels: p.config.blendModels || [],
            defaultBlendModel: p.config.defaultBlendModel || p.config.defaultModel,
            defaultBlendSize: p.config.defaultBlendSize || p.config.defaultSize,
            supportsQuality: p.name === "Pollinations",
          }];
        });

        return new Response(
          JSON.stringify({
            version: getAppVersion(),
            textModels: Config.ALL_TEXT_MODELS,
            supportedSizes: Config.SUPPORTED_SIZES,
            providers,
            runtimeConfig,
            port: resolvedPort,
            timeout: resolvedTimeout,
            maxBody: resolvedMaxBody,
            defaultModel: Config.DEFAULT_IMAGE_MODEL,
            defaultSize: Config.DEFAULT_IMAGE_SIZE,
            defaultQuality: Config.DEFAULT_IMAGE_QUALITY,
            doubaoConfigured: !!Config.DOUBAO_ACCESS_KEY ||
              getKeyPool("Doubao").some((k) => k.enabled),
            giteeConfigured: !!Config.GITEE_AI_API_KEY ||
              getKeyPool("Gitee").some((k) => k.enabled),
            modelscopeConfigured: !!Config.MODELSCOPE_API_KEY ||
              getKeyPool("ModelScope").some((k) => k.enabled),
            hfConfigured: !!Config.HUGGINGFACE_API_KEY ||
              getKeyPool("HuggingFace").some((k) => k.enabled),
            pollinationsConfigured: !!Config.POLLINATIONS_API_KEY ||
              getKeyPool("Pollinations").some((k) => k.enabled),
            globalAccessKeyConfigured: !!Config.GLOBAL_ACCESS_KEY,
            cors: resolvedCors,
            logging: resolvedLogging,
            verboseLogging: Config.VERBOSE_LOGGING,
            healthCheck: resolvedHealth,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return handleMethodNotAllowed(method);

    // OpenAI 兼容 API: 获取模型列表
    case "/v1/models":
      if (method === "GET") {
        // 聚合所有已启用 Provider 的模型
        const allModels = new Set<string>();

        // 添加文本模型
        Config.ALL_TEXT_MODELS.forEach((m) => allModels.add(m));

        const names = providerRegistry.getNames();

        for (const name of names) {
          if (!providerRegistry.has(name)) continue;
          const provider = providerRegistry.get(name);
          if (provider) {
            const models = provider.getSupportedModels();
            models.forEach((m) => allModels.add(m));
          }
        }

        const modelList = Array.from(allModels).map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "img-router",
        }));

        return new Response(
          JSON.stringify({
            object: "list",
            data: modelList,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        );
      }
      return handleMethodNotAllowed(method);

    // 管理 API：密钥池管理
    case "/api/key-pool":
      debug("KeyPool", `Received ${method} request to /api/key-pool`);
      if (method === "GET") {
        const provider = ctx.url.searchParams.get("provider");
        if (!provider) {
          return new Response(JSON.stringify({ error: "Missing provider param" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const pool = getKeyPool(provider);
        // Debug: Log pool data to diagnose the issue
        console.log(`[DEBUG] Key pool for provider "${provider}":`, JSON.stringify(pool, null, 2));
        console.log(`[DEBUG] Pool length:`, pool.length);
        pool.forEach((k, idx) => {
          console.log(`[DEBUG] Key item ${idx}:`, JSON.stringify(k));
          console.log(`[DEBUG] Key item ${idx} - key type:`, typeof k.key, `key value:`, k.key);
        });
        
        // Security: Mask keys in response
        const safePool = pool.map((k) => ({
          ...k,
          key: k.key && typeof k.key === "string" && k.key.length > 8
            ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
            : "********",
        }));
        return new Response(JSON.stringify({ pool: safePool }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        debug("KeyPool", "POST request received");
        debug("KeyPool", `Headers: ${JSON.stringify(Object.fromEntries(req.headers.entries()))}`);
        
        try {
          debug("KeyPool", "Parsing body...");
          const body = await req.json() as KeyPoolUpdatePayload;
          debug("KeyPool", `Body parsed: ${JSON.stringify(body)}`);
          const { provider, keyItem, action, id, keys, format } = body;

          if (!provider) throw new Error("Missing provider");

          const pool = getKeyPool(provider);
          let newPool = [...pool];

          if (action === "add") {
            if (!keyItem || !keyItem.key) throw new Error("Missing keyItem");
            // Check duplicate
            if (pool.some((k) => k.key === keyItem.key)) throw new Error("Duplicate key");
            newPool.push({
              id: crypto.randomUUID(),
              enabled: true,
              lastUsed: 0,
              addedAt: Date.now(),
              provider: provider,
              status: "active",
              ...keyItem,
              key: keyItem.key, // Ensure key is set
              name: keyItem.name || "New Key", // Ensure name is set
            });
          } else if (action === "batch_add") {
            if (!keys || typeof keys !== "string") throw new Error("Missing keys string");

            let keyList: string[] = [];
            const inputFormat = format || "auto";

            if (inputFormat === "csv") {
              keyList = keys.split(",").map((k) => k.trim()).filter(Boolean);
            } else if (inputFormat === "text") {
              keyList = keys.split("\n").map((k) => k.trim()).filter(Boolean);
            } else { // auto
              if (keys.includes("\n")) {
                keyList = keys.split("\n").map((k) => k.trim()).filter(Boolean);
              } else {
                keyList = keys.split(",").map((k) => k.trim()).filter(Boolean);
              }
            }

            // Deduplicate input
            keyList = [...new Set(keyList)];

            let addedCount = 0;
            for (const k of keyList) {
              // Skip if already exists in pool
              if (pool.some((pk) => pk.key === k)) continue;

              newPool.push({
                id: crypto.randomUUID(),
                key: k,
                name: `Imported Key ${k.slice(0, 8)}...`,
                enabled: true,
                lastUsed: 0,
                addedAt: Date.now(),
                successCount: 0,
                totalCalls: 0,
                errorCount: 0,
                provider: provider,
                status: "active",
              });
              addedCount++;
            }

            updateKeyPool(provider, newPool);
            // Security: Mask keys
            const safePool = newPool.map((k) => ({
              ...k,
              key: k.key && k.key.length > 8
                ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
                : "********",
            }));
            return new Response(JSON.stringify({ ok: true, pool: safePool, added: addedCount }), {
              headers: { "Content-Type": "application/json" },
            });
          } else if (action === "update") {
            if (!id) throw new Error("Missing id");
            newPool = pool.map((k) => k.id === id ? { ...k, ...keyItem } : k);
          } else if (action === "delete") {
            debug("KeyPool", `Delete action - provider: ${provider}, id: ${id}, id type: ${typeof id}`);
            if (!id) {
              error("KeyPool", `Delete failed: Missing id parameter`);
              throw new Error("Missing id parameter");
            }
            const beforeCount = pool.length;
            newPool = pool.filter((k) => k.id !== id);
            const afterCount = newPool.length;
            debug("KeyPool", `Delete result - before: ${beforeCount}, after: ${afterCount}, removed: ${beforeCount - afterCount}`);
            if (beforeCount === afterCount) {
              error("KeyPool", `Delete failed: Key with id "${id}" not found in pool`);
              throw new Error(`Key with id "${id}" not found`);
            }
          } else {
            throw new Error("Invalid action");
          }

          updateKeyPool(provider, newPool);
          // Security: Mask keys
          const safePool = newPool.map((k) => ({
            ...k,
            key: k.key && k.key.length > 8
              ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
              : "********",
          }));
          return new Response(JSON.stringify({ ok: true, pool: safePool }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      return handleMethodNotAllowed(method);

    // 管理 API：仪表盘统计
    case "/api/dashboard/stats":
      if (method === "GET") {
        const providers = providerRegistry.getNames();

        interface ProviderStats {
          total: number;
          valid: number;
          invalid: number;
          unused: number;
          totalCalls: number;
          totalSuccess: number;
          successRate: number;
        }

        const stats: Record<string, ProviderStats> = {};

        for (const name of providers) {
          const pool = getKeyPool(name);
          const total = pool.length;
          const valid = pool.filter((k) => k.enabled && !k.errorCount).length;
          const invalid = pool.filter((k) => k.enabled && !!k.errorCount).length;
          // Unused: never used (lastUsed is 0 or undefined)
          const unused = pool.filter((k) => !k.lastUsed).length;

          let totalCalls = 0;
          let totalSuccess = 0;

          pool.forEach((k) => {
            totalCalls += k.totalCalls || 0;
            totalSuccess += k.successCount || 0;
          });

          const successRate = totalCalls > 0 ? (totalSuccess / totalCalls) : 0;

          stats[name] = {
            total,
            valid,
            invalid,
            unused,
            totalCalls,
            totalSuccess,
            successRate: Number(successRate.toFixed(4)),
          };
        }

        return new Response(JSON.stringify({ stats }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleMethodNotAllowed(method);

    // 管理 API：运行时配置
    case "/api/runtime-config":
      if (method === "GET") {
        return new Response(JSON.stringify(getRuntimeConfig()), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const current = getRuntimeConfig();
        let changed = false;
        let composeSync: { updated: boolean; path: string; error?: string } | null = null;
        const nextConfig: RuntimeConfig = {
          providers: { ...current.providers },
          system: { ...current.system },
          keyPools: current.keyPools || {},
          promptOptimizer: current.promptOptimizer,
          hfModelMap: current.hfModelMap,
          storage: current.storage || {},
        };

        // 处理系统配置更新
        if (isRecord(body) && "system" in body) {
          const systemVal = body.system;
          if (isRecord(systemVal)) {
            const systemPatch = systemVal as Partial<SystemConfig>;
            const requestedPort = typeof systemPatch.port === "number"
              ? systemPatch.port
              : undefined;

            nextConfig.system = { ...nextConfig.system, ...systemPatch };

            if ("globalAccessKey" in systemVal) {
              const globalAccessKey = systemVal.globalAccessKey;
              if (globalAccessKey !== undefined) {
                nextConfig.system!.globalAccessKey =
                  globalAccessKey as SystemConfig["globalAccessKey"];
              }
            }

            if (requestedPort !== undefined) {
              composeSync = await updateDockerComposePort(requestedPort);
              if (composeSync.error) {
                error("Config", `docker-compose.yml update failed: ${composeSync.error}`);
                return new Response(
                  JSON.stringify({ ok: false, error: composeSync.error, composeSync }),
                  { status: 500, headers: { "Content-Type": "application/json" } },
                );
              }
              if (composeSync.updated) {
                info("Config", `docker-compose.yml updated: ${composeSync.path}`);
              }
            }

            Config.updateSystemConfig(nextConfig.system!);
            changed = true;
          }
        }

        // 处理 Provider 配置批量更新
        if (isRecord(body) && "providers" in body) {
          const providersVal = body.providers;
          if (isRecord(providersVal)) {
            for (const [key, value] of Object.entries(providersVal)) {
              if (!isProviderName(key)) continue;
              if (!isRecord(value)) continue;

              const pVal = value as Partial<RuntimeProviderConfig>;
              const currentP: RuntimeProviderConfig = nextConfig.providers[key] || {};
              const cleanedCurrent: RuntimeProviderConfig = {
                enabled: currentP.enabled,
                text: currentP.text,
                edit: currentP.edit,
                blend: currentP.blend,
              };
              const cleanedPatch: RuntimeProviderConfig = {
                enabled: pVal.enabled,
                text: pVal.text,
                edit: pVal.edit,
                blend: pVal.blend,
              };

              nextConfig.providers[key] = {
                ...cleanedCurrent,
                ...cleanedPatch,
                text: { ...(cleanedCurrent.text || {}), ...(cleanedPatch.text || {}) },
                edit: { ...(cleanedCurrent.edit || {}), ...(cleanedPatch.edit || {}) },
                blend: { ...(cleanedCurrent.blend || {}), ...(cleanedPatch.blend || {}) },
              };
            }

            changed = true;
          }
        }

        // 处理存储配置更新 (Storage Config)
        if (isRecord(body) && "storage" in body) {
          const storageVal = body.storage;
          if (isRecord(storageVal)) {
            nextConfig.storage = { ...nextConfig.storage, ...storageVal };
            changed = true;
          }
        }

        if (changed) {
          info(
            "Config",
            `Runtime config updated. System: ${JSON.stringify(nextConfig.system)}, Providers: ${
              JSON.stringify(nextConfig.providers)
            }, Storage: ${JSON.stringify(nextConfig.storage)}`,
          );
          replaceRuntimeConfig(nextConfig);
          return new Response(
            JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig(), composeSync }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const payload = body as {
          provider?: string;
          task?: string;
          defaults?: Record<string, unknown>;
          enabled?: boolean;
        };

        const provider = payload.provider;
        const task = payload.task;
        const defaults = payload.defaults;
        const enabled = payload.enabled;

        if (typeof provider !== "string") {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!isProviderName(provider)) {
          return new Response(JSON.stringify({ error: "Unknown provider" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 处理启用/禁用状态
        if (typeof enabled === "boolean") {
          setProviderEnabled(provider as ProviderName, enabled);
          if (enabled) {
            providerRegistry.enable(provider as ProviderName);
          } else {
            providerRegistry.disable(provider as ProviderName);
          }

          // 如果没有其他任务配置，直接返回
          if (!task && !defaults) {
            return new Response(JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig() }), {
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        if (
          (task !== "text" && task !== "edit" && task !== "blend") || !defaults ||
          typeof defaults !== "object"
        ) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const taskDefaults: ProviderTaskDefaults = {
          model: ("model" in defaults ? defaults.model : undefined) as string | null | undefined,
          size: ("size" in defaults ? defaults.size : undefined) as string | null | undefined,
          quality: ("quality" in defaults ? defaults.quality : undefined) as
            | string
            | null
            | undefined,
          n: ("n" in defaults ? defaults.n : undefined) as number | null | undefined,
          steps: ("steps" in defaults ? defaults.steps : undefined) as number | null | undefined,
          weight: ("weight" in defaults ? defaults.weight : undefined) as number | undefined,
        };

        const promptOptimizer = defaults.promptOptimizer;
        if (isRecord(promptOptimizer)) {
          taskDefaults.promptOptimizer = {
            translate: typeof promptOptimizer.translate === "boolean"
              ? promptOptimizer.translate
              : undefined,
            expand: typeof promptOptimizer.expand === "boolean"
              ? promptOptimizer.expand
              : undefined,
          };
        }

        setProviderTaskDefaults(provider as ProviderName, task, taskDefaults);

        return new Response(JSON.stringify({ ok: true, runtimeConfig: getRuntimeConfig() }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleMethodNotAllowed(method);

    case "/api/restart-docker":
      if (method !== "POST") return handleMethodNotAllowed(method);
      if (!checkAuth(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      {
        const runtime = getRuntimeConfig();
        const port = typeof runtime.system?.port === "number" ? runtime.system.port : Config.PORT;

        if (Deno.build.os !== "windows") {
          try {
            await cleanupOldContainers();
          } catch (e) {
            void e;
          }
        }

        const result = await restartDockerCompose(port);
        if (!result.ok) {
          error("Docker", JSON.stringify(result));
          return new Response(JSON.stringify(result), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (Deno.build.os !== "windows" && result.cmd === "docker.sock") {
          try {
            const detail = result.stdout ? JSON.parse(result.stdout) : undefined;
            scheduleCleanupAfterRestart(detail);
          } catch (e) {
            void e;
          }
        }

        info("Docker", `docker compose triggered: ${result.cmd} ${result.args.join(" ")}`);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      }

    // 管理 API: 提示词优化器配置
    case "/api/config/prompt-optimizer":
      if (method === "GET") {
        const config = Config.getPromptOptimizerConfig();
        // 直接返回配置，不再脱敏 API Key，以便前端明文显示
        return new Response(JSON.stringify(config || {}), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!isRecord(body)) {
          return new Response(JSON.stringify({ error: "Invalid body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const current = Config.getPromptOptimizerConfig();

        const nextBaseUrl = typeof body.baseUrl === "string"
          ? body.baseUrl
          : (current?.baseUrl ?? "");
        const nextModel = typeof body.model === "string" ? body.model : (current?.model ?? "");

        let nextApiKey: string = current?.apiKey ?? "";
        // 移除脱敏判断，始终更新 apiKey
        if (typeof body.apiKey === "string") {
          nextApiKey = body.apiKey;
        }

        const nextEnableTranslate = typeof body.enableTranslate === "boolean"
          ? body.enableTranslate
          : current?.enableTranslate;
        const nextEnableExpand = typeof body.enableExpand === "boolean"
          ? body.enableExpand
          : current?.enableExpand;
        const nextTranslatePrompt = typeof body.translatePrompt === "string"
          ? body.translatePrompt
          : current?.translatePrompt;
        const nextExpandPrompt = typeof body.expandPrompt === "string"
          ? body.expandPrompt
          : current?.expandPrompt;

        Config.updatePromptOptimizerConfig({
          baseUrl: nextBaseUrl,
          apiKey: nextApiKey,
          model: nextModel,
          enableTranslate: nextEnableTranslate,
          enableExpand: nextEnableExpand,
          translatePrompt: nextTranslatePrompt,
          expandPrompt: nextExpandPrompt,
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return handleMethodNotAllowed(method);

    // 工具 API: 获取模型列表
    case "/api/tools/fetch-models":
      if (method === "POST") {
        try {
          const body = await req.json();

          // Debug logs to verify inputs
          console.log("[API] fetch-models request:", {
            baseUrl: body.baseUrl,
            apiKey: body.apiKey ? "present" : "empty",
          });

          if (!isRecord(body) || typeof body.baseUrl !== "string") {
            return new Response(JSON.stringify({ error: "Missing or invalid baseUrl" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (!promptOptimizerService) {
            throw new Error("promptOptimizerService is not initialized");
          }

          const models = await promptOptimizerService.fetchModels({
            baseUrl: body.baseUrl,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
          });

          return new Response(JSON.stringify({ ok: true, models }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("[API] Fetch models failed:", e);
          return new Response(
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      return handleMethodNotAllowed(method);

    // 工具 API: 测试 Prompt Optimizer 连接
    case "/api/tools/test-prompt-optimizer":
      if (method === "POST") {
        try {
          const body = await req.json();
          // 如果是脱敏的 key，尝试从配置中获取真实的 key
          if (body.apiKey === "******") {
            const current = Config.getPromptOptimizerConfig();
            if (current?.apiKey) {
              body.apiKey = current.apiKey;
            }
          }

          if (!body.baseUrl || !body.apiKey) {
            return new Response(JSON.stringify({ error: "Missing parameters" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (!promptOptimizerService) {
            throw new Error("promptOptimizerService is not initialized");
          }

          const result = await promptOptimizerService.testConnection({
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            model: body.model || "",
          });

          return new Response(
            JSON.stringify({
              ok: true,
              message: result.reply,
              url: result.url,
              model: result.model,
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      return handleMethodNotAllowed(method);

    // 管理 API: HF 模型映射配置
    case "/api/config/hf-map":
      if (method === "POST") {
        try {
          const body = await req.json(); // Expected: Record<string, { main: string, backup?: string }>
          if (typeof body !== "object") {
            return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400 });
          }
          Config.updateHfModelMap(body);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
        }
      }
      if (method === "GET") {
        return new Response(JSON.stringify(Config.getHfModelMap()), { status: 200 });
      }
      return handleMethodNotAllowed(method);

    default:
      return handleNotFound();
  }
}

/**
 * 附加 CORS 响应头中间件
 */
function attachCorsHeaders(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const response = await handler(req);

    if (Config.ENABLE_CORS) {
      try {
        for (const [key, value] of Object.entries(corsHeaders)) {
          // 确保 CORS 头存在（覆盖策略，确保生效）
          response.headers.set(key, value);
        }
      } catch {
        // 如果 Headers 不可变，重新创建 Response
        const newHeaders = new Headers(response.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          newHeaders.set(key, value);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
    }
    return response;
  };
}

/**
 * 主路由函数：包装了日志中间件和 CORS 处理
 *
 * 这是导出给 main.ts 使用的函数，自动记录所有请求并处理 CORS
 */
export const handleRequest = attachCorsHeaders(withLogging(routeRequest));
