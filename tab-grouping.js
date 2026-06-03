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
      return items
        .filter(Boolean)
        .map((item) => (item.type === 'tab' ? { kind: 'tab', item } : { kind: 'other', item }));
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
