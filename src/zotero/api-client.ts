import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { ZoteroItem, ZoteroCollection } from './types';
import { ZoteroAutoSyncSettings } from '../types';

const BASE_URL = 'https://api.zotero.org';
const API_VERSION = '3';
const PAGE_LIMIT = 100;

export class ZoteroApiClient {
  private settings: ZoteroAutoSyncSettings;
  private getApiKey: () => string | null;
  private collectionCache: Map<string, string> = new Map();

  constructor(settings: ZoteroAutoSyncSettings, getApiKey: () => string | null) {
    this.settings = settings;
    this.getApiKey = getApiKey;
  }

  updateSettings(settings: ZoteroAutoSyncSettings): void {
    this.settings = settings;
  }

  private get libraryPrefix(): string {
    if (this.settings.libraryType === 'group' && this.settings.groupId) {
      return `/groups/${this.settings.groupId}`;
    }
    return `/users/${this.settings.userId}`;
  }

  private async request(
    path: string,
    params: Record<string, string> = {},
    options?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<RequestUrlResponse> {
    const url = new URL(`${BASE_URL}${this.libraryPrefix}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Zotero API key not configured. Set it in plugin settings.');
    }

    const headers: Record<string, string> = {
      'Zotero-API-Version': API_VERSION,
      'Zotero-API-Key': apiKey,
      ...options?.headers,
    };

    const reqParams: RequestUrlParam = {
      url: url.toString(),
      method: options?.method || 'GET',
      headers,
      body: options?.body,
      throw: false, // Don't throw on non-200, let us handle status codes
    };

    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await requestUrl(reqParams);

    // Handle rate limiting
    const backoff = response.headers['backoff'];
    if (backoff) {
      await this.sleep(parseInt(backoff, 10) * 1000);
    }

    if (response.status === 429) {
      const retryAfter = response.headers['retry-after'];
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
      await this.sleep(waitMs);
      return this.request(path, params, options);
    }

    if (response.status >= 400) {
      throw new Error(`Zotero API error ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return response;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async createItems<T = unknown>(payloads: unknown[]): Promise<T> {
    const response = await this.request(
      '/items',
      {},
      {
        method: 'POST',
        body: JSON.stringify(payloads),
      }
    );
    return response.json as T;
  }

  async uploadImportedFile(attachmentKey: string, file: ArrayBuffer, filename: string): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Zotero API key not configured. Set it in plugin settings.');
    }

    const md5 = require('crypto')
      .createHash('md5')
      .update(Buffer.from(file))
      .digest('hex');

    const fileUrl = `${BASE_URL}${this.libraryPrefix}/items/${attachmentKey}/file`;
    const uploadParams = new URLSearchParams({
      md5,
      filename,
      filesize: String(file.byteLength),
      mtime: String(Date.now()),
    });

    const authResponse = await requestUrl({
      url: fileUrl,
      method: 'POST',
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-API-Version': API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
        'If-None-Match': '*',
      },
      body: uploadParams.toString(),
      throw: false,
    });

    if (authResponse.status !== 200) {
      console.error(`[Zotero Connector] Zotero upload auth failed with status ${authResponse.status}: ${authResponse.text}`);
      return false;
    }

    const authData = authResponse.json as {
      exists?: number;
      url?: string;
      contentType?: string;
      prefix?: string;
      suffix?: string;
      uploadKey?: string;
    };

    if (authData?.exists === 1) {
      return true;
    }

    if (!authData?.url || !authData?.prefix || !authData?.suffix || !authData?.uploadKey) {
      console.error('[Zotero Connector] Unexpected Zotero upload auth response', authData);
      return false;
    }

    const prefixBytes = new TextEncoder().encode(authData.prefix);
    const suffixBytes = new TextEncoder().encode(authData.suffix);
    const fileBytes = new Uint8Array(file);
    const body = new Uint8Array(prefixBytes.length + fileBytes.length + suffixBytes.length);
    body.set(prefixBytes, 0);
    body.set(fileBytes, prefixBytes.length);
    body.set(suffixBytes, prefixBytes.length + fileBytes.length);

    const uploadResponse = await requestUrl({
      url: authData.url,
      method: 'POST',
      headers: { 'Content-Type': authData.contentType ?? 'multipart/form-data' },
      body: body.buffer as ArrayBuffer,
      throw: false,
    });

    if (uploadResponse.status !== 201 && uploadResponse.status !== 204) {
      console.error(`[Zotero Connector] PDF upload to Zotero storage failed with status ${uploadResponse.status}`);
      return false;
    }

    const registerResponse = await requestUrl({
      url: fileUrl,
      method: 'POST',
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-API-Version': API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
        'If-None-Match': '*',
      },
      body: `upload=${authData.uploadKey}`,
      throw: false,
    });

    if (registerResponse.status !== 204) {
      console.error(`[Zotero Connector] Zotero upload registration failed with status ${registerResponse.status}`);
      return false;
    }

    return true;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.request('/items', { limit: '1' });
      if (response.status === 200) {
        return { ok: true, message: 'Connection successful!' };
      }
      if (response.status === 403) {
        return { ok: false, message: 'Invalid API key or insufficient permissions.' };
      }
      return { ok: false, message: `Unexpected response: ${response.status}` };
    } catch (e) {
      return { ok: false, message: `Connection failed: ${(e as Error).message}` };
    }
  }

  async fetchItemsByTag(tag: string, since?: number): Promise<{ items: ZoteroItem[]; libraryVersion: number }> {
    const allItems: ZoteroItem[] = [];
    let start = 0;
    let libraryVersion = 0;

    while (true) {
      const params: Record<string, string> = {
        tag: tag,
        format: 'json',
        include: 'data,bib',
        limit: String(PAGE_LIMIT),
        start: String(start),
        sort: 'dateModified',
        direction: 'desc',
      };

      if (since !== undefined && since > 0) {
        params['since'] = String(since);
      }

      const response = await this.request('/items', params);

      if (response.status === 304) {
        return { items: [], libraryVersion: since || 0 };
      }

      const versionHeader = response.headers['last-modified-version'];
      if (versionHeader) {
        libraryVersion = parseInt(versionHeader, 10);
      }

      const items: ZoteroItem[] = response.json;
      allItems.push(...items);

      const totalResults = parseInt(response.headers['total-results'] || '0', 10);
      start += PAGE_LIMIT;

      if (start >= totalResults || items.length < PAGE_LIMIT) {
        break;
      }
    }

    return { items: allItems, libraryVersion };
  }

  async fetchItem(itemKey: string): Promise<ZoteroItem | null> {
    try {
      const response = await this.request(`/items/${itemKey}`, {
        format: 'json',
        include: 'data,bib',
      });
      return response.json;
    } catch {
      return null;
    }
  }

  async fetchItemsByKeys(keys: string[]): Promise<ZoteroItem[]> {
    const allItems: ZoteroItem[] = [];
    // Zotero API supports up to 50 keys per request
    for (let i = 0; i < keys.length; i += 50) {
      const batch = keys.slice(i, i + 50);
      const response = await this.request('/items', {
        itemKey: batch.join(','),
        format: 'json',
        include: 'data,bib',
        limit: '50',
      });
      const items: ZoteroItem[] = response.json;
      allItems.push(...items);
    }
    return allItems;
  }

  async fetchItemChildren(itemKey: string): Promise<ZoteroItem[]> {
    const allChildren: ZoteroItem[] = [];
    let start = 0;

    while (true) {
      const response = await this.request(`/items/${itemKey}/children`, {
        format: 'json',
        include: 'data',
        limit: String(PAGE_LIMIT),
        start: String(start),
      });

      const items: ZoteroItem[] = response.json;
      allChildren.push(...items);

      const totalResults = parseInt(response.headers['total-results'] || '0', 10);
      start += PAGE_LIMIT;

      if (start >= totalResults || items.length < PAGE_LIMIT) {
        break;
      }
    }

    return allChildren;
  }

  async fetchAnnotations(attachmentKey: string): Promise<ZoteroItem[]> {
    const allItems: ZoteroItem[] = [];
    let start = 0;

    while (true) {
      const response = await this.request(`/items/${attachmentKey}/children`, {
        format: 'json',
        include: 'data',
        limit: String(PAGE_LIMIT),
        start: String(start),
      });

      const items: ZoteroItem[] = response.json;
      allItems.push(...items);

      const totalResults = parseInt(response.headers['total-results'] || '0', 10);
      start += PAGE_LIMIT;

      if (start >= totalResults || items.length < PAGE_LIMIT) {
        break;
      }
    }

    return allItems.filter(item => item.data.itemType === 'annotation');
  }

  async fetchBibliography(itemKey: string): Promise<string> {
    try {
      const response = await this.request(`/items/${itemKey}`, {
        format: 'json',
        include: 'bib',
        style: 'apa',
      });
      const data = response.json;
      if (data.bib) {
        return this.cleanBibliography(data.bib);
      }
      return '';
    } catch {
      return '';
    }
  }

  private cleanBibliography(bib: string): string {
    // Strip HTML tags
    let cleaned = bib.replace(/<[^>]+>/g, '');
    // Remove leading numbering (e.g., "1. ")
    cleaned = cleaned.replace(/^\d+\.\s*/, '');
    // Collapse whitespace and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  async fetchCollections(): Promise<Map<string, string>> {
    if (this.collectionCache.size > 0) {
      return this.collectionCache;
    }

    const allCollections: ZoteroCollection[] = [];
    let start = 0;

    while (true) {
      const response = await this.request('/collections', {
        format: 'json',
        limit: String(PAGE_LIMIT),
        start: String(start),
      });

      const collections: ZoteroCollection[] = response.json;
      allCollections.push(...collections);

      const totalResults = parseInt(response.headers['total-results'] || '0', 10);
      start += PAGE_LIMIT;

      if (start >= totalResults || collections.length < PAGE_LIMIT) {
        break;
      }
    }

    this.collectionCache.clear();
    for (const col of allCollections) {
      this.collectionCache.set(col.key, col.data.name);
    }

    return this.collectionCache;
  }

  async fetchAnnotationImage(annotationKey: string): Promise<ArrayBuffer | null> {
    try {
      const url = new URL(`${BASE_URL}${this.libraryPrefix}/items/${annotationKey}/file`);

      const apiKey = this.getApiKey();
      if (!apiKey) return null;

      const response = await requestUrl({
        url: url.toString(),
        method: 'GET',
        headers: {
          'Zotero-API-Version': API_VERSION,
          'Zotero-API-Key': apiKey,
        },
        throw: false,
      });

      if (response.status === 200) {
        return response.arrayBuffer;
      }
      return null;
    } catch {
      return null;
    }
  }

  async patchItemTags(itemKey: string, tags: { tag: string }[], version: number): Promise<boolean> {
    try {
      const response = await this.request(
        `/items/${itemKey}`,
        {},
        {
          method: 'PATCH',
          body: JSON.stringify({ tags }),
          headers: {
            'If-Unmodified-Since-Version': String(version),
          },
        }
      );
      return response.status === 204 || response.status === 200;
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('409')) {
        console.warn(`[Zotero Connector] Version conflict patching tags for ${itemKey}, will retry next sync`);
        return false;
      }
      if (msg.includes('403')) {
        console.warn(`[Zotero Connector] No write permission for ${itemKey}, skipping tag push`);
        return false;
      }
      console.error(`[Zotero Connector] Failed to patch tags for ${itemKey}:`, e);
      return false;
    }
  }

  clearCollectionCache(): void {
    this.collectionCache.clear();
  }

  getCollectionName(key: string): string | undefined {
    return this.collectionCache.get(key);
  }
}
