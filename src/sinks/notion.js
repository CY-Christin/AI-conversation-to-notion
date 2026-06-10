// Notion sink — one of the pluggable landing channels (see sinks/registry.js).
//
// Implements the sink contract: { id, name, configFields, sync(config, conv,
// alreadySynced) → { newlySynced, ref } }. Config (token + root page id) is
// passed in by the caller (resolved from chrome.storage / settings page), not
// read here.
//
// Behavior: ensure structure (root page → "Claude" page → "Claude Conversations"
// db, ids cached), upsert one row-page per conversation keyed by "Conversation
// ID" (idempotent), then append fresh messages as blocks (markdown via martian),
// respecting Notion API limits.

import { markdownToBlocks } from '@tryfabric/martian';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

const DB_NAME = 'Claude Conversations';
const PLATFORM_PAGE = 'Claude';

// Property names (Chinese, per design). Centralized so a rename is one edit.
const PROP = {
  title: '标题',
  date: '时间',
  turns: '轮次',
  url: '会话链接',
  convId: 'Conversation ID',
};

// ---- low-level fetch with rate-limit handling ------------------------------
async function napi(token, path, method = 'GET', body) {
  const url = path.startsWith('http') ? path : `${NOTION}${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network/CORS failures surface as TypeError("Failed to fetch").
      throw new Error(
        `[notion] request failed (network/CORS?) for ${method} ${path}: ${e.message}. ` +
        `If this persists, the extension may need a relay (see requirements §7.3).`
      );
    }
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('Retry-After') || '1', 10) || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`[notion] ${res.status} ${method} ${path}: ${data.message || text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error(`[notion] gave up after retries: ${method} ${path}`);
}

// ---- structure (cached) ----------------------------------------------------
// List all child blocks of a page (handles pagination).
async function listChildren(token, blockId) {
  const out = [];
  let cursor = null;
  do {
    const qs = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await napi(token, `/blocks/${blockId}/children${qs}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// Find an existing child page / database by exact title (returns its id or null).
// Trashed items don't appear in children, so this naturally ignores deleted ones.
async function findChildByTitle(token, parentId, type, title) {
  const children = await listChildren(token, parentId);
  const hit = children.find((b) => b.type === type && b[type]?.title === title);
  return hit?.id || null;
}

// Ensure root → "Claude" page → "Claude Conversations" db exist. Source of truth
// is Notion's ACTUAL content: we look up existing items by title and reuse them,
// creating only what's missing — so a stale cache, a renamed/recreated structure,
// or a user-deleted db can't cause duplicates. The cache is only a fast path.
async function ensureStructure(cfg) {
  const cacheKey = `notionStruct:${cfg.rootPageId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];

  // Fast path: cached db still live (not deleted/trashed) → use it as-is.
  if (cached?.dbId) {
    try {
      const db = await napi(cfg.token, `/databases/${cached.dbId}`);
      if (!db.archived && !db.in_trash) return cached;
    } catch (e) {
      if (e.status !== 404) throw e; // 404 → fall through to discovery
    }
  }

  // Slow path: discover by title, create only what's missing.
  await napi(cfg.token, '/users/me'); // connectivity + token check

  let claudePageId = await findChildByTitle(cfg.token, cfg.rootPageId, 'child_page', PLATFORM_PAGE);
  if (!claudePageId) {
    const page = await napi(cfg.token, '/pages', 'POST', {
      parent: { type: 'page_id', page_id: cfg.rootPageId },
      properties: { title: { title: [{ text: { content: PLATFORM_PAGE } }] } },
    });
    claudePageId = page.id;
  }

  let dbId = await findChildByTitle(cfg.token, claudePageId, 'child_database', DB_NAME);
  if (!dbId) {
    const db = await napi(cfg.token, '/databases', 'POST', {
      parent: { type: 'page_id', page_id: claudePageId },
      title: [{ text: { content: DB_NAME } }],
      properties: {
        [PROP.title]: { title: {} },
        [PROP.date]: { date: {} },
        [PROP.turns]: { number: {} },
        [PROP.url]: { url: {} },
        [PROP.convId]: { rich_text: {} },
      },
    });
    dbId = db.id;
  }

  const struct = { claudePageId, dbId };
  await chrome.storage.local.set({ [cacheKey]: struct });
  return struct;
}

// ---- conversation row (idempotent by Conversation ID) ----------------------
async function upsertConversationRow(cfg, dbId, conv, turns) {
  const props = {
    [PROP.title]: { title: [{ text: { content: conv.title || '(untitled)' } }] },
    [PROP.turns]: { number: turns },
    [PROP.url]: { url: conv.url },
    [PROP.convId]: { rich_text: [{ text: { content: conv.id } }] },
  };
  if (conv.updatedAt) props[PROP.date] = { date: { start: conv.updatedAt } };

  const q = await napi(cfg.token, `/databases/${dbId}/query`, 'POST', {
    filter: { property: PROP.convId, rich_text: { equals: conv.id } },
    page_size: 1,
  });

  if (q.results?.length) {
    const pageId = q.results[0].id;
    await napi(cfg.token, `/pages/${pageId}`, 'PATCH', { properties: props });
    return pageId;
  }
  const page = await napi(cfg.token, '/pages', 'POST', {
    parent: { type: 'database_id', database_id: dbId },
    properties: props,
  });
  return page.id;
}

// ---- block builders --------------------------------------------------------
const MAX_TEXT = 2000;
const MAX_CHILDREN = 100;

function chunk(str, n = MAX_TEXT) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out.length ? out : [''];
}

function paragraphBlocks(text) {
  const blocks = [];
  for (const para of String(text).split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    for (const c of chunk(t)) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: c } }] },
      });
    }
  }
  return blocks;
}

function toggleBlock(label, text) {
  // Toggle children submitted inline → keep within depth 2 and ≤100 children.
  const children = paragraphBlocks(text).slice(0, MAX_CHILDREN);
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: label } }],
      children,
    },
  };
}

function speakerCallout(message) {
  const human = message.role === 'human';
  const when = (message.createdAt || '').slice(0, 16).replace('T', ' ');
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: `${human ? 'You' : 'Claude'}${when ? ' · ' + when : ''}` } }],
      icon: { type: 'emoji', emoji: human ? '🧑' : '🤖' },
      color: human ? 'gray_background' : 'blue_background',
    },
  };
}

function asText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// Render markdown → Notion blocks via martian (headings/lists/code/quotes/bold…).
// martian truncates to Notion limits by default. Fall back to plain paragraphs
// if it ever throws on odd input.
function mdBlocks(text) {
  try {
    const blocks = markdownToBlocks(text, { notionLimits: { truncate: true } });
    return blocks.length ? blocks : paragraphBlocks(text);
  } catch (_) {
    return paragraphBlocks(text);
  }
}

function buildMessageBlocks(message) {
  const blocks = [speakerCallout(message)];
  // Walk segments in original order → tool calls appear before the answer text,
  // matching how the turn actually unfolded.
  const segs = message.segments?.length
    ? message.segments
    : message.text
      ? [{ kind: 'text', text: message.text }]
      : [];
  for (const s of segs) {
    if (s.kind === 'text') blocks.push(...mdBlocks(s.text));
    // thinking / tools stay plain-text inside toggles: martian's nested output
    // could exceed Notion's 2-level depth limit when wrapped in a toggle.
    else if (s.kind === 'thinking') blocks.push(toggleBlock('💭 Thinking', s.text));
    else if (s.kind === 'tool_use')
      blocks.push(toggleBlock(`🔧 Tool: ${s.name || 'unknown'}`, asText(s.input).slice(0, MAX_TEXT * 2)));
    else if (s.kind === 'tool_result')
      blocks.push(toggleBlock(`📥 Result${s.name ? ': ' + s.name : ''}`, asText(s.result).slice(0, MAX_TEXT * 2)));
  }
  return blocks;
}

async function appendInBatches(token, pageId, blocks) {
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN) {
    await napi(token, `/blocks/${pageId}/children`, 'PATCH', {
      children: blocks.slice(i, i + MAX_CHILDREN),
    });
  }
}

// Create a child page (under the conversation page) holding a file's markdown.
// Created right after its message body is appended, so Notion places it in the
// conversation flow at the correct position — no extra back-link needed.
async function createFileChildPage(token, parentPageId, file) {
  const page = await napi(token, '/pages', 'POST', {
    parent: { type: 'page_id', page_id: parentPageId },
    properties: { title: { title: [{ text: { content: file.name || '(file)' } }] } },
  });
  await appendInBatches(token, page.id, mdBlocks(file.content));
  return page.id;
}

// ---- sink ------------------------------------------------------------------
// Writes fresh (not-yet-synced) messages. Returns ids that were successfully
// written, so the caller marks them synced only after a durable write.
async function sync(config, conv, alreadySynced) {
  const turns = conv.messages.filter((m) => m.role === 'assistant').length;
  const { dbId } = await ensureStructure(config);
  const pageId = await upsertConversationRow(config, dbId, conv, turns);

  const newlySynced = [];
  for (const m of conv.messages) {
    if (alreadySynced.has(m.id)) continue;
    await appendInBatches(config.token, pageId, buildMessageBlocks(m));
    // md files → child pages, appended right after this message's body.
    for (const f of m.files || []) {
      if (f.content) await createFileChildPage(config.token, pageId, f);
    }
    newlySynced.push(m.id); // per-message durability boundary
  }
  return { newlySynced, ref: pageId };
}

export const notionSink = {
  id: 'notion',
  name: 'Notion',
  configFields: [
    {
      key: 'token',
      label: 'Integration Token',
      type: 'password',
      placeholder: 'ntn_...',
      required: true,
      help: '在 notion.so/my-integrations 建 Internal integration 获取',
    },
    {
      key: 'rootPageId',
      label: 'Root Page ID',
      type: 'text',
      placeholder: '32 位十六进制（取自 page URL）',
      required: true,
      help: '先把 integration 加到该 page 的 Connections 授权',
    },
  ],
  sync,
};
