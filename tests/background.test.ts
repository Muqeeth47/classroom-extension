// Runs the real background worker against a fake browser API and fake network, end to end.
// The fakes are configurable per test so each edge case (blocked files, sign-out, resets...) is exercised.

import { beforeEach, describe, expect, test } from 'vitest';
import type { AppState, Message, PageLink, ScanResult } from '../src/types';

// ---- fake extension API -------------------------------------------------------------------
type Fn = (...args: any[]) => void;
const listeners: { message: Fn[]; dlChanged: Fn[] } = { message: [], dlChanged: [] };
const downloads: { id: number; url: string; filename: string; conflictAction?: string }[] = [];
const session: { state?: AppState } = {};
let nextId = 1;
const calls = { tabsCreate: 0, windowsCreate: 0, windowsRemove: 0 };
const tabWindowIds: (number | undefined)[] = []; // which window each background tab was opened in
const USER_WINDOW = 5; // the window the user already has open
const badgeLog: string[] = []; // every text shown on the toolbar icon, in order
let userWindowRejectsTabs = false; // e.g. the user is in an app or popup window that cannot hold tabs

/** Links "found on the page", keyed by the url of a post opened in a background tab. */
const POSTS: Record<string, PageLink[]> = {
  'https://classroom.google.com/c/C1/a/P1/details': [
    { href: 'https://drive.google.com/file/d/FILE1/view?usp=classroom_web&authuser=1', text: 'Worksheet.pdf\nPDF' },
    { href: 'https://docs.google.com/document/d/DOC1/edit', text: 'Class notes' },
    { href: 'https://docs.google.com/forms/d/e/FORM1/viewform', text: 'Exit ticket' },
  ],
  'https://classroom.google.com/c/C1/m/P2/details': [
    { href: 'https://drive.google.com/file/d/FILE1/view', text: 'Worksheet.pdf' }, // duplicate of P1
    { href: 'https://drive.google.com/drive/folders/FOLD1', text: 'Reading pack' },
  ],
};

const OPEN_POST_TAB = 77;
let openPostLinks: PageLink[] = [];
let scrapeGate: Promise<void> | null = null; // lets a test hold the scraper to interleave a RESET
let scanThrows = false;
let injectThrows = false;
let scanOverride: ScanResult | null = null;
let stallDownloads = false; // a download that never finishes (e.g. the browser is asking about a risky file)
let currentTabLinks: PageLink[] = []; // attachments shown directly on the page the user has open (tab 1)
const siblingScans: Record<string, ScanResult | Error> = {}; // what the class's OTHER tab reports, by url

const classScan = (): ScanResult => ({
  mode: 'class',
  className: 'Physics 12A',
  items: [
    { url: 'https://classroom.google.com/c/C1/a/P1/details', title: 'Forces lab', topic: 'Unit 1: Forces' },
    { url: 'https://classroom.google.com/c/C1/m/P2/details', title: 'Reading', topic: 'Unit 2' },
  ],
});
const postScan = (): ScanResult => ({
  mode: 'post',
  className: 'Reading',
  items: [{ url: 'https://classroom.google.com/c/C1/m/P9/details', title: 'Reading', topic: '' }],
});

const fakeChrome = {
  storage: {
    session: {
      get: async () => ({ state: session.state }),
      set: async (o: { state: AppState }) => void Object.assign(session, o),
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    onMessage: { addListener: (fn: Fn) => listeners.message.push(fn) },
    getPlatformInfo: async () => ({}),
  },
  action: {
    setBadgeText: async ({ text }: { text: string }) => void badgeLog.push(text),
    setBadgeBackgroundColor: async () => {},
  },
  windows: { create: async () => (calls.windowsCreate++, { id: 99 }), remove: async () => void calls.windowsRemove++ },
  tabs: {
    // The fake tab id is its URL so the fake scripting API below can look the "page" up.
    create: async ({ url, windowId }: { url: string; windowId?: number }) => {
      if (userWindowRejectsTabs && windowId != null) throw new Error('Tabs can only be created in normal windows');
      calls.tabsCreate++;
      tabWindowIds.push(windowId);
      return { id: url, url, status: 'complete' };
    },
    remove: async () => {},
    get: async (id: unknown) => ({
      id,
      status: 'complete',
      windowId: USER_WINDOW,
      url:
        id === OPEN_POST_TAB ? 'https://classroom.google.com/c/C1/m/P9/details'
        : id === 1 ? 'https://classroom.google.com/c/C1'
        : id === 88 ? 'https://example.com/'
        : id === 89 ? 'https://classroom.google.com/h/st'
        : String(id),
    }),
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async (tabId: number | string, msg: { mode: string }) => {
      if (typeof tabId === 'string') {
        const r = siblingScans[tabId];
        if (r instanceof Error) throw r;
        if (r) return r;
      }
      if (scanThrows) throw new Error('Receiving end does not exist');
      return scanOverride ?? (msg.mode === 'post' ? postScan() : classScan());
    },
  },
  scripting: {
    // In the real extension this runs inside the page; here the "page" result is canned.
    executeScript: async (opts: { target: { tabId: string | number }; files?: string[] }) => {
      if (opts.files) {
        if (injectThrows) throw new Error('Cannot access contents of the page');
        return [];
      }
      if (scrapeGate) await scrapeGate;
      const id = opts.target.tabId;
      const links = id === OPEN_POST_TAB ? openPostLinks : id === 1 ? currentTabLinks : (POSTS[String(id)] ?? []);
      return [{ result: links }];
    },
  },
  downloads: {
    download: async (opts: { url: string; filename: string; conflictAction?: string }) => {
      const id = nextId++;
      downloads.push({ id, ...opts });
      if (!stallDownloads) setTimeout(() => listeners.dlChanged.forEach((f) => f({ id, state: { current: 'complete' } })), 0);
      return id;
    },
    onChanged: {
      addListener: (f: Fn) => listeners.dlChanged.push(f),
      removeListener: (f: Fn) => void listeners.dlChanged.splice(listeners.dlChanged.indexOf(f), 1),
    },
    search: async () => [],
    show() {},
  },
};
(globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;

// ---- fake network -------------------------------------------------------------------------
const FOLDER_HTML = `
  <div class="flip-entry" id="entry-F2"><a href="https://drive.google.com/file/d/F2/view"><div class="flip-entry-title">Chapter 1.docx</div></a></div>
  <div class="flip-entry" id="entry-SUB"><a href="https://drive.google.com/drive/folders/SUB1"><div class="flip-entry-title">Extras</div></a></div>`;
const SUB_HTML = `<div class="flip-entry" id="entry-F3"><a href="https://drive.google.com/file/d/F3/view"><div class="flip-entry-title">Diagram.png</div></a></div>`;

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const ok = (h: Record<string, string>, extra: Record<string, unknown> = {}) => ({ status: 200, headers: headers(h), ...extra });
const pdf = (name: string) => ok({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` });
const fetched: string[] = [];

globalThis.fetch = (async (url: unknown) => {
  const u = String(url);
  fetched.push(u);
  if (u.includes('embeddedfolderview')) {
    if (u.includes('id=EMPTY')) return { status: 200, text: async () => '<html>sign in</html>', headers: headers({}) };
    return { status: 200, text: async () => (u.includes('id=SUB1') ? SUB_HTML : FOLDER_HTML), headers: headers({}) };
  }
  if (u.includes('id=FILE1')) return pdf('Worksheet.pdf');
  if (u.includes('id=FILE9')) return pdf('Lecture notes.pdf');
  if (u.includes('id=F2')) return ok({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Chapter 1.docx"' });
  if (u.includes('id=F3')) return ok({ 'content-type': 'text/html' }); // owner disabled downloads: Drive sends an HTML page
  if (u.includes('/document/d/DOC1/')) return pdf('Class notes.pdf');
  if (u.includes('id=HTMLUPLOAD')) return ok({ 'content-type': 'text/html', 'content-disposition': 'attachment; filename="page.html"' }); // a real .html upload
  if (u.includes('id=SIGNEDOUT')) return ok({ 'content-type': 'text/html' }, { url: 'https://accounts.google.com/v3/signin' });
  if (u.includes('id=NETFAIL')) throw new TypeError('Failed to fetch');
  if (u.includes('id=BUSY')) return { status: 429, headers: headers({}) };
  if (u.includes('id=OLDKEY')) return pdf('Old.pdf');
  if (u.includes('id=ACCT')) return pdf('Account.pdf');
  if (u.includes('id=ANNFILE')) return pdf('Syllabus.pdf');
  if (u.includes('id=ANN2')) return pdf('Announcement slides.pdf');
  return { status: 404, headers: headers({}) };
}) as unknown as typeof fetch;

// ---- helpers ------------------------------------------------------------------------------
const send = (msg: Message) =>
  new Promise<AppState>((resolve) => {
    listeners.message.forEach((fn) => fn(msg, {}, resolve));
  });

async function until(pred: (s: AppState) => boolean, label: string): Promise<AppState> {
  for (let i = 0; i < 300; i++) {
    const s = await send({ type: 'GET_STATE' });
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
const settle = () => new Promise((r) => setTimeout(r, 60));

/** Scan the open post tab with the given links and return the review state. */
async function scanPost(links: PageLink[], scan: ScanResult | null = null): Promise<AppState> {
  openPostLinks = links;
  scanOverride = scan;
  await send({ type: 'START', tabId: OPEN_POST_TAB, mode: 'post' });
  return until((x) => x.phase === 'review' || x.phase === 'error', 'review or error');
}

async function downloadAll(s: AppState, extra: Partial<Extract<Message, { type: 'DOWNLOAD' }>> = {}): Promise<AppState> {
  await send({ type: 'DOWNLOAD', keys: s.files.map((f) => f.key), className: 'Class', byTopic: true, docFormat: 'pdf', ...extra });
  return until((x) => x.phase === 'done', 'done phase');
}

await import('../src/background');

beforeEach(async () => {
  await send({ type: 'RESET' });
  downloads.length = 0;
  fetched.length = 0;
  scrapeGate = null;
  scanThrows = false;
  injectThrows = false;
  scanOverride = null;
  stallDownloads = false;
  tabWindowIds.length = 0;
  badgeLog.length = 0;
  userWindowRejectsTabs = false;
  currentTabLinks = [];
  for (const k of Object.keys(siblingScans)) delete siblingScans[k];
  openPostLinks = [];
});

// ---- whole-class flow ---------------------------------------------------------------------
describe('class scan', () => {
  test('dedupes, expands nested folders and reaches review', async () => {
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const s = await until((x) => x.phase === 'review', 'review phase');

    expect(s.className).toBe('Physics 12A');
    expect(s.files.map((f) => f.key).sort()).toEqual(['document:DOC1', 'file:F2', 'file:F3', 'file:FILE1']); // FILE1 only once
    expect(s.skipped.map((k) => k.reason)).toEqual(['Google Form']);
    const f3 = s.files.find((f) => f.id === 'F3');
    expect(f3?.sub).toEqual(['Reading pack', 'Extras']); // nested folder path preserved
    expect(f3?.topic).toBe('Unit 2');
  });

  test('downloads originals into class/topic/folder paths and reports blocked files', async () => {
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const review = await until((x) => x.phase === 'review', 'review phase');
    const done = await downloadAll(review, { className: 'Physics: 12A', docFormat: 'office' });

    expect(downloads.map((d) => d.filename).sort()).toEqual([
      'Classroom/Physics_ 12A/Unit 1_ Forces/Class notes.docx', // Google Doc exported as Office
      'Classroom/Physics_ 12A/Unit 1_ Forces/Worksheet.pdf', // original PDF, untouched
      'Classroom/Physics_ 12A/Unit 2/Reading pack/Chapter 1.docx',
    ]);
    expect(downloads.every((d) => d.conflictAction === 'uniquify')).toBe(true);
    expect(downloads.find((d) => d.filename.endsWith('Class notes.docx'))?.url).toContain('format=docx');
    expect(done.dl).toMatchObject({ done: 3, failed: 1 });
    expect(done.dl.failures[0]?.reason).toMatch(/disabled|no access/i);
  });

  test('"sort into topics" off puts everything straight under the class folder', async () => {
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const review = await until((x) => x.phase === 'review', 'review phase');
    await downloadAll(review, { byTopic: false });
    expect(downloads.map((d) => d.filename)).toContain('Classroom/Class/Worksheet.pdf');
  });

  test('an empty or inaccessible Drive folder is reported, not silently dropped', async () => {
    POSTS['https://classroom.google.com/c/C1/m/P2/details'] = [{ href: 'https://drive.google.com/drive/folders/EMPTY', text: 'Locked folder' }];
    try {
      await send({ type: 'START', tabId: 1, mode: 'class' });
      const s = await until((x) => x.phase === 'review', 'review phase');
      expect(s.skipped.some((k) => /empty|access/i.test(k.reason) && k.title === 'Locked folder')).toBe(true);
    } finally {
      POSTS['https://classroom.google.com/c/C1/m/P2/details'] = [
        { href: 'https://drive.google.com/file/d/FILE1/view', text: 'Worksheet.pdf' },
        { href: 'https://drive.google.com/drive/folders/FOLD1', text: 'Reading pack' },
      ];
    }
  });
});

// ---- single post (the main use) -----------------------------------------------------------
describe('single post', () => {
  test('is read in place: no hidden window, no reopened tab', async () => {
    const before = { ...calls };
    const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'Lecture notes.pdf' }], postScan());
    expect(s.files.map((f) => f.key)).toEqual(['file:FILE9']);
    expect(s.className).toBe('Reading');
    expect(calls).toEqual(before);
  });

  test('a post with no attachments ends in review with nothing to download', async () => {
    const s = await scanPost([]);
    expect(s.phase).toBe('review');
    expect(s.files).toHaveLength(0);
  });

  test('a real .html upload is downloaded; Drive error pages are not', async () => {
    const s = await scanPost([
      { href: 'https://drive.google.com/file/d/HTMLUPLOAD/view', text: 'page.html' },
      { href: 'https://drive.google.com/file/d/SIGNEDOUT/view', text: 'Private' },
    ]);
    const done = await downloadAll(s);
    expect(downloads.map((d) => d.filename)).toEqual(['Classroom/Class/page.html']);
    expect(done.dl.failures[0]?.reason).toMatch(/signed out/i);
  });

  test('reports network failure and rate limiting in plain words, saving nothing', async () => {
    const s = await scanPost([
      { href: 'https://drive.google.com/file/d/NETFAIL/view', text: 'a' },
      { href: 'https://drive.google.com/file/d/BUSY/view', text: 'b' },
    ]);
    const done = await downloadAll(s);
    expect(downloads).toHaveLength(0); // fail closed: nothing blindly saved
    const reasons = done.dl.failures.map((f) => f.reason).join(' | ');
    expect(reasons).toMatch(/Could not reach Google/);
    expect(reasons).toMatch(/limiting downloads/);
  });

  test('older shared links keep their resource key, and Classroom\'s Google account is used', async () => {
    const s = await scanPost(
      [
        { href: 'https://drive.google.com/file/d/OLDKEY/view?resourcekey=0-abc123', text: 'Old.pdf' },
        { href: 'https://drive.google.com/file/d/ACCT/view', text: 'Account.pdf' },
      ],
      { ...postScan(), authuser: '2' },
    );
    await downloadAll(s);
    const old = downloads.find((d) => d.url.includes('id=OLDKEY'))!;
    expect(old.url).toContain('resourcekey=0-abc123');
    const acct = downloads.find((d) => d.url.includes('id=ACCT'))!;
    expect(acct.url).toContain('authuser=2'); // link named no account, so the page's /u/2/ is used
  });

  test('very deep folder names are shortened so the path stays within limits', async () => {
    const long = 'x'.repeat(200);
    const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'n.pdf' }], { ...postScan(), className: long });
    await downloadAll(s, { className: long });
    expect(downloads[0]!.filename.length).toBeLessThanOrEqual(190);
    expect(downloads[0]!.filename.endsWith('.pdf')).toBe(true);
  });
});

// ---- errors the user should see plainly ---------------------------------------------------
describe('errors', () => {
  test('a single post that reports no page tells the user what to open', async () => {
    const s = await scanPost([], { mode: 'post', className: '', items: [] });
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/announcement|post/i);
  });

  test('a class with nothing in it explains itself', async () => {
    scanOverride = { mode: 'class', className: 'Empty class', page: 'stream', items: [], siblings: [] };
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const s = await until((x) => x.phase === 'error', 'error');
    expect(s.error).toMatch(/No announcements or posts found in this class/);
  });

  test('a scanner error is passed through', async () => {
    const s = await scanPost([], { mode: 'class', className: '', items: [], error: 'This page lists several classes.' });
    expect(s.error).toBe('This page lists several classes.');
  });

  test('a tab that cannot be read gives a friendly message, not a browser error', async () => {
    scanThrows = true;
    injectThrows = true;
    const s = await scanPost([]);
    expect(s.phase).toBe('error');
    expect(s.error).toBe('Could not read the Classroom page. Reload it, then try again.');
  });

  test('a scanner that was not injected yet is injected and retried', async () => {
    scanThrows = true;
    let injected = false;
    const real = fakeChrome.scripting.executeScript;
    fakeChrome.scripting.executeScript = async (opts: any) => {
      if (opts.files) {
        injected = true;
        scanThrows = false; // the script now answers
        return [];
      }
      return real(opts);
    };
    try {
      const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }]);
      expect(injected).toBe(true);
      expect(s.phase).toBe('review');
    } finally {
      fakeChrome.scripting.executeScript = real;
    }
  });
});

// ---- resets and cancels -------------------------------------------------------------------
describe('start over / cancel', () => {
  test('"Start over" during a scan is never overwritten by the run it interrupted', async () => {
    let release!: () => void;
    scrapeGate = new Promise<void>((r) => (release = r));
    await send({ type: 'START', tabId: 1, mode: 'class' });
    await until((x) => x.phase === 'scanning' || x.phase === 'collecting', 'scanning');

    await send({ type: 'RESET' });
    release(); // the old scrape now finishes
    await settle();

    const s = await send({ type: 'GET_STATE' });
    expect(s.phase).toBe('idle'); // not resurrected as review/done
    expect(s.files).toHaveLength(0);
  });

  test('a new run after a reset is not mixed with the old one', async () => {
    let release!: () => void;
    scrapeGate = new Promise<void>((r) => (release = r));
    await send({ type: 'START', tabId: 1, mode: 'class' });
    await until((x) => x.phase === 'scanning' || x.phase === 'collecting', 'scanning');
    await send({ type: 'RESET' });

    scrapeGate = null;
    openPostLinks = [{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }];
    await send({ type: 'START', tabId: OPEN_POST_TAB, mode: 'post' });
    release(); // old class scrape wakes up while the new post run is active
    const s = await until((x) => x.phase === 'review', 'review');
    await settle();

    const after = await send({ type: 'GET_STATE' });
    expect(after.files.map((f) => f.key)).toEqual(['file:FILE9']); // none of the class files leaked in
    expect(s.phase).toBe('review');
  });

  test('Cancel during a scan returns to the start screen', async () => {
    let release!: () => void;
    scrapeGate = new Promise<void>((r) => (release = r));
    await send({ type: 'START', tabId: 1, mode: 'class' });
    await until((x) => x.phase === 'scanning' || x.phase === 'collecting', 'scanning');
    await send({ type: 'CANCEL' });
    release();
    await until((x) => x.phase === 'idle', 'idle after cancel');
  });

  test('"Start over" while downloading does not bring the finished screen back', async () => {
    const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }]);
    await send({ type: 'DOWNLOAD', keys: s.files.map((f) => f.key), className: 'C', byTopic: true, docFormat: 'pdf' });
    await send({ type: 'RESET' });
    await settle();
    expect((await send({ type: 'GET_STATE' })).phase).toBe('idle');
  });

  test('Stop ends the run even if one download is stuck', async () => {
    const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }]);
    stallDownloads = true;
    await send({ type: 'DOWNLOAD', keys: s.files.map((f) => f.key), className: 'C', byTopic: true, docFormat: 'pdf' });
    for (let i = 0; i < 100 && downloads.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(downloads).toHaveLength(1); // started, and will never complete

    await send({ type: 'CANCEL' });
    const done = await until((x) => x.phase === 'done', 'done after Stop');
    expect(done.phase).toBe('done');
  });
});

// ---- everything posted in a class (Stream + Classwork) -----------------------------------
describe('whole class: announcements, assignments and materials', () => {
  const STREAM_URL = 'https://classroom.google.com/c/C1';
  const CLASSWORK_URL = 'https://classroom.google.com/w/C1/t/all';
  const ANN_URL = 'https://classroom.google.com/c/C1/p/ANN1/details';
  const P1_URL = 'https://classroom.google.com/c/C1/a/P1/details';

  const onClasswork = (): ScanResult => ({ ...classScan(), page: 'classwork', siblings: [STREAM_URL] });
  const streamPage = (): ScanResult => ({
    mode: 'class',
    className: '',
    page: 'stream',
    items: [
      { url: ANN_URL, title: 'Welcome', topic: '' },
      { url: P1_URL, title: 'Forces lab', topic: '' }, // the Stream also shows Classwork posts, without their topic
    ],
  });

  async function scanClassWith(here: ScanResult): Promise<AppState> {
    scanOverride = here;
    await send({ type: 'START', tabId: 1, mode: 'class' });
    return until((x) => x.phase === 'review' || x.phase === 'error', 'review or error');
  }

  test('reads BOTH tabs from either one, and keeps announcements in their own folder', async () => {
    POSTS[ANN_URL] = [{ href: 'https://drive.google.com/file/d/ANN2/view', text: 'Announcement slides.pdf' }];
    POSTS[STREAM_URL] = [
      { href: 'https://drive.google.com/file/d/ANNFILE/view', text: 'Syllabus.pdf' }, // attached straight on the Stream
      { href: 'https://drive.google.com/file/d/FILE1/view', text: 'Worksheet.pdf' }, // ALSO attached to a Classwork post
      { href: 'https://drive.google.com/drive/folders/CLASSFOLDER', text: 'Class Drive folder' },
    ];
    siblingScans[STREAM_URL] = streamPage();
    const tabsBefore = calls.tabsCreate;
    try {
      const s = await scanClassWith(onClasswork());
      expect(s.files.map((f) => f.key).sort()).toEqual(['document:DOC1', 'file:ANN2', 'file:ANNFILE', 'file:F2', 'file:F3', 'file:FILE1']);

      const topic = (id: string) => s.files.find((f) => f.id === id)?.topic;
      expect(topic('FILE1')).toBe('Unit 1: Forces'); // Classwork's topic wins over the Stream's copy
      expect(topic('ANNFILE')).toBe('Announcements'); // shown directly on the Stream
      expect(topic('ANN2')).toBe(''); // an announcement page with no topic

      // The Stream tab + P1, P2 and the announcement: each post opened exactly once.
      expect(calls.tabsCreate - tabsBefore).toBe(4);
      // The class's own Drive folder (submissions) is never opened.
      expect(fetched.some((u) => u.includes('CLASSFOLDER'))).toBe(false);

      const done = await downloadAll(s);
      expect(downloads.map((d) => d.filename)).toContain('Classroom/Class/Announcements/Syllabus.pdf');
      expect(done.dl.done).toBeGreaterThanOrEqual(4);
    } finally {
      delete POSTS[ANN_URL];
      delete POSTS[STREAM_URL];
    }
  });

  test('starting from the Stream also reads Classwork', async () => {
    currentTabLinks = [{ href: 'https://drive.google.com/file/d/ANNFILE/view', text: 'Syllabus.pdf' }];
    siblingScans[CLASSWORK_URL] = { ...classScan(), page: 'classwork' };
    const s = await scanClassWith({ mode: 'class', className: 'Physics 12A', page: 'stream', items: [], siblings: [CLASSWORK_URL] });
    expect(s.files.map((f) => f.key)).toEqual(expect.arrayContaining(['file:ANNFILE', 'file:FILE1', 'document:DOC1']));
    expect(s.files.find((f) => f.id === 'ANNFILE')?.topic).toBe('Announcements');
    expect(s.files.find((f) => f.id === 'FILE1')?.topic).toBe('Unit 1: Forces');
  });

  test('a class that only has plain announcements still works', async () => {
    currentTabLinks = [{ href: 'https://drive.google.com/file/d/ANNFILE/view', text: 'Syllabus.pdf' }];
    siblingScans[CLASSWORK_URL] = { mode: 'class', className: '', page: 'classwork', items: [] };
    const s = await scanClassWith({ mode: 'class', className: 'Art', page: 'stream', items: [], siblings: [CLASSWORK_URL] });
    expect(s.phase).toBe('review');
    expect(s.files.map((f) => f.key)).toEqual(['file:ANNFILE']);
  });

  test('if the other tab cannot be read, what the first tab found is kept and the problem is logged', async () => {
    siblingScans[STREAM_URL] = new Error('Receiving end does not exist');
    const s = await scanClassWith(onClasswork());
    expect(s.phase).toBe('review');
    expect(s.files.map((f) => f.key)).toEqual(expect.arrayContaining(['file:FILE1', 'document:DOC1']));
    expect(s.log.join('\n')).toMatch(/Could not read https:\/\/classroom\.google\.com\/c\/C1/);
  });

  test('a single post never touches the class\'s other tabs', async () => {
    const before = calls.tabsCreate;
    const s = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }], { ...postScan(), siblings: [STREAM_URL] });
    expect(s.files.map((f) => f.key)).toEqual(['file:FILE9']);
    expect(calls.tabsCreate).toBe(before);
  });

  test('a page address that is not Classroom is never opened', async () => {
    const before = calls.tabsCreate;
    const s = await scanClassWith({ ...onClasswork(), siblings: ['https://evil.example/c/C1', 'http://classroom.google.com/c/C1'] });
    expect(s.phase).toBe('review');
    expect(s.log.join('\n')).toMatch(/Ignored a page that is not on Classroom/);
    // only the two Classwork posts were opened; neither bogus address was
    expect(calls.tabsCreate - before).toBe(2);
  });

  test('the same Google Form seen in several places is listed once', async () => {
    POSTS[STREAM_URL] = [{ href: 'https://docs.google.com/forms/d/e/FORM1/viewform', text: 'Exit ticket' }];
    siblingScans[STREAM_URL] = streamPage();
    try {
      const s = await scanClassWith(onClasswork());
      expect(s.skipped.filter((k) => k.reason === 'Google Form')).toHaveLength(1); // on P1, on the Stream, once
    } finally {
      delete POSTS[STREAM_URL];
    }
  });
});

// ---- where pages are read, and which page results belong to -------------------------------
describe('no extra windows, and results stay with their page', () => {
  test('a class is read in background tabs of the user\'s own window, never a new or minimised window', async () => {
    const created = calls.windowsCreate;
    const removed = calls.windowsRemove;
    const sibling = 'https://classroom.google.com/c/C1';
    siblingScans[sibling] = { mode: 'class', className: '', page: 'stream', items: [] };
    scanOverride = { ...classScan(), page: 'classwork', siblings: [sibling] };
    await send({ type: 'START', tabId: 1, mode: 'class' });
    await until((x) => x.phase === 'review', 'review');

    expect(calls.windowsCreate).toBe(created); // Linux window managers may ignore "minimised", so none is created
    expect(calls.windowsRemove).toBe(removed); // and the user's own window is never closed
    expect(tabWindowIds.length).toBeGreaterThan(0);
    expect(tabWindowIds.every((id) => id === USER_WINDOW)).toBe(true);
  });

  test('results remember the page they came from', async () => {
    await send({ type: 'START', tabId: 1, mode: 'class' });
    expect((await until((x) => x.phase === 'review', 'review')).source).toBe('class:C1');

    await send({ type: 'RESET' });
    const post = await scanPost([{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }]);
    expect(post.source).toBe('post:C1/P9');
  });
});

describe('the toolbar icon and unusual windows', () => {
  test('the icon shows progress, the file count, and the result, so the popup can stay closed', async () => {
    const review = await scanPost([
      { href: 'https://drive.google.com/file/d/FILE9/view', text: 'a.pdf' },
      { href: 'https://drive.google.com/file/d/FILE1/view', text: 'b.pdf' },
    ]);
    expect(badgeLog).toContain('...'); // while reading
    expect(badgeLog.at(-1)).toBe('2'); // two files ready to choose

    await downloadAll(review);
    expect(badgeLog.at(-1)).toBe('OK'); // finished cleanly

    await send({ type: 'RESET' });
    expect(badgeLog.at(-1)).toBe(''); // back to nothing
  });

  test('a failure is flagged on the icon', async () => {
    const review = await scanPost([{ href: 'https://drive.google.com/file/d/NETFAIL/view', text: 'a' }]);
    await downloadAll(review);
    expect(badgeLog.at(-1)).toBe('!');
  });

  test('if the user\'s own window cannot hold tabs, pages are still read (tabs open anywhere, never stealing focus)', async () => {
    userWindowRejectsTabs = true;
    scanOverride = { ...classScan(), page: 'classwork', siblings: [] };
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const s = await until((x) => x.phase === 'review', 'review');
    expect(s.files.map((f) => f.key)).toEqual(expect.arrayContaining(['file:FILE1', 'document:DOC1']));
    expect(tabWindowIds.every((id) => id === undefined)).toBe(true); // browser chose the window
  });
});

describe('not on a Classroom post or class', () => {
  test.each([
    ['an ordinary website', 88],
    ['the Classroom home / to-do page, which lists every class', 89],
  ])('%s: nothing is scanned and the user is told what to open', async (_label, tabId) => {
    const tabsBefore = calls.tabsCreate;
    await send({ type: 'START', tabId, mode: 'class' });
    const s = await until((x) => x.phase === 'error', 'error');
    expect(s.error).toMatch(/not a Google Classroom post or class/i);
    expect(calls.tabsCreate).toBe(tabsBefore); // no page was opened
    expect(s.files).toHaveLength(0);
  });

  test('the page can change after the popup opened: what the tab shows now decides, not what was asked', async () => {
    // The popup thought "class", but tab 77 is now a single post: it must be read as that one post, in place.
    const tabsBefore = calls.tabsCreate;
    openPostLinks = [{ href: 'https://drive.google.com/file/d/FILE9/view', text: 'x.pdf' }];
    await send({ type: 'START', tabId: OPEN_POST_TAB, mode: 'class' });
    const s = await until((x) => x.phase === 'review', 'review');
    expect(s.files.map((f) => f.key)).toEqual(['file:FILE9']);
    expect(calls.tabsCreate).toBe(tabsBefore);
  });

  test('a Drive folder shown directly on a page is never opened (a class folder holds students\' work)', async () => {
    currentTabLinks = [
      { href: 'https://drive.google.com/drive/folders/STREAMFOLDER', text: 'Some folder' },
      { href: 'https://drive.google.com/file/d/ANNFILE/view', text: 'Syllabus.pdf' },
    ];
    scanOverride = { mode: 'class', className: 'Art', page: 'stream', items: [], siblings: [] };
    await send({ type: 'START', tabId: 1, mode: 'class' });
    const s = await until((x) => x.phase === 'review', 'review');
    expect(s.files.map((f) => f.key)).toEqual(['file:ANNFILE']);
    expect(fetched.some((u) => u.includes('embeddedfolderview') && u.includes('STREAMFOLDER'))).toBe(false);
    expect(s.log.join('\n')).toMatch(/Ignored 1 Drive folder link/);
  });

  test('a folder attached to a post IS still opened', async () => {
    await send({ type: 'START', tabId: 1, mode: 'class' }); // the default class has a post with a "Reading pack" folder
    const s = await until((x) => x.phase === 'review', 'review');
    expect(s.files.some((f) => f.id === 'F2' && f.sub[0] === 'Reading pack')).toBe(true);
  });
});

