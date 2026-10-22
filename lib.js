// Pure helpers shared by the background worker and the tests. No browser-API calls here.

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Google-native files have no "original" file, so they're exported. */
export const EXPORT_KINDS = new Set(['document', 'presentation', 'spreadsheets']);

const EXPORT_EXT = {
  document: { pdf: 'pdf', office: 'docx' },
  presentation: { pdf: 'pdf', office: 'pptx' },
  spreadsheets: { pdf: 'pdf', office: 'xlsx' },
};

/** Make a string safe to use as one Windows/macOS/Linux path segment. */
export function sanitize(s, max = 80) {
  let out = String(s ?? '').replace(BAD_CHARS, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (out.length > max) out = out.slice(0, max).trim();
  if (RESERVED.test(out)) out = '_' + out;
  return out;
}

/** Like sanitize, but keeps a short file extension intact when truncating. */
export function sanitizeFileName(name, max = 120) {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  const hasExt = dot > 0 && s.length - dot <= 9;
  const extBody = hasExt ? sanitize(s.slice(dot + 1), 8) : '';
  const ext = extBody ? '.' + extBody : '';
  const base = sanitize(hasExt ? s.slice(0, dot) : s, Math.max(10, max - ext.length));
  return (base || 'file') + ext;
}

/** Classroom sometimes wraps outbound links in google.com/url?q=… */
export function unwrapGoogleRedirect(href) {
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
 * Returns {kind, id, authuser} or null if it isn't something we can act on.
 * kind: file | document | presentation | spreadsheets | folder | form
 */
export function classify(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const authuser = u.searchParams.get('authuser') || '';
  let m;
  if (u.hostname === 'drive.google.com') {
    if ((m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { kind: 'file', id: m[1], authuser };
    if ((m = u.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/))) return { kind: 'folder', id: m[1], authuser };
    if (u.pathname === '/open' || u.pathname === '/uc') {
      const id = u.searchParams.get('id');
      if (id) return { kind: 'file', id, authuser };
    }
  } else if (u.hostname === 'docs.google.com') {
    if ((m = u.pathname.match(/\/(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return { kind: m[1], id: m[2], authuser };
    }
    if ((m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { kind: 'file', id: m[1], authuser };
    if (/\/forms\//.test(u.pathname)) return { kind: 'form', id: '', authuser };
  }
  return null;
}

/**
 * The URL the browser should fetch to get the file: originals as-is, Google-native docs
 * exported as PDF (default) or as Office files (docFormat 'office').
 */
export function downloadUrlFor({ kind, id, authuser }, docFormat = 'pdf') {
  const q = new URLSearchParams();
  let base;
  const ext = EXPORT_EXT[kind]?.[docFormat === 'office' ? 'office' : 'pdf'];
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
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

export function exportExtFor(kind, docFormat = 'pdf') {
  return EXPORT_EXT[kind]?.[docFormat === 'office' ? 'office' : 'pdf'] || '';
}

export function filenameFromDisposition(cd) {
  if (!cd) return null;
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim());
    } catch {
      /* fall through */
    }
  }
  m = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
  return m ? m[1].trim() : null;
}

const MIME_EXT = {
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

export function extFromMime(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[base] || '';
}

/** Pick the best file name we can: server-provided first, then the link text, then the id. */
export function buildFileName({ cd, ct, hint, kind, id, docFormat = 'pdf' }) {
  let name = filenameFromDisposition(cd);
  if (!name) {
    const h = String(hint || '').split('\n')[0].trim();
    name = h || `${kind}-${String(id).slice(0, 8)}`;
  }
  if (EXPORT_KINDS.has(kind)) {
    // Swap, don't append: a server-supplied "notes.pdf" must become "notes.docx", not "notes.pdf.docx".
    name = name.replace(/\.(pdf|docx?|pptx?|xlsx?)$/i, '') + '.' + exportExtFor(kind, docFormat);
  } else if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    name += extFromMime(ct);
  }
  return sanitizeFileName(name);
}

// ---------------------------------------------------------------- Drive folders

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Parse the HTML of drive.google.com/embeddedfolderview?id=… into [{href, name}].
 * That page is a plain, server-rendered list, which is why it's usable without the Drive API.
 */
export function parseFolderHtml(html) {
  const out = [];
  const blocks = String(html || '').split(/class="flip-entry"/).slice(1);
  for (const b of blocks) {
    const href = b.match(/<a[^>]+href="([^"]+)"/i)?.[1];
    const name = b.match(/class="flip-entry-title"[^>]*>([^<]*)</i)?.[1];
    if (href) out.push({ href: decodeEntities(href), name: decodeEntities(name || '').trim() });
  }
  return out;
}
