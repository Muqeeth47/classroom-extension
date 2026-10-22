import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitize,
  sanitizeFileName,
  classify,
  downloadUrlFor,
  filenameFromDisposition,
  buildFileName,
  unwrapGoogleRedirect,
  decodeEntities,
  parseFolderHtml,
  exportExtFor,
} from '../lib.js';

test('classify: drive file links in every shape Classroom uses', () => {
  assert.deepEqual(classify('https://drive.google.com/file/d/1AbC_-x/view?usp=classroom_web&authuser=2'), {
    kind: 'file', id: '1AbC_-x', authuser: '2',
  });
  assert.equal(classify('https://drive.google.com/open?id=ZZZ111').id, 'ZZZ111');
  assert.equal(classify('https://drive.google.com/drive/folders/FOLD1').kind, 'folder');
  assert.equal(classify('https://drive.google.com/drive/u/1/folders/FOLD2').id, 'FOLD2');
  assert.equal(classify('https://docs.google.com/file/d/OLD1/edit').kind, 'file');
});

test('classify: google-native docs and forms', () => {
  assert.equal(classify('https://docs.google.com/document/d/DOC1/edit').kind, 'document');
  assert.equal(classify('https://docs.google.com/presentation/d/PRES1/edit').kind, 'presentation');
  assert.equal(classify('https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=0').kind, 'spreadsheets');
  assert.equal(classify('https://docs.google.com/forms/d/e/FORM/viewform').kind, 'form');
});

test('classify: ignores unrelated links', () => {
  assert.equal(classify('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(classify('https://drive.google.com/drive/my-drive'), null);
  assert.equal(classify('not a url'), null);
});

test('unwrapGoogleRedirect', () => {
  const wrapped = 'https://www.google.com/url?q=' + encodeURIComponent('https://docs.google.com/document/d/DOC1/edit') + '&sa=D';
  assert.equal(unwrapGoogleRedirect(wrapped), 'https://docs.google.com/document/d/DOC1/edit');
  assert.equal(unwrapGoogleRedirect('https://drive.google.com/file/d/A/view'), 'https://drive.google.com/file/d/A/view');
});

test('downloadUrlFor: originals are fetched as-is; Google docs honour the chosen format', () => {
  const f = downloadUrlFor({ kind: 'file', id: 'ID1', authuser: '1' });
  assert.match(f, /^https:\/\/drive\.usercontent\.google\.com\/download\?/);
  assert.match(f, /id=ID1/);
  assert.match(f, /authuser=1/);

  assert.equal(downloadUrlFor({ kind: 'document', id: 'D' }), 'https://docs.google.com/document/d/D/export?format=pdf');
  assert.equal(downloadUrlFor({ kind: 'document', id: 'D' }, 'office'), 'https://docs.google.com/document/d/D/export?format=docx');
  assert.equal(downloadUrlFor({ kind: 'presentation', id: 'P' }), 'https://docs.google.com/presentation/d/P/export/pdf');
  assert.equal(downloadUrlFor({ kind: 'presentation', id: 'P' }, 'office'), 'https://docs.google.com/presentation/d/P/export/pptx');
  assert.equal(downloadUrlFor({ kind: 'spreadsheets', id: 'S' }, 'office'), 'https://docs.google.com/spreadsheets/d/S/export?format=xlsx');
  assert.equal(downloadUrlFor({ kind: 'folder', id: 'F' }), null);
  assert.equal(exportExtFor('spreadsheets', 'office'), 'xlsx');
});

test('filenameFromDisposition handles quoted, bare and RFC 5987 forms', () => {
  assert.equal(filenameFromDisposition('attachment; filename="Week 1 notes.pdf"'), 'Week 1 notes.pdf');
  assert.equal(filenameFromDisposition('attachment; filename=notes.pdf'), 'notes.pdf');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''Caf%C3%A9.pdf"), 'Café.pdf');
  assert.equal(filenameFromDisposition(''), null);
});

test('sanitize strips characters Windows rejects', () => {
  assert.equal(sanitize('Unit 1: Forces / Motion?'), 'Unit 1_ Forces _ Motion_');
  assert.equal(sanitize('trailing dot.'), 'trailing dot');
  assert.equal(sanitize('con'), '_con');
  assert.equal(sanitize('   '), '');
});

test('sanitizeFileName keeps the extension when truncating', () => {
  const out = sanitizeFileName('a'.repeat(300) + '.pdf', 50);
  assert.ok(out.endsWith('.pdf'));
  assert.ok(out.length <= 50);
});

test('buildFileName keeps originals untouched and fixes up exports', () => {
  assert.equal(buildFileName({ cd: 'attachment; filename="Lab.docx"', ct: '', kind: 'file', id: 'x' }), 'Lab.docx');
  assert.equal(buildFileName({ cd: 'attachment; filename="Model.stl"', ct: 'application/octet-stream', kind: 'file', id: 'x' }), 'Model.stl');
  assert.equal(buildFileName({ cd: '', ct: 'application/pdf', hint: 'Worksheet 3', kind: 'file', id: 'x' }), 'Worksheet 3.pdf');
  assert.equal(buildFileName({ cd: 'attachment; filename="Slides"', ct: '', kind: 'presentation', id: 'x' }), 'Slides.pdf');
  assert.equal(buildFileName({ cd: 'attachment; filename="Slides"', ct: '', kind: 'presentation', id: 'x', docFormat: 'office' }), 'Slides.pptx');
  assert.equal(buildFileName({ cd: 'attachment; filename="Essay.docx"', ct: '', kind: 'document', id: 'x', docFormat: 'office' }), 'Essay.docx');
  assert.equal(buildFileName({ cd: 'attachment; filename="Notes.pdf"', ct: '', kind: 'document', id: 'x', docFormat: 'office' }), 'Notes.docx');
  assert.equal(buildFileName({ cd: 'attachment; filename="v1.2 plan"', ct: '', kind: 'document', id: 'x' }), 'v1.2 plan.pdf');
  assert.equal(buildFileName({ cd: '', ct: '', hint: '', kind: 'file', id: 'abcdefghijkl' }), 'file-abcdefgh');
});

test('decodeEntities', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#39;s &quot;x&quot; &#x41;'), `Tom & Jerry 's "x" A`);
});

test('parseFolderHtml reads the embedded folder listing', () => {
  const html = `
    <div class="flip-entries">
      <div class="flip-entry" id="entry-AAA" tabindex="0">
        <a href="https://drive.google.com/file/d/AAA/view?usp=drive_web" target="_blank">
          <div class="flip-entry-info"><div class="flip-entry-title">Notes &amp; Slides.pdf</div></div></a></div>
      <div class="flip-entry" id="entry-BBB">
        <a href="https://drive.google.com/drive/folders/BBB" target="_blank">
          <div class="flip-entry-info"><div class="flip-entry-title">Week 2</div></div></a></div>
    </div>`;
  const entries = parseFolderHtml(html);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { href: 'https://drive.google.com/file/d/AAA/view?usp=drive_web', name: 'Notes & Slides.pdf' });
  assert.equal(entries[1].name, 'Week 2');
  assert.equal(parseFolderHtml('<html>sign in</html>').length, 0);
});
