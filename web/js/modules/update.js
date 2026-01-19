import { apiFetch } from "./utils.js";

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
        }
        .btn-github:hover {
            background: #2f363d;
            transform: translateY(-1px);
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
        .release-notes h1, .release-notes h2, .release-notes h3, .release-notes h4 {
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
            color: var(--text-primary);
        }
        .release-notes h1 { font-size: 2em; border-bottom: 1px solid var(--border-color); padding-bottom: .3em; }
        .release-notes h2 { font-size: 1.5em; border-bottom: 1px solid var(--border-color); padding-bottom: .3em; }
        .release-notes h3 { font-size: 1.25em; }
        .release-notes ul, .release-notes ol {
            padding-left: 2em;
            margin-bottom: 16px;
        }
        .release-notes li { margin-bottom: 0.25em; }
        .release-notes p { margin-bottom: 16px; }
        .release-notes code {
            padding: .2em .4em;
            margin: 0;
            font-size: 85%;
            background-color: rgba(175, 184, 193, 0.2);
            border-radius: 6px;
            font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
        }
        .release-notes pre {
            padding: 16px;
            overflow: auto;
            font-size: 85%;
            line-height: 1.45;
            background-color: #f6f8fa;
            border-radius: 6px;
            margin-bottom: 16px;
        }
        .release-notes pre code {
            background-color: transparent;
            padding: 0;
        }
        .release-notes blockquote {
            padding: 0 1em;
            color: #57606a;
            border-left: .25em solid #d0d7de;
            margin-bottom: 16px;
        }
        .release-notes a { color: #0969da; text-decoration: none; }
        .release-notes a:hover { text-decoration: underline; }
        .release-notes img { max-width: 100%; box-sizing: border-box; background-color: #fff; }
        
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
                    <a href="https://github.com/lianwusuoai/img-router" target="_blank" class="btn-github">
                        <i class="ri-github-fill"></i> 前往 GitHub 仓库
                    </a>
                </div>
                
                <div id="update-content">
                    <div class="loading-state">
                        <div class="loading-spinner"></div>
                        <span>正在检查版本信息...</span>
                    </div>
                </div>
            </div>
        </div>
    `;

  try {
    // 1. 获取本地版本
    const localRes = await apiFetch("/api/info");
    if (!localRes.ok) {
      throw new Error(`本地版本信息获取失败: ${localRes.status}`);
    }
    const localInfo = await localRes.json();
    const localVersionRaw = (localInfo && localInfo.version) ? String(localInfo.version) : "0.0.0";
    const localVersion = normalizeVersion(localVersionRaw);

    // 2. 获取 GitHub 最新版本
    const response = await apiFetch("/api/update/check");
    if (!response.ok) {
      let errorDetail = "";
      try {
        const errJson = await response.json();
        if (errJson.error === "rate_limit") {
          throw new Error("GitHub API 访问受限 (403)。请稍后（约1小时）再试。");
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
    let versionError = null;
    try {
      const comparison = compareVersions(latestVersionNorm, localVersion);
      hasUpdate = comparison > 0;
    } catch (err) {
      console.warn("Version comparison failed:", err);
      versionError = err;
    }

    const releaseNotesHtml = await renderMarkdownToHtml(
      release.body || "",
      "lianwusuoai/img-router",
    );

    // 4. 渲染结果
    const contentDiv = container.querySelector("#update-content");

    let alertHtml = "";
    if (versionError) {
      alertHtml = `
                <div class="alert-box alert-warning">
                    <i class="ri-error-warning-line" style="font-size: 20px;"></i>
                    <div>
                        <strong>版本检测异常</strong>
                        <div style="font-size: 0.9em; margin-top: 4px;">无法比较版本号 (Local: ${localVersion}, Latest: ${latestVersion})</div>
                    </div>
                </div>
            `;
    } else if (hasUpdate) {
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
                    <span class="status-value">${
      formatVersionForDisplay(localVersionRaw)
    } <span class="badge badge-current">Local</span></span>
                </div>
                <div class="status-item">
                    <span class="status-label">最新版本</span>
                    <span class="status-value">${
      formatVersionForDisplay(latestVersionNorm)
    } <span class="badge badge-new">Latest</span></span>
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
  } catch (e) {
    console.error("Check update failed:", e);
    const contentDiv = container.querySelector("#update-content");
    contentDiv.innerHTML = `
            <div class="alert-box alert-warning">
                <i class="ri-error-warning-line"></i>
                <div>
                    <strong>检查更新失败</strong>
                    <div>${e.message}</div>
                </div>
            </div>
            <div style="text-align: center; margin-top: 20px;">
                <button onclick="location.reload()" class="btn-github" style="background: var(--primary);">
                    重试
                </button>
            </div>
        `;
  }
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

/**
 * 版本号比较
 * @param {string} v1 - 最新版本
 * @param {string} v2 - 本地版本
 * @returns {number} 1: v1 > v2, -1: v1 < v2, 0: equal
 */
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
