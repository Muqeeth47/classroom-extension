// Runs the real background worker against a fake browser API and fake network, end to end:
// START -> scan -> read posts -> expand a Drive folder -> pick -> download.

import { expect, test } from 'vitest';
import type { AppState, Message, PageLink } from '../src/types';

// ---- fake extension API -------------------------------------------------------------------
type Fn = (...args: any[]) => void;
const listeners: { message: Fn[]; dlChanged: Fn[] } = { message: [], dlChanged: [] };
const downloads: { id: number; url: string; filename: string; conflictAction?: string }[] = [];
const session: { state?: AppState } = {};
let nextId = 1;

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
  windows: { create: async () => ({ id: 99 }), remove: async () => {} },
  tabs: {
    // The fake tab id is its URL so the fake scripting API below can look the "page" up.
    create: async ({ url }: { url: string }) => ({ id: url, url, status: 'complete' }),
    remove: async () => {},
    get: async (id: unknown) => ({ id, status: 'complete' }),
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({
      className: 'Physics 12A',
      items: [
        { url: 'https://classroom.google.com/c/C1/a/P1/details', title: 'Forces lab', topic: 'Unit 1: Forces' },
        { url: 'https://classroom.google.com/c/C1/m/P2/details', title: 'Reading', topic: 'Unit 2' },
      ],
    }),
  },
  scripting: {
    // In the real extension this runs inside the page; here the "page" result is canned per URL.
    executeScript: async ({ target }: { target: { tabId: string } }) => [{ result: POSTS[target.tabId] ?? [] }],
  },
  downloads: {
    download: async (opts: { url: string; filename: string; conflictAction?: string }) => {
      const id = nextId++;
      downloads.push({ id, ...opts });
      setTimeout(() => listeners.dlChanged.forEach((f) => f({ id, state: { current: 'complete' } })), 0);
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

const FOLDER_HTML = `
  <div class="flip-entry" id="entry-F2"><a href="https://drive.google.com/file/d/F2/view"><div class="flip-entry-title">Chapter 1.docx</div></a></div>
  <div class="flip-entry" id="entry-SUB"><a href="https://drive.google.com/drive/folders/SUB1"><div class="flip-entry-title">Extras</div></a></div>`;
const SUB_HTML = `<div class="flip-entry" id="entry-F3"><a href="https://drive.google.com/file/d/F3/view"><div class="flip-entry-title">Diagram.png</div></a></div>`;

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
globalThis.fetch = (async (url: unknown) => {
  const u = String(url);
  if (u.includes('embeddedfolderview')) {
    return { status: 200, text: async () => (u.includes('id=SUB1') ? SUB_HTML : FOLDER_HTML), headers: headers({}) };
  }
  if (u.includes('id=FILE1')) {
    return { status: 200, headers: headers({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Worksheet.pdf"' }) };
  }
  if (u.includes('id=F2')) {
    return { status: 200, headers: headers({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Chapter 1.docx"' }) };
  }
  if (u.includes('id=F3')) return { status: 200, headers: headers({ 'content-type': 'text/html' }) }; // owner disabled downloads
  if (u.includes('/document/d/DOC1/')) {
    return { status: 200, headers: headers({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Class notes.pdf"' }) };
  }
  return { status: 404, headers: headers({}) };
}) as unknown as typeof fetch;

const send = (msg: Message) =>
  new Promise<AppState>((resolve) => {
    listeners.message.forEach((fn) => fn(msg, {}, resolve));
  });

async function until(pred: (s: AppState) => boolean, label: string): Promise<AppState> {
  for (let i = 0; i < 200; i++) {
    const s = await send({ type: 'GET_STATE' });
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

await import('../src/background');

test('scans a class, dedupes, expands folders and reaches review', async () => {
  await send({ type: 'START', tabId: 1 });
  const s = await until((x) => x.phase === 'review', 'review phase');

  expect(s.className).toBe('Physics 12A');
  expect(s.files.map((f) => f.key).sort()).toEqual(['document:DOC1', 'file:F2', 'file:F3', 'file:FILE1']); // FILE1 only once
  expect(s.skipped).toHaveLength(1);
  expect(s.skipped[0]?.reason).toMatch(/Form/);

  const f3 = s.files.find((f) => f.id === 'F3');
  expect(f3?.sub).toEqual(['Reading pack', 'Extras']); // nested folder path preserved
  expect(f3?.topic).toBe('Unit 2');
});

test('downloads originals into class/topic/folder paths and reports blocked files', async () => {
  const s = await send({ type: 'GET_STATE' });
  await send({
    type: 'DOWNLOAD',
    keys: s.files.map((f) => f.key),
    className: 'Physics: 12A',
    byTopic: true,
    docFormat: 'office',
  });
  const done = await until((x) => x.phase === 'done', 'done phase');

  expect(downloads.map((d) => d.filename).sort()).toEqual([
    'Classroom/Physics_ 12A/Unit 1_ Forces/Class notes.docx', // Google Doc exported as Office
    'Classroom/Physics_ 12A/Unit 1_ Forces/Worksheet.pdf', // original PDF, untouched
    'Classroom/Physics_ 12A/Unit 2/Reading pack/Chapter 1.docx',
  ]);
  expect(downloads.every((d) => d.conflictAction === 'uniquify')).toBe(true);
  expect(downloads.find((d) => d.filename.endsWith('Class notes.docx'))?.url).toContain('format=docx');

  expect(done.dl.done).toBe(3);
  expect(done.dl.failed).toBe(1);
  expect(done.dl.failures[0]?.reason).toMatch(/disabled|no access/i);
});

test('RESET returns to idle', async () => {
  await send({ type: 'RESET' });
  const s = await send({ type: 'GET_STATE' });
  expect(s.phase).toBe('idle');
  expect(s.files).toHaveLength(0);
});
