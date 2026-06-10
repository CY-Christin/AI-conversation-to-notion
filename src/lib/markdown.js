// Conversation → markdown. Used by the Cloudflare (raw md) sink; the output is
// meant to be read by an AI, so it stays close to plain readable markdown.
// Claude's assistant text is already markdown source, so we mostly pass it
// through; files are inlined (the AI can't fetch links reliably).

function when(ts) {
  return (ts || '').slice(0, 16).replace('T', ' ');
}

function fileBlock(f) {
  const fence = f.content.includes('```') ? '````' : '```';
  return `\n> 📎 **${f.name}**\n\n${fence}\n${f.content}\n${fence}\n`;
}

function quote(text) {
  return text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

// fileUrlFor(file) → a URL when files are stored separately (link to it), or
// null/undefined to inline the content (fallback).
export function messageToMarkdown(m, fileUrlFor) {
  const who = m.role === 'human' ? '🧑 You' : '🤖 Claude';
  const t = when(m.createdAt);
  let out = `\n## ${who}${t ? ' · ' + t : ''}\n\n`;
  for (const s of m.segments || []) {
    if (s.kind === 'text') out += s.text.trim() + '\n';
    else if (s.kind === 'thinking') out += `\n> 💭 _thinking_\n>\n${quote(s.text.trim())}\n`;
    else if (s.kind === 'tool_use') out += `\n> 🔧 \`${s.name || 'tool'}\`\n`;
    // tool_result is omitted (often large/noisy); revisit if needed.
  }
  for (const f of m.files || []) {
    if (!f.content) continue;
    const url = fileUrlFor && fileUrlFor(f);
    out += url ? `\n> 📎 [${f.name}](${url})\n` : fileBlock(f);
  }
  return out;
}

export function conversationHeader(conv) {
  return `# ${conv.title || '(untitled)'}\n\n_${conv.platform} · ${conv.url}_\n`;
}

export function messagesToMarkdown(messages, fileUrlFor) {
  return messages.map((m) => messageToMarkdown(m, fileUrlFor)).join('\n');
}
