// Sink registry — the list of landing channels. Add a channel by implementing
// the sink contract ({ id, name, configFields, sync }) and pushing it here; the
// settings page and the background sync loop both pick it up automatically.
import { notionSink } from './notion.js';
import { cloudflareSink } from './cloudflare.js';

export const SINKS = [notionSink, cloudflareSink];

export function getSink(id) {
  return SINKS.find((s) => s.id === id) || null;
}
