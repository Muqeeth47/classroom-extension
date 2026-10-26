// @vitest-environment jsdom
// Reads simulated Classroom post pages. The first test reproduces a real report: a post with 13 attachments
// returned 34 links because the page also held a closed side menu with a Drive-folder link for EVERY class.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { scrapeAttachmentsInPage } from '../src/scrape';

// jsdom has no layout engine: give it the one bit the scraper reads.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  get() {
    return this.textContent ?? '';
  },
  configurable: true,
});

const file = (id: string, name: string) =>
  `<a href="https://drive.google.com/file/d/${id}/view?usp=classroom_web&authuser=0" aria-label="${name}">${name}</a>`;
const classFolder = (id: string, cls: string) =>
  `<a href="https://drive.google.com/drive/folders/${id}" aria-label="Open folder for &quot;${cls}&quot; in Google Drive">Open folder</a>`;

const CLASSES = ['CN (2026-27) C', 'OOAD V-SEM-C', 'CSE V SEM C SECTION', 'FSD-1 5C', 'ATCD CSE-C', 'V SEM CSE-C', 'IV SEM DBMS',
  'UHV II-IV SEM', 'IV SEM 2025-2026 CSE-C', 'P&S CSE - C', 'IV CSE-C PYTHON', 'IV Sem OS & Lab', 'IV-SEM-CSE-C'];
const attachments = Array.from({ length: 13 }, (_, i) => file('F' + i, `Unit ${i + 1}.pdf`)).join('');

async function read(): Promise<{ href: string; text: string }[]> {
  const p = scrapeAttachmentsInPage();
  await vi.advanceTimersByTimeAsync(15_000);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('only the post\'s own attachments are returned', () => {
  test('a closed side menu full of other classes\' folders is ignored (display:none)', async () => {
    document.body.innerHTML = `<main>${attachments}</main>
      <div id="menu" style="display:none">${CLASSES.map((c, i) => classFolder('C' + i, c)).join('')}</div>`;
    const links = await read();
    expect(links).toHaveLength(13);
    expect(links.every((l) => l.href.includes('/file/d/F'))).toBe(true);
  });

  test('...also when the menu is hidden with aria-hidden, hidden, or inert', async () => {
    document.body.innerHTML = `<main>${attachments}</main>
      <div aria-hidden="true">${file('H1', 'a.pdf')}</div>
      <div hidden>${file('H2', 'b.pdf')}</div>
      <div inert>${file('H3', 'c.pdf')}</div>`;
    expect(await read()).toHaveLength(13);
  });

  test('...and even when the menu is rendered and visible, its class-folder links are never attachments', async () => {
    document.body.innerHTML = `<main>${attachments}</main><aside>${CLASSES.map((c, i) => classFolder('C' + i, c)).join('')}</aside>`;
    const links = await read();
    expect(links).toHaveLength(13);
    expect(links.some((l) => l.href.includes('/drive/folders/'))).toBe(false);
  });

  test('the class\'s own "Class Drive folder" link is not an attachment', async () => {
    document.body.innerHTML = `<main>${file('F1', 'a.pdf')}<a href="https://drive.google.com/drive/folders/X">Class Drive folder</a></main>`;
    expect(await read()).toHaveLength(1);
  });

  test('a folder a teacher really attached is kept (it is expanded later)', async () => {
    document.body.innerHTML = `<main>${file('F1', 'a.pdf')}<a href="https://drive.google.com/drive/folders/READING" aria-label="Reading pack">Reading pack</a></main>`;
    const links = await read();
    expect(links.map((l) => l.text)).toEqual(['a.pdf', 'Reading pack']);
  });

  test('a hidden ancestor hides everything inside it, however deep', async () => {
    document.body.innerHTML = `<main>${file('F1', 'a.pdf')}<section style="display:none"><div><div>${file('F2', 'b.pdf')}</div></div></section></main>`;
    expect(await read()).toHaveLength(1);
  });

  test('links in the header or navigation are still ignored, and repeated links appear once', async () => {
    document.body.innerHTML = `<header>${file('H', 'h.pdf')}</header><nav>${file('N', 'n.pdf')}</nav>
      <main>${file('F1', 'a.pdf')}${file('F1', 'a.pdf')}</main>`;
    expect(await read()).toHaveLength(1);
  });

  test('other Google links (docs, slides) are kept; unrelated sites are not', async () => {
    document.body.innerHTML = `<main>
      <a href="https://docs.google.com/document/d/D1/edit">Notes</a>
      <a href="https://docs.google.com/presentation/d/P1/edit">Slides</a>
      <a href="https://www.youtube.com/watch?v=abc">Video</a>
      <a href="https://example.com/file.pdf">Elsewhere</a></main>`;
    expect((await read()).map((l) => l.text)).toEqual(['Notes', 'Slides']);
  });

  test('a post with no attachments returns nothing, without hanging', async () => {
    document.body.innerHTML = '<main><p>Just a message</p></main>';
    expect(await read()).toEqual([]);
  });
});

describe('layout-based hiding', () => {
  const rect = (left: number, right: number) => () => ({ width: right - left, height: 20, left, right, top: 0, bottom: 20, x: left, y: 0, toJSON() {} }) as DOMRect;
  const original = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = original;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  });

  test('a link slid off the left edge (a closed side menu) is ignored', async () => {
    document.body.innerHTML = `<main>${file('F1', 'a.pdf')}</main>`;
    Element.prototype.getBoundingClientRect = rect(-600, -200);
    expect(await read()).toEqual([]);
  });

  test('a link on screen is kept', async () => {
    document.body.innerHTML = `<main>${file('F1', 'a.pdf')}</main>`;
    Element.prototype.getBoundingClientRect = rect(100, 400);
    expect(await read()).toHaveLength(1);
  });

  test('a tab that reports a zero width must not hide every attachment', async () => {
    document.body.innerHTML = `<main>${attachments}</main>`;
    Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
    Element.prototype.getBoundingClientRect = rect(100, 400);
    expect(await read()).toHaveLength(13);
  });
});

