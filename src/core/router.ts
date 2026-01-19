import { getProviderTaskDefaults } from "../config/manager.ts";
import { providerRegistry } from "../providers/registry.ts";
import type { IProvider } from "../providers/base.ts";
import { debug, info } from "./logger.ts";

export type TaskType = "text" | "edit" | "blend";

export interface RouteStep {
  provider: IProvider;
  model: string;
}

export class WeightedRouter {
  private static instance: WeightedRouter;

  private constructor() {}

  public static getInstance(): WeightedRouter {
    if (!WeightedRouter.instance) {
      WeightedRouter.instance = new WeightedRouter();
    }
    return WeightedRouter.instance;
  }

  /**
   * 获取包含模型重定向逻辑的路由计划
   */
  public getRoutePlan(task: TaskType, preferredModel?: string): RouteStep[] {
    const allProviders = providerRegistry.getAll();
    const candidates: { provider: IProvider; weight: number; targetModel: string }[] = [];

    // 1. 检查各渠道的 Model Map 配置
    if (preferredModel && preferredModel !== "auto" && preferredModel !== "default") {
      for (const provider of allProviders) {
        if (!providerRegistry.has(provider.name)) continue;

        // 获取该渠道该任务的配置
        const defaults = getProviderTaskDefaults(provider.name, task);
        
        // 检查 modelMap 是否匹配
        // modelMap 可能是逗号分隔的字符串
        if (defaults.modelMap) {
          const mappedIds = defaults.modelMap.split(/[,，]/).map(s => s.trim());
          if (mappedIds.includes(preferredModel)) {
             // 匹配成功！
             // 目标模型优先使用 override model，如果没有则使用 default model
             // 但我们需要确定 override model 是存在的。
             // 通常 defaults.model 就是用户在 UI 上配置的“模型”列。
             const targetModel = defaults.model || provider.config.defaultModel;
             const weight = defaults.weight ?? 10;
             
             // 检查能力
             let supportsTask = false;
             if (task === "text" && provider.capabilities.textToImage) supportsTask = true;
             if (task === "edit" && provider.capabilities.imageToImage) supportsTask = true;
             if (task === "blend" && provider.capabilities.multiImageFusion) supportsTask = true;

             if (supportsTask) {
                candidates.push({ provider, weight, targetModel });
             }
          }
        }
      }
    }

    if (candidates.length > 0) {
      // 按权重降序排序
      candidates.sort((a, b) => b.weight - a.weight);

      const plan: RouteStep[] = candidates.map(c => ({
        provider: c.provider,
        model: c.targetModel
      }));

      debug(
        "Router",
        `Redirect plan for ${preferredModel}: ${
          plan.map((s) => `${s.provider.name}(${s.model})`).join(" -> ")
        }`,
      );
      return plan;
    }

    // 2. 如果没有重定向规则，回退到标准逻辑
    const providers = this.getPlan(task, preferredModel);
    return providers.map((p) => ({
      provider: p,
      model: preferredModel || "auto",
    }));
  }

  /**
   * 获取按权重排序的 Provider 列表
   *
   * @param task 任务类型
   * @param preferredModel 用户指定的模型 (如果指定且非 "auto"，则优先匹配支持该模型的 Provider)
   */
  public getPlan(task: TaskType, preferredModel?: string): IProvider[] {
    const allProviders = providerRegistry.getAll(); // 需要在 Registry 增加 getAll 方法，或者用 getEnabledNames + get

    // 1. 如果指定了特定模型 (且非 auto/default)，优先直接查找
    // 但按照 V4 方案，即使指定了模型，也可能需要走权重 (比如 gitee 和 hf 都支持 sdxl)
    // 这里的策略：
    // - 如果 preferredModel 是明确的 "provider/model" 格式 (如 "gitee/sdxl")，则直接锁定
    // - 如果 preferredModel 是通用名 (如 "sdxl")，则查找所有支持该模型的 Provider，并在这些 Provider 中按权重排序
    // - 如果 preferredModel 是 "auto" 或空，则查找所有支持该 task 的 Provider，按权重排序

    let candidates: IProvider[] = [];

    if (preferredModel && preferredModel !== "auto" && preferredModel !== "default") {
      // 尝试解析 provider/model 格式 (如果有这种约定)
      // 目前系统里主要是通过 getSupportedModels 匹配
      // 我们先找到所有支持该 model 的 provider
      candidates = allProviders.filter((p) => p.getSupportedModels().includes(preferredModel));

      if (candidates.length === 0) {
        // 如果没有精确匹配，尝试前缀匹配 (比如 hf 里的 flux/schnell 匹配 flux)
        candidates = allProviders.filter((p) =>
          p.getSupportedModels().some((m) =>
            preferredModel.includes(m) || m.includes(preferredModel)
          )
        );
      }

      // 如果还是空的，且模型名不包含 "/"，可能用户就是想要个通用模型，我们降级到 task 匹配
      if (candidates.length === 0) {
        info("Router", `未找到明确支持模型 ${preferredModel} 的 Provider，尝试按 Task 路由`);
        candidates = this.filterByCapability(allProviders, task);
      }
    } else {
      candidates = this.filterByCapability(allProviders, task);
    }

    // 2. 按权重排序
    // 获取权重：config.providers[name][task].weight || 10 (默认权重)
    const weightedCandidates = candidates.map((p) => {
      const defaults = getProviderTaskDefaults(p.name, task);
      const weight = defaults.weight ?? 10; // 默认为 10，确保未配置的 Provider 也能参与路由
      return { provider: p, weight };
    });

    // 排序：权重降序 -> 随机 (同权重)
    weightedCandidates.sort((a, b) => {
      if (b.weight !== a.weight) {
        return b.weight - a.weight;
      }
      return Math.random() - 0.5; // 简单的随机洗牌
    });

    const plan = weightedCandidates.map((wc) => wc.provider);

    debug(
      "Router",
      `路由计划 (${task}, ${preferredModel || "auto"}): ${plan.map((p) => p.name).join(" -> ")}`,
    );

    return plan;
  }

  private filterByCapability(providers: IProvider[], task: TaskType): IProvider[] {
    return providers.filter((p) => {
      if (task === "text") return p.capabilities.textToImage;
      if (task === "edit") return p.capabilities.imageToImage;
      if (task === "blend") return p.capabilities.multiImageFusion;
      return false;
    });
  }
}

export const weightedRouter = WeightedRouter.getInstance();
