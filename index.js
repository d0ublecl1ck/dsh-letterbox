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
  applyAnswer,
  checkedInTurn,
  countUnread,
  emptyState,
  GLOBAL_SCOPE,
  listItems,
  markChecked,
  markRead,
  MAX_OPTION_LENGTH,
  MAX_TEXT,
  normalizeState,
  noteMiss,
  pageItems,
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
    'This Session has a letterbox: the only channel where the human records that they actually read something. A note counts as read only when the human clicks its 已读 button in the panel. Nothing else counts as read - not sending it, not mentioning it in a message.',
    '',
    'You have four tools: `letterbox_add`, `letterbox_list`, `letterbox_status`, `letterbox_answer`. A note filed with `options` shows those options as buttons on its card, and every card also offers a one-line reply; read what the human picked or typed with `letterbox_answer` (it only reads - it never writes a receipt or an answer).',
    '',
    '## Every turn, two duties',
  ];
  lines.push(config.requireCheckBeforeReply
    ? '1. The host injects one `Letterbox:` receipt line into every turn - read it. If it reports unacknowledged notes, call `letterbox_status` before your final answer and name each one explicitly; a completed turn that ends with unacknowledged notes and no such call records a miss the human can see. If it reports that the human has acknowledged every filed note, or that nothing has been filed yet, do not call `letterbox_status` this turn.'
    : '1. The host injects one `Letterbox:` receipt line into every turn - read it. Call `letterbox_status` before your final answer when it reports unacknowledged notes.');
  lines.push(
    '2. Whenever you learn something the human must know - a risk, a decision only they can make, a handoff they must accept, a constraint that changes their plan - file it with `letterbox_add` before you reply. Do not rely on prose alone: a fact buried in a long answer is exactly what gets missed.',
    'File it as a session note by default. Use `scope: "global"` only when the human asked for it, or the fact is a standing preference / cross-session rule rather than something tied to this task.',
    '',
    '## Reading the receipt',
    '- `N unacknowledged note(s)`: N notes are still unread. Call `letterbox_status` and name each one explicitly in your answer (short quote plus why it matters). Never assume the human saw it.',
    '- `the human has acknowledged all N filed note(s)`: they have read every note. Treat those notes as shared ground - speak from them, do not re-explain what they already acknowledged, do not hedge with "as I mentioned", and do not ask whether they saw it.',
    '- `nothing has been filed`: the box is empty. File what the human must know with `letterbox_add`.',
    '- If the human asks something an unacknowledged note already answers, surface that note instead of answering from memory.',
    '- One note per distinct fact. Call `letterbox_list` before adding, so the box does not fill with near-duplicates.',
  );
  return lines.join('\n');
}

/** One-line rendering shared by every tool result. */
function renderItem(item) {
  const badge = item.read ? 'read' : 'UNREAD';
  const priority = item.priority === 'high' ? '!' : ' ';
  const scope = item.scope === 'global' ? ' [global]' : '';
  return '- [' + badge + ']' + priority + ' (' + item.kind + ')' + scope + ' ' + item.text + (item.source ? ' — from ' + item.source : '');
}

/**
 * One-line rendering of an answered note: what the human picked or typed, when,
 * and enough of the note to recognise it.
 * @param item - a public item carrying `answer`.
 * @returns one line for the tool result.
 */
function renderAnswer(item) {
  const answer = item.answer;
  const text = item.text.length > 80 ? item.text.slice(0, 80) + '…' : item.text;
  const choice = answer.choice === null ? '—' : answer.choice;
  const note = answer.note === null ? '—' : answer.note;
  const at = Number.isFinite(answer.answeredAt) ? new Date(answer.answeredAt).toISOString() : '—';
  return '- ' + item.id + ' · ' + item.kind + ' · choice: ' + choice + ' · note: ' + note + ' · answeredAt: ' + at + ' · ' + text;
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

  /** The bucket a panel request addresses: this session's own, or the shared one. */
  function bucketIdOf(sessionId, bucket) {
    return bucket === 'global' ? GLOBAL_SCOPE : sessionId;
  }

  /**
   * The receipt half of a snapshot: everything that is not the item list.
   *
   * `unreadCount` describes the bucket being viewed while `globalUnreadCount`
   * always describes the shared box, so the panel can badge either view. The
   * checkpoint fields stay session-scoped: misses are a property of the
   * conversation, never of the global box.
   */
  function receiptFor(scopeId, sessionId) {
    const sessionBucket = state.sessions[sessionId];
    return {
      sessionId,
      bucket: scopeId === GLOBAL_SCOPE ? 'global' : 'session',
      unreadCount: countUnread(state, scopeId),
      globalUnreadCount: countUnread(state, GLOBAL_SCOPE),
      checkedAt: sessionBucket?.checkedAt ?? null,
      checkedTurn: sessionBucket?.checkedTurn ?? null,
      checkedThisTurn: checkedInTurn(state, sessionId, currentTurnOf(sessionId)),
      misses: sessionBucket?.misses ?? 0,
      lastMissAt: sessionBucket?.lastMissAt ?? null,
    };
  }

  function snapshotFor(scopeId, view = {}, sessionId = scopeId) {
    return { ...receiptFor(scopeId, sessionId), items: listItems(state, scopeId, view) };
  }

  /** One page plus the receipt fields; `total`/`hasMore` describe the whole set. */
  function pagedSnapshotFor(scopeId, view, sessionId = scopeId) {
    const page = pageItems(state, scopeId, view);
    return {
      ...receiptFor(scopeId, sessionId),
      items: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
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
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '1-6 candidate choices, max 60 characters each. The human sees one button per option on the card; picking one answers the note and marks it read.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'global'],
          description: 'Where the note lives. session (default) = this conversation only. global = shared across every Session; use it only when the human asked for it, or the fact is a standing preference / cross-session rule rather than something tied to the current task.',
        },
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
      const scope = payload.scope === 'global' ? 'global' : 'session';
      const scopeId = bucketIdOf(sessionId, scope);
      await ready;
      const item = addItem(state, { sessionId, payload, now: Date.now(), id: 'lb_' + randomUUID(), scope });
      trimSession(state, scopeId, config.maxItemsPerSession);
      schedulePersist();
      const where = scope === 'global' ? 'the global box' : 'this session';
      return 'filed ' + item.id + ' (' + scope + ', ' + countUnread(state, scopeId) + ' unread in ' + where + ')';
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
      const globalUnread = listItems(state, GLOBAL_SCOPE, { unreadOnly: true });
      const filed = listItems(state, sessionId);
      const globalFiled = listItems(state, GLOBAL_SCOPE);
      const stamp = 'checkpoint: recorded at ' + new Date(checkpoint.checkedAt).toISOString() + ' (turn ' + String(checkpoint.checkedTurn) + ')';
      // The header always names the bucket: two boxes with one "unread" number
      // was exactly the ambiguity this change removes.
      const head = 'unread: ' + unread.length + ' (session)'
        + (globalUnread.length > 0 ? ' · global: ' + globalUnread.length : '');
      const body = [];
      if (unread.length === 0) {
        // An empty session receipt means two different things, and the human's
        // intent depends on which: "nothing was ever filed" is not "everything
        // you filed has been acknowledged, so stop explaining what I read".
        body.push(filed.length === 0
          ? 'nothing has been filed in this session yet.'
          : 'all ' + filed.length + ' filed session note(s) are acknowledged; treat them as shared ground.');
      } else {
        for (const item of unread) body.push(renderItem(item));
      }
      if (globalUnread.length > 0) {
        body.push('global unread:');
        for (const item of globalUnread) body.push(renderItem(item));
      } else if (globalFiled.length > 0) {
        body.push('global: all ' + globalFiled.length + ' note(s) acknowledged; treat them as shared ground.');
      }
      return head + '\n' + body.join('\n') + '\n' + stamp;
    },
  });

  ctx.tools.register({
    name: 'letterbox_answer',
    description: 'Read the answers the human gave on the cards: the notes they picked an option on or replied to, newest first. Read-only - it never writes a receipt or an answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session whose box to read. Defaults to the calling session.' },
        bucket: { type: 'string', enum: ['session', 'global'], description: 'Which box: session (default) or the shared global box.' },
        id: { type: 'string', description: 'When set, only that note is reported.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const named = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : null;
      const sessionId = named ?? sessionIdOf(exec);
      if (sessionId === null) throw new Error('letterbox_answer: no calling session');
      await ready;
      const bucket = args?.bucket === 'global' ? 'global' : 'session';
      const scopeId = bucketIdOf(sessionId, bucket);
      const wanted = typeof args?.id === 'string' && args.id !== '' ? args.id : null;
      // Only answered notes are reported: an unread card is still open, and this
      // tool exists to read a decision the human already made.
      const answered = listItems(state, scopeId)
        .filter((item) => item.answer !== null && item.answer !== undefined)
        .filter((item) => wanted === null || item.id === wanted)
        .sort((left, right) => (right.answer.answeredAt ?? 0) - (left.answer.answeredAt ?? 0));
      if (answered.length === 0) {
        return wanted === null
          ? 'no answers in this ' + bucket + ' box yet: every card is still waiting for the human.'
          : 'no answer for ' + wanted + ' in this ' + bucket + ' box yet.';
      }
      return answered.slice(0, 20).map(renderAnswer).join('\n');
    },
  });

  // ── turn bookkeeping and the miss gate ────────────────────────────────
  // The host owns "this turn": a turn id is minted on turn/start, and turn/end
  // checks whether letterbox_status ran while it was open. A miss is only owed
  // when something was actually left unacknowledged - with an empty receipt the
  // agent is told not to check, so charging it for not checking would be a lie.
  // Only a completed turn can miss: an interrupted one never reached the human.
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
      warn('letterbox: turn ' + turn + ' ended with unacknowledged notes and no letterbox_status call (miss #' + misses + ')');
      try {
        ctx.emit?.('letterbox/miss', { sessionId: id, turn, misses });
      } catch {
        /* the event is advisory; a listener must never break the turn */
      }
    });
  });

  // ── per-Agent receipt line ────────────────────────────────────────────
  // The agent must know the box's state without asking for it: "everything is
  // acknowledged, do not check this turn" is a fact only the host can assert,
  // and silence is exactly how a stale assumption survives. One line is pushed
  // into every turn of every live Agent through that Agent's own prompt scope,
  // and its `text` is a thunk: the prompt is assembled per turn, so the line
  // always describes the ledger as it is right now, not as it was at install.
  function receiptLine(sessionId) {
    // Before hydration the ledger is unknown; an empty contribution is dropped
    // by the prompt renderer, which beats claiming either state and being wrong.
    if (!hydrated) return '';
    const unread = countUnread(state, sessionId);
    const globalUnread = countUnread(state, GLOBAL_SCOPE);
    if (unread > 0) {
      return 'Letterbox: ' + unread + ' unacknowledged note(s) in this Session'
        + (globalUnread > 0 ? ' (plus ' + globalUnread + ' unacknowledged in the global box)' : '')
        + '. Call letterbox_status before your final answer and name each one explicitly.';
    }
    if (globalUnread > 0) {
      // A global-only backlog never charges a miss - misses count session notes -
      // but staying silent would let the agent claim there is nothing to know.
      return 'Letterbox: this Session has nothing unacknowledged, but the global box has ' + globalUnread + ' unacknowledged note(s). You do not need to check the box this turn - mention them only if they matter here.';
    }
    const filed = listItems(state, sessionId).length;
    if (filed === 0) {
      return 'Letterbox: nothing has been filed in this Session yet. File anything the human must know with letterbox_add.';
    }
    return 'Letterbox: the human has acknowledged all ' + filed + ' filed note(s) in this Session. You do not need to check the box this turn; treat those notes as shared ground - do not re-explain them and do not ask whether they were seen.';
  }

  ctx.inject(['agents'], (scoped) => {
    const installed = new Map();
    const install = (agent) => {
      if (installed.has(agent)) return;
      const sessionId = agent?.session?.id;
      const systemPrompt = agent?.ctx?.systemPrompt;
      if (typeof sessionId !== 'string' || sessionId === '' || typeof systemPrompt?.context !== 'function') return;
      // A context entry belongs to the Agent's scope, so it is registered
      // through that Agent's own ctx; the placement sits right after the
      // delegation block, before the harness-source context.
      const base = systemPrompt.getContextOrder?.('SUBAGENT_DELEGATION');
      installed.set(agent, systemPrompt.context({
        name: 'letterbox:receipt',
        order: Number.isFinite(base) ? base + 1 : 121,
        required: true,
        text: () => receiptLine(sessionId),
      }));
    };
    const release = (agent) => {
      const dispose = installed.get(agent);
      if (dispose === undefined) return;
      installed.delete(agent);
      dispose();
    };
    for (const agent of scoped.agents.list()) install(agent);
    scoped.on('agent/created', ({ agent }) => { install(agent); });
    scoped.on('agent/disposed', ({ agent }) => { release(agent); });
    scoped.effect(() => () => {
      for (const dispose of installed.values()) dispose();
      installed.clear();
    }, 'letterbox: receipt lines');
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
          // `scope` picks the view the panel is showing; `all` stays the default
          // so an older browser half keeps working. `query` only narrows the
          // list - the receipt fields are always the whole session's.
          //
          // Paging is opt-in: a caller that sends `limit` gets one page plus
          // `total`/`hasMore`; a caller that does not keeps the old full-array
          // shape, byte-compatible with an older browser half.
          const requested = body?.scope;
          const scope = requested === 'unread' || requested === 'history' ? requested : 'all';
          const query = typeof body?.query === 'string' ? body.query : '';
          // `bucket` selects which box, `scope` selects which slice of it; the
          // two are orthogonal on purpose.
          const bucket = body?.bucket === 'global' ? 'global' : 'session';
          const scopeId = bucketIdOf(sessionId, bucket);
          if (body?.limit === undefined) {
            sendJson(res, 200, { ok: true, value: snapshotFor(scopeId, { scope, query }, sessionId) });
            return;
          }
          sendJson(res, 200, { ok: true, value: pagedSnapshotFor(scopeId, { scope, query, limit: body.limit, offset: body.offset }, sessionId) });
          return;
        }
        if (endpoint === 'read') {
          if (typeof body?.id !== 'string' || body.id === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id must be a non-empty string' } });
            return;
          }
          // A global note is acknowledged in the global bucket, so the read
          // carries the same bucket selector the list does.
          const bucket = body?.bucket === 'global' ? 'global' : 'session';
          const scopeId = bucketIdOf(sessionId, bucket);
          const changed = markRead(state, { sessionId: scopeId, id: body.id, now: Date.now() });
          if (changed) schedulePersist();
          sendJson(res, 200, { ok: true, value: { ...snapshotFor(scopeId, {}, sessionId), changed } });
          return;
        }
        if (endpoint === 'answer') {
          // The card offers exactly two ways to finish: pick an option, or type
          // a one-line reply. Both land here, and both acknowledge the note in
          // the same write - a half-answered note would be a state no reader of
          // the receipt could interpret.
          if (typeof body?.id !== 'string' || body.id === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id must be a non-empty string' } });
            return;
          }
          const choice = typeof body?.choice === 'string' && body.choice.trim() !== '' ? body.choice.trim() : null;
          const note = typeof body?.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
          if (choice === null && note === null) {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'choice or note must be a non-empty string' } });
            return;
          }
          if ((choice !== null && choice.length > MAX_OPTION_LENGTH) || (note !== null && note.length > MAX_TEXT)) {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'answer is too long' } });
            return;
          }
          const bucket = body?.bucket === 'global' ? 'global' : 'session';
          const scopeId = bucketIdOf(sessionId, bucket);
          const changed = applyAnswer(state, { sessionId: scopeId, id: body.id, choice, note, now: Date.now() });
          if (changed) schedulePersist();
          sendJson(res, 200, { ok: true, value: { ...snapshotFor(scopeId, {}, sessionId), changed } });
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
