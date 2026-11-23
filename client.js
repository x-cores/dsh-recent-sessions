/**
 * @local/sessions-window —— browser 半。
 *
 * 一个「全部会话」右侧浮动窗口（与上下文洞察同款的 sidebar-right 页签）：
 *   - 列出所有会话（含归档），按 updatedAt 倒序；行首是跨两行的大号序号
 *   - 搜索（标题 / 会话 ID / cwd / 工作区名）
 *   - 分页（默认 20，下拉可改 10/20/50/100；翻页用链接不用按钮）
 *   - 归档会话带「已归档」标识，点击不跳转；普通会话点击直达
 *   - 工作区过滤列表：可把某些工作区下的全部会话整组隐藏（输入框
 *     placeholder 默认显示「记忆中枢」），存 localStorage
 *
 * 入口按钮挂在 conversation.input.right（与象棋游戏同款位置：模型选择框旁），
 * 无边框纯图标；hover 走 CSS :hover（不依赖 JS state，不会残留高亮）。
 *
 * 数据全部来自官方客户端快照，不经过 Host：
 *   ctx.get('sessions').list    → byId: { id → { sessionId, title, updatedAt, running, blank, retainedBy, address } }
 *   ctx.get('workspaces').list  → items[].{ title, sessionIds }, archivedSessionIds, pinnedSessionIds
 * 跳转走 ctx.get('uiWorkspace').openSession(id)。
 */
window.__ModuleLoader__.load({
  id: '@local/sessions-window',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useSyncExternalStore } = React;

    /** 页签类型 kind（openTab 用）与实现 id（keyed 席位注册 key）。 */
    const KIND = 'sessions-window';
    const TYPE_ID = '@local/sessions-window';

    const FILTER_KEY = 'dsh.sessions-window.filteredWorkspaces.v1';
    const PAGE_SIZE_KEY = 'dsh.sessions-window.pageSize.v1';
    const DEFAULT_PAGE_SIZE = 20;
    const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
    /** 过滤输入框的默认 placeholder。 */
    const FILTER_PLACEHOLDER = '记忆中枢';

    /* ───────────────────────── 小工具 ───────────────────────── */

    function idOf(key, summary) {
      return summary.sessionId ?? key;
    }

    function workspaceNames(items) {
      const map = new Map();
      for (const item of items ?? []) {
        const title = item.title?.trim();
        if (!title) continue;
        for (const sessionId of item.sessionIds ?? []) {
          if (!map.has(sessionId)) map.set(sessionId, title);
        }
      }
      return map;
    }

    function relativeTime(updatedAt, now) {
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '时间未知';
      const diff = Math.max(0, now - updatedAt);
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
      const at = new Date(updatedAt);
      return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    }

    function absoluteTime(updatedAt) {
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
      const at = new Date(updatedAt);
      const p = (n) => String(n).padStart(2, '0');
      return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
    }

    function loadJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
      } catch {
        return fallback;
      }
    }

    function saveJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch { /* 私隐模式等存不进去就算了 */ }
    }

    /* ───────────────────────── 样式表（hover 全部走 CSS） ───────────────────────── */

    const CSS = `
.sw-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-size: 13px; line-height: 1.45; gap: 8px; padding: 12px; box-sizing: border-box; }
.sw-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sw-search { flex: 1; min-width: 120px; box-sizing: border-box; padding: 5px 9px;
  font: inherit; color: inherit; background: transparent; border: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  border-radius: 0; outline: none; }
.sw-search:focus { border-bottom-color: var(--dsw-alias-label-accent, currentColor); }
.sw-iconbtn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px;
  font: inherit; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer;
  background: transparent; border: none; border-radius: 6px; line-height: 1;
  position: relative; }
.sw-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
.sw-iconbtn .cnt { font-size: 10px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8)); }
.sw-select { padding: 2px 4px; font: inherit; color: inherit; cursor: pointer;
  background: transparent; border: none; outline: none; }
.sw-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
/* ── 会话行：无边框装饰；hover 只加背景（CSS :hover，移出即消失） ── */
.sw-row { display: flex; align-items: stretch; gap: 10px; padding: 6px 8px;
  border-radius: 8px; cursor: pointer; text-align: left; outline: none;
  background: transparent; border: none; font: inherit; color: inherit; width: 100%; }
.sw-row:hover, .sw-row:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.sw-row.archived { cursor: default; opacity: .55; }
.sw-row.archived:hover { background: transparent; }
/* 行首序号：大字体、跨两行、无边框装饰 */
.sw-idx { flex: none; min-width: 34px; display: flex; align-items: center; justify-content: flex-end;
  font-size: 20px; font-weight: 600; line-height: 1;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75));
  font-variant-numeric: tabular-nums; }
.sw-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sw-title { display: flex; align-items: center; gap: 6px; font-weight: 500; min-width: 0; }
.sw-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.sw-badge { flex: none; font-size: 11px; line-height: 1; padding: 3px 6px; border-radius: 999;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8)); }
.sw-meta { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75)); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75)); }
.sw-spacer { flex: 1; }
/* 翻页链接 */
.sw-link { background: none; border: none; padding: 0; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-accent, #4d8fd6); cursor: pointer; text-decoration: none; }
.sw-link:hover { text-decoration: underline; }
.sw-link.off { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.5)); cursor: default; text-decoration: none; }
.sw-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75)); }
.sw-empty { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75)); text-align: center; padding: 28px 0; }
/* 过滤面板 */
.sw-filter { display: flex; flex-direction: column; gap: 6px; padding: 8px 0 2px; }
.sw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sw-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border-radius: 999; font-size: 12px; cursor: default;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.sw-chip button { cursor: pointer; border: none; background: none; color: inherit;
  padding: 0; font: inherit; line-height: 1; }
.sw-filter input { padding: 5px 9px; font: inherit; color: inherit; background: transparent;
  border: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  border-radius: 0; outline: none; }
.sw-known { display: flex; gap: 4px; flex-wrap: wrap; }
.sw-known button { font-size: 11px; padding: 2px 6px; border-radius: 999; border: none;
  background: transparent; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; }
.sw-known button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
/* 入口按钮（conversation.input.right）：与象棋按钮同款，无边框无背景 */
.sw-entry { border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit); font-size: 16px; line-height: 1;
  padding: 4px 6px; border-radius: 6px; display: inline-flex; align-items: center; }
.sw-entry:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
`;

    /* ───────────────────────── 过滤面板 ───────────────────────── */

    function FilterPanel({ filtered, setFiltered, knownWorkspaces }) {
      const [text, setText] = useState('');
      const add = (name) => {
        const trimmed = name.trim();
        if (!trimmed || filtered.includes(trimmed)) return;
        setFiltered([...filtered, trimmed]);
        setText('');
      };
      const suggestions = knownWorkspaces.filter((w) => w && !filtered.includes(w)).slice(0, 12);
      return h('div', { className: 'sw-filter' },
        h('div', { className: 'sw-hint' }, '隐藏这些工作区下的全部会话：'),
        filtered.length > 0 && h('div', { className: 'sw-chips' },
          filtered.map((name) => h('span', { key: name, className: 'sw-chip' },
            name,
            h('button', {
              'aria-label': `取消过滤 ${name}`,
              onClick: () => setFiltered(filtered.filter((n) => n !== name)),
            }, '×'),
          ))),
        h('input', {
          value: text,
          placeholder: FILTER_PLACEHOLDER,
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') add(e.target.value); },
        }),
        suggestions.length > 0 && h('div', { className: 'sw-known' },
          suggestions.map((name) => h('button', {
            key: name, onClick: () => add(name),
          }, `+ ${name}`))),
      );
    }

    /* ───────────────────────── 会话行 ───────────────────────── */

    function SessionRow({ index, row, now, openSession }) {
      const isArchived = row.archived;
      return h('button', {
        type: 'button',
        className: `sw-row${isArchived ? ' archived' : ''}`,
        tabIndex: isArchived ? -1 : 0,
        title: isArchived
          ? '已归档会话'
          : `${row.title}\n${row.cwd || row.id}\n${absoluteTime(row.updatedAt)}`,
        onClick: () => { if (!isArchived) openSession(row.id); },
      },
        h('span', { className: 'sw-idx', 'aria-hidden': true }, String(index)),
        h('span', { className: 'sw-main' },
          h('span', { className: 'sw-title' },
            h('span', { className: 'sw-title-text' }, row.title),
            isArchived && h('span', { key: 'arch', className: 'sw-badge' }, '已归档'),
            row.current && h('span', { key: 'cur', className: 'sw-badge' }, '当前'),
            row.pinned && h('span', { key: 'pin', className: 'sw-badge' }, '置顶'),
            row.running && h('span', { key: 'run', className: 'sw-badge' }, '运行中'),
          ),
          h('span', { className: 'sw-meta', title: `${row.cwd}${row.cwd ? '\n' : ''}${row.id}` },
            [
              row.workspace,
              relativeTime(row.updatedAt, now),
              absoluteTime(row.updatedAt),
              row.cwd,
            ].filter(Boolean).join(' · ')),
        ),
      );
    }

    /* ───────────────────────── 主窗口 ───────────────────────── */

    /**
     * props 由 sidebar.right.pane.tab 席位注入（hooks.tabInfo 等），
     * 数据与动作经闭包里的 ctx 拿 —— 工厂里 apply 时才建组件，ctx 已就绪。
     */
    function makeBody(ctx) {
      const sessionsApi = ctx.get?.('sessions', false);
      const workspacesApi = ctx.get?.('workspaces', false);
      const uiWorkspace = ctx.get?.('uiWorkspace', false);

      function openSession(id) {
        if (typeof uiWorkspace?.openSession === 'function') {
          try { uiWorkspace.openSession(id); return; } catch (error) {
            ctx.logger?.warn?.('[sessions-window] openSession 失败：', error);
          }
        }
      }

      return function SessionsWindowBody() {
        const [query, setQuery] = useState('');
        const [page, setPage] = useState(1);
        const [pageSize, setPageSize] = useState(() => {
          const saved = loadJson(PAGE_SIZE_KEY, DEFAULT_PAGE_SIZE);
          return PAGE_SIZE_OPTIONS.includes(saved) ? saved : DEFAULT_PAGE_SIZE;
        });
        const [filtered, setFiltered] = useState(() => loadJson(FILTER_KEY, []));
        const [filterOpen, setFilterOpen] = useState(false);
        const [now, setNow] = useState(() => Date.now());

        // 相对时间每 30s 刷新一次
        useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), 30_000);
          return () => clearInterval(timer);
        }, []);

        useEffect(() => { saveJson(FILTER_KEY, filtered); }, [filtered]);
        useEffect(() => { saveJson(PAGE_SIZE_KEY, pageSize); }, [pageSize]);

        // ── 两个官方快照 → 引用稳定的行数组 ──
        const rowsStore = useMemo(() => {
          let cache = [];
          let known = [];
          const recompute = () => {
            const byId = sessionsApi?.list?.getSnapshot()?.byId ?? {};
            const ws = workspacesApi?.list?.getSnapshot();
            const archived = new Set(ws?.archivedSessionIds ?? []);
            const pinned = new Set(ws?.pinnedSessionIds ?? []);
            const names = workspaceNames(ws?.items);
            let currentId;
            const rows = [];
            for (const [key, summary] of Object.entries(byId)) {
              if (summary?.address?.kind === 'subagent') continue; // 子代理不是对话
              const id = idOf(key, summary);
              if ((summary?.retainedBy?.mainView ?? 0) > 0) currentId = id;
              const updatedAt = Number.isFinite(summary?.updatedAt) ? summary.updatedAt : 0;
              if (updatedAt <= 0) continue;
              rows.push({
                id,
                title: summary.blank ? '新会话' : (summary.title?.trim() || '未命名会话'),
                workspace: names.get(id) ?? '',
                cwd: summary.cwd ?? '',
                updatedAt,
                running: summary.running === true,
                archived: archived.has(id),
                pinned: pinned.has(id),
                current: false,
              });
            }
            for (const row of rows) if (row.id === currentId) row.current = true;
            rows.sort((a, b) => b.updatedAt - a.updatedAt);
            cache = rows;
            known = [...new Set([...names.values()])].sort((a, b) => a.localeCompare(b));
          };
          recompute();
          return {
            subscribe(listener) {
              const notify = () => { recompute(); listener(); };
              const offs = [
                sessionsApi?.list?.subscribe?.(notify),
                workspacesApi?.list?.subscribe?.(notify),
              ].filter(Boolean);
              return () => { for (const off of offs) off(); };
            },
            getSnapshot() { return cache; },
            getKnownWorkspaces() { return known; },
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const allRows = useSyncExternalStore(rowsStore.subscribe, rowsStore.getSnapshot);
        const knownWorkspaces = rowsStore.getKnownWorkspaces();

        // ── 过滤 + 搜索 ──
        const queryLower = query.trim().toLowerCase();
        const visibleRows = useMemo(() => {
          const filterSet = new Set(filtered);
          return allRows.filter((row) => {
            if (filterSet.has(row.workspace)) return false;
            if (queryLower.length === 0) return true;
            return row.title.toLowerCase().includes(queryLower)
              || row.id.toLowerCase().includes(queryLower)
              || row.cwd.toLowerCase().includes(queryLower)
              || row.workspace.toLowerCase().includes(queryLower);
          });
        }, [allRows, filtered, queryLower]);

        const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
        const safePage = Math.min(page, totalPages);
        const pageRows = visibleRows.slice((safePage - 1) * pageSize, safePage * pageSize);

        const archivedVisible = pageRows.filter((r) => r.archived).length;
        const filterTag = useMemo(() => filtered.join('\u0000'), [filtered]);

        // 搜索 / 过滤 / 每页条数变化时回到第 1 页
        useEffect(() => { setPage(1); }, [query, filterTag, pageSize]);

        /** 翻页链接 */
        const link = (label, target, disabled) => h('button', {
          type: 'button',
          className: `sw-link${disabled ? ' off' : ''}`,
          disabled,
          onClick: () => { if (!disabled && target >= 1 && target <= totalPages) setPage(target); },
        }, label);

        return h('div', { className: 'sw-root' },
          h('style', null, CSS),
          h('div', { className: 'sw-toolbar' },
            h('input', {
              className: 'sw-search', value: query,
              placeholder: '搜索会话标题 / ID / 路径 / 工作区',
              onChange: (e) => setQuery(e.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'sw-iconbtn',
              title: filterOpen ? '收起工作区过滤' : '展开工作区过滤',
              'aria-expanded': filterOpen,
              onClick: () => setFilterOpen(!filterOpen),
            },
              // 漏斗图标
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
                h('path', {
                  d: 'M1.5 2h13l-5 6v5l-3-1.5V8z',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
                })),
              filtered.length > 0 && h('span', { className: 'cnt' }, String(filtered.length)),
              // 展开/收起箭头
              h('svg', { viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': true },
                h('path', {
                  d: filterOpen ? 'M3 10l5-5 5 5' : 'M3 6l5 5 5-5',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
                })),
            ),
          ),
          filterOpen && h(FilterPanel, {
            filtered, setFiltered,
            knownWorkspaces,
          }),
          h('div', { className: 'sw-hint' },
            `共 ${allRows.length} 个会话` + (visibleRows.length !== allRows.length ? `，当前条件 ${visibleRows.length} 个` : '')
            + (archivedVisible > 0 ? `，其中已归档 ${archivedVisible} 个` : '')),
          h('div', { className: 'sw-list' },
            pageRows.length === 0
              ? h('div', { className: 'sw-empty' }, '没有符合条件的会话')
              : pageRows.map((row, i) => h(SessionRow, {
                  key: row.id, row, now, openSession,
                  index: (safePage - 1) * pageSize + i + 1,
                }))),
          h('div', { className: 'sw-footer' },
            h('span', null, '每页'),
            h('select', {
              className: 'sw-select', value: pageSize,
              onChange: (e) => setPageSize(Number(e.target.value)),
            }, PAGE_SIZE_OPTIONS.map((n) => h('option', { key: n, value: n }, String(n)))),
            h('span', null, `条 · 第 ${safePage} / ${totalPages} 页`),
            h('span', { className: 'sw-spacer' }),
            link('«', 1, safePage <= 1),
            link('上一页', safePage - 1, safePage <= 1),
            link('下一页', safePage + 1, safePage >= totalPages),
            link('»', totalPages, safePage >= totalPages),
          ),
        );
      };
    }

    /* ───────────────────────── 入口按钮（conversation.input.right，模型选择框旁） ───────────────────────── */

    function makeEntryButton(ctx) {
      return function OpenSessionsWindowButton() {
        const onClick = () => {
          const sidebarRight = ctx.get?.('sidebarRight', false);
          try {
            if (sidebarRight?.openTab) {
              sidebarRight.openTab(KIND, { destination: 'float' });
              return;
            }
          } catch (error) {
            ctx.logger?.warn?.('[sessions-window] openTab 失败：', error);
          }
        };
        // ▤：BMP 几何符号（旧字体也有字形），扣「列表」意象
        return h('button', {
          type: 'button',
          className: 'sw-entry',
          onClick,
          title: '全部会话：按更新时间浏览所有会话',
          'aria-label': '打开全部会话窗口',
        },
          h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
            h('path', {
              d: 'M2 3.5h12M2 8h12M2 12.5h8',
              stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
            })));
      };
    }

    /* ───────────────────────── 插件注册 ───────────────────────── */

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        // ① 页签类型：kind 供 openTab；guide 让它出现在右侧栏引导页上
        const tabs = ctx.get?.('sidebarRightTabs', false);
        if (typeof tabs?.register === 'function') {
          ctx.effect(() => tabs.register({
            id: TYPE_ID,
            kind: KIND,
            title: () => '全部会话',
            guide: [{
              id: 'main',
              order: 20,
              title: () => '全部会话',
              description: () => '按更新时间浏览所有会话；支持搜索、分页、归档标识与工作区过滤',
            }],
          }), 'sessions-window: tab type');
        } else {
          ctx.logger?.warn?.('[sessions-window] sidebarRightTabs 不可用，仅注册入口按钮');
        }

        // ② 页签正文（keyed：注册 key = 类型实现 id）
        const Body = makeBody(ctx);
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TYPE_ID },
          Body,
        )), 'sessions-window: tab body');

        // ③ 入口按钮：conversation.input.right（模型选择框旁，与象棋同款位置）
        const EntryButton = makeEntryButton(ctx);
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'sessions-window-open', order: 5 },
          EntryButton,
        )), 'sessions-window: entry button');
      },
    };
  },
});
