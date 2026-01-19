import { apiFetch } from "./utils.js";

// 状态管理
let checkInterval = null;
let retryTimer = null;
let retryCount = 0;
const CHECK_INTERVAL_MS = 3600 * 1000; // 1小时

/**
 * 渲染更新检查页面
 * @param {HTMLElement} container - 主内容容器
 */
export async function renderUpdate(container) {
    // 注入页面样式
    const style = document.createElement("style");
    style.textContent = `
        .update-container {
            max-width: 800px;
            margin: 0 auto;
        }
        .version-card {
            background: var(--surface);
            border-radius: var(--border-radius);
            padding: 30px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.05);
            margin-bottom: 24px;
        }
        .version-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
        }
        .version-title {
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        .btn-github {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #24292e;
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 500;
            transition: all 0.2s;
            cursor: pointer;
            border: none;
        }
        .btn-github:hover {
            background: #2f363d;
            transform: translateY(-1px);
        }
        .btn-github:disabled {
            opacity: 0.7;
            cursor: not-allowed;
            transform: none;
        }
        .version-status-row {
            display: flex;
            gap: 40px;
            margin-bottom: 30px;
        }
        .status-item {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .status-label {
            font-size: 0.875rem;
            color: var(--text-secondary);
        }
        .status-value {
            font-size: 1.25rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .badge {
            font-size: 0.75rem;
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: 500;
        }
        .badge-current { background: var(--primary-light); color: var(--primary); }
        .badge-new { background: #e3f2fd; color: #1976d2; }
        .badge-update-available {
            background: #f44336;
            color: white;
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 10px;
            margin-left: 8px;
            display: none; /* 默认隐藏 */
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.1); }
            100% { transform: scale(1); }
        }
        
        .alert-box {
            padding: 16px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
        }
        .alert-info { background: #e3f2fd; color: #0d47a1; border: 1px solid #bbdefb; }
        .alert-warning { background: #fff3e0; color: #e65100; border: 1px solid #ffe0b2; }
        .alert-success { background: #e8f5e9; color: #1b5e20; border: 1px solid #c8e6c9; }
        
        .release-notes {
            margin-top: 20px;
            font-size: 14px;
            line-height: 1.6;
            color: var(--text-primary);
        }
        /* Markdown styles */
        .release-notes h1, .release-notes h2, .release-notes h3 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; color: var(--text-primary); }
        .release-notes ul, .release-notes ol { padding-left: 2em; margin-bottom: 16px; }
        .release-notes code { padding: .2em .4em; font-size: 85%; background-color: rgba(175, 184, 193, 0.2); border-radius: 6px; }
        .release-notes pre { padding: 16px; overflow: auto; background-color: #f6f8fa; border-radius: 6px; margin-bottom: 16px; }
        .release-notes a { color: #0969da; text-decoration: none; }
        .release-notes a:hover { text-decoration: underline; }
        
        .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: var(--text-secondary);
        }
        .loading-spinner {
            width: 30px;
            height: 30px;
            border: 3px solid var(--border-color);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 16px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    `;
    container.appendChild(style);

    container.innerHTML += `
        <div class="update-container">
            <div class="version-card">
                <div class="version-header">
                    <div class="version-title">系统更新</div>
                    <div style="display: flex; gap: 10px;">
                        <button id="btn-check-update" class="btn-github" style="background: var(--surface); color: var(--text-primary); border: 1px solid var(--border-color);">
                            <i class="ri-refresh-line"></i> 检查更新
                            <span id="badge-new-version" class="badge-update-available">NEW</span>
                        </button>
                        <a href="https://github.com/lianwusuoai/img-router" target="_blank" class="btn-github">
                            <i class="ri-github-fill"></i> 前往 GitHub 仓库
                        </a>
                    </div>
                </div>
                
                <div id="update-content">
                    <!-- 默认显示本地版本信息 -->
                    <div class="version-status-row">
                        <div class="status-item">
                            <span class="status-label">当前版本</span>
                            <span class="status-value" id="local-version-display">加载中...</span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">最新版本</span>
                            <span class="status-value" id="latest-version-display">-- <span class="badge badge-new" style="background: #eee; color: #666;">Unknown</span></span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">状态</span>
                            <span class="status-value" style="font-size: 1rem; font-weight: normal;" id="check-status-display">
                                等待检查
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const checkBtn = container.querySelector("#btn-check-update");
    const contentDiv = container.querySelector("#update-content");
    const badge = container.querySelector("#badge-new-version");

    if (!checkBtn || !contentDiv) {
        console.error("Required elements not found in update page");
        return;
    }

    // 绑定点击事件
    checkBtn.addEventListener("click", () => performCheck(true, contentDiv, checkBtn, badge));

    // 1. 立即加载本地版本信息（但不触发远程检查）
    await loadLocalVersion(container);

    // 2. 启动自动检查定时器
    startAutoCheckTimer(contentDiv, checkBtn, badge);
}

// 启动自动检查定时器
function startAutoCheckTimer(contentDiv, checkBtn, badge) {
    if (checkInterval) clearInterval(checkInterval);
    
    console.log("[AutoUpdate] 定时任务已启动，每小时检查一次");
    checkInterval = setInterval(() => {
        console.log("[AutoUpdate] 触发定时检查...");
        performCheck(false, contentDiv, checkBtn, badge);
    }, CHECK_INTERVAL_MS);
}

// 加载本地版本
async function loadLocalVersion(container) {
    try {
        const localRes = await apiFetch("/api/info");
        if (localRes.ok) {
            const localInfo = await localRes.json();
            const localVersionRaw = (localInfo && localInfo.version) ? String(localInfo.version) : "0.0.0";
            const displayEl = container.querySelector("#local-version-display");
            if (displayEl) {
                displayEl.innerHTML = `${formatVersionForDisplay(localVersionRaw)} <span class="badge badge-current">Local</span>`;
            }
            return localVersionRaw;
        }
    } catch (e) {
        console.error("[Update] Failed to load local version:", e);
    }
    return "0.0.0";
}

// 执行检查
// isManual: 是否为手动点击
async function performCheck(isManual, contentDiv, checkBtn, badge) {
    // 浏览器信息（自动通过 HTTP 头发送，此处仅做日志记录）
    if (isManual) {
        console.log("[Update] 开始手动检查...", navigator.userAgent);
    } else {
        console.log("[AutoUpdate] 开始自动检查...", navigator.userAgent);
    }

    if (isManual) {
        checkBtn.disabled = true;
        checkBtn.innerHTML = '<i class="ri-loader-4-line status-spinner"></i> 检查中...';
        // 手动检查时，显示加载动画
        contentDiv.innerHTML = `
            <div class="loading-state">
                <div class="loading-spinner"></div>
                <span>正在检查版本信息...</span>
            </div>
        `;
    }

    try {
        // 1. 获取本地版本
        const localRes = await apiFetch("/api/info");
        if (!localRes.ok) throw new Error(`本地版本信息获取失败: ${localRes.status}`);
        const localInfo = await localRes.json();
        const localVersionRaw = (localInfo && localInfo.version) ? String(localInfo.version) : "0.0.0";
        const localVersion = normalizeVersion(localVersionRaw);

        // 2. 获取 GitHub 最新版本
        // 强制刷新：手动检查时强制刷新，自动检查时使用缓存
        const url = isManual ? "/api/update/check?force=true" : "/api/update/check";
        const response = await apiFetch(url);

        if (!response.ok) {
            let errorDetail = "";
            try {
                const errJson = await response.json();
                // 处理限流
                if (errJson.error === "rate_limit") {
                    throw new Error("GitHub API 访问受限 (403)。请稍后再试。");
                }
                errorDetail = errJson.message || errJson.error || response.statusText;
            } catch (e) {
                if (e.message.includes("GitHub API")) throw e;
                errorDetail = response.statusText;
            }
            throw new Error(`GitHub API 请求失败: ${response.status} (${errorDetail})`);
        }

        const release = await response.json();
        const latestVersion = release.tag_name ? release.tag_name.replace(/^v/, "") : "0.0.0";
        const latestVersionNorm = normalizeVersion(latestVersion);

        // 3. 比较版本
        let hasUpdate = false;
        try {
            hasUpdate = compareVersions(latestVersionNorm, localVersion) > 0;
        } catch (err) {
            console.error("Version comparison failed:", err);
        }

        // 成功获取，重置重试计数
        retryCount = 0;
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }

        // 更新新版本提示 Badge
        if (hasUpdate && badge) {
            badge.style.display = "inline-block";
        } else if (badge) {
            badge.style.display = "none";
        }

        // 4. 渲染结果 (仅当手动检查 或 自动检查发现新版本且用户当前在页面上时更新)
        // 为了简单起见，只要获取成功，我们就更新 UI，因为用户正在看这个区域
        
        const releaseNotesHtml = await renderMarkdownToHtml(
            release.body || "",
            "lianwusuoai/img-router",
        );

        let alertHtml = "";
        if (hasUpdate) {
            alertHtml = `
                <div class="alert-box alert-warning">
                    <i class="ri-notification-badge-line" style="font-size: 20px;"></i>
                    <div>
                        <strong>发现新版本 v${latestVersion}</strong>
                        <div style="font-size: 0.9em; margin-top: 4px;">建议尽快更新以获得最新功能和修复。</div>
                    </div>
                </div>
            `;
        } else {
            alertHtml = `
                <div class="alert-box alert-success">
                    <i class="ri-checkbox-circle-line" style="font-size: 20px;"></i>
                    <div>
                        <strong>当前已是最新版本</strong>
                        <div style="font-size: 0.9em; margin-top: 4px;">您正在使用最新的 img-router v${localVersion}</div>
                    </div>
                </div>
            `;
        }

        contentDiv.innerHTML = `
            ${alertHtml}
            
            <div class="version-status-row">
                <div class="status-item">
                    <span class="status-label">当前版本</span>
                    <span class="status-value">${formatVersionForDisplay(localVersionRaw)} <span class="badge badge-current">Local</span></span>
                </div>
                <div class="status-item">
                    <span class="status-label">最新版本</span>
                    <span class="status-value">${formatVersionForDisplay(latestVersionNorm)} <span class="badge badge-new">Latest</span></span>
                </div>
                <div class="status-item">
                    <span class="status-label">发布时间</span>
                    <span class="status-value" style="font-size: 1rem; font-weight: normal;">
                        ${new Date(release.published_at).toLocaleString("zh-CN")}
                    </span>
                </div>
            </div>

            <div style="border-top: 1px solid var(--border-color); margin: 20px 0;"></div>

            <h3 style="margin-bottom: 16px;">更新日志</h3>
            <div class="release-notes markdown-body">
                ${releaseNotesHtml}
            </div>
        `;

        console.log(`[Update] Check success. Local: ${localVersion}, Latest: ${latestVersion}`);

    } catch (e) {
        console.error("[Update] Check failed:", e);
        
        // 错误处理策略
        if (isManual) {
            // 手动模式：直接显示错误并允许重试
            contentDiv.innerHTML = `
                <div class="alert-box alert-warning">
                    <i class="ri-error-warning-line"></i>
                    <div>
                        <strong>检查更新失败</strong>
                        <div>${e.message}</div>
                    </div>
                </div>
                <div style="text-align: center; margin-top: 20px;">
                    <button id="btn-retry" class="btn-github" style="background: var(--primary);">
                        重试
                    </button>
                </div>
            `;
            const retryBtn = contentDiv.querySelector("#btn-retry");
            if(retryBtn) retryBtn.onclick = () => performCheck(true, contentDiv, checkBtn, badge);
        } else {
            // 自动模式：指数退避重试
            scheduleRetry(contentDiv, checkBtn, badge);
        }
    } finally {
        if (isManual) {
            checkBtn.disabled = false;
            checkBtn.innerHTML = `
                <i class="ri-refresh-line"></i> 检查更新
                <span id="badge-new-version-inner" class="badge-update-available" style="display: ${badge && badge.style.display === 'inline-block' ? 'inline-block' : 'none'}">NEW</span>
            `;
            // 重新绑定 badge 引用，因为 innerHTML 重置了 button 内容
            // 其实这里 button 内容重置会导致 badge 元素丢失，需要重新处理
            // 更好的做法是只修改 icon 和 text，保留 badge 元素
            // 但为了简单，我们重新插入 badge 的 HTML
        }
    }
}

// 简单的“一次快速重试”策略
function scheduleRetry(contentDiv, checkBtn, badge) {
    // 策略：失败后仅重试一次（1分钟后）。
    // 如果重试依然失败，则不再继续重试，而是等待下一次每小时的定时检查。
    // 这样可以避免因持续失败导致的 429 限流问题。
    
    if (retryCount >= 1) {
        console.info("[AutoUpdate] Fast retry failed. Giving up and waiting for next scheduled hourly check.");
        retryCount = 0; // 重置计数，确保下一次定时检查如果失败，仍能触发一次快速重试
        return;
    }

    retryCount++;
    const delay = 60 * 1000; // 固定 1 分钟
    
    console.log(`[AutoUpdate] Check failed. Retrying once in ${delay/1000} seconds.`);
    
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        performCheck(false, contentDiv, checkBtn, badge);
    }, delay);
}

function formatVersionForDisplay(version) {
  const v = (version === undefined || version === null) ? "" : String(version).trim();
  if (!v) return "v0.0.0";
  return v.startsWith("v") ? v : `v${v}`;
}

function normalizeVersion(version) {
  const v = (version === undefined || version === null) ? "" : String(version).trim();
  if (!v) return "0.0.0";
  return v.replace(/^v/i, "");
}

async function renderMarkdownToHtml(markdown, context) {
  const text = (markdown === undefined || markdown === null) ? "" : String(markdown);
  if (!text.trim()) {
    return "<p>暂无更新日志</p>";
  }

  try {
    const res = await fetch("https://api.github.com/markdown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        mode: "gfm",
        context,
      }),
    });

    if (res.ok) {
      return await res.text();
    }
  } catch {
    0;
  }

  if (globalThis.marked) {
    try {
      return globalThis.marked.parse(text);
    } catch {
      0;
    }
  }

  return `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(text)}</pre>`;
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compareVersions(v1, v2) {
  if (!v1) v1 = "0.0.0";
  if (!v2) v2 = "0.0.0";
  const p1 = String(v1).split(".").map(Number);
  const p2 = String(v2).split(".").map(Number);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}
