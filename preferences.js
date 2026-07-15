(function() {
  'use strict';

  const ALLOWED_RESULTS_LIMITS = Object.freeze([10, 20, 50]);

  // 'default' = 浏览器默认引擎（走 chrome.search.query）；其余走固定 URL。
  const ALLOWED_SEARCH_ENGINES = Object.freeze(['default', 'google', 'bing', 'github', 'linuxdo']);

  const DEFAULT_SEARCH_PREFERENCES = Object.freeze({
    quickPickEnabled: true,
    pinyinMatchingEnabled: true,
    tabGroupingEnabled: false,
    resultsLimit: 10,
    searchEngine: 'default'
  });

  const SEARCH_PREFERENCE_KEYS = Object.freeze(Object.keys(DEFAULT_SEARCH_PREFERENCES));

  function normalizeResultsLimit(value) {
    const num = Number(value);
    return ALLOWED_RESULTS_LIMITS.includes(num) ? num : DEFAULT_SEARCH_PREFERENCES.resultsLimit;
  }

  function normalizeSearchEngine(value) {
    return ALLOWED_SEARCH_ENGINES.includes(value) ? value : DEFAULT_SEARCH_PREFERENCES.searchEngine;
  }

  function normalizeSearchPreferences(values) {
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
  }

  const api = {
    DEFAULT_SEARCH_PREFERENCES,
    SEARCH_PREFERENCE_KEYS,
    ALLOWED_RESULTS_LIMITS,
    ALLOWED_SEARCH_ENGINES,
    normalizeResultsLimit,
    normalizeSearchEngine,
    normalizeSearchPreferences
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.PouncePreferences = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
