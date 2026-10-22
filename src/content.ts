// Runs on classroom.google.com. Answers the background worker's SCAN request by scrolling the
// Classwork page until every post is loaded, then returning the list of posts with a best-effort topic.

import type { ScanItem, ScanResult } from './types';

declare global {
  interface Window {
    __classroomBulkDownloaderLoaded?: boolean;
  }
}

interface FoundLink {
  url: string;
  title: string;
  el: HTMLAnchorElement;
}

interface Heading {
  el: Element;
  text: string;
}

const ITEM_PATH = /^(.*\/c\/[^/]+\/(?:a|m|sp|qs)\/[^/?#]+)/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function collectLinks(): FoundLink[] {
  const byUrl = new Map<string, FoundLink>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let u: URL;
    try {
      u = new URL(a.href, location.href);
    } catch {
      continue;
    }
    if (u.origin !== location.origin) continue;
    const m = u.pathname.match(ITEM_PATH);
    if (!m) continue;
    const url = `${u.origin}${m[1]}/details`;
    const text = (a.getAttribute('aria-label') || a.innerText || '').split('\n')[0]!.trim();
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
function findScrollers(): Element[] {
  const out: Element[] = [document.scrollingElement || document.documentElement];
  for (const el of document.querySelectorAll('div, main, section')) {
    if (el.scrollHeight <= el.clientHeight + 5) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') out.push(el);
  }
  return out;
}

async function loadEverything(): Promise<void> {
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
function topicFor(el: Element, headings: Heading[]): string {
  let best = '';
  for (const h of headings) {
    if (h.el.contains(el)) continue;
    if (h.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
    else break;
  }
  return best;
}

function guessClassName(): string {
  const cleaned = document.title
    .replace(/\s*[-–|]\s*(Google\s+)?Classroom\s*$/i, '')
    .replace(/\s*[-–|]\s*Classwork\s*$/i, '')
    .trim();
  return cleaned && !/^(classwork|classroom|stream|people|grades)$/i.test(cleaned) ? cleaned : '';
}

async function scan(): Promise<ScanResult> {
  await loadEverything();
  const links = collectLinks();
  const titles = new Set(links.map((l) => l.title));
  const headings: Heading[] = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"]')]
    .map((el) => ({ el, text: (el.innerText || '').split('\n')[0]!.trim() }))
    .filter((h) => h.text && !titles.has(h.text) && !h.el.closest('a'));

  const items: ScanItem[] = links.map((l) => ({
    url: l.url,
    title: l.title,
    topic: topicFor(l.el, headings),
  }));
  return { className: guessClassName(), items };
}

if (!window.__classroomBulkDownloaderLoaded) {
  window.__classroomBulkDownloaderLoaded = true;
  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg?.type !== 'SCAN') return false;
    scan()
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ className: '', items: [], error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
