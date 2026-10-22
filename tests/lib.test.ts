import { describe, expect, test } from 'vitest';
import {
  buildFileName,
  classify,
  decodeEntities,
  downloadUrlFor,
  exportExtFor,
  filenameFromDisposition,
  pageKind,
  courseIdFromPath,
  authuserFromPath,
  buildDownloadPath,
  describeHttpFailure,
  parseFolderHtml,
  sanitize,
  sanitizeFileName,
  unwrapGoogleRedirect,
} from '../src/lib';

describe('classify', () => {
  test('drive file links in every shape Classroom uses', () => {
    expect(classify('https://drive.google.com/file/d/1AbC_-x/view?usp=classroom_web&authuser=2')).toEqual({
      kind: 'file',
      id: '1AbC_-x',
      authuser: '2',
    });
    expect(classify('https://drive.google.com/open?id=ZZZ111')?.id).toBe('ZZZ111');
    expect(classify('https://drive.google.com/drive/folders/FOLD1')?.kind).toBe('folder');
    expect(classify('https://drive.google.com/drive/u/1/folders/FOLD2')?.id).toBe('FOLD2');
    expect(classify('https://docs.google.com/file/d/OLD1/edit')?.kind).toBe('file');
  });

  test('google-native docs and forms', () => {
    expect(classify('https://docs.google.com/document/d/DOC1/edit')?.kind).toBe('document');
    expect(classify('https://docs.google.com/presentation/d/PRES1/edit')?.kind).toBe('presentation');
    expect(classify('https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=0')?.kind).toBe('spreadsheets');
    expect(classify('https://docs.google.com/forms/d/e/FORM/viewform')?.kind).toBe('form');
  });

  test('ignores unrelated links', () => {
    expect(classify('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(classify('https://drive.google.com/drive/my-drive')).toBeNull();
    expect(classify('not a url')).toBeNull();
  });
});

test('unwrapGoogleRedirect', () => {
  const wrapped = 'https://www.google.com/url?q=' + encodeURIComponent('https://docs.google.com/document/d/DOC1/edit') + '&sa=D';
  expect(unwrapGoogleRedirect(wrapped)).toBe('https://docs.google.com/document/d/DOC1/edit');
  expect(unwrapGoogleRedirect('https://drive.google.com/file/d/A/view')).toBe('https://drive.google.com/file/d/A/view');
});

describe('downloadUrlFor', () => {
  test('originals are fetched as-is', () => {
    const f = downloadUrlFor({ kind: 'file', id: 'ID1', authuser: '1' });
    expect(f).toMatch(/^https:\/\/drive\.usercontent\.google\.com\/download\?/);
    expect(f).toContain('id=ID1');
    expect(f).toContain('authuser=1');
  });

  test('Google docs honour the chosen format', () => {
    expect(downloadUrlFor({ kind: 'document', id: 'D' })).toBe('https://docs.google.com/document/d/D/export?format=pdf');
    expect(downloadUrlFor({ kind: 'document', id: 'D' }, 'office')).toBe('https://docs.google.com/document/d/D/export?format=docx');
    expect(downloadUrlFor({ kind: 'presentation', id: 'P' })).toBe('https://docs.google.com/presentation/d/P/export/pdf');
    expect(downloadUrlFor({ kind: 'presentation', id: 'P' }, 'office')).toBe('https://docs.google.com/presentation/d/P/export/pptx');
    expect(downloadUrlFor({ kind: 'spreadsheets', id: 'S' }, 'office')).toBe('https://docs.google.com/spreadsheets/d/S/export?format=xlsx');
    expect(downloadUrlFor({ kind: 'folder', id: 'F' })).toBeNull();
    expect(exportExtFor('spreadsheets', 'office')).toBe('xlsx');
  });
});

test('filenameFromDisposition handles quoted, bare and RFC 5987 forms', () => {
  expect(filenameFromDisposition('attachment; filename="Week 1 notes.pdf"')).toBe('Week 1 notes.pdf');
  expect(filenameFromDisposition('attachment; filename=notes.pdf')).toBe('notes.pdf');
  expect(filenameFromDisposition("attachment; filename*=UTF-8''Caf%C3%A9.pdf")).toBe('Café.pdf');
  expect(filenameFromDisposition('')).toBeNull();
});

describe('file names', () => {
  test('sanitize strips characters Windows rejects', () => {
    expect(sanitize('Unit 1: Forces / Motion?')).toBe('Unit 1_ Forces _ Motion_');
    expect(sanitize('trailing dot.')).toBe('trailing dot');
    expect(sanitize('con')).toBe('_con');
    expect(sanitize('   ')).toBe('');
  });

  test('sanitizeFileName keeps the extension when truncating', () => {
    const out = sanitizeFileName('a'.repeat(300) + '.pdf', 50);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  test('buildFileName keeps originals untouched and fixes up exports', () => {
    expect(buildFileName({ cd: 'attachment; filename="Lab.docx"', ct: '', kind: 'file', id: 'x' })).toBe('Lab.docx');
    expect(buildFileName({ cd: 'attachment; filename="Model.stl"', ct: 'application/octet-stream', kind: 'file', id: 'x' })).toBe('Model.stl');
    expect(buildFileName({ cd: '', ct: 'application/pdf', hint: 'Worksheet 3', kind: 'file', id: 'x' })).toBe('Worksheet 3.pdf');
    expect(buildFileName({ cd: 'attachment; filename="Slides"', ct: '', kind: 'presentation', id: 'x' })).toBe('Slides.pdf');
    expect(buildFileName({ cd: 'attachment; filename="Slides"', ct: '', kind: 'presentation', id: 'x', docFormat: 'office' })).toBe('Slides.pptx');
    expect(buildFileName({ cd: 'attachment; filename="Essay.docx"', ct: '', kind: 'document', id: 'x', docFormat: 'office' })).toBe('Essay.docx');
    expect(buildFileName({ cd: 'attachment; filename="Notes.pdf"', ct: '', kind: 'document', id: 'x', docFormat: 'office' })).toBe('Notes.docx');
    expect(buildFileName({ cd: 'attachment; filename="v1.2 plan"', ct: '', kind: 'document', id: 'x' })).toBe('v1.2 plan.pdf');
    expect(buildFileName({ cd: '', ct: '', hint: '', kind: 'file', id: 'abcdefghijkl' })).toBe('file-abcdefgh');
    // a numeric tail like ".2" is not an extension, so the real type is added
    expect(buildFileName({ cd: '', ct: 'application/pdf', hint: 'Version 1.2', kind: 'file', id: 'x' })).toBe('Version 1.2.pdf');
    expect(buildFileName({ cd: '', ct: 'application/pdf', hint: 'notes.pdf', kind: 'file', id: 'x' })).toBe('notes.pdf');
  });
});

test('decodeEntities', () => {
  expect(decodeEntities('Tom &amp; Jerry &#39;s &quot;x&quot; &#x41;')).toBe(`Tom & Jerry 's "x" A`);
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
  expect(entries).toHaveLength(2);
  expect(entries[0]).toEqual({ href: 'https://drive.google.com/file/d/AAA/view?usp=drive_web', name: 'Notes & Slides.pdf' });
  expect(entries[1]?.name).toBe('Week 2');
  expect(parseFolderHtml('<html>sign in</html>')).toHaveLength(0);
});

describe('pageKind', () => {
  test('a single post is a post, whatever the account number', () => {
    expect(pageKind('https://classroom.google.com/c/ODc1NDc5MzU2Mjc5/m/ODcwMjA4MzI0ODE1/details')).toBe('post');
    expect(pageKind('https://classroom.google.com/u/1/c/ABC/a/DEF/details')).toBe('post');
    expect(pageKind('https://classroom.google.com/c/ABC/sp/DEF')).toBe('post');
  });

  test('class pages are classes', () => {
    expect(pageKind('https://classroom.google.com/c/ODc1NDc5MzU2Mjc5')).toBe('class');
    expect(pageKind('https://classroom.google.com/w/ODc1NDc5MzU2Mjc5/t/all')).toBe('class');
    expect(pageKind('https://classroom.google.com/u/2/c/ABC/p')).toBe('class');
  });

  test('pages that list every class are never scanned', () => {
    expect(pageKind('https://classroom.google.com/h')).toBeNull();
    expect(pageKind('https://classroom.google.com/h/st')).toBeNull();
    expect(pageKind('https://classroom.google.com/u/0/h')).toBeNull();
    expect(pageKind('https://classroom.google.com/a/not-turned-in/all')).toBeNull();
    expect(pageKind('https://classroom.google.com/')).toBeNull();
    expect(pageKind('https://example.com/c/ABC/m/DEF/details')).toBeNull();
    expect(pageKind('nonsense')).toBeNull();
  });

  test('courseIdFromPath', () => {
    expect(courseIdFromPath('/c/ABC/m/DEF/details')).toBe('ABC');
    expect(courseIdFromPath('/u/1/w/XYZ/t/all')).toBe('XYZ');
    expect(courseIdFromPath('/h')).toBeNull();
  });
});

describe('resource keys and announcements', () => {
  test('older shared links carry their resource key into the download URL', () => {
    const c = classify('https://drive.google.com/file/d/ABC/view?resourcekey=0-xyz');
    expect(c).toEqual({ kind: 'file', id: 'ABC', authuser: '', resourcekey: '0-xyz' });
    expect(downloadUrlFor(c!)).toContain('resourcekey=0-xyz');
    expect(downloadUrlFor(classify('https://docs.google.com/document/d/D/edit?resourcekey=0-k')!)).toContain('resourcekey=0-k');
    expect(classify('https://drive.google.com/file/d/ABC/view')).not.toHaveProperty('resourcekey');
  });

  test('announcement pages (/p/<id>) count as a post; the bare /p tab does not', () => {
    expect(pageKind('https://classroom.google.com/c/ABC/p/POSTID')).toBe('post');
    expect(pageKind('https://classroom.google.com/u/1/c/ABC/p/POSTID')).toBe('post');
    expect(pageKind('https://classroom.google.com/c/ABC/p')).toBe('class');
  });

  test('authuserFromPath reads the account number', () => {
    expect(authuserFromPath('/u/2/c/ABC/m/DEF/details')).toBe('2');
    expect(authuserFromPath('/c/ABC')).toBe('');
  });
});

describe('buildDownloadPath', () => {
  test('short paths are left alone', () => {
    expect(buildDownloadPath('Classroom', ['Physics', 'Unit 1'], 'a.pdf')).toBe('Classroom/Physics/Unit 1/a.pdf');
  });

  test('long folder names are shortened to fit, keeping the extension', () => {
    const p = buildDownloadPath('Classroom', ['c'.repeat(60), 't'.repeat(60), 's'.repeat(60), 'u'.repeat(60)], 'n'.repeat(100) + '.pdf');
    expect(p.length).toBeLessThanOrEqual(190);
    expect(p.endsWith('.pdf')).toBe(true);
    expect(p.split('/')).toHaveLength(6);
  });

  test('empty and unsafe folders are dropped, never producing "//" or ".."', () => {
    const p = buildDownloadPath('Classroom', ['', '..', 'a/b', '   '], 'f.txt');
    expect(p).toBe('Classroom/a_b/f.txt');
    expect(p).not.toContain('//');
  });
});

describe('describeHttpFailure', () => {
  test.each([
    [403, /permission/i],
    [404, /not found/i],
    [429, /limiting/i],
    [503, /problem/i],
    [418, /418/],
  ])('status %i', (status, re) => {
    expect(describeHttpFailure(status)).toMatch(re);
  });
});
