# Cmd+K 标签页域名分组 + 单标签关闭 — 设计文档

- 日期:2026-06-03
- 范围:Pounce 扩展的搜索浮层(`search-overlay.js`)+ background 消息
- 状态:已与用户确认,待写实现计划

## 1. 目标

1. **域名分组**:按 `Cmd+K` 打开浮层(浏览态/空查询)时,把**同域名 ≥2 个的打开标签页**折叠成一个可展开的分组行;回车展开/收起。
2. **单标签关闭**:任意标签页结果行右侧有 `✕` 按钮(鼠标点击关闭);键盘 `⌘⌫`(Mac)/ `Ctrl+⌫`(其他)关闭当前选中的标签页。

## 2. 已确认的决策

- 分组**仅作用于 `type==='tab'`**,**仅在空查询(浏览态)**;一旦输入关键词 → 退回按相关度排序的平铺列表(不分组)。
- 分组阈值:同域名 **≥2** 才成组;单个标签是普通行。
- 默认**全部折叠**。
- 浏览态分组**覆盖全部打开标签**,在结果上限(默认 10)**截断之前**计算;上限只管下方 历史/常用/书签 段。
- 关闭能力:**✕ 按钮 + `⌘⌫`/`Ctrl+⌫`**,**仅关单个标签**。v1 **不做**整组关闭,组头**无** `✕`。
- 此次**不发版**,不动版本号 / CHANGELOG / README(后续发版另行处理)。

## 3. 实现路线:渲染层「显示模型」

`currentResults` 仍是平铺的、ranking 排好序的数组,**排序逻辑完全不动**。新增纯函数 `buildDisplayRows(results, expandedGroups, query)`,把 `currentResults`(及浏览态下的全部标签)折叠成「显示行」数组 `displayRows`。键盘导航与选中改为索引 `displayRows`。

不选数据层分组(排序与展示耦合、"搜索时平铺"要特判);不选 `chrome.tabGroups`(那是改真实标签栏,非浮层展示)。

## 4. 数据模型

### 4.1 显示行 displayRow

```
{ kind: 'group',  domain, count, tabs: [resultItem...], expanded: bool }
{ kind: 'tab',    item: resultItem, groupDomain?: string }   // 单标签 或 展开后的成员
{ kind: 'other',  item: resultItem }                          // 历史/常用/书签
```

`displayRows` 是**当前可见行**的扁平数组:折叠的组只贡献 1 行(组头);展开的组贡献组头 + 各成员行;折叠组的成员**不进** `displayRows`(不参与导航)。

### 4.2 域名键

复用现有逻辑:`new URL(item.url).hostname.replace(/^www\./,'').toLowerCase()`,`try/catch` 兜底。解析失败 / `chrome://` / `file://` 归到组键 `'__other__'`,这些标签**不分组**,按单标签行渲染。

### 4.3 展开状态

`this.expandedGroups = new Set()`(存域名键)。重渲染时保留;关闭标签后保留。

## 5. buildDisplayRows 逻辑(纯函数,可单测)

输入:`results`(平铺、已排序)、`expandedGroups`、`query`、以及浏览态下的 `allTabs`(全部标签,绕过上限)。

- **搜索态(query 非空)**:不分组。每个 result → `{kind: item.type==='tab' ? 'tab' : 'other', item}`。顺序不变。
- **浏览态(query 空)**:
  1. 取**全部** `type==='tab'` 的标签(来自 `allData`,不受 limit 截断),按现有空查询排序规则排序。
  2. 按域名键分桶,保留各桶**首次出现**的顺序。
  3. 每桶:`size>=2 且 域名键!=='__other__'` → 1 个 `group` 行(`expanded` 取自 `expandedGroups`);展开则追加成员 `tab` 行。否则桶内每个标签 → 单独 `tab` 行。
  4. 追加 `currentResults` 里的**非标签**结果(历史/常用/书签,受 limit 约束)→ `other` 行。

## 6. 渲染(`renderResults` / `createResultElement`)

- 遍历 `displayRows` 而非 `currentResults`。
- `group` 行:`▸/▾` + 域名 favicon(取组内首个标签的 favicon)+ 域名文本 + 计数徽标(`overlay_tabCount`)。**无 ✕**。`data-index` 为该行在 `displayRows` 的下标。
- `tab` 行:沿用现有标签行结构;成员行加缩进 class;右侧加 `✕` 按钮(`aria-label=overlay_closeTab`,`hover` 显现 + `.selected` 行常驻,点击 `stopPropagation`)。
- `other` 行:与现状一致。
- 数字徽标(`Alt+1–9`)按 `displayRows` 可见顺序映射。

## 7. 键盘 & 选中(`handleKeyDown`/`moveSelection`/`updateSelection`/`selectResult`)

`selectedIndex` 索引 `displayRows`。

| 按键 | group 行 | tab / other 行 |
|------|----------|----------------|
| `↑/↓` | 可见行间移动 | 同 |
| `回车` | 展开/收起(切 `expandedGroups` → 重建 displayRows) | 打开:tab → `switchToTab`;other → `openBookmark`/`performWebSearch`(不变) |
| `⌘⌫` / `Ctrl+⌫` | 无动作 | tab 行 → 关闭该标签;other 行 → 无动作 |
| `Alt+1–9` | 映射可见行(展开/收起) | 映射可见行(打开) |
| `Esc` | 关浮层(不变) | 同 |

`⌘⌫` 检测:`(e.metaKey || e.ctrlKey) && e.key === 'Backspace'`,命中 tab 行时 `preventDefault`。普通 `Backspace` 不拦截(留给搜索框删字)。

## 8. 关闭流程

1. 触发(✕ 点击 或 `⌘⌫`)→ 取该行 `item`(必须 `type==='tab'`)。
2. `chrome.runtime.sendMessage({action:'closeTab', tabId: item.id})`。background 新增处理:`chrome.tabs.remove(tabId)`,标签不存在则静默忽略。
3. **本地乐观更新**:从 `this.allData`、`this.currentResults` 删除该标签 → 重建 displayRows 重渲染。保留 `expandedGroups`。注意 `rerankAndRender` 会把 `selectedIndex` 重置为 -1,所以关闭流程要在重建后**显式恢复选中**:记下关闭前的目标行下标,重建后 `clamp` 到新 `displayRows` 长度再 `updateSelection`(可单独走一个 `refreshAfterClose(targetIndex)`,不复用会清选中的 `rerankAndRender`)。
4. 选中落到下一行(到底则上一行);列表空则显示空态。
5. 组员降到 1 → 自动变单标签行(buildDisplayRows 阈值天然处理);降到 0 → 组消失。

## 9. 边界情况

- `chrome://`/`file://`/无 URL:归 `'__other__'`,不分组,不崩。
- 跨窗口同域名:归一组;`switchToTab` 聚焦对应窗口(现有行为)。
- 浮层打开期间标签被外部关闭:`switchToTab`/`closeTab` 沿用"标签不存在兜底"。
- 无重复域名 / 仅 1 标签:无组头,视觉同现状。

## 10. 改动文件

- `search-overlay.js`:`buildDisplayRows()`(纯函数,挂到可测出口)、`expandedGroups` 状态、改 `renderResults`/`createResultElement`/`handleKeyDown`/`moveSelection`/`updateSelection`/`selectResult`、新增关闭+展开折叠处理、浮层内联 `<style>` 新增组头/缩进/`▸▾`/✕/计数样式。
- `background.js`:`closeTab` 消息处理(`chrome.tabs.remove`)。
- `_locales/en/messages.json`、`_locales/zh_CN/messages.json`:`overlay_tabCount`、`overlay_closeTab`。

## 11. 测试

- `buildDisplayRows` 设计为纯函数,单测覆盖:同域名 ≥2 成组 / 单标签不成组 / `__other__` 不成组 / 搜索态平铺 / 展开追加成员 / 关闭后降级与移除 / 顺序稳定。
- DOM、键盘、`closeTab` 消息往返:扩展内手动验证(加载未打包扩展 → 多开同域名标签 → Cmd+K 看折叠 → 回车展开 → ✕ 和 ⌘⌫ 关闭)。

## 12. 非目标(YAGNI)

- 整组关闭、组的持久化展开偏好、拖拽、跨窗口可视化、原生 `chrome.tabGroups` 联动 —— 均不在 v1。
