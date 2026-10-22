// Background worker (service worker in Chromium browsers, event page in Firefox).
// Flow: scan the Classwork page -> open each post in a hidden tab to read its attachments ->
// expand Drive folders -> let the user pick -> download each file in its original format.
// All progress lives in `state`, mirrored to storage.session, so the popup can close and reopen.

import {
  classify,
  downloadUrlFor,
  buildFileName,
  sanitize,
  unwrapGoogleRedirect,
  parseFolderHtml,
} from './lib.js';

const ROOT_FOLDER = 'Classroom';
const SCAN_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_FILES = 400;

function freshState() {
  return {
    phase: 'idle', // idle | scanning | collecting | review | downloading | done | error
    className: '',
    progress: { done: 0, total: 0, label: '' },
    files: [],
    skipped: [],
    dl: { total: 0, done: 0, failed: 0, failures: [], lastId: null, folder: '' },
    log: [],
    error: '',
  };
}

let state = freshState();
let cancelled = false;
let keepAliveTimer = null;

const ready = (async () => {
  try {
    const saved = (await chrome.storage.session.get('state')).state;
    if (saved) {
      state = saved;
      // A worker killed mid-run can't resume; say so instead of showing a spinner forever.
      if (['scanning', 'collecting', 'downloading'].includes(state.phase)) {
        state.phase = 'error';
        state.error = 'The browser stopped the extension mid-run. Please start again.';
      }
    }
  } catch {
    /* storage.session unavailable: start fresh */
  }
})();

async function save() {
  try {
    await chrome.storage.session.set({ state });
  } catch {
    /* non-fatal */
  }
}

function log(msg) {
  state.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (state.log.length > 80) state.log.shift();
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    const busy = ['scanning', 'collecting', 'downloading'].includes(state.phase);
    switch (msg?.type) {
      case 'GET_STATE':
        sendResponse(state);
        break;
      case 'START':
        if (!busy) start(msg.tabId).catch(fail);
        sendResponse({ ok: true });
        break;
      case 'DOWNLOAD':
        if (state.phase === 'review') download(msg).catch(fail);
        sendResponse({ ok: true });
        break;
      case 'CANCEL':
        cancelled = true;
        sendResponse({ ok: true });
        break;
      case 'RESET':
        cancelled = true;
        state = freshState();
        await save();
        sendResponse({ ok: true });
        break;
      case 'SHOW_IN_FOLDER':
        if (state.dl.lastId != null) chrome.downloads.show(state.dl.lastId);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // keep the channel open for the async response
});

async function fail(err) {
  stopKeepAlive();
  state.phase = 'error';
  state.error = String(err?.message || err);
  log(`ERROR ${state.error}`);
  await save();
}

// ---------------------------------------------------------------- scanning + collecting

async function requestScan(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'SCAN' });
  } catch {
    // The tab was open before the extension was installed or reloaded: inject, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { type: 'SCAN' });
  }
}

async function start(tabId) {
  cancelled = false;
  state = freshState();
  state.phase = 'scanning';
  state.progress = { done: 0, total: 0, label: 'Loading every post on the page…' };
  await save();
  startKeepAlive();

  const scan = await requestScan(tabId);
  if (!scan || scan.error) throw new Error(scan?.error || 'The Classroom page did not respond. Reload it and try again.');
  if (!scan.items.length) {
    throw new Error('No posts found. Open the class’s Classwork tab (not Stream), let it finish loading, and try again.');
  }
  if (cancelled) {
    state = freshState();
    stopKeepAlive();
    return save();
  }
  state.className = scan.className || '';
  await collect(scan.items);
}

async function collect(items) {
  state.phase = 'collecting';
  state.progress = { done: 0, total: items.length, label: 'Reading posts…' };
  log(`Scanning ${items.length} posts`);
  await save();

  // Scan in a minimised window so tabs don't flash over whatever the user is doing.
  let windowId;
  try {
    const win = await chrome.windows.create({ url: 'about:blank', state: 'minimized' });
    windowId = win.id;
  } catch (e) {
    log(`Could not create scan window (${e.message}); using background tabs`);
  }

  const ctx = { seen: new Set(), folders: [] };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (!cancelled) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const found = await scrapePost(item, windowId);
        let added = 0;
        for (const link of found) added += addLink(ctx, { topic: item.topic, post: item.title }, link) ? 1 : 0;
        log(`${item.title || item.url}: ${found.length} link(s), ${added} new`);
      } catch (e) {
        log(`Failed on "${item.title}": ${e.message}`);
      }
      done++;
      state.progress = { done, total: items.length, label: item.title || '' };
      await save();
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  if (windowId != null) chrome.windows.remove(windowId).catch(() => {});

  if (!cancelled && ctx.folders.length) await expandFolders(ctx);

  stopKeepAlive();
  if (cancelled) {
    state = freshState();
  } else {
    state.phase = 'review';
    log(`Done: ${state.files.length} file(s), ${state.skipped.length} skipped`);
  }
  await save();
}

async function scrapePost(item, windowId) {
  const tab = await chrome.tabs.create({
    url: item.url,
    active: false,
    ...(windowId != null ? { windowId } : {}),
  });
  try {
    await waitForComplete(tab.id, 25000);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAttachmentsInPage,
    });
    return res?.result || [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}

/**
 * Runs INSIDE the Classroom post page (injected via scripting.executeScript), so it must be
 * fully self-contained. Classroom renders attachments client-side, so poll until the links
 * appear and stop changing.
 */
async function scrapeAttachmentsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = () => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!/^https:\/\/(drive|docs|www)\.google\.com\//.test(href)) continue;
      if (a.closest('header, [role="banner"], [role="navigation"], nav')) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ href, text: (a.getAttribute('aria-label') || a.innerText || '').trim() });
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

/**
 * Record one attachment link. Files go to state.files; folders are queued for expansion.
 * @param meta {topic, post, sub?} where sub is the Drive-folder path the file was found in
 * @returns {boolean} true if something new was recorded
 */
function addLink(ctx, meta, link) {
  const href = unwrapGoogleRedirect(link.href);
  const c = classify(href);
  if (!c) return false;
  const label = (link.text || '').split('\n')[0].trim();

  if (c.kind === 'form') {
    state.skipped.push({ post: meta.post, title: label || 'Google Form', reason: 'Google Form', href });
    return false;
  }
  const key = `${c.kind}:${c.id}`;
  if (ctx.seen.has(key)) return false; // same file in several posts/folders: download once
  ctx.seen.add(key);

  if (c.kind === 'folder') {
    ctx.folders.push({ ...c, ...meta, name: label, sub: [...(meta.sub || []), ...(label ? [label] : [])] });
    return true;
  }
  state.files.push({
    key,
    kind: c.kind,
    id: c.id,
    authuser: c.authuser,
    hint: label,
    label: label || `${c.kind} ${c.id.slice(0, 8)}`,
    post: meta.post || '',
    topic: meta.topic || '',
    sub: meta.sub || [],
  });
  return true;
}

/** Drive folders are listed from the plain-HTML embedded view, so no Drive API/OAuth is needed. */
async function expandFolders(ctx) {
  const queue = ctx.folders.map((f) => ({ ...f, depth: 1 }));
  let found = 0;
  state.phase = 'collecting';
  while (queue.length && !cancelled && found < MAX_FOLDER_FILES) {
    const folder = queue.shift();
    state.progress = { done: state.progress.total, total: state.progress.total, label: `Opening folder: ${folder.name || folder.id}` };
    await save();
    try {
      const qs = new URLSearchParams({ id: folder.id });
      if (folder.authuser) qs.set('authuser', folder.authuser);
      const r = await fetch(`https://drive.google.com/embeddedfolderview?${qs}`, { credentials: 'include' });
      const entries = parseFolderHtml(await r.text());
      log(`Folder "${folder.name || folder.id}": ${entries.length} item(s)`);
      for (const e of entries) {
        const c = classify(e.href);
        if (c?.kind === 'folder') {
          if (folder.depth < MAX_FOLDER_DEPTH && !ctx.seen.has(`folder:${c.id}`)) {
            ctx.seen.add(`folder:${c.id}`);
            queue.push({ ...folder, ...c, name: e.name, sub: [...folder.sub, e.name].filter(Boolean), depth: folder.depth + 1 });
          }
        } else if (addLink(ctx, { topic: folder.topic, post: folder.post, sub: folder.sub }, { href: e.href, text: e.name })) {
          found++;
        }
      }
    } catch (e) {
      log(`Could not open folder "${folder.name || folder.id}": ${e.message}`);
      state.skipped.push({ post: folder.post, title: folder.name || 'Drive folder', reason: 'Could not open folder', href: '' });
    }
  }
}

// ---------------------------------------------------------------- downloading

async function download({ keys, className, byTopic = true, docFormat = 'pdf' }) {
  cancelled = false;
  const chosen = state.files.filter((f) => keys.includes(f.key));
  const classFolder = sanitize(className, 60) || sanitize(state.className, 60) || 'Class';
  state.className = classFolder;
  state.phase = 'downloading';
  state.dl = { total: chosen.length, done: 0, failed: 0, failures: [], lastId: null, folder: `${ROOT_FOLDER}/${classFolder}` };
  log(`Downloading ${chosen.length} file(s)`);
  await save();
  startKeepAlive();

  let next = 0;
  const worker = async () => {
    while (!cancelled) {
      const i = next++;
      if (i >= chosen.length) return;
      const file = chosen[i];
      try {
        const url = downloadUrlFor(file, docFormat);
        const probe = await probeUrl(url);
        if (probe.blocked) throw new Error(probe.blocked);
        const name = buildFileName({ cd: probe.cd, ct: probe.ct, hint: file.hint, kind: file.kind, id: file.id, docFormat });
        const segments = [
          ROOT_FOLDER,
          classFolder,
          byTopic ? sanitize(file.topic, 60) : '',
          ...(file.sub || []).map((s) => sanitize(s, 60)),
          name,
        ].filter(Boolean);
        const id = await chrome.downloads.download({
          url,
          filename: segments.join('/'),
          conflictAction: 'uniquify',
          saveAs: false,
        });
        const outcome = await waitForDownload(id);
        if (outcome !== 'complete') throw new Error('Download was interrupted');
        state.dl.lastId = id;
        state.dl.done++;
      } catch (e) {
        state.dl.failed++;
        state.dl.failures.push({ name: file.label, post: file.post, reason: String(e.message || e) });
        log(`Failed "${file.label}": ${e.message || e}`);
      }
      await save();
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));

  stopKeepAlive();
  state.phase = 'done';
  log(`Finished: ${state.dl.done} saved, ${state.dl.failed} failed`);
  await save();
}

/**
 * Peek at the response headers before committing to a download. Drive answers "no access" and
 * "downloading disabled" with a 200 HTML page, which would otherwise be saved as a junk .html file.
 */
async function probeUrl(url) {
  const ac = new AbortController();
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow', signal: ac.signal });
    const ct = r.headers.get('content-type') || '';
    const cd = r.headers.get('content-disposition') || '';
    ac.abort(); // headers are enough; don't pull the body twice
    if (r.status === 404) return { blocked: 'File not found (deleted or no access)' };
    if (r.status >= 400) return { blocked: `Not accessible (HTTP ${r.status})` };
    if (/text\/html/i.test(ct)) return { blocked: 'Download disabled by the owner, or no access with this account' };
    return { ct, cd };
  } catch {
    // Network hiccup (or our own abort) during the probe: let the real download try anyway.
    return { ct: '', cd: '' };
  }
}

function waitForDownload(id) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([it]) => {
      if (it && it.state !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(it.state);
      }
    });
  });
}
