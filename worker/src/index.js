// AI Chat → Notion Sync — raw markdown sink (Cloudflare Worker, R2-backed).
//
// Stores one markdown object per conversation (and per file) in R2, served at a
// stable URL so an AI can fetch the full history directly.
//
//   GET  /conv/{path}  → raw markdown (public; unlisted via unguessable id)
//   PUT  /conv/{path}  → overwrite (auth)    — used for first sync / reset
//   POST /conv/{path}  → append   (auth)     — used for incremental turns
//
// Each conversation gets its own folder; the path maps to an R2 key (.md):
//   /conv/{convId}            → conv/{convId}/conversation.md  (the conversation)
//   /conv/{convId}/files/f0   → conv/{convId}/files/f0.md      (a file in it)
//
// Auth: writes require `Authorization: Bearer <WRITE_TOKEN>` (a Worker secret).
// Reads are public. See README.md for deploy steps.
//
// Note: POST is a read-modify-write (GET + concat + PUT). R2 has no atomic
// append, but its strong read-after-write consistency means the GET sees the
// latest value; the extension also serializes writes per conversation, so
// concurrent RMW on the same id doesn't lose updates.

// Match /conv/{id} or /conv/{id}/{sub...}. Segments: letters, digits, _ - .
const PATH_RE = /^\/conv\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)$/;

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    ...extra,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const { pathname } = new URL(request.url);
    const match = pathname.match(PATH_RE);
    if (!match) return new Response('Not found', { status: 404, headers: cors() });
    const id = match[1];
    const sub = match[2]; // '' for the conversation, '/files/f0' for a file
    if ((id + sub).includes('..')) return new Response('Bad path', { status: 400, headers: cors() });
    // Everything for a conversation lives under conv/{id}/; body is conversation.md.
    const key = sub ? `conv/${id}${sub}.md` : `conv/${id}/conversation.md`;

    if (request.method === 'GET') {
      const obj = await env.BUCKET.get(key);
      if (obj == null) return new Response('Not found', { status: 404, headers: cors() });
      return new Response(obj.body, {
        headers: cors({ 'Content-Type': 'text/markdown; charset=utf-8' }),
      });
    }

    // Writes require auth.
    const auth = request.headers.get('Authorization') || '';
    if (!env.WRITE_TOKEN || auth !== `Bearer ${env.WRITE_TOKEN}`) {
      return new Response('Unauthorized', { status: 401, headers: cors() });
    }
    const body = await request.text();

    if (request.method === 'PUT') {
      await env.BUCKET.put(key, body);
      return new Response('OK', { headers: cors() });
    }
    if (request.method === 'POST') {
      const obj = await env.BUCKET.get(key);
      const existing = obj ? await obj.text() : '';
      await env.BUCKET.put(key, existing + body);
      return new Response('OK', { headers: cors() });
    }
    return new Response('Method not allowed', { status: 405, headers: cors() });
  },
};
