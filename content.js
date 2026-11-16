/* 网页翻译 · DeepSeek —— Content Script
 * 职责：DOM 文本采集（附语境元数据）→ 批量请求 DeepSeek → 原位替换
 * 特性：译文缓存、懒翻译（IntersectionObserver）、动态内容增量翻译（MutationObserver）
 */
(() => {
  if (window.__dsWebTranslatorLoaded) return;
  window.__dsWebTranslatorLoaded = true;

  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    mode: 'bilingual', // 始终保留原文，并在原文后显示中文
    batchSize: 30,
    concurrency: 3,
  };

  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'code', 'pre', 'textarea', 'svg', 'math',
    'iframe', 'canvas', 'object', 'embed', 'template',
    '[contenteditable=""]', '[contenteditable="true"]',
    '.ds-trans', '.ds-skip', '#ds-translator-toast',
  ].join(', ');

  const ATTR_SELECTOR =
    'input[placeholder], input[type="button"], input[type="submit"], ' +
    'textarea[placeholder], img[alt], [title], [aria-label]';

  const state = {
    settings: { ...DEFAULTS },
    translated: [],        // 已翻译条目，用于恢复原文
    queue: [],             // 待翻译条目
    inflight: 0,           // 进行中的请求数
    total: 0,
    done: 0,
    failedCount: 0,
    failed: [],            // { entry, reason }
    translating: false,
    enabled: false,        // 一旦开启，动态新增内容也会增量翻译
    force: false,          // 重新翻译：跳过缓存
    applying: false,       // 忽略自身 DOM 修改
    generation: 0,         // 恢复原文/重新翻译时 +1，丢弃过期请求结果
    collectedNodes: new WeakSet(),
    observer: null,
    io: null,
    pendingLazy: new Set(),
    toastEl: null,
  };

  /* ---------------- 消息入口 ---------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'PING':
        sendResponse({ ok: true, loaded: true });
        break;
      case 'TRANSLATE':
        sendResponse({ ok: true });
        translatePage();
        break;
      case 'SHOW_ORIGINAL':
        sendResponse({ ok: true });
        showOriginal(true);
        break;
      case 'RETRANSLATE':
        sendResponse({ ok: true });
        retranslate();
        break;
      case 'SETTINGS_UPDATED':
        loadSettings();
        break;
    }
  });

  async function loadSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    state.settings = { ...DEFAULTS, ...stored, mode: 'bilingual' };
    return state.settings;
  }
  loadSettings();

  /* ---------------- 主流程 ---------------- */
  async function translatePage() {
    await loadSettings();
    if (!state.settings.apiKey) {
      setToast('未配置 DeepSeek API Key：请右键扩展图标 → 选项，填入 Key', 'error');
      return;
    }
    if (state.translating) {
      setToast('正在翻译中，请稍候…', 'progress');
      return;
    }
    if (state.translated.length) {
      setToast('当前页面已显示原文和中文；如需更新译文，请使用“重新翻译”', 'success', { autoHide: 3500 });
      return;
    }

    state.enabled = true;
    state.translating = true;
    state.generation++;
    state.collectedNodes = new WeakSet(); // 清空采集标记，确保「重新翻译」能重新收集已恢复原文的节点
    state.done = 0;
    state.total = 0;
    state.failedCount = 0;
    state.failed = [];

    const entries = collectEntries(document.documentElement);
    if (!entries.length) {
      state.translating = false;
      setToast('未发现需要翻译的外文内容', 'success', { autoHide: 2500 });
      return;
    }

    setupMutationObserver();
    state.total = entries.length;
    for (const e of entries) {
      if (nearViewport(e.el || e.node)) enqueue(e);
      else watchLazy(e);
    }
    updateProgressToast();
    drainQueue();
  }

  /* ---------------- 采集（含语境元数据） ---------------- */
  function collectEntries(root) {
    const entries = [];
    if (!root) return entries;

    const doc = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument;
    if (doc) {
      const walker = doc.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        { acceptNode }
      );
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === Node.TEXT_NODE) {
          state.collectedNodes.add(n);
          entries.push({
            type: 'text',
            node: n,
            el: n.parentElement,
            original: n.nodeValue,
            context: getContext(n),
            gen: state.generation,
            force: state.force,
          });
        }
      }
    }

    const attrEls = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(ATTR_SELECTOR)) attrEls.push(root);
    if (root.querySelectorAll) attrEls.push(...root.querySelectorAll(ATTR_SELECTOR));
    for (const el of attrEls) {
      if (el.closest(SKIP_SELECTOR)) continue;
      for (const [attr, role] of attrTargets(el)) {
        const val = el.getAttribute(attr);
        if (val && needsTranslation(val)) {
          entries.push({
            type: 'attr',
            el,
            attr,
            original: val,
            context: role + ', ' + lengthClass(val),
            gen: state.generation,
            force: state.force,
          });
        }
      }
    }
    return entries;
  }

  function acceptNode(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return node.matches(SKIP_SELECTOR)
        ? NodeFilter.FILTER_REJECT // 整棵子树跳过
        : NodeFilter.FILTER_ACCEPT;
    }
    const parent = node.parentElement;
    if (!parent || parent.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
    if (state.collectedNodes.has(node)) return NodeFilter.FILTER_SKIP;
    return needsTranslation(node.nodeValue)
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_SKIP;
  }

  function attrTargets(el) {
    const tag = el.tagName;
    const list = [];
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || type === 'password') return list;
      if (el.hasAttribute('placeholder')) list.push(['placeholder', 'placeholder']);
      if (type === 'button' || type === 'submit') list.push(['value', 'button']);
    } else if (tag === 'TEXTAREA') {
      if (el.hasAttribute('placeholder')) list.push(['placeholder', 'placeholder']);
    } else if (tag === 'IMG') {
      if (el.hasAttribute('alt')) list.push(['alt', 'alt']);
    }
    if (el.hasAttribute('title')) list.push(['title', 'tooltip']);
    if (el.hasAttribute('aria-label')) list.push(['aria-label', 'label']);
    return list;
  }

  /* ---------------- 语境元数据 ---------------- */
  function getContext(node) {
    const el = node.parentElement;
    const text = node.nodeValue.trim();
    return (el ? getRole(el) : 'body') + ', ' + lengthClass(text);
  }

  function getRole(el) {
    if (el.closest('button, [role="button"], input[type="button"], input[type="submit"], summary')) return 'button';
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) || el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')) return 'heading';
    if (el.closest('nav, [role="navigation"]')) return 'nav';
    if (el.closest('th')) return 'table-header';
    if (el.closest('select')) return 'option';
    if (el.closest('label')) return 'label';
    if (el.closest('a')) return 'link';
    if (el.closest('td')) return 'table-cell';
    if (el.closest('ol, ul, menu')) return 'list-item';
    if (el.closest('footer')) return 'footer';
    if (el.closest('figcaption, small')) return 'caption';
    return 'body';
  }

  function lengthClass(text) {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words <= 4) return 'ui-short';
    return text.length <= 160 ? 'sentence' : 'paragraph';
  }

  /* ---------------- 是否需要翻译 ---------------- */
  const RE_LATIN = /[A-Za-zÀ-ÖØ-öø-ÿ]/;
  const RE_CYRILLIC = /[\u0400-\u04FF]/;
  const RE_KANA = /[\u3040-\u30FF]/;
  const RE_HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/;

  function needsTranslation(text) {
    if (!text) return false;
    const t = text.trim();
    if (!t) return false;
    if (RE_KANA.test(t) || RE_HANGUL.test(t)) return true; // 日文 / 韩文
    const latin = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    if (!latin && !RE_CYRILLIC.test(t)) return false; // 没有可翻译的字母文字
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk > 0 && cjk >= latin) return false; // 以中文为主，跳过
    return true;
  }

  /* ---------------- 懒翻译 ---------------- */
  function nearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false; // 不可见（display:none）
      return r.bottom > -300 && r.top < window.innerHeight + 300;
    } catch (e) {
      return true;
    }
  }

  function watchLazy(e) {
    const target = e.el || (e.node && e.node.parentElement);
    if (!target || typeof target.getBoundingClientRect !== 'function') {
      enqueue(e);
      return;
    }
    if (!state.io) {
      state.io = new IntersectionObserver(
        (ioEntries) => {
          if (!state.enabled) {
            disconnectAll();
            return;
          }
          for (const ie of ioEntries) {
            if (!ie.isIntersecting) continue;
            const list = ie.target.__dsEntries || [];
            ie.target.__dsEntries = null;
            state.pendingLazy.delete(ie.target);
            state.io.unobserve(ie.target);
            for (const entry of list) enqueue(entry);
          }
          if (state.queue.length) {
            updateProgressToast();
            drainQueue();
          }
        },
        { rootMargin: '300px 0px' }
      );
    }
    const arr = target.__dsEntries || (target.__dsEntries = []);
    arr.push(e);
    state.pendingLazy.add(target);
    state.io.observe(target);
  }

  /* ---------------- 批量翻译 ---------------- */
  function enqueue(e) {
    state.queue.push(e);
  }

  function drainQueue() {
    const limit = Math.max(1, Math.min(6, state.settings.concurrency || 3));
    const size = Math.max(5, Math.min(50, state.settings.batchSize || 30));
    while (state.inflight < limit && state.queue.length > 0) {
      const batch = state.queue.splice(0, size);
      state.inflight++;
      processBatch(batch)
        .catch((e) => console.warn('[网页翻译]', e))
        .finally(() => {
          state.inflight--;
          drainQueue();
          checkFinished();
        });
    }
  }

  async function processBatch(batch) {
    // 1. 先查缓存
    let cacheMap = {};
    if (!batch.some((entry) => entry.force)) {
      try {
        cacheMap = await chrome.storage.local.get(batch.map((e) => cacheKey(e)));
      } catch (err) {}
    }
    const jobs = [];
    for (let i = 0; i < batch.length; i++) {
      const hit = cacheMap[cacheKey(batch[i])];
      if (typeof hit === 'string') applyTranslation(batch[i], hit);
      else jobs.push({ id: jobs.length, entry: batch[i] });
    }
    if (!jobs.length) return;

    // 2. 未命中的发给 DeepSeek（经 background 代理）
    markPending(batch, true);
    try {
      let attempt = 0;
      for (;;) {
        if (jobs[0].entry.gen !== state.generation) return; // 页面状态已变更，丢弃
        const resp = await sendToBackground(
          jobs.map((j) => ({ id: j.id, text: j.entry.original.trim(), context: j.entry.context }))
        );

        if (resp && resp.ok) {
          const map = new Map();
          for (const t of resp.translations || []) {
            if (t && typeof t.id === 'number' && typeof t.text === 'string') map.set(t.id, t.text);
          }
          const toCache = [];
          for (const j of jobs) {
            const text = map.get(j.id);
            if (text != null) {
              applyTranslation(j.entry, text);
              toCache.push([cacheKey(j.entry), text]);
            } else {
              failEntry(j.entry, '模型未返回该片段译文');
            }
          }
          saveCache(toCache);
          return;
        }

        // 失败：可重试错误退避重试，最多 2 次
        if (resp && resp.retryable && attempt < 2) {
          attempt++;
          setToast((resp.message || '请求失败') + '，' + attempt * 1.5 + 's 后第 ' + (attempt + 1) + ' 次尝试…', 'progress');
          await sleep(attempt * 1500);
          continue;
        }
        for (const j of jobs) failEntry(j.entry, (resp && resp.message) || '请求失败');
        showErrorToast((resp && resp.message) || '请求失败');
        return;
      }
    } finally {
      markPending(batch, false);
    }
  }

  function sendToBackground(items) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'FETCH_TRANSLATE', payload: { items, settings: state.settings } },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, retryable: true, message: chrome.runtime.lastError.message || '与后台通信失败' });
            } else {
              resolve(resp || { ok: false, retryable: true, message: '后台无响应' });
            }
          }
        );
      } catch (e) {
        resolve({ ok: false, retryable: true, message: String((e && e.message) || e) });
      }
    });
  }

  /* ---------------- 应用译文 / 失败标记 ---------------- */
  function applyTranslation(entry, translated) {
    if (entry.gen !== state.generation) return;
    const text = String(translated == null ? '' : translated).trim();
    if (!text) {
      failEntry(entry, '空译文');
      return;
    }
    state.applying = true;
    try {
      if (entry.type === 'attr') {
        entry.translated = composeAttributeText(entry.original, text, entry.attr);
        entry.el.setAttribute(entry.attr, entry.translated);
      } else {
        // 原文节点保持不动，中文紧邻原文插入，保证逐条对应且可完整恢复。
        entry.translated = text;
        if (text !== entry.original.trim()) {
          const span = document.createElement('span');
          const block = /(?:sentence|paragraph)$/.test(entry.context) &&
            !/^(button|link|nav|label|table-header|option),/.test(entry.context);
          span.className = 'ds-trans' + (block ? ' ds-trans-block' : '');
          span.lang = 'zh-CN';
          span.textContent = text;
          if (entry.node.parentNode) entry.node.parentNode.insertBefore(span, entry.node.nextSibling);
          entry.transSpan = span;
        }
      }
      state.translated.push(entry);
      state.done++;
    } finally {
      state.applying = false;
    }
    updateProgressToast();
  }

  function composeAttributeText(original, translated, attr) {
    const source = String(original || '').trim();
    if (!source || source === translated) return source || translated;
    // title 支持换行，更容易看清原文与中文；其他单行属性使用斜杠分隔。
    return attr === 'title' ? source + '\n中文：' + translated : source + ' / ' + translated;
  }

  function failEntry(entry, reason) {
    if (entry.gen !== state.generation) return;
    state.failedCount++;
    state.failed.push({ entry, reason });
    try {
      if (entry.el) entry.el.classList.add('ds-failed');
    } catch (e) {}
    updateProgressToast();
  }

  function markPending(batch, on) {
    for (const e of batch) {
      try {
        if (e.el) e.el.classList.toggle('ds-pending', on);
      } catch (err) {}
    }
  }

  /* ---------------- 完成与重试 ---------------- */
  function checkFinished() {
    if (!state.translating) return;
    if (state.queue.length > 0 || state.inflight > 0) return;
    // 不等待 pendingLazy（display:none 元素可能永不触发 IntersectionObserver）
    state.translating = false;
    state.force = false;
    const lazyHint =
      state.pendingLazy.size > 0 ? '，' + state.pendingLazy.size + ' 条将在滚动时翻译' : '';
    if (state.failedCount > 0) {
      setToast('翻译完成：成功 ' + state.done + ' 条，失败 ' + state.failedCount + ' 条' + lazyHint, 'warn', {
        actionText: '重试失败项',
        onAction: retryFailed,
      });
    } else {
      setToast('翻译完成：共 ' + state.done + ' 条' + lazyHint, 'success', { autoHide: 3500 });
    }
  }

  function retryFailed() {
    const items = state.failed.splice(0);
    if (!items.length) return;
    // 失败条目已计入 total，仅回退失败计数，避免进度虚高
    state.failedCount -= items.length;
    state.enabled = true;
    state.translating = true;
    for (const it of items) {
      try {
        if (it.entry.el) it.entry.el.classList.remove('ds-failed');
      } catch (e) {}
      it.entry.gen = state.generation;
      enqueue(it.entry);
    }
    updateProgressToast();
    drainQueue();
  }

  /* ---------------- 恢复原文 / 重新翻译 ---------------- */
  function showOriginal(notify) {
    state.enabled = false;
    state.translating = false;
    state.force = false;
    state.generation++;
    state.queue = [];
    disconnectAll();

    state.applying = true;
    try {
      for (const e of state.translated) {
        try {
          if (e.type === 'attr') {
            if (e.el.getAttribute(e.attr) === e.translated) e.el.setAttribute(e.attr, e.original);
          }
          if (e.transSpan) {
            e.transSpan.remove();
            e.transSpan = null;
          }
        } catch (err) {}
      }
      document
        .querySelectorAll('.ds-pending, .ds-failed')
        .forEach((el) => el.classList.remove('ds-pending', 'ds-failed'));
    } finally {
      state.applying = false;
    }
    state.translated = [];
    state.done = 0;
    state.total = 0;
    state.failedCount = 0;
    state.failed = [];
    hideToast();
    if (notify) setToast('已恢复原文', 'success', { autoHide: 2000 });
  }

  function retranslate() {
    showOriginal(false);
    state.force = true; // 跳过缓存重新翻译
    setTimeout(translatePage, 60);
  }

  function disconnectAll() {
    clearTimeout(moTimer);
    pendingRoots.clear();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.io) {
      state.io.disconnect();
      state.io = null;
    }
    state.pendingLazy.clear();
  }

  /* ---------------- 动态内容增量翻译 ---------------- */
  let moTimer = null;
  const pendingRoots = new Set();
  function setupMutationObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((muts) => {
      if (state.applying || !state.enabled) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE && !(n.matches && n.matches(SKIP_SELECTOR))) {
            pendingRoots.add(n);
          } else if (n.nodeType === Node.TEXT_NODE && n.parentElement &&
                     !n.parentElement.closest(SKIP_SELECTOR)) {
            pendingRoots.add(n.parentElement);
          }
        }
      }
      if (!pendingRoots.size) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(() => {
        const roots = [...pendingRoots];
        pendingRoots.clear();
        if (!state.enabled) return;
        const entries = [];
        for (const r of roots) entries.push(...collectEntries(r));
        if (!entries.length) return;
        state.total += entries.length;
        for (const e of entries) {
          if (nearViewport(e.el || e.node)) enqueue(e);
          else watchLazy(e);
        }
        updateProgressToast();
        drainQueue();
      }, 400);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------- 缓存 ---------------- */
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + s.length.toString(36);
  }
  function cacheKey(entry) {
    const settings = state.settings;
    return 't:v2:' + hash(JSON.stringify([
      location.href, settings.baseUrl, settings.model, entry.context, entry.original,
    ]));
  }
  async function saveCache(pairs) {
    if (!pairs || !pairs.length) return;
    const obj = {};
    for (const [k, v] of pairs) obj[k] = String(v);
    try {
      await chrome.storage.local.set(obj);
    } catch (e) {
      // 配额不足时清空翻译缓存后重试一次
      try {
        await clearCache();
        await chrome.storage.local.set(obj);
      } catch (e2) {}
    }
  }
  async function clearCache() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('t:'));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  /* ---------------- 页面内 Toast ---------------- */
  function ensureToast() {
    if (state.toastEl && state.toastEl.isConnected) return state.toastEl;
    const el = document.createElement('div');
    el.id = 'ds-translator-toast';
    el.setAttribute('data-kind', 'progress');
    (document.body || document.documentElement).appendChild(el);
    state.toastEl = el;
    return el;
  }

  function setToast(msg, kind = 'info', opts = {}) {
    const el = ensureToast();
    el.textContent = '';
    el.setAttribute('data-kind', kind);
    el.style.display = 'flex';
    const span = document.createElement('span');
    span.className = 'ds-toast-msg';
    span.textContent = msg;
    el.appendChild(span);
    if (opts.actionText) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opts.actionText;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideToast();
        if (typeof opts.onAction === 'function') opts.onAction();
      });
      el.appendChild(btn);
    }
    clearTimeout(el.__dsHideTimer);
    if (opts.autoHide) el.__dsHideTimer = setTimeout(hideToast, opts.autoHide);
  }

  function hideToast() {
    if (state.toastEl) state.toastEl.style.display = 'none';
  }

  function updateProgressToast() {
    if (!state.translating) return;
    const resolved = state.done + state.failedCount;
    const lazy = state.pendingLazy.size;
    const extra = lazy > 0 ? ' · ' + lazy + ' 条待滚动' : '';
    const failed = state.failedCount > 0 ? ' · 失败 ' + state.failedCount : '';
    setToast('翻译中 ' + resolved + '/' + state.total + failed + extra, 'progress');
  }

  function showErrorToast(message) {
    setToast(message, 'error', { actionText: '重试失败项', onAction: retryFailed });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
})();
