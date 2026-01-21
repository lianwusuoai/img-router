/**
 * 仪表盘 (Admin) 模块
 *
 * 负责渲染主控台页面，展示系统状态、渠道状态和实时日志。
 * 包含 WebSocket/SSE 日志流的处理逻辑。
 */

import { apiFetch, detectApiKey, escapeHtml, providerMeta } from "./utils.js";

// 日志相关状态
let logEventSource = null;
let logAutoScroll = true;
let logLevel = localStorage.getItem("logLevel") || "INFO";
const maxLogEntries = 500;

/**
 * 渲染仪表盘页面
 *
 * @param {HTMLElement} container - 容器元素
 */
export async function renderAdmin(container) {
  container.innerHTML = `
        <div class="dashboard-grid">
            <!-- 系统状态 (单行) -->
            <div class="card full-width" style="padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; min-height: 60px;">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <h3 class="card-title" style="margin: 0;">系统状态</h3>
                    <div class="status-pill">
                        <span class="status-dot"></span>
                        <span>运行中</span>
                    </div>
                </div>
                <div style="display: flex; gap: 40px; color: var(--text-secondary); font-size: 14px;">
                    <div>端口 <span id="dash-port" style="color: var(--text-primary); font-weight: 600; margin-left: 8px;">...</span></div>
                    <div>版本 <span id="dash-version" style="color: var(--text-primary); font-weight: 600; margin-left: 8px;">...</span></div>
                    <div>模式 <span id="dash-mode" style="color: var(--text-primary); font-weight: 600; margin-left: 8px;">...</span></div>
                </div>
            </div>

            <!-- 渠道状态 (单行) -->
            <div class="card full-width" style="padding: 12px 20px; display: flex; align-items: center; min-height: 60px;">
                <h3 class="card-title" style="margin: 0; margin-right: 24px; white-space: nowrap;">渠道状态</h3>
                <div id="dashboardChannels" style="display: flex; gap: 12px; flex-wrap: wrap; flex: 1;">
                    <!-- 动态生成 -->
                </div>
            </div>

            <!-- 实时日志 -->
            <div class="card full-width" style="display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0;">
                <div class="card-header" style="padding: 12px 24px; border-bottom: 1px solid var(--border-color); margin-bottom: 0;">
                    <h3 class="card-title">实时日志</h3>
                    <div class="log-controls">
                        <span style="font-size: 13px; color: var(--text-secondary); font-weight: 500;">日志等级</span>
                        <select id="logLevelSelect" class="form-control" style="width:auto; padding:4px 24px 4px 8px; height: 32px;">
                            <option value="DEBUG">DEBUG</option>
                            <option value="INFO">INFO</option>
                            <option value="ERROR">ERROR</option>
                        </select>
                        
                        <div style="width: 1px; height: 16px; background: var(--border-color); margin: 0 4px;"></div>

                        <button id="logAutoScrollBtn" class="btn icon-btn active" title="自动滚动：开启后将始终显示最新日志" style="font-size: 13px; gap: 4px; padding: 4px 8px;">
                            <i class="ri-arrow-down-circle-line"></i> 自动滚动
                        </button>
                        <button id="logClearBtn" class="btn icon-btn" title="清空日志" style="font-size: 13px; gap: 4px; padding: 4px 8px;">
                            <i class="ri-delete-bin-line"></i> 清空日志
                        </button>

                        <div style="width: 1px; height: 16px; background: var(--border-color); margin: 0 4px;"></div>

                        <button id="logScrollTopBtn" class="btn icon-btn" title="回到顶部" style="padding: 4px 8px;">
                            <i class="ri-arrow-up-line"></i>
                        </button>
                        <button id="logScrollBottomBtn" class="btn icon-btn" title="回到底部" style="padding: 4px 8px;">
                            <i class="ri-arrow-down-line"></i>
                        </button>

                        <div class="status-pill" style="margin-left:10px">
                            <span class="status-dot" id="logStatusDot"></span>
                            <span id="logStatusText">未连接</span>
                        </div>
                    </div>
                </div>
                <div id="logContent" class="log-content" data-filter="${logLevel}" style="border-radius: 0; border: none; background: #1e1e2e;">
                    <div class="log-empty">等待日志...</div>
                </div>
            </div>
        </div>
    `;

  // 初始化日志等级选择
  const logLevelSelect = document.getElementById("logLevelSelect");
  logLevelSelect.value = logLevel;
  logLevelSelect.addEventListener("change", (e) => {
    logLevel = e.target.value;
    localStorage.setItem("logLevel", logLevel);
    document.getElementById("logContent").dataset.filter = logLevel;
  });

  // 初始化自动滚动按钮
  const autoScrollBtn = document.getElementById("logAutoScrollBtn");
  autoScrollBtn.addEventListener("click", () => {
    logAutoScroll = !logAutoScroll;
    if (logAutoScroll) {
      autoScrollBtn.classList.add("active");
      const logContent = document.getElementById("logContent");
      logContent.scrollTop = logContent.scrollHeight;
    } else {
      autoScrollBtn.classList.remove("active");
    }
  });

  // 初始化清空日志按钮
  document.getElementById("logClearBtn").addEventListener("click", () => {
    document.getElementById("logContent").innerHTML = '<div class="log-empty">等待日志...</div>';
  });

  // 初始化回到顶部按钮
  document.getElementById("logScrollTopBtn").addEventListener("click", () => {
    const logContent = document.getElementById("logContent");
    logContent.scrollTop = 0;
  });

  // 初始化回到底部按钮
  document.getElementById("logScrollBottomBtn").addEventListener("click", () => {
    const logContent = document.getElementById("logContent");
    logContent.scrollTop = logContent.scrollHeight;
  });

  // 加载系统状态数据
  await loadDashboardData();

  // 连接实时日志流
  connectLogStream();

  // 注册清理函数 (在路由切换时调用)
  container.cleanup = () => {
    if (logEventSource) {
      logEventSource.close();
      logEventSource = null;
    }
  };
}

/**
 * 加载仪表盘基础数据
 */
async function loadDashboardData() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();

    document.getElementById("dash-port").innerText = config.port;
    document.getElementById("dash-version").innerText = config.version || "v1.7.3";

    const runtimeSystem = (config.runtimeConfig && config.runtimeConfig.system)
      ? config.runtimeConfig.system
      : {};
    const modes = runtimeSystem.modes || { relay: true, backend: false };
    const modeStr = [];
    if (modes.relay) modeStr.push("中转");
    if (modes.backend) modeStr.push("后端");
    document.getElementById("dash-mode").innerText = modeStr.join(" + ") || "无";

    renderDashboardChannels(config);
  } catch (e) {
    console.error("加载仪表盘数据失败:", e);
  }
}

/**
 * 渲染渠道状态徽章
 *
 * @param {Object} config - 系统配置
 */
function renderDashboardChannels(config) {
  const container = document.getElementById("dashboardChannels");
  if (!container) return;
  container.innerHTML = "";

  const providers = config.providers || [];
  const runtimeSystem = (config.runtimeConfig && config.runtimeConfig.system)
    ? config.runtimeConfig.system
    : {};
  const modes = runtimeSystem.modes || { relay: true, backend: false };
  const isRelay = modes.relay;
  const isBackend = modes.backend;

  for (const p of providers) {
    const meta = providerMeta[p.name] ||
      { icon: "ri-server-line", color: "#666", desc: "未知渠道" };
    const isEnabled = p.enabled !== false;

    let isConfigured = false;
    if (p.name === "Doubao") {
      isConfigured = config.doubaoConfigured || detectApiKey(config.globalAccessKey, "Doubao");
    } else if (p.name === "Gitee") {
      isConfigured = config.giteeConfigured || detectApiKey(config.globalAccessKey, "Gitee");
    } else if (p.name === "ModelScope") {
      isConfigured = config.modelscopeConfigured ||
        detectApiKey(config.globalAccessKey, "ModelScope");
    } else if (p.name === "HuggingFace") {
      isConfigured = config.hfConfigured || detectApiKey(config.globalAccessKey, "HuggingFace");
    } else if (p.name === "Pollinations") isConfigured = true;

    // 状态判定逻辑
    let statusIcon = "ri-question-line";
    let statusText = "未知";
    let opacity = "1";

    if (!isRelay && !isBackend) {
      statusIcon = "ri-forbid-line";
      statusText = "未启用";
      opacity = "0.5";
    } else if (isRelay) {
      if (isEnabled) {
        statusIcon = "ri-check-line";
        statusText = "已启用";
      } else {
        statusIcon = "ri-forbid-line";
        statusText = "未启用";
        opacity = "0.5";
      }
    } else if (isBackend) {
      if (isEnabled) {
        if (isConfigured) {
          statusIcon = "ri-check-line";
          statusText = "已启用";
        } else {
          statusIcon = "ri-close-line";
          statusText = "缺Key";
        }
      } else {
        statusIcon = "ri-forbid-line";
        statusText = "已禁用";
        opacity = "0.5";
      }
    }

    const html = `
            <div class="channel-badge" style="display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: #f8f9fa; border: 1px solid var(--border-color); border-radius: 8px; opacity: ${opacity};" title="${statusText}">
                <i class="${meta.icon}" style="font-size: 16px; color: ${meta.color};"></i>
                <span style="font-weight: 500; font-size: 13px;">${p.name}</span>
                <i class="${statusIcon}" style="font-size: 14px; margin-left: 4px; color: var(--text-secondary);"></i>
            </div>
        `;
    container.innerHTML += html;
  }

  // 更新图标颜色
  const badges = container.querySelectorAll(".channel-badge");
  badges.forEach((el) => {
    const icon = el.lastElementChild;
    if (icon.classList.contains("ri-check-line")) icon.style.color = "var(--success)";
    if (icon.classList.contains("ri-close-line")) icon.style.color = "var(--error)";
  });
}

/**
 * 连接日志流 (SSE)
 */
function connectLogStream() {
  if (logEventSource) {
    logEventSource.close();
  }

  const url = `/api/logs/stream?level=DEBUG`;
  logEventSource = new EventSource(url);

  logEventSource.onopen = () => {
    updateLogStatus(true);
  };

  logEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        appendLogEntry(data);
      } else if (data.type === "connected") {
        appendLogEntry({
          timestamp: new Date().toISOString(),
          level: "INFO",
          message: `日志流已连接`,
        });
      }
    } catch (e) {
      console.error("解析日志失败:", e);
    }
  };

  logEventSource.onerror = () => {
    updateLogStatus(false);
  };
}

/**
 * 更新日志连接状态指示器
 *
 * @param {boolean} connected - 是否连接成功
 */
function updateLogStatus(connected) {
  const dot = document.getElementById("logStatusDot");
  const text = document.getElementById("logStatusText");
  if (!dot || !text) return;

  if (connected) {
    dot.classList.add("connected");
    text.textContent = "已连接";
  } else {
    dot.classList.remove("connected");
    text.textContent = "未连接";
  }
}

// 日志去重相关变量
let lastLogEntry = null;
let lastLogElement = null;
let repeatCount = 0;

/**
 * 追加日志条目到界面
 *
 * 包含简单的日志去重逻辑，相同日志会增加计数而不是重复显示。
 *
 * @param {Object} entry - 日志对象 {timestamp, level, message}
 */
function appendLogEntry(entry) {
  const container = document.getElementById("logContent");
  if (!container) return;

  // 日志去重/聚合逻辑
  if (
    lastLogEntry &&
    lastLogEntry.level === entry.level &&
    lastLogEntry.message === entry.message
  ) {
    repeatCount++;
    if (lastLogElement) {
      const countBadge = lastLogElement.querySelector(".log-repeat-count");
      if (countBadge) {
        countBadge.textContent = `x${repeatCount + 1}`;
      } else {
        const badge = document.createElement("span");
        badge.className = "log-repeat-count";
        badge.textContent = `x${repeatCount + 1}`;
        badge.style.cssText =
          "margin-left: 8px; font-size: 10px; background: rgba(255,255,255,0.1); padding: 0 4px; border-radius: 4px; color: var(--text-secondary);";
        lastLogElement.querySelector(".log-message").appendChild(badge);
      }

      // 更新时间
      const timeStr = new Date(entry.timestamp).toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      lastLogElement.querySelector(".log-time").textContent = timeStr;

      if (logAutoScroll) {
        container.scrollTop = container.scrollHeight;
      }
      return;
    }
  }

  lastLogEntry = entry;
  repeatCount = 0;

  const empty = container.querySelector(".log-empty");
  if (empty) {
    empty.remove();
  }

  const div = document.createElement("div");
  div.className = `log-entry ${entry.level}`;
  lastLogElement = div;

  const time = new Date(entry.timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  div.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-level ${entry.level}">${entry.level}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
    `;

  container.appendChild(div);

  // 限制最大日志条数，避免 DOM 节点过多
  while (container.children.length > maxLogEntries) {
    container.removeChild(container.firstChild);
  }

  if (logAutoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}
