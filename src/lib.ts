// Pure helpers shared by the background worker and the tests. No browser-API calls here.

import type { Classified, DocFormat, FileKind, Kind, PageKind } from './types';

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Google-native files have no "original" file, so they're exported. */
export const EXPORT_KINDS: ReadonlySet<Kind> = new Set<Kind>(['document', 'presentation', 'spreadsheets']);

const EXPORT_EXT: Partial<Record<Kind, Record<DocFormat, string>>> = {
  document: { pdf: 'pdf', office: 'docx' },
  presentation: { pdf: 'pdf', office: 'pptx' },
  spreadsheets: { pdf: 'pdf', office: 'xlsx' },
};

/** Make a string safe to use as one Windows/macOS/Linux path segment. */
export function sanitize(s: unknown, max = 80): string {
  let out = String(s ?? '').replace(BAD_CHARS, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (out.length > max) out = out.slice(0, max).trim();
  if (RESERVED.test(out)) out = '_' + out;
  return out;
}

/** Like sanitize, but keeps a short file extension intact when truncating. */
export function sanitizeFileName(name: unknown, max = 120): string {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  const hasExt = dot > 0 && s.length - dot <= 9;
  const extBody = hasExt ? sanitize(s.slice(dot + 1), 8) : '';
  const ext = extBody ? '.' + extBody : '';
  const base = sanitize(hasExt ? s.slice(0, dot) : s, Math.max(10, max - ext.length));
  return (base || 'file') + ext;
}

/** Classroom sometimes wraps outbound links in google.com/url?q=… */
export function unwrapGoogleRedirect(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === 'www.google.com' && u.pathname === '/url') {
      return u.searchParams.get('q') || u.searchParams.get('url') || href;
    }
  } catch {
    /* fall through */
  }
  return href;
}

/**
 * Work out what a Drive/Docs link points at.
 * Returns null if it isn't something we can act on.
 */
export function classify(href: string): Classified | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const authuser = u.searchParams.get('authuser') || '';
  const resourcekey = u.searchParams.get('resourcekey') || undefined;
  const withKey = (c: Classified): Classified => (resourcekey ? { ...c, resourcekey } : c);
  let m: RegExpMatchArray | null;
  if (u.hostname === 'drive.google.com') {
    if ((m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/))) return withKey({ kind: 'file', id: m[1]!, authuser });
    if ((m = u.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/))) return { kind: 'folder', id: m[1]!, authuser };
    if (u.pathname === '/open' || u.pathname === '/uc') {
      const id = u.searchParams.get('id');
      if (id) return withKey({ kind: 'file', id, authuser });
    }
  } else if (u.hostname === 'docs.google.com') {
    if ((m = u.pathname.match(/\/(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return withKey({ kind: m[1] as Kind, id: m[2]!, authuser });
    }
    if ((m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/))) return withKey({ kind: 'file', id: m[1]!, authuser });
    if (/\/forms\//.test(u.pathname)) return { kind: 'form', id: '', authuser };
  }
  return null;
}

export function exportExtFor(kind: Kind, docFormat: DocFormat = 'pdf'): string {
  return EXPORT_EXT[kind]?.[docFormat === 'office' ? 'office' : 'pdf'] ?? '';
}

/**
 * The URL the browser should fetch to get the file: originals as-is, Google-native docs
 * exported as PDF (default) or as Office files (docFormat 'office').
 */
export function downloadUrlFor(
  { kind, id, authuser, resourcekey }: { kind: Kind; id: string; authuser?: string; resourcekey?: string },
  docFormat: DocFormat = 'pdf',
): string | null {
  const q = new URLSearchParams();
  const ext = exportExtFor(kind, docFormat);
  let base: string;
  switch (kind) {
    case 'file':
      base = 'https://drive.usercontent.google.com/download';
      q.set('id', id);
      q.set('export', 'download');
      q.set('confirm', 't'); // skips the "can't scan for viruses" interstitial on big files
      break;
    case 'document':
      base = `https://docs.google.com/document/d/${id}/export`;
      q.set('format', ext);
      break;
    case 'spreadsheets':
      base = `https://docs.google.com/spreadsheets/d/${id}/export`;
      q.set('format', ext);
      break;
    case 'presentation':
      base = `https://docs.google.com/presentation/d/${id}/export/${ext}`;
      break;
    default:
      return null;
  }
  if (authuser) q.set('authuser', authuser);
  if (resourcekey) q.set('resourcekey', resourcekey);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

export function filenameFromDisposition(cd: string | null | undefined): string | null {
  if (!cd) return null;
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  m = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
  return m ? m[1]!.trim() : null;
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/json': '.json',
  'application/rtf': '.rtf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export function extFromMime(ct: string | null | undefined): string {
  const base = String(ct || '').split(';')[0]!.trim().toLowerCase();
  return MIME_EXT[base] || '';
}

export interface FileNameInput {
  cd?: string;
  ct?: string;
  hint?: string;
  kind: FileKind;
  id: string;
  docFormat?: DocFormat;
}

/** "notes.pdf" has an extension; "Version 1.2" and "Week 3." do not (a purely numeric tail is not one). */
function hasRealExtension(name: string): boolean {
  const ext = name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  return !!ext && !/^\d+$/.test(ext);
}

/** Pick the best file name we can: server-provided first, then the link text, then the id. */
export function buildFileName({ cd, ct, hint, kind, id, docFormat = 'pdf' }: FileNameInput): string {
  let name = filenameFromDisposition(cd);
  if (!name) {
    const h = String(hint || '').split('\n')[0]!.trim();
    name = h || `${kind}-${String(id).slice(0, 8)}`;
  }
  if (EXPORT_KINDS.has(kind)) {
    // Swap, don't append: a server-supplied "notes.pdf" must become "notes.docx", not "notes.pdf.docx".
    name = name.replace(/\.(pdf|docx?|pptx?|xlsx?)$/i, '') + '.' + exportExtFor(kind, docFormat);
  } else if (!hasRealExtension(name)) {
    name += extFromMime(ct);
  }
  return sanitizeFileName(name);
}

// ---------------------------------------------------------------- Drive folders

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: unknown): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Parse the HTML of drive.google.com/embeddedfolderview?id=… into [{href, name}].
 * That page is a plain, server-rendered list, which is why it's usable without the Drive API.
 */
export function parseFolderHtml(html: string): { href: string; name: string }[] {
  const out: { href: string; name: string }[] = [];
  const blocks = String(html || '').split(/class="flip-entry"/).slice(1);
  for (const b of blocks) {
    const href = b.match(/<a[^>]+href="([^"]+)"/i)?.[1];
    const name = b.match(/class="flip-entry-title"[^>]*>([^<]*)</i)?.[1];
    if (href) out.push({ href: decodeEntities(href), name: decodeEntities(name || '').trim() });
  }
  return out;
}

// ---------------------------------------------------------------- Classroom pages

const POST_PATH = /^\/(?:u\/\d+\/)?c\/[^/]+\/(?:a|m|sp|qs|p)\/[^/]+/;
const CLASS_PATH = /^\/(?:u\/\d+\/)?(?:c|w)\/[^/]+/;

/**
 * What the given Classroom URL is: a single post, a class page, or neither (home, to-do,
 * calendar...). Pages that list every class must never be scanned.
 */
export function pageKind(href: string): PageKind | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.hostname !== 'classroom.google.com') return null;
  if (POST_PATH.test(u.pathname)) return 'post';
  if (CLASS_PATH.test(u.pathname)) return 'class';
  return null;
}

/** The course id in a Classroom URL (/c/<id>/... or /w/<id>/...), if any. */
export function courseIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/(?:u\/\d+\/)?(?:c|w)\/([^/?#]+)/)?.[1] ?? null;
}

/** The Google account number in a Classroom URL (/u/1/...), or '' for the default account. */
export function authuserFromPath(pathname: string): string {
  return pathname.match(/^\/u\/(\d+)\//)?.[1] ?? '';
}

// ---------------------------------------------------------------- download paths

/**
 * Join path segments for chrome.downloads, keeping the whole relative path under `budget`
 * characters. Windows refuses paths over ~260 characters including the Downloads folder, so deep
 * folder names are shortened (longest first) and, as a last resort, so is the file name.
 */
export function buildDownloadPath(root: string, folders: string[], name: string, budget = 190): string {
  const dirs = folders.map((f) => sanitize(f, 60)).filter(Boolean);
  let file = name;
  const total = () => root.length + dirs.reduce((n, d) => n + d.length + 1, 0) + file.length + 1;

  while (total() > budget) {
    let longest = -1;
    for (let i = 0; i < dirs.length; i++) if (longest < 0 || dirs[i]!.length > dirs[longest]!.length) longest = i;
    if (longest < 0 || dirs[longest]!.length <= 10) break;
    const cut = Math.min(total() - budget, dirs[longest]!.length - 10);
    dirs[longest] = sanitize(dirs[longest]!.slice(0, dirs[longest]!.length - cut), 60) || '_';
  }
  if (total() > budget) file = sanitizeFileName(file, Math.max(24, file.length - (total() - budget)));
  return [root, ...dirs, file].join('/');
}

/** Turn an HTTP status into something a student can act on. */
export function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return 'No permission. The owner may have disabled downloading, or you are signed in with a different Google account.';
  if (status === 404) return 'File not found. It may have been deleted.';
  if (status === 429) return 'Google is limiting downloads of this file right now. Try again later.';
  if (status >= 500) return `Google had a problem (HTTP ${status}). Try again later.`;
  return `Google refused the download (HTTP ${status}).`;
}
