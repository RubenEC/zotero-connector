import type { TFile } from 'obsidian';

export type ZoteroGuidelinePdfImportMode = 'metadata-first' | 'placeholder-parent';

export interface ZoteroGuidelinePdfImportInput {
  title?: string;
  providerLabel?: string;
  url?: string;
  doi?: string;
  citekey?: string;
  authorNames?: string[];
  date?: string;
  tags?: string[];
  pdf: ArrayBuffer;
  filename: string;
  importMode?: ZoteroGuidelinePdfImportMode;
  syncNote?: boolean;
}

export interface ZoteroGuidelinePdfImportResult {
  zoteroItemKey: string | null;
  zoteroAttachmentKey: string;
  literatureNotePath?: string;
  appliedTags: string[];
  parentPending: boolean;
}

export interface ZoteroGuidelinePdfFinalizeInput {
  attachmentKey: string;
  title?: string;
  providerLabel?: string;
  url?: string;
  doi?: string;
  citekey?: string;
  tags?: string[];
  syncNote?: boolean;
}

export interface ZoteroConnectorApi {
  importGuidelinePdf(input: ZoteroGuidelinePdfImportInput): Promise<ZoteroGuidelinePdfImportResult>;
  finalizeGuidelinePdfImport(input: ZoteroGuidelinePdfFinalizeInput): Promise<ZoteroGuidelinePdfImportResult>;
  syncNow(options?: { silent?: boolean }): Promise<void>;
  syncItem(itemKey: string): Promise<void>;
  findLiteratureNoteByZoteroKey(itemKey: string): TFile | null;
}
