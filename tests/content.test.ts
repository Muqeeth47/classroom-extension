// @vitest-environment jsdom
// Tests the page scanner (src/content.ts) against simulated Classroom pages. These are the cases behind the
// reported bug: scanning the home page must never pull in posts from every class.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScanResult } from '../src/types';

type Listener = (msg: unknown, sender: unknown, send: (r: ScanResult) => void) => boolean;
let listeners: Listener[] = [];
let removed: Listener[] = [];

// jsdom has no layout engine: give it the two bits the scanner relies on.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  get() {
    return this.textContent ?? '';
  },
  configurable: true,
});
Element.prototype.scrollTo = () => {};

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: {
      addListener: (fn: Listener) => listeners.push(fn),
      removeListener: (fn: Listener) => void removed.push(fn),
    },
  },
};

interface Post {
  course: string;
  id: string;
  title: string;
}
const link = (p: Post) => `<a href="/u/0/c/${p.course}/a/${p.id}/details">${p.title}</a>`;

function setPage(path: string, body: string, title = 'Physics 12A - Google Classroom'): void {
  history.pushState(null, '', path);
  document.title = title;
  document.body.innerHTML = body;
}

/** Load a fresh copy of the content script and ask it to scan. */
async function scan(mode: 'class' | 'post'): Promise<ScanResult> {
  listeners = [];
  vi.resetModules();
  await import('../src/content');
  const listener = listeners.at(-1)!;
  const result = new Promise<ScanResult>((resolve) => listener({ type: 'SCAN', mode }, null, resolve));
  await vi.advanceTimersByTimeAsync(10_000); // lets the scroll-to-load loop finish
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  removed = [];
  delete (window as { __ilmScanListener?: unknown }).__ilmScanListener;
});
afterEach(() => vi.useRealTimers());

describe('class scan only ever returns the open class', () => {
  const sidebarOtherClass = [
    { course: 'COURSE2', id: 'X1', title: 'History essay' },
    { course: 'COURSE2', id: 'X2', title: 'Maths notes' },
  ]
    .map(link)
    .join('');

  test('ignores another class linked from the same page', async () => {
    const mine = ['A1', 'A2', 'A3'].map((id) => link({ course: 'COURSE1', id, title: 'Task ' + id })).join('');
    setPage('/c/COURSE1/w', `<nav>${sidebarOtherClass}</nav><main>${mine}</main>`);
    const r = await scan('class');
    expect(r.error).toBeUndefined();
    expect(r.items.map((i) => i.title)).toEqual(['Task A1', 'Task A2', 'Task A3']);
    expect(r.items.every((i) => i.url.includes('/c/COURSE1/'))).toBe(true);
  });

  test('refuses on a page that lists several classes (home / to-do)', async () => {
    const two = ['A', 'B']
      .flatMap((c) => ['1', '2'].map((n) => link({ course: 'CLASS' + c, id: n, title: `${c}${n}` })))
      .join('');
    for (const path of ['/h', '/h/st', '/u/0/h']) {
      setPage(path, `<main>${two}</main>`);
      const r = await scan('class');
      expect(r.items).toHaveLength(0);
      expect(r.error).toMatch(/several classes/i);
    }
  });

  test('when the URL id matches no link but only ONE class is on the page, that class is used', async () => {
    const mine = ['1', '2', '3'].map((id) => link({ course: 'COURSE1', id, title: 't' + id })).join('');
    setPage('/w/SOMETHING_ELSE/t/all', `<main>${mine}</main>`);
    const r = await scan('class');
    expect(r.items).toHaveLength(3);
  });

  test('...but with several classes linked and no match it refuses, even if one looks dominant (never another class)', async () => {
    const mine = ['1', '2', '3', '4', '5', '6'].map((id) => link({ course: 'COURSE1', id, title: 't' + id })).join('');
    setPage('/w/SOMETHING_ELSE/t/all', `<main>${mine}${link({ course: 'COURSE2', id: 'Z', title: 'stray' })}</main>`);
    const r = await scan('class');
    expect(r.items).toHaveLength(0);
    expect(r.error).toMatch(/several classes/i);
  });

  test('a class page whose own posts are absent never borrows posts from another class', async () => {
    // e.g. a Stream of plain announcements with a sidebar linking to a different class
    setPage('/c/COURSE1', `<aside>${link({ course: 'COURSE2', id: 'X', title: 'Other class work' })}</aside><main>Hello class</main>`);
    const r = await scan('class');
    expect(r.items.filter((i) => i.url.includes('COURSE2'))).toHaveLength(0);
  });

  test('a page with no posts returns nothing and no error (the worker explains)', async () => {
    setPage('/c/COURSE1/w', '<main>Nothing here</main>');
    const r = await scan('class');
    expect(r.items).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test('assigns each post to the topic heading above it and reports the Google account', async () => {
    setPage(
      '/u/2/c/COURSE1/w',
      `<main><h2>Unit 1</h2>${link({ course: 'COURSE1', id: '1', title: 'Lab' })}<h2>Unit 2</h2>${link({ course: 'COURSE1', id: '2', title: 'Quiz' })}</main>`,
    );
    const r = await scan('class');
    expect(r.items.map((i) => [i.title, i.topic])).toEqual([
      ['Lab', 'Unit 1'],
      ['Quiz', 'Unit 2'],
    ]);
    expect(r.authuser).toBe('2');
    expect(r.className).toBe('Physics 12A');
  });

  test('one post linked by an icon link and a title link is listed once, with the longer title', async () => {
    setPage('/c/COURSE1/w', `<main><a href="/c/COURSE1/a/P/details"></a><a href="/c/COURSE1/a/P/details">Real title</a></main>`);
    const r = await scan('class');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('Real title');
  });
});

describe('single post', () => {
  test('reports just the open page, with its title and account', async () => {
    setPage('/u/1/c/ABC/m/DEF/details', '<h1>Chapter notes</h1><p>files below</p>');
    const r = await scan('post');
    expect(r.mode).toBe('post');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('Chapter notes');
    expect(r.authuser).toBe('1');
  });

  test('ignores every other class and post linked on the page', async () => {
    setPage('/c/ABC/m/DEF/details', `<h1>Reading</h1>${link({ course: 'OTHER', id: '9', title: 'Elsewhere' })}`);
    const r = await scan('post');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.url).toContain('/c/ABC/m/DEF');
  });

  test('a heading that is just the app name falls back to the page title', async () => {
    setPage('/c/ABC/m/DEF/details', '<h1>Classroom</h1>', 'Week 3 slides - Google Classroom');
    const r = await scan('post');
    expect(r.items[0]!.title).toBe('Week 3 slides');
  });
});

describe('re-injection', () => {
  test('a newer copy replaces the older listener instead of being blocked by it', async () => {
    setPage('/c/ABC/m/DEF/details', '<h1>x</h1>');
    await scan('post');
    const first = listeners.at(-1)!;
    // Simulates the extension injecting the script again into the same page (the old listener's
    // reference survives on window, exactly as after an extension reload).
    listeners = [];
    vi.resetModules();
    await import('../src/content');
    const second = listeners.at(-1)!;
    expect(second).not.toBe(first);
    expect(removed).toContain(first); // the stale one was removed; the new one is the only active listener
  });
});
