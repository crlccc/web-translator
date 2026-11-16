/* 网页翻译 · DeepSeek —— Service Worker
 * 职责：右键菜单 / 快捷键 / 消息中转 / DeepSeek API 代理（content script 受页面 CORS 限制，统一由此处请求）
 */

const SYSTEM_PROMPT = `你是资深网页本地化译员，负责将网页内容翻译为简体中文。

输入是一个 JSON 对象：{"texts":[{"id":片段编号,"text":"待译原文","context":"语境标签"}]}
context 由元素角色（button/link/nav/heading/table-header/label/placeholder/alt/tooltip/option/list-item/table-cell/footer/caption/body）和长度分类（ui-short/sentence/paragraph）组成。

请根据 context 判断每段文字在页面中的角色，按以下规则翻译：

【文风随语境切换】
1. button：动词开头、2~6 字、口语有力。"Get Started"→"开始使用"；"Sign Up"→"注册"；"Learn more"→"了解更多"。
2. link / nav：极简名词。"Pricing"→"定价"；"Docs"→"文档"；"Careers"→"招聘"。
3. heading：简洁有概括力，保留信息层级，不逐词直译。
4. placeholder：提示语气，用"请输入… / 请选择…"。"Search docs..."→"搜索文档…"。
5. table-header：2~4 字名词短语。
6. label：与对应控件语义一致的短标签。
7. option（下拉选项）：简短名词或动词短语，与其他选项风格统一。
8. tooltip：简洁说明；error/toast 类提示：礼貌、明确、可操作。"This action cannot be undone"→"此操作无法撤销"。
9. sentence / paragraph：完整流畅的中文书面语，先因后果、避免长定语，不逐字直译；专有名词首次出现可附原文括注。
10. ui-short：优先按 UI 文案习惯处理，宁短勿长。

【术语与不译规则】
- 行业术语用中文社区惯用译法；API、Token、Bug、Cloud、Docker 等开发者熟知词可保留英文。
- 品牌名、产品名、人名保留原文；代码、命令、文件路径、URL、邮箱、版本号、变量名一律原样保留。
- 若 text 已经是简体中文，或不含需要翻译的外文，原样返回。
- 同一术语在所有片段中译法必须一致。

【格式保真】
- 严格保留占位符（%s、{name}、<strong> 等）、Markdown 标记、换行、表情符号、数字与单位。
- 译文长度尽量接近原文，避免撑破按钮和导航。

【输出】
仅输出 JSON 对象：{"translations":[{"id":<原id>,"text":"<译文>"}]}
不要输出任何解释、注释或 Markdown 代码块围栏。`;

/* ---------------- 右键菜单 ---------------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ds-translate-page',
      title: '翻译此页面为中文',
      contexts: ['page', 'selection', 'link', 'image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ds-translate-page' && tab && tab.id != null) {
    invokeContent(tab.id, 'TRANSLATE');
  }
});

/* ---------------- 快捷键 ---------------- */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'translate-page') {
    const tabId = await getActiveTabId();
    if (tabId != null) invokeContent(tabId, 'TRANSLATE');
  }
});

/* ---------------- 消息中转 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'START_TRANSLATE' || msg.type === 'START_SHOW_ORIGINAL' || msg.type === 'START_RETRANSLATE') {
    const action = {
      START_TRANSLATE: 'TRANSLATE',
      START_SHOW_ORIGINAL: 'SHOW_ORIGINAL',
      START_RETRANSLATE: 'RETRANSLATE',
    }[msg.type];
    (async () => {
      try {
        const tabId = msg.tabId != null ? msg.tabId : await getActiveTabId();
        if (tabId == null) return sendResponse({ ok: false, message: '找不到活动标签页' });
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && !/^https?:/i.test(tab.url)) {
          return sendResponse({ ok: false, message: '此页面不支持翻译（浏览器内部页面 / 应用商店页面）' });
        }
        await ensureInjected(tabId);
        await chrome.tabs.sendMessage(tabId, { type: action });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, message: '无法在此页面运行：' + (e && e.message ? e.message : String(e)) });
      }
    })();
    return true; // 异步响应
  }

  if (msg.type === 'FETCH_TRANSLATE') {
    translateBatch(msg.payload)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, retryable: true, message: String((e && e.message) || e) }));
    return true;
  }
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : null;
}

/** 确保内容脚本已注入（按需注入，页面导航后自动重新注入） */
async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function invokeContent(tabId, action) {
  try {
    await ensureInjected(tabId);
    await chrome.tabs.sendMessage(tabId, { type: action });
  } catch (e) {
    console.warn('[网页翻译]', e);
  }
}

/* ---------------- DeepSeek API 代理 ---------------- */
async function translateBatch(payload) {
  const { items = [], settings = {} } = payload || {};
  const apiKey = settings.apiKey;
  const baseUrl = (settings.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = settings.model || 'deepseek-chat';

  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', retryable: false, message: '未配置 DeepSeek API Key，请先在扩展设置中填写' };
  }
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error();
  } catch (e) {
    return { ok: false, retryable: false, message: '接口地址无效，必须使用 HTTPS' };
  }
  if (!items.length) return { ok: true, translations: [] };

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ texts: items }) },
    ],
    max_tokens: 8192,
    stream: false,
  };
  if (model === 'deepseek-chat') {
    body.temperature = 1.3; // DeepSeek 官方建议翻译场景使用较高温度
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 401) return { ok: false, code: 'AUTH', retryable: false, message: 'API Key 无效（401），请在扩展设置中检查' };
    if (res.status === 402) return { ok: false, code: 'BILLING', retryable: false, message: 'DeepSeek 账户余额不足（402），请前往平台充值' };
    if (res.status === 429) return { ok: false, code: 'RATE', retryable: true, message: '请求过于频繁（429），稍后自动重试' };
    if (res.status >= 500) return { ok: false, code: 'HTTP_' + res.status, retryable: true, message: 'DeepSeek 服务错误（' + res.status + '），稍后自动重试' };
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || JSON.stringify(j).slice(0, 150);
      } catch (e) {}
      return { ok: false, code: 'HTTP_' + res.status, retryable: false, message: '接口错误（' + res.status + '）' + (detail ? '：' + detail : '') };
    }

    const data = await res.json();
    const content =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const translations = parseTranslations(content);
    if (!translations) {
      return { ok: false, code: 'PARSE', retryable: true, message: '模型返回内容无法解析，请重试' };
    }
    return { ok: true, translations };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', retryable: true, message: '请求超时（90 秒），请重试' };
    }
    return { ok: false, code: 'NETWORK', retryable: true, message: '网络错误：' + ((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 容错解析模型输出：兼容 JSON 对象 / 数组 / 代码块围栏等多种返回形态 */
function parseTranslations(content) {
  if (!content) return null;
  let s = String(content).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const pick = (v) => (Array.isArray(v) ? v : null);
  try {
    const obj = JSON.parse(s);
    const arr = pick(obj) || pick(obj.translations) || pick(obj.data) || pick(obj.results);
    if (arr) return arr;
  } catch (e) {}
  const m = s.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  return null;
}
