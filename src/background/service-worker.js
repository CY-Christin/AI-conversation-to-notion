// Background service worker — receives captured conversations, normalizes them
// to the common ConversationModel, diffs by message id against locally-seen ids,
// and logs what we WOULD write to Notion.
//
// M1 scope: NO Notion writes. We persist "seen" message ids so you can watch the
// diff work: first open = all new; reopen = 0 new; new turn = +1..2 new.
// To reset the demo, open this worker's DevTools console and run:
//     chrome.storage.local.clear()

// ---- Claude normalize (per-platform; will move into an adapter later) --------
function collectFiles(m) {
  const out = [];
  const push = (arr, kind) => {
    if (Array.isArray(arr)) {
      for (const f of arr) {
        out.push({ name: f.file_name || f.name || f.title || '(file)', kind });
      }
    }
  };
  push(m.attachments, 'attachment');
  push(m.files, 'file');
  push(m.files_v2, 'file');
  return out;
}

function normalizeClaude(raw) {
  const messages = (raw.chat_messages || []).map((m) => {
    const role = m.sender === 'human' ? 'human' : 'assistant';
    const content = Array.isArray(m.content) ? m.content : [];
    let text = '';
    const thinking = [];
    const tools = [];
    for (const c of content) {
      if (c.type === 'text') text += c.text || '';
      else if (c.type === 'thinking') thinking.push(c.thinking || c.text || '');
      else if (c.type === 'tool_use') tools.push({ name: c.name, input: c.input });
      else if (c.type === 'tool_result') tools.push({ name: c.name, result: c.content });
    }
    if (!text && m.text) text = m.text; // fallback for older shapes
    return {
      id: m.uuid,
      role,
      createdAt: m.created_at,
      text,
      thinking,
      tools,
      files: collectFiles(m),
    };
  });

  return {
    id: raw.uuid,
    platform: 'claude',
    title: raw.name || '(untitled)',
    url: `https://claude.ai/chat/${raw.uuid}`,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    messages,
  };
}

const NORMALIZERS = { claude: normalizeClaude };

// ---- diff + log --------------------------------------------------------------
function preview(text, n = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function handleConversation(platform, raw) {
  const normalize = NORMALIZERS[platform];
  if (!normalize) return;
  const conv = normalize(raw);

  const key = `synced:${conv.platform}:${conv.id}`;
  const stored = (await chrome.storage.local.get(key))[key] || { messageIds: [] };
  const seen = new Set(stored.messageIds);
  const fresh = conv.messages.filter((m) => !seen.has(m.id));
  const turns = conv.messages.filter((m) => m.role === 'assistant').length;

  console.groupCollapsed(
    `%c[ACNS] ${conv.platform} · ${conv.title}`,
    'color:#7c6cff;font-weight:bold'
  );
  console.log('conversation id :', conv.id);
  console.log('messages total  :', conv.messages.length);
  console.log('already seen    :', seen.size);
  console.log('NEW this capture:', fresh.length);
  console.log('turns (AI 答完) :', turns);
  for (const m of fresh) {
    const tags = [
      m.thinking.length ? `thinking×${m.thinking.length}` : '',
      m.tools.length ? `tools×${m.tools.length}` : '',
      m.files.length ? `files:[${m.files.map((f) => f.name).join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`  + [${m.role}] ${preview(m.text)}${tags ? '  ' + tags : ''}`);
  }
  console.groupEnd();

  // M1: mark fresh ids as "seen" so the diff is observable across captures.
  // (In M2 this becomes "mark seen ONLY after a successful Notion write".)
  if (fresh.length) {
    const messageIds = [...seen, ...fresh.map((m) => m.id)];
    await chrome.storage.local.set({ [key]: { messageIds, title: conv.title } });
  }
}

// ---- message intake ----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.kind !== 'capture') return;
  if (msg.type === 'conversation' && msg.payload && msg.payload.raw) {
    handleConversation(msg.platform, msg.payload.raw).catch((e) =>
      console.warn('[ACNS] handle error', e)
    );
  } else if (msg.type === 'error') {
    console.warn('[ACNS] capture error', msg.payload);
  }
  // No async response needed.
});

console.log('[ACNS] background ready');
