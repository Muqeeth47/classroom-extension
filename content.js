// Runs on classroom.google.com. Answers the popup's SCAN request by scrolling the Classwork page
// until every post is loaded, then returning the list of post links (with a best-effort topic).

(() => {
  if (window.__classroomBulkDownloaderLoaded) return;
  window.__classroomBulkDownloaderLoaded = true;

  const ITEM_PATH = /^(.*\/c\/[^/]+\/(?:a|m|sp|qs)\/[^/?#]+)/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function collectLinks() {
    const byUrl = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (u.origin !== location.origin) continue;
      const m = u.pathname.match(ITEM_PATH);
      if (!m) continue;
      const url = `${u.origin}${m[1]}/details`;
      const text = (a.getAttribute('aria-label') || a.innerText || '').split('\n')[0].trim();
      const prev = byUrl.get(url);
      if (!prev) byUrl.set(url, { url, title: text, el: a });
      else if (text.length > prev.title.length) prev.title = text; // title link beats icon link
    }
    return [...byUrl.values()];
  }

  /**
   * Every element that can scroll vertically: the window plus any inner overflow container.
   * Classroom's Classwork list usually scrolls inside a div, but scrolling all of them is cheaper
   * than guessing which one lazy-loads.
   */
  function findScrollers() {
    const out = [document.scrollingElement || document.documentElement];
    for (const el of document.querySelectorAll('div, main, section')) {
      if (el.scrollHeight <= el.clientHeight + 5) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') out.push(el);
    }
    return out;
  }

  async function loadEverything() {
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      for (const s of findScrollers()) s.scrollTo({ top: s.scrollHeight });
      await sleep(700);
      const n = collectLinks().length;
      if (n === prev) stable++;
      else {
        stable = 0;
        prev = n;
      }
    }
    for (const s of findScrollers()) s.scrollTo({ top: 0 });
  }

  /** Nearest heading above the link in document order that isn't another post's title. */
  function topicFor(el, headings) {
    let best = '';
    for (const h of headings) {
      if (h.contains(el)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
      else break;
    }
    return best;
  }

  function guessClassName() {
    const cleaned = document.title
      .replace(/\s*[-–|]\s*(Google\s+)?Classroom\s*$/i, '')
      .replace(/\s*[-–|]\s*Classwork\s*$/i, '')
      .trim();
    return cleaned && !/^(classwork|classroom|stream|people|grades)$/i.test(cleaned) ? cleaned : '';
  }

  async function scan() {
    await loadEverything();
    const links = collectLinks();
    const titles = new Set(links.map((l) => l.title));
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
      .map((el) => ({ el, text: (el.innerText || '').split('\n')[0].trim() }))
      .filter((h) => h.text && !titles.has(h.text) && !h.el.closest('a'))
      .map((h) => Object.assign(h.el, { text: h.text }));

    const items = links.map((l) => ({
      url: l.url,
      title: l.title,
      topic: topicFor(l.el, headings),
    }));
    return { className: guessClassName(), items };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'SCAN') return false;
    scan()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });
})();
