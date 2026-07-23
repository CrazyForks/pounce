// Pounce Search Overlay - Content Script
(function() {
  'use strict';

  // 版本守卫：扩展更新后旧的 content script 仍残留在页面上，重新注入会被早退守卫卡死，
  // 老 keyboard 行为继续生效到用户刷新页面为止。这里用 manifest 版本对比，
  // 同版本短路返回；不同版本先 destroy 旧实例再重新初始化。
  let POUNCE_OVERLAY_VERSION = 'unknown';
  try {
    POUNCE_OVERLAY_VERSION = chrome.runtime.getManifest().version;
  } catch (e) {
    // chrome.runtime 在某些边缘场景可能失效；fallback 使版本检查失败 → 强制替换
  }

  if (window.pounceSearchOverlay) {
    const existing = window.pounceSearchOverlay;
    if (existing.version === POUNCE_OVERLAY_VERSION) {
      return;
    }
    try {
      if (typeof existing.destroy === 'function') existing.destroy();
    } catch (err) {
      console.warn('Pounce: failed to destroy stale overlay instance', err);
    }
    window.pounceSearchOverlay = null;
  }

  // compositionend 之后 Chrome/macOS IME 偶发多发一次 Enter keydown（isComposing=false），
  // 此窗口内收到的 Enter 一律视为 IME trailing，避免误触发 selectResult。
  const IME_TRAILING_ENTER_GUARD_MS = 120;
  const HIGHLIGHTABLE_TYPES = ['tab', 'history', 'topSite', 'bookmark'];
  const PREFERENCES = globalThis.PouncePreferences || {};
  const DEFAULT_SEARCH_PREFERENCES = PREFERENCES.DEFAULT_SEARCH_PREFERENCES || {
    quickPickEnabled: true,
    pinyinMatchingEnabled: true,
    tabGroupingEnabled: false,
    resultsLimit: 10,
    searchEngine: 'default'
  };
  const ALLOWED_RESULTS_LIMITS = PREFERENCES.ALLOWED_RESULTS_LIMITS || [10, 20, 50];
  const ALLOWED_SEARCH_ENGINES = PREFERENCES.ALLOWED_SEARCH_ENGINES || ['default', 'google', 'bing', 'github', 'linuxdo'];
  const SEARCH_PREFERENCE_KEYS = PREFERENCES.SEARCH_PREFERENCE_KEYS || Object.keys(DEFAULT_SEARCH_PREFERENCES);
  const normalizeResultsLimit = PREFERENCES.normalizeResultsLimit || ((value) => {
    const num = Number(value);
    return ALLOWED_RESULTS_LIMITS.includes(num) ? num : DEFAULT_SEARCH_PREFERENCES.resultsLimit;
  });
  const normalizeSearchEngine = PREFERENCES.normalizeSearchEngine || ((value) => {
    return ALLOWED_SEARCH_ENGINES.includes(value) ? value : DEFAULT_SEARCH_PREFERENCES.searchEngine;
  });
  const normalizeSearchPreferences = PREFERENCES.normalizeSearchPreferences || ((values) => {
    const source = values && typeof values === 'object' ? values : {};
    return SEARCH_PREFERENCE_KEYS.reduce((preferences, key) => {
      if (key === 'resultsLimit') {
        preferences[key] = normalizeResultsLimit(source[key]);
      } else if (key === 'searchEngine') {
        preferences[key] = normalizeSearchEngine(source[key]);
      } else {
        preferences[key] = typeof source[key] === 'boolean'
          ? source[key]
          : DEFAULT_SEARCH_PREFERENCES[key];
      }
      return preferences;
    }, {});
  });

  // 引擎图标(内联 SVG,不依赖本地 favicon 缓存,任意站点都能显示)。
  // github/bing 用 currentColor 单色跟随主题;linuxdo 为自带浅底的彩色 logo。
  const ENGINE_ICON_GITHUB = '<svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M16 0C7.16 0 0 7.16 0 16C0 23.08 4.58 29.06 10.94 31.18C11.74 31.32 12.04 30.84 12.04 30.42C12.04 30.04 12.02 28.78 12.02 27.44C8 28.18 6.96 26.46 6.64 25.56C6.46 25.1 5.68 23.68 5 23.3C4.44 23 3.64 22.26 4.98 22.24C6.24 22.22 7.14 23.4 7.44 23.88C8.88 26.3 11.18 25.62 12.1 25.2C12.24 24.16 12.66 23.46 13.12 23.06C9.56 22.66 5.84 21.28 5.84 15.16C5.84 13.42 6.46 11.98 7.48 10.86C7.32 10.46 6.76 8.82 7.64 6.62C7.64 6.62 8.98 6.2 12.04 8.26C13.32 7.9 14.68 7.72 16.04 7.72C17.4 7.72 18.76 7.9 20.04 8.26C23.1 6.18 24.44 6.62 24.44 6.62C25.32 8.82 24.76 10.46 24.6 10.86C25.62 11.98 26.24 13.4 26.24 15.16C26.24 21.3 22.5 22.66 18.94 23.06C19.52 23.56 20.02 24.52 20.02 26.02C20.02 28.16 20 29.88 20 30.42C20 30.84 20.3 31.34 21.1 31.18C27.42 29.06 32 23.06 32 16C32 7.16 24.84 0 16 0V0Z"/></svg>';
  const ENGINE_ICON_BING = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.176 15.406a6.48 6.48 0 01-1.736 4.414c1.338-1.47.803-3.869-1.003-4.635-.862-.305-2.488-.85-3.367-1.158a1.834 1.834 0 01-.932-.818c-.381-.975-1.163-2.968-1.548-3.948-.095-.285-.31-.625-.265-.938.046-.598.724-1.003 1.276-.754l3.682 1.888c.621.292 1.305.692 1.796 1.172a6.486 6.486 0 012.097 4.777zm-1.44 1.888c-.264-1.194-1.135-1.744-2.216-2.028-1.527.902-4.853 2.878-6.952 4.13-1.103.68-2.13 1.35-2.919 1.242a2.866 2.866 0 01-2.77-2.325c-.012-.048-.008-.03-.001.01a6.4 6.4 0 00.947 2.653 6.498 6.498 0 005.486 3.022c1.908.062 3.536-1.153 5.099-2.096.292-.188.804-.496 1.332-.831l1.423-1.51c.553-.577.764-1.426.571-2.267zm-12.04 2.97c.422 0 .822-.1 1.173-.29.355-.215.964-.579 1.7-1.018L9.57 4.502c0-.99-.497-1.864-1.257-2.382-.08-.059-2.91-1.901-2.99-1.956-.605-.432-1.523.045-1.5.797v14.887l.417 2.36a2.488 2.488 0 002.455 2.056z"/></svg>';
  const ENGINE_ICON_LINUXDO = '<svg viewBox="0 0 120 120" width="18" height="18" aria-hidden="true"><clipPath id="pounce-ld-clip"><circle cx="60" cy="60" r="47"/></clipPath><circle fill="#f0f0f0" cx="60" cy="60" r="50"/><rect fill="#1c1c1e" clip-path="url(#pounce-ld-clip)" x="10" y="10" width="100" height="30"/><rect fill="#f0f0f0" clip-path="url(#pounce-ld-clip)" x="10" y="40" width="100" height="40"/><rect fill="#ffb003" clip-path="url(#pounce-ld-clip)" x="10" y="80" width="100" height="30"/></svg>';

  // 引擎元数据：buildUrl 为 null 表示走浏览器默认引擎（chrome.search.query）。
  // iconSvg 有则用内联图标；否则 home 取该站 favicon（google）；都无则用放大镜（default）。
  const SEARCH_ENGINES = {
    default: { label: 'Default', buildUrl: null },
    google:  { label: 'Google',  home: 'https://www.google.com', buildUrl: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) },
    bing:    { label: 'Bing',    iconSvg: ENGINE_ICON_BING,      buildUrl: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) },
    github:  { label: 'GitHub',  iconSvg: ENGINE_ICON_GITHUB,    buildUrl: (q) => 'https://github.com/search?q=' + encodeURIComponent(q) },
    linuxdo: { label: 'LinuxDo', iconSvg: ENGINE_ICON_LINUXDO,   buildUrl: (q) => 'https://linux.do/search?q=' + encodeURIComponent(q) }
  };

  // 空搜索框时轮播的功能提示(第 0 条为原始 placeholder)。
  const PLACEHOLDER_KEYS = [
    'overlay_searchPlaceholder',
    'overlay_placeholderUrl',
    'overlay_placeholderEngine',
    'overlay_placeholderWebSearch',
    'overlay_placeholderPinyin',
    'overlay_placeholderCombo',
    'overlay_placeholderCloseTab'
  ];
  const PLACEHOLDER_ROTATE_MS = 5000;
  const PLACEHOLDER_FALLBACKS = {
    overlay_searchPlaceholder: 'Search tabs, history, bookmarks, and top sites…',
    overlay_placeholderUrl: 'Type a URL and press Enter to open it',
    overlay_placeholderEngine: 'Click the left icon to switch search engine',
    overlay_placeholderWebSearch: 'Select the “Search for…” result to search the web',
    overlay_placeholderPinyin: 'Search Chinese tabs by pinyin, too',
    overlay_placeholderCombo: 'Separate keywords with spaces to narrow results',
    overlay_placeholderCloseTab: 'Press ✕ on a result to close that tab'
  };

  class PounceSearchOverlay {
    constructor() {
      this.overlay = null;
      this.searchInput = null;
      this._placeholderTimer = null;
      this._placeholderIndex = 0;
      this.resultsContainer = null;
      this.resultsCounter = null;
      this.currentResults = [];
      this.selectedIndex = -1;
      this.isVisible = false;
      this.themeManager = null;
      this.dynamicHistoryItems = [];
      this.historyFetchTimer = null;
      this.historyFetchRequestId = 0;
      this.bridgeTabId = null;
      this.visibleResultIndices = [];
      this.expandedGroups = new Set();
      this.displayRows = [];
      this.searchPreferences = normalizeSearchPreferences({});
      this.quickPickHint = null;
      this.resultsLimitSelect = null;
      this.enginePicker = null;
      this.engineBtn = null;
      this.engineMenu = null;

      // 版本标记 + destroy 状态，供扩展更新时旧实例替换逻辑使用
      this.version = POUNCE_OVERLAY_VERSION;
      this.isDestroyed = false;
      this.shadowHost = null;
      this.docKeyDownHandler = null;
      this.docKeyUpHandler = null;
      this.focusShieldHandler = null;
      this.focusRestoreFrame = null;
      this.focusRestoreTimer = null;
      this.runtimeMessageHandler = null;
      this.storageChangeHandler = null;
      this.languageChangeHandler = null;

      // 静态文本节点引用，用于语言切换时实时刷新
      this.resultsCounterStaticKey = 'overlay_zeroResults';
      this.navigateHintEl = null;
      this.selectHintEl = null;
      this.quickPickHintLabelEl = null;
      this.closeHintEl = null;

      // 鼠标真实移动跟踪：Cmd+K 弹出时若光标恰好压在某项上，
      // CSS :hover 会立刻点亮那一项，与键盘默认选中的第 1 项形成"两个高亮"。
      // 通过门控 :hover（CSS 用 .pn-mouse-active 父类），只有用户真正移动鼠标
      // 超过阈值后才允许 hover 生效，并同步把 selectedIndex 推到光标所在项。
      this._mouseActive = false;
      this._mouseBaselineX = null;
      this._mouseBaselineY = null;
      this._lastMouseX = null;
      this._lastMouseY = null;

      // Mac 用 ⌥ 符号，其他平台用 Alt+ 前缀
      const isMac = navigator.platform.toUpperCase().includes('MAC') ||
        navigator.userAgent.toUpperCase().includes('MAC');
      this.shortcutPrefix = isMac ? '⌥' : 'Alt+';
      this.shortcutKeyLabel = isMac ? '⌥' : 'Alt';

      this.init();
    }

    getSearchIconSvg() {
      return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="11" cy="11" r="7.5" stroke="currentColor" stroke-width="1.75"/>
          <path d="M20 20L16.5 16.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
        </svg>
      `;
    }

    getFaviconUrl(pageUrl) {
      const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
      faviconUrl.searchParams.set('pageUrl', pageUrl);
      faviconUrl.searchParams.set('size', '32');
      return faviconUrl.toString();
    }

    isExtensionIconUrl(value) {
      if (!value || typeof value !== 'string') return false;
      try {
        const parsed = new URL(value);
        const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
        return parsed.protocol === 'chrome-extension:' && parsed.origin === extensionOrigin;
      } catch (error) {
        return false;
      }
    }

    getSafeFaviconUrl(item) {
      if (!item || item.type === 'search' || !item.url) {
        return '';
      }
      if (this.isExtensionIconUrl(item.favIconUrl)) {
        return item.favIconUrl;
      }
      return this.getFaviconUrl(item.url);
    }

    init() {
      this.createOverlay();
      this.bindEvents();
      this.initTheme();
    }
    
    initTheme() {
      // 把主题 class 挂在 overlay 自身上，避免被宿主页（如 juejin.cn）抢占 <html>
      try {
        this.themeManager = new ContentThemeManager(this.overlay);
      } catch (error) {
        console.error('Failed to initialize theme manager:', error);
      }
    }
    
    createOverlay() {
      // Shadow DOM 用于彻底隔离宿主页的 input/svg/button 全局样式（如 juejin.cn 污染）。
      const shadowHost = document.createElement('div');
      shadowHost.id = 'pounce-shadow-host';
      // 0 尺寸 host：不占位、不拦截交互；overlay 自己 position:fixed 盖满视窗。
      shadowHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
      this.shadowHost = shadowHost;
      this.shadowRoot = shadowHost.attachShadow({ mode: 'open' });

      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = chrome.runtime.getURL('search-overlay.css');
      this.shadowRoot.appendChild(cssLink);

      // Create overlay container
      this.overlay = document.createElement('div');
      this.overlay.className = 'pounce-search-overlay';
      // CSS 通过 <link> 异步加载，先用内联 display:none 避免首帧 FOUC。
      this.overlay.style.display = 'none';
      
      // Create search container
      const container = document.createElement('div');
      container.className = 'pounce-search-container';
      
      // Create search input container (this was missing!)
      const inputContainer = document.createElement('div');
      inputContainer.className = 'pounce-search-input-container';
      
      // 引擎选择器占据放大镜位置：按钮显示当前引擎图标,点击弹菜单切换。
      this.enginePicker = this.createEnginePicker();

      // Create search input
      this.searchInput = document.createElement('input');
      this.searchInput.className = 'pounce-search-input';
      this.searchInput.type = 'text';
      this.searchInput.placeholder = window.i18n
        ? window.i18n.t('overlay_searchPlaceholder')
        : 'Search tabs, history, bookmarks, and top sites...';
      this.searchInput.autocomplete = 'off';
      this.searchInput.spellcheck = false;

      // create close icon — proper currentColor SVG
      const closeIcon = document.createElement('div');
      closeIcon.className = 'pounce-close-icon';
      closeIcon.id = 'pounce-close-icon';
      closeIcon.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      
      // Create results container
      this.resultsContainer = document.createElement('div');
      this.resultsContainer.className = 'pounce-search-results';

      // 底部区域
      const bottomContainer = document.createElement('div');
      bottomContainer.className = 'pounce-search-bottom';

      const leftContainer = document.createElement('div');
      leftContainer.className = 'pounce-search-bottom-left';
      const resultsCounter = document.createElement('span');
      resultsCounter.className = 'pounce-results-counter';
      resultsCounter.textContent = window.i18n
        ? window.i18n.t('overlay_zeroResults')
        : '0 results';
      this.resultsCounter = resultsCounter; // 保存引用以便后续更新
      this.resultsLimitSelect = this.createResultsLimitSelect();
      leftContainer.appendChild(resultsCounter);
      leftContainer.appendChild(this.resultsLimitSelect);
      bottomContainer.appendChild(leftContainer);
      const rightContainer = document.createElement('div');
      rightContainer.className = 'pounce-hints';
      // 用 DOM 构造而非 innerHTML，以便保留文本节点引用做语言切换刷新
      const navigateHint = document.createElement('span');
      navigateHint.className = 'pounce-hint';
      const navKey = document.createElement('span');
      navKey.className = 'pounce-hint-key';
      navKey.textContent = '↑↓';
      const navigateLabel = document.createTextNode(' ' + (window.i18n ? window.i18n.t('overlay_navigate') : 'Navigate'));
      navigateHint.appendChild(navKey);
      navigateHint.appendChild(navigateLabel);
      this.navigateHintEl = navigateLabel;

      const selectHint = document.createElement('span');
      selectHint.className = 'pounce-hint';
      const selectKey = document.createElement('span');
      selectKey.className = 'pounce-hint-key';
      selectKey.textContent = '↵';
      const selectLabel = document.createTextNode(' ' + (window.i18n ? window.i18n.t('overlay_select') : 'Select'));
      selectHint.appendChild(selectKey);
      selectHint.appendChild(selectLabel);
      this.selectHintEl = selectLabel;

      const quickPickHint = document.createElement('span');
      quickPickHint.className = 'pounce-hint';
      quickPickHint.setAttribute('data-pounce-quick-pick-hint', '');
      const quickPickKey = document.createElement('span');
      quickPickKey.className = 'pounce-hint-key';
      quickPickKey.textContent = this.shortcutKeyLabel + ' 1-9';
      const quickPickLabel = document.createTextNode(' ' + (window.i18n ? window.i18n.t('overlay_quickPick') : 'Quick pick'));
      quickPickHint.appendChild(quickPickKey);
      quickPickHint.appendChild(quickPickLabel);
      this.quickPickHintLabelEl = quickPickLabel;

      const closeHint = document.createElement('span');
      closeHint.className = 'pounce-hint';
      const closeKey = document.createElement('span');
      closeKey.className = 'pounce-hint-key';
      closeKey.textContent = 'Esc';
      const closeLabel = document.createTextNode(' ' + (window.i18n ? window.i18n.t('overlay_close') : 'Close'));
      closeHint.appendChild(closeKey);
      closeHint.appendChild(closeLabel);
      this.closeHintEl = closeLabel;

      rightContainer.appendChild(navigateHint);
      rightContainer.appendChild(selectHint);
      rightContainer.appendChild(quickPickHint);
      rightContainer.appendChild(closeHint);
      this.quickPickHint = quickPickHint;
      bottomContainer.appendChild(rightContainer);
      
      // Assemble the overlay with correct structure
      inputContainer.appendChild(this.enginePicker);
      inputContainer.appendChild(this.searchInput);
      inputContainer.appendChild(closeIcon);
      container.appendChild(inputContainer);
      container.appendChild(this.resultsContainer);
      container.appendChild(bottomContainer);
      this.overlay.appendChild(container);
      // 引擎菜单挂在 overlay 顶层(container 之后 → 绘制在其之上),
      // 脱离 container 的 overflow:hidden;打开时按按钮位置绝对定位。
      this.overlay.appendChild(this.engineMenu);

      this.shadowRoot.appendChild(this.overlay);
      (document.body || document.documentElement).appendChild(shadowHost);
    }

    applyPlaceholder() {
      if (!this.searchInput) return;
      const key = PLACEHOLDER_KEYS[this._placeholderIndex] || PLACEHOLDER_KEYS[0];
      this.searchInput.placeholder = window.i18n ? window.i18n.t(key) : PLACEHOLDER_FALLBACKS[key];
    }

    startPlaceholderRotation() {
      this.stopPlaceholderRotation();
      this._placeholderIndex = 0;
      this.applyPlaceholder();
      // 尊重「减少动态」偏好:只显示第一条,不轮播。
      const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion || PLACEHOLDER_KEYS.length < 2) return;
      this._scheduleNextPlaceholder();
    }

    _scheduleNextPlaceholder() {
      this._placeholderTimer = setTimeout(() => {
        this._placeholderIndex = (this._placeholderIndex + 1) % PLACEHOLDER_KEYS.length;
        this.applyPlaceholder();
        this._scheduleNextPlaceholder();
      }, PLACEHOLDER_ROTATE_MS);
      // Node(测试)下不让这个自续期定时器阻塞进程退出;浏览器返回数字,无 unref,守卫后为空操作。
      if (this._placeholderTimer && typeof this._placeholderTimer.unref === 'function') {
        this._placeholderTimer.unref();
      }
    }

    stopPlaceholderRotation() {
      if (this._placeholderTimer) {
        clearTimeout(this._placeholderTimer);
        this._placeholderTimer = null;
      }
    }

    // 有输入时停轮播(placeholder 不可见);清空后从头恢复。
    syncPlaceholderRotation(value) {
      if (String(value || '').trim()) {
        this.stopPlaceholderRotation();
      } else if (!this._placeholderTimer && this.isVisible) {
        this.startPlaceholderRotation();
      }
    }

    getResultsLimitLabel() {
      return window.i18n ? window.i18n.t('options_resultsLimit') : 'Results shown';
    }

    createResultsLimitSelect() {
      const select = document.createElement('select');
      select.className = 'pounce-results-limit-select';

      ALLOWED_RESULTS_LIMITS.forEach((limit) => {
        const option = document.createElement('option');
        option.value = String(limit);
        option.textContent = String(limit);
        select.appendChild(option);
      });

      this.syncResultsLimitSelectLabel(select);
      return select;
    }

    syncResultsLimitSelectLabel(select = this.resultsLimitSelect) {
      if (!select) return;
      const label = this.getResultsLimitLabel();
      select.title = label;
      select.setAttribute('aria-label', label);
    }

    syncResultsLimitSelectValue() {
      if (!this.resultsLimitSelect) return;
      this.resultsLimitSelect.value = String(this.searchPreferences.resultsLimit);
    }

    getSearchEngineLabel() {
      return window.i18n ? window.i18n.t('overlay_searchEngine') : 'Search engine';
    }

    getSearchOptionTitle(query) {
      const engineId = normalizeSearchEngine(this.searchPreferences.searchEngine);
      const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.default;
      if (engineId === 'default') {
        return window.i18n
          ? window.i18n.t('overlay_searchForQuery', [query])
          : `Search for "${query}"`;
      }
      return window.i18n
        ? window.i18n.t('overlay_searchForEngineQuery', [engine.label, query])
        : `${engine.label} for "${query}"`;
    }

    getEngineIconHtml(engineId) {
      const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.default;
      if (engine.iconSvg) {
        return engine.iconSvg; // 内联图标,任意站点/无缓存都能显示
      }
      if (engine.home) {
        // google：用浏览器 favicon 库(总是已缓存)；home 为常量,无注入风险。
        const src = this.getFaviconUrl(engine.home);
        return `<img class="pounce-engine-favicon" src="${src}" alt="" width="18" height="18">`;
      }
      return this.getSearchIconSvg(); // 'default' → 放大镜
    }

    // 放大镜位置的引擎选择器：按钮显示当前引擎图标,点击弹出图标菜单。
    createEnginePicker() {
      const wrap = document.createElement('div');
      wrap.className = 'pounce-engine-picker';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pounce-engine-btn';
      btn.setAttribute('aria-haspopup', 'true');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleEngineMenu();
      });

      const menu = document.createElement('div');
      menu.className = 'pounce-engine-menu';
      menu.hidden = true;
      // 菜单内部点击不冒泡到 overlay(否则会触发收菜单/关浮层)。
      menu.addEventListener('click', (e) => e.stopPropagation());

      this.engineBtn = btn;
      this.engineMenu = menu;
      this._engineMenuBuilt = false;
      // 菜单内容(含各引擎 favicon)首次打开时才构建,避免构造期做 favicon/URL 解析。
      this.syncEngineButtonIcon();
      this.syncEngineButtonLabel();

      // 注意:菜单不放进 wrap,而是由 createOverlay 挂到 overlay 顶层,
      // 以脱离 .pounce-search-container 的 overflow:hidden 裁剪(结果少时会切掉下方选项)。
      wrap.appendChild(btn);
      return wrap;
    }

    buildEngineMenu() {
      if (!this.engineMenu) return;
      this._engineMenuBuilt = true;
      this.engineMenu.textContent = '';
      const defaultLabel = window.i18n ? window.i18n.t('overlay_searchEngineDefault') : 'Default';
      ALLOWED_SEARCH_ENGINES.forEach((id) => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'pounce-engine-option';
        opt.dataset.engine = id;
        const icon = document.createElement('span');
        icon.className = 'pounce-engine-option-icon';
        icon.innerHTML = this.getEngineIconHtml(id);
        const label = document.createElement('span');
        label.className = 'pounce-engine-option-label';
        label.textContent = id === 'default' ? defaultLabel : (SEARCH_ENGINES[id]?.label || id);
        opt.appendChild(icon);
        opt.appendChild(label);
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectEngine(id);
        });
        this.engineMenu.appendChild(opt);
      });
      this.markActiveEngineOption();
    }

    markActiveEngineOption() {
      if (!this.engineMenu) return;
      const current = this.searchPreferences.searchEngine;
      this.engineMenu.querySelectorAll('.pounce-engine-option').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.engine === current);
      });
    }

    syncEngineButtonIcon() {
      if (!this.engineBtn) return;
      this.engineBtn.innerHTML = this.getEngineIconHtml(this.searchPreferences.searchEngine);
    }

    syncEngineButtonLabel() {
      if (!this.engineBtn) return;
      const label = this.getSearchEngineLabel();
      this.engineBtn.title = label;
      this.engineBtn.setAttribute('aria-label', label);
    }

    toggleEngineMenu(force) {
      if (!this.engineMenu || !this.engineBtn) return;
      const show = typeof force === 'boolean' ? force : this.engineMenu.hidden;
      if (show) {
        if (!this._engineMenuBuilt) this.buildEngineMenu();
        this.positionEngineMenu();
      }
      this.engineMenu.hidden = !show;
      this.engineBtn.classList.toggle('is-open', show);
    }

    // 菜单在 overlay(视口全屏、position:fixed)坐标系里绝对定位到按钮正下方。
    // ponytail: 只在打开时定位一次;开着时窗口 resize 极少见,resize 不重定位。
    positionEngineMenu() {
      if (!this.engineBtn || !this.engineMenu) return;
      if (typeof this.engineBtn.getBoundingClientRect !== 'function') return;
      const r = this.engineBtn.getBoundingClientRect();
      this.engineMenu.style.left = `${Math.round(r.left)}px`;
      this.engineMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    }

    closeEngineMenu() {
      if (this.engineMenu && !this.engineMenu.hidden) this.toggleEngineMenu(false);
    }

    isEngineMenuOpen() {
      return !!this.engineMenu && !this.engineMenu.hidden;
    }

    async selectEngine(id) {
      this.closeEngineMenu();
      if (this.isVisible && this.searchInput) this.searchInput.focus();

      const nextEngine = normalizeSearchEngine(id);
      if (nextEngine === this.searchPreferences.searchEngine) return;

      const previousPreferences = this.searchPreferences;
      this.searchPreferences = { ...this.searchPreferences, searchEngine: nextEngine };
      this.applySearchPreferences();

      try {
        await chrome.storage.sync.set({ searchEngine: nextEngine });
      } catch (error) {
        console.warn('Pounce: failed to save search engine preference', error);
        this.searchPreferences = previousPreferences;
        this.applySearchPreferences();
      }
    }

    isResultsLimitSelectEvent(event) {
      if (!this.resultsLimitSelect || !event) return false;
      if (event.target === this.resultsLimitSelect) return true;
      return typeof event.composedPath === 'function' &&
        event.composedPath().includes(this.resultsLimitSelect);
    }
    
    bindEvents() {
      // Listen for messages from background script
      // 用实例属性保存 handler 引用，destroy() 时才能 removeListener
      this.runtimeMessageHandler = (message, sender, sendResponse) => {
        if (this.isDestroyed) return;
        if (message.action === 'showSearchOverlay') {
          this.bridgeTabId = message.bridgeTabId ?? null;
          this.show();
          sendResponse({ success: true });
        }
      };
      chrome.runtime.onMessage.addListener(this.runtimeMessageHandler);
      
      // Search input events
      this.searchInput.addEventListener('input', (e) => {
        this._resetMouseActivation();
        this.syncPlaceholderRotation(e.target.value);
        this.handleSearch(e.target.value);
      });

      this.searchInput.addEventListener('keydown', (e) => {
        // 任何键盘动作都视为"用户在用键盘"，重置鼠标激活状态。
        // 这样键盘选完后，trackpad 微小抖动（<5px）不会再把选中抢走。
        this._resetMouseActivation();
        this.handleKeyDown(e);
      });

      if (this.resultsLimitSelect) {
        this.resultsLimitSelect.addEventListener('change', () => {
          this.handleResultsLimitSelectChange();
        });
      }

      // 自维护 IME 组词状态：Shadow DOM + 部分 IME 下 e.isComposing 不可靠。
      this.isComposing = false;
      this.compositionEndedAt = 0;
      this.searchInput.addEventListener('compositionstart', () => {
        this.isComposing = true;
      });
      this.searchInput.addEventListener('compositionend', () => {
        this.isComposing = false;
        this.compositionEndedAt = performance.now();
        // Shadow DOM 边缘 case：compositionend 后输入框偶发失焦，光标消失。
        if (this.isVisible && this.shadowRoot.activeElement !== this.searchInput) {
          this.searchInput.focus();
        }
      });
      
      // 阻止点击冒泡到宿主页，同时点背板（overlay 本身）关闭弹窗
      this.overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        // 引擎按钮/选项自身会 stopPropagation；能冒泡到这里的点击都在选择器之外 → 收起菜单。
        this.closeEngineMenu();
        if (e.target === this.overlay) this.hide();
      });
      
      // ESC 关闭走 keyup 而不是 keydown——
      // 原因：在 ESC keydown handler 里关掉跳板页（当前激活 tab）会让 Chrome
      // 的 "press and hold ESC to exit fullscreen" 保护被 bypass，单按 ESC
      // 就退 macOS Space。改到 keyup 之后，Chrome 已经判定过"短按、不退"，
      // 此时再 tabs.remove 和全屏状态无关。
      // handler 存为实例属性，扩展更新替换旧实例时 destroy() 才能清掉。
      this.docKeyDownHandler = (e) => {
        if (e.key === 'Escape' && this.isVisible) {
          // keydown 只拦截默认行为，不做关闭动作
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (this.isResultsLimitSelectEvent(e)) return;
      };
      this.docKeyUpHandler = (e) => {
        if (e.key === 'Escape' && this.isVisible) {
          e.preventDefault();
          e.stopPropagation();
          // 菜单开着时,Esc 先收菜单,不关整个浮层。
          if (this.isEngineMenuOpen()) {
            this.closeEngineMenu();
            this.searchInput?.focus();
            return;
          }
          this.hide();
          return;
        }
        if (this.isResultsLimitSelectEvent(e)) return;
      };
      document.addEventListener('keydown', this.docKeyDownHandler, { capture: true });
      document.addEventListener('keyup', this.docKeyUpHandler, { capture: true });

      // 屏蔽宿主页的 focus trap：浮层显示期间，"焦点进入 Pounce shadowHost"
      // 这一类 focusin 在 document capture 阶段就 stopPropagation，不让事件继续
      // 传到 body 及更下层。背景：Quasar QDialog 等 a11y 模态库会在 body 上挂
      // bubble 阶段 focusin，发现焦点跑出 dialog 就把焦点拽回 dialog 内第一个
      // [tabindex>=0] 元素（如关闭按钮）。从源头拦掉事件，它们不再触发抢回逻辑，
      // 避免和我们形成 ping-pong。仅当 target 是 shadowHost 时才拦，宿主自己内部
      // 的 focus 移动事件原样冒泡，不影响宿主自身的 focus 管理。
      // 验证场景：OpenObserve（QA 部署版本未带 allow-focus-outside），打开日志
      // 详情后按 Cmd+K，焦点会被关闭按钮抢走 → 此守卫接住。
      this.focusShieldHandler = (e) => {
        if (this.isDestroyed || !this.isVisible) return;
        if (e.target === this.shadowHost) {
          e.stopPropagation();
        }
      };
      document.addEventListener('focusin', this.focusShieldHandler, { capture: true });

      this.shadowRoot.getElementById('pounce-close-icon').addEventListener('click', (e) => {
        this.hide();
        e.preventDefault();
        e.stopPropagation();
      });

      this.overlay.addEventListener('keydown', (e) => {
        e.stopPropagation();
      });

      this.resultsContainer.addEventListener('scroll', () => {
        this.updateNumberBadges();
        // 滚轮滚动列表时，CSS :hover 会自动跟着光标位置走（光标不动但内容滚走，
        // 命中行变成新一项），但浏览器不会触发 mousemove → selectedIndex 与 hover
        // 行错位 → 又出现"两个高亮"。这里同步一次。
        this._syncSelectionToMouse();
      });

      // 真实鼠标移动判定：>5px 才认为是有意移动，避免 trackpad 误触；
      // 一旦激活，每次 mousemove 都把 selectedIndex 推到光标所在项，
      // 让"hover 高亮"和"键盘选中"始终是同一项。
      this.resultsContainer.addEventListener('mousemove', (e) => {
        // 缓存最近一次鼠标位置，用于异步重建结果列表后续上 hover 同步。
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        if (!this._mouseActive) {
          if (this._mouseBaselineX === null) {
            this._mouseBaselineX = e.clientX;
            this._mouseBaselineY = e.clientY;
            return;
          }
          const dx = e.clientX - this._mouseBaselineX;
          const dy = e.clientY - this._mouseBaselineY;
          if (dx * dx + dy * dy < 25) return; // 5px 阈值
          this._mouseActive = true;
          if (this.overlay) this.overlay.classList.add('pn-mouse-active');
        }
        const item = e.target && e.target.closest ? e.target.closest('.pounce-search-result') : null;
        if (!item || !item.dataset || item.dataset.index === undefined) return;
        const idx = Number(item.dataset.index);
        if (Number.isFinite(idx) && idx !== this.selectedIndex) {
          this.selectedIndex = idx;
          this.updateSelection();
        }
      });

      this.storageChangeHandler = (changes, area) => {
        if (area !== 'sync') return;
        if (!SEARCH_PREFERENCE_KEYS.some(key => changes[key])) return;

        // 用偏好键表重建,避免每加一个偏好都要在这里补一行。
        this.searchPreferences = normalizeSearchPreferences(
          SEARCH_PREFERENCE_KEYS.reduce((acc, key) => {
            acc[key] = changes[key] ? changes[key].newValue : this.searchPreferences[key];
            return acc;
          }, {})
        );
        this.applySearchPreferences();
        // 分组开关/上限变化时,若浮层正开着,重排重渲染让其立刻生效。
        if (this.isVisible && this.searchInput) {
          this.rerankAndRender(this.searchInput.value);
        }
      };
      chrome.storage.onChanged.addListener(this.storageChangeHandler);

      // 语言切换：reload 词典后重渲染静态文案
      this.languageChangeHandler = async (changes, area) => {
        if (this.isDestroyed) return;
        if (area !== 'sync' || !changes.language || !window.i18n) return;
        try {
          await window.i18n.reload();
        } catch (e) {
          console.warn('Pounce: failed to reload i18n', e);
          return;
        }
        this.rerenderStaticOverlayText();
      };
      chrome.storage.onChanged.addListener(this.languageChangeHandler);
    }

    rerenderStaticOverlayText() {
      if (this.isDestroyed || !window.i18n) return;
      if (this.searchInput) {
        this.applyPlaceholder(); // 用当前轮播中的那条,按新语言刷新
      }
      if (this.navigateHintEl) {
        this.navigateHintEl.textContent = ' ' + window.i18n.t('overlay_navigate');
      }
      if (this.selectHintEl) {
        this.selectHintEl.textContent = ' ' + window.i18n.t('overlay_select');
      }
      if (this.quickPickHintLabelEl) {
        this.quickPickHintLabelEl.textContent = ' ' + window.i18n.t('overlay_quickPick');
      }
      if (this.closeHintEl) {
        this.closeHintEl.textContent = ' ' + window.i18n.t('overlay_close');
      }
      this.syncResultsLimitSelectLabel();
      this.syncEngineButtonLabel();
      // 'default' 选项文案随语言变;仅在菜单已构建时重建(其余是专有名词)。
      if (this._engineMenuBuilt) this.buildEngineMenu();
      // 重新渲染当前结果（含 sourceLabel 等动态文本）和计数
      if (this.currentResults && this.currentResults.length) {
        this.applyEngineToWebSearch();
        this.renderResults(this.searchInput ? this.searchInput.value : '');
      } else {
        // 0 结果：刷新计数和（若已挂出）空态文案
        if (this.resultsCounter) {
          this.resultsCounter.textContent = window.i18n.t('overlay_zeroResults');
        }
        if (this.resultsContainer) {
          const emptyEl = this.resultsContainer.querySelector('.pounce-search-empty');
          if (emptyEl) {
            emptyEl.textContent = window.i18n.t('overlay_noResults');
          }
        }
      }
    }
    
    _resetMouseActivation() {
      this._mouseActive = false;
      this._mouseBaselineX = null;
      this._mouseBaselineY = null;
      this._lastMouseX = null;
      this._lastMouseY = null;
      if (this.overlay) this.overlay.classList.remove('pn-mouse-active');
    }

    _syncSelectionToMouse() {
      if (!this._mouseActive) return;
      if (this._lastMouseX === null || this._lastMouseY === null) return;
      if (!this.shadowRoot || typeof this.shadowRoot.elementFromPoint !== 'function') return;
      const hit = this.shadowRoot.elementFromPoint(this._lastMouseX, this._lastMouseY);
      if (!hit || !hit.closest) return;
      const item = hit.closest('.pounce-search-result');
      if (!item || !item.dataset || item.dataset.index === undefined) return;
      const idx = Number(item.dataset.index);
      if (Number.isFinite(idx) && idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        this.updateSelection();
      }
    }

    _placeShadowHostForFocus() {
      // Keep the visual host at the document root. Ancestors with transform/filter/contain
      // change position:fixed containing blocks and can clip or offset the viewport overlay.
      const parent = document.body || document.documentElement;
      if (this.shadowHost && this.shadowHost.parentNode !== parent) {
        parent.appendChild(this.shadowHost);
      }
    }

    _focusSearchInput() {
      if (this.isDestroyed || !this.isVisible || !this.searchInput) return;
      if (this.shadowRoot?.activeElement !== this.searchInput) {
        this.searchInput.focus();
      }
    }

    _scheduleFocusRestore() {
      queueMicrotask(() => this._focusSearchInput());
      this.focusRestoreFrame = requestAnimationFrame(() => {
        this.focusRestoreFrame = null;
        this._focusSearchInput();
      });
      this.focusRestoreTimer = setTimeout(() => {
        this.focusRestoreTimer = null;
        this._focusSearchInput();
      }, 0);
    }

    _cancelFocusRestore() {
      if (this.focusRestoreFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.focusRestoreFrame);
      }
      if (this.focusRestoreTimer !== null) {
        clearTimeout(this.focusRestoreTimer);
      }
      this.focusRestoreFrame = null;
      this.focusRestoreTimer = null;
    }

    show() {
      if (this.isVisible) return;

      this.isVisible = true;
      this._placeShadowHostForFocus();
      this.overlay.style.display = 'flex';
      this.searchInput.value = '';
      this.startPlaceholderRotation();
      this._focusSearchInput();
      this._scheduleFocusRestore();
      this.selectedIndex = -1;
      this._resetMouseActivation();
      this.loadSearchPreferences();
      
      // Load initial data
      this.loadSearchData();
      
      // Prevent page scrolling
      document.body.style.overflow = 'hidden';
    }
    
    hide() {
      if (!this.isVisible) return;
      this.isVisible = false; // 先置 false，阻止重复触发
      this._cancelFocusRestore();
      this.stopPlaceholderRotation();
      // 关引擎菜单：放在 bridgeTab 提前 return 之前,确保任何关闭路径
      // (含点关闭图标,其 stopPropagation 绕过了 overlay 的收菜单逻辑)都复位。
      this.closeEngineMenu();

      // 如果是跳板页且用户未选择结果，直接关闭该标签页。
      // 关键：用 setTimeout 把 tabs.remove 推出当前 keydown 事件栈。
      // 原因：在 ESC keydown handler 同步调用链里关掉当前激活 tab，会让
      // Chrome 的 "press and hold ESC to exit fullscreen" 计时器失效，
      // 单按 ESC 就会退出 macOS Space。推到下一个 task 后，keydown 已结束，
      // Chrome 完成短按判定不退 Space，之后再关 tab，两者不再互相干扰。
      if (this.bridgeTabId) {
        const tabId = this.bridgeTabId;
        this.bridgeTabId = null;
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'closeBridgeTab', tabId }).catch(() => {});
        }, 0);
        return;
      }

      this.overlay.style.display = 'none';
      this.searchInput.blur();
      this.currentResults = [];
      this.selectedIndex = -1;
      this.cancelHistoryFetch();
      this.dynamicHistoryItems = [];

      // Restore page scrolling
      document.body.style.overflow = '';
    }
    
    destroy() {
      // 扩展更新后，旧实例若被 background 重新注入路径碰到，需要先彻底清理：
      // - 标记 isDestroyed，让残存回调短路
      // - 清 timer / 解绑文档级 listeners / 摘除 shadow host / 复原 body 滚动
      // 缺一不可：少摘 shadow host 会留两份 overlay，少解 listener 老 ESC 仍会触发旧逻辑。
      if (this.isDestroyed) return;
      this.isDestroyed = true;

      if (this.historyFetchTimer) {
        clearTimeout(this.historyFetchTimer);
        this.historyFetchTimer = null;
      }
      this.stopPlaceholderRotation();
      this._cancelFocusRestore();

      if (this.docKeyDownHandler) {
        document.removeEventListener('keydown', this.docKeyDownHandler, { capture: true });
        this.docKeyDownHandler = null;
      }
      if (this.docKeyUpHandler) {
        document.removeEventListener('keyup', this.docKeyUpHandler, { capture: true });
        this.docKeyUpHandler = null;
      }
      if (this.focusShieldHandler) {
        document.removeEventListener('focusin', this.focusShieldHandler, { capture: true });
        this.focusShieldHandler = null;
      }

      try {
        if (this.runtimeMessageHandler && chrome.runtime?.onMessage?.removeListener) {
          chrome.runtime.onMessage.removeListener(this.runtimeMessageHandler);
        }
      } catch (e) {
        // chrome.runtime 可能已失效（extension context invalidated），忽略
      }
      this.runtimeMessageHandler = null;

      try {
        if (this.storageChangeHandler && chrome.storage?.onChanged?.removeListener) {
          chrome.storage.onChanged.removeListener(this.storageChangeHandler);
        }
      } catch (e) {
        // chrome.runtime 可能已失效（extension context invalidated），忽略
      }
      this.storageChangeHandler = null;

      try {
        if (this.languageChangeHandler && chrome.storage?.onChanged?.removeListener) {
          chrome.storage.onChanged.removeListener(this.languageChangeHandler);
        }
      } catch (e) {
        // chrome.runtime 可能已失效（extension context invalidated），忽略
      }
      this.languageChangeHandler = null;

      if (this.shadowHost && this.shadowHost.parentNode) {
        this.shadowHost.parentNode.removeChild(this.shadowHost);
      }
      this.shadowHost = null;
      this.shadowRoot = null;
      this.overlay = null;
      this.searchInput = null;
      this.resultsContainer = null;
      this.resultsLimitSelect = null;
      this.enginePicker = null;
      this.engineBtn = null;
      this.engineMenu = null;

      if (this.isVisible) {
        document.body.style.overflow = '';
      }
      this.isVisible = false;
    }

    async loadSearchPreferences() {
      try {
        const savedPreferences = await chrome.storage.sync.get(SEARCH_PREFERENCE_KEYS);
        if (this.isDestroyed) return;
        this.searchPreferences = normalizeSearchPreferences(savedPreferences);
        this.applySearchPreferences();
      } catch (error) {
        console.warn('Pounce: failed to load search preferences', error);
      }
    }

    applySearchPreferences() {
      if (window.PounceSearchUtils && typeof window.PounceSearchUtils.setPinyinMatchingEnabled === 'function') {
        window.PounceSearchUtils.setPinyinMatchingEnabled(this.searchPreferences.pinyinMatchingEnabled);
      }

      this.syncResultsLimitSelectValue();
      this.syncEngineButtonIcon();
      this.markActiveEngineOption();

      if (this.overlay) {
        this.overlay.classList.toggle('pounce-quick-pick-disabled', !this.searchPreferences.quickPickEnabled);
      }

      if (this.quickPickHint) {
        this.quickPickHint.style.display = this.searchPreferences.quickPickEnabled ? 'flex' : 'none';
      }

      if (this.allData) {
        this.rerankAndRender(this.searchInput ? this.searchInput.value : '');
        return;
      }

      this.updateNumberBadges();
    }

    handleResultsLimitSelectChange() {
      this.updateResultsLimitPreference(this.resultsLimitSelect.value);
      if (this.isVisible && this.searchInput) {
        this.searchInput.focus();
      }
    }

    async updateResultsLimitPreference(value) {
      const nextPreferences = normalizeSearchPreferences({
        ...this.searchPreferences,
        resultsLimit: value
      });
      const nextLimit = nextPreferences.resultsLimit;

      if (nextLimit === this.searchPreferences.resultsLimit) {
        this.syncResultsLimitSelectValue();
        return;
      }

      const previousPreferences = this.searchPreferences;
      this.searchPreferences = nextPreferences;
      this.applySearchPreferences();

      try {
        await this.saveResultsLimitPreference(nextLimit);
      } catch (error) {
        console.warn('Pounce: failed to save results limit preference', error);
        this.searchPreferences = previousPreferences;
        this.applySearchPreferences();
      }
    }

    saveResultsLimitPreference(resultsLimit) {
      return chrome.storage.sync.set({ resultsLimit });
    }

    async loadSearchData() {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'getSearchData'
        });

        if (response && response.success) {
          this.allData = response.data;
          this.handleSearch(this.searchInput.value);
        } else {
          console.error('Pounce: Response indicates failure:', response);
          const base = window.i18n ? window.i18n.t('overlay_loadError') : 'Failed to load search data';
          const unknownErr = window.i18n ? window.i18n.t('overlay_unknownError') : 'Unknown error';
          this.showError(base + ': ' + (response?.error || unknownErr));
        }
      } catch (error) {
        console.error('Pounce: Error loading search data:', error);
        const base = window.i18n ? window.i18n.t('overlay_loadError') : 'Failed to load search data';
        this.showError(base + ': ' + error.message);
      }
    }
    
    handleSearch(query) {
      if (!this.allData) {
        this.showLoading();
        return;
      }

      const trimmed = String(query || '').trim();
      if (trimmed) {
        this.scheduleHistoryFetch(trimmed);
      } else {
        this.cancelHistoryFetch();
        this.dynamicHistoryItems = [];
      }

      this.rerankAndRender(query);
    }

    rerankAndRender(query) {
      const merged = Array.isArray(this.dynamicHistoryItems) && this.dynamicHistoryItems.length
        ? [...this.allData, ...this.dynamicHistoryItems]
        : this.allData;

      const limit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
      // 仅当「分组开启 且 浏览态(空查询)」才覆盖全部打开标签(不截断);
      // 否则用常规上限(分组关闭时即旧行为)。非标签段在 buildDisplayRows 里按 limit 截断。
      const trimmed = String(query || '').trim();
      const bypassLimit = !trimmed && !!this.searchPreferences.tabGroupingEnabled;
      const effectiveLimit = bypassLimit ? ((merged && merged.length) || limit) : limit;
      if (window.PounceSearchUtils && typeof window.PounceSearchUtils.rankResults === 'function') {
        this.currentResults = window.PounceSearchUtils.rankResults(merged, query, effectiveLimit);
      } else {
        this.currentResults = this.getFallbackResults(query);
      }

      this.applyEngineToWebSearch();
      this.selectedIndex = -1;
      this.renderResults(query);
    }

    // web-search 兜底项由 search-ranking.js 统一生成(url: search:<query>);
    // 这里按当前选中引擎改写它,让指定引擎走对应站点的搜索 URL。
    applyEngineToWebSearch() {
      const engine = SEARCH_ENGINES[this.searchPreferences.searchEngine] || SEARCH_ENGINES.default;
      const item = (this.currentResults || []).find(
        (r) => r && r.id === 'web-search' && typeof r.url === 'string' && r.url.startsWith('search:')
      );
      if (!item) return;
      const query = item.url.slice('search:'.length);
      item.displayTitle = this.getSearchOptionTitle(query);
      if (!engine.buildUrl) {
        delete item.engineUrl;
        item.displayUrl = window.i18n
          ? window.i18n.t('overlay_searchDefault')
          : 'Search with default search engine';
        return;
      }
      item.engineUrl = engine.buildUrl(query);
      item.displayUrl = engine.label;
    }

    cancelHistoryFetch() {
      if (this.historyFetchTimer) {
        clearTimeout(this.historyFetchTimer);
        this.historyFetchTimer = null;
      }
      this.historyFetchRequestId += 1;
    }

    scheduleHistoryFetch(query) {
      this.cancelHistoryFetch();
      const requestId = this.historyFetchRequestId;

      this.historyFetchTimer = setTimeout(async () => {
        this.historyFetchTimer = null;
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'searchHistory',
            query
          });

          if (requestId !== this.historyFetchRequestId) return;
          if (!this.isVisible) return;
          if (String(this.searchInput.value || '').trim() !== query) return;

          this.dynamicHistoryItems = response && response.success && Array.isArray(response.data)
            ? response.data
            : [];
          this.rerankAndRender(this.searchInput.value);
        } catch (error) {
          console.warn('Pounce: dynamic history fetch failed', error);
        }
      }, 120);
    }

    getFallbackResults(query) {
      const trimmedQuery = String(query || '').trim();
      const normalizedQuery = trimmedQuery.toLowerCase();
      const sourcePriority = {
        tab: 0,
        history: 1,
        topSite: 2,
        bookmark: 3
      };
      const items = Array.isArray(this.allData) ? this.allData.slice() : [];
      const filteredItems = normalizedQuery
        ? items.filter((item) => {
          const title = String(item.title || '').toLowerCase();
          const url = String(item.url || '').toLowerCase();
          return title.includes(normalizedQuery) || url.includes(normalizedQuery);
        })
        : items;

      filteredItems.sort((a, b) => {
        const sourceDiff = (sourcePriority[a.type] ?? 99) - (sourcePriority[b.type] ?? 99);
        if (sourceDiff !== 0) {
          return sourceDiff;
        }

        if (a.type === 'tab' && b.type === 'tab') {
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        }

        if (a.type === 'history' && b.type === 'history') {
          const typedDiff = (b.typedCount || 0) - (a.typedCount || 0);
          if (typedDiff !== 0) {
            return typedDiff;
          }

          const visitDiff = (b.visitCount || 0) - (a.visitCount || 0);
          if (visitDiff !== 0) {
            return visitDiff;
          }

          return (b.lastVisitTime || 0) - (a.lastVisitTime || 0);
        }

        const aTitle = String(a.title || '').toLowerCase();
        const bTitle = String(b.title || '').toLowerCase();
        return aTitle.localeCompare(bTitle);
      });

      const tr = (key, fallback) => (window.i18n ? window.i18n.t(key) : fallback);
      const limit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
      const results = filteredItems.slice(0, limit).map((item) => {
        const sourceLabel = item.type === 'history'
          ? tr('overlay_sourceHistory', 'History')
          : item.type === 'topSite'
            ? tr('overlay_sourceTopSite', 'Top Site')
            : item.type === 'bookmark'
              ? tr('overlay_sourceBookmark', 'Bookmark')
              : '';
        const iconFallback = item.type === 'tab'
          ? 'T'
          : item.type === 'history'
            ? 'H'
            : item.type === 'topSite'
              ? 'S'
              : item.type === 'bookmark'
                ? 'B'
                : '?';
        let displayUrl = item.url || '';

        if (item.type !== 'search' && item.url) {
          try {
            const parsedUrl = new URL(item.url);
            const hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
            const pathname = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/+$/, '');
            displayUrl = `${hostname}${pathname}${parsedUrl.search}`;
          } catch (error) {
            displayUrl = item.url;
          }
        }

        return {
          ...item,
          displayTitle: item.title || item.url || tr('overlay_untitled', 'Untitled'),
          displayUrl,
          sourceLabel,
          iconFallback
        };
      });

      if (!trimmedQuery) {
        return results;
      }

      const openResult = this.createOpenFallbackResult(trimmedQuery);
      const searchTitle = this.getSearchOptionTitle(trimmedQuery);
      const searchResult = {
        type: 'search',
        id: 'web-search',
        title: searchTitle,
        url: `search:${trimmedQuery}`,
        displayTitle: searchTitle,
        displayUrl: tr('overlay_searchDefault', 'Search with default search engine'),
        sourceLabel: tr('overlay_sourceSearch', 'Search'),
        iconFallback: 'S',
        isSearchOption: true
      };

      // Keep quick-jump first for complete URLs, with web search as the
      // fallback at the bottom. For other queries, web search stays on top.
      return openResult ? [openResult, ...results, searchResult] : [searchResult, ...results];
    }

    createOpenFallbackResult(query) {
      if (!query || /\s/.test(query)) {
        return null;
      }

      let url = null;

      if (/^https?:\/\//i.test(query)) {
        url = query;
      } else {
        const hostMatch = query.match(
          /^(localhost(?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}|(?:\[[0-9a-f:.]+\]))(?:[/?#].*)?$/i
        );

        if (hostMatch) {
          url = `http://${query}`;
        } else {
          const domainPattern = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
          if (domainPattern.test(query)) {
            url = `https://${query}`;
          }
        }
      }

      if (!url) {
        return null;
      }

      try {
        const parsedUrl = new URL(url);
        const normalizedUrl = parsedUrl.href;
        return {
          type: 'open',
          id: 'direct-open',
          title: normalizedUrl,
          url: normalizedUrl,
          displayTitle: window.i18n ? window.i18n.t('overlay_openUrl', [normalizedUrl]) : `Open ${normalizedUrl}`,
          displayUrl: normalizedUrl,
          sourceLabel: window.i18n ? window.i18n.t('overlay_sourceOpen') : 'Open',
          iconFallback: 'O',
          isOpenOption: true
        };
      } catch (error) {
        return null;
      }
    }
    renderHighlightedText(textEl, text, ranges) {
      // Always reset the element first.
      textEl.textContent = '';

      const safeText = typeof text === 'string' ? text : '';
      const safeRanges = Array.isArray(ranges) ? ranges : [];

      if (safeRanges.length === 0) {
        textEl.textContent = safeText;
        return;
      }

      let cursor = 0;
      for (const range of safeRanges) {
        const start = range[0];
        const end = range[1];
        if (start > cursor) {
          textEl.appendChild(document.createTextNode(safeText.slice(cursor, start)));
        }
        const span = document.createElement('span');
        span.className = 'pounce-highlight';
        span.textContent = safeText.slice(start, end);
        textEl.appendChild(span);
        cursor = end;
      }

      if (cursor < safeText.length) {
        textEl.appendChild(document.createTextNode(safeText.slice(cursor)));
      }
    }

    rebuildDisplayRows(query) {
      const grouping = window.PounceTabGrouping;
      const groupingOn = !!this.searchPreferences.tabGroupingEnabled;
      if (groupingOn && grouping && typeof grouping.buildDisplayRows === 'function') {
        const limit = this.searchPreferences.resultsLimit || DEFAULT_SEARCH_PREFERENCES.resultsLimit;
        // 浏览态标签页全展示(绕过上限),非标签段只填到「上限 - 标签数」,使可见总数不超过上限。
        // 仅当打开的标签本身就超过上限时,总数才会超过(此时保证标签全可见优先)。
        let nonTabLimit = limit;
        if (!String(query || '').trim()) {
          const tabCount = (this.currentResults || []).filter((it) => it && it.type === 'tab').length;
          nonTabLimit = Math.max(0, limit - tabCount);
        }
        this.displayRows = grouping.buildDisplayRows(this.currentResults, {
          query,
          expandedGroups: this.expandedGroups,
          nonTabLimit,
        });
      } else {
        // 分组关闭(或模块缺失):平铺,每条一行(标签页仍有 ✕、仍可 ⌘⌫ 关闭)。
        this.displayRows = (this.currentResults || []).map((item) =>
          ({ kind: item && item.type === 'tab' ? 'tab' : 'other', item }));
      }
    }

    renderResults(query = '', restoreIndex = 0) {
      this.rebuildDisplayRows(query);

      if (!this.displayRows.length) {
        this.showEmpty();
        return;
      }

      this.resultsContainer.innerHTML = '';

      // 渲染各行的同时累加计数:组头按其代表的标签数计、展开的成员不重复计、合成搜索行不计。
      let actualResultsCount = 0;
      this.displayRows.forEach((row, index) => {
        const el = this.createRowElement(row, index, query);
        // Expanded group members go inside a per-domain tray box; everything
        // else (headers, flat tabs, sources) is a direct child of the list.
        if (row.kind === 'tab' && row.groupDomain) {
          const last = this.resultsContainer.lastElementChild;
          let tray = last;
          if (!last || !last.classList.contains('pounce-group-tray') || last.dataset.domain !== row.groupDomain) {
            tray = document.createElement('div');
            tray.className = 'pounce-group-tray';
            tray.dataset.domain = row.groupDomain;
            this.resultsContainer.appendChild(tray);
          }
          tray.appendChild(el);
        } else {
          this.resultsContainer.appendChild(el);
        }
        if (row.kind === 'group') {
          actualResultsCount += row.count;
        } else if (!(row.kind === 'tab' && row.groupDomain) && !(row.item && row.item.type === 'search')) {
          actualResultsCount += 1;
        }
      });

      // 选中目标行(默认第一项;展开/关闭等场景由调用方传入要恢复的行号),只渲染一次高亮。
      this.selectedIndex = Math.min(Math.max(0, restoreIndex), this.displayRows.length - 1);
      this.updateSelection();

      // 见原注释:异步重建后续上鼠标 hover 同步,避免"两个高亮"。
      this._syncSelectionToMouse();

      // 初始编号（异步等 layout 稳定后再算）
      requestAnimationFrame(() => this.updateNumberBadges());

      this.updateResultsCount(actualResultsCount);
    }
    
    // 给图标容器填入 favicon <img>(加载失败回退到字符);无可用图标时直接显示回退字符。
    _buildFaviconIcon(icon, favIconUrl, altText, fallbackChar) {
      if (favIconUrl && !favIconUrl.startsWith('chrome://')) {
        const img = document.createElement('img');
        img.referrerPolicy = 'no-referrer';
        img.src = favIconUrl;
        img.alt = altText;
        img.onerror = () => {
          icon.innerHTML = '';
          icon.textContent = fallbackChar;
        };
        icon.appendChild(img);
      } else {
        icon.textContent = fallbackChar;
      }
    }

    createRowElement(row, index, query = '') {
      if (row.kind === 'group') {
        return this.createGroupElement(row, index);
      }
      return this.createResultElement(row.item, index, query, row);
    }

    createGroupElement(row, index) {
      const element = document.createElement('div');
      element.className = 'pounce-search-result pounce-group-header';
      if (row.expanded) element.classList.add('expanded');
      element.dataset.index = String(index);
      if (index === this.selectedIndex) {
        element.classList.add('selected');
      }
      const countLabel = window.i18n
        ? window.i18n.t('overlay_tabCount', [String(row.count)])
        : `${row.count} tabs`;
      element.setAttribute('aria-label', `${row.domain}, ${countLabel}`);

      // Empty number gutter keeps the header's left edge aligned with rows.
      const num = document.createElement('div');
      num.className = 'pounce-result-number';

      // Single favicon — every tab of a domain shares the same icon, so there's
      // nothing to stack; one icon reads cleaner.
      const icon = document.createElement('div');
      icon.className = 'pounce-result-icon tab';
      const firstTab = row.tabs && row.tabs[0];
      const favIconUrl = firstTab ? this.getSafeFaviconUrl(firstTab) : '';
      const fallbackChar = (row.domain && row.domain[0] ? row.domain[0] : '?').toUpperCase();
      this._buildFaviconIcon(icon, favIconUrl, row.domain, fallbackChar);

      // Domain title.
      const content = document.createElement('div');
      content.className = 'pounce-result-content';
      const title = document.createElement('div');
      title.className = 'pounce-result-title';
      title.textContent = row.domain;
      content.appendChild(title);

      // Green count pill + "tabs" unit.
      const count = document.createElement('span');
      count.className = 'pounce-group-count';
      count.textContent = String(row.count);
      const unit = document.createElement('span');
      unit.className = 'pounce-group-unit';
      unit.textContent = window.i18n ? window.i18n.t('overlay_tabsUnit') : 'tabs';

      // Close-all-tabs button (revealed on hover/selected like the per-tab ✕).
      const closeAll = document.createElement('button');
      closeAll.type = 'button';
      closeAll.className = 'pounce-result-close pounce-group-close-all';
      closeAll.textContent = '✕';
      closeAll.setAttribute('aria-label', window.i18n ? window.i18n.t('overlay_closeAllTabs') : 'Close all tabs');
      closeAll.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeGroupTabsAtIndex(index);
      });

      // Expand / Collapse hint with the ↵ key that triggers it.
      const action = document.createElement('span');
      action.className = 'pounce-group-action';
      const actionKey = document.createElement('span');
      actionKey.className = 'pounce-group-action-key';
      actionKey.textContent = '↵';
      const actionLabel = document.createElement('span');
      actionLabel.textContent = window.i18n
        ? window.i18n.t(row.expanded ? 'overlay_collapse' : 'overlay_expand')
        : (row.expanded ? 'Collapse' : 'Expand');
      action.appendChild(actionKey);
      action.appendChild(actionLabel);

      // Rotating chevron.
      const chevron = document.createElement('span');
      chevron.className = 'pounce-group-chevron';
      chevron.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>';

      element.appendChild(num);
      element.appendChild(icon);
      element.appendChild(content);
      element.appendChild(count);
      element.appendChild(unit);
      element.appendChild(action);
      element.appendChild(chevron);
      element.appendChild(closeAll);

      element.addEventListener('click', () => {
        this.selectResult(index);
      });

      return element;
    }

    createResultElement(item, index, query = '', row = null) {
      const element = document.createElement('div');
      element.className = 'pounce-search-result';
      if (row && row.groupDomain) {
        element.classList.add('pounce-group-member');
      }
      element.dataset.index = String(index);
      if (index === this.selectedIndex) {
        element.classList.add('selected');
      }
      
      // Icon
      const icon = document.createElement('div');
      icon.className = `pounce-result-icon ${item.type}`;
      
      // Special handling for synthetic options.
      if (item.type === 'search') {
        const engineId = normalizeSearchEngine(this.searchPreferences.searchEngine);
        icon.innerHTML = this.getEngineIconHtml(engineId);
        icon.dataset.engine = engineId;
        if (engineId !== 'default') icon.classList.add('search-engine-icon');
        element.classList.add('search-option');
      } else if (item.type === 'open') {
        element.classList.add('open-option');
      }

      const favIconUrl = this.getSafeFaviconUrl(item);

      if (item.type !== 'search') {
        const iconAlt = item.displayTitle || item.title || (window.i18n ? window.i18n.t('overlay_websiteIconAlt') : 'Website icon');
        this._buildFaviconIcon(icon, favIconUrl, iconAlt, item.iconFallback || '?');
      }
      
      // Content
      const content = document.createElement('div');
      content.className = 'pounce-result-content';
      
      const titleText = item.displayTitle || item.title || (window.i18n ? window.i18n.t('overlay_untitled') : 'Untitled');
      const urlText = item.displayUrl || item.url || '';
      const isHighlightable = HIGHLIGHTABLE_TYPES.includes(item.type) &&
        typeof query === 'string' &&
        query.trim().length > 0;
      const ranger = (typeof globalThis !== 'undefined' && globalThis.PounceSearchUtils && globalThis.PounceSearchUtils.getHighlightRanges) || null;

      const title = document.createElement('div');
      title.className = 'pounce-result-title';
      if (isHighlightable && ranger) {
        this.renderHighlightedText(title, titleText, ranger(titleText, query));
      } else {
        title.textContent = titleText;
      }

      const url = document.createElement('div');
      url.className = 'pounce-result-url';
      if (isHighlightable && ranger) {
        this.renderHighlightedText(url, urlText, ranger(urlText, query));
      } else {
        url.textContent = urlText;
      }
      
      content.appendChild(title);
      content.appendChild(url);
      
      // Badge
      const badge = document.createElement('div');
      badge.className = `pounce-result-badge pounce-result-badge-${item.type}`;
      badge.textContent = item.sourceLabel || '';
      const num = document.createElement('div');
      num.className = 'pounce-result-number';
      element.appendChild(num);
      element.appendChild(icon);
      element.appendChild(content);
      if (item.sourceLabel) {
        element.appendChild(badge);
      }
      
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
    }

    handleKeyDown(e) {
      // IME 组词期间 Enter/方向键属于输入法候选操作；keyCode 229 兜底浏览器不报 isComposing 的场景。
      if (this.isComposing || e.keyCode === 229) return;

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
          
        case 'Escape':
          // 关闭由 document 级 keyup handler 负责，此处仅防默认行为。
          // 不要在 keydown 里 hide() —— 见文件里 keyup 分支的注释。
          e.preventDefault();
          break;

        default:
          // Alt+1..9 触发快速跳转。用 e.code 而非 e.key —— Mac 上 Alt+1 的 e.key 是 ¡ 等特殊字符，
          // 只有 e.code='Digit1' 跨平台稳定。同时排除 Ctrl/Meta 组合，避免误触浏览器原生快捷键。
          // preventDefault 提到外层：即使对应位置没有结果（比如只搜到 3 条但按 Alt+5），
          // 也要吞掉默认行为，否则 Mac 上 Option+5 的 ∞ 等特殊字符会污染搜索框。
          if (this.searchPreferences.quickPickEnabled && e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
            e.preventDefault();
            const pos = parseInt(e.code.slice(5), 10) - 1;
            if (this.visibleResultIndices && pos < this.visibleResultIndices.length) {
              this.selectResult(this.visibleResultIndices[pos]);
            }
          }
      }
    }
    
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
    
    updateSelection() {
      const results = this.resultsContainer.querySelectorAll('.pounce-search-result');
      results.forEach((result, index) => {
        if (index === this.selectedIndex) {
          result.classList.add('selected');
          result.scrollIntoView({ block: 'nearest' });
        } else {
          result.classList.remove('selected');
        }
      });
      // scrollIntoView 可能改变可视区域，等 layout 后重算编号
      requestAnimationFrame(() => this.updateNumberBadges());
    }
    
    updateNumberBadges() {
      if (!this.searchPreferences.quickPickEnabled) {
        this.visibleResultIndices = [];
        this.resultsContainer.querySelectorAll('.pounce-result-number').forEach((numEl) => {
          numEl.textContent = '';
        });
        return;
      }

      const containerRect = this.resultsContainer.getBoundingClientRect();
      const results = Array.from(this.resultsContainer.querySelectorAll('.pounce-search-result'));
      this.visibleResultIndices = [];

      results.forEach((result, index) => {
        const numEl = result.querySelector('.pounce-result-number');
        if (!numEl) return;
        const rect = result.getBoundingClientRect();
        const visible = rect.top < containerRect.bottom && rect.bottom > containerRect.top;
        if (visible && this.visibleResultIndices.length < 9) {
          this.visibleResultIndices.push(index);
          numEl.textContent = `${this.shortcutPrefix}${this.visibleResultIndices.length}`;
        } else {
          numEl.textContent = '';
        }
      });
    }

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
          if (item.engineUrl) {
            // 指定引擎：直接打开该引擎的搜索 URL（复用 openBookmark 的 bridge tab 逻辑）。
            await chrome.runtime.sendMessage({
              action: 'openBookmark',
              url: item.engineUrl,
              bridgeTabId: this.bridgeTabId
            });
          } else {
            const searchQuery = item.url.replace('search:', '');
            await chrome.runtime.sendMessage({
              action: 'performWebSearch',
              query: searchQuery,
              bridgeTabId: this.bridgeTabId
            });
          }
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
      this.renderResults(this.searchInput ? this.searchInput.value : '', index);
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

      this.renderResults(this.searchInput ? this.searchInput.value : '', index);
    }

    // Close every open tab in a domain group (the group header's "close all").
    closeGroupTabsAtIndex(index) {
      if (index < 0 || index >= this.displayRows.length) return;
      const row = this.displayRows[index];
      if (!row || row.kind !== 'group' || !Array.isArray(row.tabs)) return;
      const ids = new Set(
        row.tabs.filter((t) => t && t.type === 'tab' && t.id != null).map((t) => t.id)
      );
      if (!ids.size) return;

      ids.forEach((tabId) => {
        chrome.runtime.sendMessage({ action: 'closeTab', tabId }).catch(() => {});
      });

      const dropTabs = (arr) => Array.isArray(arr)
        ? arr.filter((it) => !(it && it.type === 'tab' && ids.has(it.id)))
        : arr;
      this.allData = dropTabs(this.allData);
      this.currentResults = dropTabs(this.currentResults);

      this.renderResults(this.searchInput ? this.searchInput.value : '', index);
    }

    showLoading() {
      const loadingText = window.i18n ? window.i18n.t('overlay_loading') : 'Loading...';
      this.resultsContainer.innerHTML = '';
      const loadingEl = document.createElement('div');
      loadingEl.className = 'pounce-search-loading';
      loadingEl.textContent = loadingText;
      this.resultsContainer.appendChild(loadingEl);
      // 加载时显示加载状态
      if (this.resultsCounter) {
        this.resultsCounter.textContent = loadingText;
      }
    }
    
    showEmpty() {
      this.resultsContainer.innerHTML = '';
      const emptyEl = document.createElement('div');
      emptyEl.className = 'pounce-search-empty';
      emptyEl.textContent = window.i18n
        ? window.i18n.t('overlay_noResults')
        : 'No matching tabs, history, bookmarks, or top sites found';
      this.resultsContainer.appendChild(emptyEl);
      // 更新计数为0
      this.updateResultsCount(0);
    }
    
    showError(message) {
      this.resultsContainer.innerHTML = `
        <div class="pounce-search-empty">
          ${message}
        </div>
      `;
      // 错误时显示0结果
      this.updateResultsCount(0);
    }
    
    updateResultsCount(count) {
      if (this.resultsCounter) {
        const text = window.i18n
          ? (count === 1 ? window.i18n.t('overlay_resultsCountOne') : window.i18n.t('overlay_resultsCount', [String(count)]))
          : (count === 1 ? '1 result' : `${count} results`);
        this.resultsCounter.textContent = text;
      }
    }
  }
  
  // Initialize when DOM is ready.
  // 关键时序：先 new 出 overlay 注册 onMessage 监听，再异步加载 i18n。
  // 否则 background.js 在 bridge 标签页加载完 50ms 后发送 showSearchOverlay
  // 时监听器还没就绪，消息会丢失。i18n.init 完成后再刷新一次静态文本。
  const bootstrap = () => {
    const overlay = new PounceSearchOverlay();
    window.pounceSearchOverlay = overlay;
    if (window.i18n) {
      window.i18n.init().then(() => {
        overlay.rerenderStaticOverlayText();
      }).catch((e) => {
        console.warn('Pounce: i18n init failed, falling back to English literals', e);
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
