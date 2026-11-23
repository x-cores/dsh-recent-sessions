/**
 * @local/sessions-window —— browser 半。
 *
 * 一个「全部会话」右侧浮动窗口（与上下文洞察同款的 sidebar-right 页签）：
 *   - 列出所有会话（含归档），按 updatedAt 倒序
 *   - 搜索（标题 / 会话 ID / cwd / 工作区名）
 *   - 分页（默认 20，下拉可改 10/20/50/100）
 *   - 归档会话带「已归档」标识，点击不跳转；普通会话点击直达
 *   - 工作区过滤列表：可把某些工作区下的全部会话整组隐藏（输入框
 *     placeholder 默认显示「记忆中枢」），存 localStorage
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
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;

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

    /* ───────────────────────── 样式 ───────────────────────── */

    const BORDER = '1px solid color-mix(in srgb, currentColor 18%, transparent)';
    const HOVER_BG = 'color-mix(in srgb, currentColor 8%, transparent)';
    const MUTED = 'color-mix(in srgb, currentColor 55%, transparent)';

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        fontSize: '13px', lineHeight: 1.45, gap: 8,
      },
      toolbar: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      search: {
        flex: 1, minWidth: 120, boxSizing: 'border-box',
        padding: '5px 9px', font: 'inherit', color: 'inherit',
        background: 'transparent', border: BORDER, borderRadius: 6, outline: 'none',
      },
      button: {
        padding: '5px 10px', font: 'inherit', color: 'inherit', cursor: 'pointer',
        background: 'transparent', border: BORDER, borderRadius: 6,
      },
      buttonActive: { background: HOVER_BG },
      select: {
        padding: '5px 6px', font: 'inherit', color: 'inherit', cursor: 'pointer',
        background: 'transparent', border: BORDER, borderRadius: 6, outline: 'none',
      },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 2 },
      row: {
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: '7px 9px', borderRadius: 6, border: '1px solid transparent',
        cursor: 'pointer', textAlign: 'left',
      },
      rowArchived: { cursor: 'default', opacity: 0.62 },
      rowTitle: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, minWidth: 0 },
      rowTitleText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      badge: {
        flexShrink: 0, fontSize: 11, lineHeight: 1, padding: '3px 6px', borderRadius: 999,
        border: BORDER, fontWeight: 400,
      },
      rowMeta: { color: MUTED, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      footer: { display: 'flex', alignItems: 'center', gap: 6, color: MUTED, flexWrap: 'wrap' },
      spacer: { flex: 1 },
      empty: { color: MUTED, textAlign: 'center', padding: '28px 0' },
      filterPanel: {
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: 10, border: BORDER, borderRadius: 8, marginBottom: 4,
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
        borderRadius: 999, border: BORDER, fontSize: 12, cursor: 'default',
      },
      chipRemove: { cursor: 'pointer', border: 'none', background: 'none', color: 'inherit', padding: 0, font: 'inherit', lineHeight: 1 },
      hintText: { fontSize: 12, color: MUTED },
      knownRow: { display: 'flex', gap: 4, flexWrap: 'wrap' },
      knownButton: { fontSize: 11, padding: '2px 6px', borderRadius: 999, border: BORDER, background: 'transparent', color: 'inherit', cursor: 'pointer' },
    };

    function useHover() {
      const [hovered, setHovered] = useState(false);
      const bind = { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) };
      return [hovered, bind];
    }

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
      return h('div', { style: styles.filterPanel },
        h('div', { style: styles.hintText }, '隐藏这些工作区下的全部会话：'),
        filtered.length > 0 && h('div', { style: styles.chips },
          filtered.map((name) => h('span', { key: name, style: styles.chip },
            name,
            h('button', {
              key: 'x', style: styles.chipRemove, 'aria-label': `取消过滤 ${name}`,
              onClick: () => setFiltered(filtered.filter((n) => n !== name)),
            }, '×'),
          ))),
        h('input', {
          style: styles.search, value: text,
          placeholder: FILTER_PLACEHOLDER,
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') add(e.target.value); },
        }),
        suggestions.length > 0 && h('div', { style: styles.knownRow },
          suggestions.map((name) => h('button', {
            key: name, style: styles.knownButton, onClick: () => add(name),
          }, `+ ${name}`))),
        h('div', { style: styles.hintText }, '回车或点上方建议添加；× 移除。'));
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
        const searchRef = useRef(null);

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
          const listeners = new Set();
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
              listeners.add(listener);
              return () => { for (const off of offs) off(); listeners.delete(listener); };
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
        useEffect(() => { setPage(1); }, [query, filtered.join('\u0000'), pageSize]);

        const archivedVisible = pageRows.filter((r) => r.archived).length;

        return h('div', { style: styles.root },
          h('div', { style: styles.toolbar },
            h('input', {
              ref: searchRef, style: styles.search, value: query,
              placeholder: '搜索会话标题 / ID / 路径 / 工作区',
              onChange: (e) => setQuery(e.target.value),
            }),
            h('button', {
              style: { ...styles.button, ...(filterOpen || filtered.length > 0 ? styles.buttonActive : {}) },
              onClick: () => setFilterOpen(!filterOpen),
              title: '设置工作区过滤列表',
            }, `过滤${filtered.length > 0 ? ` · ${filtered.length}` : ''}`),
          ),
          filterOpen && h(FilterPanel, {
            filtered, setFiltered,
            knownWorkspaces,
          }),
          h('div', { style: styles.hintText },
            `共 ${allRows.length} 个会话` + (visibleRows.length !== allRows.length ? `，当前条件 ${visibleRows.length} 个` : '')
            + (archivedVisible > 0 ? `，其中已归档 ${archivedVisible} 个` : '')),
          h('div', { style: styles.list },
            pageRows.length === 0
              ? h('div', { style: styles.empty }, '没有符合条件的会话')
              : pageRows.map((row) => h(SessionRow, { key: row.id, row, now, openSession }))),
          h('div', { style: styles.footer },
            h('span', null, '每页'),
            h('select', {
              style: styles.select, value: pageSize,
              onChange: (e) => setPageSize(Number(e.target.value)),
            }, PAGE_SIZE_OPTIONS.map((n) => h('option', { key: n, value: n }, String(n)))),
            h('span', null, `条 · 第 ${safePage} / ${totalPages} 页`),
            h('div', { style: styles.spacer }),
            h('button', { style: styles.button, disabled: safePage <= 1, onClick: () => setPage(1) }, '«'),
            h('button', { style: styles.button, disabled: safePage <= 1, onClick: () => setPage(safePage - 1) }, '上一页'),
            h('button', { style: styles.button, disabled: safePage >= totalPages, onClick: () => setPage(safePage + 1) }, '下一页'),
            h('button', { style: styles.button, disabled: safePage >= totalPages, onClick: () => setPage(totalPages) }, '»'),
          ),
        );
      };
    }

    function SessionRow({ row, now, openSession }) {
      const [hovered, bind] = useHover();
      const isArchived = row.archived;
      const style = {
        ...styles.row,
        ...(isArchived ? styles.rowArchived : {}),
        ...(hovered && !isArchived ? { background: HOVER_BG, border: BORDER } : {}),
      };
      return h('div', {
        ...bind,
        style,
        role: isArchived ? 'listitem' : 'button',
        tabIndex: isArchived ? -1 : 0,
        title: isArchived
          ? '已归档会话'
          : `${row.title}\n${row.cwd || row.id}\n${absoluteTime(row.updatedAt)}`,
        onClick: () => { if (!isArchived) openSession(row.id); },
        onKeyDown: (e) => {
          if (!isArchived && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSession(row.id); }
        },
      },
        h('div', { style: styles.rowTitle },
          h('span', { style: styles.rowTitleText }, row.title),
          isArchived && h('span', { key: 'arch', style: styles.badge }, '已归档'),
          row.current && h('span', { key: 'cur', style: styles.badge }, '当前'),
          row.pinned && h('span', { key: 'pin', style: styles.badge }, '置顶'),
          row.running && h('span', { key: 'run', style: styles.badge }, '运行中'),
        ),
        h('div', { style: styles.rowMeta, title: `${row.cwd}${row.cwd ? '\n' : ''}${row.id}` },
          [
            row.workspace,
            relativeTime(row.updatedAt, now),
            absoluteTime(row.updatedAt),
            row.cwd,
          ].filter(Boolean).join(' · ')),
      );
    }

    /* ───────────────────────── 入口按钮（输入框 dock） ───────────────────────── */

    function makeDockButton(ctx) {
      return function OpenSessionsWindowButton() {
        const [hovered, bind] = useHover();
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
        return h('button', {
          ...bind,
          onClick,
          title: '全部会话：按更新时间浏览所有会话',
          'aria-label': '打开全部会话窗口',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 8px', font: 'inherit', fontSize: 12, color: 'inherit', cursor: 'pointer',
            background: hovered ? HOVER_BG : 'transparent',
            border: BORDER, borderRadius: 6,
          },
        },
          h('svg', {
            viewBox: '0 0 64 64', width: 14, height: 14, 'aria-hidden': true,
            style: { flexShrink: 0 },
          },
            h('rect', { x: 8, y: 6, width: 48, height: 52, rx: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
            h('line', { x1: 8, y1: 20, x2: 56, y2: 20, stroke: 'currentColor', strokeWidth: 5 }),
            h('line', { x1: 18, y1: 32, x2: 46, y2: 32, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
            h('line', { x1: 18, y1: 43, x2: 38, y2: 43, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' })),
          '会话');
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
          ctx.logger?.warn?.('[sessions-window] sidebarRightTabs 不可用，仅注册 dock 按钮');
        }

        // ② 页签正文（keyed：注册 key = 类型实现 id）
        const Body = makeBody(ctx);
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TYPE_ID },
          Body,
        )), 'sessions-window: tab body');

        // ③ 输入框 dock 上的打开按钮
        const DockButton = makeDockButton(ctx);
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'sessions-window-open', order: 8 },
          DockButton,
        )), 'sessions-window: dock button');
      },
    };
  },
});
