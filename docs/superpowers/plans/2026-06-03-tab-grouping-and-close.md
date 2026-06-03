# Cmd+K 标签页域名分组 + 单标签关闭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Pounce 搜索浮层(Cmd+K)里,浏览态把同域名 ≥2 个的打开标签页折叠成可展开分组(回车展开);任意标签页行提供 ✕ 按钮和 `⌘⌫`/`Ctrl+⌫` 关闭能力。

**Architecture:** 排序逻辑(`search-ranking.js`)完全不动。新增纯函数模块 `tab-grouping.js`(`buildDisplayRows`),把已排序的 `currentResults` 折叠成「显示行」数组。浮层把键盘导航/选中从索引 `currentResults` 改为索引 `displayRows`。关闭走新的 `closeTab` 后台消息 + 本地乐观更新。

**Tech Stack:** 原生 JS(无构建)、Chrome MV3 content script(executeScript 注入 + bridge.html 内嵌)、`node:test` + `node:assert` 单测、Shadow DOM + 外部 `search-overlay.css`、`i18n.js` 占位符本地化。

参考设计文档:`docs/superpowers/specs/2026-06-03-tab-grouping-and-close-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `tab-grouping.js` | 纯函数:`buildDisplayRows` / `domainKey`,把排序结果折叠成显示行 | **新建** |
| `tests/tab-grouping.test.js` | `tab-grouping.js` 单测 | **新建** |
| `background.js` | 注入列表加新模块;新增 `closeTab` 消息处理 | 改 |
| `bridge.html` | 内嵌脚本加新模块 | 改 |
| `search-overlay.js` | 显示行模型、渲染、键盘/选中、展开折叠、关闭 | 改 |
| `search-overlay.css` | 组头箭头、成员缩进、✕ 按钮样式 | 改 |
| `_locales/en/messages.json`、`_locales/zh_CN/messages.json` | `overlay_tabCount`、`overlay_closeTab` | 改 |

**约束:** 不发版,不动 `manifest.json` version / CHANGELOG / README。

**关键事实(已核实):**
- `rankResults(items, query, limit)`:空 query 时返回 `clipped`(按 source 优先级 tab→history→topSite→bookmark 排序,**不**追加 search/open 行)。`limit` 用 `slice(0, limit)` 截断。
- 浏览态要覆盖全部标签 → `rerankAndRender` 空 query 时传 `limit = merged.length`(不截断);非标签段在 `buildDisplayRows` 里按 `resultsLimit` 截断。
- 结果对象:`{type:'tab', id, url, title, displayTitle?, displayUrl?, favIconUrl?, sourceLabel?, iconFallback?}`。tab 的 `id` 是 chrome tabId。tab 无 `sourceLabel`(badge 不渲染)。
- 注入顺序在 `background.js` `injectAndShow` 的 `files` 数组 + `bridge.html` `<script>` 标签**两处**,新模块都要排在 `search-overlay.js` **之前**、`search-ranking.js` **之后**。
- `i18n.t(key, substitutions)` 支持 `$name$` 占位符(`placeholders: {name:{content:"$1"}}`)。
- 测试:`node --test tests/`,模块用 `module.exports` 即可 `require`。

---

## Task 1: 新建 `tab-grouping.js` 纯函数模块 + 单测(TDD)

**Files:**
- Create: `tab-grouping.js`
- Test: `tests/tab-grouping.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/tab-grouping.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDisplayRows, domainKey, OTHER_GROUP_KEY } = require('../tab-grouping.js');

const tab = (id, url, title) => ({ type: 'tab', id, url, title: title || url });
const hist = (url) => ({ type: 'history', url, title: url });

test('domainKey strips www and lowercases http(s) hosts', () => {
  assert.equal(domainKey('https://www.GitHub.com/pulls'), 'github.com');
  assert.equal(domainKey('http://github.com/issues'), 'github.com');
});

test('domainKey returns OTHER for non-http(s) or unparseable urls', () => {
  assert.equal(domainKey('chrome://extensions'), OTHER_GROUP_KEY);
  assert.equal(domainKey('file:///Users/x/a.html'), OTHER_GROUP_KEY);
  assert.equal(domainKey('not a url'), OTHER_GROUP_KEY);
  assert.equal(domainKey(undefined), OTHER_GROUP_KEY);
});

test('browse mode: same-domain >=2 tabs collapse into one group row', () => {
  const results = [
    tab(1, 'https://github.com/a'),
    tab(2, 'https://github.com/b'),
    tab(3, 'https://github.com/c'),
  ];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[0].domain, 'github.com');
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].expanded, false);
});

test('browse mode: expanded group emits header + member rows', () => {
  const results = [tab(1, 'https://github.com/a'), tab(2, 'https://github.com/b')];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set(['github.com']) });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].kind, 'tab');
  assert.equal(rows[1].groupDomain, 'github.com');
  assert.equal(rows[2].kind, 'tab');
});

test('browse mode: www and bare host land in the same group', () => {
  const results = [tab(1, 'https://www.github.com/a'), tab(2, 'https://github.com/b')];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

test('browse mode: singleton domain stays a flat tab row', () => {
  const results = [tab(1, 'https://figma.com/x')];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tab');
});

test('browse mode: chrome:// tabs are never grouped even if >=2', () => {
  const results = [tab(1, 'chrome://extensions'), tab(2, 'chrome://settings')];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set() });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.kind === 'tab'));
});

test('browse mode: non-tab results append after tabs, capped at nonTabLimit', () => {
  const results = [
    tab(1, 'https://github.com/a'),
    tab(2, 'https://github.com/b'),
    hist('https://a.com'),
    hist('https://b.com'),
    hist('https://c.com'),
  ];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set(), nonTabLimit: 2 });
  assert.equal(rows[0].kind, 'group');
  const others = rows.filter((r) => r.kind === 'other');
  assert.equal(others.length, 2);
});

test('search mode: never groups, one row per result', () => {
  const results = [
    tab(1, 'https://github.com/a'),
    tab(2, 'https://github.com/b'),
    hist('https://github.com/c'),
  ];
  const rows = buildDisplayRows(results, { query: 'git', expandedGroups: new Set() });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'tab');
  assert.equal(rows[2].kind, 'other');
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test tests/tab-grouping.test.js`
Expected: FAIL — `Cannot find module '../tab-grouping.js'`

- [ ] **Step 3: 实现 `tab-grouping.js`**

Create `tab-grouping.js`:

```javascript
(function() {
  'use strict';

  const OTHER_GROUP_KEY = '__other__';

  // 从 http(s) URL 取分组键(去掉 www. 的主机名)。非 http(s)、缺失或解析失败 → OTHER（永不分组）。
  function domainKey(url) {
    if (typeof url !== 'string') return OTHER_GROUP_KEY;
    if (!/^https?:\/\//i.test(url)) return OTHER_GROUP_KEY;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return host || OTHER_GROUP_KEY;
    } catch (e) {
      return OTHER_GROUP_KEY;
    }
  }

  // 把已排序的结果折叠成「可见显示行」数组。
  //   search 态(query 非空):不分组,每条结果一行。
  //   browse 态(query 空):tab 结果(排在最前)按域名分组,同域名 >=2 → 1 个可折叠组行
  //     (展开时追加成员行);单标签和 OTHER 桶保持平铺。非 tab 结果追加在后,按 nonTabLimit 截断。
  // 行结构:
  //   { kind:'group', domain, count, tabs:[...], expanded }
  //   { kind:'tab',   item, groupDomain? }
  //   { kind:'other', item }
  // 纯函数:无 DOM、无全局。expandedGroups 是域名键的 Set。
  function buildDisplayRows(results, options) {
    const items = Array.isArray(results) ? results : [];
    const opts = options || {};
    const query = String(opts.query || '').trim();
    const expanded = opts.expandedGroups instanceof Set ? opts.expandedGroups : new Set();
    const nonTabLimit = Number.isFinite(opts.nonTabLimit) ? opts.nonTabLimit : Infinity;

    if (query) {
      return items.map((item) =>
        item && item.type === 'tab' ? { kind: 'tab', item } : { kind: 'other', item }
      );
    }

    const tabs = items.filter((item) => item && item.type === 'tab');
    const others = items.filter((item) => item && item.type !== 'tab');

    const order = [];
    const buckets = new Map();
    for (const t of tabs) {
      const key = domainKey(t.url);
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key).push(t);
    }

    const rows = [];
    for (const key of order) {
      const bucket = buckets.get(key);
      if (bucket.length >= 2 && key !== OTHER_GROUP_KEY) {
        const isExpanded = expanded.has(key);
        rows.push({ kind: 'group', domain: key, count: bucket.length, tabs: bucket, expanded: isExpanded });
        if (isExpanded) {
          for (const t of bucket) rows.push({ kind: 'tab', item: t, groupDomain: key });
        }
      } else {
        for (const t of bucket) rows.push({ kind: 'tab', item: t });
      }
    }

    const cappedOthers = Number.isFinite(nonTabLimit) ? others.slice(0, Math.max(0, nonTabLimit)) : others;
    for (const item of cappedOthers) rows.push({ kind: 'other', item });

    return rows;
  }

  const api = { buildDisplayRows, domainKey, OTHER_GROUP_KEY };

  if (typeof globalThis !== 'undefined') {
    globalThis.PounceTabGrouping = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test tests/tab-grouping.test.js`
Expected: PASS(9 tests)

- [ ] **Step 5: 提交**

```bash
git add tab-grouping.js tests/tab-grouping.test.js
git commit -m "feat(overlay): add tab-grouping display-row builder with tests"
```

---

## Task 2: 把 `tab-grouping.js` 接入注入链路

**Files:**
- Modify: `background.js`(`injectAndShow` 的 `files` 数组,约 L536-545)
- Modify: `bridge.html`(`<script>` 标签,约 L11-18)

- [ ] **Step 1: background.js 注入列表加入新模块**

把:
```javascript
      'pinyin-matcher.js',
      'search-ranking.js',
      'search-overlay.js',
```
改为:
```javascript
      'pinyin-matcher.js',
      'search-ranking.js',
      'tab-grouping.js',
      'search-overlay.js',
```

- [ ] **Step 2: bridge.html 内嵌脚本加入新模块**

把:
```html
  <script src="search-ranking.js"></script>
  <script src="search-overlay.js"></script>
```
改为:
```html
  <script src="search-ranking.js"></script>
  <script src="tab-grouping.js"></script>
  <script src="search-overlay.js"></script>
```

- [ ] **Step 3: 提交**

```bash
git add background.js bridge.html
git commit -m "chore(overlay): load tab-grouping.js before search-overlay in both inject paths"
```

---

## Task 3: background.js 新增 `closeTab` 消息处理

**Files:**
- Modify: `background.js`(`onMessage` 监听器内,`closeBridgeTab` 分支之后,约 L163-166)

- [ ] **Step 1: 加入 `closeTab` 分支**

在:
```javascript
  } else if (request.action === 'closeBridgeTab') {
    chrome.tabs.remove(request.tabId).catch(() => {});
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'showSearchOverlay') {
```
的 `closeBridgeTab` 分支后插入:
```javascript
  } else if (request.action === 'closeTab') {
    // 关闭指定标签页;标签可能已被外部关掉,忽略错误。
    chrome.tabs.remove(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开放
  } else if (request.action === 'showSearchOverlay') {
```

- [ ] **Step 2: 提交**

```bash
git add background.js
git commit -m "feat(background): add closeTab message to remove a tab by id"
```

---

## Task 4: i18n 新增 `overlay_tabCount` / `overlay_closeTab`

**Files:**
- Modify: `_locales/en/messages.json`
- Modify: `_locales/zh_CN/messages.json`

- [ ] **Step 1: en 文案**

在 `_locales/en/messages.json` 里(放到任一现有 `overlay_*` 条目旁,保持 JSON 合法),新增:
```json
  "overlay_tabCount": {
    "message": "$count$ tabs",
    "description": "Group header label: number of tabs in a domain group",
    "placeholders": { "count": { "content": "$1" } }
  },
  "overlay_closeTab": {
    "message": "Close tab",
    "description": "Accessible label for the close (x) button on a tab result"
  },
```

- [ ] **Step 2: zh_CN 文案**

在 `_locales/zh_CN/messages.json` 里同样位置新增:
```json
  "overlay_tabCount": {
    "message": "$count$ 个标签页",
    "description": "分组头标签:该域名下的标签页数量",
    "placeholders": { "count": { "content": "$1" } }
  },
  "overlay_closeTab": {
    "message": "关闭标签页",
    "description": "标签页结果上 ✕ 关闭按钮的无障碍标签"
  },
```

- [ ] **Step 3: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('_locales/en/messages.json','utf8'));JSON.parse(require('fs').readFileSync('_locales/zh_CN/messages.json','utf8'));console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: 提交**

```bash
git add _locales/en/messages.json _locales/zh_CN/messages.json
git commit -m "i18n(overlay): add tab count + close-tab strings"
```

---

## Task 5: CSS 组头/成员/✕ 样式

**Files:**
- Modify: `search-overlay.css`(在 `.pounce-result-badge` 规则块之后追加,约 L321 附近)

- [ ] **Step 1: 追加样式**

在 `search-overlay.css` 里 `.pounce-result-badge-open { ... }` 规则之后追加:
```css
/* ── Domain group header & close button ── */
.pounce-group-caret {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  font-size: 10px;
  line-height: 1;
  color: var(--pn-muted-foreground);
}

.pounce-group-member {
  margin-left: 28px;
}

.pounce-result-close {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--pn-muted-foreground);
  font-size: 12px;
  line-height: 1;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}

.pn-mouse-active .pounce-search-result:hover .pounce-result-close,
.pounce-search-result.selected .pounce-result-close {
  opacity: 0.7;
}

.pounce-result-close:hover {
  opacity: 1;
  background-color: var(--pn-border);
  color: var(--pn-foreground);
}
```

- [ ] **Step 2: 提交**

```bash
git add search-overlay.css
git commit -m "style(overlay): group header caret, member indent, close button"
```

---

## Task 6: 浮层集成 —— 显示行模型、渲染、键盘/选中、展开折叠、关闭

**Files:**
- Modify: `search-overlay.js`(构造函数 L58-114、`rerankAndRender` L850-864、`renderResults` L1088-1119、`createResultElement` L1121-1211、`handleKeyDown` L1213-1260、`moveSelection` L1262-1276、`selectResult` L1319-1362)

> 本任务在单文件内紧耦合,按步骤改完后一次性提交、再到 Task 7 手动验证。

- [ ] **Step 1: 构造函数加状态**

把 L72-73:
```javascript
      this.visibleResultIndices = [];
      this.searchPreferences = normalizeSearchPreferences({});
```
改为:
```javascript
      this.visibleResultIndices = [];
      this.expandedGroups = new Set();
      this.displayRows = [];
      this.searchPreferences = normalizeSearchPreferences({});
```

- [ ] **Step 2: `rerankAndRender` 浏览态不截断标签**

把 L850-864 整个方法:
```javascript
    rerankAndRender(query) {
      const merged = Array.isArray(this.dynamicHistoryItems) && this.dynamicHistoryItems.length
        ? [...this.allData, ...this.dynamicHistoryItems]
        : this.allData;

      const limit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
      if (window.PounceSearchUtils && typeof window.PounceSearchUtils.rankResults === 'function') {
        this.currentResults = window.PounceSearchUtils.rankResults(merged, query, limit);
      } else {
        this.currentResults = this.getFallbackResults(query);
      }

      this.selectedIndex = -1;
      this.renderResults(query);
    }
```
改为:
```javascript
    rerankAndRender(query) {
      const merged = Array.isArray(this.dynamicHistoryItems) && this.dynamicHistoryItems.length
        ? [...this.allData, ...this.dynamicHistoryItems]
        : this.allData;

      const limit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
      // 浏览态(空查询)要覆盖全部打开标签 → 不截断;非标签段在 buildDisplayRows 里按 limit 截断。
      const trimmed = String(query || '').trim();
      const effectiveLimit = trimmed ? limit : ((merged && merged.length) || limit);
      if (window.PounceSearchUtils && typeof window.PounceSearchUtils.rankResults === 'function') {
        this.currentResults = window.PounceSearchUtils.rankResults(merged, query, effectiveLimit);
      } else {
        this.currentResults = this.getFallbackResults(query);
      }

      this.selectedIndex = -1;
      this.renderResults(query);
    }
```

- [ ] **Step 3: 新增 `rebuildDisplayRows`,改写 `renderResults` 遍历 `displayRows`**

把 L1088-1119 整个 `renderResults` 方法:
```javascript
    renderResults(query = '') {
      if (!this.currentResults.length) {
        this.showEmpty();
        return;
      }

      this.resultsContainer.innerHTML = '';

      this.currentResults.forEach((item, index) => {
        const resultElement = this.createResultElement(item, index, query);
        this.resultsContainer.appendChild(resultElement);
      });
      
      // 自动选中第一项
      if (this.currentResults.length > 0) {
        this.selectedIndex = 0;
        this.updateSelection();
      }

      // 列表异步重建（如 history 拉取回来后 rerankAndRender）若鼠标仍在某项上
      // 但未触发新 mousemove，selectedIndex 已被重置为 0 而 .pn-mouse-active 还在，
      // CSS :hover 会让光标下那条也高亮 → 又出现"两个选中"。
      // 这里用缓存的鼠标坐标 + shadowRoot.elementFromPoint 续上同步。
      this._syncSelectionToMouse();

      // 初始编号（异步等 layout 稳定后再算）
      requestAnimationFrame(() => this.updateNumberBadges());
      
      // 更新结果计数显示（排除搜索选项）
      const actualResultsCount = this.currentResults.filter(item => item.type !== 'search').length;
      this.updateResultsCount(actualResultsCount);
    }
```
改为:
```javascript
    rebuildDisplayRows(query) {
      const grouping = window.PounceTabGrouping;
      const nonTabLimit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
      if (grouping && typeof grouping.buildDisplayRows === 'function') {
        this.displayRows = grouping.buildDisplayRows(this.currentResults, {
          query,
          expandedGroups: this.expandedGroups,
          nonTabLimit,
        });
      } else {
        // 降级:不分组,平铺。
        this.displayRows = (this.currentResults || []).map((item) =>
          ({ kind: item && item.type === 'tab' ? 'tab' : 'other', item }));
      }
    }

    renderResults(query = '') {
      this.rebuildDisplayRows(query);

      if (!this.displayRows.length) {
        this.showEmpty();
        return;
      }

      this.resultsContainer.innerHTML = '';

      this.displayRows.forEach((row, index) => {
        const rowElement = this.createRowElement(row, index, query);
        this.resultsContainer.appendChild(rowElement);
      });

      // 自动选中第一项
      this.selectedIndex = 0;
      this.updateSelection();

      // 见原注释:异步重建后续上鼠标 hover 同步,避免"两个高亮"。
      this._syncSelectionToMouse();

      // 初始编号（异步等 layout 稳定后再算）
      requestAnimationFrame(() => this.updateNumberBadges());

      // 更新结果计数显示（排除合成的搜索选项;组头计 1 条）
      const actualResultsCount = this.displayRows.filter(
        (row) => !(row.item && row.item.type === 'search')
      ).length;
      this.updateResultsCount(actualResultsCount);
    }
```

- [ ] **Step 4: 新增 `createRowElement` / `createGroupElement`,并给 `createResultElement` 加 ✕ 按钮 + 成员缩进**

在 `createResultElement` 方法**之前**(即 L1121 `createResultElement(item, index, query = '') {` 上方)插入:
```javascript
    createRowElement(row, index, query = '') {
      if (row.kind === 'group') {
        return this.createGroupElement(row, index);
      }
      return this.createResultElement(row.item, index, query, row);
    }

    createGroupElement(row, index) {
      const element = document.createElement('div');
      element.className = 'pounce-search-result pounce-group-header';
      element.dataset.index = String(index);
      if (index === this.selectedIndex) {
        element.classList.add('selected');
      }

      const num = document.createElement('div');
      num.className = 'pounce-result-number';

      const caret = document.createElement('div');
      caret.className = 'pounce-group-caret';
      caret.textContent = row.expanded ? '▾' : '▸';

      const icon = document.createElement('div');
      icon.className = 'pounce-result-icon tab';
      const firstTab = row.tabs && row.tabs[0];
      const favIconUrl = firstTab ? this.getSafeFaviconUrl(firstTab) : '';
      const fallbackChar = (row.domain && row.domain[0] ? row.domain[0] : '?').toUpperCase();
      if (favIconUrl && !favIconUrl.startsWith('chrome://')) {
        const img = document.createElement('img');
        img.referrerPolicy = 'no-referrer';
        img.src = favIconUrl;
        img.alt = row.domain;
        img.onerror = function() {
          icon.innerHTML = '';
          icon.textContent = fallbackChar;
        };
        icon.appendChild(img);
      } else {
        icon.textContent = fallbackChar;
      }

      const content = document.createElement('div');
      content.className = 'pounce-result-content';
      const title = document.createElement('div');
      title.className = 'pounce-result-title';
      title.textContent = row.domain;
      const sub = document.createElement('div');
      sub.className = 'pounce-result-url';
      sub.textContent = window.i18n
        ? window.i18n.t('overlay_tabCount', [String(row.count)])
        : `${row.count} tabs`;
      content.appendChild(title);
      content.appendChild(sub);

      element.appendChild(num);
      element.appendChild(caret);
      element.appendChild(icon);
      element.appendChild(content);

      element.addEventListener('click', () => {
        this.selectResult(index);
      });

      return element;
    }
```

然后修改 `createResultElement`:把签名 L1121
```javascript
    createResultElement(item, index, query = '') {
      const element = document.createElement('div');
      element.className = 'pounce-search-result';
      element.dataset.index = String(index);
```
改为(加 `row` 参数 + 成员缩进 class):
```javascript
    createResultElement(item, index, query = '', row = null) {
      const element = document.createElement('div');
      element.className = 'pounce-search-result';
      if (row && row.groupDomain) {
        element.classList.add('pounce-group-member');
      }
      element.dataset.index = String(index);
```

并在 `createResultElement` 的 click handler 之前(L1204-1208)
```javascript
      // Click handler
      element.addEventListener('click', () => {
        this.selectResult(index);
      });
      
      return element;
```
改为(插入 ✕ 按钮):
```javascript
      // 标签页行:右侧 ✕ 关闭按钮(hover/选中时显现)
      if (item.type === 'tab') {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'pounce-result-close';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', window.i18n ? window.i18n.t('overlay_closeTab') : 'Close tab');
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeTabAtIndex(index);
        });
        element.appendChild(closeBtn);
      }

      // Click handler
      element.addEventListener('click', () => {
        this.selectResult(index);
      });
      
      return element;
```

- [ ] **Step 5: `handleKeyDown` —— Enter 走 displayRows,新增 ⌘⌫/Ctrl+⌫ 关闭**

把 L1217-1239:
```javascript
      if (e.key === 'Enter' && performance.now() - this.compositionEndedAt < IME_TRAILING_ENTER_GUARD_MS) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.moveSelection(1);
          break;
          
        case 'ArrowUp':
          e.preventDefault();
          this.moveSelection(-1);
          break;
          
        case 'Enter':
          e.preventDefault();
          if (this.selectedIndex >= 0 && this.selectedIndex < this.currentResults.length) {
            this.selectResult(this.selectedIndex);
          }
          break;
```
改为:
```javascript
      if (e.key === 'Enter' && performance.now() - this.compositionEndedAt < IME_TRAILING_ENTER_GUARD_MS) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ⌘⌫(Mac)/ Ctrl+⌫:关闭当前选中的标签页行。普通 Backspace 不拦截(留给搜索框删字)。
      if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
        if (this.selectedIndex >= 0 && this.selectedIndex < this.displayRows.length) {
          const sel = this.displayRows[this.selectedIndex];
          if (sel && sel.kind === 'tab') {
            e.preventDefault();
            this.closeTabAtIndex(this.selectedIndex);
          }
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.moveSelection(1);
          break;
          
        case 'ArrowUp':
          e.preventDefault();
          this.moveSelection(-1);
          break;
          
        case 'Enter':
          e.preventDefault();
          if (this.selectedIndex >= 0 && this.selectedIndex < this.displayRows.length) {
            this.selectResult(this.selectedIndex);
          }
          break;
```

- [ ] **Step 6: `moveSelection` 改用 `displayRows`**

把 L1262-1276:
```javascript
    moveSelection(direction) {
      if (!this.currentResults.length) return;
      
      const newIndex = this.selectedIndex + direction;
      
      if (newIndex >= 0 && newIndex < this.currentResults.length) {
        this.selectedIndex = newIndex;
      } else if (newIndex < 0) {
        this.selectedIndex = this.currentResults.length - 1;
      } else {
        this.selectedIndex = 0;
      }
      
      this.updateSelection();
    }
```
改为:
```javascript
    moveSelection(direction) {
      if (!this.displayRows.length) return;
      
      const newIndex = this.selectedIndex + direction;
      
      if (newIndex >= 0 && newIndex < this.displayRows.length) {
        this.selectedIndex = newIndex;
      } else if (newIndex < 0) {
        this.selectedIndex = this.displayRows.length - 1;
      } else {
        this.selectedIndex = 0;
      }
      
      this.updateSelection();
    }
```

- [ ] **Step 7: `selectResult` 改用 `displayRows`,新增 `toggleGroup` 与 `closeTabAtIndex`**

把 L1319-1362 整个 `selectResult`:
```javascript
    async selectResult(index) {
      if (index < 0 || index >= this.currentResults.length) return;
      
      const item = this.currentResults[index];
      
      try {
        if (item.type === 'search') {
          const searchQuery = item.url.replace('search:', '');
          await chrome.runtime.sendMessage({
            action: 'performWebSearch',
            query: searchQuery,
            bridgeTabId: this.bridgeTabId
          });
        } else if (item.type === 'open') {
          await chrome.runtime.sendMessage({
            action: 'openBookmark',
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        } else if (item.type === 'tab') {
          // Switch to existing tab; if bridge tab exists, close it first
          await chrome.runtime.sendMessage({
            action: 'switchToTab',
            tabId: item.id,
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        } else {
          // Open bookmark/history/top site — navigate bridge tab or open new tab
          await chrome.runtime.sendMessage({
            action: 'openBookmark',
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        }

        // Bridge is now owned by background (reused as destination or already closed);
        // clear so hide() won't re-close the freshly-loaded tab.
        this.bridgeTabId = null;
        this.hide();
      } catch (error) {
        console.error('Pounce: Error selecting result:', error);
      }
    }
```
改为:
```javascript
    async selectResult(index) {
      if (index < 0 || index >= this.displayRows.length) return;

      const row = this.displayRows[index];
      if (!row) return;

      // 组头:回车/点击 = 展开或收起
      if (row.kind === 'group') {
        this.toggleGroup(row.domain, index);
        return;
      }

      const item = row.item;
      if (!item) return;

      try {
        if (item.type === 'search') {
          const searchQuery = item.url.replace('search:', '');
          await chrome.runtime.sendMessage({
            action: 'performWebSearch',
            query: searchQuery,
            bridgeTabId: this.bridgeTabId
          });
        } else if (item.type === 'open') {
          await chrome.runtime.sendMessage({
            action: 'openBookmark',
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        } else if (item.type === 'tab') {
          // Switch to existing tab; if bridge tab exists, close it first
          await chrome.runtime.sendMessage({
            action: 'switchToTab',
            tabId: item.id,
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        } else {
          // Open bookmark/history/top site — navigate bridge tab or open new tab
          await chrome.runtime.sendMessage({
            action: 'openBookmark',
            url: item.url,
            bridgeTabId: this.bridgeTabId
          });
        }

        // Bridge is now owned by background (reused as destination or already closed);
        // clear so hide() won't re-close the freshly-loaded tab.
        this.bridgeTabId = null;
        this.hide();
      } catch (error) {
        console.error('Pounce: Error selecting result:', error);
      }
    }

    // 展开/收起某域名分组,保持选中停在该组头(组头自身行号不变)。
    toggleGroup(domain, index) {
      if (this.expandedGroups.has(domain)) {
        this.expandedGroups.delete(domain);
      } else {
        this.expandedGroups.add(domain);
      }
      this.renderResults(this.searchInput ? this.searchInput.value : '');
      if (this.displayRows.length) {
        this.selectedIndex = Math.min(index, this.displayRows.length - 1);
        this.updateSelection();
      }
    }

    // 关闭某显示行对应的标签页:发后台消息 + 本地乐观删除 + 重渲染并续上选中。
    closeTabAtIndex(index) {
      if (index < 0 || index >= this.displayRows.length) return;
      const row = this.displayRows[index];
      if (!row || row.kind !== 'tab' || !row.item || row.item.type !== 'tab') return;
      const tabId = row.item.id;

      chrome.runtime.sendMessage({ action: 'closeTab', tabId }).catch(() => {});

      const dropTab = (arr) => Array.isArray(arr)
        ? arr.filter((it) => !(it && it.type === 'tab' && it.id === tabId))
        : arr;
      this.allData = dropTab(this.allData);
      this.currentResults = dropTab(this.currentResults);

      const targetIndex = index;
      this.renderResults(this.searchInput ? this.searchInput.value : '');
      if (this.displayRows.length) {
        this.selectedIndex = Math.min(targetIndex, this.displayRows.length - 1);
        this.updateSelection();
      }
    }
```

- [ ] **Step 8: 提交**

```bash
git add search-overlay.js
git commit -m "feat(overlay): domain grouping, expand/collapse, and per-tab close"
```

---

## Task 7: 全量测试 + 扩展内手动验证

**Files:** 无(验证)

- [ ] **Step 1: 跑全量单测**

Run: `node --test tests/`
Expected: 全部 PASS(含新增的 tab-grouping 9 项,且既有 search-overlay/search-ranking 测试不回归)

- [ ] **Step 2: 加载未打包扩展手动验证**

1. Chrome → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选本目录(或重新加载)。
2. 开 ≥3 个同域名标签(如 3 个 github.com 页 + 1 个 figma.com)。
3. 按 `Cmd+K`:确认 github.com 折叠成一行「▸ github.com / 3 tabs」,figma.com 是单独一行。
4. 选中 github 组按 `回车`:展开成 `▾` + 3 条缩进成员;再回车收起。
5. `↑/↓` 在可见行间移动(折叠时跳过成员)。
6. 选中某标签行按 `⌘⌫`(Mac)/ `Ctrl+⌫`:该标签关闭,列表即时更新,选中落到下一行。
7. 鼠标悬停标签行 → 出现 `✕`,点击关闭。
8. 输入关键词(如 `git`):列表退回平铺(无分组),✕ 和 `⌘⌫` 仍可关闭。
9. 切到中文(设置页切语言)复查组头计数显示「N 个标签页」、✕ 的 aria-label。
10. 边界:含 `chrome://` 页的不分组;只有 1 个标签的域名不出现组头。

- [ ] **Step 3: 确认无回退后(由用户决定是否提交/发版)**

本计划不发版。手动验证通过即完成;后续发版另走 `release` skill。

---

## Self-Review(已对照 spec)

- **Spec 覆盖:** 分组规则(§2)→ Task1 `buildDisplayRows`;域名键/`__other__`(§4.2)→ Task1 `domainKey`+测试;覆盖全部标签绕过上限(§2)→ Task6 Step2 `effectiveLimit`;非标签段限流(§5)→ Task1 `nonTabLimit` + Task6 Step3;展开折叠(§7)→ Task6 Step7 `toggleGroup`;`⌘⌫`/✕ 关闭(§5/§8)→ Task6 Step5/Step7 + Task3;选中恢复(§8)→ `toggleGroup`/`closeTabAtIndex` 重渲染后回填 `selectedIndex`;边界(§9)→ Task1 chrome:// 测试 + Task7 手动;i18n(§10)→ Task4;CSS(§6)→ Task5;注入两处(spec 未显式但实现必需)→ Task2。
- **占位符扫描:** 无 TBD/TODO;每个代码步骤都给了完整代码与精确替换锚点。
- **类型/命名一致:** 行 `kind` 取值 `group|tab|other` 在 Task1 定义、Task6 渲染/选择/关闭一致使用;方法名 `buildDisplayRows`/`rebuildDisplayRows`/`createRowElement`/`createGroupElement`/`toggleGroup`/`closeTabAtIndex`/`closeTab`(消息)全程一致;`expandedGroups`(Set)、`displayRows`(数组)命名一致。
