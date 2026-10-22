// Popup UI. The background worker owns the real state; this renders it and sends commands.
// Everything from Classroom (file names, topics) is untrusted, so it only ever goes in via textContent.

import { EXPORT_KINDS } from './lib.js';

const HOST_ORIGINS = ['https://classroom.google.com/*', 'https://*.google.com/*', 'https://*.googleusercontent.com/*'];

const app = document.getElementById('app');

let state = null; // mirror of the background state
let tab = null; // the active tab, if it is Classroom
let hasAccess = true; // Firefox asks for site access separately; Chromium grants it at install
let className = null; // folder name being edited in the review step
const unticked = new Set(); // file keys the user turned off
const prefs = { byTopic: true, docFormat: 'pdf' };

// ---------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const send = (msg) => chrome.runtime.sendMessage(msg);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function loadPrefs() {
  try {
    const saved = (await chrome.storage.local.get('prefs')).prefs;
    if (saved) Object.assign(prefs, saved);
  } catch {
    /* defaults are fine */
  }
}
function savePrefs() {
  chrome.storage.local.set({ prefs }).catch(() => {});
}

async function detectContext() {
  try {
    hasAccess = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  } catch {
    hasAccess = true;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active?.url?.startsWith('https://classroom.google.com/') ? active : null;
}

function progressBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
    h('div', { style: `width:${pct}%` }));
}

function logBox() {
  if (!state?.log?.length) return null;
  return h('details', {}, h('summary', { text: 'Activity log' }), h('pre', { text: state.log.join('\n') }));
}

async function reset() {
  await send({ type: 'RESET' });
  className = null;
  unticked.clear();
  await refresh();
}

// ---------------------------------------------------------------- views

function viewIdle() {
  if (!hasAccess) {
    return [
      h('p', { text: 'This extension needs permission to read Google Classroom and Drive so it can find and download your files.' }),
      h('button', {
        class: 'primary block',
        text: 'Allow access',
        onclick: async () => {
          hasAccess = await chrome.permissions.request({ origins: HOST_ORIGINS });
          await detectContext();
          render();
        },
      }),
    ];
  }
  if (!tab) {
    return [
      h('div', { class: 'card stack' },
        h('p', { text: 'Open a class in Google Classroom, then go to its Classwork tab.' }),
        h('p', { class: 'muted small', text: 'Then click this button again.' }),
      ),
      h('button', { class: 'primary block', text: 'Find files in this class', disabled: true }),
    ];
  }
  return [
    h('p', { class: 'muted', text: 'Finds every file attached in this class and saves them in their original format. Nothing is zipped.' }),
    h('button', {
      class: 'primary block',
      text: 'Find files in this class',
      onclick: async () => {
        await send({ type: 'START', tabId: tab.id });
        await refresh();
      },
    }),
  ];
}

function viewBusy() {
  const { done, total, label } = state.progress;
  const scanning = state.phase === 'scanning';
  return [
    h('p', { text: scanning ? 'Loading the class…' : `Reading posts… ${done} of ${total}` }),
    progressBar(scanning ? 0 : done, total),
    h('p', { class: 'muted small', text: label }),
    h('button', { class: 'block', text: 'Cancel', onclick: () => send({ type: 'CANCEL' }) }),
  ];
}

function viewReview() {
  const files = state.files;
  if (className === null) className = state.className || 'My class';
  const selected = files.filter((f) => !unticked.has(f.key));

  const out = [];
  if (!files.length) {
    out.push(h('div', { class: 'card stack' },
      h('p', { class: 'warn', text: 'No downloadable files were found in this class.' }),
      h('p', { class: 'muted small', text: 'If you expected some, open the activity log below.' }),
    ));
    out.push(h('button', { class: 'block', text: 'Start over', onclick: reset }));
    out.push(logBox());
    return out;
  }

  out.push(h('label', { class: 'field' },
    h('span', { class: 'muted small', text: 'Save into Downloads/Classroom/…' }),
    h('input', { type: 'text', value: className, 'aria-label': 'Folder name', oninput: (e) => { className = e.target.value; } }),
  ));

  out.push(h('div', { class: 'row between' },
    h('span', { class: 'muted', text: `${plural(files.length, 'file')} found` }),
    h('span', { class: 'row' },
      h('button', { class: 'link', text: 'All', onclick: () => { unticked.clear(); render(); } }),
      h('button', { class: 'link', text: 'None', onclick: () => { files.forEach((f) => unticked.add(f.key)); render(); } }),
    ),
  ));

  const list = h('div', { class: 'list' });
  const groups = new Map();
  for (const f of files) {
    const g = f.topic || 'No topic';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  for (const [topic, fs] of groups) {
    list.append(h('div', { class: 'group', text: topic }));
    for (const f of fs) {
      const where = [f.post, ...(f.sub || [])].filter(Boolean).join(' › ');
      list.append(h('label', { class: 'file' },
        h('input', {
          type: 'checkbox',
          checked: !unticked.has(f.key),
          onchange: (e) => {
            if (e.target.checked) unticked.delete(f.key);
            else unticked.add(f.key);
            render();
          },
        }),
        h('div', {},
          h('div', { class: 'name' }, f.label, EXPORT_KINDS.has(f.kind) ? h('span', { class: 'tag', text: 'Google' }) : null),
          h('div', { class: 'sub', text: where }),
        ),
      ));
    }
  }
  out.push(list);

  out.push(h('label', { class: 'row' },
    h('input', { type: 'checkbox', checked: prefs.byTopic, onchange: (e) => { prefs.byTopic = e.target.checked; savePrefs(); } }),
    h('span', { text: 'Sort into topic folders' }),
  ));
  if (files.some((f) => EXPORT_KINDS.has(f.kind))) {
    const sel = h('select', { 'aria-label': 'Google Docs, Slides and Sheets format', onchange: (e) => { prefs.docFormat = e.target.value; savePrefs(); } },
      h('option', { value: 'pdf', text: 'PDF' }),
      h('option', { value: 'office', text: 'Word / PowerPoint / Excel' }),
    );
    sel.value = prefs.docFormat;
    out.push(h('label', { class: 'field' },
      h('span', { class: 'muted small', text: 'Save Google Docs, Slides and Sheets as' }),
      sel,
    ));
  }

  out.push(h('button', {
    class: 'primary block',
    disabled: selected.length === 0,
    text: selected.length ? `Download ${plural(selected.length, 'file')}` : 'Nothing selected',
    onclick: async () => {
      await send({
        type: 'DOWNLOAD',
        keys: selected.map((f) => f.key),
        className: className.trim(),
        byTopic: prefs.byTopic,
        docFormat: prefs.docFormat,
      });
      await refresh();
    },
  }));
  out.push(h('button', { class: 'link', text: 'Start over', onclick: reset }));

  if (state.skipped.length) {
    out.push(h('details', {},
      h('summary', { text: `${plural(state.skipped.length, 'link')} skipped` }),
      h('ul', {}, state.skipped.map((s) => h('li', { text: `${s.title} — ${s.reason}` }))),
    ));
  }
  out.push(logBox());
  return out;
}

function viewDownloading() {
  const { done, failed, total } = state.dl;
  return [
    h('p', { text: `Downloading… ${done + failed} of ${total}` }),
    progressBar(done + failed, total),
    failed ? h('p', { class: 'warn small', text: `${plural(failed, 'file')} could not be downloaded` }) : null,
    h('button', { class: 'block', text: 'Stop', onclick: () => send({ type: 'CANCEL' }) }),
  ];
}

function viewDone() {
  const { done, failed, failures, folder } = state.dl;
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
    done ? h('button', { class: 'primary block', text: 'Show in folder', onclick: () => send({ type: 'SHOW_IN_FOLDER' }) }) : null,
    h('button', { class: 'block', text: 'Done', onclick: reset }),
    logBox(),
  ];
}

function viewError() {
  return [
    h('div', { class: 'card' }, h('p', { class: 'bad', text: state.error || 'Something went wrong.' })),
    h('button', { class: 'primary block', text: 'Try again', onclick: reset }),
    logBox(),
  ];
}

function render() {
  if (!state) return;
  const views = {
    idle: viewIdle,
    scanning: viewBusy,
    collecting: viewBusy,
    review: viewReview,
    downloading: viewDownloading,
    done: viewDone,
    error: viewError,
  };
  const keep = app.querySelector('.list')?.scrollTop ?? 0;
  app.replaceChildren(...(views[state.phase] || viewIdle)().filter(Boolean));
  const list = app.querySelector('.list');
  if (list) list.scrollTop = keep;
}

async function refresh() {
  state = await send({ type: 'GET_STATE' });
  if (state.phase === 'idle') await detectContext();
  render();
}

// Live updates while the worker runs (the popup may even be opened mid-run).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.state?.newValue) {
    state = changes.state.newValue;
    render();
  }
});

loadPrefs().then(refresh);
