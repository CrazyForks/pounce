const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preferences = require('../preferences.js');

class FakeTextNode {
  constructor(text) {
    this.textContent = text;
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.eventListeners = {};
    this.className = '';
    this.classList = {
      add: (...tokens) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        tokens.forEach((token) => current.add(token));
        this.className = [...current].join(' ');
      },
      remove: (...tokens) => {
        const remove = new Set(tokens);
        this.className = this.className.split(/\s+/).filter((token) => token && !remove.has(token)).join(' ');
      },
      toggle: (token, force) => {
        const has = this.className.split(/\s+/).includes(token);
        const shouldHave = force === undefined ? !has : !!force;
        if (shouldHave && !has) this.classList.add(token);
        if (!shouldHave && has) this.classList.remove(token);
        return shouldHave;
      },
      contains: (token) => this.className.split(/\s+/).includes(token)
    };
    this.id = '';
    this.value = '';
    this.textContent = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  attachShadow() {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      this.eventListeners[type] = [];
    }
    this.eventListeners[type].push(handler);
  }

  focus() {
    this.focused = true;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  querySelectorAll(selector) {
    const results = [];
    const matches = (element) => {
      if (!(element instanceof FakeElement)) return false;
      if (selector.startsWith('.')) {
        return element.className.split(/\s+/).includes(selector.slice(1));
      }
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (element) => {
      if (!(element instanceof FakeElement)) return;
      if (matches(element)) results.push(element);
      element.children.forEach(visit);
    };
    visit(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.getElementById(id);
        if (found) return found;
      }
    }
    return null;
  }
}

class FakeShadowRoot extends FakeElement {
  constructor() {
    super('#shadow-root');
    this.activeElement = null;
  }
}

function createOverlayHarness() {
  const document = {
    readyState: 'complete',
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    eventListeners: {},
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(text),
    addEventListener(type, handler) {
      if (!this.eventListeners[type]) {
        this.eventListeners[type] = [];
      }
      this.eventListeners[type].push(handler);
    },
    removeEventListener() {}
  };
  document.body.style = {};

  const context = {
    console,
    clearTimeout,
    setTimeout,
    requestAnimationFrame: (handler) => handler(),
    performance: { now: () => 1000 },
    navigator: { platform: 'MacIntel', userAgent: 'Macintosh' },
    URL,
    document,
    PouncePreferences: preferences,
    ContentThemeManager: class ContentThemeManager {},
    chrome: {
      runtime: {
        getManifest: () => ({ version: 'test' }),
        getURL: (file) => `chrome-extension://pounce/${file}`,
        onMessage: {
          addListener() {},
          removeListener() {}
        },
        sendMessage: () => Promise.resolve({ success: true })
      },
      storage: {
        sync: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve()
        },
        onChanged: {
          addListener() {},
          removeListener() {}
        }
      }
    }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'search-overlay.js'), 'utf8'),
    context,
    { filename: 'search-overlay.js' }
  );

  return context.window.pounceSearchOverlay;
}

test('overlay fallback results honor the configured results limit', () => {
  const overlay = createOverlayHarness();
  overlay.searchPreferences = preferences.normalizeSearchPreferences({ resultsLimit: 20 });
  overlay.allData = Array.from({ length: 25 }, (_, index) => ({
    type: 'history',
    id: `history:${index}`,
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
    typedCount: 1,
    visitCount: 1,
    lastVisitTime: index
  }));

  const results = overlay.getFallbackResults('');

  assert.equal(results.length, 20);
});

test('fallback actions keep complete-url search at the bottom', () => {
  const overlay = createOverlayHarness();
  overlay.searchPreferences = preferences.normalizeSearchPreferences({ resultsLimit: 20 });
  overlay.allData = [{
    type: 'history',
    id: 'history:1',
    title: 'Example',
    url: 'https://example.com/',
    typedCount: 1,
    visitCount: 1,
    lastVisitTime: 1
  }];

  const directResults = overlay.getFallbackResults('https://example.com');
  assert.deepEqual(Array.from(directResults, (item) => item.type), ['open', 'history', 'search']);

  const searchResults = overlay.getFallbackResults('example');
  assert.deepEqual(Array.from(searchResults, (item) => item.type), ['search', 'history']);
});

test('Esc closes the overlay when the results limit select has focus', () => {
  const overlay = createOverlayHarness();
  let hideCalls = 0;
  overlay.isVisible = true;
  overlay.hide = () => {
    hideCalls += 1;
  };

  overlay.docKeyUpHandler({
    key: 'Escape',
    target: overlay.resultsLimitSelect,
    composedPath: () => [overlay.resultsLimitSelect],
    preventDefault() {},
    stopPropagation() {}
  });

  assert.equal(hideCalls, 1);
});

test('changing the results limit returns focus to the search input', () => {
  const overlay = createOverlayHarness();
  overlay.isVisible = true;
  overlay.resultsLimitSelect.value = '20';
  overlay.updateResultsLimitPreference = () => {};

  overlay.handleResultsLimitSelectChange();

  assert.equal(overlay.searchInput.focused, true);
});

test('favicon selection keeps external icons behind the extension favicon lookup', () => {
  const overlay = createOverlayHarness();

  assert.equal(overlay.getSafeFaviconUrl({
    type: 'history',
    url: 'https://example.com/page',
    favIconUrl: 'https://example.com/favicon.ico'
  }), overlay.getFaviconUrl('https://example.com/page'));

  assert.equal(overlay.getSafeFaviconUrl({
    type: 'history',
    url: 'https://example.com/page',
    favIconUrl: 'chrome-extension://pounce/icons/example.png'
  }), 'chrome-extension://pounce/icons/example.png');

  assert.equal(overlay.getSafeFaviconUrl({
    type: 'history',
    url: 'https://example.com/page',
    favIconUrl: 'chrome://favicon/example'
  }), overlay.getFaviconUrl('https://example.com/page'));
});

test('direct open results use extension favicon lookup without storing duplicate icon urls', () => {
  const overlay = createOverlayHarness();

  const result = overlay.createOpenFallbackResult('example.com');

  assert.equal(result.type, 'open');
  assert.equal(result.favIconUrl, undefined);
  assert.equal(overlay.getSafeFaviconUrl(result), overlay.getFaviconUrl('https://example.com/'));
});

test('result icons fall back to letters when favicon loading fails', () => {
  const overlay = createOverlayHarness();
  const element = overlay.createResultElement({
    type: 'history',
    id: 'history:1',
    title: 'Example',
    displayTitle: 'Example',
    url: 'https://example.com/',
    displayUrl: 'example.com',
    iconFallback: 'H',
    favIconUrl: 'https://example.com/favicon.ico'
  }, 0, '');

  const icon = element.querySelector('.pounce-result-icon');
  const img = icon.querySelector('img');

  assert.equal(img.src, overlay.getFaviconUrl('https://example.com/'));
  img.onerror();
  assert.equal(icon.textContent, 'H');
});

test('web search fallback rewrites to the selected engine URL', () => {
  const overlay = createOverlayHarness();
  overlay.searchPreferences = preferences.normalizeSearchPreferences({ searchEngine: 'bing' });
  overlay.currentResults = [{ id: 'web-search', type: 'search', url: 'search:hello world' }];

  overlay.applyEngineToWebSearch();

  assert.equal(overlay.currentResults[0].engineUrl, 'https://www.bing.com/search?q=hello%20world');
  assert.equal(overlay.currentResults[0].displayUrl, 'Bing');
});

test('web search title and result icon follow the selected engine', () => {
  const overlay = createOverlayHarness();
  overlay.searchPreferences = preferences.normalizeSearchPreferences({ searchEngine: 'github' });
  overlay.currentResults = [{ id: 'web-search', type: 'search', url: 'search:hello' }];

  overlay.applyEngineToWebSearch();

  assert.equal(overlay.currentResults[0].displayTitle, 'GitHub for "hello"');
  const result = overlay.createResultElement(overlay.currentResults[0], 0, 'hello');
  const icon = result.querySelector('.pounce-result-icon');
  assert.equal(icon.dataset.engine, 'github');
  assert.equal(icon.classList.contains('search-engine-icon'), true);
  assert.match(icon.innerHTML, /<svg/);

  overlay.searchPreferences = preferences.normalizeSearchPreferences({ searchEngine: 'default' });
  overlay.applyEngineToWebSearch();
  assert.equal(overlay.currentResults[0].displayTitle, 'Search for "hello"');
  assert.equal(overlay.currentResults[0].engineUrl, undefined);
});

test('web search fallback keeps browser default (no engineUrl) for default engine', () => {
  const overlay = createOverlayHarness();
  overlay.searchPreferences = preferences.normalizeSearchPreferences({ searchEngine: 'default' });
  overlay.currentResults = [{ id: 'web-search', type: 'search', url: 'search:hello' }];

  overlay.applyEngineToWebSearch();

  assert.equal(overlay.currentResults[0].engineUrl, undefined);
  assert.equal(overlay.currentResults[0].url, 'search:hello');
});

test('hiding the overlay resets the engine menu so it does not reopen', () => {
  const overlay = createOverlayHarness();
  overlay.isVisible = true;
  // 走 bridgeTab 提前 return 分支(不触到 blur),验证该路径也复位菜单。
  overlay.bridgeTabId = 'bridge-1';
  let closed = 0;
  overlay.closeEngineMenu = () => { closed += 1; };

  overlay.hide();

  assert.equal(closed, 1);
});

test('engine menu is mounted on the overlay, not inside the clipped container', () => {
  const overlay = createOverlayHarness();
  // 菜单必须是 overlay 的直接子节点,才能脱离 .pounce-search-container 的 overflow:hidden。
  assert.equal(overlay.engineMenu.parentNode, overlay.overlay);
});

test('opening the engine menu positions it below the button in viewport coords', () => {
  const overlay = createOverlayHarness();
  overlay.engineBtn.getBoundingClientRect = () => ({ left: 100, bottom: 60 });

  overlay.positionEngineMenu();

  assert.equal(overlay.engineMenu.style.left, '100px');
  assert.equal(overlay.engineMenu.style.top, '66px');
});

test('placeholder cycles through feature hints (fallback text)', () => {
  const overlay = createOverlayHarness();

  overlay._placeholderIndex = 0;
  overlay.applyPlaceholder();
  assert.match(overlay.searchInput.placeholder, /tabs, history/);

  overlay._placeholderIndex = 2;
  overlay.applyPlaceholder();
  assert.match(overlay.searchInput.placeholder, /search engine/i);
});

test('typing stops the placeholder rotation timer', () => {
  const overlay = createOverlayHarness();
  overlay._placeholderTimer = setTimeout(() => {}, 999999); // 假装正在轮播

  overlay.syncPlaceholderRotation('hello');

  assert.equal(overlay._placeholderTimer, null);
});
