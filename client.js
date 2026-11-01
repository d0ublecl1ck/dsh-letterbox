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
    const STYLE_TEXT = [
      '.lbx-dockbtn,.lbx-ghost,.lbx-row,.lbx-tab{transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease,color 120ms ease}',
      '.lbx-dockbtn:hover,.lbx-ghost:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.10))!important}',
      '.lbx-row:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.10))!important}',
      '.lbx-row[data-active="true"]{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,0.12))!important;box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4c8dff)}',
      '.lbx-dockbtn:focus-visible,.lbx-ghost:focus-visible,.lbx-row:focus-visible,.lbx-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
    ].join(String.fromCharCode(10));

    const styles = {
      // ── entry: 28px icon button inside the composer toolbar ──────────────
      // In flow, right-aligned: it is covered by the scrim when the drawer is
      // open, which is intended (the scrim/Esc close it), so it needs no z-index.
      dock: { display: 'flex', justifyContent: 'flex-end', padding: '2px 12px' },
      dockBtn: {
        position: 'relative', width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'inherit', cursor: 'pointer', userSelect: 'none',
      },
      dockBadge: {
        position: 'absolute', top: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px',
        borderRadius: 999, background: 'var(--dsw-alias-brand-primary, #4c8dff)',
        color: '#ffffff', fontSize: 10, lineHeight: '14px', fontWeight: 600, textAlign: 'center',
      },
      warnDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-text-warning, #b26a00)', display: 'inline-block' },

      // ── scrim + drawer shell ─────────────────────────────────────────────
      scrim: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 990, background: 'transparent', pointerEvents: 'auto' },
      panel: {
        // Anchored to the left edge; the shadow and the divider both point right.
        position: 'fixed', top: 0, left: 0, right: 'auto', bottom: 0, zIndex: 1000, pointerEvents: 'auto',
        width: 'min(560px, calc(100vw - 40px))',
        display: 'flex', flexDirection: 'column', color: 'inherit',
        background: 'var(--dsw-alias-bg-primary, #ffffff)',
        borderRight: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
        borderLeft: 'none',
        boxShadow: '12px 0 32px rgba(0,0,0,0.10)',
      },
      panelHead: {
        flex: '0 0 48px', height: 48, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      panelTitle: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 },
      headCount: { fontSize: 12, opacity: 0.62 },
      close: {
        marginLeft: 'auto', width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      left: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 10px 8px', minHeight: 0,
        borderRight: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },

      // ── segmented tabs ───────────────────────────────────────────────────
      segment: { display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.10))' },
      tab: {
        flex: 1, height: 26, padding: 0, border: 'none', borderRadius: 6, lineHeight: '26px',
        background: 'transparent', color: 'inherit', opacity: 0.62, fontSize: 12, cursor: 'pointer',
      },
      tabActive: {
        flex: 1, height: 26, padding: 0, border: 'none', borderRadius: 6, lineHeight: '26px',
        background: 'var(--dsw-alias-bg-primary, #ffffff)', color: 'inherit', opacity: 1,
        fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
      },

      // ── history search ───────────────────────────────────────────────────
      searchWrap: { position: 'relative' },
      searchIcon: { position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.55, pointerEvents: 'none' },
      search: {
        width: '100%', boxSizing: 'border-box', height: 32, fontSize: 12, padding: '8px 8px 8px 30px',
        borderRadius: 8, border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
        background: 'transparent', color: 'inherit',
      },

      // ── list ─────────────────────────────────────────────────────────────
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 2 },
      row: {
        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8,
        border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      rowTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 },
      badge: {
        fontSize: 10.5, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,0.16))', color: 'inherit',
      },
      badgeWarn: {
        fontSize: 10.5, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,0.16))',
        color: 'var(--dsw-alias-text-warning, #b26a00)',
      },
      rowTime: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      rowTitle: {
        marginTop: 2, fontSize: 12.5, fontWeight: 500, lineHeight: 1.45,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      rowSource: { marginTop: 2, fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

      // ── pagination ───────────────────────────────────────────────────────
      pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, fontSize: 12, opacity: 0.7 },
      pagerCount: { marginRight: 'auto', fontSize: 12, opacity: 0.62 },
      more: { fontSize: 12, padding: '2px 6px', border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' },

      // ── right column ─────────────────────────────────────────────────────
      right: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', overflowY: 'auto' },
      detailHead: { display: 'flex', alignItems: 'center', gap: 8 },
      detailTitle: { fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
      detailText: { fontSize: 13, lineHeight: 1.65, maxWidth: '60ch', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      fields: { display: 'grid', gridTemplateColumns: '56px 1fr', columnGap: 8, rowGap: 6, alignItems: 'baseline' },
      fieldLabel: { fontSize: 11, opacity: 0.62 },
      fieldValue: { fontSize: 12.5, minWidth: 0, wordBreak: 'break-word' },
      action: {
        alignSelf: 'flex-start', height: 30, display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0 14px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', color: 'inherit',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.18))', background: 'transparent',
      },
      // ── sidebar panel page (layout "main" slot) ─────────────────────────
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'inherit' },
      pageHead: {
        flex: '0 0 44px', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },
      empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '24px 0', fontSize: 12.5, opacity: 0.7 },
      emptyIcon: { opacity: 0.5 },

      // ── toast card ───────────────────────────────────────────────────────
      toast: {
        position: 'fixed', left: 20, right: 'auto', bottom: 132, width: 300, zIndex: 1010, pointerEvents: 'auto',
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
        background: 'var(--dsw-alias-bg-primary, #ffffff)', color: 'inherit', fontSize: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)', cursor: 'pointer',
      },
      toastHead: { display: 'flex', alignItems: 'center', gap: 6 },
      toastText: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.45 },
      toastFoot: { display: 'flex', justifyContent: 'flex-end' },
    };

    /** Viewport width, so the drawer can pick its narrow geometry once. */
    function useViewportWidth() {
      const read = () => (typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280);
      const [width, setWidth] = React.useState(read);
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onResize = () => setWidth(read());
        window.addEventListener('resize', onResize);
        return () => { window.removeEventListener('resize', onResize); };
      }, []);
      return width;
    }

    /**
     * The inbox UI. `variant` picks the surface: `dock` is the composer button
     * plus the portalled drawer/card, `panel` is the page mounted in the
     * layout's keyed `main` slot when the sidebar entry is selected.
     */
    function LetterboxDock({ sessions, variant = 'dock' }) {
      const isDock = variant !== 'panel';
      const sessionId = useSessionId(sessions);
      const [bucket, setBucket] = React.useState('session');
      const [open, setOpen] = React.useState(false);
      // The session box is always polled: the entry button's count is session-only.
      const ledger = useLedger(sessionId, 'session', true);
      const globalLedger = useLedger(sessionId, 'global', (open || !isDock) && bucket === 'global');
      const active = bucket === 'global' ? globalLedger : ledger;
      const [tab, setTab] = React.useState('unread');
      const [query, setQuery] = React.useState('');
      const [selectedId, setSelectedId] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [toastPaused, setToastPaused] = React.useState(false);
      const searched = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
      const history = useHistory(sessionId, (open || !isDock) && tab === 'history', searched, active.unreadCount, bucket);
      const viewport = useViewportWidth();

      // One portal host for every floating layer, created on mount and removed on
      // unmount. pointer-events stays off on the host so it can never swallow a
      // click meant for the conversation; each child turns it back on.
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
        // at level 0, so another plugin's own overlay (e.g. a full-screen veil)
        // can paint over our drawer even though our layers are 990+.
        host.style.zIndex = '999';
        document.body.appendChild(host);
        setPortalHost(host);
        return () => {
          setPortalHost(null);
          if (typeof host.remove === 'function') host.remove();
          else if (host.parentNode !== null) host.parentNode.removeChild(host);
        };
      }, []);

      // ── when a card may appear ───────────────────────────────────────────
      // Only a note that arrived while the human was already looking counts.
      // The first loaded snapshot merely primes the baseline, so a window reload
      // never replays old notes as news; a read that merely uncovers an older
      // unread note fails the createdAt test, so it never pops a card either.
      const primed = React.useRef(false);
      const latestUnread = React.useRef(null);
      const openRef = React.useRef(open);
      openRef.current = open;
      React.useEffect(() => {
        if (!isDock || !ledger.loaded) return;
        const newest = ledger.items.find((item) => !item.read) ?? null;
        const snapshot = newest === null ? null : { id: newest.id, createdAt: newest.createdAt };
        if (!primed.current) {
          primed.current = true;
          latestUnread.current = snapshot;
          return;
        }
        const previous = latestUnread.current;
        latestUnread.current = snapshot;
        if (snapshot === null || openRef.current) return;
        if (previous !== null && snapshot.id === previous.id) return;
        if (previous !== null && !(snapshot.createdAt > previous.createdAt)) return;
        setToast({ id: snapshot.id, item: newest });
        setToastPaused(false);
      }, [isDock, ledger.loaded, ledger.items]);

      // Eight seconds on screen, paused while the pointer rests on the card and
      // resumed with the leftover time instead of a fresh countdown.
      const remaining = React.useRef(TOAST_MS);
      const toastKey = React.useRef(null);
      React.useEffect(() => {
        if (!isDock) return undefined;
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
      }, [isDock, toast, toastPaused]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [open]);

      // Opening the drawer with nothing selected picks the top row of the tab.
      React.useEffect(() => {
        if ((isDock && !open) || selectedId !== null) return;
        const list = tab === 'history' ? history.items : active.items.filter((item) => !item.read);
        if (list.length > 0) setSelectedId(list[0].id);
      }, [isDock, open, selectedId, tab, active.items, history.items]);

      // Hover states and the selected-row accent bar live in one injected sheet.
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
      const unread = active.unreadCount;
      const unreadItems = active.items.filter((item) => !item.read);
      const selected = selectedId === null
        ? null
        : (active.items.find((item) => item.id === selectedId) ?? history.items.find((item) => item.id === selectedId) ?? null);
      const narrow = Math.min(560, viewport - 40) < 520;
      const leftWidth = narrow ? 200 : 240;

      const openPanel = (id) => {
        setOpen(true);
        setToast(null);
        if (typeof id === 'string' && id !== '') setSelectedId(id);
      };
      const switchTab = (next) => {
        setTab(next);
        setSelectedId(null);
      };
      const switchBucket = (next) => {
        setBucket(next);
        setSelectedId(null);
        setQuery('');
      };
      const emptyBlock = (iconName, text) => h('div', { style: styles.empty },
        h('span', { style: styles.emptyIcon }, icon(iconName, 20)),
        h('span', null, text),
      );
      const field = (name, value) => h(React.Fragment, { key: 'field-' + name },
        h('span', { style: styles.fieldLabel }, name),
        h('span', { style: styles.fieldValue }, value),
      );
      const row = (item) => h('button', {
        key: item.id,
        type: 'button',
        className: 'lbx-row',
        'data-active': item.id === selectedId ? 'true' : 'false',
        style: styles.row,
        onClick: () => setSelectedId(item.id),
      },
        h('span', { style: styles.rowTop },
          h('span', { style: item.priority === 'high' ? styles.badgeWarn : styles.badge }, kindLabel(item.kind)),
          h('span', { style: styles.rowTime }, tab === 'history' ? formatReadAt(item.readAt) : formatClock(item.createdAt)),
        ),
        h('div', { style: styles.rowTitle }, item.text),
        h('div', { style: styles.rowSource }, item.source === null ? '—' : '来自 ' + item.source),
      );

      // The receipt details the icon cannot show survive as its tooltip; the
      // badge counts session notes only, and the dot marks a miss or an error.
      const dockMeta = [
        ledger.checkedAt ? '上次核对 ' + formatClock(ledger.checkedAt) : null,
        ledger.misses > 0 ? 'Agent 漏核对 ' + ledger.misses + ' 轮' : null,
        globalUnread > 0 ? '全局 ' + globalUnread + ' 条未读' : null,
        ledger.error !== null ? '连接异常：' + ledger.error : null,
      ].filter((part) => part !== null).join(' · ');
      const dockAlert = ledger.misses > 0 || ledger.error !== null;

      const dockEntry = h('div', { style: styles.dock },
        h('button', {
          type: 'button',
          className: 'lbx-dockbtn',
          style: styles.dockBtn,
          'aria-label': '打开收件箱（' + sessionUnread + ' 条未读）',
          'aria-expanded': open,
          title: dockMeta === '' ? '收件箱' : '收件箱 · ' + dockMeta,
          onClick: () => { if (open) setOpen(false); else openPanel(); },
        },
          icon('inbox'),
          sessionUnread > 0 ? h('span', { style: styles.dockBadge }, String(sessionUnread)) : null,
          dockAlert ? h('span', { style: { ...styles.warnDot, position: 'absolute', bottom: 2, right: 2 }, 'aria-hidden': true }) : null,
        ),
      );

      const listRows = tab === 'history'
        ? (history.items.length === 0
          ? emptyBlock('search', history.error !== null ? '历史读取失败' : (history.loaded ? (searched === '' ? '还没有历史' : '没有匹配的历史') : '读取中…'))
          : history.items.map(row))
        : (unreadItems.length === 0
          ? emptyBlock('inbox', ledger.loaded ? '没有未读' : '读取中…')
          : unreadItems.map(row));

      const pager = tab === 'history' && history.hasMore
        ? h('div', { style: styles.pager },
          history.loadingMore
            ? h('span', { style: styles.pagerCount }, '加载中…')
            : h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: styles.more,
              disabled: history.loadingMore === true,
              onClick: () => void history.loadMore(),
            }, '加载更多（还剩 ' + (history.total - history.items.length) + ' 条）'),
        )
        : null;

      const detail = selected === null
        ? emptyBlock('inbox', '从左边选一条')
        : [
          h('div', { key: 'head', style: styles.detailHead },
            h('span', { style: styles.detailTitle }, kindLabel(selected.kind)),
            h('span', { style: selected.priority === 'high' ? styles.badgeWarn : styles.badge }, selected.priority === 'high' ? '高优先' : 'normal'),
            h('span', { style: styles.rowTime }, selected.read ? '已读于 ' + formatReadAt(selected.readAt) : '未读'),
          ),
          h('div', { key: 'text', style: styles.detailText }, selected.text),
          h('div', { key: 'fields', style: styles.fields },
            field('优先级', selected.priority === 'high' ? 'high' : 'normal'),
            field('来源', selected.source === null ? '—' : selected.source),
            field('创建', formatReadAt(selected.createdAt)),
            selected.read ? field('已读', formatReadAt(selected.readAt)) : null,
          ),
          selected.read
            ? null
            : h('button', {
              key: 'read',
              type: 'button',
              className: 'lbx-ghost',
              style: styles.action,
              onClick: () => void active.markRead(selected.id),
            }, icon('check'), h('span', null, '标记为已读')),
        ];

      // Rendered as a sibling *behind* the panel, not as its parent: a click on
      // the drawer never reaches this handler, so "inside" needs no stopPropagation.
      const scrim = open
        ? h('div', {
          style: styles.scrim,
          'aria-hidden': true,
          'data-letterbox-scrim': true,
          onClick: () => setOpen(false),
        })
        : null;

      // One pair of columns shared by the floating drawer and the sidebar panel
      // page, so the two surfaces cannot drift apart.
      const leftColumn = h('div', { style: { ...styles.left, width: leftWidth, minWidth: leftWidth } },
            h('div', { style: styles.segment, role: 'tablist', 'aria-label': '收件箱范围' },
              h('button', {
                type: 'button',
                className: 'lbx-tab',
                role: 'tab',
                'aria-selected': bucket === 'session',
                style: bucket === 'session' ? styles.tabActive : styles.tab,
                onClick: () => switchBucket('session'),
              }, '会话'),
              h('button', {
                type: 'button',
                className: 'lbx-tab',
                role: 'tab',
                'aria-selected': bucket === 'global',
                style: bucket === 'global' ? styles.tabActive : styles.tab,
                onClick: () => switchBucket('global'),
              }, globalUnread > 0 ? '全局 · ' + globalUnread : '全局'),
            ),
            h('div', { style: styles.segment, role: 'tablist' },
              h('button', {
                type: 'button',
                className: 'lbx-tab',
                role: 'tab',
                'aria-selected': tab === 'unread',
                style: tab === 'unread' ? styles.tabActive : styles.tab,
                onClick: () => switchTab('unread'),
              }, unread > 0 ? '未读 · ' + unread : '未读'),
              h('button', {
                type: 'button',
                className: 'lbx-tab',
                role: 'tab',
                'aria-selected': tab === 'history',
                style: tab === 'history' ? styles.tabActive : styles.tab,
                onClick: () => switchTab('history'),
              }, '历史'),
            ),
            tab === 'history' && history.loaded
              ? h('div', { style: styles.pagerCount }, '共 ' + history.total + ' 条')
              : null,
            tab === 'history'
              ? h('div', { style: styles.searchWrap },
                h('span', { style: styles.searchIcon }, icon('search')),
                h('input', {
                  type: 'search',
                  value: query,
                  placeholder: '搜索已读：正文 / 来源 / 类型',
                  'aria-label': '搜索历史条目',
                  style: styles.search,
                  onChange: (event) => setQuery(event.target.value),
                }),
              )
              : null,
            h('div', { style: styles.scroll }, listRows),
            pager,
          );
      const rightColumn = h('div', { style: { ...styles.right, minWidth: narrow ? 260 : 0 } }, detail);

      // The panel page owns no floating surface: it is the drawer's columns in
      // the layout's main column, so it returns before any portal work.
      if (!isDock) {
        return h('div', { style: styles.page },
          h('div', { style: styles.pageHead },
            h('span', { style: styles.panelTitle }, '收件箱'),
            h('span', { style: styles.headCount }, unread > 0 ? unread + ' 条未读' : '全部已读'),
          ),
          h('div', { style: styles.body }, leftColumn, rightColumn),
        );
      }

      const drawer = open ? h('div', {
        style: styles.panel,
        role: 'dialog',
        'aria-label': '收件箱',
        'aria-modal': false,
      },
        h('div', { style: styles.panelHead },
          h('span', { style: styles.panelTitle }, '收件箱'),
          h('span', { style: styles.headCount }, unread > 0 ? unread + ' 条未读' : '全部已读'),
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.close,
            onClick: () => setOpen(false),
            'aria-label': '关闭收件箱',
          }, icon('x')),
        ),
        h('div', { style: styles.body }, leftColumn, rightColumn),
      ) : null;

      // The sidebar page: same columns, but it lives in the layout main slot,
      // so it takes the height it is given instead of floating over the app.
      const page = h('div', { style: styles.page },
        h('div', { style: styles.pageHead },
          h('span', { style: styles.panelTitle }, '收件箱'),
          h('span', { style: styles.headCount }, unread > 0 ? unread + ' 条未读' : '全部已读'),
        ),
        h('div', { style: styles.body }, leftColumn, rightColumn),
      );

      const card = toast === null ? null : h('div', {
        style: styles.toast,
        role: 'status',
        onClick: () => openPanel(toast.id),
        onMouseEnter: () => setToastPaused(true),
        onMouseLeave: () => setToastPaused(false),
      },
        h('div', { style: styles.toastHead },
          h('span', { style: toast.item.priority === 'high' ? styles.badgeWarn : styles.badge }, kindLabel(toast.item.kind)),
          h('span', { style: styles.rowTime }, '新条目'),
        ),
        h('div', { style: styles.toastText }, toast.item.text),
        h('div', { style: styles.toastFoot },
          h('button', {
            type: 'button',
            className: 'lbx-ghost',
            style: styles.more,
            onClick: (event) => {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
              openPanel(toast.id);
            },
          }, icon('arrow-right'), h('span', null, '查看')),
        ),
      );

      // The entry button stays in the composer toolbar; everything that must
      // escape that subtree is portalled to <body>.
      const floating = portalHost === null
        ? null
        : ReactDOM.createPortal(h(React.Fragment, null, scrim, drawer, card), portalHost);

      return h(React.Fragment, null, dockEntry, floating);
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

    /** Page mounted in the layout's keyed `main` slot when the row is active. */
    function InboxPage(props) {
      return h(LetterboxDock, { sessions: props?.sessions, variant: 'panel' });
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        const sessions = ctx.get('sessions').list;
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-letterbox',
          order: 60,
          inject: () => ({ sessions }),
        }, LetterboxDock)), 'letterbox: composer dock');
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
        }, InboxPage)), 'letterbox: main panel');
      },
    };
  },
});
