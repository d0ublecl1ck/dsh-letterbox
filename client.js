/**
 * dsh-letterbox — client half.
 *
 * One dock above the composer. It shows how many notes the agent filed for this
 * Session are still unacknowledged, and gives the human the only button that
 * can turn one into "read". The host half owns the ledger; this half never
 * guesses a receipt.
 *
 * Loaded by the Web module loader (window.__ModuleLoader__), not by Node ESM,
 * so there is no bundler and no JSX here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-letterbox',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROUTE = '/letterbox';
    const POLL_MS = 5000;

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
      return { sessionId: null, unreadCount: 0, items: [], error: null, loaded: false };
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

    function useLedger(sessionId) {
      const [ledger, setLedger] = React.useState(emptyLedger);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(() => {
        alive.current = true;
        if (sessionId === null) {
          setLedger(emptyLedger());
          return undefined;
        }
        let cancelled = false;
        const refresh = async () => {
          try {
            const value = await post('list', { sessionId });
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
      }, [sessionId]);
      const markRead = React.useCallback(async (id) => {
        if (sessionId === null) return;
        try {
          const value = await post('read', { sessionId, id });
          setLedger({ ...value, error: null, loaded: true });
        } catch (error) {
          setLedger((previous) => ({ ...previous, error: String(error && error.message ? error.message : error) }));
        }
      }, [sessionId]);
      return { ...ledger, markRead };
    }

    const styles = {
      wrap: { borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.24))', padding: '6px 12px', fontSize: 13 },
      bar: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
      count: { fontWeight: 600 },
      list: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' },
      item: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.08))' },
      text: { flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.45 },
      meta: { opacity: 0.65, fontSize: 11 },
      badge: { fontSize: 11, padding: '0 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,0.18))' },
      read: { fontSize: 12, padding: '2px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))', background: 'transparent', cursor: 'pointer' },
      readDone: { fontSize: 12, padding: '2px 10px', borderRadius: 6, border: 'none', background: 'transparent', opacity: 0.55, cursor: 'default' },
    };

    function kindLabel(kind) {
      if (kind === 'risk') return '风险';
      if (kind === 'decision') return '待决定';
      if (kind === 'handoff') return '交接';
      return '备注';
    }

    function LetterboxDock({ sessions }) {
      const sessionId = useSessionId(sessions);
      const ledger = useLedger(sessionId);
      const [open, setOpen] = React.useState(false);
      if (sessionId === null) return null;
      if (!ledger.loaded && ledger.items.length === 0) return null;
      if (ledger.items.length === 0 && ledger.error === null) return null;
      const unread = ledger.unreadCount;
      return h('div', { style: styles.wrap },
        h('div', {
          style: styles.bar,
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setOpen((value) => !value); },
        },
          h('span', { 'aria-hidden': true }, '📬'),
          h('span', { style: styles.count }, unread > 0 ? '收件箱 · ' + unread + ' 条未读' : '收件箱 · 全部已读'),
          h('span', { style: styles.meta }, open ? '收起' : '展开'),
          ledger.error !== null ? h('span', { style: styles.meta, title: ledger.error }, '（连接异常）') : null,
        ),
        open ? h('div', { style: styles.list },
          ledger.items.map((item) => h('div', { key: item.id, style: styles.item },
            h('span', { style: styles.badge }, kindLabel(item.kind) + (item.priority === 'high' ? '!' : '')),
            h('div', { style: styles.text },
              item.text,
              item.source ? h('div', { style: styles.meta }, '来自 ' + item.source) : null,
            ),
            item.read
              ? h('button', { type: 'button', style: styles.readDone, disabled: true }, '已读')
              : h('button', { type: 'button', style: styles.read, onClick: () => void ledger.markRead(item.id) }, '已读'),
          )),
        ) : null,
      );
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
      },
    };
  },
});
