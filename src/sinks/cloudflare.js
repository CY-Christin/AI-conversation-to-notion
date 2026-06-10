// Cloudflare sink — pushes each conversation as raw markdown to the Worker
// (see worker/), giving a stable URL an AI can fetch. Implements the sink
// contract { id, name, configFields, sync }.
//
// Strategy mirrors Notion's message-id diff, but lands as markdown:
//  - first sync / reset (alreadySynced empty) → full document via PUT (overwrite,
//    so a re-sync can't duplicate),
//  - incremental turns → only fresh messages via POST (server-side append).

import { conversationHeader, messagesToMarkdown } from '../lib/markdown.js';

async function send(url, method, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
    body,
  });
  if (!res.ok) {
    throw new Error(`[cloudflare] ${res.status} ${method} ${url}: ${await res.text()}`);
  }
}

async function sync(config, conv, alreadySynced) {
  const base = String(config.workerUrl).replace(/\/+$/, '');
  const url = `${base}/conv/${conv.id}`;

  const fresh = conv.messages.filter((m) => !alreadySynced.has(m.id));
  if (!fresh.length) return { newlySynced: [], ref: url };

  const isFirst = alreadySynced.size === 0;

  // Files are stored as SEPARATE docs under the conversation's folder, e.g.
  // /conv/{convId}/files/f0. Assign each file a stable index by its order across
  // the whole conversation, so links don't shift between syncs (PUT overwrites).
  const fileUrlMap = new Map();
  let idx = 0;
  for (const m of conv.messages) {
    for (const f of m.files || []) {
      if (f.content) fileUrlMap.set(f, `${base}/conv/${conv.id}/files/f${idx++}`);
    }
  }
  const fileUrlFor = (f) => fileUrlMap.get(f) || null;

  // Upload the files belonging to the messages we're writing this round.
  for (const m of isFirst ? conv.messages : fresh) {
    for (const f of m.files || []) {
      if (f.content) await send(fileUrlMap.get(f), 'PUT', config.writeToken, f.content);
    }
  }

  // Then write the conversation md (files referenced as links).
  if (isFirst) {
    const md = conversationHeader(conv) + '\n' + messagesToMarkdown(conv.messages, fileUrlFor);
    await send(url, 'PUT', config.writeToken, md);
  } else {
    await send(url, 'POST', config.writeToken, '\n' + messagesToMarkdown(fresh, fileUrlFor));
  }
  return { newlySynced: fresh.map((m) => m.id), ref: url };
}

export const cloudflareSink = {
  id: 'cloudflare',
  name: 'Cloudflare (raw markdown)',
  configFields: [
    {
      key: 'workerUrl',
      label: 'Worker URL',
      type: 'text',
      placeholder: 'https://ai-chat-md.<you>.workers.dev',
      required: true,
      help: '部署 worker/ 后得到的地址',
    },
    {
      key: 'writeToken',
      label: 'Write Token',
      type: 'password',
      placeholder: '与 worker 的 WRITE_TOKEN 一致',
      required: true,
      help: '写入鉴权，需与 Worker secret 相同',
    },
  ],
  sync,
};
