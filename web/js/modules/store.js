/**
 * 全局状态管理模块
 *
 * 负责管理应用配置和跨组件状态，实现简单的发布-订阅模式。
 */

import { apiFetch } from "./utils.js";

/**
 * 全局状态存储类
 */
class Store {
  constructor() {
    /**
     * 应用状态
     * @type {{config: Object, loading: boolean, error: Error|null}}
     */
    this.state = {
      config: {}, // 系统配置
      loading: true, // 加载状态
      error: null, // 错误信息
    };

    /**
     * 订阅者列表
     * @type {Array<Function>}
     */
    this.listeners = [];
  }

  /**
   * 订阅状态变更
   *
   * @param {Function} listener - 回调函数，接收当前 state 作为参数
   * @returns {Function} 取消订阅函数
   */
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * 通知所有订阅者状态已变更
   * @private
   */
  notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  /**
   * 加载系统配置
   *
   * 从后端 API 获取最新配置并更新状态。
   * @returns {Promise<Object>} 系统配置对象
   */
  async loadConfig() {
    try {
      this.state.loading = true;
      this.notify();

      const res = await apiFetch("/api/config");
      if (!res.ok) throw new Error("Failed to load config");

      const config = await res.json();
      this.state.config = config;
      this.state.loading = false;
      this.notify();
      return config;
    } catch (e) {
      console.error("加载配置失败:", e);
      this.state.error = e;
      this.state.loading = false;
      this.notify();
    }
  }

  /**
   * 获取当前缓存的配置
   * @returns {Object} 系统配置
   */
  getConfig() {
    return this.state.config;
  }
}

// 导出单例 Store 实例
export const store = new Store();
