/**
 * @fileoverview Provider 注册表模块
 * 
 * 核心功能：
 * 1. 管理所有图片生成 Provider 的生命周期（注册/注销）
 * 2. 提供 Provider 的查找、过滤和获取功能
 * 3. 维护 Provider 的启用/禁用状态
 * 4. 实现基于 API Key 的自动路由策略
 */

import type { IProvider, ProviderCapabilities, ProviderConfig, ProviderName } from "./base.ts";
import { doubaoProvider } from "./doubao.ts";
import { giteeProvider } from "./gitee.ts";
import { modelScopeProvider } from "./modelscope.ts";
import { huggingFaceProvider } from "./huggingface.ts";
import { pollinationsProvider } from "./pollinations.ts";
import { debug, info, logProviderRouting, warn } from "../core/logger.ts";

/** 模块名称，用于日志前缀 */
const MODULE = "Registry";

/**
 * Provider 注册信息内部结构
 */
interface ProviderRegistration {
  /** Provider 实例引用 */
  instance: IProvider;
  /** 当前启用状态 */
  enabled: boolean;
}

/**
 * Provider 注册表管理类
 * 
 * 这是一个单例模式的实现（通过导出实例），负责维护系统中所有可用的 Provider。
 */
class ProviderRegistry {
  /** 内部存储 Map，Key 为 Provider 名称 */
  private registrations = new Map<ProviderName, ProviderRegistration>();

  constructor() {
    // 初始化时自动注册所有内置 Provider
    this.registerBuiltinProviders();
  }

  /**
   * 注册所有内置的 Provider
   * 在构造函数中调用，确保系统启动时所有 Provider 就绪
   */
  private registerBuiltinProviders(): void {
    const builtinProviders = [
      doubaoProvider,
      giteeProvider,
      modelScopeProvider,
      huggingFaceProvider,
      pollinationsProvider,
    ];

    const successList: string[] = [];
    const failList: string[] = [];

    for (const provider of builtinProviders) {
      try {
        this.register(provider);
        successList.push(provider.name);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        failList.push(`${provider.name}(${errorMsg})`);
      }
    }

    const successStr = successList.length > 0 ? successList.join(", ") : "无";
    const failStr = failList.length > 0 ? failList.join(", ") : "无";

    const report = `\n ✅ 已注册Provider(${successList.length}): ${successStr}\n ❌ 未注册Provider(${failList.length}): ${failStr}`;

    debug(MODULE, report);
  }

  /**
   * 注册一个新的 Provider
   * 
   * @param {IProvider} provider - Provider 实例
   * @param {boolean} [enabled=true] - 初始启用状态
   */
  register(provider: IProvider, enabled = true): void {
    if (this.registrations.has(provider.name)) {
      warn(MODULE, `Provider ${provider.name} 已存在，将被覆盖`);
    }
    this.registrations.set(provider.name, { instance: provider, enabled });
  }

  /**
   * 注销一个 Provider
   * 
   * @param {ProviderName} name - 要注销的 Provider 名称
   * @returns {boolean} 如果注销成功返回 true，不存在返回 false
   */
  unregister(name: ProviderName): boolean {
    const deleted = this.registrations.delete(name);
    if (deleted) {
      debug(MODULE, `已注销 Provider: ${name}`);
    }
    return deleted;
  }

  /**
   * 获取 Provider 实例
   * 
   * @param {ProviderName} name - Provider 名称
   * @param {boolean} [ignoreEnabled=false] - 是否忽略启用状态（强制获取，即使已禁用）
   * @returns {IProvider | undefined} Provider 实例，如果不存在或已禁用（且未忽略）则返回 undefined
   */
  get(name: ProviderName, ignoreEnabled = false): IProvider | undefined {
    const reg = this.registrations.get(name);
    if (!reg) {
      warn(MODULE, `未找到 Provider: ${name}`);
      return undefined;
    }

    if (!ignoreEnabled && !reg.enabled) {
      warn(MODULE, `Provider ${name} 已禁用`);
      return undefined;
    }

    return reg.instance;
  }

  /**
   * 获取 Provider 实例（严格模式）
   * 如果不存在或已禁用，将抛出错误
   * 
   * @param {ProviderName} name - Provider 名称
   * @returns {IProvider} Provider 实例
   * @throws {Error} 如果 Provider 不存在
   */
  getOrThrow(name: ProviderName): IProvider {
    const provider = this.get(name);
    if (!provider) {
      throw new Error(`Provider not found: ${name}`);
    }
    return provider;
  }

  /**
   * 检查 Provider 是否存在且已启用
   * 
   * @param {ProviderName} name - Provider 名称
   * @returns {boolean} 存在且启用返回 true
   */
  has(name: ProviderName): boolean {
    const reg = this.registrations.get(name);
    return reg !== undefined && reg.enabled;
  }

  /**
   * 获取所有已注册的 Provider 名称列表
   * 
   * @returns {ProviderName[]} 名称数组
   */
  getNames(): ProviderName[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * 获取所有已启用的 Provider 名称列表
   * 
   * @returns {ProviderName[]} 名称数组
   */
  getEnabledNames(): ProviderName[] {
    return Array.from(this.registrations.entries())
      .filter(([_, reg]) => reg.enabled)
      .map(([name, _]) => name);
  }

  /**
   * 获取所有已启用 Provider 的配置信息
   * 
   * @returns {ProviderConfig[]} 配置数组
   */
  getAllConfigs(): ProviderConfig[] {
    return Array.from(this.registrations.values())
      .filter((reg) => reg.enabled)
      .map((reg) => reg.instance.config);
  }

  /**
   * 获取指定 Provider 的能力描述
   * 
   * @param {ProviderName} name - Provider 名称
   * @returns {ProviderCapabilities | undefined} 能力描述对象
   */
  getCapabilities(name: ProviderName): ProviderCapabilities | undefined {
    return this.registrations.get(name)?.instance.capabilities;
  }

  /**
   * 根据模型名称查找支持该模型的 Provider
   * 优先匹配已启用的 Provider
   * 
   * @param {string} model - 模型名称
   * @returns {IProvider | undefined} 匹配的 Provider 实例
   */
  getProviderByModel(model: string): IProvider | undefined {
    // 遍历所有已启用的 Provider
    for (const reg of this.registrations.values()) {
      if (!reg.enabled) continue;
      
      const supported = reg.instance.getSupportedModels();
      if (supported.includes(model)) {
        return reg.instance;
      }
    }
    
    // 如果没有精确匹配，后续可以扩展支持前缀匹配或模糊匹配
    
    return undefined;
  }

  /**
   * 根据能力需求过滤 Provider
   * 
   * @param {Partial<ProviderCapabilities>} filter - 能力过滤条件
   * @returns {ProviderName[]} 符合条件的 Provider 名称列表
   */
  filterByCapability(filter: Partial<ProviderCapabilities>): ProviderName[] {
    return Array.from(this.registrations.entries())
      .filter(([_, reg]) => {
        if (!reg.enabled) return false;
        const caps = reg.instance.capabilities;
        
        // 逐项检查能力要求
        if (filter.textToImage !== undefined && caps.textToImage !== filter.textToImage) {
          return false;
        }
        if (filter.imageToImage !== undefined && caps.imageToImage !== filter.imageToImage) {
          return false;
        }
        if (
          filter.multiImageFusion !== undefined && caps.multiImageFusion !== filter.multiImageFusion
        ) return false;
        if (filter.asyncTask !== undefined && caps.asyncTask !== filter.asyncTask) return false;
        
        return true;
      })
      .map(([name, _]) => name);
  }

  /**
   * 启用指定的 Provider
   * 
   * @param {ProviderName} name - Provider 名称
   * @returns {boolean} 操作是否成功
   */
  enable(name: ProviderName): boolean {
    const reg = this.registrations.get(name);
    if (reg) {
      reg.enabled = true;
      info(MODULE, `已启用 Provider: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * 禁用指定的 Provider
   * 
   * @param {ProviderName} name - Provider 名称
   * @returns {boolean} 操作是否成功
   */
  disable(name: ProviderName): boolean {
    const reg = this.registrations.get(name);
    if (reg) {
      reg.enabled = false;
      info(MODULE, `已禁用 Provider: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * 获取注册表的当前状态摘要
   * 用于系统监控或调试
   */
  getSummary() {
    const providers = Array.from(this.registrations.entries()).map(([name, reg]) => ({
      name,
      enabled: reg.enabled,
      capabilities: reg.instance.capabilities,
    }));

    return {
      total: this.registrations.size,
      enabled: providers.filter((p) => p.enabled).length,
      disabled: providers.filter((p) => !p.enabled).length,
      providers,
    };
  }

  /**
   * 根据 API Key 格式自动检测并路由到对应的 Provider
   * 
   * @param {string} apiKey - API 密钥
   * @returns {IProvider | undefined} 匹配的 Provider 实例
   */
  detectProvider(apiKey: string): IProvider | undefined {
    if (!apiKey) return undefined;

    // 遍历所有已注册且启用的 Provider，调用它们的 detectApiKey 方法
    for (const reg of this.registrations.values()) {
      if (reg.enabled && reg.instance.detectApiKey(apiKey)) {
        // 记录路由日志（注意脱敏 Key）
        logProviderRouting(reg.instance.name, apiKey.substring(0, 4));
        return reg.instance;
      }
    }

    logProviderRouting("Unknown", apiKey.substring(0, 4));
    return undefined;
  }

  isRecognizedApiKey(apiKey: string): boolean {
    if (!apiKey) return false;

    for (const reg of this.registrations.values()) {
      if (reg.enabled && reg.instance.detectApiKey(apiKey)) {
        return true;
      }
    }

    return false;
  }
}

// 导出单例实例，确保全局共享同一份注册表
export const providerRegistry = new ProviderRegistry();

// 导出便捷操作函数，简化调用
export const getProvider = (name: ProviderName) => providerRegistry.get(name);
export const getProviderOrThrow = (name: ProviderName) => providerRegistry.getOrThrow(name);
export const hasProvider = (name: ProviderName) => providerRegistry.has(name);
export const getProviderNames = () => providerRegistry.getNames();
export const getEnabledProviders = () => providerRegistry.getEnabledNames();
