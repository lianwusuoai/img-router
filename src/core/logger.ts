/**
 * @fileoverview 核心日志模块（简化版）
 *
 * 提供轻量级日志服务：
 * 1. 北京时间支持 (UTC+8)
 * 2. 文件持久化存储与自动轮转 (按天)
 * 3. 多级别日志控制 (DEBUG/INFO/ERROR)
 * 4. 实时 SSE 日志流推送
 * 5. 同步写入，真正实时
 * 6. 日志去重机制
 *
 * 统一输出格式：
 * - INFO：单行显示
 * - ERROR/DEBUG：多行格式化显示
 *
 * HTTP 请求日志级别策略：
 * - ERROR：失败请求（状态码 >= 400）
 * - INFO：关键业务操作（图片生成、密钥管理等）
 * - DEBUG：常规请求（页面访问、配置查询、状态轮询等）
 */

/** 北京时间偏移量 (UTC+8) */
const BEIJING_TIMEZONE_OFFSET = 8 * 60 * 60 * 1000;

/**
 * 日志条目接口
 * 定义单条日志的数据结构
 */
export interface LogEntry {
  /** 格式化的时间戳 (HH:mm:ss.ss) */
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

/** 日志文件句柄 */
let logFile: Deno.FsFile | null = null;
/** 当前日志日期 */
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
 */
function processLogEntry(entry: LogEntry): void {
  // 1. 签名去重
  const sig = getLogSignature(entry);
  if (recentLogSignatures.has(sig)) {
    return;
  }

  // 2. 更新签名缓存
  recentLogSignatures.add(sig);
  if (recentLogSignatures.size > MAX_SIGNATURES) {
    recentLogSignatures.clear();
    recentLogSignatures.add(sig);
  }

  // 3. 更新历史记录
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
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
 * 获取北京时间格式化字符串
 * 格式: HH:mm:ss.ss (只显示时间，毫秒保留2位)
 */
function getBeijingTimestamp(): string {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + BEIJING_TIMEZONE_OFFSET);
  const isoString = beijingTime.toISOString();
  // 提取时间部分 HH:mm:ss.sss，然后截取到2位毫秒
  const timePart = isoString.split("T")[1].replace("Z", "");
  const [time, ms] = timePart.split(".");
  return `${time}.${ms.substring(0, 2)}`;
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
  level: LogLevel.DEBUG,  // 默认记录所有级别的日志
  fileEnabled: true,
  logDir: "./data/logs",
};

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
    } catch (e) {
      console.error(`[Logger] 无法打开日志文件: ${logPath}, error: ${e}`);
      config.fileEnabled = false;
    }
  }
}

/**
 * 格式化日志消息
 * INFO：单行显示
 * ERROR/DEBUG：多行格式化显示
 *
 * @param {LogLevel} level - 日志级别
 * @param {string} timestamp - 时间戳
 * @param {string} levelName - 级别名称
 * @param {string} module - 模块名
 * @param {string} message - 消息内容
 * @returns {string} 格式化后的日志字符串
 */
function formatLogMessage(
  level: LogLevel,
  timestamp: string,
  levelName: string,
  module: string,
  message: string
): string {
  const lines = message.split('\n');
  
  if (level === LogLevel.INFO) {
    // INFO：单行显示（将换行符替换为空格）
    const singleLine = message.replace(/\n+/g, ' ').trim();
    return `[${timestamp}] [${levelName}] [${module}] ${singleLine}`;
  } else {
    // ERROR/DEBUG：多行格式化显示
    const result = [`[${timestamp}] [${levelName}] [${module}] ${lines[0]}`];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim()) {
        result.push(`  ${lines[i]}`);
      }
    }
    return result.join('\n');
  }
}

/**
 * 核心日志写入函数
 * 统一处理控制台、SSE、文件三个输出
 *
 * @param {number} level - 日志级别
 * @param {string} module - 模块名称
 * @param {string} message - 日志消息
 */
async function writeLog(level: number, module: string, message: string): Promise<void> {
  const timestamp = getBeijingTimestamp();

  // 修正 LogLevel 枚举映射
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
  processLogEntry(entry);

  // 格式化日志消息
  const formattedMessage = formatLogMessage(level, timestamp, actualLevelName, module, message);

  // 控制台输出
  if (level >= config.level) {
    const color = level === LogLevel.ERROR
      ? "\x1b[31m"
      : (level === LogLevel.DEBUG ? "\x1b[34m" : "\x1b[32m");
    const reset = "\x1b[0m";
    console.log(`${color}${formattedMessage}${reset}`);
  }

  // 文件输出（同步写入）
  if (config.fileEnabled) {
    await rotateLogFileIfNeeded();
    if (logFile) {
      const encoder = new TextEncoder();
      await logFile.write(encoder.encode(formattedMessage + '\n'));
    }
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
 * 创建日志目录，打开日志文件
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
    const sep = "=".repeat(50) + "\n";
    await logFile.write(encoder.encode(`${sep}[${getBeijingTimestamp()}] 启动\n${sep}`));
  } catch {
    // 如果无法打开文件，降级为仅控制台输出
    config.fileEnabled = false;
  }
}

/**
 * 关闭日志模块
 * 关闭文件句柄
 */
export async function closeLogger(): Promise<void> {
  if (logFile) {
    try {
      const encoder = new TextEncoder();
      const sep = "=".repeat(50) + "\n";
      await logFile.write(encoder.encode(`\n${sep}[${getBeijingTimestamp()}] 关闭\n${sep}`));
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
    const msg = `${method} ${url} ${status} 失败 (${duration}ms) [${requestId}]: ${
      errorMessage || "未知错误"
    }`;
    writeLog(LogLevel.ERROR, "HTTP", msg);
  } else {
    // 关键业务操作使用 INFO 级别
    const importantPaths = [
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/variations",
      "/api/keys",  // 密钥管理操作
    ];

    // 常规请求使用 DEBUG 级别（页面访问、配置查询、状态轮询等）
    const msg = `${method} ${url} ${status} (${duration}ms)`;
    
    // 判断是否为关键业务操作
    const isImportant = importantPaths.some((p) => url.startsWith(p));
    
    writeLog(isImportant ? LogLevel.INFO : LogLevel.DEBUG, "HTTP", msg);
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
    success ? LogLevel.DEBUG : LogLevel.ERROR,
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
