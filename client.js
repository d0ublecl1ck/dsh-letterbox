/**
 * dsh-letterbox — client half.
 *
 * One dock above the composer. It shows how many notes the agent filed for this
 * Session are still unacknowledged, and gives the human the only button that
 * can turn one into "read". Acknowledged notes leave the main list and live in
 * the history tab, which searches them without offering the button again. The
 * host half owns the ledger; this half never guesses a receipt.
 *
 * Loaded by the Web module loader (window.__ModuleLoader__), not by Node ESM,
 * so there is no bundler and no JSX here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-letterbox',
  factory(require) {
    const React = require('react');
    // Floating layers are portalled to <body>: inside the composer subtree a
    // transformed ancestor would both trap position:fixed and create a stacking
    // context that lets the host's sidebar paint over our panel.
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const ROUTE = '/letterbox';
    const POLL_MS = 5000;
    const SEARCH_DEBOUNCE_MS = 250;
    const PAGE_SIZE = 20;
    const TOAST_MS = 8000;

    /** The conversation the main view is showing, or null. */
    function currentSessionId(list) {
      if (list === null || typeof list !== 'object' || !Array.isArray(list.ids)) return null;
      for (const id of list.ids) {
        const row = list.byId ? list.byId[id] : null;
        if (row && row.retainedBy && row.retainedBy.mainView > 0) return id;
      }
      return list.ids.length > 0 ? list.ids[0] : null;
    }

    function useSessionId(sessions) {
      const [sessionId, setSessionId] = React.useState(() => currentSessionId(sessions.getSnapshot()));
      React.useEffect(() => {
        const read = () => setSessionId(currentSessionId(sessions.getSnapshot()));
        read();
        const unsubscribe = typeof sessions.subscribe === 'function' ? sessions.subscribe(read) : undefined;
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, [sessions]);
      return sessionId;
    }

    function emptyLedger() {
      return { sessionId: null, bucket: 'session', unreadCount: 0, globalUnreadCount: 0, items: [], error: null, loaded: false };
    }

    async function post(endpoint, body) {
      const response = await fetch(ROUTE + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (payload === null || payload.ok !== true || payload.value === undefined) {
        throw new Error('letterbox host refused ' + endpoint + ' (HTTP ' + String(response.status) + ')');
      }
      return payload.value;
    }

    /**
     * One box's snapshot, polled.
     *
     * `bucket` picks the box ('session' or 'global'); `active` lets the panel stop
     * polling a box it is not showing. The session box is always polled because
     * the entry button's count is session-only.
     */
    function useLedger(sessionId, bucket = 'session', active = true) {
      const [ledger, setLedger] = React.useState(emptyLedger);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(() => {
        alive.current = true;
        if (sessionId === null || !active) return undefined;
        let cancelled = false;
        const refresh = async () => {
          try {
            const value = await post('list', { sessionId, bucket });
            if (!cancelled && alive.current) setLedger({ ...value, error: null, loaded: true });
          } catch (error) {
            if (!cancelled && alive.current) setLedger((previous) => ({ ...previous, error: String(error && error.message ? error.message : error), loaded: true }));
          }
        };
        void refresh();
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId, bucket, active]);
      const markRead = React.useCallback(async (id) => {
        if (sessionId === null) return;
        try {
          const value = await post('read', { sessionId, id, bucket });
          setLedger({ ...value, error: null, loaded: true });
        } catch (error) {
          setLedger((previous) => ({ ...previous, error: String(error && error.message ? error.message : error) }));
        }
      }, [sessionId, bucket]);
      return { ...ledger, markRead };
    }

    /** Delay a fast-changing value so typing does not fire one request per key. */
    function useDebounced(value, delay) {
      const [settled, setSettled] = React.useState(value);
      React.useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
      }, [value, delay]);
      return settled;
    }

    /**
     * Acknowledged items, one page at a time.
     *
     * The first page is fetched whenever the view changes (session, tab, query,
     * or a new acknowledgement); every later page is appended on demand, so the
     * panel never pulls the whole ledger. The host filters and counts, which is
     * why `total` keeps describing the whole result set rather than the page.
     */
    function useHistory(sessionId, active, query, revision, bucket = 'session') {
      const [history, setHistory] = React.useState({ items: [], total: 0, hasMore: false, error: null, loaded: false, loadingMore: false });
      React.useEffect(() => {
        if (!active || sessionId === null) return undefined;
        let cancelled = false;
        setHistory((previous) => ({ ...previous, loaded: false }));
        const load = async () => {
          try {
            const value = await post('list', { sessionId, bucket, scope: 'history', query, limit: PAGE_SIZE, offset: 0 });
            if (!cancelled) {
              setHistory({ items: value.items, total: value.total, hasMore: value.hasMore === true, error: null, loaded: true, loadingMore: false });
            }
          } catch (error) {
            if (!cancelled) setHistory((previous) => ({ ...previous, error: String(error && error.message ? error.message : error), loaded: true, loadingMore: false }));
          }
        };
        void load();
        return () => { cancelled = true; };
      }, [sessionId, active, query, revision, bucket]);

      const loadMore = React.useCallback(async () => {
        if (sessionId === null || history.loadingMore || !history.hasMore) return;
        setHistory((previous) => ({ ...previous, loadingMore: true }));
        try {
          const value = await post('list', { sessionId, bucket, scope: 'history', query, limit: PAGE_SIZE, offset: history.items.length });
          // Append, but trust the host's total: a page can shrink between reads.
          setHistory((previous) => ({
            items: previous.items.concat(value.items),
            total: value.total,
            hasMore: value.hasMore === true,
            error: null,
            loaded: true,
            loadingMore: false,
          }));
        } catch (error) {
          setHistory((previous) => ({ ...previous, loadingMore: false, error: String(error && error.message ? error.message : error) }));
        }
      }, [sessionId, bucket, query, history.items.length, history.loadingMore, history.hasMore]);

      return { ...history, loadMore };
    }

    // ── icons ─────────────────────────────────────────────────────────────
    // Lucide geometries (ISC), inlined: no package, no import, no font glyph.
    // One factory keeps every path single-sourced and every icon on the same
    // 24x24 grid; they render at 16px and take the surrounding text colour.
    const ICON_SHAPES = {
      inbox: [
        { tag: 'polyline', attrs: { points: '22 12 16 12 14 15 10 15 8 12 2 12' } },
        { tag: 'path', attrs: { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' } },
      ],
      x: [
        { tag: 'path', attrs: { d: 'M18 6 6 18' } },
        { tag: 'path', attrs: { d: 'm6 6 12 12' } },
      ],
      check: [
        { tag: 'path', attrs: { d: 'M20 6 9 17l-5-5' } },
      ],
      'arrow-right': [
        { tag: 'path', attrs: { d: 'M5 12h14' } },
        { tag: 'path', attrs: { d: 'm12 5 7 7-7 7' } },
      ],
      search: [
        { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
        { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
      ],
      'arrow-left': [
        { tag: 'path', attrs: { d: 'M19 12H5' } },
        { tag: 'path', attrs: { d: 'm12 19-7-7 7-7' } },
      ],
      archive: [
        { tag: 'rect', attrs: { x: '2', y: '3', width: '20', height: '5', rx: '1' } },
        { tag: 'path', attrs: { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' } },
        { tag: 'path', attrs: { d: 'M10 12h4' } },
      ],
      globe: [
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
        { tag: 'path', attrs: { d: 'M2 12h20' } },
        { tag: 'path', attrs: { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' } },
      ],
    };

    /**
     * Draw one inline Lucide icon.
     * @param name - key in {@link ICON_SHAPES}.
     * @param size - rendered square size in px (default 16).
     * @returns an inline svg vnode, decorative for assistive tech.
     */
    function icon(name, size) {
      const shapes = ICON_SHAPES[name] ?? [];
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size ?? 16,
        height: size ?? 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: '0 0 auto' },
      }, shapes.map((shape, index) => h(shape.tag, { key: name + '-' + index, ...shape.attrs })));
    }

    /** Short stamp for an acknowledged item; history rows carry no button. */
    function formatReadAt(readAt) {
      if (!Number.isFinite(readAt)) return '';
      return new Date(readAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    /** HH:MM, for the compact rows in the drawer's left column. */
    function formatClock(ts) {
      if (!Number.isFinite(ts)) return '';
      return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    /**
     * Gmail's list stamp: today shows HH:MM, anything older shows MM/DD.
     * @param ts - epoch millis.
     * @returns the compact right-hand label.
     */
    function formatListTime(ts) {
      if (!Number.isFinite(ts)) return '';
      const date = new Date(ts);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      const two = (value) => String(value).padStart(2, '0');
      return sameDay ? two(date.getHours()) + ':' + two(date.getMinutes()) : two(date.getMonth() + 1) + '/' + two(date.getDate());
    }

    /** Kind badges shared by rows, the detail head and the toast card. */
    function kindLabel(kind) {
      if (kind === 'risk') return '风险';
      if (kind === 'decision') return '待决定';
      if (kind === 'handoff') return '交接';
      return '备注';
    }

    // Inline style cannot express :hover or the selected-row accent bar, so one
    // namespaced stylesheet is injected on mount and removed on unmount. Every
    // selector is prefixed lbx- so two hosts (or two reloads) cannot collide.
    // The resting background stays inline so the first paint is already correct;
    // the hover/selected backgrounds are !important because an inline background
    // would otherwise win and those states could never paint.

    // Inline style cannot express :hover, the open-card accent bar, or the
    // collapse transition, so one namespaced stylesheet is injected on mount and
    // removed on unmount. Every selector is prefixed lbx- so two hosts (or two
    // reloads) cannot collide; hover/open states use !important because the
    // inline resting values would otherwise win.

    // Inline style cannot express :hover, the hover-revealed row action, or the
    // list↔detail fade, so one namespaced stylesheet is injected on mount and
    // removed on unmount. Every selector is prefixed lbx- so two hosts (or two
    // reloads) cannot collide; hover states use !important because the inline
    // resting values would otherwise win.

    // Inline style cannot express :hover, the hover-revealed row action, the
    // label hover, or the responsive label bar, so one namespaced stylesheet is
    // injected on mount and removed on unmount. Every selector is prefixed lbx-.
    const STYLE_TEXT = [
      '.lbx-ghost,.lbx-row,.lbx-navitem{transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease,color 120ms ease}',
      '.lbx-ghost:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.10))!important}',
      '.lbx-row:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.08))!important}',
      '.lbx-ghost:focus-visible,.lbx-row:focus-visible,.lbx-navitem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:-1px}',
      '.lbx-rowact{opacity:0;transition:opacity 120ms ease}',
      '.lbx-row:hover .lbx-rowact,.lbx-rowact:focus-visible{opacity:1}',
      '.lbx-navlist{display:flex;flex-direction:column;gap:1px;width:176px;flex:0 0 176px;padding:8px 6px;border-right:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,0.08));box-sizing:border-box;overflow-y:auto}',
      '.lbx-navitem{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:inherit;font-size:12.5px;cursor:pointer;text-align:left;box-sizing:border-box}',
      '.lbx-navitem:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.10))!important}',
      '.lbx-navitem[data-active="true"]{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.14))!important;font-weight:600}',
      '.lbx-view{animation:lbx-fade-in 120ms ease both}',
      '@keyframes lbx-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '@media (max-width: 719px){.lbx-shell{flex-direction:column}.lbx-navlist{flex-direction:row;flex-wrap:wrap;width:auto;flex:0 0 auto;border-right:none;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,0.08));padding:6px;overflow:visible}.lbx-navitem{width:auto;flex:0 0 auto}.lbx-divider{display:none}}',
      '@media (prefers-reduced-motion: reduce){.lbx-view{animation:none}.lbx-rowact{transition:none}.lbx-ghost,.lbx-row,.lbx-navitem{transition:none}}',
    ].join(String.fromCharCode(10));

    const styles = {
      // ── page shell ───────────────────────────────────────────────────────
      // The panel page fills the whole main column: the old 720px centred box left
      // half the layout empty once the label rail moved inside it.
      page: {
        display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0,
        padding: '16px 24px', boxSizing: 'border-box', color: 'inherit',
      },
      pageInner: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' },
      topBar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 10px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      title: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 },
      headCount: { fontSize: 12, opacity: 0.62 },
      spacer: { flex: 1 },
      close: {
        width: 26, height: 26, padding: 0, border: 'none', borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },

      // ── label rail + main column ─────────────────────────────────────────
      shell: { display: 'flex', flex: 1, minHeight: 0 },
      navGroup: { fontSize: 10.5, opacity: 0.55, padding: '6px 8px 2px', letterSpacing: '0.02em' },
      navDivider: { height: 1, margin: '6px 8px', background: 'var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))' },
      navText: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      navCount: { fontSize: 11, opacity: 0.6, marginLeft: 4 },
      main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 },

      // ── list toolbar ─────────────────────────────────────────────────────
      toolbar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.06))',
      },
      toolbarLabel: { fontSize: 12, fontWeight: 500 },
      toolbarCount: { fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap' },
      toolbarBtn: { border: 'none', background: 'transparent', color: 'inherit', fontSize: 12, padding: '2px 4px', borderRadius: 4, cursor: 'pointer' },
      toolbarDot: { fontSize: 12, opacity: 0.4 },
      selectBar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px',
        background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.10))',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      selectText: { fontSize: 12, fontWeight: 500 },

      // ── search (history only) ────────────────────────────────────────────
      searchRow: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px' },
      searchWrap: { position: 'relative', flex: 1, minWidth: 0 },
      searchIcon: { position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.55, pointerEvents: 'none', display: 'inline-flex' },
      search: {
        width: '100%', boxSizing: 'border-box', height: 32, padding: '8px 8px 8px 30px', borderRadius: 8, fontSize: 12,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.14))',
        background: 'transparent', color: 'inherit', outline: 'none',
      },

      // ── list ─────────────────────────────────────────────────────────────
      listScroll: { flex: 1, minHeight: 0, overflowY: 'auto' },
      list: { display: 'flex', flexDirection: 'column' },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
        minHeight: 44, padding: '6px 16px', border: 'none', borderRadius: 0, textAlign: 'left',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.06))',
      },
      rowCheck: { width: 13, height: 13, margin: 0, flex: '0 0 auto', cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary, #4c8dff)' },
      dot: { width: 6, height: 6, flex: '0 0 6px', borderRadius: '50%', background: 'var(--dsw-alias-brand-primary, #4c8dff)' },
      dotEmpty: { width: 6, height: 6, flex: '0 0 6px' },
      kindBadge: { flex: '0 0 auto', fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,0.16))', color: 'inherit' },
      kindBadgeWarn: { flex: '0 0 auto', fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,0.16))', color: 'var(--dsw-alias-text-warning, #b26a00)' },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
      subject: { fontSize: 13, fontWeight: 600, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      subjectRead: { fontSize: 13, fontWeight: 400, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85 },
      snippet: { fontSize: 12, opacity: 0.6, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      time: { flex: '0 0 auto', fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', marginLeft: 4 },
      rowAction: {
        flex: '0 0 auto', width: 24, height: 24, padding: 0, border: 'none', borderRadius: 4,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },

      // ── detail view ──────────────────────────────────────────────────────
      detailView: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
      detailBar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 8px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      back: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 8px', borderRadius: 6,
        border: 'none', background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer',
      },
      iconBtn: {
        width: 26, height: 26, padding: 0, borderRadius: 6, border: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      detailScroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px 20px' },
      detailTitleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
      prioDot: { width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-text-warning, #b26a00)', display: 'inline-block' },
      detailTime: { marginLeft: 'auto', fontSize: 11, opacity: 0.6 },
      detailText: {
        fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text',
        maxWidth: '72ch',
      },
      fields: { marginTop: 14, display: 'grid', gridTemplateColumns: '56px 1fr', columnGap: 8, rowGap: 6, alignItems: 'baseline' },
      fieldLabel: { fontSize: 11, opacity: 0.55 },
      fieldValue: { fontSize: 12, opacity: 0.75, minWidth: 0, wordBreak: 'break-word' },

      // ── pager ────────────────────────────────────────────────────────────
      pagerBar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      pagerText: { fontSize: 11.5, opacity: 0.62 },
      more: { fontSize: 12, padding: '4px 10px', border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' },

      // ── empty state ──────────────────────────────────────────────────────
      empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '40px 24px', textAlign: 'center' },
      emptyIcon: { opacity: 0.3, marginBottom: 4, display: 'inline-flex' },
      emptyTitle: { fontSize: 13, fontWeight: 500 },
      emptyHint: { fontSize: 12, opacity: 0.6, lineHeight: 1.5 },

      // ── toast card ───────────────────────────────────────────────────────
      toast: {
        position: 'fixed', left: 20, right: 'auto', bottom: 132, width: 300, zIndex: 1010, pointerEvents: 'auto',
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
        background: 'var(--dsw-alias-bg-primary, #ffffff)', color: 'inherit', fontSize: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)', cursor: 'pointer',
      },
      toastHead: { display: 'flex', alignItems: 'center', gap: 6 },
      toastText: {
        lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      toastFoot: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 },
    };

    /**
     * One page of a bucket's items, newest first.
     *
     * Gmail-style paging needs both directions and an exact window, so the host
     * is asked for limit/offset instead of the whole ledger; reload re-runs the
     * same window after an acknowledgement.
     */
    function usePagedList(sessionId, bucket, scope, query, active, revision) {
      const [offset, setOffset] = React.useState(0);
      const [nonce, setNonce] = React.useState(0);
      const [page, setPage] = React.useState({ items: [], total: 0, offset: 0, limit: PAGE_SIZE, hasMore: false, error: null, loaded: false });
      const reset = bucket + '|' + scope + '|' + query;
      React.useEffect(() => { setOffset(0); }, [reset]);
      React.useEffect(() => {
        if (!active || sessionId === null) return undefined;
        let cancelled = false;
        setPage((previous) => ({ ...previous, loaded: false }));
        const load = async () => {
          try {
            const value = await post('list', { sessionId, bucket, scope, query, limit: PAGE_SIZE, offset });
            if (!cancelled) setPage({ items: value.items, total: value.total, offset: value.offset, limit: value.limit, hasMore: value.hasMore === true, error: null, loaded: true });
          } catch (error) {
            if (!cancelled) setPage((previous) => ({ ...previous, error: String(error && error.message ? error.message : error), loaded: true }));
          }
        };
        void load();
        return () => { cancelled = true; };
      }, [sessionId, bucket, scope, query, offset, active, revision, nonce]);
      const reload = React.useCallback(() => setNonce((value) => value + 1), []);
      return { ...page, setOffset, reload };
    }
    /**
     * The inbox page, mounted in the layout's keyed main slot. One header, one
     * label rail, one Gmail-style list with an in-place detail view.
     */
    function InboxPanel({ sessions }) {
      const sessionId = useSessionId(sessions);
      // One label drives box and view together, like a mail label rail.
      const [labelId, setLabelId] = React.useState('session:unread');
      const [bucket, tab] = labelId.split(':');
      const ledger = useLedger(sessionId, 'session', true);
      const globalLedger = useLedger(sessionId, 'global', bucket === 'global');
      const active = bucket === 'global' ? globalLedger : ledger;
      const [query, setQuery] = React.useState('');
      const [selectedId, setSelectedId] = React.useState(null);
      const [checked, setChecked] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const searched = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
      const list = usePagedList(sessionId, bucket, tab === 'history' ? 'history' : 'unread', tab === 'history' ? searched : '', true, active.unreadCount);

      // The list is unmounted while the detail view is open, so its scroll offset
      // lives in a ref and is written back the moment the list returns.
      const listScroll = React.useRef(0);
      const listRef = React.useRef(null);

      // Put the reader back where they left the list.
      React.useEffect(() => {
        if (selectedId !== null) return;
        const node = listRef.current;
        if (node !== null) node.scrollTop = listScroll.current;
      }, [selectedId, list.items]);

      // Hover states, the row action and the view fade live in one injected sheet.
      React.useEffect(() => {
        if (typeof document === 'undefined' || document.head === null || typeof document.createElement !== 'function') return undefined;
        const sheet = document.createElement('style');
        sheet.setAttribute('data-letterbox-styles', 'true');
        sheet.textContent = STYLE_TEXT;
        document.head.appendChild(sheet);
        return () => { if (sheet.parentNode !== null) sheet.parentNode.removeChild(sheet); };
      }, []);

      if (sessionId === null) return null;

      const sessionUnread = ledger.unreadCount;
      const globalUnread = ledger.globalUnreadCount;
      const items = list.items;
      const detailItem = selectedId === null ? null : (items.find((item) => item.id === selectedId) ?? null);
      const loading = !list.loaded;

      React.useEffect(() => {
        if (selectedId === null || !list.loaded || detailItem !== null) return;
        setSelectedId(null);
      }, [selectedId, list.loaded, detailItem]);

      const openItem = (id) => {
        const node = listRef.current;
        listScroll.current = node === null ? 0 : node.scrollTop;
        setSelectedId(id);
      };
      const pickLabel = (next) => { setLabelId(next); setSelectedId(null); setChecked([]); setQuery(''); };
      const toggleCheck = (id) => setChecked((current) => (current.includes(id) ? current.filter((value) => value !== id) : current.concat([id])));
      const pageSize = list.limit || PAGE_SIZE;
      const gotoNewer = () => { setSelectedId(null); setChecked([]); list.setOffset(Math.max(0, list.offset - pageSize)); };
      const gotoOlder = () => { if (!list.hasMore) return; setSelectedId(null); setChecked([]); list.setOffset(list.offset + pageSize); };

      // One acknowledged note per call, one call at a time: a failure is swallowed
      // so the remaining notes still get acknowledged.
      const markIds = async (ids) => {
        if (busy || ids.length === 0) return;
        setBusy(true);
        for (const id of ids) {
          try { await active.markRead(id); } catch { /* keep going */ }
        }
        setBusy(false);
        setChecked([]);
        list.reload();
      };

      const firstLine = (text) => {
        const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '');
        return line === undefined ? text.trim() : line;
      };
      const snippet = (text) => {
        const lines = text.split('\n').map((part) => part.trim()).filter((part) => part !== '');
        return lines.length > 1 ? lines.slice(1).join(' ') : '';
      };

      const field = (name, value) => h(React.Fragment, { key: 'field-' + name },
        h('span', { style: styles.fieldLabel }, name),
        h('span', { style: styles.fieldValue }, value),
      );

      const badge = (item) => h('span', { style: item.priority === 'high' ? styles.kindBadgeWarn : styles.kindBadge }, kindLabel(item.kind));

      const row = (item) => {
        const isChecked = checked.includes(item.id);
        const preview = snippet(item.text);
        return h('div', {
          key: item.id,
          className: 'lbx-row',
          style: styles.row,
          role: 'button',
          tabIndex: 0,
          'aria-label': firstLine(item.text),
          onClick: () => openItem(item.id),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            openItem(item.id);
          },
        },
          h('input', {
            type: 'checkbox',
            className: 'lbx-check',
            style: styles.rowCheck,
            checked: isChecked,
            'aria-label': '选择这条',
            onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); },
            onChange: () => toggleCheck(item.id),
          }),
          item.read ? h('span', { style: styles.dotEmpty, 'aria-hidden': true }) : h('span', { style: styles.dot, 'aria-hidden': true }),
          badge(item),
          h('div', { style: styles.rowMain },
            h('div', { style: item.read ? styles.subjectRead : styles.subject }, firstLine(item.text)),
            preview === '' ? null : h('div', { style: styles.snippet }, preview),
          ),
          h('span', { style: styles.time }, formatListTime(tab === 'history' && item.readAt ? item.readAt : item.createdAt)),
          item.read
            ? null
            : h('button', {
              type: 'button',
              className: 'lbx-ghost lbx-rowact',
              style: styles.rowAction,
              'aria-label': '标记为已读',
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                void markIds([item.id]);
              },
            }, icon('check', 14)),
        );
      };


      const navItem = (id, iconName, text, count) => h('button', {
        key: id,
        type: 'button',
        className: 'lbx-navitem',
        'data-active': labelId === id ? 'true' : 'false',
        'aria-current': labelId === id ? 'page' : undefined,
        onClick: () => pickLabel(id),
      },
        icon(iconName, 16),
        h('span', { style: styles.navText }, text),
        count > 0 ? h('span', { style: styles.navCount }, String(count)) : null,
      );

      // Gmail's shape: a label rail on the left, one toolbar over the list. The
      // two segmented controls this replaced lived inside the header and made the
      // page read as a settings form rather than a mailbox.
      const navList = h('div', { className: 'lbx-navlist' },
        h('div', { style: styles.navGroup }, '会话'),
        navItem('session:unread', 'inbox', '未读', sessionUnread),
        navItem('session:history', 'archive', '历史', 0),
        h('div', { className: 'lbx-divider', style: styles.navDivider }),
        h('div', { style: styles.navGroup }, '全局'),
        navItem('global:unread', 'globe', '未读', globalUnread),
        navItem('global:history', 'archive', '历史', 0),
      );

      const labelName = (bucket === 'global' ? '全局' : '会话') + ' · ' + (tab === 'history' ? '历史' : '未读');

      const topBar = (withClose) => h('div', { style: styles.topBar },
        h('span', { style: styles.title }, '收件箱'),
        h('span', { style: styles.headCount }, sessionUnread > 0 ? sessionUnread + ' 条未读' : '全部已读'),
        h('span', { style: styles.spacer }),
        withClose
          ? h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.close,
            onClick: () => setOpen(false),
            'aria-label': '关闭收件箱',
          }, icon('x'))
          : null,
      );

      const allChecked = items.length > 0 && items.every((item) => checked.includes(item.id));
      const range = list.total === 0 ? '0 / 0' : (list.offset + 1) + '–' + (list.offset + items.length) + ' / ' + list.total;

      // The one counting line in the toolbar; the pager keeps the verbose form.
      const listToolbar = h('div', { style: styles.toolbar },
        h('input', {
          type: 'checkbox',
          style: styles.rowCheck,
          checked: allChecked,
          'aria-label': '全选本页',
          onChange: () => setChecked(allChecked ? [] : items.map((item) => item.id)),
        }),
        h('span', { style: styles.toolbarLabel }, labelName),
        h('span', { style: styles.spacer }),
        h('span', { style: styles.toolbarCount }, list.loaded ? range : '读取中…'),
      );

      const searchRow = tab === 'history' ? h('div', { style: styles.searchRow },
        h('div', { style: styles.searchWrap },
          h('span', { style: styles.searchIcon }, icon('search')),
          h('input', {
            type: 'search',
            value: query,
            placeholder: '搜索已读：正文 / 来源 / 类型',
            'aria-label': '搜索历史条目',
            style: styles.search,
            onChange: (event) => { setQuery(event.target.value); setSelectedId(null); setChecked([]); },
          }),
        ),
      ) : null;

      const selectBar = checked.length === 0 ? null : h('div', { style: styles.selectBar },
        h('span', { style: styles.selectText }, '已选 ' + checked.length + ' 项'),
        h('span', { style: styles.toolbarDot }, '·'),
        h('button', {
          type: 'button',
          className: 'lbx-ghost',
          style: styles.toolbarBtn,
          disabled: busy === true,
          onClick: () => void markIds(checked),
        }, busy ? '标记中…' : '标记为已读'),
        h('span', { style: styles.toolbarDot }, '·'),
        h('button', { type: 'button', className: 'lbx-ghost', style: styles.toolbarBtn, onClick: () => setChecked([]) }, '取消选择'),
      );

      const emptyBlock = (title, hint) => h('div', { style: styles.empty },
        h('span', { style: styles.emptyIcon }, icon('inbox', 32)),
        h('div', { style: styles.emptyTitle }, title),
        hint === null ? null : h('div', { style: styles.emptyHint }, hint),
      );

      const empty = () => {
        if (loading) return emptyBlock('读取中…', null);
        if (list.error !== null) return emptyBlock('收件箱读取失败', String(list.error));
        if (tab === 'history') {
          if (searched !== '') return emptyBlock('没有匹配的历史', '换个关键词再试');
          return bucket === 'global'
            ? emptyBlock('全局没有历史', '跨会话的条目会收在这里')
            : emptyBlock('还没有历史', '标记为已读的条目会收在这里');
        }
        return bucket === 'global'
          ? emptyBlock('全局没有未读', '跨会话的条目会出现在这里')
          : emptyBlock('没有未读', '新条目会出现在这里');
      };

      const pager = items.length === 0 ? null : h('div', { style: styles.pagerBar },
        h('button', {
          type: 'button',
          className: 'lbx-ghost',
          style: styles.more,
          disabled: list.offset === 0,
          onClick: gotoNewer,
        }, '较新'),
        h('span', { style: styles.pagerText }, list.total === 0
          ? '共 0 条'
          : '第 ' + (list.offset + 1) + '–' + (list.offset + items.length) + ' 条，共 ' + list.total + ' 条'),
        h('button', {
          type: 'button',
          className: 'lbx-ghost',
          style: styles.more,
          disabled: list.hasMore !== true,
          onClick: gotoOlder,
        }, '较旧'),
      );

      const listView = h(React.Fragment, null,
        listToolbar,
        searchRow,
        selectBar,
        items.length === 0
          ? empty()
          : h('div', { ref: listRef, style: styles.listScroll },
            h('div', { style: styles.list }, items.map(row)),
          ),
        pager,
      );

      const index = detailItem === null ? -1 : items.findIndex((item) => item.id === detailItem.id);
      const previous = index > 0 ? items[index - 1] : null;
      const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;
      const detailView = detailItem === null ? null : h('div', { className: 'lbx-view', style: styles.detailView },
        h('div', { style: styles.detailBar },
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.back,
            onClick: () => setSelectedId(null),
            'aria-label': '返回列表',
          }, icon('arrow-left', 14), h('span', null, '返回')),
          h('span', { style: styles.spacer }),
          detailItem.read
            ? null
            : h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: styles.iconBtn,
              'aria-label': '标记为已读',
              title: '标记为已读',
              onClick: () => void markIds([detailItem.id]),
            }, icon('check', 15)),
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.more,
            disabled: previous === null,
            onClick: () => { if (previous !== null) setSelectedId(previous.id); },
          }, '上一封'),
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.more,
            disabled: next === null,
            onClick: () => { if (next !== null) setSelectedId(next.id); },
          }, '下一封'),
        ),
        h('div', { style: styles.detailScroll },
          h('div', { style: styles.detailTitleRow },
            badge(detailItem),
            detailItem.priority === 'high' ? h('span', { style: styles.prioDot, 'aria-hidden': true }) : null,
            h('span', { style: styles.detailTime }, formatReadAt(detailItem.createdAt)),
          ),
          h('div', { style: styles.detailText }, detailItem.text),
          h('div', { style: styles.fields },
            field('类型', kindLabel(detailItem.kind)),
            field('优先级', detailItem.priority === 'high' ? 'high' : 'normal'),
            field('来源', detailItem.source === null ? '—' : detailItem.source),
            field('创建', formatReadAt(detailItem.createdAt)),
            detailItem.read ? field('已读', formatReadAt(detailItem.readAt)) : field('已读', '未读'),
          ),
        ),
      );

      const mainColumn = h('div', { style: styles.main }, detailItem === null ? listView : detailView);
      const shell = h('div', { className: 'lbx-shell', style: styles.shell }, navList, mainColumn);
      return h('div', { style: styles.page }, h('div', { style: styles.pageInner }, topBar(), shell));
    }

    /** Stable panel id: the sidebar row's id must equal the main slot's key. */
    const PANEL_ID = 'letterbox';
    /** Sits between 自动化任务 (10) and 健康提醒 (40) in the nav column. */
    const PANEL_ORDER = 30;

    /**
     * Sidebar glyph. The sidebar owns the button and passes its own size
     * (16 expanded, 18 collapsed); it resolves the label from our metadata.
     */
    function InboxGlyph(props) {
      return icon('inbox', props?.size ?? 16);
    }

    /**
     * Always-mounted host in the composer dock: it polls the session box and
     * renders nothing unless a note arrives, so the toolbar keeps its height.
     * The card is portalled to <body> so no ancestor transform can trap it.
     */
    function InboxToastHost({ sessions, layout }) {
      const sessionId = useSessionId(sessions);
      const ledger = useLedger(sessionId, 'session', true);
      const [toast, setToast] = React.useState(null);
      const [toastPaused, setToastPaused] = React.useState(false);

      const [portalHost, setPortalHost] = React.useState(null);
      React.useEffect(() => {
        if (typeof document === 'undefined' || document.body === null || typeof document.createElement !== 'function') return undefined;
        const host = document.createElement('div');
        host.id = 'lbx-portal';
        host.setAttribute('data-letterbox-portal', 'true');
        host.style.position = 'fixed';
        host.style.inset = '0';
        host.style.pointerEvents = 'none';
        // Non-zero on purpose: a z-index of 0 makes this host a stacking context
        // at level 0, so another plugin's own overlay can paint over the card.
        host.style.zIndex = '999';
        document.body.appendChild(host);
        setPortalHost(host);
        return () => {
          setPortalHost(null);
          if (typeof host.remove === 'function') host.remove();
          else if (host.parentNode !== null) host.parentNode.removeChild(host);
        };
      }, []);

      // Only a note that arrived while the human was already looking counts. The
      // first loaded snapshot merely primes the baseline, so a window reload never
      // replays old notes as news; a read that uncovers an older note fails the
      // createdAt test and never pops a card either.
      const primed = React.useRef(false);
      const latestUnread = React.useRef(null);
      React.useEffect(() => {
        if (!ledger.loaded) return;
        const newest = ledger.items.find((item) => !item.read) ?? null;
        const snapshot = newest === null ? null : { id: newest.id, createdAt: newest.createdAt };
        if (!primed.current) {
          primed.current = true;
          latestUnread.current = snapshot;
          return;
        }
        const previous = latestUnread.current;
        latestUnread.current = snapshot;
        if (snapshot === null) return;
        if (previous !== null && snapshot.id === previous.id) return;
        if (previous !== null && !(snapshot.createdAt > previous.createdAt)) return;
        setToast({ id: snapshot.id, item: newest });
        setToastPaused(false);
      }, [ledger.loaded, ledger.items]);

      // Eight seconds on screen, paused while the pointer rests on the card and
      // resumed with the leftover time instead of a fresh countdown.
      const remaining = React.useRef(TOAST_MS);
      const toastKey = React.useRef(null);
      React.useEffect(() => {
        if (toast === null) {
          remaining.current = TOAST_MS;
          toastKey.current = null;
          return undefined;
        }
        if (toastKey.current !== toast.id) {
          toastKey.current = toast.id;
          remaining.current = TOAST_MS;
        }
        if (toastPaused) return undefined;
        const startedAt = Date.now();
        const timer = setTimeout(() => setToast(null), Math.max(remaining.current, 0));
        return () => {
          clearTimeout(timer);
          remaining.current = Math.max(remaining.current - (Date.now() - startedAt), 0);
        };
      }, [toast, toastPaused]);

      if (sessionId === null || toast === null) return null;

      // The layout service is the cross-plugin panel face; when it is missing the
      // card still carries the text, so clicking it just dismisses.
      const openInbox = () => {
        setToast(null);
        try {
          if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
        } catch {
          /* the main panel is not registered yet; the card already said its piece */
        }
      };

      const card = h('div', {
        style: styles.toast,
        role: 'status',
        onClick: openInbox,
        onMouseEnter: () => setToastPaused(true),
        onMouseLeave: () => setToastPaused(false),
      },
        h('div', { style: styles.toastHead },
          h('span', { style: toast.item.priority === 'high' ? styles.kindBadgeWarn : styles.kindBadge }, kindLabel(toast.item.kind)),
          h('span', { style: styles.time }, '新条目'),
        ),
        h('div', { style: styles.toastText }, toast.item.text),
        h('div', { style: styles.toastFoot },
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.more,
            onClick: (event) => {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
              openInbox();
            },
          }, icon('arrow-right'), h('span', null, '查看')),
        ),
      );

      return portalHost === null ? null : ReactDOM.createPortal(card, portalHost);
    }

    return {
      inject: ['slots', 'sessions', 'layout'],
      apply(ctx) {
        const sessions = ctx.get('sessions').list;
        const layout = ctx.get('layout') ?? null;
        // No drawer any more: this seat is only the toast host, and it renders
        // null unless a card is due. The registration is what keeps the ledger
        // polling while the page is open.
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-letterbox',
          order: 60,
          inject: () => ({ sessions, layout }),
        }, InboxToastHost)), 'letterbox: toast host');
        // The sidebar row only selects a main panel: layout.selectPanel throws
        // unless a main entry with this key is registered, so both go together.
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: '收件箱',
        }, InboxGlyph)), 'letterbox: sidebar row');
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ sessions }),
        }, InboxPanel)), 'letterbox: main panel');
      },
    };
  },
});
