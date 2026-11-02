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

    /** The conversation the main view is showing, or null. */
    function currentSessionId(list) {
      if (list === null || typeof list !== 'object' || !Array.isArray(list.ids)) return null;
      for (const id of list.ids) {
        const row = list.byId ? list.byId[id] : null;
        if (row && row.retainedBy && row.retainedBy.mainView > 0) return id;
      }
      return list.ids.length > 0 ? list.ids[0] : null;
    }

    /**
     * Stand-in sessions service for a slot rendered without the `sessions`
     * inject: it reports "no conversation", so a hollow mount draws no bubbles
     * instead of throwing inside the sidebar.
     */
    const NO_SESSIONS = { getSnapshot: () => null, subscribe: () => undefined };

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
     * Whether two polled snapshots describe the same box.
     *
     * The poll runs every five seconds whether or not anything changed, and a
     * fresh object per poll re-renders every consumer - the deck included. Only
     * the fields a viewer can see are compared: the ids in order, each item's
     * read flag and answer stamp, and the two counts. A poll that changes nothing
     * therefore leaves the previous state object in place.
     *
     * @param previous - the snapshot already in state.
     * @param next - the snapshot just fetched.
     * @returns true when `next` carries no visible change.
     */
    function sameSnapshot(previous, next) {
      if (previous.loaded !== true) return false;
      if (previous.sessionId !== next.sessionId || previous.bucket !== next.bucket) return false;
      if (previous.unreadCount !== next.unreadCount || previous.globalUnreadCount !== next.globalUnreadCount) return false;
      if (previous.items.length !== next.items.length) return false;
      for (let index = 0; index < next.items.length; index += 1) {
        const before = previous.items[index];
        const after = next.items[index];
        if (before.id !== after.id || before.read !== after.read) return false;
        const beforeAt = before.answer === null || before.answer === undefined ? null : before.answer.answeredAt;
        const afterAt = after.answer === null || after.answer === undefined ? null : after.answer.answeredAt;
        if (beforeAt !== afterAt) return false;
      }
      return true;
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
            if (!cancelled && alive.current) {
              setLedger((previous) => (sameSnapshot(previous, value) ? previous : { ...value, error: null, loaded: true }));
            }
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
      // Returns false instead of throwing: an optimistic caller has already
      // removed the card and only needs to know whether to put it back.
      const markRead = React.useCallback(async (id) => {
        if (sessionId === null) return false;
        try {
          const value = await post('read', { sessionId, id, bucket });
          setLedger({ ...value, error: null, loaded: true });
          return true;
        } catch (error) {
          setLedger((previous) => ({ ...previous, error: String(error && error.message ? error.message : error) }));
          return false;
        }
      }, [sessionId, bucket]);
      return { ...ledger, markRead };
    }

    /** Nothing unread: the shape the sidebar bubbles start from. */
    const NO_UNREAD = { sessionUnread: 0, globalUnread: 0 };

    /**
     * Unread counts for the two sidebar bubbles.
     *
     * One `list` request answers both bubbles: the host reports the session
     * box's `unreadCount` next to the shared box's `globalUnreadCount`. The poll
     * keeps the dock's 5s cadence, and a refused request leaves the previous
     * numbers alone — a dropped poll must neither blank the bubbles nor push an
     * error into the sidebar, which has nowhere to show one.
     *
     * @returns {{ sessionUnread: number, globalUnread: number }} the two counts.
     */
    function useUnreadBadge(sessions) {
      const sessionId = useSessionId(sessions ?? NO_SESSIONS);
      const [counts, setCounts] = React.useState(NO_UNREAD);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(() => {
        alive.current = true;
        if (sessionId === null) {
          setCounts(NO_UNREAD);
          return undefined;
        }
        let cancelled = false;
        const refresh = async () => {
          try {
            const value = await post('list', { sessionId, bucket: 'session' });
            if (cancelled || !alive.current) return;
            setCounts({
              sessionUnread: Number.isInteger(value?.unreadCount) ? value.unreadCount : 0,
              globalUnread: Number.isInteger(value?.globalUnreadCount) ? value.globalUnreadCount : 0,
            });
          } catch {
            /* keep the last counts: the sidebar only reports, it cannot explain */
          }
        };
        void refresh();
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);
      return counts;
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

    /**
     * Text for one unread bubble.
     *
     * Mirrors `badgeText` in store.js — the Web bundle is one script the module
     * loader materializes, and its `require` only resolves loader ids
     * (react/react-dom), never a sibling ESM file, so the browser half cannot
     * import the Node half. test/store.test.mjs pins both copies to one body so
     * they cannot drift.
     *
     * @param count - the raw unread count from the host.
     * @returns '' to hide the bubble, else '1'…'99' or '99+'.
     */
    function badgeText(count) {
      if (typeof count !== 'number' || !Number.isFinite(count)) return '';
      if (!Number.isInteger(count)) return '';
      if (count <= 0) return '';
      return count > 99 ? '99+' : String(count);
    }

    /** Kind badges shared by rows, the detail head and the deck cards. */
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

    // One pill, two anchors. The ring is the host's own sidebar fill painted as a
    // 1.5px shadow: the bubble sits on top of the icon's strokes, and without it
    // the glyph lines show through the corners and read as dirt. pointer-events
    // stays off so the bubble never steals the row's click.
    const BUBBLE = {
      position: 'absolute', boxSizing: 'border-box', minWidth: 12, height: 12,
      padding: '0 3px', borderRadius: 999, color: '#ffffff', fontSize: 9,
      fontWeight: 600, lineHeight: '12px', textAlign: 'center', whiteSpace: 'nowrap',
      pointerEvents: 'none', fontVariantNumeric: 'tabular-nums',
      boxShadow: '0 0 0 1.5px var(--dsw-specific-sidebar-fill, transparent)',
    };

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
      // The reading actions sit under the body, so the rule above them is the
      // only thing separating prose from controls.
      actionRow: {
        display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 12, paddingTop: 10,
        borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))',
      },

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

      // ── quick-reply card deck ────────────────────────────────────────────
      // The deck is a fixed box anchored to the sidebar's right edge; its
      // children are absolutely positioned so a card can move between 'stacked'
      // and 'listed' by transform alone, with no layout animation.
      // width is the literal 340: this object is built before DECK_WIDTH exists
      // (that constant lives with the deck logic further down) and the horizontal
      // clamp uses DECK_WIDTH to keep the same box on screen.
      deck: { position: 'fixed', width: 340, pointerEvents: 'none', zIndex: 998 },
      // Card visuals only: position, height and the stack transform live in the
      // deck's stylesheet so switching between stack and list is a class swap, not
      // a re-render of every card.
      deckCard: {
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px',
        borderRadius: 10, pointerEvents: 'auto',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
        background: 'var(--dsw-alias-bg-primary, #ffffff)', color: 'inherit', fontSize: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      },
      deckMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.62 },
      deckText: { lineHeight: 1.45 },
      deckFoot: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 'auto' },
      deckBtn: {
        fontSize: 11, padding: '2px 8px', border: 'none', borderRadius: 6,
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      deckOption: {
        fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.16))',
        background: 'transparent', color: 'inherit',
      },
      deckReply: {
        flex: 1, minWidth: 120, height: 24, padding: '0 8px', borderRadius: 6, fontSize: 11,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.16))',
        background: 'transparent', color: 'inherit', outline: 'none',
      },
      // Stacked: the cards are absolutely positioned inside a zero-height box, so
      // the deck never reserves space in the conversation above the composer.
      deckStack: { position: 'relative', height: 0 },
      // Listed: real document flow, so every card can be as tall as its text. The
      // 60vh cap keeps the deck off the top of the window; the overflow lives here
      // rather than on the deck root so the scrollbar belongs to the list.
      deckList: {
        display: 'flex', flexDirection: 'column', gap: 8,
        maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain',
      },
      deckMore: {
        width: '100%', padding: '6px 2px', border: 'none', background: 'transparent',
        color: 'inherit', opacity: 0.7, fontSize: 11, cursor: 'pointer', textAlign: 'left',
      },
      deckError: { fontSize: 11, color: 'var(--dsw-alias-text-warning, #b26a00)' },
      deckBadge: {
        position: 'absolute', right: 0, zIndex: 41, padding: '2px 8px', borderRadius: 999,
        fontSize: 11, cursor: 'pointer', pointerEvents: 'auto',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.16))',
        background: 'var(--dsw-alias-bg-primary, #ffffff)', color: 'inherit',
        boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
      },
      // Off-screen but still announced: the count changes, the cards never do.
      srOnly: {
        position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
        overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
      },
      // Near-zero flow node inside the composer dock: its rect is the composer's
      // top edge, which is what the deck anchors to. It keeps a 1px box on
      // purpose - a 0x0 node cannot be told apart from a node that was never laid
      // out, and the anchor has to know the difference.
      probe: { display: 'block', width: 1, height: 1, margin: 0, padding: 0, opacity: 0, pointerEvents: 'none' },

      // ── sidebar glyph bubbles ────────────────────────────────────────────
      // The wrapper is the positioning frame; inline-flex keeps the icon the
      // only thing that sizes the box, so the row's own centring is untouched.
      glyphWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      // Session count: top-right, brand blue. It answers "is there anything for
      // the conversation I am looking at".
      glyphBadgeSession: { ...BUBBLE, top: -4, right: -4, background: 'var(--dsw-alias-brand-primary, #4c8dff)' },
      // Global count: bottom-left, warning amber. It answers "is anything unread
      // anywhere", so it must not compete with the session bubble above.
      glyphBadgeGlobal: { ...BUBBLE, bottom: -4, left: -4, background: 'var(--dsw-alias-text-warning, #b26a00)' },
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
        ),
        h('div', { style: styles.detailScroll },
          h('div', { style: styles.detailTitleRow },
            badge(detailItem),
            detailItem.priority === 'high' ? h('span', { style: styles.prioDot, 'aria-hidden': true }) : null,
            h('span', { style: styles.detailTime }, formatReadAt(detailItem.createdAt)),
          ),
          h('div', { style: styles.detailText }, detailItem.text),
          // Reading actions live under the body, where the eye lands after the
          // note rather than before it; the bar above keeps only "back".
          h('div', { style: styles.actionRow },
            detailItem.read
              ? null
              : h('button', {
                type: 'button',
                className: 'lbx-ghost',
                style: { ...styles.iconBtn, width: 'auto', padding: '4px 10px', gap: 4, fontSize: 12 },
                'aria-label': '标记为已读',
                title: '标记为已读',
                onClick: () => void markIds([detailItem.id]),
              }, icon('check', 15), h('span', null, '标记为已读')),
            detailItem.read ? null : h('span', { style: styles.toolbarDot, 'aria-hidden': true }, '·'),
            h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: styles.more,
              disabled: previous === null,
              onClick: () => { if (previous !== null) setSelectedId(previous.id); },
            }, '上一封'),
            h('span', { style: styles.toolbarDot, 'aria-hidden': true }, '·'),
            h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: styles.more,
              disabled: next === null,
              onClick: () => { if (next !== null) setSelectedId(next.id); },
            }, '下一封'),
          ),
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
     *
     * The row renders one aria-hidden icon span plus the label span and offers
     * no trailing slot, so both unread bubbles have to be drawn inside this
     * component. They are absolutely positioned children of the wrapper span
     * (the positioning frame), which is why the wrapper is inline-flex: the icon
     * stays the only thing that sizes the box, so the glyph never grows or
     * drifts out of centre. A zero count renders nothing at all.
     */
    function InboxGlyph(props) {
      const unread = useUnreadBadge(props?.sessions);
      const sessionText = badgeText(unread.sessionUnread);
      const globalText = badgeText(unread.globalUnread);
      return h('span', { style: styles.glyphWrap },
        icon('inbox', props?.size ?? 16),
        sessionText === '' ? null : h('span', {
          style: styles.glyphBadgeSession,
          title: '本会话 ' + String(unread.sessionUnread) + ' 条未读',
        }, sessionText),
        globalText === '' ? null : h('span', {
          style: styles.glyphBadgeGlobal,
          title: '全局 ' + String(unread.globalUnread) + ' 条未读',
        }, globalText),
      );
    }

    /** How many cards the deck draws once it is listed. */
    const DECK_MAX = 8;
    /** How many cards the stacked state keeps; the rest become one count. */
    const DECK_STACK = 3;
    /** Slot height of one card while stacked. */
    const DECK_SLOT = 96;
    /** How far each card behind the front one peeks out while stacked. */
    const DECK_PEEK = 3;
    /**
     * Floor for the deck's bottom edge. 44 clears the window's bottom chrome (a
     * status bar, an info strip) without pushing the deck up into the transcript;
     * the measured height of the host's bottom row is added on top of it.
     */
    const DECK_MIN_BOTTOM = 44;
    /** Bottom edge used when the composer probe cannot be measured at all. */
    const DECK_FALLBACK_BOTTOM = 132;
    /** The deck's fixed width; the horizontal clamp keeps it on screen. */
    const DECK_WIDTH = 340;
    /** Flip to true to log one anchor measurement per mount (numbers, not vibes). */
    const DECK_DEBUG = false;
    /** Hover is a preview, not a commitment: expand after the pointer settles... */
    const DECK_HOVER_IN_MS = 120;
    /** ...and collapse only after it has really left. */
    const DECK_HOVER_OUT_MS = 200;
    /**
     * The deck's stylesheet. It owns everything that differs between the two
     * layouts - position, height, the stack offsets, the text clamp - so a hover
     * only swaps a class on the container and React never re-renders a card for a
     * visual state. The panel's big sheet is not reused: it exists only while the
     * panel is mounted, and the deck can be up with the panel never opened.
     */
    const DECK_STYLE_TEXT = '@keyframes lbx-deck-fade{from{opacity:0}to{opacity:1}}'
      + '.lbx-deck-fade{animation:lbx-deck-fade 120ms ease}'
      + '.lbx-deck-stack .lbx-card{position:absolute;left:0;right:0;bottom:0;min-height:' + String(DECK_SLOT) + 'px;max-height:' + String(DECK_SLOT) + 'px;overflow:hidden;transition:transform 180ms ease,opacity 180ms ease}'
      + '.lbx-deck-stack .lbx-card:nth-child(1){transform:none;opacity:1;z-index:40}'
      + '.lbx-deck-stack .lbx-card:nth-child(2){transform:translateY(-' + String(DECK_PEEK) + 'px) scale(0.98);opacity:0.9;z-index:39}'
      + '.lbx-deck-stack .lbx-card:nth-child(3){transform:translateY(-' + String(DECK_PEEK * 2) + 'px) scale(0.96);opacity:0.8;z-index:38}'
      + '.lbx-deck-list .lbx-card{position:relative}'
      + '.lbx-deck-stack .lbx-card-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
      + '.lbx-deck-list .lbx-card-text{white-space:pre-wrap;word-break:break-word}'
      + '@media (prefers-reduced-motion: reduce){.lbx-deck-fade{animation:none}.lbx-deck-stack .lbx-card{transition:none}}';

    /**
     * Clamp one deck measurement into the viewport.
     *
     * Pure on purpose: the anchor used to be "whatever the probe said", which is
     * how a half-laid-out composer parked the deck under the window edge. Every
     * input may be missing or junk - a clamp that throws is worse than a clamp
     * that picks a safe box.
     *
     * @param input - frameLeft, sidebarWidth, probeTop, probeHeight, chromeHeight,
     *   viewportWidth, viewportHeight (all numbers, any may be NaN/undefined).
     * @returns {{left: number, bottom: number, probeBottom: number|null,
     *   minBottom: number, ceiling: number}} the final box plus its bounds.
     */
    function clampDeckAnchor(input) {
      const viewportWidth = Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0;
      const viewportHeight = Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0;
      const frameLeft = Number.isFinite(input.frameLeft) ? input.frameLeft : 0;
      const sidebarWidth = Number.isFinite(input.sidebarWidth) && input.sidebarWidth > 0 ? input.sidebarWidth : 0;
      const chromeHeight = Number.isFinite(input.chromeHeight) && input.chromeHeight > 0 ? input.chromeHeight : 0;
      const probeHeight = Number.isFinite(input.probeHeight) ? input.probeHeight : 0;

      const rawLeft = frameLeft + sidebarWidth + 12;
      const left = Math.max(12, Math.min(rawLeft, viewportWidth - 12 - DECK_WIDTH));

      const minBottom = Math.max(DECK_MIN_BOTTOM, chromeHeight + 12);
      const usable = Number.isFinite(input.probeTop) && probeHeight > 0 && input.probeTop < viewportHeight;
      const probeBottom = usable ? viewportHeight - input.probeTop + 12 : DECK_FALLBACK_BOTTOM;
      const ceiling = Math.max(viewportHeight * 0.6, minBottom);
      const bottom = Math.min(Math.max(probeBottom, minBottom), ceiling);
      return { left, bottom, probeBottom: usable ? probeBottom : null, minBottom, ceiling };
    }

    /**
     * Where the deck lives: the sidebar's right edge and the composer's top.
     *
     * The three-column grid belongs to the app frame, so the sidebar width is the
     * frame's first grid track - read from its computed grid-template-columns,
     * which is the same number the frame writes inline from the layout store. The
     * frame itself is found through [data-shell-bottom], its always-rendered
     * bottom row; the data-sidebar-collapsed attribute is only present while
     * collapsed, so it cannot be the primary anchor (it stays as a fallback).
     *
     * Measured on mount and then only when something real changes: frame resize,
     * a frame attribute/style rewrite (collapsing the sidebar rewrites the grid
     * inline style), dock resize and window resize. One animation frame coalesces
     * a burst of notifications into one read - never one read per frame.
     *
     * Both axes are clamped, because a measurement is only evidence: the probe
     * can report a rect before the composer is laid out, or after the window has
     * been resized under it, and an unclamped result parks the deck half off
     * screen. The bottom also clears the host's own bottom row (the pipeline
     * shell's status strip, when a profile renders one).
     *
     * @param probeRef - 1x1 invisible node rendered inside the composer dock.
     * @returns {{left: number, bottom: number, probeBottom: number|null}|null}
     *   the clamped anchor plus the raw probe-derived number it came from.
     */
    function useDeckAnchor(probeRef) {
      const [anchor, setAnchor] = React.useState(null);
      const logged = React.useRef(false);
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        const bottomRowOf = () => document.querySelector('[data-shell-bottom]');
        const frameOf = () => {
          const bottomRow = bottomRowOf();
          if (bottomRow !== null) return bottomRow.parentElement;
          return document.querySelector('[data-sidebar-collapsed]');
        };
        let scheduled = 0;
        const measure = () => {
          const frame = frameOf();
          const probe = probeRef.current;
          if (frame === null || probe === null) return;
          const frameRect = frame.getBoundingClientRect();
          const tracks = window.getComputedStyle(frame).gridTemplateColumns || '';
          const sidebarWidth = Number.parseFloat(tracks);
          const probeRect = probe.getBoundingClientRect();
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          // The bottom row is the host's own chrome (status strip when a profile
          // renders one); its height is the floor the deck must stay above.
          const bottomRow = bottomRowOf();
          const chromeRect = bottomRow === null ? null : bottomRow.getBoundingClientRect();
          const chrome = chromeRect !== null && Number.isFinite(chromeRect.height) ? chromeRect.height : 0;

          const clamped = clampDeckAnchor({
            frameLeft: frameRect.left,
            sidebarWidth,
            probeTop: probeRect.top,
            probeHeight: probeRect.height,
            chromeHeight: chrome,
            viewportWidth,
            viewportHeight,
          });

          if (DECK_DEBUG && !logged.current) {
            logged.current = true;
            console.debug('[letterbox] deck anchor', {
              frame: { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height },
              sidebarTrack: sidebarWidth,
              probe: { top: probeRect.top, height: probeRect.height },
              bottomChrome: chrome,
              // Both candidates on purpose: what the probe implied, and what the
              // deck actually uses after the clamp.
              candidates: { left: frameRect.left + (sidebarWidth > 0 ? sidebarWidth : 0) + 12, bottom: clamped.probeBottom },
              clamped: { left: clamped.left, bottom: clamped.bottom, minBottom: clamped.minBottom, ceiling: clamped.ceiling },
              viewport: { width: viewportWidth, height: viewportHeight },
            });
          }

          setAnchor((previous) => (previous !== null
            && Math.abs(previous.left - clamped.left) < 0.5
            && Math.abs(previous.bottom - clamped.bottom) < 0.5
            && previous.probeBottom === clamped.probeBottom
            ? previous
            : { left: clamped.left, bottom: clamped.bottom, probeBottom: clamped.probeBottom }));
        };
        const schedule = () => {
          if (scheduled !== 0) return;
          scheduled = window.requestAnimationFrame(() => {
            scheduled = 0;
            measure();
          });
        };
        const frame = frameOf();
        schedule();
        const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        if (resized !== null) {
          if (frame !== null) resized.observe(frame);
          if (probeRef.current !== null) resized.observe(probeRef.current);
        }
        const mutated = typeof MutationObserver === 'function' && frame !== null ? new MutationObserver(schedule) : null;
        if (mutated !== null) {
          mutated.observe(frame, {
            attributes: true,
            attributeFilter: ['style', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
          });
        }
        window.addEventListener('resize', schedule);
        return () => {
          if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
          if (resized !== null) resized.disconnect();
          if (mutated !== null) mutated.disconnect();
          window.removeEventListener('resize', schedule);
        };
      }, [probeRef]);
      return anchor;
    }

    /** No options: one shared empty array, so a card without options keeps its props. */
    const NO_OPTIONS = [];

    /**
     * One card in the deck.
     *
     * Memoised on primitive props: hovering only swaps a class on the container,
     * so the cards must not re-render for it. Everything the two layouts disagree
     * about (position, height, stack offset, text clamp) is CSS keyed off the
     * container (`.lbx-deck-stack` / `.lbx-deck-list`), which is why this
     * component takes no layout props at all.
     */
    const DeckCard = React.memo(function DeckCard(props) {
      const { id, text, kind, priority, createdAt, options, busy, locked, replyOpen, onRead, onReply, onAnswer, onSend, onPin, onToggle } = props;
      const dim = locked && !busy ? 0.5 : 1;
      const meta = kindLabel(kind) + (priority === 'high' ? ' · 高' : '') + ' · ' + formatClock(createdAt);
      const stop = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      };

      const button = (label, onClick) => h('button', {
        type: 'button',
        className: 'lbx-ghost',
        style: { ...styles.deckBtn, opacity: dim },
        disabled: locked,
        onClick: (event) => {
          stop(event);
          onClick();
        },
      }, label);

      const foot = replyOpen
        ? h(DeckReply, { id, locked, onSend })
        : h('div', { style: styles.deckFoot },
          (options === undefined ? NO_OPTIONS : options).map((option) => h('button', {
            key: option,
            type: 'button',
            className: 'lbx-ghost',
            style: { ...styles.deckOption, opacity: dim },
            disabled: locked,
            onClick: (event) => {
              stop(event);
              onAnswer(id, option);
            },
          }, option)),
          button('已读', () => onRead(id)),
          button('回复', () => onReply(id)),
        );

      return h('div', {
        className: 'lbx-card',
        style: styles.deckCard,
        'data-card': id,
        // The body is focusable on purpose: touch and keyboard have no hover, so
        // Enter / Space is their way into the list.
        tabIndex: 0,
        role: 'button',
        onClick: (event) => {
          stop(event);
          onPin();
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          onToggle();
        },
      },
        h('div', { style: styles.deckMeta }, meta),
        h('div', { className: 'lbx-card-text', style: styles.deckText }, text),
        foot,
      );
    });

    /**
     * The one-line reply box. It keeps the draft locally so typing re-renders the
     * input and nothing else - the deck and its other cards stay untouched.
     */
    const DeckReply = React.memo(function DeckReply(props) {
      const { id, locked, onSend } = props;
      const [draft, setDraft] = React.useState('');
      const send = () => {
        const value = draft.trim();
        if (value === '') return;
        onSend(id, value);
      };
      const stop = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      };
      return h('div', { style: styles.deckFoot },
        h('input', {
          type: 'text',
          style: styles.deckReply,
          value: draft,
          disabled: locked,
          autoFocus: true,
          placeholder: '回复一句…',
          'aria-label': '回复这条笔记',
          onChange: (event) => setDraft(event.target.value),
          onClick: stop,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            send();
          },
        }),
        h('button', {
          type: 'button',
          className: 'lbx-ghost',
          style: styles.deckBtn,
          disabled: locked,
          onClick: (event) => {
            stop(event);
            send();
          },
        }, '发送'),
      );
    });

    /**
     * The quick-reply deck, mounted in the composer dock.
     *
     * Every unread note of this Session stays on screen as a card until the human
     * acts on it: nothing here times out. One note is drawn whole, two form a
     * light stack, three or more stack three deep and fold the rest into a count.
     * A pointer that settles on the deck previews the list; a click, a Tab into it
     * or starting a reply pins that list open. Esc or a tap outside lets it go.
     *
     * Everything the human clicks is optimistic: the card leaves at once and only
     * comes back if the host refuses the write, so no action ever looks ignored
     * while a request is in flight.
     *
     * Performance rules: one poll (the existing useLedger, now deduped), no
     * standing timers - the two hover delays live only between a pointer event and
     * its effect and are cleared on unmount - at most DECK_MAX cards, memoised
     * cards, and no per-hover style building. Nothing plays under reduced motion.
     */
    function CardDeck({ sessions, layout }) {
      const sessionId = useSessionId(sessions);
      const ledger = useLedger(sessionId, 'session', true);
      const probeRef = React.useRef(null);
      const deckRef = React.useRef(null);
      const anchor = useDeckAnchor(probeRef);
      const [portalHost, setPortalHost] = React.useState(null);
      const [hovered, setHovered] = React.useState(false);
      // Pinned = the list stays open regardless of the pointer: set by a click, a
      // Tab into the deck, or starting a reply; cleared by Esc or a tap outside.
      const [pinned, setPinned] = React.useState(false);
      const [replyId, setReplyId] = React.useState(null);
      const [busyId, setBusyId] = React.useState(null);
      const [doneIds, setDoneIds] = React.useState([]);
      const [error, setError] = React.useState(null);
      const [reduced, setReduced] = React.useState(false);
      const [announcement, setAnnouncement] = React.useState('');
      const enterTimer = React.useRef(0);
      const leaveTimer = React.useRef(0);
      const restoreFocus = React.useRef(false);

      // The deck is portalled to <body>: inside the composer subtree a transformed
      // ancestor would both trap position:fixed and create a stacking context
      // that lets the sidebar paint over the cards.
      React.useEffect(() => {
        if (typeof document === 'undefined' || document.body === null || typeof document.createElement !== 'function') return undefined;
        const host = document.createElement('div');
        host.id = 'lbx-deck-portal';
        host.setAttribute('data-letterbox-deck', 'true');
        host.style.position = 'fixed';
        host.style.inset = '0';
        host.style.pointerEvents = 'none';
        // Above every in-page chrome the host draws (bottom status strips, toasts,
        // tooltips): the deck is an overlay, not part of the column flow.
        host.style.zIndex = '2147480000';
        document.body.appendChild(host);
        setPortalHost(host);
        return () => {
          setPortalHost(null);
          if (typeof host.remove === 'function') host.remove();
          else if (host.parentNode !== null) host.parentNode.removeChild(host);
        };
      }, []);

      React.useEffect(() => {
        if (typeof document === 'undefined' || document.head === null || typeof document.createElement !== 'function') return undefined;
        const sheet = document.createElement('style');
        sheet.setAttribute('data-letterbox-deck-styles', 'true');
        sheet.textContent = DECK_STYLE_TEXT;
        document.head.appendChild(sheet);
        return () => { if (sheet.parentNode !== null) sheet.parentNode.removeChild(sheet); };
      }, []);

      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const sync = () => setReduced(query.matches === true);
        sync();
        if (typeof query.addEventListener !== 'function') return undefined;
        query.addEventListener('change', sync);
        return () => query.removeEventListener('change', sync);
      }, []);

      // A card leaves the deck when the ledger says it is read, or immediately
      // after a successful answer - waiting for the next poll would leave a card
      // the human already answered sitting on screen for five seconds.
      const unread = ledger.items.filter((item) => !item.read && doneIds.indexOf(item.id) === -1);
      const total = unread.length;
      const shown = unread.slice(0, DECK_MAX);
      const rest = total - shown.length;
      const listed = hovered || pinned;
      // One note has nothing to stack against, so it is always drawn whole.
      const flow = listed || total === 1;
      const stacked = unread.slice(0, DECK_STACK);
      const badgeCount = flow ? 0 : total - stacked.length;

      // Screen readers hear one sentence per count change, never one per card.
      const announced = React.useRef(null);
      React.useEffect(() => {
        if (announced.current === total) return;
        const previous = announced.current;
        announced.current = total;
        if (total === 0) return;
        // The first load is the whole count; a later grow is the delta.
        setAnnouncement(previous === null || previous === 0
          ? '共 ' + String(total) + ' 条未读'
          : (total > previous ? '新增 ' + String(total - previous) + ' 条未读' : '共 ' + String(total) + ' 条未读'));
      }, [total]);

      // Answering the last card unmounts the deck, and a pointerleave that never
      // happens would leave 'hovered' or 'pinned' behind: the next card would then
      // appear already listed. Drop every pointer-driven state when the ids change.
      const shownKey = shown.map((item) => item.id).join(',');
      React.useEffect(() => {
        const ids = shownKey === '' ? [] : shownKey.split(',');
        if (replyId !== null && ids.indexOf(replyId) === -1) setReplyId(null);
        if (ids.length === 0) {
          setHovered(false);
          setPinned(false);
        }
      }, [shownKey, replyId]);

      // Dismissing the last card removes the node the human was standing on. If it
      // held the focus, hand it back to the composer instead of leaving it on
      // <body> - measured at action time, because by then the node is already gone.
      const wasShown = React.useRef(false);
      React.useEffect(() => {
        const visible = shown.length > 0;
        if (wasShown.current && !visible && restoreFocus.current) {
          restoreFocus.current = false;
          const target = typeof document === 'undefined' ? null : document.querySelector('textarea, [contenteditable=""], [contenteditable="true"]');
          if (target !== null && typeof target.focus === 'function') target.focus();
        }
        wasShown.current = visible;
      }, [shown.length]);

      // Outside tap and Esc are only listened for while the list is pinned; the
      // listeners come off with the pin.
      React.useEffect(() => {
        if (!pinned || typeof document === 'undefined') return undefined;
        const onDown = (event) => {
          const root = deckRef.current;
          if (root !== null && event.target !== null && root.contains(event.target)) return;
          setPinned(false);
          setHovered(false);
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          setPinned(false);
          setHovered(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [pinned]);

      React.useEffect(() => () => {
        if (enterTimer.current !== 0) window.clearTimeout(enterTimer.current);
        if (leaveTimer.current !== 0) window.clearTimeout(leaveTimer.current);
      }, []);

      const clearTimer = (ref) => {
        if (ref.current === 0) return;
        window.clearTimeout(ref.current);
        ref.current = 0;
      };

      // Hovering is a preview, not a commitment: expand only after the pointer has
      // settled, and collapse only after it has really left.
      const onPointerEnter = () => {
        clearTimer(leaveTimer);
        if (listed || total < 2) return;
        clearTimer(enterTimer);
        enterTimer.current = window.setTimeout(() => {
          enterTimer.current = 0;
          setHovered(true);
        }, DECK_HOVER_IN_MS);
      };

      const onPointerLeave = () => {
        clearTimer(enterTimer);
        if (pinned) return;
        clearTimer(leaveTimer);
        leaveTimer.current = window.setTimeout(() => {
          leaveTimer.current = 0;
          setHovered(false);
        }, DECK_HOVER_OUT_MS);
      };

      // Remember whether the human was standing on the deck before it disappears.
      const noteFocus = React.useCallback(() => {
        const root = deckRef.current;
        restoreFocus.current = root !== null && root.contains(document.activeElement);
      }, []);

      // Optimistic: the card goes now, the request follows. A refusal puts the
      // card back and says so - never a spinner over a card that is still there.
      const onRead = React.useCallback((id) => {
        noteFocus();
        setDoneIds((previous) => previous.concat(id));
        setBusyId(id);
        setError(null);
        void Promise.resolve(ledger.markRead(id)).then((ok) => {
          if (ok !== false) return;
          setDoneIds((previous) => previous.filter((value) => value !== id));
          setError('标记失败，卡片已恢复');
        }).finally(() => setBusyId(null));
      }, [ledger.markRead, noteFocus]);

      const answer = React.useCallback((id, body) => {
        noteFocus();
        setDoneIds((previous) => previous.concat(id));
        setReplyId((previous) => (previous === id ? null : previous));
        setBusyId(id);
        setError(null);
        void post('answer', { sessionId, id, ...body }).then(() => {}).catch(() => {
          setDoneIds((previous) => previous.filter((value) => value !== id));
          setError('提交失败，卡片已恢复');
        }).finally(() => setBusyId(null));
      }, [sessionId, noteFocus]);

      const onAnswer = React.useCallback((id, choice) => answer(id, { choice }), [answer]);
      const onSend = React.useCallback((id, note) => answer(id, { note }), [answer]);
      const onReply = React.useCallback((id) => {
        setReplyId(id);
        setPinned(true);
      }, []);
      const onPin = React.useCallback(() => setPinned(true), []);
      const onToggle = React.useCallback(() => setPinned((value) => !value), []);

      const openInbox = () => {
        try {
          if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
        } catch {
          /* the main panel is not registered yet; the deck already said its piece */
        }
      };

      const cards = (flow ? shown : stacked).map((item) => h(DeckCard, {
        key: item.id,
        id: item.id,
        text: item.text,
        kind: item.kind,
        priority: item.priority,
        createdAt: item.createdAt,
        options: item.options === undefined ? NO_OPTIONS : item.options,
        busy: busyId === item.id,
        locked: busyId !== null,
        replyOpen: replyId === item.id,
        onRead,
        onReply,
        onAnswer,
        onSend,
        onPin,
        onToggle,
      }));

      const probe = h('span', { ref: probeRef, style: styles.probe, 'aria-hidden': true });
      const live = h('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', style: styles.srOnly }, announcement);
      const deck = anchor === null || portalHost === null || total === 0 ? null : ReactDOM.createPortal(h('div', {
        ref: deckRef,
        style: {
          ...styles.deck,
          left: anchor.left + 12,
          bottom: anchor.bottom,
          // Only a pinned deck owns the pointer: an always-on transparent
          // rectangle over the conversation would swallow clicks that were never
          // meant for the deck.
          pointerEvents: pinned ? 'auto' : 'none',
        },
        onPointerEnter,
        onPointerLeave,
        onFocus: () => setPinned(true),
      },
        flow
          ? h('div', {
            className: listed && !reduced ? 'lbx-deck-fade' : undefined,
            style: styles.deckList,
          },
            cards,
            rest > 0 ? h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: styles.deckMore,
              onClick: openInbox,
            }, '还有 ' + String(rest) + ' 条') : null,
            error === null ? null : h('div', { style: styles.deckError }, error),
          )
          : h('div', { style: styles.deckStack },
            cards,
            error === null ? null : h('div', {
              style: { ...styles.deckError, position: 'absolute', left: 0, bottom: DECK_SLOT + 6 },
            }, error),
            badgeCount > 0 ? h('button', {
              type: 'button',
              className: 'lbx-ghost',
              style: { ...styles.deckBadge, bottom: DECK_SLOT + DECK_PEEK * Math.max(stacked.length - 1, 0) + 6 },
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                openInbox();
              },
            }, '还有 ' + String(badgeCount) + ' 条') : null,
          ),
      ), portalHost);

      return h(React.Fragment, null, probe, live, deck);
    }

    return {
      inject: ['slots', 'sessions', 'layout'],
      apply(ctx) {
        const sessions = ctx.get('sessions').list;
        const layout = ctx.get('layout') ?? null;
        // The deck rides the composer dock because that is the seat the layout
        // keeps mounted for the whole conversation: its own render is a portal to
        // <body>, so nothing in the composer can clip or transform it. The single
        // ledger poll that feeds it lives in useLedger.
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-letterbox',
          order: 60,
          inject: () => ({ sessions, layout }),
        }, CardDeck)), 'letterbox: card deck');
        // The sidebar row only selects a main panel: layout.selectPanel throws
        // unless a main entry with this key is registered, so both go together.
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: '收件箱',
          inject: () => ({ sessions }),
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
