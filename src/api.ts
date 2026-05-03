import type { TFile } from 'obsidian';

export interface ZoteroGuidelinePdfImportInput {
  title: string;
  providerLabel?: string;
  url?: string;
  doi?: string;
  tags?: string[];
  pdf: ArrayBuffer;
  filename: string;
  syncNote?: boolean;
}

export interface ZoteroGuidelinePdfImportResult {
  zoteroItemKey: string;
  zoteroAttachmentKey: string | null;
  literatureNotePath?: string;
  appliedTags: string[];
}

export interface ZoteroConnectorApi {
  importGuidelinePdf(input: ZoteroGuidelinePdfImportInput): Promise<ZoteroGuidelinePdfImportResult>;
  syncNow(options?: { silent?: boolean }): Promise<void>;
  syncItem(itemKey: string): Promise<void>;
  findLiteratureNoteByZoteroKey(itemKey: string): TFile | null;
}

