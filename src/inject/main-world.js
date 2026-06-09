// MAIN-world injected script — runs in the page's JS context at document_start.
//
// Capture WITHOUT monkey-patching window.fetch/XHR, so we coexist with other
// extensions/userscripts that also hook fetch (e.g. Tampermonkey export tools).
// We only ever ISSUE our own canonical refetch; we never intercept the app's
// request bodies.
//
// Two conflict-free triggers, both ending in "refetch the canonical conversation":
//   1. URL change to /chat/{convId}  — open / switch / new→chat / cross-device.
//      org id comes from the `lastActiveOrg` cookie, conv id from the path.
//   2. completion finished           — follow-up turns in the SAME conversation,
//      detected via PerformanceObserver on the `.../completion` resource entry
//      (reads URL + timing only, touches nobody's fetch).
//
// It never touches chrome.* (no access from MAIN world) and only forwards the
// conversation object — never cookies/auth headers.
//
// NOTE: Claude endpoint/cookie shapes are the per-platform "capture config".
// When we add real adapters this moves into a Claude adapter module.

(() => {
  if (window.__acnsInstalled) return;
  window.__acnsInstalled = true;

  const TAG = 'acns';
  const PLATFORM = 'claude';

  // Capture whatever fetch is current — used ONLY to issue our own GET. We don't
  // care if it's native or someone's wrapper; a plain GET passes through.
  const issueFetch = window.fetch.bind(window);

  // ---- Claude capture config -------------------------------------------------
  const RE_CONV_PATH = /\/chat\/([0-9a-fA-F-]{36})/;
  const RE_COMPLETION =
    /\/api\/organizations\/([0-9a-f-]+)\/chat_conversations\/([0-9a-f-]+)\/(?:completion|retry_completion)/i;

  function getOrgId() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function getConvIdFromPath() {
    const m = location.pathname.match(RE_CONV_PATH);
    return m ? m[1] : null;
  }
  function convUrl(org, conv) {
    return `${location.origin}/api/organizations/${org}/chat_conversations/${conv}` +
      `?tree=True&rendering_mode=messages&render_all_tools=true`;
  }

  // ---- bridge out ------------------------------------------------------------
  function post(type, payload) {
    window.postMessage({ __source: TAG, platform: PLATFORM, type, payload }, location.origin);
  }

  // ---- canonical refetch (the only network call we make) ---------------------
  const lastRefetch = new Map(); // convId -> ts (debounce bursts of triggers)
  async function refetchConversation(org, conv, reason) {
    if (!org || !conv) return;
    const now = Date.now();
    if (now - (lastRefetch.get(conv) || 0) < 1200) return;
    lastRefetch.set(conv, now);
    try {
      console.log(`%c[ACNS] refetch (${reason}) conv=${conv}`, 'color:#7c6cff');
      const res = await issueFetch(convUrl(org, conv), { credentials: 'include' });
      if (!res.ok) {
        // New conversations 404 briefly: the URL flips to /chat/{id} before the
        // server has created it. Retry once after it settles.
        if (res.status === 404 && !reason.endsWith(':retry')) {
          setTimeout(() => refetchConversation(org, conv, reason + ':retry'), 1500);
        } else {
          post('error', { stage: 'refetch', status: res.status, conv });
        }
        return;
      }
      post('conversation', { source: reason, raw: await res.json() });
    } catch (e) {
      post('error', { stage: 'refetch', message: String(e), conv });
    }
  }
  function triggerForCurrentUrl(reason) {
    const conv = getConvIdFromPath();
    if (conv) refetchConversation(getOrgId(), conv, reason);
  }

  // ---- Trigger 1: URL → /chat/{id} -------------------------------------------
  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    queueMicrotask(() => triggerForCurrentUrl('url:push'));
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    queueMicrotask(() => triggerForCurrentUrl('url:replace'));
    return r;
  };
  window.addEventListener('popstate', () => triggerForCurrentUrl('url:popstate'));

  // Fallback poll for navigations the history hooks miss.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      triggerForCurrentUrl('url:poll');
    }
  }, 1000);

  // Initial load (covers hard-loading /chat/{id} directly).
  triggerForCurrentUrl('initial');

  // ---- Trigger 2: completion finished ----------------------------------------
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const m = String(e.name || '').match(RE_COMPLETION);
        if (m) {
          console.log('%c[ACNS] completion observed → refetch', 'color:#10b981', m[2]);
          refetchConversation(m[1], m[2], 'completion');
        }
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {
    console.warn('[ACNS] PerformanceObserver unavailable', e);
  }

  console.log(
    '%c[ACNS] capture installed (URL + PerformanceObserver, no fetch patch)',
    'color:#7c6cff;font-weight:bold'
  );
})();
