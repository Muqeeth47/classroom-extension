// Runs on classroom.google.com. Answers the background worker's SCAN request:
//  - mode "post":  the user is on a single post, so just report this page.
//  - mode "class": load the whole page (scroll, "show more"), then list the posts of THIS class only
//                  (never the posts of other classes the page may link to) and say where the class's
//                  other tab (Stream <-> Classwork) is, so the worker can read both.

import { authuserFromPath, courseIdFromPath } from './lib';
import type { ClassPage, PageKind, ScanItem, ScanResult } from './types';

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

// Captures: 1 = post url without /details, 2 = course id.
// a = assignment, m = material, sp/qs = questions, p = announcement.
const ITEM_PATH = /^(.*\/c\/([^/]+)\/(?:a|m|sp|qs|p)\/[^/?#]+)/;
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
 * Classroom's lists usually scroll inside a div, but scrolling all of them is cheaper
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

// The Stream pages older posts behind a "Show more" style button. Deliberately narrow: "View all" and
// similar can navigate away, so only buttons that clearly mean "load older posts" are clicked.
const LOAD_MORE = /^(show|load|view)\s+(more|older)(\s+(posts|announcements))?$/i;

function clickLoadMore(): number {
  let clicked = 0;
  for (const b of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
    if (LOAD_MORE.test(label) && !b.hasAttribute('disabled')) {
      b.click();
      clicked++;
    }
  }
  return clicked;
}

async function loadEverything(): Promise<void> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    for (const s of findScrollers()) s.scrollTo({ top: s.scrollHeight });
    const clicked = clickLoadMore();
    await sleep(clicked ? 1500 : 700); // give freshly requested posts time to arrive
    const n = collectLinks().length + document.querySelectorAll('a[href*="drive.google.com"], a[href*="docs.google.com"]').length;
    // Done when nothing new appears for 3 rounds. A button that stays on the page is not progress by itself.
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this the class's Stream (announcements), its Classwork list, or some other tab? */
function pageType(): ClassPage {
  const p = location.pathname;
  if (/^\/(?:u\/\d+\/)?c\/[^/]+\/?$/.test(p)) return 'stream';
  if (/^\/(?:u\/\d+\/)?w\/[^/]+/.test(p)) return 'classwork';
  return 'other';
}

/**
 * Where the class's other tab(s) live. Prefer the real links on the page (the tab bar); fall back to the
 * address pattern when the page doesn't show them. Only ever addresses for THIS class.
 */
function siblingPages(course: string, here: ClassPage): string[] {
  const prefix = location.pathname.match(/^\/u\/\d+/)?.[0] ?? '';
  const id = escapeRegExp(course);
  const find = (re: RegExp): string | undefined => {
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      try {
        const u = new URL(a.href, location.href);
        if (u.origin === location.origin && re.test(u.pathname)) return u.href;
      } catch {
        /* ignore malformed links */
      }
    }
    return undefined;
  };
  const stream = find(new RegExp(`^(?:/u/\\d+)?/c/${id}/?$`)) ?? `${location.origin}${prefix}/c/${course}`;
  const classwork = find(new RegExp(`^(?:/u/\\d+)?/w/${id}(?:/|$)`)) ?? `${location.origin}${prefix}/w/${course}/t/all`;
  return [...(here === 'stream' ? [] : [stream]), ...(here === 'classwork' ? [] : [classwork])];
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
  const page = pageType();

  // A page can link to posts from several classes (sidebar, to-do list). Only ever keep the class the
  // user has open, and never guess: if the address doesn't match and several classes are linked, refuse.
  const byCourse = new Map<string, FoundLink[]>();
  for (const l of links) byCourse.set(l.course, [...(byCourse.get(l.course) ?? []), l]);
  const current = courseIdFromPath(location.pathname);
  let chosen = current ? byCourse.get(current) : undefined;
  if (!chosen) {
    const firstGroup = [...byCourse.values()][0];
    if (current && !/^\/(?:u\/\d+\/)?w\//.test(location.pathname)) {
      // /c/<id>: the id has the same format as the ones in post links, so no match means this class has
      // no linked posts (e.g. a Stream of plain announcements). Never borrow another class's.
      chosen = [];
    } else if (byCourse.size === 1) {
      // /w/<id> may encode the id differently from post links; a single class on the page is unambiguous.
      chosen = firstGroup;
    } else if (byCourse.size === 0) {
      chosen = [];
    }
  }
  if (!chosen) {
    const error = byCourse.size > 1 ? 'This page lists several classes. Open one class’s Stream or Classwork tab and try again.' : '';
    return { mode: 'class', className: '', items: [], page, ...(error ? { error } : {}) };
  }

  // Topics come from Classwork headings. The Stream has none (its headings are post authors, dates...).
  const titles = new Set(chosen.map((l) => l.title));
  const headings: Heading[] =
    page === 'stream'
      ? []
      : [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"]')]
          .map((el) => ({ el, text: (el.innerText || '').split('\n')[0]!.trim() }))
          .filter((h) => h.text && !titles.has(h.text) && !h.el.closest('a'));

  const items: ScanItem[] = chosen.map((l) => ({ url: l.url, title: l.title, topic: topicFor(l.el, headings) }));
  const course = current ?? chosen[0]?.course;
  return {
    mode: 'class',
    className: guessClassName(),
    items,
    page,
    authuser: authuserFromPath(location.pathname),
    ...(course ? { siblings: siblingPages(course, page) } : {}),
  };
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
