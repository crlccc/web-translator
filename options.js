const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  mode: 'replace',
  batchSize: 30,
};

function showMsg(text, kind = 'info') {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg ' + kind;
}

function setModel(value) {
  const sel = $('model');
  if (![...sel.options].some((o) => o.value === value)) {
    sel.add(new Option(value + '（自定义）', value));
  }
  sel.value = value;
}

function currentForm() {
  const modeEl = document.querySelector('input[name="mode"]:checked');
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    model: $('model').value,
    mode: modeEl ? modeEl.value : 'replace',
    batchSize: Math.max(5, Math.min(50, parseInt($('batchSize').value, 10) || 30)),
  };
}

async function checkEndpointPermission(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (e) {
    throw new Error('接口地址格式无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('接口地址必须是 HTTPS，且不能包含用户名或密码');
  }
  if (url.origin === 'https://api.deepseek.com') return;
  const granted = await chrome.permissions.request({ origins: [url.origin + '/*'] });
  if (!granted) throw new Error('需要授予自定义接口域名访问权限');
}

async function updateCacheCount() {
  try {
    const all = await chrome.storage.local.get(null);
    const count = Object.keys(all).filter((k) => k.startsWith('t:')).length;
    $('cache-count').textContent = count;
  } catch (e) {
    $('cache-count').textContent = '0';
  }
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('apiKey').value = s.apiKey;
  $('baseUrl').value = s.baseUrl;
  setModel(s.model);
  const modeEl = document.querySelector('input[name="mode"][value="' + s.mode + '"]');
  if (modeEl) modeEl.checked = true;
  $('batchSize').value = s.batchSize;
  updateCacheCount();
}

document.addEventListener('DOMContentLoaded', load);

/* 保存设置 */
$('save').addEventListener('click', async () => {
  const s = currentForm();
  try {
    await checkEndpointPermission(s.baseUrl);
  } catch (e) {
    showMsg(e.message || String(e), 'error');
    return;
  }
  await chrome.storage.local.set(s);
  // 通知所有已注入内容脚本的标签页刷新设置
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED' }).catch(() => {});
    }
  } catch (e) {}
  showMsg('已保存 ✓', 'ok');
});

/* 显示 / 隐藏 Key */
$('toggle-key').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? '隐藏' : '显示';
});

/* 测试连接（使用当前表单值，不必先保存） */
$('test').addEventListener('click', async () => {
  const s = currentForm();
  if (!s.apiKey) {
    showMsg('请先填写 API Key', 'error');
    return;
  }
  try {
    await checkEndpointPermission(s.baseUrl);
  } catch (e) {
    showMsg(e.message || String(e), 'error');
    return;
  }
  showMsg('测试中…', 'info');
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'FETCH_TRANSLATE',
      payload: {
        items: [{ id: 0, text: 'Get Started', context: 'button, ui-short' }],
        settings: s,
      },
    });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      resp = { ok: false, message: '扩展后台未启动：请在 chrome://extensions 页面点击本扩展的「重新加载」按钮，然后重试' };
    } else {
      resp = { ok: false, message: '后台无响应：' + msg };
    }
  }
  if (resp && resp.ok) {
    const t = (resp.translations && resp.translations[0] && resp.translations[0].text) || '';
    showMsg('连接成功 ✓ 示例翻译："Get Started" → “' + t + '”', 'ok');
  } else {
    showMsg('连接失败：' + ((resp && resp.message) || '未知错误'), 'error');
  }
});

/* 清空缓存 */
$('clear-cache').addEventListener('click', async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('t:'));
    if (keys.length) await chrome.storage.local.remove(keys);
    showMsg('已清空 ' + keys.length + ' 条翻译缓存', 'ok');
    updateCacheCount();
  } catch (e) {
    showMsg('清空失败：' + ((e && e.message) || e), 'error');
  }
});
