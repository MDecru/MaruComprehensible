// Proxy Jisho API calls — background service workers bypass CORS reliably
// Also proxy YouTube timedtext fetches — content script fetches can be blocked
// by uBlock Origin via chrome.webRequest, but service worker requests are not
// associated with a tab and bypass that filtering.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'fetchText') {
    if (!sender?.tab?.id) { reply({ ok: false, status: 0, text: '', error: 'no tab context' }); return; }
    // Execute fetch inside the YouTube page (MAIN world) so the browser sends
    // YouTube's own session cookies and sets Origin: https://www.youtube.com.
    // Fetching from the service worker or content script sends a chrome-extension
    // origin that YouTube silently rejects with an empty 200 body.
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: async (url) => {
        try {
          const r = await fetch(url);
          const text = await r.text();
          return { ok: r.ok, status: r.status, text };
        } catch (e) {
          return { ok: false, status: 0, text: '', error: e.message };
        }
      },
      args: [msg.url],
    }).then(results => {
      reply(results?.[0]?.result || { ok: false, status: 0, text: '' });
    }).catch(e => reply({ ok: false, status: 0, text: '', error: String(e) }));
    return true;
  }
  if (msg.action !== 'jishoLookup') return;
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(msg.word)}`;
  fetch(url)
    .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
    .then(data => {
      const hit = (data.data || []).find(e =>
        e.japanese?.some(j => j.word === msg.word || j.reading === msg.word)
      ) || data.data?.[0];
      if (!hit) { reply({ ok: false }); return; }
      const reading = hit.japanese?.[0]?.reading || '';
      const senses  = (hit.senses || []).slice(0, 3).map(s => ({
        defs: s.english_definitions?.slice(0, 4) || [],
        pos:  s.parts_of_speech?.[0] || '',
      })).filter(s => s.defs.length);
      reply({ ok: true, reading, senses });
    })
    .catch(e => reply({ ok: false, error: String(e) }));
  return true; // async
});
