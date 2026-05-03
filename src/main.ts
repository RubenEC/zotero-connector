import { Plugin, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { ZoteroAutoSyncSettings, DEFAULT_SETTINGS, SECRET_KEY_ID } from './types';
import { ZoteroAutoSyncSettingTab } from './settings';
import { ZoteroApiClient } from './zotero/api-client';
import { NoteRenderer } from './renderer/note-renderer';
import { SyncManager, SyncResult } from './sync/sync-manager';
import { VersionTracker } from './sync/version-tracker';
import type {
  ZoteroConnectorApi,
  ZoteroGuidelinePdfImportInput,
  ZoteroGuidelinePdfImportResult,
} from './api';

export default class ZoteroConnectorPlugin extends Plugin {
  settings: ZoteroAutoSyncSettings = DEFAULT_SETTINGS;
  api!: ZoteroConnectorApi;
  private apiClient!: ZoteroApiClient;
  private renderer!: NoteRenderer;
  private syncManager!: SyncManager;
  private versionTracker!: VersionTracker;
  private statusBarEl: HTMLElement | null = null;
  private autoSyncIntervalId: number | null = null;
  private lastSyncTime: Date | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize modules
    this.apiClient = new ZoteroApiClient(
      this.settings,
      () => this.getApiKey()
    );
    this.renderer = new NoteRenderer(this.settings);
    this.versionTracker = new VersionTracker(this.settings, () => this.saveSettings());
    this.syncManager = new SyncManager(
      this.app,
      this.settings,
      this.apiClient,
      this.renderer,
      this.versionTracker,
      () => this.saveSettings()
    );

    this.api = {
      importGuidelinePdf: (input) => this.importGuidelinePdf(input),
      syncNow: async (options) => {
        await this.runSync(options?.silent ?? false);
      },
      syncItem: async (itemKey) => {
        await this.syncItemByKey(itemKey);
      },
      findLiteratureNoteByZoteroKey: (itemKey) => this.findLiteratureNoteByZoteroKey(itemKey),
    };

    // Ribbon icon
    this.addRibbonIcon('book-open', 'Zotero Connector: Sync now', async () => {
      await this.runSync();
    });

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: async () => {
        await this.runSync();
      },
    });

    this.addCommand({
      id: 'full-sync',
      name: 'Full sync (re-import all)',
      callback: async () => {
        await this.clearSyncCache();
        await this.runSync();
      },
    });

    this.addCommand({
      id: 'sync-current-note',
      name: 'Sync current note',
      callback: async () => {
        await this.syncCurrentNote();
      },
    });

    this.addCommand({
      id: 'register-existing-notes',
      name: 'Register existing notes',
      callback: async () => {
        await this.registerExistingNotes();
      },
    });

    this.addCommand({
      id: 'open-settings',
      name: 'Open settings',
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById(this.manifest.id);
      },
    });

    // Settings tab
    this.addSettingTab(new ZoteroAutoSyncSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Auto-sync
    this.setupAutoSync();
  }

  onunload(): void {
    if (this.autoSyncIntervalId !== null) {
      window.clearInterval(this.autoSyncIntervalId);
    }
  }

  // ── Secret Storage ──────────────────────────────────────────────────

  getApiKey(): string | null {
    return this.app.secretStorage.getSecret(SECRET_KEY_ID);
  }

  setApiKey(value: string): void {
    this.app.secretStorage.setSecret(SECRET_KEY_ID, value);
  }

  // ── Settings ────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.colorMap || this.settings.colorMap.length === 0) {
      this.settings.colorMap = [...DEFAULT_SETTINGS.colorMap];
    }
    if (!this.settings.itemVersions) {
      this.settings.itemVersions = {};
    }
    if (!this.settings.itemFilenames) {
      this.settings.itemFilenames = {};
    }
    if (!this.settings.zoteroCacheDirs || typeof this.settings.zoteroCacheDirs !== 'object') {
      this.settings.zoteroCacheDirs = {};
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.apiClient?.updateSettings(this.settings);
    this.renderer?.updateSettings(this.settings);
    this.syncManager?.updateSettings(this.settings);
    this.versionTracker?.updateSettings(this.settings);
  }

  setupAutoSync(): void {
    if (this.autoSyncIntervalId !== null) {
      window.clearInterval(this.autoSyncIntervalId);
      this.autoSyncIntervalId = null;
    }

    const intervalMs = this.settings.autoSyncIntervalMinutes * 60 * 1000;
    if (intervalMs > 0) {
      this.autoSyncIntervalId = this.registerInterval(
        window.setInterval(async () => {
          await this.runSync(true);
        }, intervalMs)
      );
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return this.apiClient.testConnection();
  }

  async importGuidelinePdf(input: ZoteroGuidelinePdfImportInput): Promise<ZoteroGuidelinePdfImportResult> {
    if (!this.getApiKey() || !this.settings.userId) {
      throw new Error('Configure Zotero Connector API credentials first.');
    }

    const providerLabel = input.providerLabel?.trim() || 'Guideline';
    const title = input.title.trim() || input.filename.replace(/\.pdf$/i, '') || 'Untitled guideline';
    const appliedTags = uniqueStrings(['obsidian', 'guidelines', this.settings.syncTag, ...(input.tags || [])]);

    const itemPayload = {
      itemType: 'journalArticle',
      title,
      abstractNote: '',
      publicationTitle: providerLabel,
      date: '',
      DOI: input.doi || '',
      url: input.url || '',
      extra: 'Type: Guideline',
      creators: [],
      tags: appliedTags.map(tag => ({ tag })),
    };

    const createData = await this.apiClient.createItems<ZoteroCreateResponse>([itemPayload]);
    const zoteroItemKey = extractCreatedKey(createData);
    if (!zoteroItemKey) {
      throw new Error(extractCreateFailureMessage(createData) || 'Zotero item creation failed.');
    }

    const attachmentPayload = {
      itemType: 'attachment',
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      filename: input.filename,
      parentItem: zoteroItemKey,
    };

    const attachmentData = await this.apiClient.createItems<ZoteroCreateResponse>([attachmentPayload]);
    const zoteroAttachmentKey = extractCreatedKey(attachmentData);
    if (!zoteroAttachmentKey) {
      throw new Error(extractCreateFailureMessage(attachmentData) || 'Zotero attachment creation failed.');
    }

    const uploaded = await this.apiClient.uploadImportedFile(zoteroAttachmentKey, input.pdf, input.filename);
    if (!uploaded) {
      throw new Error('Zotero PDF upload failed.');
    }

    let literatureNotePath: string | undefined;
    if (input.syncNote !== false) {
      await this.syncItemByKey(zoteroItemKey, true);
      literatureNotePath = this.findLiteratureNoteByZoteroKey(zoteroItemKey)?.path;
    }

    return {
      zoteroItemKey,
      zoteroAttachmentKey,
      literatureNotePath,
      appliedTags,
    };
  }

  async clearSyncCache(): Promise<void> {
    await this.versionTracker.clearAll();
    this.settings.itemFilenames = {};
    this.settings.lastSyncedTags = {};
    await this.saveSettings();
    this.apiClient.clearCollectionCache();
  }

  findLiteratureNoteByZoteroKey(itemKey: string): TFile | null {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.['zotero-key'] === itemKey) {
        return file;
      }
    }
    return null;
  }

  // ── Sync ────────────────────────────────────────────────────────────

  private async runSync(silent = false): Promise<void> {
    if (!this.getApiKey() || !this.settings.userId) {
      if (!silent) {
        new Notice('Zotero Connector: Please configure API key and User ID in settings.');
      }
      return;
    }

    this.updateStatusBar('syncing');
    this.syncManager.setProgressCallback((current, total) => {
      const pct = Math.round((current / total) * 100);
      this.updateStatusBar('syncing', `${pct}% (${current}/${total})`);
    });

    try {
      const result = await this.syncManager.syncAll();
      this.lastSyncTime = new Date();
      this.showSyncResult(result, silent);
    } catch (e) {
      if (!silent) {
        new Notice(`Zotero sync failed: ${(e as Error).message}`);
      }
      console.error('Zotero Connector error:', e);
    }

    this.syncManager.setProgressCallback(() => {});
    this.updateStatusBar();
  }

  private async syncCurrentNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No active note to sync.');
      return;
    }

    const content = await this.app.vault.read(activeFile);
    const keyMatch = content.match(/^zotero-key:\s*(.+)$/m);

    if (!keyMatch) {
      new Notice('This note does not have a zotero-key in its frontmatter.');
      return;
    }

    const itemKey = keyMatch[1].trim();
    await this.syncItemByKey(itemKey);
  }

  private async syncItemByKey(itemKey: string, silent = false): Promise<void> {
    this.updateStatusBar('syncing');

    try {
      const result = await this.syncManager.syncSingleItem(itemKey);
      this.lastSyncTime = new Date();
      this.showSyncResult(result, silent);
    } catch (e) {
      if (!silent) {
        new Notice(`Zotero sync failed: ${(e as Error).message}`);
      }
      if (silent) {
        throw e;
      }
    } finally {
      this.updateStatusBar();
    }
  }

  private async registerExistingNotes(): Promise<void> {
    const folderPath = normalizePath(this.settings.outputFolder);
    console.log(`[Zotero Connector] Registering notes from: ${folderPath}`);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`Output folder not found: ${folderPath}`);
      return;
    }

    if (!this.getApiKey() || !this.settings.userId) {
      new Notice('Zotero Connector: Please configure API key and User ID first.');
      return;
    }

    new Notice('Zotero: Scanning notes and tagging items in Zotero...');

    // Phase 1: Scan notes and collect item keys
    const mdFiles: TFile[] = [];
    const collectFiles = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === 'md') {
          mdFiles.push(child);
        } else if (child instanceof TFolder) {
          collectFiles(child);
        }
      }
    };
    collectFiles(folder);
    console.log(`[Zotero Connector] Found ${mdFiles.length} markdown files`);

    const noteMap: Map<string, { filename: string; tags: string[] }> = new Map();
    let skipped = 0;

    for (const file of mdFiles) {
      const content = await this.app.vault.read(file);

      const keyMatch = content.match(/zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Za-z0-9]+)/);
      if (!keyMatch) {
        skipped++;
        continue;
      }

      const itemKey = keyMatch[1];

      // Extract frontmatter tags
      const tags: string[] = [];
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const tagsMatch = fm.match(/^tags:\s*\r?\n((?:[ \t]*-\s*.+\r?\n?)*)/m);
        if (tagsMatch) {
          for (const line of tagsMatch[1].split(/\r?\n/)) {
            const m = line.match(/^\s*-\s*(.+)/);
            if (m) tags.push(m[1].trim());
          }
        }
      }

      noteMap.set(itemKey, { filename: file.basename, tags });
    }

    console.log(`[Zotero Connector] Found ${noteMap.size} notes with Zotero keys, ${skipped} without`);

    // Phase 2: Find keys that need to be registered (not yet in itemFilenames)
    const newKeys = [...noteMap.keys()].filter(k => !this.settings.itemFilenames[k]);
    // Also find keys that are registered but have no itemVersion (never synced by this plugin)
    const unsyncedKeys = [...noteMap.keys()].filter(k => !this.settings.itemVersions[k]);

    console.log(`[Zotero Connector] ${newKeys.length} new keys to register, ${unsyncedKeys.length} unsynced keys to tag`);

    // Register all new filename mappings
    for (const key of newKeys) {
      const info = noteMap.get(key)!;
      this.settings.itemFilenames[key] = info.filename;
      if (info.tags.length > 0) {
        this.settings.lastSyncedTags[key] = info.tags;
      }
    }

    // Phase 3: Fetch unsynced items from Zotero and add sync tag
    if (unsyncedKeys.length > 0) {
      let tagged = 0;
      let fetchErrors = 0;

      // Batch fetch items (50 at a time)
      const items = await this.apiClient.fetchItemsByKeys(unsyncedKeys);
      console.log(`[Zotero Connector] Fetched ${items.length} items from Zotero`);

      for (const item of items) {
        const hasSyncTag = (item.data.tags || []).some(t => t.tag === this.settings.syncTag);
        if (!hasSyncTag) {
          // Add sync tag to existing tags
          const newTags = [...(item.data.tags || []), { tag: this.settings.syncTag }];
          const ok = await this.apiClient.patchItemTags(item.key, newTags, item.version);
          if (ok) {
            tagged++;
          } else {
            fetchErrors++;
            console.warn(`[Zotero Connector] Failed to tag item ${item.key}`);
          }
        }
        // Store version so sync knows about this item
        this.settings.itemVersions[item.key] = 0; // Force re-sync on next run
      }

      console.log(`[Zotero Connector] Tagged ${tagged} items in Zotero, ${fetchErrors} errors`);
    }

    // Reset sync version to force full re-fetch on next sync
    this.settings.lastSyncVersion = 0;
    await this.saveSettings();

    const msg = `Registered ${newKeys.length} new notes, tagged ${unsyncedKeys.length} items in Zotero. Run sync now to update all notes.`;
    console.log(`[Zotero Connector] ${msg}`);
    new Notice(`Zotero: ${msg}`);
  }

  private showSyncResult(result: SyncResult, silent: boolean): void {
    if (result.errors.length > 0) {
      new Notice(`Zotero sync completed with errors:\n${result.errors[0]}`);
      return;
    }

    if (!silent && (result.created > 0 || result.updated > 0)) {
      new Notice(`Zotero: synced ${result.created} new, ${result.updated} updated`);
    } else if (!silent && result.created === 0 && result.updated === 0) {
      new Notice('Zotero: everything up to date');
    }
  }

  private statusClearTimer: number | null = null;

  private updateStatusBar(state?: 'syncing', progress?: string): void {
    if (!this.statusBarEl) return;
    if (this.statusClearTimer) { window.clearTimeout(this.statusClearTimer); this.statusClearTimer = null; }

    if (state === 'syncing') {
      this.statusBarEl.style.display = "";
      this.statusBarEl.setText(progress ? `Zotero: syncing ${progress}` : 'Zotero: syncing...');
      return;
    }

    if (this.lastSyncTime) {
      const ago = this.timeSince(this.lastSyncTime);
      this.statusBarEl.style.display = "";
      this.statusBarEl.setText(`Zotero: synced ${ago}`);
      // Hide after 5 seconds
      this.statusClearTimer = window.setTimeout(() => {
        if (this.statusBarEl) { this.statusBarEl.setText(""); this.statusBarEl.style.display = "none"; }
      }, 5000);
    } else {
      this.statusBarEl.setText('');
      this.statusBarEl.style.display = "none";
    }
  }

  private timeSince(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }
}

interface ZoteroCreateResponse {
  successful?: Record<string, { key: string }>;
  success?: Record<string, string>;
  failed?: Record<string, { code?: number; message?: string }>;
}

function extractCreatedKey(response: ZoteroCreateResponse): string {
  return response?.successful?.['0']?.key ?? response?.success?.['0'] ?? '';
}

function extractCreateFailureMessage(response: ZoteroCreateResponse): string | undefined {
  return response?.failed?.['0']?.message;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
