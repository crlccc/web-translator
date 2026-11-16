const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createWorker(fetchImpl) {
  let onMessage;
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: event(),
      onMessage: { addListener(fn) { onMessage = fn; } },
    },
    contextMenus: { removeAll() {}, create() {}, onClicked: event() },
    commands: { onCommand: event() },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInNewContext(source, {
    chrome, fetch: fetchImpl, AbortController, setTimeout, clearTimeout, URL, console,
  });
  return (message) => new Promise((resolve) => {
    assert.equal(onMessage(message, {}, resolve), true);
  });
}

test('未配置密钥时返回明确错误，且不请求接口', async () => {
  const send = createWorker(() => { throw new Error('不应发出请求'); });
  const result = await send({ type: 'FETCH_TRANSLATE', payload: { items: [{ id: 0, text: 'Hello' }] } });
  assert.equal(result.code, 'NO_KEY');
});

test('翻译消息由后台代理并返回模型结果', async () => {
  let requestedUrl;
  const send = createWorker(async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"translations":[{"id":0,"text":"你好"}]}' } }] }),
    };
  });
  const result = await send({
    type: 'FETCH_TRANSLATE',
    payload: { items: [{ id: 0, text: 'Hello', context: 'body, ui-short' }], settings: { apiKey: 'test-key' } },
  });
  assert.equal(requestedUrl, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(result.ok, true);
  assert.equal(result.translations[0].text, '你好');
});
