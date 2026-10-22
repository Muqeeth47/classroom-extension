// Runs on classroom.google.com. Answers the background worker's SCAN request:
//  - mode "post":  the user is on a single post, so just report this page.
//  - mode "class": scroll the Classwork page until every post is loaded, then list the posts of
//                  THIS class only (never the posts of other classes the page may link to).

import { authuserFromPath, courseIdFromPath } from './lib';
import type { PageKind, ScanItem, ScanResult } from './types';

type ScanListener = (msg: { type?: string; mode?: PageKind }, sender: unknown, sendResponse: (r: ScanResult) => void) => boolean;

declare global {
  interface Window {
    /** The listener registered by the newest copy of this script in the page. */
    __ilmScanListener?: ScanListener;
  }
}

interface FoundLink {
  url: string;
  course: string;
  title: string;
  el: HTMLAnchorElement;
}

interface Heading {
  el: Element;
  text: string;
}

// Captures: 1 = post url without /details, 2 = course id
const ITEM_PATH = /^(.*\/c\/([^/]+)\/(?:a|m|sp|qs)\/[^/?#]+)/;
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
    if (!prev) byUrl.set(url, { url, course: m[2]!, title: text, el: a });
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

function cleanTitle(): string {
  return document.title
    .replace(/\s*[-–|]\s*(Google\s+)?Classroom\s*$/i, '')
    .replace(/\s*[-–|]\s*Classwork\s*$/i, '')
    .trim();
}

function guessClassName(): string {
  const cleaned = cleanTitle();
  return cleaned && !/^(classwork|classroom|stream|people|grades)$/i.test(cleaned) ? cleaned : '';
}

function scanPost(): ScanResult {
  const heading = document.querySelector<HTMLElement>('h1, [role="heading"][aria-level="1"]');
  let title = (heading?.innerText || '').split('\n')[0]!.trim();
  // Some pages put only the app name in the first heading, which makes a useless folder name.
  if (!title || /^(google\s+)?classroom$/i.test(title)) title = cleanTitle() || 'Post';
  return {
    mode: 'post',
    className: guessClassName() || title,
    items: [{ url: location.href, title, topic: '' }],
    authuser: authuserFromPath(location.pathname),
  };
}

async function scanClass(): Promise<ScanResult> {
  await loadEverything();
  const links = collectLinks();

  // A page can link to posts from several classes (home page, to-do list, sidebar). Keep only
  // the class the user has open, or give up rather than guess.
  const byCourse = new Map<string, FoundLink[]>();
  for (const l of links) byCourse.set(l.course, [...(byCourse.get(l.course) ?? []), l]);
  const current = courseIdFromPath(location.pathname);
  let chosen = current ? byCourse.get(current) : undefined;
  if (!chosen) {
    // The URL's id didn't match any link. Accept the class that clearly dominates the page (a Classwork
    // list is almost entirely one class); if it's a toss-up, refuse rather than guess.
    const ranked = [...byCourse.values()].sort((a, b) => b.length - a.length);
    if (ranked[0] && (!ranked[1] || ranked[0].length >= ranked[1].length * 3)) chosen = ranked[0];
  }
  if (!chosen) {
    const error = byCourse.size > 1 ? 'This page lists several classes. Open one class’s Classwork tab and try again.' : '';
    return { mode: 'class', className: '', items: [], ...(error ? { error } : {}) };
  }

  const titles = new Set(chosen.map((l) => l.title));
  const headings: Heading[] = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"]')]
    .map((el) => ({ el, text: (el.innerText || '').split('\n')[0]!.trim() }))
    .filter((h) => h.text && !titles.has(h.text) && !h.el.closest('a'));

  const items: ScanItem[] = chosen.map((l) => ({ url: l.url, title: l.title, topic: topicFor(l.el, headings) }));
  return { mode: 'class', className: guessClassName(), items, authuser: authuserFromPath(location.pathname) };
}

const listener: ScanListener = (msg, _sender, sendResponse) => {
  if (msg?.type !== 'SCAN') return false;
  const run = msg.mode === 'post' ? Promise.resolve(scanPost()) : scanClass();
  run
    .then(sendResponse)
    .catch((e: unknown) =>
      sendResponse({ mode: msg.mode ?? 'class', className: '', items: [], error: e instanceof Error ? e.message : String(e) }),
    );
  return true;
};

// A newer copy replaces an older one. After the extension is reloaded or updated, the copy already in
// an open tab is orphaned and can no longer answer, so a one-time "already loaded" flag would leave
// the page with no working listener at all.
if (window.__ilmScanListener) {
  try {
    chrome.runtime.onMessage.removeListener(window.__ilmScanListener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
  } catch {
    /* the old context is already gone */
  }
}
window.__ilmScanListener = listener;
chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
