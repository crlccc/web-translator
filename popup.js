const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  mode: 'replace',
  batchSize: 30,
};

document.addEventListener('DOMContentLoaded', async () => {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };

  // Key 配置状态
  const banner = $('key-status');
  if (!s.apiKey) {
    banner.textContent = '尚未配置 DeepSeek API Key，翻译前请先到设置中填写';
    banner.className = 'banner warn';
  } else {
    banner.textContent = 'Key 已配置 · ' + (s.baseUrl.includes('deepseek.com') ? '官方接口' : '自定义接口');
    banner.className = 'banner ok';
  }

  // 模型选择
  if (![...$('model').options].some((o) => o.value === s.model)) {
    $('model').add(new Option(s.model + '（自定义）', s.model));
  }
  $('model').value = s.model;

  $('btn-translate').onclick = () => send('START_TRANSLATE');
  $('btn-original').onclick = () => send('START_SHOW_ORIGINAL');
  $('btn-retranslate').onclick = () => send('START_RETRANSLATE');

  $('model').onchange = async (e) => {
    await chrome.storage.local.set({ model: e.target.value });
  };

  $('open-options').onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
});

async function send(type) {
  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  } catch (e) {}
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type, tabId });
  } catch (e) {
    resp = { ok: false, message: '扩展后台未启动：请在 chrome://extensions 页面点击本扩展的「重新加载」按钮，然后重试' };
  }
  if (!resp || resp.ok !== true) {
    const banner = $('key-status');
    banner.textContent = '⚠ ' + ((resp && resp.message) || '后台未返回有效结果，请重新加载扩展后重试');
    banner.className = 'banner error';
    return;
  }
  window.close();
}
