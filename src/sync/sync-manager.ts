import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { ZoteroApiClient } from '../zotero/api-client';
import { ZoteroItem, SyncItemData } from '../zotero/types';
import { NoteRenderer } from '../renderer/note-renderer';
import { VersionTracker } from './version-tracker';
import { ZoteroAutoSyncSettings } from '../types';
import {
  generateFilename,
  extractCitekey,
  parseAnnotationPosition,
  buildAnnotationImagePath,
} from '../utils/filename';

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export class SyncManager {
  private app: App;
  private settings: ZoteroAutoSyncSettings;
  private apiClient: ZoteroApiClient;
  private renderer: NoteRenderer;
  private versionTracker: VersionTracker;
  private saveSettings: () => Promise<void>;
  private isSyncing = false;
  private onProgress: ((current: number, total: number) => void) | null = null;

  constructor(
    app: App,
    settings: ZoteroAutoSyncSettings,
    apiClient: ZoteroApiClient,
    renderer: NoteRenderer,
    versionTracker: VersionTracker,
    saveSettings: () => Promise<void>
  ) {
    this.app = app;
    this.settings = settings;
    this.apiClient = apiClient;
    this.renderer = renderer;
    this.versionTracker = versionTracker;
    this.saveSettings = saveSettings;
  }

  updateSettings(settings: ZoteroAutoSyncSettings): void {
    this.settings = settings;
  }

  setProgressCallback(cb: (current: number, total: number) => void): void {
    this.onProgress = cb;
  }

  get syncing(): boolean {
    return this.isSyncing;
  }

  // ── Tag sync helpers ──────────────────────────────────────────────────

  private parseFrontmatterTags(content: string): string[] {
    // Match the tags: block in YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];
    const fm = fmMatch[1];

    // Find the tags section
    const tagsMatch = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)*)/m);
    if (!tagsMatch) return [];

    const tags: string[] = [];
    const lines = tagsMatch[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*-\s*(.+)/);
      if (m) {
        tags.push(m[1].trim());
      }
    }
    return tags;
  }

  private normalizeTag(tag: string): string {
    return tag.replace(/-/g, ' ').toLowerCase();
  }

  private tagsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const normA = a.map(t => this.normalizeTag(t)).sort();
    const normB = b.map(t => this.normalizeTag(t)).sort();
    return normA.every((v, i) => v === normB[i]);
  }

  /**
   * Two-way tag merge.
   * Returns the merged tag list (without sync tag) and pushes to Zotero if needed.
   */
  private async syncTagsTwoWay(
    item: ZoteroItem,
    existingContent: string | null
  ): Promise<string[]> {
    const syncTag = this.settings.syncTag;

    // Zotero tags (excluding sync tag)
    const zoteroTags = (item.data.tags || [])
      .filter(t => t.tag !== syncTag)
      .map(t => t.tag);

    // If no existing note, this is a new file — use Zotero tags as-is
    if (!existingContent) {
      this.settings.lastSyncedTags[item.key] = zoteroTags.map(t => t.replace(/\s+/g, '-'));
      await this.saveSettings();
      return zoteroTags;
    }

    // Read frontmatter tags from existing note
    const fmTags = this.parseFrontmatterTags(existingContent);

    // Get last synced tags for this item
    const lastSynced = this.settings.lastSyncedTags[item.key];

    if (!lastSynced) {
      // First sync for this item — don't remove anything, only add
      // Start with fmTags, add any zoteroTags not already present
      const fmNormSet = new Set(fmTags.map(t => this.normalizeTag(t)));
      const merged = [...fmTags];
      for (const zt of zoteroTags) {
        const norm = this.normalizeTag(zt);
        if (!fmNormSet.has(norm)) {
          merged.push(zt.replace(/\s+/g, '-'));
          fmNormSet.add(norm);
        }
      }

      // Push to Zotero if merged differs from zoteroTags
      await this.pushTagsToZotero(item, merged, syncTag, zoteroTags);

      this.settings.lastSyncedTags[item.key] = [...merged];
      await this.saveSettings();
      return merged;
    }

    // Normal merge: start with fmTags (user's curated list)
    const fmNormSet = new Set(fmTags.map(t => this.normalizeTag(t)));
    const lastSyncedNormSet = new Set(lastSynced.map(t => this.normalizeTag(t)));
    const zoteroNormSet = new Set(zoteroTags.map(t => this.normalizeTag(t)));

    // Remove tags that were deleted in Zotero since last sync
    // (tag was in lastSynced but is now gone from Zotero → user removed it in Zotero)
    const removedInZotero = new Set<string>();
    for (const ls of lastSynced) {
      const norm = this.normalizeTag(ls);
      if (!zoteroNormSet.has(norm)) {
        removedInZotero.add(norm);
      }
    }

    const merged = fmTags.filter(t => !removedInZotero.has(this.normalizeTag(t)));
    const mergedNormSet = new Set(merged.map(t => this.normalizeTag(t)));

    // Add zotero tags that are new since last sync (not in lastSynced)
    for (const zt of zoteroTags) {
      const norm = this.normalizeTag(zt);
      if (!lastSyncedNormSet.has(norm) && !mergedNormSet.has(norm)) {
        // Newly added in Zotero since last sync
        merged.push(zt.replace(/\s+/g, '-'));
        mergedNormSet.add(norm);
      }
    }

    // Push to Zotero if merged differs from zoteroTags
    await this.pushTagsToZotero(item, merged, syncTag, zoteroTags);

    this.settings.lastSyncedTags[item.key] = [...merged];
    await this.saveSettings();
    return merged;
  }

  private async pushTagsToZotero(
    item: ZoteroItem,
    merged: string[],
    syncTag: string,
    zoteroTags: string[]
  ): Promise<void> {
    if (this.tagsEqual(merged, zoteroTags)) return;

    // Build tag objects: merged tags (hyphens→spaces for Zotero) + sync tag
    const tagsForZotero: { tag: string }[] = merged.map(t => ({
      tag: t.replace(/-/g, ' ')
    }));
    tagsForZotero.push({ tag: syncTag });

    await this.apiClient.patchItemTags(item.key, tagsForZotero, item.version);
  }

  async syncAll(): Promise<SyncResult> {
    if (this.isSyncing) {
      new Notice('Zotero sync already in progress');
      return { created: 0, updated: 0, skipped: 0, errors: ['Sync already in progress'] };
    }

    this.isSyncing = true;
    const result: SyncResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    try {
      // Validate settings
      if (!this.settings.userId) {
        throw new Error('User ID is required. Configure it in settings.');
      }

      // Fetch collections (cache them for this sync cycle)
      await this.apiClient.fetchCollections();

      // Fetch items with sync tag, using incremental sync if possible
      const sinceVersion = this.versionTracker.getLibraryVersion();
      const { items, libraryVersion } = await this.apiClient.fetchItemsByTag(
        this.settings.syncTag,
        sinceVersion > 0 ? sinceVersion : undefined
      );

      if (items.length === 0 && sinceVersion > 0) {
        // Nothing changed
        return result;
      }

      // Filter to top-level items only (skip attachments, notes, annotations)
      const topLevelItems = items.filter(item =>
        item.data.itemType !== 'attachment' &&
        item.data.itemType !== 'note' &&
        item.data.itemType !== 'annotation'
      );

      // Ensure output folder exists
      await this.ensureFolder(this.settings.outputFolder);

      // Process each item
      const total = topLevelItems.length;
      let processed = 0;
      for (const item of topLevelItems) {
        try {
          processed++;
          this.onProgress?.(processed, total);
          // Use stored filename if available, otherwise generate and store
          let filename = this.settings.itemFilenames[item.key];
          if (!filename) {
            filename = generateFilename(item, this.settings);
            this.settings.itemFilenames[item.key] = filename;
            await this.saveSettings();
          }

          const filePath = normalizePath(`${this.settings.outputFolder}/${filename}.md`);
          const existingFile = this.app.vault.getAbstractFileByPath(filePath);

          // Skip if version unchanged AND the file still exists
          // BUT re-process if there are missing image annotations and local cache is available
          // BUT also re-process if frontmatter tags have changed (for two-way tag sync)
          const fileExists = existingFile && existingFile instanceof TFile;
          if (!this.versionTracker.isItemChanged(item.key, item.version) && fileExists) {
            const hasMissingImages = await this.hasMissingImageAnnotations(existingFile as TFile);
            const hasTagChanges = await this.hasLocalTagChanges(existingFile as TFile, item.key);
            if (!hasMissingImages && !hasTagChanges) {
              result.skipped++;
              continue;
            }
            // Fall through to re-process
          }

          const syncData = await this.buildSyncData(item);
          syncData.citekey = filename;

          // Two-way tag sync
          const existingContent = (existingFile && existingFile instanceof TFile)
            ? await this.app.vault.read(existingFile)
            : null;
          const mergedTags = await this.syncTagsTwoWay(item, existingContent);

          // Apply merged tags to item data for rendering
          syncData.item.data.tags = [
            ...mergedTags.map(t => ({ tag: t })),
            { tag: this.settings.syncTag },
          ];

          const content = await this.renderContent(syncData);

          if (existingFile && existingFile instanceof TFile) {
            // Update existing file, preserving user comments if enabled
            if (this.settings.preserveUserContent) {
              const merged = this.renderer.renderWithPreservedComments(syncData, existingContent!, content);
              await this.app.vault.modify(existingFile, merged);
            } else {
              await this.app.vault.modify(existingFile, content);
            }
            result.updated++;
          } else {
            // Create new file
            await this.app.vault.create(filePath, content);
            result.created++;
          }

          // Update version tracking
          await this.versionTracker.setItemVersion(item.key, item.version);
        } catch (e) {
          const msg = `Error processing item ${item.key}: ${(e as Error).message}`;
          result.errors.push(msg);
          console.error(msg, e);
        }
      }

      // Update library version
      if (libraryVersion > 0) {
        await this.versionTracker.setLibraryVersion(libraryVersion);
      }

    } catch (e) {
      const msg = `Sync failed: ${(e as Error).message}`;
      result.errors.push(msg);
      console.error(msg, e);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  async syncSingleItem(itemKey: string): Promise<SyncResult> {
    if (this.isSyncing) {
      new Notice('Zotero sync already in progress');
      return { created: 0, updated: 0, skipped: 0, errors: ['Sync already in progress'] };
    }

    this.isSyncing = true;
    const result: SyncResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    try {
      if (!this.settings.userId) {
        throw new Error('User ID is required.');
      }

      await this.apiClient.fetchCollections();

      // Fetch the specific item directly by key
      const item = await this.apiClient.fetchItem(itemKey);

      if (!item) {
        result.errors.push(`Item ${itemKey} not found in Zotero.`);
        return result;
      }

      await this.ensureFolder(this.settings.outputFolder);

      // Use stored filename if available, otherwise generate and store
      let filename = this.settings.itemFilenames[itemKey];
      if (!filename) {
        filename = generateFilename(item, this.settings);
        this.settings.itemFilenames[itemKey] = filename;
        await this.saveSettings();
      }

      const syncData = await this.buildSyncData(item);
      syncData.citekey = filename;

      const filePath = normalizePath(`${this.settings.outputFolder}/${filename}.md`);
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);

      // Two-way tag sync
      const existingContent = (existingFile && existingFile instanceof TFile)
        ? await this.app.vault.read(existingFile)
        : null;
      const mergedTags = await this.syncTagsTwoWay(item, existingContent);

      // Apply merged tags to item data for rendering
      syncData.item.data.tags = [
        ...mergedTags.map(t => ({ tag: t })),
        { tag: this.settings.syncTag },
      ];

      const content = await this.renderContent(syncData);

      if (existingFile && existingFile instanceof TFile) {
        if (this.settings.preserveUserContent) {
          const merged = this.renderer.renderWithPreservedComments(syncData, existingContent!, content);
          await this.app.vault.modify(existingFile, merged);
        } else {
          await this.app.vault.modify(existingFile, content);
        }
        result.updated++;
      } else {
        await this.app.vault.create(filePath, content);
        result.created++;
      }

      await this.versionTracker.setItemVersion(item.key, item.version);
    } catch (e) {
      result.errors.push(`Sync failed: ${(e as Error).message}`);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  private async renderContent(syncData: SyncItemData): Promise<string> {
    // If a template path is set, try to use it
    if (this.settings.templatePath) {
      let path = normalizePath(this.settings.templatePath);
      // Append .md if not already present
      if (!path.endsWith('.md')) {
        path += '.md';
      }
      const templateFile = this.app.vault.getAbstractFileByPath(path);
      if (templateFile && templateFile instanceof TFile) {
        const template = await this.app.vault.read(templateFile);
        return this.renderer.renderFromTemplate(syncData, template);
      } else {
        console.warn(`[Zotero Connector] Template file not found: ${path}`);
      }
    }
    return this.renderer.render(syncData);
  }

  private async buildSyncData(item: ZoteroItem): Promise<SyncItemData> {
    console.log('[Zotero Connector] Building sync data for item:', item.key, item.data?.title);

    // Fetch children
    const children = await this.apiClient.fetchItemChildren(item.key);

    // Collect annotations from PDF attachments
    const pdfAttachments = children.filter(
      c => c.data.itemType === 'attachment' && c.data.contentType === 'application/pdf'
    );

    let allAnnotations: ZoteroItem[] = [];
    for (const pdf of pdfAttachments) {
      const annotations = await this.apiClient.fetchAnnotations(pdf.key);
      allAnnotations.push(...annotations);
    }

    // Resolve collection names
    const collectionKeys = item.data.collections || [];
    const collectionNames: string[] = [];
    for (const key of collectionKeys) {
      const name = this.apiClient.getCollectionName(key);
      if (name) {
        collectionNames.push(name);
      }
    }

    // Fetch bibliography
    const bibliography = await this.apiClient.fetchBibliography(item.key);

    // Process image annotations
    const annotationImages = await this.processImageAnnotations(item, allAnnotations);

    return {
      item,
      children,
      annotations: allAnnotations,
      collectionNames,
      bibliography,
      annotationImages: annotationImages.size > 0 ? annotationImages : undefined,
    };
  }

  private async processImageAnnotations(
    item: ZoteroItem,
    annotations: ZoteroItem[]
  ): Promise<Map<string, string>> {
    const imageAnnotations = annotations.filter(a => a.data.annotationType === 'image');
    const annotationImages = new Map<string, string>();

    if (imageAnnotations.length === 0) return annotationImages;

    const citekey = extractCitekey(item.data) || generateFilename(item, this.settings);
    const imageFolder = this.settings.imageOutputFolder || 'Maintenance/Attachments';

    for (const ann of imageAnnotations) {
      try {
        const position = parseAnnotationPosition(ann.data.annotationPosition);
        if (!position) {
          console.warn(`[Zotero Connector] Could not parse position for annotation ${ann.key}`);
          continue;
        }

        const imagePath = buildAnnotationImagePath(imageFolder, citekey, position);
        const normalizedPath = normalizePath(imagePath);

        // Check if image already exists in vault
        const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (existingFile && existingFile instanceof TFile) {
          annotationImages.set(ann.key, normalizedPath);
          continue;
        }

        // Try Web API first
        let imageData = await this.apiClient.fetchAnnotationImage(ann.key);

        // Fallback: try local Zotero cache
        if (!imageData) {
          imageData = await this.readFromLocalCache(ann.key);
        }

        if (!imageData) {
          console.warn(`[Zotero Connector] No image data for annotation ${ann.key}`);
          continue;
        }

        // Ensure folder exists and save image
        const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
        await this.ensureFolderRecursive(folderPath);
        await this.app.vault.createBinary(normalizedPath, imageData);
        annotationImages.set(ann.key, normalizedPath);
      } catch (e) {
        console.warn(`[Zotero Connector] Failed to process image annotation ${ann.key}:`, e);
      }
    }

    return annotationImages;
  }

  private async readFromLocalCache(annotationKey: string): Promise<ArrayBuffer | null> {
    const hostname = require('os').hostname();
    const cacheDir = this.settings.zoteroCacheDirs[hostname];
    if (!cacheDir) return null;

    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(cacheDir, `${annotationKey}.png`);
      const buffer: Buffer = fs.readFileSync(filePath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } catch {
      return null;
    }
  }

  private async hasMissingImageAnnotations(file: TFile): Promise<boolean> {
    const hostname = require('os').hostname();
    const hasLocalCache = !!this.settings.zoteroCacheDirs[hostname];
    if (!hasLocalCache) return false;

    const content = await this.app.vault.read(file);
    return content.includes('[Area highlight');
  }

  private async hasLocalTagChanges(file: TFile, itemKey: string): Promise<boolean> {
    const lastSynced = this.settings.lastSyncedTags[itemKey];
    if (!lastSynced) return false; // No baseline yet — will be handled during sync

    const content = await this.app.vault.read(file);
    const fmTags = this.parseFrontmatterTags(content);

    return !this.tagsEqual(fmTags, lastSynced);
  }

  private async ensureFolderRecursive(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing && existing instanceof TFolder) return;

    // Split into parts and create each level
    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(current);
      if (!folder) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      await this.app.vault.createFolder(normalized);
    }
  }
}
