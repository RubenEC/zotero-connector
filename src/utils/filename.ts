import { ZoteroItem } from '../zotero/types';
import { ZoteroAutoSyncSettings } from '../types';

/** Characters not allowed in filenames on Windows/macOS/Linux */
const UNSAFE_CHARS = /[\\/:*?"<>|#^\[\]]/g;

export function generateFilename(item: ZoteroItem, settings: ZoteroAutoSyncSettings): string {
  const d = item.data;
  const template = settings.fileNameTemplate || '{{citekey}}';

  let filename: string;

  if (template === '{{citekey}}') {
    const citekey = extractCitekey(d);
    filename = citekey || buildCitekeyFallback(d) || buildFallbackName(d);
  } else if (template === '{{title}}') {
    filename = d.title || item.key;
  } else {
    // Simple template substitution
    filename = template
      .replace(/\{\{citekey\}\}/g, extractCitekey(d) || item.key)
      .replace(/\{\{title\}\}/g, d.title || '')
      .replace(/\{\{key\}\}/g, item.key)
      .replace(/\{\{year\}\}/g, extractYear(d.date))
      .replace(/\{\{author\}\}/g, firstAuthorLastName(d.creators));
  }

  // Sanitize
  filename = filename.replace(UNSAFE_CHARS, '').trim();

  // Ensure non-empty
  if (!filename) {
    filename = item.key;
  }

  return filename;
}

export function extractCitekey(data: ZoteroItem['data']): string {
  if (data.extra) {
    const match = data.extra.match(/Citation Key:\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }
  }
  return '';
}

function capitalizeHyphenated(name: string): string {
  return name.split('-').map(seg =>
    seg.length > 0 ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg
  ).join('-');
}

function buildCitekeyFallback(data: ZoteroItem['data']): string {
  const author = firstAuthorLastName(data.creators);
  const year = extractYear(data.date);
  if (author) {
    const capitalized = capitalizeHyphenated(author);
    return year ? `${capitalized}_${year}` : capitalized;
  }
  return '';
}

function buildFallbackName(data: ZoteroItem['data']): string {
  const author = firstAuthorLastName(data.creators);
  const year = extractYear(data.date);
  const title = data.title || 'Untitled';
  const parts = [author, year].filter(Boolean);
  if (parts.length > 0) {
    return `${parts.join(' ')} - ${title}`;
  }
  return title;
}

function firstAuthorLastName(creators: ZoteroItem['data']['creators']): string {
  if (!creators || creators.length === 0) return '';
  const first = creators[0];
  return first.lastName || first.name || '';
}

function extractYear(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{4})/);
  return m ? m[1] : '';
}

export function ensureUniqueFilename(
  desiredName: string,
  existingFiles: Set<string>,
  itemKey: string
): string {
  if (!existingFiles.has(desiredName)) {
    return desiredName;
  }
  // Append item key to avoid conflict
  return `${desiredName} (${itemKey})`;
}

export interface AnnotationPosition {
  pageIndex: number;
  x: number;
  y: number;
}

export function parseAnnotationPosition(json: string | undefined): AnnotationPosition | null {
  if (!json) return null;
  try {
    const pos = JSON.parse(json);
    const pageIndex = typeof pos.pageIndex === 'number' ? pos.pageIndex : -1;
    const rects = pos.rects;
    if (pageIndex < 0 || !Array.isArray(rects) || rects.length === 0) return null;
    // Use top-left corner of first rect
    const firstRect = rects[0];
    if (!Array.isArray(firstRect) || firstRect.length < 2) return null;
    return {
      pageIndex,
      x: Math.round(firstRect[0]),
      y: Math.round(firstRect[1]),
    };
  } catch {
    return null;
  }
}

export function buildAnnotationImagePath(
  folder: string,
  citekey: string,
  position: AnnotationPosition
): string {
  const page = position.pageIndex + 1; // 0-indexed → 1-indexed
  return `${folder}/${citekey}/image-${page}-x${position.x}-y${position.y}.png`;
}
