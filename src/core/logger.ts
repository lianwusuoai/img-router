/**
 * @fileoverview 核心日志模块
 *
 * 提供全功能的日志服务，包括：
 * 1. 北京时间支持 (UTC+8)
 * 2. 文件持久化存储与自动轮转 (按天)
 * 3. 多级别日志控制 (DEBUG/INFO/ERROR)
 * 4. 实时 SSE 日志流推送
 * 5. 异步高性能写入
 * 6. 日志去重与文件监听 (Tail 模式)
 *
 * 从根目录迁移到 src/core/ 作为核心基础设施
 */

/** 北京时间偏移量 (UTC+8) */
const BEIJING_TIMEZONE_OFFSET = 8 * 60 * 60 * 1000;

/**
 * 日志条目接口
 * 定义单条日志的数据结构
 */
export interface LogEntry {
  /** 格式化的时间戳 (YYYY-MM-DD HH:mm:ss.sss) */
  timestamp: string;
  /** 日志级别枚举值 */
  level: LogLevel;
  /** 日志级别名称 (INFO, ERROR 等) */
  levelName: string;
  /** 所属模块名称 */
  module: string;
  /** 日志具体内容 */
  message: string;
}

/** SSE 连接回调函数类型 */
type LogStreamCallback = (entry: LogEntry) => void;

/** 当前活跃的 SSE 连接集合 */
const activeStreams: Set<LogStreamCallback> = new Set();

/**
 * 最近日志签名缓存
 * 用于防止短时间内重复记录相同的日志（去重）
 */
const recentLogSignatures: Set<string> = new Set();
/** 最大签名缓存数量 */
const MAX_SIGNATURES = 1000;

/**
 * 最近日志缓存
 * 用于新建立连接时回显历史日志
 */
const recentLogs: LogEntry[] = [];
/** 最大保留的历史日志条数 */
const MAX_RECENT_LOGS = 100;

/** 文件系统监听器实例 */
let fileWatcher: Deno.FsWatcher | null = null;
/** 当前正在监听的文件路径 */
let currentWatchPath: string | null = null;
/** 上一次读取的文件大小（用于增量读取） */
let lastFileSize = 0;

// ==========================================
// 异步写入队列相关
// ==========================================
const logQueue: Uint8Array[] = [];
let isWriting = false;
let currentLogDate: string = "";

/**
 * 生成日志唯一签名
 *
 * @param {LogEntry} entry - 日志条目
 * @returns {string} 签名字符串
 */
function getLogSignature(entry: LogEntry): string {
  return `${entry.timestamp}|${entry.levelName}|${entry.module}|${entry.message}`;
}

/**
 * 处理日志条目
 * 包括去重、缓存更新和实时推送
 *
 * @param {LogEntry} entry - 日志条目
 * @param {boolean} isExternal - 是否来自外部文件监听（用于防止循环记录）
 */
function processLogEntry(entry: LogEntry, isExternal: boolean): void {
  // 1. 签名去重
  const sig = getLogSignature(entry);
  if (isExternal && recentLogSignatures.has(sig)) {
    // 如果是外部文件读取的日志，且已经存在于签名缓存中（说明是我们自己写入的），则忽略
    return;
  }

  // 2. 更新签名缓存
  recentLogSignatures.add(sig);
  if (recentLogSignatures.size > MAX_SIGNATURES) {
    recentLogSignatures.clear(); // 简单清理，防止内存无限增长
    recentLogSignatures.add(sig);
  }

  // 3. 更新历史记录
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift(); // 移除最旧的日志
  }

  // 4. 推送给所有活跃的 SSE 连接
  for (const callback of activeStreams) {
    try {
      callback(entry);
    } catch { /* 忽略推送过程中的错误 */ }
  }
}

/**
 * 获取最近的日志记录
 *
 * @returns {LogEntry[]} 日志列表副本
 */
export function getRecentLogs(): LogEntry[] {
  return [...recentLogs];
}

/**
 * 启动日志文件监听（模拟 `tail -f` 功能）
 * 当日志文件发生变化时，自动读取新增内容并推送到流
 *
 * @param {string} path - 日志文件绝对路径
 */
async function startFileWatcher(path: string): Promise<void> {
  if (currentWatchPath === path && fileWatcher) return;

  // 停止旧的监听器
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch { /* 忽略关闭错误 */ }
    fileWatcher = null;
  }

  currentWatchPath = path;

  try {
    // 获取初始文件大小
    const stat = await Deno.stat(path);
    lastFileSize = stat.size;

    // 开始监听文件变化
    // 注意：Windows 上 Deno.watchFs 对文件修改通常是有效的
    fileWatcher = Deno.watchFs(path);

    // 异步处理文件变更事件
    (async () => {
      if (!fileWatcher) return;
      for await (const event of fileWatcher) {
        if (event.kind === "modify") {
          await processFileUpdates(path);
        }
      }
    })();

    info("Logger", `已启动日志文件监听: ${path}`);
  } catch (e) {
    // 文件可能还不存在，或者无法访问
    // 这是一个非致命错误，因为如果是我们自己创建文件，稍后 initLogger 会创建
    // 但如果是监听外部文件，可能需要重试机制。这里暂时只记录。
    // 注意：这里调用 info 可能会导致递归调用（如果 info -> writeLog -> 报错），所以用 console.error
    console.error(`[Logger] 启动文件监听失败: ${e}`);
  }
}

/**
 * 处理文件更新事件
 * 读取自上次检查以来的新增内容
 *
 * @param {string} path - 文件路径
 */
async function processFileUpdates(path: string): Promise<void> {
  try {
    const stat = await Deno.stat(path);
    const newSize = stat.size;

    if (newSize > lastFileSize) {
      // 读取新增内容
      const file = await Deno.open(path, { read: true });
      try {
        await file.seek(lastFileSize, Deno.SeekMode.Start);
        const buf = new Uint8Array(newSize - lastFileSize);
        await file.read(buf);
        const text = new TextDecoder().decode(buf);

        // 更新偏移量
        lastFileSize = newSize;

        // 解析并推送日志行
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          // 解析标准日志行格式: [TIMESTAMP] [LEVEL] [MODULE] MESSAGE
          // 正则: ^\[(.*?)\] \[(.*?)\] \[(.*?)\] (.*)$
          const match = line.match(/^\[(.*?)\] \[(.*?)\] \[(.*?)\] (.*)$/);
          if (match) {
            const [_, timestamp, levelName, module, message] = match;

            // 映射 LevelName 到 LogLevel 枚举
            let level = LogLevel.INFO;
            if (levelName === "DEBUG") level = LogLevel.DEBUG;
            else if (levelName === "ERROR") level = LogLevel.ERROR;

            const entry: LogEntry = {
              timestamp,
              level,
              levelName,
              module,
              message,
            };

            // 处理外部日志（标记 isExternal = true）
            processLogEntry(entry, true);
          }
        }
      } finally {
        file.close();
      }
    } else if (newSize < lastFileSize) {
      // 文件被截断（如日志轮转），重置偏移量
      lastFileSize = newSize;
    }
  } catch (e) {
    console.error(`[Logger] 读取文件更新失败: ${e}`);
  }
}

/**
 * 获取北京时间格式化字符串
 * 格式: YYYY-MM-DD  HH:mm:ss.sss
 */
function getBeijingTimestamp(): string {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + BEIJING_TIMEZONE_OFFSET);
  return beijingTime.toISOString().replace("T", "  ").replace("Z", "");
}

/**
 * 获取北京时间日期字符串
 * 格式: YYYY-MM-DD
 */
function getBeijingDateString(): string {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + BEIJING_TIMEZONE_OFFSET);
  return beijingTime.toISOString().split("T")[0];
}

/**
 * 日志级别枚举
 */
export enum LogLevel {
  /** 调试级别：用于开发调试信息，记录详细的程序执行流程 */
  DEBUG = 0,
  /** 信息级别：用于记录关键业务操作和系统运行状态 */
  INFO = 1,
  /** 错误级别：用于记录错误和异常情况 */
  ERROR = 2,
}

/** 日志配置接口 */
interface LoggerConfig {
  /** 最低日志级别 */
  level: LogLevel;
  /** 是否启用文件输出 */
  fileEnabled: boolean;
  /** 日志文件存储目录 */
  logDir: string;
}

/** 默认日志配置 */
let config: LoggerConfig = {
  level: LogLevel.INFO,
  fileEnabled: true,
  logDir: "./data/logs",
};

/** 日志文件句柄 */
let logFile: Deno.FsFile | null = null;

/**
 * 轮转日志文件
 * 检查日期是否变更，如果变更则切换文件
 */
async function rotateLogFileIfNeeded(): Promise<void> {
  const today = getBeijingDateString();
  if (currentLogDate !== today) {
    // 关闭旧文件
    if (logFile) {
      try {
        logFile.close();
      } catch { /* ignore */ }
      logFile = null;
    }

    // 更新日期
    currentLogDate = today;

    // 打开新文件
    const logPath = `${config.logDir}/${today}.log`;
    try {
      logFile = await Deno.open(logPath, { create: true, append: true });
      
      // 如果是新的一天，启动新的监听
      startFileWatcher(logPath);
    } catch (e) {
      console.error(`[Logger] 无法打开日志文件: ${logPath}, error: ${e}`);
      config.fileEnabled = false;
    }
  }
}

/**
 * 刷新写入队列
 * 异步将队列中的日志写入文件
 */
async function flushQueue() {
  if (isWriting || logQueue.length === 0) return;
  isWriting = true;

  try {
    while (logQueue.length > 0) {
      // 检查轮转
      await rotateLogFileIfNeeded();

      if (config.fileEnabled && logFile) {
        const data = logQueue.shift();
        if (data) {
          await logFile.write(data);
        }
      } else {
        // 如果文件未启用或无法打开，清空队列防止内存溢出
        logQueue.length = 0; 
      }
    }
  } catch (e) {
    console.error(`[Logger] 写入失败: ${e}`);
  } finally {
    isWriting = false;
    // 如果在写入过程中有新日志加入，再次触发
    if (logQueue.length > 0) {
      flushQueue();
    }
  }
}

/**
 * 核心日志写入函数
 *
 * @param {number} level - 日志级别
 * @param {string} module - 模块名称
 * @param {string} message - 日志消息
 */
function writeLog(level: number, module: string, message: string): void {
  const timestamp = getBeijingTimestamp();
  
  // 修正 LogLevel 枚举映射：
  // DEBUG=0 -> DEBUG
  // INFO=1 -> INFO
  // ERROR=2 -> ERROR
  let actualLevelName = "INFO";
  if (level === LogLevel.DEBUG) actualLevelName = "DEBUG";
  else if (level === LogLevel.ERROR) actualLevelName = "ERROR";
  else actualLevelName = "INFO";


  // 仅当级别满足配置要求时才处理
  if (level < config.level) {
    return;
  }

  // 创建日志条目对象
  const entry: LogEntry = {
    timestamp,
    level,
    levelName: actualLevelName,
    module,
    message,
  };

  // 处理日志（缓存、去重、推送）
  processLogEntry(entry, false);

  // 控制台输出（仅当级别满足配置要求时）
  if (level >= config.level) {
    const color = level === LogLevel.ERROR ? "\x1b[31m" : (level === LogLevel.DEBUG ? "\x1b[34m" : "\x1b[32m");
    const reset = "\x1b[0m";
    console.log(`${color}[${timestamp}] [${actualLevelName}] [${module}] ${message}${reset}`);
  }

  // 文件输出 (加入队列)
  if (config.fileEnabled) {
    const line = `[${timestamp}] [${actualLevelName}] [${module}] ${message}\n`;
    logQueue.push(new TextEncoder().encode(line));
    flushQueue();
  }
}

/**
 * 记录调试日志
 * @param {string} module - 模块名称
 * @param {string} message - 日志内容
 */
export function debug(module: string, message: string): void {
  writeLog(LogLevel.DEBUG, module, message);
}

/**
 * 记录信息日志
 * @param {string} module - 模块名称
 * @param {string} message - 日志内容
 */
export function info(module: string, message: string): void {
  writeLog(LogLevel.INFO, module, message);
}

/**
 * 记录错误日志
 * @param {string} module - 模块名称
 * @param {string} message - 日志内容
 */
export function error(module: string, message: string): void {
  writeLog(LogLevel.ERROR, module, message);
}

/**
 * 配置日志模块
 * 允许在运行时更新日志配置
 *
 * @param {Partial<LoggerConfig>} opts - 配置选项
 */
export function configureLogger(opts: Partial<LoggerConfig>): void {
  config = { ...config, ...opts };

  // 优先使用环境变量中的日志级别设置
  const envLevel = Deno.env.get("LOG_LEVEL");
  if (envLevel) {
    if (envLevel.toUpperCase() === "DEBUG") config.level = LogLevel.DEBUG;
    else if (envLevel.toUpperCase() === "ERROR") config.level = LogLevel.ERROR;
    else config.level = LogLevel.INFO;
  }
}

/**
 * 初始化日志模块
 * 创建日志目录，打开日志文件，并启动监听
 */
export async function initLogger(): Promise<void> {
  try {
    await Deno.mkdir(config.logDir, { recursive: true });
  } catch { /* 目录可能已存在，忽略错误 */ }

  currentLogDate = getBeijingDateString();
  const logPath = `${config.logDir}/${currentLogDate}.log`;

  try {
    logFile = await Deno.open(logPath, { create: true, append: true });
    const encoder = new TextEncoder();
    const sep = "\n" + "=".repeat(50) + "\n";
    
    // 使用队列写入启动信息
    logQueue.push(encoder.encode(`${sep}[${getBeijingTimestamp()}] 启动${sep}`));
    flushQueue();

    // 启动文件监听
    startFileWatcher(logPath);
  } catch {
    // 如果无法打开文件，降级为仅控制台输出
    config.fileEnabled = false;
  }
}

/**
 * 关闭日志模块
 * 关闭文件句柄和监听器
 */
export async function closeLogger(): Promise<void> {
  // 停止文件监听
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch { /* ignore */ }
    fileWatcher = null;
  }

  // 等待队列清空
  while(logQueue.length > 0) {
    await new Promise(r => setTimeout(r, 10));
  }

  if (logFile) {
    try {
      const encoder = new TextEncoder();
      const sep = "\n" + "=".repeat(50) + "\n";
      await logFile.write(encoder.encode(`${sep}[${getBeijingTimestamp()}] 关闭${sep}`));
      logFile.close();
    } catch { /* 忽略关闭错误 */ }
    logFile = null;
  }
}

/**
 * 添加日志流监听者
 *
 * @param {LogStreamCallback} callback - 接收日志条目的回调函数
 * @returns {Function} 取消订阅的函数
 */
export function addLogStream(callback: LogStreamCallback): () => void {
  activeStreams.add(callback);
  return () => {
    activeStreams.delete(callback);
  };
}

/**
 * 获取当前活跃的流连接数
 * @returns {number} 连接数
 */
export function getActiveStreamCount(): number {
  return activeStreams.size;
}

/**
 * 生成唯一的请求 ID
 * @returns {string} 格式: req_时间戳_随机串
 */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 记录 HTTP 请求结束日志
 *
 * @param {string} requestId - 请求 ID
 * @param {string} method - HTTP 方法
 * @param {string} url - 请求 URL
 * @param {number} status - HTTP 状态码
 * @param {number} duration - 耗时 (ms)
 * @param {string} [errorMessage] - 错误信息（如果有）
 */
export function logRequestEnd(
  requestId: string,
  method: string,
  url: string,
  status: number,
  duration: number,
  errorMessage?: string,
): void {
  if (errorMessage || status >= 400) {
    const msg = `${method} ${url} ${status} 失败 (${duration}ms) [${requestId}]: ${errorMessage || "未知错误"}`;
    writeLog(LogLevel.ERROR, "HTTP", msg);
  } else {
    // 彻底屏蔽高频/低价值请求的成功日志（如管理后台页面导航和配置轮询）
    const ignoredPaths = [
      "/api/config",
      "/api/key-pool",
      "/favicon.ico",
      "/admin",
      "/setting",
      "/channel",
      "/keys",
    ];

    if (ignoredPaths.some((p) => url.startsWith(p)) || url === "/") {
      return;
    }

    const msg = `${method} ${url} ${status} (${duration}ms)`;
    writeLog(LogLevel.INFO, "HTTP", msg); // 正常请求使用 INFO 级别
  }
}

/**
 * 记录提供商路由决策日志
 */
export function logProviderRouting(provider: string, keyPrefix: string): void {
  writeLog(LogLevel.DEBUG, "Router", `路由 ${provider} (${keyPrefix}...)`);
}

/**
 * 记录 API 调用开始日志
 */
export function logApiCallStart(provider: string, op: string): void {
  writeLog(LogLevel.DEBUG, provider, `API ${op} 开始`);
}

/**
 * 记录 API 调用结束日志
 */
export function logApiCallEnd(
  provider: string,
  op: string,
  success: boolean,
  duration: number,
): void {
  const status = success ? "成功" : "失败";
  writeLog(
    success ? LogLevel.INFO : LogLevel.ERROR,
    provider,
    `API ${op} ${status} (${duration}ms)`,
  );
}

/**
 * 记录完整的 Prompt 日志（用于调试）
 */
export function logFullPrompt(provider: string, requestId: string, prompt: string): void {
  writeLog(
    LogLevel.DEBUG,
    provider,
    `🤖 完整 Prompt (${requestId}):\n${"=".repeat(60)}\n${prompt}\n${"=".repeat(60)}`,
  );
}

/**
 * 记录输入图片信息
 */
export function logInputImages(provider: string, requestId: string, images: string[]): void {
  if (images.length > 0) {
    const formatImage = (raw: string): string => {
      const maxLen = 240;

      if (raw.startsWith("data:")) {
        const commaIndex = raw.indexOf(",");
        const meta = commaIndex >= 0 ? raw.slice(0, commaIndex) : raw.slice(0, 60);
        return `${meta},...(长度: ${raw.length})`;
      }

      if (!raw.startsWith("http")) {
        return `base64...(长度: ${raw.length})`;
      }

      if (raw.length > maxLen) {
        return `${raw.slice(0, maxLen)}...(截断)`;
      }

      return raw;
    };

    const imageList = images.map((raw, i) => `  ${i + 1}. ${formatImage(raw)}`).join("\n");
    writeLog(LogLevel.DEBUG, provider, `📷 输入图片 (${requestId}):\n${imageList}`);
  }
}

/**
 * 记录图片生成开始日志
 */
export function logImageGenerationStart(
  provider: string,
  requestId: string,
  model: string,
  size: string,
  promptLength: number,
): void {
  writeLog(
    LogLevel.INFO,
    provider,
    `🎨 开始生成图片 (${requestId}):\n  模型: ${model}\n  尺寸: ${size}\n  Prompt长度: ${promptLength} 字符`,
  );
}

/**
 * 记录生成的图片结果
 */
export function logGeneratedImages(
  provider: string,
  requestId: string,
  images: { url?: string; b64_json?: string }[],
): void {
  if (images.length > 0) {
    const imageUrls = images.map((img, i) => {
      if (img.url) {
        return `🖼️ 图片 ${i + 1} (${requestId}):\n  URL: ${img.url}`;
      } else if (img.b64_json) {
        return `🖼️ 图片 ${i + 1} (${requestId}):\n  Base64 (长度: ${img.b64_json.length})`;
      }
      return "";
    }).filter(Boolean).join("\n");

    writeLog(LogLevel.DEBUG, provider, imageUrls);
  }
}

/**
 * 记录图片生成完成日志
 */
export function logImageGenerationComplete(
  provider: string,
  requestId: string,
  count: number,
  duration: number,
): void {
  writeLog(
    LogLevel.INFO,
    provider,
    `✅ 图片生成完成 (${requestId}): ${count} 张图片, 耗时 ${(duration / 1000).toFixed(2)}s`,
  );
}

/**
 * 记录图片生成失败日志
 */
export function logImageGenerationFailed(provider: string, requestId: string, error: string): void {
  writeLog(LogLevel.ERROR, provider, `❌ 图片生成失败 (${requestId}): ${error}`);
}
