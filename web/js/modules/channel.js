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

function formatDoubaoSizeLabel(size) {
  return formatSizeWithRatio(size);
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
  });

  // 加载配置
  await loadChannelConfig();
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

    const textDefaults = providerDefaults.text || {};
    const editDefaults = providerDefaults.edit || {};
    const blendDefaults = providerDefaults.blend || {};
    const isEnabled = provider.enabled !== false;

    const section = document.createElement("div");
    section.className = "form-section";
    section.style.padding = "12px 16px";
    section.innerHTML = `
            <div class="form-header" style="display:flex; justify-content:space-between; align-items:center; padding-bottom: 8px; margin-bottom: 8px;">
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
            <div class="channel-table" style="${
      isEnabled ? "" : "opacity:0.5; pointer-events:none; transition: opacity 0.3s;"
    }">
                <div class="channel-row">
                    <div class="channel-label"></div>
                    <div class="channel-header">模型</div>
                    <div class="channel-header">尺寸</div>
                    <div class="channel-header">质量</div>
                    <div class="channel-header">生图数量</div>
                </div>
                <div class="channel-row">
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
                </div>
                <div class="channel-row">
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
                </div>
                <div class="channel-row">
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
                </div>
            </div>
        `;
    container.appendChild(section);
  }
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
    const label = (isDoubao || isModelScope || isPollinations) ? formatSizeWithRatio(s) : s;
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
      const label = (isDoubao || isModelScope) ? formatSizeWithRatio(s) : s;
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
 * 更新豆包尺寸选项
 *
 * @param {HTMLSelectElement} modelSelect - 触发变更的模型下拉框
 */
function updateDoubaoSizeOptions(modelSelect) {
  const providerName = modelSelect.dataset.provider;
  const task = modelSelect.dataset.task;
  const modelValue = modelSelect.value;

  // 找到对应的尺寸下拉框
  const sizeSelect = document.querySelector(
    `select[data-provider="${providerName}"][data-task="${task}"][data-field="size"]`,
  );
  if (!sizeSelect) return;

  // 确定使用的尺寸列表
  let sizes = [...DOUBAO_SIZES_4_5]; // 默认安全列表
  if (modelValue.includes("4-0") || modelValue.includes("4.0")) {
    sizes = [...DOUBAO_SIZES_4_0];
  } else if (modelValue.includes("4-5") || modelValue.includes("4.5")) {
    sizes = [...DOUBAO_SIZES_4_5];
  }

  // 保留当前选中的值（如果不在新列表中，可能需要添加到顶部或重置）
  // 这里我们简单处理：如果当前值在新列表中，保持选中；否则重置为空（跟随默认）
  // 或者，我们可以把旧值也加进去，但用户意图是切换模型，所以展示新模型的推荐尺寸更好。
  // 为了防止当前选中的值是不合法的（例如从 4.0 切到 4.5，原值为 1024x1024），
  // 我们应该检查合法性。如果不合法，重置为 Default。

  const currentSize = sizeSelect.value;
  let shouldKeepCurrent = false;

  // 简单检查 currentSize 是否在 sizes 中
  if (currentSize && sizes.includes(currentSize)) {
    shouldKeepCurrent = true;
  }

  // 重新生成 options
  // 1. 默认选项
  // 我们需要获取 baseSize。这在 DOM 里没存，只能从 textDefaults 里拿吗？
  // 简单起见，我们只保留 "跟随默认" 文本，不再计算 "跟随默认(2048x2048)" 这种动态文本，除非我们能获取到 defaultSize。
  // 为了保持一致性，我们尝试保留原有的第一项文本，或者简化它。

  // let defaultOptionText = "跟随默认";
  // if (sizeSelect.options.length > 0) {
  //     // 尝试复用第一项的文本，通常是 "跟随默认 (WxH)"
  //     defaultOptionText = sizeSelect.options[0].text;
  // }

  let html = ""; // `<option value="">${defaultOptionText}</option>`;

  // 如果当前值不在列表中，且不为空，我们是否要强制加进去？
  // 用户的需求是“只显示支持的列表”，所以如果切到 4.5，原值是 1024x1024，就不应该显示在列表里了。
  // 除非它被选中... 但它是不合法的。所以最好重置。

  // 重新计算默认选中项
  // 之前逻辑是 shouldKeepCurrent ? currentSize : (fallback to first)

  const targetValue = shouldKeepCurrent ? currentSize : sizes[0];

  for (const s of sizes) {
    const label = formatDoubaoSizeLabel(s);
    const selected = (s === targetValue) ? "selected" : "";
    html += `<option value="${s}" ${selected}>${label}</option>`;
  }

  sizeSelect.innerHTML = html;

  // 如果原值被剔除了，sizeSelect.value 会变成 "" (第一项)，这符合预期。
  // 此时如果不触发 change 事件，配置里的 size 就会变成 ""（跟随默认）。
  // 这通常是安全的。
}

/**
 * 更新 ModelScope 尺寸选项
 *
 * @param {HTMLSelectElement} modelSelect - 触发变更的模型下拉框
 */
function updateModelScopeSizeOptions(modelSelect) {
  const providerName = modelSelect.dataset.provider;
  const task = modelSelect.dataset.task;
  const modelValue = modelSelect.value || "";

  // 找到对应的尺寸下拉框
  const sizeSelect = document.querySelector(
    `select[data-provider="${providerName}"][data-task="${task}"][data-field="size"]`,
  );
  if (!sizeSelect) return;

  // 确定使用的尺寸列表
  let sizes = [...MODELSCOPE_SIZES_TEXT];
  if (modelValue.toLowerCase().includes("qwen-image-edit")) {
    sizes = [...MODELSCOPE_SIZES_EDIT];
  }

  const currentSize = sizeSelect.value;
  let shouldKeepCurrent = false;

  // 简单检查 currentSize 是否在 sizes 中
  if (currentSize && sizes.includes(currentSize)) {
    shouldKeepCurrent = true;
  }

  const targetValue = shouldKeepCurrent ? currentSize : sizes[0];

  let html = "";
  for (const s of sizes) {
    const label = formatSizeWithRatio(s);
    const selected = (s === targetValue) ? "selected" : "";
    html += `<option value="${s}" ${selected}>${label}</option>`;
  }

  sizeSelect.innerHTML = html;
}

/**
 * 防抖保存函数
 */
const debounceSave = debounce(async () => {
  await saveChannelSettings();
}, 1000);

/**
 * 保存渠道配置到后端
 */
async function saveChannelSettings() {
  const statusDot = document.querySelector(".status-pill .status-dot");
  const statusText = document.querySelector(".status-pill span");
  if (statusDot && statusText) {
    statusDot.style.background = "#ffd700";
    statusText.innerText = "保存中...";
  }

  try {
    // 构建 providers 配置对象
    const providersConfig = {};

    // 收集所有 provider 名称
    const providerNames = new Set();
    document.querySelectorAll("[data-provider]").forEach((el) =>
      providerNames.add(el.dataset.provider)
    );

    for (const name of providerNames) {
      const enabledInput = document.querySelector(
        `input[data-provider="${name}"][data-field="enabled"]`,
      );
      const isEnabled = enabledInput ? enabledInput.checked : true;

      const defaults = {};

      document.querySelectorAll(`select[data-provider="${name}"]`).forEach((sel) => {
        const task = sel.dataset.task; // text or edit
        const field = sel.dataset.field; // model, size, quality, n
        const val = sel.value;

        if (val) { // 只有非空值才保存
          if (!defaults[task]) defaults[task] = {};

          if (field === "n") {
            defaults[task][field] = parseInt(val, 10);
          } else {
            defaults[task][field] = val;
          }
        }
      });

      // 构建单个 provider 配置
      providersConfig[name] = {
        enabled: isEnabled,
        ...defaults,
      };
    }

    // 发送配置更新
    await apiFetch("/api/runtime-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: providersConfig }),
    });

    if (statusDot) {
      statusDot.style.background = "var(--success)";
      statusText.innerText = "已保存";
      setTimeout(() => {
        statusText.innerText = "运行中";
      }, 2000);
    }
  } catch (e) {
    console.error(e);
    if (statusDot) statusDot.style.background = "var(--error)";
    statusText.innerText = "保存失败";
  }
}
