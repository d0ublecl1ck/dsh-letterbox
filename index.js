/**
 * dsh-letterbox — host half.
 *
 * Owns the one thing the human cannot hold in their head: which notes the agent
 * believed were important, and whether the human actually acknowledged each
 * one. The panel in the browser half only draws what this half stores.
 *
 * Design notes:
 * - State is per Session (`sessionId` -> items), so a subagent's report can be
 *   filed against the conversation that delegated it.
 * - `readAt` is written only by the human's click through the authenticated
 *   route; no tool can mark an item read. That is what makes the receipt
 *   trustworthy.
 * - The ledger lives under DSH_HOME, so a restart does not silently empty the
 *   box and let the agent believe the human saw everything.
 *
 * @module dsh-letterbox
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addItem,
  checkedInTurn,
  countUnread,
  emptyState,
  listItems,
  markChecked,
  markRead,
  normalizeState,
  noteMiss,
  trimSession,
  validateAdd,
} from './store.js';

/** Stable cordis plugin name; the bundle row's id is `letterbox`. */
export const name = 'letterbox';
/** Hard dependencies: tools and the prompt section are the whole surface. */
export const inject = ['tools', 'systemPrompt'];

/** Authenticated route the browser half posts to. */
const ROUTE_PATH = '/letterbox';
/** File name under DSH_HOME. */
const STATE_FILE = 'letterbox.json';
/** Coalesce bursts of edits into one write. */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * Read the row config defensively.
 *
 * The plugin ships without a Schemastery dependency on purpose: a `link:`
 * install resolves bare imports from the plugin's own directory, so a missing
 * dependency would fail activation. Validation is therefore explicit here.
 *
 * @param raw - config handed down by the loader.
 * @returns the resolved config.
 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const enabled = source.enabled !== false;
  const requireCheckBeforeReply = source.requireCheckBeforeReply !== false;
  const enforcement = source.enforcement === 'warn' ? 'warn' : 'strict';
  const maxItemsPerSession = Number.isInteger(source.maxItemsPerSession) && source.maxItemsPerSession > 0
    ? source.maxItemsPerSession
    : 200;
  return { enabled, requireCheckBeforeReply, enforcement, maxItemsPerSession };
}

/** Turn the configured policy into the section the model reads every turn. */
function guidance(config) {
  const lines = [
    '# Letterbox (session inbox)',
    '',
    'This Session has a letterbox: a list of notes the agent decided the human must see.',
    'A note is only "read" when the human clicks its 已读 button in the panel. Nothing else counts as read - not sending it, not mentioning it in a message.',
  ];
  if (config.requireCheckBeforeReply) {
    lines.push(
      '',
      'Before each final answer, call `letterbox_status`. If it reports unread items:',
      '- name each unread item explicitly in the answer (short quote plus why it matters), and',
      '- do not assume the human has seen it; do not fold it into "as discussed" or "as you know".',
      'If the human asks something that an unread item already answers, surface that item instead of answering from memory alone.',
      '- If a turn ends with unread items and you never called `letterbox_status`, the host records a miss and the panel shows it to the human.',
    );
  } else {
    lines.push('', 'Check `letterbox_status` when a turn depends on what the human already knows.');
  }
  lines.push(
    '',
    'Write a note with `letterbox_add` when you learn something the human must act on or must not miss: a risk you found, a decision they own, a handoff they need to accept. Do not file routine progress; that belongs in the answer, not the letterbox.',
    'Keep one note per distinct fact. Reuse `letterbox_list` before adding, so the box does not fill with near-duplicates.',
  );
  return lines.join('\n');
}

/** One-line rendering shared by every tool result. */
function renderItem(item) {
  const badge = item.read ? 'read' : 'UNREAD';
  const priority = item.priority === 'high' ? '!' : ' ';
  return '- [' + badge + ']' + priority + ' (' + item.kind + ') ' + item.text + (item.source ? ' — from ' + item.source : '');
}

/**
 * Mount the host half.
 * @param rawCtx - host cordis context.
 * @param rawConfig - row config.
 */
export function apply(rawCtx, rawConfig) {
  const ctx = rawCtx;
  const config = resolveConfig(rawConfig);
  if (!config.enabled) return;

  const homePathOf = ctx.get('dshHomePath');
  const statePath = typeof homePathOf === 'function'
    ? homePathOf(STATE_FILE)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STATE_FILE);

  let state = emptyState();
  let hydrated = false;
  let loading = null;
  let persistTimer = null;
  let persistChain = Promise.resolve();

  const warn = (message) => {
    ctx.logger?.warn?.(message);
  };

  function persistNow() {
    const payload = JSON.stringify(state, null, 2);
    persistChain = persistChain
      .then(async () => {
        await mkdir(dirname(statePath), { recursive: true });
        const temporary = statePath + '.tmp-' + process.pid + '-' + Date.now();
        await writeFile(temporary, payload, 'utf8');
        await rename(temporary, statePath);
      })
      .catch((error) => {
        warn('letterbox: could not persist ' + statePath + ': ' + String(error));
      });
    return persistChain;
  }

  function schedulePersist() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  function load() {
    loading ??= (async () => {
      try {
        state = normalizeState(JSON.parse(await readFile(statePath, 'utf8')));
      } catch (error) {
        if (error?.code !== 'ENOENT') warn('letterbox: ignoring unreadable ' + statePath + ': ' + String(error));
        state = emptyState();
      }
      hydrated = true;
    })();
    return loading;
  }

  function whenLoaded(run) {
    if (hydrated) {
      run();
      return;
    }
    void load().then(run);
  }

  /** Session id of the agent that called a tool. */
  function sessionIdOf(exec) {
    const session = exec?.agent?.session;
    const id = session?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /** Turn bookkeeping: the host, not the model, decides what "this turn" means. */
  const turns = new Map();

  function currentTurnOf(sessionId) {
    const record = turns.get(sessionId);
    return record ? record.id : null;
  }

  function snapshotFor(sessionId) {
    const bucket = state.sessions[sessionId];
    const turn = currentTurnOf(sessionId);
    return {
      sessionId,
      unreadCount: countUnread(state, sessionId),
      items: listItems(state, sessionId),
      checkedAt: bucket?.checkedAt ?? null,
      checkedTurn: bucket?.checkedTurn ?? null,
      checkedThisTurn: checkedInTurn(state, sessionId, turn),
      misses: bucket?.misses ?? 0,
      lastMissAt: bucket?.lastMissAt ?? null,
    };
  }

  const ready = load();

  // ── prompt section ────────────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'tool:letterbox',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 1,
    text: guidance(config),
  });

  // ── model tools ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'letterbox_add',
    description: 'File one note the human must see or act on. Only the human can mark it read; this call cannot.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'One fact, written so it stands alone. Max 4000 characters.' },
        kind: { type: 'string', enum: ['risk', 'note', 'decision', 'handoff'], description: 'risk = something that can bite later; decision = a choice only the human can make.' },
        priority: { type: 'string', enum: ['high', 'normal'], description: 'high is rendered with a warning tone.' },
        source: { type: 'string', description: 'Optional origin label, e.g. a subagent name or a file path.' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('letterbox_add: no calling session');
      const payload = validateAdd(args);
      await ready;
      const item = addItem(state, { sessionId, payload, now: Date.now(), id: 'lb_' + randomUUID() });
      trimSession(state, sessionId, config.maxItemsPerSession);
      schedulePersist();
      return 'filed ' + item.id + ' (' + countUnread(state, sessionId) + ' unread in this session)';
    },
  });

  ctx.tools.register({
    name: 'letterbox_list',
    description: 'List this session letterbox items, newest first, with their read receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unreadOnly: { type: 'boolean', description: 'When true, hide items the human already marked read.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('letterbox_list: no calling session');
      await ready;
      const items = listItems(state, sessionId, { unreadOnly: args?.unreadOnly === true });
      if (items.length === 0) return 'letterbox is empty.';
      return items.map(renderItem).join('\n');
    },
  });

  ctx.tools.register({
    name: 'letterbox_status',
    description: 'Read the unread receipts before answering: which notes the human has not acknowledged yet.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('letterbox_status: no calling session');
      await ready;
      const checkpoint = markChecked(state, { sessionId, now: Date.now(), turn: currentTurnOf(sessionId) });
      schedulePersist();
      const unread = listItems(state, sessionId, { unreadOnly: true });
      const stamp = 'checkpoint: recorded at ' + new Date(checkpoint.checkedAt).toISOString() + ' (turn ' + String(checkpoint.checkedTurn) + ')';
      if (unread.length === 0) return 'unread: 0 — the human has acknowledged every filed note.\n' + stamp;
      return 'unread: ' + unread.length + '\n' + unread.map(renderItem).join('\n') + '\n' + stamp;
    },
  });

  // ── turn bookkeeping and the miss gate ────────────────────────────────
  // The host owns "this turn": a turn id is minted on turn/start, and turn/end
  // checks whether letterbox_status ran while it was open. Only a completed
  // turn can miss: an interrupted one never reached the human.
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (typeof id !== 'string' || id === '' || event === null || typeof event !== 'object') return;
    if (event.type === 'turn/start') {
      const previous = turns.get(id);
      const seq = (previous?.seq ?? 0) + 1;
      turns.set(id, { id: id + '#' + seq, seq });
      return;
    }
    if (event.type !== 'turn/end') return;
    if (config.enforcement !== 'strict') return;
    if (event.data?.reason?.kind !== 'completed') return;
    whenLoaded(() => {
      const turn = currentTurnOf(id);
      if (turn === null) return;
      if (countUnread(state, id) === 0) return;
      if (checkedInTurn(state, id, turn)) return;
      const misses = noteMiss(state, { sessionId: id, now: Date.now() });
      schedulePersist();
      warn('letterbox: turn ' + turn + ' ended with unread items and no letterbox_status call (miss #' + misses + ')');
      try {
        ctx.emit?.('letterbox/miss', { sessionId: id, turn, misses });
      } catch {
        /* the event is advisory; a listener must never break the turn */
      }
    });
  });

  // ── browser route ─────────────────────────────────────────────────────
  // The route must not be gated on a one-shot `ctx.get('webServer')`. That read
  // is strict: it only returns an implementation whose providing fiber is
  // already ACTIVE. A cold boot can reach this plugin while the web server is
  // still loading, so the read came back undefined, the whole registration
  // branch was skipped, and nothing ever retried it - the route then stayed
  // missing for the life of the process. A scoped inject is the retrying form
  // of the same read: the callback runs as soon as the service is available
  // (and again if it is replaced), which is how the web server's own
  // dependents mount their routes.
  //
  // `webServer` stays out of the module-level `inject` on purpose: a profile
  // without a web server (acp) must still activate the tools and the prompt.
  function mountRoute(scoped) {
    const webServer = scoped.get('webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    const sendJson = (res, status, value) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const readBody = (req) => new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += String(chunk); });
      req.on('end', () => {
        try {
          resolve(raw === '' ? {} : JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
    });
    // `connection` is read per request, not captured while mounting: it may be
    // absent here (it is optional) and arrive later, and a fence resolved from
    // a stale capture would silently admit every request.
    const rejected = (req, res) => {
      const rejection = scoped.get('connection')?.requestRejection?.(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    };
    scoped.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        const path = new URL(String(req.url), 'http://localhost').pathname;
        const endpoint = path.startsWith(ROUTE_PATH + '/') ? path.slice(ROUTE_PATH.length + 1) : '';
        const body = await readBody(req);
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string' } });
          return;
        }
        await ready;
        if (endpoint === 'list') {
          sendJson(res, 200, { ok: true, value: snapshotFor(sessionId) });
          return;
        }
        if (endpoint === 'read') {
          if (typeof body?.id !== 'string' || body.id === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id must be a non-empty string' } });
            return;
          }
          const changed = markRead(state, { sessionId, id: body.id, now: Date.now() });
          if (changed) schedulePersist();
          sendJson(res, 200, { ok: true, value: { ...snapshotFor(sessionId), changed } });
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: 'unknown-endpoint', message: 'no endpoint ' + endpoint } });
      },
    }), 'letterbox: POST ' + ROUTE_PATH + '/<endpoint>');
  }

  // Scoped, not module-level: this fiber waits for the web server to appear and
  // is unloaded with its effects (the route unregisters) when this plugin goes.
  ctx.inject(['webServer'], mountRoute);

  ctx.effect(() => () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    void persistNow();
  }, 'letterbox: persist on dispose');
}
