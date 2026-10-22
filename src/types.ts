/** Shapes shared by the background worker, the content script and the popup. */

export type Phase = 'idle' | 'scanning' | 'collecting' | 'review' | 'downloading' | 'done' | 'error';

/** What a Drive/Docs link points at. */
export type Kind = 'file' | 'document' | 'presentation' | 'spreadsheets' | 'folder' | 'form';

/** Kinds that become a downloadable file (folders are expanded, forms are skipped). */
export type FileKind = Exclude<Kind, 'folder' | 'form'>;

/** Google-native files have no original, so the user picks how they are exported. */
export type DocFormat = 'pdf' | 'office';

export interface Classified {
  kind: Kind;
  id: string;
  authuser: string;
}

export interface FileEntry {
  key: string;
  kind: FileKind;
  id: string;
  authuser: string;
  /** Link text from Classroom, used as a fallback file name. */
  hint: string;
  label: string;
  post: string;
  topic: string;
  /** Path of Drive folders the file was found in. */
  sub: string[];
}

export interface Skipped {
  post: string;
  title: string;
  reason: string;
  href: string;
}

export interface DownloadFailure {
  name: string;
  post: string;
  reason: string;
}

export interface AppState {
  phase: Phase;
  className: string;
  progress: { done: number; total: number; label: string };
  files: FileEntry[];
  skipped: Skipped[];
  dl: {
    total: number;
    done: number;
    failed: number;
    failures: DownloadFailure[];
    lastId: number | null;
    folder: string;
  };
  log: string[];
  error: string;
}

/** One post found on the Classwork page. */
export interface ScanItem {
  url: string;
  title: string;
  topic: string;
}

export interface ScanResult {
  className: string;
  items: ScanItem[];
  error?: string;
}

/** A link found on a post page. */
export interface PageLink {
  href: string;
  text: string;
}

export interface Prefs {
  byTopic: boolean;
  docFormat: DocFormat;
}

export type Message =
  | { type: 'GET_STATE' }
  | { type: 'START'; tabId: number }
  | { type: 'DOWNLOAD'; keys: string[]; className: string; byTopic: boolean; docFormat: DocFormat }
  | { type: 'CANCEL' }
  | { type: 'RESET' }
  | { type: 'SHOW_IN_FOLDER' };
