// Runs the real background.js against a fake browser API and fake network, end to end:
// START -> scan -> read posts -> expand a Drive folder -> pick -> download.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- fake extension API -------------------------------------------------------------------
const listeners = { message: [], tabsUpdated: [], dlChanged: [] };
const downloads = [];
const session = {};
let nextId = 1;

const POSTS = {
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

globalThis.chrome = {
  storage: {
    session: {
      get: async () => ({ state: session.state }),
      set: async (o) => Object.assign(session, o),
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    getPlatformInfo: async () => ({}),
  },
  windows: { create: async () => ({ id: 99 }), remove: async () => {} },
  tabs: {
    create: async ({ url }) => ({ id: url, url, status: 'complete' }),
    remove: async () => {},
    get: async (id) => ({ id, status: 'complete' }),
    onUpdated: { addListener: (f) => listeners.tabsUpdated.push(f), removeListener() {} },
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
    executeScript: async ({ target }) => [{ result: POSTS[target.tabId] ?? [] }],
  },
  downloads: {
    download: async (opts) => {
      const id = nextId++;
      downloads.push({ id, ...opts });
      setTimeout(() => listeners.dlChanged.forEach((f) => f({ id, state: { current: 'complete' } })), 0);
      return id;
    },
    onChanged: {
      addListener: (f) => listeners.dlChanged.push(f),
      removeListener: (f) => listeners.dlChanged.splice(listeners.dlChanged.indexOf(f), 1),
    },
    search: async () => [],
    show() {},
  },
};

const FOLDER_HTML = `
  <div class="flip-entry" id="entry-F2"><a href="https://drive.google.com/file/d/F2/view"><div class="flip-entry-title">Chapter 1.docx</div></a></div>
  <div class="flip-entry" id="entry-SUB"><a href="https://drive.google.com/drive/folders/SUB1"><div class="flip-entry-title">Extras</div></a></div>`;
const SUB_HTML = `<div class="flip-entry" id="entry-F3"><a href="https://drive.google.com/file/d/F3/view"><div class="flip-entry-title">Diagram.png</div></a></div>`;

globalThis.fetch = async (url) => {
  const u = String(url);
  const hdr = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  if (u.includes('embeddedfolderview')) {
    const html = u.includes('id=SUB1') ? SUB_HTML : FOLDER_HTML;
    return { status: 200, text: async () => html, headers: hdr({}) };
  }
  if (u.includes('id=FILE1')) return { status: 200, headers: hdr({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Worksheet.pdf"' }) };
  if (u.includes('id=F2')) return { status: 200, headers: hdr({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Chapter 1.docx"' }) };
  if (u.includes('id=F3')) return { status: 200, headers: hdr({ 'content-type': 'text/html' }) }; // owner disabled downloads
  if (u.includes('/document/d/DOC1/')) return { status: 200, headers: hdr({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Class notes.pdf"' }) };
  return { status: 404, headers: hdr({}) };
};

const send = (msg) =>
  new Promise((resolve) => {
    listeners.message.forEach((fn) => fn(msg, {}, resolve));
  });

const until = async (pred, label) => {
  for (let i = 0; i < 200; i++) {
    const s = await send({ type: 'GET_STATE' });
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
};

await import('../background.js');

test('scans a class, dedupes, expands folders and reaches review', async () => {
  await send({ type: 'START', tabId: 1 });
  const s = await until((x) => x.phase === 'review', 'review phase');

  assert.equal(s.className, 'Physics 12A');
  const keys = s.files.map((f) => f.key).sort();
  assert.deepEqual(keys, ['document:DOC1', 'file:F2', 'file:F3', 'file:FILE1']); // FILE1 only once
  assert.equal(s.skipped.length, 1);
  assert.match(s.skipped[0].reason, /Form/);

  const f3 = s.files.find((f) => f.id === 'F3');
  assert.deepEqual(f3.sub, ['Reading pack', 'Extras']); // nested folder path preserved
  assert.equal(f3.topic, 'Unit 2');
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

  const names = downloads.map((d) => d.filename).sort();
  assert.deepEqual(names, [
    'Classroom/Physics_ 12A/Unit 1_ Forces/Class notes.docx', // Google Doc exported as Office
    'Classroom/Physics_ 12A/Unit 1_ Forces/Worksheet.pdf', // original PDF, untouched
    'Classroom/Physics_ 12A/Unit 2/Reading pack/Chapter 1.docx',
  ]);
  assert.ok(downloads.every((d) => d.conflictAction === 'uniquify'));
  assert.match(downloads.find((d) => d.filename.endsWith('Class notes.docx')).url, /format=docx/);

  assert.equal(done.dl.done, 3);
  assert.equal(done.dl.failed, 1);
  assert.match(done.dl.failures[0].reason, /disabled|no access/i);
});

test('RESET returns to idle', async () => {
  await send({ type: 'RESET' });
  const s = await send({ type: 'GET_STATE' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.files.length, 0);
});
