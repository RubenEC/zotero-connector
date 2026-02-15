import { ZoteroAutoSyncSettings } from '../types';

export class VersionTracker {
  private settings: ZoteroAutoSyncSettings;
  private saveCallback: () => Promise<void>;

  constructor(settings: ZoteroAutoSyncSettings, saveCallback: () => Promise<void>) {
    this.settings = settings;
    this.saveCallback = saveCallback;
  }

  updateSettings(settings: ZoteroAutoSyncSettings): void {
    this.settings = settings;
  }

  getLibraryVersion(): number {
    return this.settings.lastSyncVersion;
  }

  async setLibraryVersion(version: number): Promise<void> {
    this.settings.lastSyncVersion = version;
    await this.saveCallback();
  }

  getItemVersion(itemKey: string): number | undefined {
    return this.settings.itemVersions[itemKey];
  }

  isItemChanged(itemKey: string, newVersion: number): boolean {
    const stored = this.settings.itemVersions[itemKey];
    return stored === undefined || stored < newVersion;
  }

  async setItemVersion(itemKey: string, version: number): Promise<void> {
    this.settings.itemVersions[itemKey] = version;
    await this.saveCallback();
  }

  async clearAll(): Promise<void> {
    this.settings.lastSyncVersion = 0;
    this.settings.itemVersions = {};
    await this.saveCallback();
  }
}
