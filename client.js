/**
 * dsh-recent-sessions —— browser 半。
 *
 * 一个「全部会话」主面板（与上下文洞察 / 技能中心同款：左侧导航入口 + 主对话区面板）：
 *   - 列出所有会话（含归档），按 updatedAt 倒序，行首带全局序号
 *   - 搜索（标题 / 会话 ID / cwd / 工作区名）
 *   - 分页（默认 20，下拉可改 10/20/50/100；下拉与选项配色自动适配深 / 浅主题）
 *   - 列表元信息不显示完整路径；相对时间与日期靠右显示
 *   - 归档会话带「已归档」标识，点击不跳转；普通会话点击直达
 *   - 工作区过滤列表：可把某些工作区下的全部会话整组隐藏（输入框
 *     placeholder 默认显示「记忆中枢」），存 localStorage
 *   - 输入框 dock 上的「会话」按钮：选中本主面板
 *
 * 零外部资源：全部样式为内联 React 样式与内联 SVG，无任何 CDN css/js，
 * 可在无互联网的企业内部署运行。
 *
 * 数据全部来自官方客户端快照，不经过 Host：
 *   ctx.get('sessions').list    → byId: { id → { sessionId, title, updatedAt, running, blank, retainedBy, address } }
 *   ctx.get('workspaces').list  → items[].{ title, sessionIds }, archivedSessionIds, pinnedSessionIds
 * 跳转走 ctx.get('uiWorkspace').openSession(id)；面板选中走 ctx.layout.selectPanel(id)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-recent-sessions',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
    // useDeferredValue 在较新 React 上可用；旧版回退为直通（行为退化为同步过滤，不报错）
    const useDeferredValueIfAvailable = typeof React.useDeferredValue === 'function'
      ? React.useDeferredValue
      : (v) => v;

    /** 主面板 id：sidebar.panellist 的 id 与 root `main` keyed slot 的 key 用同一个值寻址。 */
    const PANEL_ID = 'sessions-window';
    const TYPE_ID = 'dsh-recent-sessions';

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
      return absoluteTime(updatedAt).slice(0, 10);
    }

    function absoluteTime(updatedAt) {
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
      const at = new Date(updatedAt);
      const p = (n) => String(n).padStart(2, '0');
      return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
    }

    /** 路径只显示最后一段（目录名），不显示完整路径。 */
    function cwdBasename(cwd) {
      if (!cwd) return '';
      const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : '';
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

    /**
     * 读取宿主实际渲染的底色，判断深 / 浅主题，并给原生控件（select 下拉）
     * 提供一套不透明的背景 / 前景，避免「白底白字」。纯 DOM 读取，零依赖。
     */
    function detectUiTheme() {
      const fallback = { dark: true, bg: '#202020', fg: '#e6e6e6' };
      try {
        const cs = getComputedStyle(document.body);
        const m = String(cs.backgroundColor).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return fallback;
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        if (alpha < 0.5) return fallback; // 透明底拿不到有效色，按深色兜底
        const r = +m[1], g = +m[2], b = +m[3];
        const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
        return dark
          ? { dark: true, bg: '#262626', fg: '#e8e8e8' }
          : { dark: false, bg: '#ffffff', fg: '#1f2328' };
      } catch {
        return fallback;
      }
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const BORDER = '1px solid color-mix(in srgb, currentColor 18%, transparent)';
    const HOVER_BG = 'color-mix(in srgb, currentColor 8%, transparent)';
    const MUTED = 'color-mix(in srgb, currentColor 55%, transparent)';
    const ACCENT_BLUE = 'color-mix(in srgb, #4c9aff 80%, currentColor 20%)';
    const ACCENT_GREEN = 'color-mix(in srgb, #4cc38a 78%, currentColor 22%)';
    const ACCENT_AMBER = 'color-mix(in srgb, #e0a458 78%, currentColor 22%)';

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        fontSize: '13px', lineHeight: 1.45, gap: 8, padding: 12,
      },
      /* 「全部会话」页头：不加边框、不用单独背景色 */
      hero: {
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '0 2px',
      },
      heroTitleRow: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15 },
      heroStats: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      statPill: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 10px', borderRadius: 999, fontSize: 12,
        border: BORDER, background: 'color-mix(in srgb, currentColor 5%, transparent)',
      },
      statDot: { width: 6, height: 6, borderRadius: 999, display: 'inline-block' },
      toolbar: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      search: {
        flex: 1, minWidth: 120, boxSizing: 'border-box',
        padding: '5px 9px', font: 'inherit', color: 'inherit',
        background: 'transparent', border: BORDER, borderRadius: 6, outline: 'none',
      },
      button: {
        padding: '5px 10px', font: 'inherit', color: 'inherit', cursor: 'pointer',
        background: 'transparent', border: BORDER, borderRadius: 6,
        transition: 'background .12s ease',
      },
      buttonActive: { background: HOVER_BG },
      select: {
        padding: '5px 6px', font: 'inherit', cursor: 'pointer', outline: 'none',
        border: BORDER, borderRadius: 6,
      },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 2 },
      row: {
        display: 'flex', alignItems: 'stretch', gap: 10,
        padding: '6px 8px', borderRadius: 8,
        cursor: 'pointer', textAlign: 'left',
        width: '100%', font: 'inherit', color: 'inherit', border: 'none',
      },
      rowArchived: { cursor: 'default', opacity: 0.62 },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
      /* 行首序号：大字体、跨两行、靠顶部对齐、无边框装饰 */
      indexNum: {
        flexShrink: 0, minWidth: 34, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
        fontSize: 20, fontWeight: 600, lineHeight: 1.1, color: MUTED,
        fontVariantNumeric: 'tabular-nums', alignSelf: 'flex-start',
      },
      rowTitle: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, minWidth: 0, maxWidth: '100%', overflow: 'hidden', flexWrap: 'wrap' },
      rowTitleText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0, maxWidth: '100%' },
      badge: {
        flexShrink: 0, fontSize: 11, lineHeight: 1, padding: '3px 6px', borderRadius: 999,
        fontWeight: 400, border: BORDER,
      },
      rowMeta: {
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: MUTED,
      },
      rowMetaLeft: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
      rowMetaRight: {
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6,
        marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      },
      clockIcon: { flexShrink: 0, display: 'inline-flex', opacity: 0.75 },
      footer: { display: 'flex', alignItems: 'center', gap: 6, color: MUTED, flexWrap: 'wrap' },
      spacer: { flex: 1 },
      empty: { color: MUTED, textAlign: 'center', padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 },
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

    /* 行背景由本类接管：div 无 UA 默认底色，基态透明，hover 高亮 */
    const CSS = `
.sw-row { outline: none; }
.sw-row:not(.archived):hover, .sw-row:not(.archived):focus-visible {
  background-color: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }
.sw-row.archived { cursor: default; opacity: .62; }
`;

    /* ───────────────────────── 装饰 SVG ───────────────────────── */

    function ClockIcon({ size = 12 }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: styles.clockIcon,
      },
        h('circle', { cx: 32, cy: 32, r: 26, fill: 'none', stroke: 'currentColor', strokeWidth: 6 }),
        h('polyline', {
          points: '32,16 32,34 44,42', fill: 'none', stroke: 'currentColor',
          strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    function PanelHeroIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { color: ACCENT_BLUE, flexShrink: 0 },
      },
        h('rect', { x: 8, y: 6, width: 48, height: 52, rx: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
        h('line', { x1: 8, y1: 20, x2: 56, y2: 20, stroke: 'currentColor', strokeWidth: 5 }),
        h('circle', { cx: 20, cy: 32, r: 2.5, fill: 'currentColor' }),
        h('circle', { cx: 20, cy: 42, r: 2.5, fill: 'currentColor' }),
        h('line', { x1: 28, y1: 32, x2: 46, y2: 32, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
        h('line', { x1: 28, y1: 42, x2: 38, y2: 42, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }));
    }

    function EmptyIcon({ size = 44 }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { opacity: 0.4 },
      },
        h('rect', { x: 10, y: 8, width: 44, height: 48, rx: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeDasharray: '6 5' }),
        h('circle', { cx: 32, cy: 30, r: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        h('line', { x1: 32, y1: 44, x2: 32, y2: 50, stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }));
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
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: styles.hintText }, '隐藏这些工作区下的全部会话：'),
          h('span', { style: { ...styles.hintText, marginLeft: 'auto', whiteSpace: 'nowrap' } }, '回车或点上方建议添加；× 移除。')),
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
          }, `+ ${name}`))));
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    /**
     * props 由 root `main` keyed slot 注入；数据与动作经闭包里的 ctx 拿 ——
     * 工厂里 apply 时才建组件，ctx 已就绪。
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
        const [filtered, setFiltered] = useState(() => {
          const saved = loadJson(FILTER_KEY, [])
          // 兜底：存的数据损坏（非字符串数组）时回退为空列表
          return Array.isArray(saved) && saved.every((x) => typeof x === 'string')
            ? saved.filter((x) => x.trim().length > 0)
            : []
        });
        const [filterOpen, setFilterOpen] = useState(false);
        const [now, setNow] = useState(() => Date.now());
        const [ui, setUi] = useState(detectUiTheme);
        const searchRef = useRef(null);

        // 相对时间每 30s 刷新一次（低频、可接受的全列表轻量重渲染）
        useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), 30_000);
          return () => clearInterval(timer);
        }, []);
        // 主题探测：MutationObserver 监听主题相关属性变化，即时生效、零轮询；
        // 观察器不可用时退化为 15s 低频轮询兜底
        useEffect(() => {
          setUi(detectUiTheme());
          const TARGETS = [document.documentElement, document.body];
          if (typeof MutationObserver === 'function') {
            const mo = new MutationObserver(() => setUi(detectUiTheme()));
            for (const t of TARGETS) mo.observe(t, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'aria-hidden'] });
            return () => mo.disconnect();
          }
          const timer = setInterval(() => setUi(detectUiTheme()), 15_000);
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

        // ── 搜索：deferred 值让输入框在大会话量下仍保持即时响应 ──
        const deferredQuery = useDeferredValueIfAvailable(query);

        // ── 过滤 + 搜索 ──
        const queryLower = deferredQuery.trim().toLowerCase();
        const queryStale = deferredQuery !== query;
        const visibleRows = useMemo(() => {
          const filterSet = new Set(filtered);
          return allRows.filter((row) => {
            // workspace 可能为空（sessionIds 未登记该会话，行上显示的是 cwd 目录名兜底），
            // 过滤时同时匹配两者，保证按可见名字能过滤掉。
            if (filterSet.has(row.workspace) || filterSet.has(cwdBasename(row.cwd))) return false;
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
        // 条件变化时回到第 1 页；已在第 1 页则跳过，避免多余的一次重渲染
        const filterKey = query + '\u0000' + filtered.join('\u0000') + '\u0000' + String(pageSize);
        useEffect(() => { setPage((p) => (p === 1 ? p : 1)); }, [filterKey]);

        const archivedVisible = pageRows.filter((r) => r.archived).length;
        const runningVisible = visibleRows.filter((r) => r.running).length;

        // select 用不透明主题色 + colorScheme，原生下拉与选项不再白底白字
        const selectStyle = {
          ...styles.select,
          color: ui.fg, backgroundColor: ui.bg,
          colorScheme: ui.dark ? 'dark' : 'light',
        };
        const optionStyle = { color: ui.fg, backgroundColor: ui.bg };

        return h('div', { style: styles.root },
          h('style', null, CSS),
          // ── 页头（无边框、无单独背景色） ──
          h('div', { style: styles.hero },
            h('div', { style: styles.heroTitleRow },
              h(PanelHeroIcon),
              '全部会话',
              h('div', { style: styles.spacer }),
              h('span', { style: styles.hintText }, '按更新时间倒序')),
            h('div', { style: styles.heroStats },
              h('span', { style: styles.statPill },
                h('span', { style: { ...styles.statDot, background: ACCENT_BLUE } }),
                `共 ${allRows.length} 个`),
              runningVisible > 0 && h('span', { style: styles.statPill },
                h('span', { style: { ...styles.statDot, background: ACCENT_GREEN } }),
                `运行中 ${runningVisible}`),
              visibleRows.length !== allRows.length && h('span', { style: styles.statPill },
                h('span', { style: { ...styles.statDot, background: ACCENT_AMBER } }),
                `当前条件 ${visibleRows.length} 个`),
              archivedVisible > 0 && h('span', { style: styles.statPill },
                h('span', { style: { ...styles.statDot, background: MUTED } }),
                `本页归档 ${archivedVisible} 个`))),
          h('div', { style: styles.toolbar },
            h('input', {
              ref: searchRef, style: styles.search, value: query,
              type: 'search', 'aria-label': '搜索会话',
              placeholder: '搜索会话标题 / ID / 路径 / 工作区',
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } },
            }),
            h('button', {
              style: { ...styles.button, ...(filterOpen || filtered.length > 0 ? styles.buttonActive : {}) },
              onClick: () => setFilterOpen(!filterOpen),
              title: filterOpen ? '收起工作区过滤' : '展开工作区过滤',
              'aria-expanded': filterOpen,
            },
              // 漏斗图标
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flexShrink: 0 } },
                h('path', {
                  d: 'M1.5 2h13l-5 6v5l-3-1.5V8z',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
                })),
              filtered.length > 0 && h('span', { style: { fontSize: 11, color: MUTED } }, String(filtered.length)),
              // 展开 / 收起箭头
              h('svg', { viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': true, style: { flexShrink: 0 } },
                h('path', {
                  d: filterOpen ? 'M3 10l5-5 5 5' : 'M3 6l5 5 5-5',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
                }))),
          ),
          filterOpen && h(FilterPanel, {
            filtered, setFiltered,
            knownWorkspaces,
          }),
          h('div', { style: { ...styles.list, opacity: queryStale ? 0.55 : 1, transition: 'opacity .12s ease' }, role: 'list', 'aria-label': '会话列表' },
            pageRows.length === 0
              ? h('div', { style: styles.empty },
                h(EmptyIcon),
                '没有符合条件的会话')
              : pageRows.map((row, idx) => h(SessionRow, {
                key: row.id, row, now, openSession,
                index: (safePage - 1) * pageSize + idx + 1,
              }))),
          h('div', { style: styles.footer },
            h('span', null, '每页'),
            h('select', {
              style: selectStyle, value: pageSize,
              onChange: (e) => setPageSize(Number(e.target.value)),
            }, PAGE_SIZE_OPTIONS.map((n) => h('option', { key: n, value: n, style: optionStyle }, String(n)))),
            h('span', null, `条 · 第 ${safePage} / ${totalPages} 页`),
            h('div', { style: styles.spacer }),
            pageLink('«', 1, safePage <= 1, safePage, totalPages, setPage),
            pageLink('上一页', safePage - 1, safePage <= 1, safePage, totalPages, setPage),
            pageLink('下一页', safePage + 1, safePage >= totalPages, safePage, totalPages, setPage),
            pageLink('»', totalPages, safePage >= totalPages, safePage, totalPages, setPage),
          ),
        );
      };
    }

    /** 翻页按钮 */
    function pageLink(label, target, disabled, safePage, totalPages, setPage) {
      return h('button', {
        type: 'button',
        style: { ...styles.button, ...(disabled ? { opacity: 0.45, cursor: 'default' } : {}) },
        disabled,
        onClick: () => { if (!disabled && target >= 1 && target <= totalPages) setPage(target); },
      }, label);
    }

    function SessionRow({ row, now, openSession, index }) {
      const isArchived = row.archived;
      const at = absoluteTime(row.updatedAt); // 一次计算，两处复用
      // 普通元素（非原生 button）：无 UA 默认白底/焦点样式，可点击性用 role+tabIndex+键盘事件补齐
      return h('div', {
        className: `sw-row${isArchived ? ' archived' : ''}`,
        style: styles.row,
        role: isArchived ? 'listitem' : 'button',
        'aria-label': isArchived ? `${row.title}（已归档）` : `打开会话 ${row.title}`,
        tabIndex: isArchived ? -1 : 0,
        title: isArchived
          ? '已归档会话'
          : `${row.title}\n${row.cwd || row.id}\n${at}`,
        onClick: () => { if (!isArchived) openSession(row.id); },
        onKeyDown: (e) => {
          if (!isArchived && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSession(row.id); }
        },
      },
        h('span', { style: styles.indexNum, 'aria-hidden': true }, String(index)),
        h('span', { style: styles.rowMain },
          h('span', { style: styles.rowTitle },
            h('span', { style: styles.rowTitleText }, row.title),
            isArchived && h('span', { key: 'arch', style: styles.badge }, '已归档'),
            row.current && h('span', { key: 'cur', style: { ...styles.badge, color: ACCENT_BLUE, borderColor: ACCENT_BLUE } }, '当前'),
            row.pinned && h('span', { key: 'pin', style: styles.badge }, '置顶'),
            row.running && h('span', { key: 'run', style: { ...styles.badge, color: ACCENT_GREEN, borderColor: ACCENT_GREEN } }, '运行中'),
          ),
          h('span', { style: styles.rowMeta },
            h('span', {
              style: styles.rowMetaLeft,
              title: `${row.cwd}${row.cwd ? '\n' : ''}${row.id}`,
            }, [row.workspace, cwdBasename(row.cwd)]
              .filter((part, i, arr) => part && arr.indexOf(part) === i)
              .join(' · ')),
            h('span', { style: styles.rowMetaRight, title: at },
              relativeTime(row.updatedAt, now),
              h('span', { style: { opacity: 0.5 } }, '·'),
              at))));
    }

    /* ───────────────────────── 入口按钮（conversation.input.right，模型选择框旁） ───────────────────────── */

    function makeEntryButton(ctx) {
      return function OpenSessionsWindowButton() {
        const onClick = () => {
          try {
            ctx.layout?.selectPanel?.(PANEL_ID);
          } catch (error) {
            ctx.logger?.warn?.('[sessions-window] selectPanel 失败：', error);
          }
        };
        // 无边框纯图标（与象棋按钮同款形态）
        return h('button', {
          type: 'button',
          onClick,
          title: '全部会话：按更新时间浏览所有会话',
          'aria-label': '打开全部会话面板',
          style: {
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary, inherit)',
            padding: '4px 6px', borderRadius: 6, lineHeight: 1, display: 'inline-flex', alignItems: 'center',
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))'; },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
        },
          h('svg', {
            viewBox: '0 0 64 64', width: 16, height: 16, 'aria-hidden': true, style: { flexShrink: 0 },
          },
            h('rect', { x: 8, y: 6, width: 48, height: 52, rx: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
            h('line', { x1: 8, y1: 20, x2: 56, y2: 20, stroke: 'currentColor', strokeWidth: 5 }),
            h('line', { x1: 18, y1: 32, x2: 46, y2: 32, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
            h('line', { x1: 18, y1: 43, x2: 38, y2: 43, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' })));
      };
    }

    /* ───────────────────────── 左侧导航图标（sidebar.panellist） ───────────────────────── */

    function SessionsPanelIcon({ size }) {
      const s = size ?? 16;
      return h('svg', { viewBox: '0 0 64 64', width: s, height: s, 'aria-hidden': true },
        h('rect', { x: 8, y: 6, width: 48, height: 52, rx: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
        h('line', { x1: 8, y1: 20, x2: 56, y2: 20, stroke: 'currentColor', strokeWidth: 5 }),
        h('circle', { cx: 20, cy: 32, r: 2.5, fill: 'currentColor' }),
        h('circle', { cx: 20, cy: 42, r: 2.5, fill: 'currentColor' }),
        h('line', { x1: 28, y1: 32, x2: 46, y2: 32, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
        h('line', { x1: 28, y1: 42, x2: 38, y2: 42, stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }));
    }

    /* ───────────────────────── 插件注册 ───────────────────────── */

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout'],
      apply(ctx) {
        // ① 主面板正文（root `main` keyed slot，key 与 panellist 的 id 同值）
        const Body = makeBody(ctx);
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          Body,
        )), 'sessions-window: main panel');

        // ② 左侧导航入口（与「上下文洞察」「技能中心」同款 sidebar.panellist 行）
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => '全部会话',
          },
          SessionsPanelIcon,
        )), 'sessions-window: sidebar entry');

        // ③ 输入区右上快捷入口：conversation.input.right（模型选择框旁）
        const EntryButton = makeEntryButton(ctx);
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'sessions-window-open', order: 5 },
          EntryButton,
        )), 'sessions-window: entry button');
      },
    };
  },
});
