/**
 * Runs INSIDE a Classroom page (injected with scripting.executeScript), so it must be fully self-contained:
 * no imports and nothing declared outside this function. Classroom renders attachments client-side, so it
 * polls until the links appear and stop changing.
 *
 * Only a page's own attachments are returned. A Classroom page also contains links that are NOT attachments:
 * the side menu keeps a "Open folder for <class> in Google Drive" link for EVERY class the user is in, and
 * that menu can be present in the page while closed. Reading those pulled other classes' folders (and files)
 * into the results, so anything hidden, off-screen, or labelled as a class folder is ignored.
 */
export async function scrapeAttachmentsInPage(): Promise<{ href: string; text: string }[]> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // "Open folder for "Physics 12A" in Google Drive" (the side menu) and the class's own Drive folder.
  const NOT_AN_ATTACHMENT = [/^open folder for .* in google drive$/i, /class drive folder/i];

  /** Is the link actually on the page for the user, rather than tucked away in a closed menu? */
  const isHidden = (el: Element): boolean => {
    for (let n: Element | null = el, depth = 0; n && depth < 60; n = n.parentElement, depth++) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden') || n.hasAttribute('inert')) return true;
      if (getComputedStyle(n).display === 'none') return true;
    }
    if (getComputedStyle(el).visibility === 'hidden') return true;
    const r = el.getBoundingClientRect();
    // A closed side menu is usually slid off the edge of the screen rather than removed.
    return r.width > 0 && window.innerWidth > 0 && (r.right <= 0 || r.left >= window.innerWidth);
  };

  const pick = () => {
    const out: { href: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.href;
      if (!/^https:\/\/(drive|docs|www)\.google\.com\//.test(href)) continue;
      if (a.closest('header, [role="banner"], [role="navigation"], nav')) continue;
      if (seen.has(href)) continue;
      const label = (a.getAttribute('aria-label') || a.innerText || '').trim();
      const first = label.split('\n')[0]!.trim();
      if (NOT_AN_ATTACHMENT.some((re) => re.test(first) || re.test(label))) continue;
      if (isHidden(a)) continue;
      seen.add(href);
      out.push({ href, text: label });
    }
    return out;
  };

  const start = Date.now();
  let lastCount = -1;
  let stableSince = 0;
  while (Date.now() - start < 9000) {
    const found = pick();
    if (found.length) {
      if (found.length === lastCount) {
        if (Date.now() - stableSince > 1200) break;
      } else {
        lastCount = found.length;
        stableSince = Date.now();
      }
    } else if (Date.now() - start > 5000 && document.readyState === 'complete') {
      break; // nothing showed up: probably a post with no attachments
    }
    await sleep(300);
  }
  return pick();
}
