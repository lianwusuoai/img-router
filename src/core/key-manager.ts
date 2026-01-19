import { getKeyPool, getRuntimeConfig, replaceRuntimeConfig } from "../config/manager.ts";
import { info, warn } from "./logger.ts";

/**
 * Key 管理器
 *
 * 负责管理 Provider 的 API Key 池，包括：
 * 1. 状态追踪 (Active/RateLimited/Exhausted)
 * 2. 自动轮询 (Rotation)
 * 3. 每日配额重置 (Daily Reset)
 * 4. 匿名模式支持 (HuggingFace)
 */
export class KeyManager {
  private static instance: KeyManager;
  private lastResetDate: string = "";

  private constructor() {
    this.lastResetDate = new Date().toISOString().split("T")[0];
    // 启动每日重置检查定时器 (每小时检查一次)
    setInterval(() => this.checkDailyReset(), 60 * 60 * 1000);
  }

  public static getInstance(): KeyManager {
    if (!KeyManager.instance) {
      KeyManager.instance = new KeyManager();
    }
    return KeyManager.instance;
  }

  /**
   * 检查是否需要重置配额 (UTC 0点)
   */
  private checkDailyReset() {
    const today = new Date().toISOString().split("T")[0];
    if (today !== this.lastResetDate) {
      info("KeyManager", `日期变更 (${this.lastResetDate} -> ${today})，重置所有 Key 状态`);
      this.resetAllKeys();
      this.lastResetDate = today;
    }
  }

  /**
   * 重置所有 Key 状态为 active
   */
  private resetAllKeys() {
    const config = getRuntimeConfig();
    let changed = false;

    for (const [_provider, pool] of Object.entries(config.keyPools)) {
      for (const keyItem of pool) {
        if (keyItem.status === "rate_limited" || keyItem.status === "disabled") {
          // 注意：disabled 手动禁用的不应该自动开启，但 rate_limited 可以重置
          // 这里我们假设 rate_limited 是系统自动标记的，disabled 是人工的
          if (keyItem.status === "rate_limited") {
            keyItem.status = "active";
            changed = true;
          }
        }
      }
    }

    if (changed) {
      replaceRuntimeConfig(config);
      info("KeyManager", "已重置所有受限 Key");
    }
  }

  /**
   * 获取下一个可用 Key
   *
   * @param provider Provider 名称
   * @returns 可用的 Key，如果支持匿名且无 Key 则返回 null (但在 TS 中 string | null)
   */
  public getNextKey(provider: string): string | null {
    // 触发一次懒加载检查
    this.checkDailyReset();

    const pool = getKeyPool(provider);

    // 1. 过滤可用 Key
    const activeKeys = pool.filter((k) => k.enabled !== false && k.status === "active");

    if (activeKeys.length === 0) {
      // 检查是否允许匿名 (目前仅 HF)
      if (provider === "HuggingFace") {
        // 如果池子本来就是空的，或者所有都耗尽了，HF 可以尝试匿名
        // 但按照 V4 方案：策略 A (先匿名 -> Token) 或 B (Token 池)
        // 这里我们简化：如果没配置 Token，就返回 null (代表匿名)
        // 如果配置了 Token 但全挂了，也返回 null (尝试匿名兜底)
        return null;
      }
      return null;
    }

    // 2. 负载均衡 (这里简单随机，也可以轮询)
    const randomIndex = Math.floor(Math.random() * activeKeys.length);
    return activeKeys[randomIndex].key;
  }

  /**
   * 标记 Key 耗尽/限流
   */
  public markKeyExhausted(provider: string, key: string) {
    if (!key) return; // 匿名模式无需标记

    const config = getRuntimeConfig();
    const pool = config.keyPools[provider];
    if (!pool) return;

    const item = pool.find((k) => k.key === key);
    if (item) {
      item.status = "rate_limited";
      item.lastUsed = Date.now();
      warn(
        "KeyManager",
        `Provider ${provider} Key ...${key.slice(-4)} 已标记为限流 (Rate Limited)`,
      );
      replaceRuntimeConfig(config);
    }
  }

  /**
   * 标记 Key 无效 (401)
   */
  public markKeyInvalid(provider: string, key: string) {
    if (!key) return;

    const config = getRuntimeConfig();
    const pool = config.keyPools[provider];
    if (!pool) return;

    const item = pool.find((k) => k.key === key);
    if (item) {
      item.status = "disabled"; // 永久禁用
      item.enabled = false;
      warn("KeyManager", `Provider ${provider} Key ...${key.slice(-4)} 无效，已禁用`);
      replaceRuntimeConfig(config);
    }
  }

  /**
   * 报告 Key 成功使用 (用于统计或恢复)
   */
  public reportSuccess(_provider: string, _key: string) {
    // 可以用来做熔断恢复（比如连续成功多少次解除限流），暂不实现复杂逻辑
  }
}

export const keyManager = KeyManager.getInstance();
