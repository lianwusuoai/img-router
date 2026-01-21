/**
 * 前端路由模块
 *
 * 处理 URL 路由、页面切换和导航状态管理。
 * 实现了一个简单的基于 History API 的前端路由。
 */

import { renderAdmin } from "./admin.js";
import { renderSetting } from "./setting.js";
import { renderChannel } from "./channel.js";
// import { renderModelMap } from "./model_map.js";
import { renderKeys } from "./keys.js";
import { renderGallery } from "./gallery.js";

/**
 * 路由配置表
 * 映射路径到页面标题和渲染函数
 * @type {Object.<string, {title: string, render: Function}>}
 */
const routes = {
  "/admin": { title: "仪表盘", render: renderAdmin },
  "/setting": { title: "系统设置", render: renderSetting },
  "/channel": { title: "渠道设置", render: renderChannel },
  // "/model-map": { title: "模型映射", render: renderModelMap },
  "/keys": { title: "后端Key池", render: renderKeys },
  "/pic": { title: "图片画廊", render: renderGallery },
  "/prompt-optimizer": {
    title: "提示词优化器 (PromptOptimizer)",
    render: async (container) => {
      const { renderPromptOptimizer } = await import("./prompt-optimizer.js");
      await renderPromptOptimizer(container);
    },
  },
  "/update": {
    title: "检查更新",
    render: async (container) => {
      const { renderUpdate } = await import("./update.js");
      await renderUpdate(container);
    },
  },
};

/**
 * 初始化路由系统
 *
 * 监听 popstate 事件和全局点击事件，实现无刷新跳转。
 */
export function initRouter() {
  globalThis.addEventListener("popstate", handleLocation);

  // 拦截点击事件以处理路由跳转
  // 代理所有带有 data-link 属性的 <a> 标签
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[data-link]");
    if (link) {
      e.preventDefault();
      navigateTo(link.getAttribute("href"));
    }
  });

  // 处理初始 URL
  handleLocation();
}

/**
 * 编程式路由跳转
 *
 * @param {string} url - 目标路径
 */
export function navigateTo(url) {
  globalThis.history.pushState(null, null, url);
  handleLocation();
}

/**
 * 处理当前位置变更
 *
 * 解析当前 URL，查找匹配的路由，并渲染对应页面。
 */
async function handleLocation() {
  let path = globalThis.location.pathname;

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  // 根路径重定向到默认页面 (仪表盘)
  if (path === "/" || path === "/index.html") {
    path = "/admin";
    globalThis.history.replaceState(null, null, path);
  }

  // 查找路由，未找到则回退到默认路由
  const route = routes[path] || routes["/admin"];

  // 1. 更新页面标题
  document.title = `${route.title} - ImgRouter 管理面板`;

  // 2. 更新顶部 Header 标题
  const headerTitle = document.getElementById("headerTitle");
  if (headerTitle) headerTitle.innerText = route.title;

  // 3. 更新侧边栏导航激活状态
  updateActiveNav(path);

  // 4. 渲染页面内容
  const mainContent = document.getElementById("main-container");
  if (mainContent) {
    // 执行上一个页面的清理函数（如果有）
    // 用于清理定时器、事件监听器等资源
    if (typeof mainContent.cleanup === "function") {
      mainContent.cleanup();
      mainContent.cleanup = null;
    }

    // 清空旧内容
    mainContent.innerHTML = "";
    try {
      await route.render(mainContent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("路由渲染失败:", e);
      mainContent.innerHTML = `
        <div class="card" style="margin: 16px; padding: 16px; border: 1px solid var(--border-color);">
          <div style="font-weight: 600; margin-bottom: 8px; color: var(--text-primary);">页面渲染失败</div>
          <div style="color: var(--text-secondary); font-size: 13px; line-height: 1.6;">${message}</div>
          <div style="margin-top: 12px; color: var(--text-secondary); font-size: 12px;">建议：按 Ctrl + F5 强制刷新；或在浏览器控制台查看详细错误。</div>
        </div>
      `;
    }
  }
}

/**
 * 更新侧边栏导航项的激活状态
 *
 * @param {string} path - 当前激活的路径
 */
function updateActiveNav(path) {
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.remove("active");
    // 兼容 href 属性和 data-href 属性 (用于 onclick 跳转的元素)
    const link = el.getAttribute("href") || el.dataset.href;
    if (link === path) {
      el.classList.add("active");
    }
  });
}
