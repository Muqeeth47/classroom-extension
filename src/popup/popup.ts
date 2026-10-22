// Popup UI. The background worker owns the real state; this renders it and sends commands.
// Everything from Classroom (file names, topics) is untrusted, so it only ever goes in via textContent.

import { EXPORT_KINDS, pageKind } from '../lib';
import { freshState } from '../state';
import type { AppState, DocFormat, FileEntry, Message, PageKind, Prefs } from '../types';

// Single source of truth: whatever the manifest asks for is what the Firefox "Allow access" button requests.
const HOST_ORIGINS = chrome.runtime.getManifest().host_permissions ?? [];

const app = document.getElementById('app')!;

let state: AppState | null = null; // mirror of the background state
let tab: chrome.tabs.Tab | null = null; // the active tab, if it is a Classroom class or post
let kind: PageKind | null = null; // what that tab is showing
let hasAccess = true; // Firefox asks for site access separately; Chromium grants it at install
let className: string | null = null; // folder name being edited in the review step
const unticked = new Set<string>(); // file keys the user turned off
const prefs: Prefs = { byTopic: true, docFormat: 'pdf' };

// ---------------------------------------------------------------- helpers

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

function h(tag: string, props: Props = {}, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// Never throws: if the extension was reloaded or its worker is unavailable we show an error screen instead of a blank popup.
const send = async <T = unknown>(msg: Message): Promise<T | undefined> => {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return undefined;
  }
};

function unavailableState(): AppState {
  return {
    ...freshState(),
    phase: 'error',
    error: 'Could not reach the extension. Reload it from your browser’s extensions page, then open this popup again.',
  };
}
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

async function loadPrefs(): Promise<void> {
  try {
    const saved = (await chrome.storage.local.get('prefs')).prefs as Partial<Prefs> | undefined;
    if (saved) Object.assign(prefs, saved);
  } catch {
    /* defaults are fine */
  }
}
function savePrefs(): void {
  chrome.storage.local.set({ prefs }).catch(() => {});
}

async function detectContext(): Promise<void> {
  try {
    hasAccess = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  } catch {
    hasAccess = true;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  kind = active?.url ? pageKind(active.url) : null;
  tab = kind ? (active ?? null) : null;
}

function progressBar(done: number, total: number): HTMLElement {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
    h('div', { style: `width:${pct}%` }));
}

function logBox(s: AppState): HTMLElement | null {
  if (!s.log.length) return null;
  return h('details', {}, h('summary', { text: 'Activity log' }), h('pre', { text: s.log.join('\n') }));
}

async function reset(): Promise<void> {
  await send({ type: 'RESET' });
  className = null;
  unticked.clear();
  await refresh();
}

// ---------------------------------------------------------------- views

function viewIdle(): HTMLElement[] {
  if (!hasAccess) {
    return [
      h('p', { text: 'This extension needs permission to read Google Classroom and Drive so it can find and download your files.' }),
      h('button', {
        class: 'primary block',
        text: 'Allow access',
        onclick: async () => {
          try {
            hasAccess = await chrome.permissions.request({ origins: HOST_ORIGINS });
          } catch {
            hasAccess = false;
          }
          await detectContext();
          render();
        },
      }),
    ];
  }
  if (!tab || !kind) {
    return [
      h('div', { class: 'card stack' },
        h('p', { text: 'Open the announcement or post whose files you want to download.' }),
        h('p', { class: 'muted small', text: 'Then click this button again. To get a whole class, open its Classwork tab instead.' }),
      ),
      h('button', { class: 'primary block', text: 'Find files', disabled: true }),
    ];
  }
  const tabId = tab.id;
  const mode: PageKind = kind;
  const isPost = mode === 'post';
  return [
    h('p', { class: 'muted', text: isPost ? 'Gets the files attached to this post, in their original format.' : 'Gets every file in this class, in their original format. Nothing is zipped.' }),
    h('button', {
      class: 'primary block',
      text: isPost ? 'Get files from this post' : 'Get files from this class',
      onclick: async () => {
        if (tabId == null) return;
        className = null;
        unticked.clear();
        await send({ type: 'START', tabId, mode });
        await refresh();
      },
    }),
  ];
}

function viewBusy(s: AppState): HTMLElement[] {
  const { done, total, label } = s.progress;
  const scanning = s.phase === 'scanning';
  return [
    h('p', { text: scanning ? 'Reading the page…' : total > 1 ? `Reading posts… ${done} of ${total}` : 'Finding files…' }),
    progressBar(scanning ? 0 : done, total),
    h('p', { class: 'muted small', text: label }),
    h('button', { class: 'block', text: 'Cancel', onclick: () => void send({ type: 'CANCEL' }) }),
  ];
}

function fileRow(f: FileEntry): HTMLElement {
  const where = [f.post, ...f.sub].filter(Boolean).join(' › ');
  return h('label', { class: 'file' },
    h('input', {
      type: 'checkbox',
      checked: !unticked.has(f.key),
      onchange: (e) => {
        if ((e.target as HTMLInputElement).checked) unticked.delete(f.key);
        else unticked.add(f.key);
        render();
      },
    }),
    h('div', {},
      h('div', { class: 'name' }, f.label, EXPORT_KINDS.has(f.kind) ? h('span', { class: 'tag', text: 'Google' }) : null),
      h('div', { class: 'sub', text: where }),
    ),
  );
}

function viewReview(s: AppState): (HTMLElement | null)[] {
  const files = s.files;
  if (className === null) className = s.className || 'My class';
  const selected = files.filter((f) => !unticked.has(f.key));

  if (!files.length) {
    return [
      h('div', { class: 'card stack' },
        h('p', { class: 'warn', text: 'No downloadable files were found here.' }),
        h('p', { class: 'muted small', text: 'Open the announcement or post that has the attachments, let it finish loading, then try again.' }),
      ),
      h('button', { class: 'block', text: 'Start over', onclick: reset }),
      logBox(s),
    ];
  }

  const list = h('div', { class: 'list' });
  const groups = new Map<string, FileEntry[]>();
  for (const f of files) {
    const g = f.topic || 'No topic';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  for (const [topic, fs] of groups) {
    list.append(h('div', { class: 'group', text: topic }), ...fs.map(fileRow));
  }

  const out: (HTMLElement | null)[] = [
    h('label', { class: 'field' },
      h('span', { class: 'muted small', text: 'Save into Downloads/Classroom/…' }),
      h('input', { type: 'text', value: className, 'aria-label': 'Folder name', oninput: (e) => { className = (e.target as HTMLInputElement).value; } }),
    ),
    h('div', { class: 'row between' },
      h('span', { class: 'muted', text: `${plural(files.length, 'file')} found` }),
      h('span', { class: 'row' },
        h('button', { class: 'link', text: 'All', onclick: () => { unticked.clear(); render(); } }),
        h('button', { class: 'link', text: 'None', onclick: () => { files.forEach((f) => unticked.add(f.key)); render(); } }),
      ),
    ),
    list,
    // Topics only exist when a whole class was scanned; a single post has none.
    files.some((f) => f.topic)
      ? h('label', { class: 'row' },
          h('input', { type: 'checkbox', checked: prefs.byTopic, onchange: (e) => { prefs.byTopic = (e.target as HTMLInputElement).checked; savePrefs(); } }),
          h('span', { text: 'Sort into topic folders' }),
        )
      : null,
  ];

  if (files.some((f) => EXPORT_KINDS.has(f.kind))) {
    const sel = h('select', {
      'aria-label': 'Google Docs, Slides and Sheets format',
      onchange: (e) => { prefs.docFormat = (e.target as HTMLSelectElement).value as DocFormat; savePrefs(); },
    },
      h('option', { value: 'pdf', text: 'PDF' }),
      h('option', { value: 'office', text: 'Word / PowerPoint / Excel' }),
    ) as HTMLSelectElement;
    sel.value = prefs.docFormat;
    out.push(h('label', { class: 'field' },
      h('span', { class: 'muted small', text: 'Save Google Docs, Slides and Sheets as' }),
      sel,
    ));
  }

  out.push(
    h('button', {
      class: 'primary block',
      disabled: selected.length === 0,
      text: selected.length ? `Download ${plural(selected.length, 'file')}` : 'Nothing selected',
      onclick: async () => {
        await send({
          type: 'DOWNLOAD',
          keys: selected.map((f) => f.key),
          className: (className ?? '').trim(),
          byTopic: prefs.byTopic,
          docFormat: prefs.docFormat,
        });
        await refresh();
      },
    }),
    h('button', { class: 'link', text: 'Start over', onclick: reset }),
  );

  if (s.skipped.length) {
    out.push(h('details', {},
      h('summary', { text: `${plural(s.skipped.length, 'link')} skipped` }),
      h('ul', {}, s.skipped.map((k) => h('li', { text: `${k.title} — ${k.reason}` }))),
    ));
  }
  out.push(logBox(s));
  return out;
}

function viewDownloading(s: AppState): HTMLElement[] {
  const { done, failed, total } = s.dl;
  return [
    h('p', { text: `Downloading… ${done + failed} of ${total}` }),
    progressBar(done + failed, total),
    failed ? h('p', { class: 'warn small', text: `${plural(failed, 'file')} could not be downloaded` }) : null,
    h('button', { class: 'block', text: 'Stop', onclick: () => void send({ type: 'CANCEL' }) }),
  ].filter((x): x is HTMLElement => x !== null);
}

function viewDone(s: AppState): (HTMLElement | null)[] {
  const { done, failed, failures, folder } = s.dl;
  return [
    h('div', { class: 'card stack' },
      h('p', { class: failed && !done ? 'bad' : 'good', text: `Saved ${plural(done, 'file')}` }),
      h('p', { class: 'muted small', text: `Downloads/${folder}` }),
      failed ? h('p', { class: 'warn small', text: `${plural(failed, 'file')} could not be downloaded.` }) : null,
    ),
    failures.length
      ? h('details', { open: true }, h('summary', { text: 'What went wrong' }),
          h('ul', {}, failures.map((f) => h('li', { text: `${f.name} — ${f.reason}` }))))
      : null,
    done ? h('button', { class: 'primary block', text: 'Show in folder', onclick: () => void send({ type: 'SHOW_IN_FOLDER' }) }) : null,
    h('button', { class: 'block', text: 'Done', onclick: reset }),
    logBox(s),
  ];
}

function viewError(s: AppState): (HTMLElement | null)[] {
  return [
    h('div', { class: 'card' }, h('p', { class: 'bad', text: s.error || 'Something went wrong.' })),
    h('button', { class: 'primary block', text: 'Try again', onclick: reset }),
    logBox(s),
  ];
}

function render(): void {
  if (!state) return;
  const s = state;
  const views: Record<AppState['phase'], () => (HTMLElement | null)[]> = {
    idle: viewIdle,
    scanning: () => viewBusy(s),
    collecting: () => viewBusy(s),
    review: () => viewReview(s),
    downloading: () => viewDownloading(s),
    done: () => viewDone(s),
    error: () => viewError(s),
  };
  const keep = app.querySelector('.list')?.scrollTop ?? 0;
  app.replaceChildren(...views[s.phase]().filter((x): x is HTMLElement => x !== null));
  const list = app.querySelector('.list');
  if (list) list.scrollTop = keep;
}

async function refresh(): Promise<void> {
  state = (await send<AppState>({ type: 'GET_STATE' })) ?? unavailableState();
  if (state.phase === 'idle') await detectContext();
  render();
}

// Live updates while the worker runs (the popup may even be opened mid-run).
chrome.storage.onChanged.addListener((changes, area) => {
  const next = changes.state?.newValue as AppState | undefined;
  if (area === 'session' && next) {
    state = next;
    render();
  }
});

void loadPrefs().then(refresh);
