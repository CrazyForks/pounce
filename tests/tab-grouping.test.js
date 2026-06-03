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

test('buildDisplayRows with no options arg returns flat rows', () => {
  const rows = buildDisplayRows([tab(1, 'https://a.com/x')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tab');
});

test('group row carries its member tab objects in tabs[]', () => {
  const results = [tab(1, 'https://github.com/a'), tab(2, 'https://github.com/b')];
  const rows = buildDisplayRows(results, { query: '', expandedGroups: new Set() });
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[0].tabs.length, 2);
  assert.equal(rows[0].tabs[0], results[0]);
  assert.equal(rows[0].tabs[1], results[1]);
});
