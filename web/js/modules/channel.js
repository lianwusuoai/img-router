/**
 * 渠道设置模块
 *
 * 负责渲染和管理各个 Provider 的详细配置。
 * 包括模型选择、尺寸设置、质量选项以及启用/禁用状态。
 * 支持动态加载支持的尺寸列表。
 */

import { apiFetch, debounce } from "./utils.js";

let currentConfig = {};
let channelSupportedSizes = [];
let channelRuntimeConfig = { providers: {} };

const DOUBAO_SIZES_4_0 = [
  "1024x1024",
  "2048x2048",
  "2304x1728",
  "1728x2304",
  "2560x1440",
  "1440x2560",
  "2496x1664",
  "1664x2496",
  "3024x1296",
];

const DOUBAO_SIZES_4_5 = [
  "2048x2048",
  "2304x1728",
  "1728x2304",
  "2560x1440",
  "1440x2560",
  "2496x1664",
  "1664x2496",
  "3024x1296",
];

const MODELSCOPE_SIZES_TEXT = [
  "1024x1024",
  "720x1280",
  "864x1152",
  "1152x864",
  "1280x720",
];

const MODELSCOPE_SIZES_EDIT = [
  "1328x1328",
  "928x1664",
  "1104x1472",
  "1472x1104",
  "1664x928",
  "1664x1664",
  "1024x1024",
];

const POLLINATIONS_SIZES = [
  "1024x1024",
  "768x1024",
  "1024x768",
  "720x1280",
  "1280x720",
  "512x512",
  "256x256",
];

function parsePixelSize(size) {
  const m = String(size || "").match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function formatSizeWithRatio(size) {
  const parsed = parsePixelSize(size);
  if (!parsed) return String(size);

  if (parsed.width === 928 && parsed.height === 1664) {
    return `9:16 ${size}`;
  }

  if (parsed.width === 1664 && parsed.height === 928) {
    return `16:9 ${size}`;
  }

  // 特殊处理 21:9 的尺寸
  if (parsed.width === 3024 && parsed.height === 1296) {
    return `21:9 ${size}`;
  }

  const d = gcd(parsed.width, parsed.height);
  const rw = parsed.width / d;
  const rh = parsed.height / d;
  return `${rw}:${rh} ${size}`;
}

/**
 * 渲染渠道设置页面
 *
 * @param {HTMLElement} container - 容器元素
 */
export async function renderChannel(container) {
  container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">渠道设置</h3>
                <div class="status-pill">
                    <span class="status-dot"></span>
                    <span>运行中</span>
                </div>
            </div>
            <div id="channelsContainer">
                <div class="loading">加载中...</div>
            </div>
        </div>
    `;

  // 事件委托处理变更
  // 监听所有配置项的变动并触发自动保存
  container.addEventListener("change", (e) => {
    // 监听豆包模型变化，动态更新尺寸列表
    if (e.target.dataset.field === "model" && e.target.dataset.provider === "Doubao") {
      updateDoubaoSizeOptions(e.target);
    }

    // 监听 ModelScope 模型变化，动态更新尺寸列表
    if (e.target.dataset.field === "model" && e.target.dataset.provider === "ModelScope") {
      updateModelScopeSizeOptions(e.target);
    }

    // 检查是否是配置项 (带有 data-provider 属性)
    if (e.target.dataset.provider) {
      debounceSave();
    }

    // 监听编辑映射按钮点击
    if (e.target.id === "btn-edit-hf-map") {
      showModelMapEditor();
    }
  });

  // 加载配置
  await loadChannelConfig();
}

/**
 * 显示模型映射编辑器弹窗
 */
function showModelMapEditor() {
  const provider = currentConfig.providers.find((p) => p.name === "HuggingFace");
  if (!provider) return;

  const modelMap = provider.modelMap || {};
  const modalId = "modal-hf-model-map";
  let modal = document.getElementById(modalId);

  if (!modal) {
    modal = document.createElement("div");
    modal.id = modalId;
    modal.className = "modal";
    document.body.appendChild(modal);
  }

  const rowsHtml = Object.entries(modelMap).map(([name, url]) => `
    <div class="model-map-row" style="display: flex; gap: 8px; margin-bottom: 8px;">
      <input type="text" class="input model-name" placeholder="模型名称 (如 Flux.1)" value="${name}" style="flex: 1;">
      <input type="text" class="input model-url" placeholder="Space URL (如 black-forest-labs/FLUX.1-schnell)" value="${url}" style="flex: 2;">
      <button class="btn-icon btn-remove-row" style="color: red;"><i class="ri-delete-bin-line"></i></button>
    </div>
  `).join("");

  modal.innerHTML = `
    <div class="modal-content" style="max-width: 600px;">
      <div class="modal-header">
        <h3 class="modal-title">HuggingFace 模型映射配置</h3>
        <button class="btn-icon modal-close"><i class="ri-close-line"></i></button>
      </div>
      <div class="modal-body">
        <div id="modelMapList">
          ${rowsHtml}
          ${
    Object.keys(modelMap).length === 0
      ? '<div class="empty-text" style="text-align:center; padding: 20px; color: #888;">暂无映射，点击下方按钮添加</div>'
      : ""
  }
        </div>
        <button class="btn btn-secondary" id="btnAddMapRow" style="width: 100%; margin-top: 8px;">
          <i class="ri-add-line"></i> 添加映射
        </button>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">取消</button>
        <button class="btn btn-primary" id="btnSaveModelMap">保存配置</button>
      </div>
    </div>
  `;

  modal.style.display = "flex";

  // 内部事件监听
  modal.querySelector(".modal-close").onclick = () => modal.style.display = "none";
  modal.querySelectorAll(".modal-close")[1].onclick = () => modal.style.display = "none";

  modal.querySelector("#btnAddMapRow").onclick = () => {
    const row = document.createElement("div");
    row.className = "model-map-row";
    row.style = "display: flex; gap: 8px; margin-bottom: 8px;";
    row.innerHTML = `
      <input type="text" class="input model-name" placeholder="模型名称" style="flex: 1;">
      <input type="text" class="input model-url" placeholder="Space URL" style="flex: 2;">
      <button class="btn-icon btn-remove-row" style="color: red;"><i class="ri-delete-bin-line"></i></button>
    `;
    const list = modal.querySelector("#modelMapList");
    const empty = list.querySelector(".empty-text");
    if (empty) empty.remove();
    list.appendChild(row);
  };

  modal.addEventListener("click", (e) => {
    if (e.target.closest(".btn-remove-row")) {
      e.target.closest(".model-map-row").remove();
    }
  });

  modal.querySelector("#btnSaveModelMap").onclick = async () => {
    const newMap = {};
    modal.querySelectorAll(".model-map-row").forEach((row) => {
      const name = row.querySelector(".model-name").value.trim();
      const url = row.querySelector(".model-url").value.trim();
      if (name && url) newMap[name] = url;
    });

    provider.modelMap = newMap;
    modal.style.display = "none";
    await debounceSave();
    alert("映射配置已保存，请刷新页面以应用到模型选择框。");
  };
}

/**
 * 加载渠道配置
 */
async function loadChannelConfig() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    currentConfig = config;

    channelSupportedSizes = Array.isArray(config.supportedSizes) ? config.supportedSizes : [];
    channelRuntimeConfig = config.runtimeConfig || { providers: {} };

    const providers = Array.isArray(config.providers) ? config.providers : [];
    renderAllChannels(providers);
  } catch (e) {
    console.error("Failed to load channel config:", e);
    document.getElementById("channelsContainer").innerHTML =
      '<div style="padding:20px; text-align:center; color:red;">加载失败</div>';
  }
}

/**
 * 渲染所有渠道的配置卡片
 *
 * @param {Array<Object>} providers - Provider 列表
 */
function renderAllChannels(providers) {
  const container = document.getElementById("channelsContainer");
  if (!container) return;

  container.innerHTML = "";

  for (const provider of providers) {
    // 获取运行时配置中的默认值
    // 兼容大小写：尝试直接匹配或转小写匹配
    let providerDefaults = (channelRuntimeConfig.providers || {})[provider.name];
    if (!providerDefaults) {
      providerDefaults = (channelRuntimeConfig.providers || {})[provider.name.toLowerCase()] || {};
    }

    // Inject global default steps into provider object for fallback usage in UI
    provider.defaultSteps = providerDefaults.defaultSteps || provider.defaultSteps || 4;

    const textDefaults = providerDefaults.text || {};
    const editDefaults = providerDefaults.edit || {};
    const blendDefaults = providerDefaults.blend || {};
    const isEnabled = provider.enabled !== false;

    let extraConfigHtml = "";
    if (provider.name === "HuggingFace") {
      extraConfigHtml = `
        <div style="padding: 0 0 8px 0; border-bottom: 1px solid var(--border-color); margin-bottom: 8px;">
            <div style="display: flex; gap: 24px; align-items: flex-start;">
                <div class="form-group" style="margin-bottom: 0; flex: 1;">
                    <label class="form-label" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>模型映射 (Model Map)</span>
                        <button class="btn-text" id="btn-edit-hf-map" style="font-size: 12px; color: var(--primary); background: none; border: none; cursor: pointer; padding: 0;">编辑映射</button>
                    </label>
                    <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                        配置模型名称到具体 Space URL 的映射关系。
                    </div>
                </div>
            </div>
        </div>
      `;
    }

    const section = document.createElement("div");
    section.className = "form-section";
    section.style.padding = "6px 16px";
    section.style.marginBottom = "8px";
    section.innerHTML = `
            <div class="form-header" style="display:flex; justify-content:space-between; align-items:center; padding-bottom: 2px; margin-bottom: 4px;">
                <h3 class="card-title" style="font-size: 0.9rem;">
                    ${provider.name} 
                    <span style="font-size: 0.7rem; color: #888; font-weight: normal; margin-left: 8px;">
                        (Text: ${provider.textModels.length}, Edit: ${
      provider.editModels ? provider.editModels.length : 0
    })
                    </span>
                </h3>
                <div style="display:flex; align-items:center; gap:10px;">
                    <label class="switch" style="transform: scale(0.8);">
                        <input type="checkbox" data-provider="${provider.name}" data-field="enabled" ${
      isEnabled ? "checked" : ""
    }>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            ${extraConfigHtml}
            <div class="channel-table" style="${
      isEnabled ? "" : "opacity:0.5; pointer-events:none; transition: opacity 0.3s;"
    }">
                <div class="channel-row">
                    <div class="channel-header">权重</div>
                    <div class="channel-header">模型映射 (自定义ID)</div>
                    <div class="channel-header">渠道名称</div>
                    <div class="channel-header">模型</div>
                    <div class="channel-header">尺寸</div>
                    <div class="channel-header">质量</div>
                    <div class="channel-header">生图数量</div>
                    <div class="channel-header">生图步数</div>
                </div>
                <div class="channel-row">
                    <div class="channel-cell">${
      buildWeightInput(provider, textDefaults.weight, "text")
    }</div>
                    <div class="channel-cell">${
      buildModelMapInput(provider, textDefaults.modelMap, "text")
    }</div>
                    <div class="channel-label" title="只看本次发送的文字进行生图">
                        <i class="ri-image-add-line"></i>
                        <span>文生图</span>
                    </div>
                    <div class="channel-cell">${
      buildModelSelect(provider, "text", textDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildSizeSelect(provider, "text", textDefaults.size, textDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildQualitySelect(provider, textDefaults.quality, "text")
    }</div>
                    <div class="channel-cell">${
      buildCountSelect(provider, textDefaults.n, "text")
    }</div>
                    <div class="channel-cell">${
      buildStepsInput(provider, textDefaults.steps, "text")
    }</div>
                </div>
                <div class="channel-row">
                    <div class="channel-cell">${
      buildWeightInput(provider, editDefaults.weight, "edit")
    }</div>
                    <div class="channel-cell">${
      buildModelMapInput(provider, editDefaults.modelMap, "edit")
    }</div>
                    <div class="channel-label" title="只看本次发送的图片和文字进行生图">
                        <i class="ri-edit-2-line"></i>
                        <span>图片编辑</span>
                    </div>
                    <div class="channel-cell">${
      buildModelSelect(provider, "edit", editDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildSizeSelect(provider, "edit", editDefaults.size, editDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildQualitySelect(provider, editDefaults.quality, "edit")
    }</div>
                    <div class="channel-cell">${
      buildCountSelect(provider, editDefaults.n, "edit")
    }</div>
                    <div class="channel-cell">${
      buildStepsInput(provider, editDefaults.steps, "edit")
    }</div>
                </div>
                <div class="channel-row">
                    <div class="channel-cell">${
      buildWeightInput(provider, blendDefaults.weight, "blend")
    }</div>
                    <div class="channel-cell">${
      buildModelMapInput(provider, blendDefaults.modelMap, "blend")
    }</div>
                    <div class="channel-label" title="会参考上面对话的内容和图片，进行生图">
                        <i class="ri-magic-line"></i>
                        <span>融合生图</span>
                        <i class="ri-information-line" style="font-size: 12px; color: #888; margin-left: 4px;"></i>
                    </div>
                    <div class="channel-cell">${
      buildModelSelect(provider, "blend", blendDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildSizeSelect(provider, "blend", blendDefaults.size, blendDefaults.model)
    }</div>
                    <div class="channel-cell">${
      buildQualitySelect(provider, blendDefaults.quality, "blend")
    }</div>
                    <div class="channel-cell">${
      buildCountSelect(provider, blendDefaults.n, "blend")
    }</div>
                    <div class="channel-cell">${
      buildStepsInput(provider, blendDefaults.steps, "blend")
    }</div>
                </div>
            </div>
        `;
    container.appendChild(section);
  }
}

/**
 * 构建模型映射输入框
 *
 * @param {Object} provider - Provider 对象
 * @param {string} currentValue - 当前值
 * @param {string} task - 任务类型
 * @returns {string} HTML 字符串
 */
function buildModelMapInput(provider, currentValue, task) {
  return `<input type="text" class="form-control" 
    data-provider="${provider.name}" 
    data-task="${task}" 
    data-field="modelMap" 
    value="${currentValue || ""}" 
    placeholder="自定义ID (如文生图)"
  >`;
}

/**
 * 构建模型选择下拉框
 *
 * @param {Object} provider - Provider 对象
 * @param {string} task - 任务类型 ('text' | 'edit')
 * @param {string} currentValue - 当前选中的值
 * @returns {string} HTML 字符串
 */
function buildModelSelect(provider, task, currentValue) {
  let baseModel = provider.defaultModel;
  let models = provider.textModels;

  if (task === "edit") {
    baseModel = provider.defaultEditModel || provider.defaultModel;
    models = (provider.editModels && provider.editModels.length > 0)
      ? provider.editModels
      : provider.textModels;
  } else if (task === "blend") {
    baseModel = provider.defaultBlendModel || provider.defaultModel;
    models = (provider.blendModels && provider.blendModels.length > 0)
      ? provider.blendModels
      : provider.textModels;
  }

  let html =
    `<select class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="model">`;
  // html += `<option value="">跟随默认（${baseModel}）</option>`;
  for (const m of models || []) {
    // 如果 currentValue 为空（即跟随默认），且该项是 baseModel，则选中
    // 如果 currentValue 不为空，且等于该项，则选中
    let selected = "";
    if (currentValue) {
      if (currentValue === m) selected = "selected";
    } else {
      if (m === baseModel) selected = "selected";
    }

    html += `<option value="${m}" ${selected}>${m}</option>`;
  }
  html += "</select>";
  return html;
}

/**
 * 构建尺寸选择下拉框
 *
 * @param {Object} provider - Provider 对象
 * @param {string} task - 任务类型
 * @param {string} currentValue - 当前选中的值
 * @param {string} currentModel - 当前选中的模型
 * @returns {string} HTML 字符串
 */
function buildSizeSelect(provider, task, currentValue, currentModel) {
  let baseSize = provider.defaultSize;

  if (task === "edit") {
    baseSize = provider.defaultEditSize || provider.defaultSize;
  } else if (task === "blend") {
    baseSize = provider.defaultBlendSize || provider.defaultSize;
  }

  const isDoubao = provider.name === "Doubao";
  const isModelScope = provider.name === "ModelScope";
  const isPollinations = provider.name === "Pollinations";
  let sizes = channelSupportedSizes && channelSupportedSizes.length > 0
    ? channelSupportedSizes
    : ["1024x1024", "1024x768", "768x1024", "1280x720"];

  if (isDoubao) {
    // 根据模型选择推荐尺寸列表
    const model = currentModel || provider.defaultModel || "";
    if (model.includes("4-0") || model.includes("4.0")) {
      sizes = [...DOUBAO_SIZES_4_0];
    } else if (model.includes("4-5") || model.includes("4.5")) {
      sizes = [...DOUBAO_SIZES_4_5];
    } else {
      // 默认或未知模型，使用 4.5 的列表作为安全兜底
      sizes = [...DOUBAO_SIZES_4_5];
    }

    const extra = new Set();
    if (baseSize) extra.add(baseSize);
    if (currentValue) extra.add(currentValue);
    for (const v of extra) {
      if (v && !sizes.includes(v)) sizes.unshift(v);
    }
  } else if (isModelScope) {
    // 魔搭渠道尺寸配置
    const model = currentModel || provider.defaultModel || "";
    const isQwenEdit = model.toLowerCase().includes("qwen-image-edit");

    if (isQwenEdit) {
      sizes = [...MODELSCOPE_SIZES_EDIT];
    } else {
      // 默认为 Z-Image-Turbo 或其他模型，使用 TEXT 尺寸列表
      sizes = [...MODELSCOPE_SIZES_TEXT];
    }
  } else if (isPollinations) {
    sizes = [...POLLINATIONS_SIZES];
  }

  let html =
    `<select class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="size">`;
  // html += `<option value="">跟随默认（${baseLabel}）</option>`;

  // 如果没有尺寸列表，至少显示一个 defaultSize
  if (sizes.length === 0 && baseSize) {
    sizes.push(baseSize);
  }

  // 重新遍历逻辑
  let hasSelection = false;
  // 先判断默认选谁
  let targetValue = currentValue || baseSize;
  if (!targetValue && sizes.length > 0) targetValue = sizes[0];

  for (const s of sizes) {
    let selected = "";
    if (s === targetValue) {
      selected = "selected";
      hasSelection = true;
    }
    // 统一应用比例显示格式，提升体验
    const label = formatSizeWithRatio(s);
    html += `<option value="${s}" ${selected}>${label}</option>`;
  }

  // 如果 baseSize 不在列表里，targetValue 也不在列表里，导致没有 selected，
  // 应该强制选中第一个吗？是的。
  if (!hasSelection && sizes.length > 0) {
    // 重置 html 重新生成？或者直接用正则替换第一个？
    // 简单起见，重新生成一遍 html 比较稳妥，或者在第一次循环时就处理好
    html =
      `<select class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="size">`;
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      const label = formatSizeWithRatio(s);
      const selected = (i === 0) ? "selected" : "";
      html += `<option value="${s}" ${selected}>${label}</option>`;
    }
  }

  html += "</select>";
  return html;
}

/**
 * 构建质量选择下拉框
 *
 * @param {Object} provider - Provider 对象
 * @param {string} currentValue - 当前选中的值
 * @param {string} task - 任务类型
 * @returns {string} HTML 字符串
 */
function buildQualitySelect(provider, currentValue, task) {
  const baseQuality = currentConfig.defaultQuality || "standard";
  const supportsQuality = !!provider.supportsQuality;
  const disabled = supportsQuality ? "" : "disabled";
  const opacity = supportsQuality ? "1" : "0.6";

  let html =
    `<select class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="quality" ${disabled} style="opacity: ${opacity}">`;
  // html += `<option value="">跟随默认（${baseQuality}）</option>`;

  // 确定默认值
  const targetValue = currentValue || baseQuality || "standard";

  const stdSelected = targetValue === "standard" ? "selected" : "";
  const hdSelected = targetValue === "hd" ? "selected" : "";
  html += `<option value="standard" ${stdSelected}>标准</option>`;
  html += `<option value="hd" ${hdSelected}>高清</option>`;
  html += "</select>";
  return html;
}

/**
 * 构建数量选择下拉框
 *
 * @param {Object} provider - Provider 对象
 * @param {number|string} currentValue - 当前选中的值
 * @param {string} task - 任务类型
 * @returns {string} HTML 字符串
 */
function buildCountSelect(provider, currentValue, task) {
  const baseCount = currentConfig.defaults?.imageCount || 1;

  // 获取动态上限
  let maxCount = 4;

  if (provider.capabilities) {
    if (task === "text") {
      maxCount = provider.capabilities.maxOutputImages || 16;
    } else if (task === "edit") {
      maxCount = provider.capabilities.maxEditOutputImages ||
        provider.capabilities.maxOutputImages || 16;
    } else if (task === "blend") {
      maxCount = provider.capabilities.maxBlendOutputImages ||
        provider.capabilities.maxOutputImages || 16;
    }
  } else {
    // 如果没有 capabilities 信息，默认给予较大额度，由后端进行限制或并发处理
    maxCount = 16;
  }

  let html =
    `<select class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="n">`;
  // html += `<option value="">跟随默认（${baseCount}）</option>`;

  const targetValue = currentValue || baseCount;

  for (let i = 1; i <= maxCount; i++) {
    // currentValue 可能是数字或字符串，统一转字符串比较
    const selected = String(targetValue) === String(i) ? "selected" : "";
    html += `<option value="${i}" ${selected}>${i} 张</option>`;
  }

  if (maxCount === 1) {
    html += `<option disabled value="">(Gitee 官方限制每次仅支持生成 1 张)</option>`;
  }

  html += "</select>";
  return html;
}

/**
 * 构建步数输入框
 *
 * @param {Object} provider - Provider 对象
 * @param {number|string} currentValue - 当前选中的值
 * @param {string} task - 任务类型
 * @returns {string} HTML 字符串
 */
function buildStepsInput(provider, currentValue, task) {
  const defaultSteps = provider.defaultSteps || 4; // Use global default if task specific is not set, though here we want task specific input
  const value = currentValue !== undefined && currentValue !== null ? currentValue : defaultSteps;

  return `<input type="number" class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="steps" value="${value}" min="1" max="100" style="width: 100%;">`;
}

/**
 * 构建权重输入框
 *
 * @param {Object} provider - Provider 对象
 * @param {number|string} currentValue - 当前选中的值
 * @param {string} task - 任务类型
 * @returns {string} HTML 字符串
 */
function buildWeightInput(provider, currentValue, task) {
  const value = currentValue !== undefined && currentValue !== null ? currentValue : 1;
  return `<input type="number" class="form-control" data-provider="${provider.name}" data-task="${task}" data-field="weight" value="${value}" min="0" max="100" style="width: 100%;" title="权重越高，被选中的概率越大 (0表示禁用路由)">`;
}

/**
 * 更新豆包尺寸选项
 *
 * @param {HTMLSelectElement} modelSelect - 触发变更的模型下拉框
 */
function updateDoubaoSizeOptions(modelSelect) {
  const row = modelSelect.closest(".channel-row");
  const sizeSelect = row.querySelector('[data-field="size"]');
  if (!sizeSelect) return;

  const model = modelSelect.value;
  let sizes = DOUBAO_SIZES_4_5;
  if (model.includes("4-0") || model.includes("4.0")) {
    sizes = DOUBAO_SIZES_4_0;
  }

  // 保留当前选中的值（如果在列表里）
  const currentSize = sizeSelect.value;

  // 重建 Options
  sizeSelect.innerHTML = "";
  for (const s of sizes) {
    const selected = (s === currentSize) ? "selected" : "";
    const label = formatSizeWithRatio(s);
    sizeSelect.insertAdjacentHTML(
      "beforeend",
      `<option value="${s}" ${selected}>${label}</option>`,
    );
  }

  // 如果原来的值不在列表里，是否要强制添加？
  // 按照 buildSizeSelect 逻辑，如果当前值不在推荐列表，通常会 unshift 进去
  // 但这里作为联动更新，强制切回列表第一个可能更好
  if (!sizes.includes(currentSize)) {
    // 选中第一个
    if (sizeSelect.options.length > 0) {
      sizeSelect.selectedIndex = 0;
    }
  }
}

/**
 * 更新 ModelScope 尺寸选项
 *
 * @param {HTMLSelectElement} modelSelect - 触发变更的模型下拉框
 */
function updateModelScopeSizeOptions(modelSelect) {
  const row = modelSelect.closest(".channel-row");
  const sizeSelect = row.querySelector('[data-field="size"]');
  if (!sizeSelect) return;

  const model = modelSelect.value || "";
  const isQwenEdit = model.toLowerCase().includes("qwen-image-edit");
  const sizes = isQwenEdit ? MODELSCOPE_SIZES_EDIT : MODELSCOPE_SIZES_TEXT;

  // 保留当前选中的值（如果在列表里）
  const currentSize = sizeSelect.value;

  // 重建 Options
  sizeSelect.innerHTML = "";
  for (const s of sizes) {
    const selected = (s === currentSize) ? "selected" : "";
    const label = formatSizeWithRatio(s);
    sizeSelect.insertAdjacentHTML(
      "beforeend",
      `<option value="${s}" ${selected}>${label}</option>`,
    );
  }

  if (!sizes.includes(currentSize)) {
    if (sizeSelect.options.length > 0) {
      sizeSelect.selectedIndex = 0;
    }
  }
}

/**
 * 防抖保存
 */
const debounceSave = debounce(async () => {
  const payload = { providers: {} };
  const container = document.getElementById("channelsContainer");

  // 遍历所有 inputs
  const inputs = container.querySelectorAll(
    "input[data-provider], select[data-provider], textarea[data-provider]",
  );

  inputs.forEach((input) => {
    const provider = input.dataset.provider;
    const task = input.dataset.task; // text, edit, blend
    const field = input.dataset.field; // model, size, quality, n, enabled, defaultSteps
    let value = input.value;

    if (input.type === "checkbox") {
      value = input.checked;
    } else if (input.type === "number") {
      value = Number(value);
    } else if (field === "n") {
      // 确保 n 参数始终为数字类型
      value = Number(value);
    }

    if (!payload.providers[provider]) {
      payload.providers[provider] = {};
    }

    // 处理 enabled 和 defaultSteps 等顶层属性
    if (field === "enabled") {
      payload.providers[provider].enabled = value;
    } else if (field === "defaultSteps") {
      payload.providers[provider].defaultSteps = value;
    } else if (task) {
      if (!payload.providers[provider][task]) {
        payload.providers[provider][task] = {};
      }
      payload.providers[provider][task][field] = value;
    }
  });

  try {
    const res = await apiFetch("/api/runtime-config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log("配置已自动保存");
    } else {
      console.error("保存失败");
    }
  } catch (e) {
    console.error("保存出错", e);
  }
}, 1000);
