// ISOLATED-world content script — the only side that can talk to chrome.*.
// It just relays tagged page messages from the MAIN-world hook to the background.

(() => {
  const TAG = 'acns';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== TAG) return;

    // After an extension reload, this (now-stale) content script's context is
    // invalidated: chrome.runtime.id goes undefined and sendMessage throws
    // SYNCHRONOUSLY (so .catch can't help). Guard, then try/catch the race.
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime
        .sendMessage({
          kind: 'capture',
          platform: msg.platform,
          type: msg.type,
          payload: msg.payload,
        })
        .catch(() => {
          // Background asleep/reloading; capture re-fires on next trigger.
        });
    } catch (_) {
      // Context invalidated between the guard and the call — ignore.
    }
  });
})();
