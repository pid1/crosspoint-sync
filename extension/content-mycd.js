/**
 * Content script for the Manage Your Content & Devices page (all regions).
 * Performs the Send-to-Kindle library fetch IN THE PAGE'S OWN CONTEXT: same-origin
 * fetch, the page's cookies and Sec-Fetch headers — indistinguishable from the
 * site's own requests, which is what gets past Amazon's WAF (the extension
 * background worker's cross-origin POST is answered with an HTML challenge).
 */

(async () => {
  const { parseCsrfToken, parseOwnershipData } = await import(chrome.runtime.getURL('lib.mjs'));

  async function scrapePdocs() {
    const csrf = parseCsrfToken(document.documentElement.innerHTML);
    if (!csrf) {
      throw new Error('log into Amazon in this tab, then hit "Sync library now" again');
    }
    const items = [];
    let startIndex = 0;
    for (;;) {
      const res = await fetch('/hz/mycd/digital-console/contentlist/ownedItems/resources', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'anti-csrftoken-a2z': csrf,
        },
        body: `param=${encodeURIComponent(JSON.stringify({ contentType: 'KindlePDoc', startIndex, batchSize: 100 }))}`,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`MYCD library fetch -> HTTP ${res.status}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('MYCD returned HTML instead of JSON — reload this tab, make sure you are logged in, and retry');
      }
      const { items: batch, total } = parseOwnershipData(json);
      items.push(...batch);
      startIndex += batch.length;
      if (batch.length === 0 || startIndex >= total) break;
    }
    return items;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'scrape-pdocs') return undefined;
    scrapePdocs().then(
      (items) => sendResponse({ ok: true, items }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) })
    );
    return true; // async response
  });
})();
