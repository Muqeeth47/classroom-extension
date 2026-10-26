// Background worker (service worker in Chromium browsers, event page in Firefox).
// Flow: read the post (or scan the class) -> collect Drive/Docs attachments -> expand Drive
// folders -> let the user pick -> download each file in its original format.
// All progress lives in `state`, mirrored to storage.session, so the popup can close and reopen.

import {
  ANNOUNCEMENTS_TOPIC,
  badgeFor,
  isClassroomUrl,
  pageKind,
  sourceKey,
  buildDownloadPath,
  buildFileName,
  classify,
  describeHttpFailure,
  downloadUrlFor,
  parseFolderHtml,
  sanitize,
  unwrapGoogleRedirect,
} from './lib';
import { freshState } from './state';
import { scrapeAttachmentsInPage } from './scrape';
import type { AppState, DocFormat, FileEntry, Message, PageKind, PageLink, ScanItem, ScanResult } from './types';

const ROOT_FOLDER = 'Classroom';
const SCAN_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_FILES = 400;

const BUSY: readonly string[] = ['scanning', 'collecting', 'downloading'];

let state: AppState = freshState();
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Every START, DOWNLOAD and RESET bumps `run`. A background loop remembers the run it belongs to
 * and stops as soon as it is no longer current, so a "Start over" can never be overwritten by the
 * run it interrupted. CANCEL marks the current run as cancelled without invalidating its results.
 */
let run = 0;
let cancelledRun = -1;
const isStale = (my: number): boolean => my !== run;
const isStopped = (my: number): boolean => my !== run || cancelledRun === my;

const ready = (async () => {
  try {
    const saved = (await chrome.storage.session.get('state')).state as AppState | undefined;
    if (saved) {
      state = saved;
      // A worker killed mid-run can't resume; say so instead of showing a spinner forever.
      if (BUSY.includes(state.phase)) {
        state.phase = 'error';
        state.error = 'The browser stopped the extension mid-run. Please start again.';
      }
    }
  } catch {
    /* storage.session unavailable: start fresh */
  }
  void updateBadge();
})();

async function save(): Promise<void> {
  try {
    await chrome.storage.session.set({ state });
  } catch {
    /* non-fatal */
  }
  void updateBadge();
}

/** Shows progress on the toolbar icon, so the user can close the popup and still see what Ilm is doing. */
async function updateBadge(): Promise<void> {
  try {
    const { text, color } = badgeFor(state);
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* a missing badge must never stop a download */
  }
}

function log(msg: string): void {
  state.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (state.log.length > 80) state.log.shift();
}

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20000);
}
function stopKeepAlive(): void {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** " [a.pdf, b.pptx, ...]": the first few link names, for the Activity log. */
function sample(links: PageLink[]): string {
  const names = links.slice(0, 4).map((l) => (l.text.split('\n')[0] || l.href).slice(0, 40));
  return names.length ? ` [${names.join(', ')}${links.length > names.length ? ', ...' : ''}]` : '';
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  void (async () => {
    await ready;
    const busy = BUSY.includes(state.phase);
    switch (msg?.type) {
      case 'GET_STATE':
        sendResponse(state);
        break;
      case 'START':
        if (!busy) void start(msg.tabId, msg.mode);
        sendResponse({ ok: true });
        break;
      case 'DOWNLOAD':
        if (state.phase === 'review') void download(msg);
        sendResponse({ ok: true });
        break;
      case 'CANCEL':
        cancelledRun = run;
        sendResponse({ ok: true });
        break;
      case 'RESET':
        run++;
        stopKeepAlive();
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

async function fail(err: unknown, my: number): Promise<void> {
  if (isStale(my)) return;
  stopKeepAlive();
  state.phase = 'error';
  state.error = errorMessage(err);
  log(`ERROR ${state.error}`);
  await save();
}

// ---------------------------------------------------------------- scanning + collecting

const NO_PAGE = 'Could not read the Classroom page. Reload it, then try again.';
const NOT_CLASSROOM = 'This is not a Google Classroom post or class. Open one in Google Classroom, then try again.';

async function requestScan(tabId: number, mode: PageKind): Promise<ScanResult> {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'SCAN', mode }) as Promise<ScanResult | undefined>;
  let res: ScanResult | undefined;
  try {
    res = await ask();
  } catch {
    // The tab was open before the extension was installed or reloaded: inject, then retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      res = await ask();
    } catch {
      throw new Error(NO_PAGE);
    }
  }
  if (!res) throw new Error(NO_PAGE);
  return res;
}

async function start(tabId: number, requested: PageKind): Promise<void> {
  const my = ++run;
  let mode: PageKind = requested;
  state = freshState();
  state.phase = 'scanning';
  state.progress = { done: 0, total: 0, label: requested === 'post' ? 'Reading this post…' : 'Reading this class…' };
  startKeepAlive();
  let windowId: number | undefined;
  try {
    const here = await chrome.tabs.get(tabId).catch(() => undefined);
    if (here?.url) {
      // The page may have changed since the popup was opened: trust what the tab shows now.
      const actual = pageKind(here.url);
      if (!actual) throw new Error(NOT_CLASSROOM);
      mode = actual;
    }
    const source = here?.url ? sourceKey(here.url) : null;
    if (source) state.source = source;
    await save();
    const scan = await requestScan(tabId, mode);
    if (isStopped(my)) return finishStopped(my);
    if (scan.error) throw new Error(scan.error);
    if (mode === 'post' && !scan.items.length) {
      throw new Error('Could not find this post. Open the post or announcement whose files you want, then try again.');
    }
    state.className = scan.className || '';
    const authuser = scan.authuser ?? '';

    if (mode === 'post') {
      // A single post: the user is already on the page, so read it in place instead of reopening it.
      await collect(my, { items: scan.items, inline: [], authuser, directTabId: tabId });
      return;
    }

    // A class: read its Stream AND its Classwork (whichever one the user is on, plus the other), each
    // post in a background tab of the window the user already has open.
    windowId = here?.windowId;
    const plan = await gatherClass(my, tabId, scan, windowId);
    if (isStopped(my)) return finishStopped(my);
    if (!plan.items.length && !plan.inline.length) {
      throw new Error('No announcements or posts found in this class. Let the page finish loading, then try again.');
    }
    await collect(my, { ...plan, authuser, windowId });
  } catch (e) {
    await fail(e, my);
  }
}

/** A cancelled (not reset) scan goes back to the start screen. */
async function finishStopped(my: number): Promise<void> {
  if (isStale(my)) return;
  stopKeepAlive();
  state = freshState();
  await save();
}

/** Attachments shown directly on a page (for example inside announcements on the Stream). */
interface InlineLink {
  link: PageLink;
  topic: string;
}

interface ScanPlan {
  items: ScanItem[];
  inline: InlineLink[];
}

const PAGE_NAME: Record<string, string> = { stream: 'the Stream', classwork: 'Classwork', other: 'this page' };

/**
 * Everything posted in one class: the posts that have their own page (assignments, materials, questions,
 * announcements) from BOTH the Stream and Classwork, plus attachments shown inline on the pages.
 */
async function gatherClass(my: number, tabId: number, scan: ScanResult, windowId: number | undefined): Promise<ScanPlan> {
  const byUrl = new Map<string, ScanItem>();
  const inline: InlineLink[] = [];
  const addItems = (items: ScanItem[]): void => {
    for (const it of items) {
      const prev = byUrl.get(it.url);
      if (!prev) byUrl.set(it.url, { ...it });
      else if (!prev.topic && it.topic) prev.topic = it.topic; // Classwork knows the topic; the Stream does not
    }
  };
  const addInline = (page: ScanResult['page'], links: PageLink[]): void => {
    const topic = page === 'stream' ? ANNOUNCEMENTS_TOPIC : '';
    for (const link of links) inline.push({ link, topic });
  };

  const here = scan.page ?? 'other';
  addItems(scan.items);
  const hereInline = await scrapeTab(tabId);
  addInline(here, hereInline);
  log(`${PAGE_NAME[here]}: ${scan.items.length} post(s), ${hereInline.length} attachment link(s) shown on the page`);

  // The class's other tab. One tab failing must never lose what the other already gave us.
  for (const url of scan.siblings ?? []) {
    if (isStopped(my)) break;
    if (!isClassroomUrl(url)) {
      log(`Ignored a page that is not on Classroom: ${url}`);
      continue;
    }
    state.progress = { done: 0, total: 0, label: 'Reading the rest of this class…' };
    await save();
    try {
      const sub = await scanSiblingPage(url, windowId);
      if (sub.scan.error) throw new Error(sub.scan.error);
      const there = sub.scan.page ?? 'other';
      addItems(sub.scan.items);
      addInline(there, sub.inline);
      log(`${PAGE_NAME[there]}: ${sub.scan.items.length} post(s), ${sub.inline.length} attachment link(s) shown on the page`);
    } catch (e) {
      log(`Could not read ${url}: ${errorMessage(e)}`);
    }
  }
  return { items: [...byUrl.values()], inline };
}

/**
 * A background tab in the window the user is in. If that window can't hold tabs (an app or popup window), let the
 * browser pick instead of failing; the tab still opens inactive so it never takes focus.
 */
async function openBackgroundTab(url: string, windowId: number | undefined): Promise<chrome.tabs.Tab> {
  if (windowId != null) {
    try {
      return await chrome.tabs.create({ url, active: false, windowId });
    } catch {
      /* fall through */
    }
  }
  return chrome.tabs.create({ url, active: false });
}

async function scanSiblingPage(url: string, windowId: number | undefined): Promise<{ scan: ScanResult; inline: PageLink[] }> {
  const tab = await openBackgroundTab(url, windowId);
  const id = tab.id;
  if (id == null) throw new Error('Could not open the page');
  try {
    await waitForComplete(id, 25000);
    const scan = await requestScan(id, 'class');
    return { scan, inline: await scrapeTab(id) };
  } finally {
    chrome.tabs.remove(id).catch(() => {});
  }
}

async function scrapeTab(tabId: number): Promise<PageLink[]> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeAttachmentsInPage });
    return res?.result ?? [];
  } catch {
    return [];
  }
}

interface CollectContext {
  seen: Set<string>;
  folders: FolderJob[];
  /** Account number Classroom is open under; used when a link does not name one. */
  authuser: string;
}

interface FolderJob {
  id: string;
  authuser: string;
  resourcekey?: string;
  topic: string;
  post: string;
  name: string;
  sub: string[];
  depth: number;
}

interface LinkMeta {
  topic: string;
  post: string;
  sub?: string[];
}

interface CollectInput extends ScanPlan {
  authuser: string;
  windowId?: number;
  directTabId?: number;
}

async function collect(my: number, { items, inline, authuser, windowId, directTabId }: CollectInput): Promise<void> {
  state.phase = 'collecting';
  state.progress = { done: 0, total: items.length, label: 'Reading posts…' };
  log(`Reading ${items.length} post(s)`);
  await save();

  const ctx: CollectContext = { seen: new Set(), folders: [], authuser };
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (!isStopped(my)) {
      const item = items[next++];
      if (!item) return;
      try {
        const found = await scrapePost(item, windowId, directTabId);
        if (isStopped(my)) return;
        let added = 0;
        for (const link of found) added += addLink(ctx, { topic: item.topic, post: item.title }, link) ? 1 : 0;
        log(`${item.title || item.url}: ${found.length} link(s), ${added} new${sample(found)}`);
      } catch (e) {
        if (isStopped(my)) return;
        log(`Failed on "${item.title}": ${errorMessage(e)}`);
      }
      done++;
      state.progress = { done, total: items.length, label: item.title || '' };
      await save();
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));

  // Attachments shown directly on pages come AFTER the posts, so a file that is also attached to a post
  // keeps that post's topic instead of landing under "Announcements".
  if (!isStopped(my)) {
    let added = 0;
    let folders = 0;
    for (const { link, topic } of inline) {
      // The class's own Drive folder (where submissions live) is not something a teacher attached.
      if (/class drive folder/i.test(link.text)) continue;
      // A folder is only opened when it is attached to a post that was read. On a page it could just as
      // well be a class folder, which holds students' work and must never be pulled in.
      if (classify(unwrapGoogleRedirect(link.href))?.kind === 'folder') {
        folders++;
        continue;
      }
      added += addLink(ctx, { topic, post: topic ? 'Announcement' : '' }, link) ? 1 : 0;
    }
    if (inline.length) log(`Attachments shown on pages: ${inline.length} link(s), ${added} new`);
    if (folders) log(`Ignored ${folders} Drive folder link(s) shown directly on pages; folders are opened only when attached to a post`);
  }

  if (!isStopped(my) && ctx.folders.length) await expandFolders(my, ctx);

  if (isStale(my)) return;
  stopKeepAlive();
  if (cancelledRun === my) {
    state = freshState();
  } else {
    state.phase = 'review';
    log(`Done: ${state.files.length} file(s), ${state.skipped.length} skipped`);
  }
  await save();
}

async function scrapePost(item: ScanItem, windowId: number | undefined, directTabId?: number): Promise<PageLink[]> {
  if (directTabId != null) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: directTabId }, func: scrapeAttachmentsInPage });
    return res?.result ?? [];
  }
  if (!isClassroomUrl(item.url)) throw new Error('Not a Classroom page');
  const tab = await openBackgroundTab(item.url, windowId);
  const tabId = tab.id;
  if (tabId == null) return [];
  try {
    await waitForComplete(tabId, 25000);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeAttachmentsInPage,
    });
    return res?.result ?? [];
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = (id: number, info: { status?: string }): void => {
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
 * Record one attachment link. Files go to state.files; folders are queued for expansion.
 * @returns true if something new was recorded
 */
function addLink(ctx: CollectContext, meta: LinkMeta, link: PageLink): boolean {
  const href = unwrapGoogleRedirect(link.href);
  const c = classify(href);
  if (!c) return false;
  const label = (link.text || '').split('\n')[0]!.trim();
  const authuser = c.authuser || ctx.authuser;

  if (c.kind === 'form') {
    if (ctx.seen.has(`form:${href}`)) return false;
    ctx.seen.add(`form:${href}`);
    state.skipped.push({ post: meta.post, title: label || 'Google Form', reason: 'Google Form', href });
    return false;
  }
  const key = `${c.kind}:${c.id}`;
  if (ctx.seen.has(key)) return false; // same file in several posts/folders: download once
  ctx.seen.add(key);

  if (c.kind === 'folder') {
    ctx.folders.push({
      id: c.id,
      authuser,
      ...(c.resourcekey ? { resourcekey: c.resourcekey } : {}),
      topic: meta.topic,
      post: meta.post,
      name: label,
      sub: [...(meta.sub ?? []), ...(label ? [label] : [])],
      depth: 1,
    });
    return true;
  }
  state.files.push({
    key,
    kind: c.kind,
    id: c.id,
    authuser,
    ...(c.resourcekey ? { resourcekey: c.resourcekey } : {}),
    hint: label,
    label: label || `${c.kind} ${c.id.slice(0, 8)}`,
    post: meta.post || '',
    topic: meta.topic || '',
    sub: meta.sub ?? [],
  });
  return true;
}

/** Drive folders are listed from the plain-HTML embedded view, so no Drive API/OAuth is needed. */
async function expandFolders(my: number, ctx: CollectContext): Promise<void> {
  const queue: FolderJob[] = [...ctx.folders];
  let found = 0;
  const skip = (folder: FolderJob, reason: string): void => {
    state.skipped.push({ post: folder.post, title: folder.name || 'Drive folder', reason, href: '' });
  };

  while (queue.length && !isStopped(my) && found < MAX_FOLDER_FILES) {
    const folder = queue.shift()!;
    state.progress = {
      done: state.progress.total,
      total: state.progress.total,
      label: `Opening folder: ${folder.name || folder.id}`,
    };
    await save();
    try {
      const qs = new URLSearchParams({ id: folder.id });
      if (folder.authuser) qs.set('authuser', folder.authuser);
      if (folder.resourcekey) qs.set('resourcekey', folder.resourcekey);
      const r = await fetch(`https://drive.google.com/embeddedfolderview?${qs}`, { credentials: 'include' });
      const entries = parseFolderHtml(await r.text());
      if (isStopped(my)) return;
      log(`Folder "${folder.name || folder.id}": ${entries.length} item(s)`);
      // An empty list means the folder really is empty, or Google showed a sign-in / no-access page.
      if (!entries.length) skip(folder, 'Folder is empty or you do not have access');
      for (const e of entries) {
        const c = classify(e.href);
        if (c?.kind === 'folder') {
          if (folder.depth < MAX_FOLDER_DEPTH && !ctx.seen.has(`folder:${c.id}`)) {
            ctx.seen.add(`folder:${c.id}`);
            queue.push({
              ...folder,
              id: c.id,
              authuser: c.authuser || folder.authuser,
              ...(c.resourcekey ? { resourcekey: c.resourcekey } : {}),
              name: e.name,
              sub: [...folder.sub, e.name].filter(Boolean),
              depth: folder.depth + 1,
            });
          } else if (folder.depth >= MAX_FOLDER_DEPTH) {
            skip({ ...folder, name: e.name }, 'Folder is nested too deeply; open it manually');
          }
        } else if (addLink(ctx, { topic: folder.topic, post: folder.post, sub: folder.sub }, { href: e.href, text: e.name })) {
          found++;
        }
      }
    } catch (e) {
      if (isStopped(my)) return;
      log(`Could not open folder "${folder.name || folder.id}": ${errorMessage(e)}`);
      skip(folder, 'Could not open folder');
    }
  }
  if (queue.length && found >= MAX_FOLDER_FILES) {
    log(`Stopped after ${MAX_FOLDER_FILES} files from folders`);
    state.skipped.push({ post: '', title: 'Some Drive folders', reason: `Too many files; only the first ${MAX_FOLDER_FILES} were listed`, href: '' });
  }
}

// ---------------------------------------------------------------- downloading

type DownloadMessage = Extract<Message, { type: 'DOWNLOAD' }>;

async function download({ keys, className, byTopic = true, docFormat = 'pdf' }: DownloadMessage): Promise<void> {
  const my = ++run;
  try {
    const chosen = state.files.filter((f) => keys.includes(f.key));
    const classFolder = sanitize(className, 60) || sanitize(state.className, 60) || 'Class';
    state.className = classFolder;
    state.phase = 'downloading';
    state.dl = { total: chosen.length, done: 0, failed: 0, failures: [], lastId: null, folder: `${ROOT_FOLDER}/${classFolder}` };
    log(`Downloading ${chosen.length} file(s)`);
    startKeepAlive();
    await save();

    let next = 0;
    const worker = async (): Promise<void> => {
      while (!isStopped(my)) {
        const file = chosen[next++];
        if (!file) return;
        try {
          const id = await downloadOne(file, classFolder, byTopic, docFormat);
          if (isStale(my)) return;
          state.dl.lastId = id;
          state.dl.done++;
        } catch (e) {
          if (isStale(my)) return;
          state.dl.failed++;
          state.dl.failures.push({ name: file.label, post: file.post, reason: errorMessage(e) });
          log(`Failed "${file.label}": ${errorMessage(e)}`);
        }
        await save();
      }
    };
    // Stop must end the run even if one download is stuck (e.g. the browser is asking the user to
    // confirm a risky file type), so race the workers against the stop signal.
    const finished = Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    let watch: ReturnType<typeof setInterval> | undefined;
    const stopped = new Promise<void>((resolve) => {
      watch = setInterval(() => isStopped(my) && resolve(), 300);
    });
    try {
      await Promise.race([finished, stopped]);
    } finally {
      clearInterval(watch);
    }

    if (isStale(my)) return;
    stopKeepAlive();
    state.phase = 'done';
    log(`Finished: ${state.dl.done} saved, ${state.dl.failed} failed`);
    await save();
  } catch (e) {
    await fail(e, my);
  }
}

/** Downloads one file and resolves with the browser's download id. Throws a readable reason on failure. */
async function downloadOne(file: FileEntry, classFolder: string, byTopic: boolean, docFormat: DocFormat): Promise<number> {
  const url = downloadUrlFor(file, docFormat);
  if (!url) throw new Error('Unsupported file type');
  const probe = await probeUrl(url);
  if (probe.blocked) throw new Error(probe.blocked);

  const name = buildFileName({ cd: probe.cd, ct: probe.ct, hint: file.hint, kind: file.kind, id: file.id, docFormat });
  const folders = [classFolder, byTopic ? file.topic : '', ...file.sub];

  let id: number;
  try {
    id = await chrome.downloads.download({
      url,
      filename: buildDownloadPath(ROOT_FOLDER, folders, name),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (e) {
    // The browser rejected the path (odd characters, length). Fall back to a plain safe name.
    const ext = name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? '';
    id = await chrome.downloads.download({
      url,
      filename: buildDownloadPath(ROOT_FOLDER, [classFolder], `file-${file.id.slice(0, 8)}${ext}`),
      conflictAction: 'uniquify',
      saveAs: false,
    }).catch(() => {
      throw new Error(`The browser could not save this file (${errorMessage(e)})`);
    });
  }
  const outcome = await waitForDownload(id);
  if (outcome !== 'complete') throw new Error('The download was cancelled or interrupted');
  return id;
}

type Probe = { blocked: string; ct?: undefined; cd?: undefined } | { blocked?: undefined; ct: string; cd: string };

/**
 * Peek at the response headers before committing to a download. Drive answers "no access" and
 * "downloading disabled" with a 200 HTML page, which would otherwise be saved as a junk .html file.
 * A real HTML upload is sent with a Content-Disposition: attachment header, so it passes.
 */
async function probeUrl(url: string): Promise<Probe> {
  const ac = new AbortController();
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'include', redirect: 'follow', signal: ac.signal });
  } catch {
    // Fail closed: if we can't even read the headers, saving the result blindly could store a sign-in page.
    return { blocked: 'Could not reach Google. Check your connection, and that ilm. has permission to access Google sites.' };
  }
  const ct = r.headers.get('content-type') || '';
  const cd = r.headers.get('content-disposition') || '';
  let finalHost = '';
  try {
    finalHost = new URL(r.url).hostname;
  } catch {
    /* some environments don't expose the final URL */
  }
  ac.abort(); // headers are enough; don't pull the body twice

  if (finalHost === 'accounts.google.com') return { blocked: 'You are signed out of Google. Sign in, then try again.' };
  if (r.status >= 400) return { blocked: describeHttpFailure(r.status) };
  if (/text\/html/i.test(ct) && !/attachment/i.test(cd)) {
    return { blocked: 'Download disabled by the owner, or no access with this Google account.' };
  }
  return { ct, cd };
}

function waitForDownload(id: number): Promise<string> {
  return new Promise((resolve) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      const current = delta.state?.current;
      if (delta.id === id && current && current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(current);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already be finished before the listener was attached.
    chrome.downloads
      .search({ id })
      .then(([it]) => {
        if (it && it.state !== 'in_progress') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve(it.state);
        }
      })
      .catch(() => {});
  });
}
