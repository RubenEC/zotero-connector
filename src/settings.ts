import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ZoteroConnectorPlugin from './main';
import { ColorMapEntry, DEFAULT_COLOR_MAP } from './types';

export class ZoteroAutoSyncSettingTab extends PluginSettingTab {
  plugin: ZoteroConnectorPlugin;

  constructor(app: App, plugin: ZoteroConnectorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Authentication ──────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Authentication' });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your Zotero Web API key. Create one at zotero.org/settings/keys/new')
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.style.width = '100%';
        const currentKey = this.plugin.getApiKey();
        if (currentKey) {
          text.setValue(currentKey);
        }
        text.setPlaceholder('Enter API key')
          .onChange(async (value) => {
            this.plugin.setApiKey(value.trim());
          });
      });

    new Setting(containerEl)
      .setName('User ID')
      .setDesc('Your Zotero user ID (numeric). Found at zotero.org/settings/keys')
      .addText(text => text
        .setPlaceholder('Enter user ID')
        .setValue(this.plugin.settings.userId)
        .onChange(async (value) => {
          this.plugin.settings.userId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Library type')
      .setDesc('Choose between personal or group library')
      .addDropdown(dropdown => dropdown
        .addOption('user', 'User library')
        .addOption('group', 'Group library')
        .setValue(this.plugin.settings.libraryType)
        .onChange(async (value: 'user' | 'group') => {
          this.plugin.settings.libraryType = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.libraryType === 'group') {
      new Setting(containerEl)
        .setName('Group ID')
        .setDesc('The numeric group ID for group libraries')
        .addText(text => text
          .setPlaceholder('Enter group ID')
          .setValue(this.plugin.settings.groupId)
          .onChange(async (value) => {
            this.plugin.settings.groupId = value.trim();
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify your API key and user ID')
      .addButton(button => button
        .setButtonText('Test')
        .onClick(async () => {
          try {
            button.setButtonText('Testing...');
            button.setDisabled(true);
            const result = await this.plugin.testConnection();
            new Notice(result.ok ? `\u2705 ${result.message}` : `\u274C ${result.message}`);
          } catch (e) {
            new Notice(`\u274C Connection failed: ${(e as Error).message}`);
          } finally {
            button.setButtonText('Test');
            button.setDisabled(false);
          }
        }));

    // ── Sync Settings ───────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync Settings' });

    new Setting(containerEl)
      .setName('Sync tag')
      .setDesc('Only items with this Zotero tag will be synced')
      .addText(text => text
        .setPlaceholder('obsidian')
        .setValue(this.plugin.settings.syncTag)
        .onChange(async (value) => {
          this.plugin.settings.syncTag = value.trim() || 'obsidian';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auto-sync interval (minutes)')
      .setDesc('How often to auto-sync. Set to 0 to disable auto-sync.')
      .addSlider(slider => slider
        .setLimits(0, 120, 5)
        .setValue(this.plugin.settings.autoSyncIntervalMinutes)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.autoSyncIntervalMinutes = value;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        }));

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc('Folder in your vault where literature notes will be created')
      .addText(text => text
        .setPlaceholder('Zotero Literature Notes')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || 'Zotero Literature Notes';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('File name template')
      .setDesc('Template for note file names. Available: {{citekey}}, {{title}}, {{author}}, {{year}}, {{key}}')
      .addText(text => text
        .setPlaceholder('{{citekey}}')
        .setValue(this.plugin.settings.fileNameTemplate)
        .onChange(async (value) => {
          this.plugin.settings.fileNameTemplate = value.trim() || '{{citekey}}';
          await this.plugin.saveSettings();
        }));

    // ── Template Settings ───────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Template Settings' });

    new Setting(containerEl)
      .setName('Note template file')
      .setDesc('Path to a .md template file in your vault (e.g. "Templates/zotero.md"). Uses {{placeholders}} for substitution. Leave empty for built-in default.')
      .addText(text => text
        .setPlaceholder('Templates/zotero.md')
        .setValue(this.plugin.settings.templatePath)
        .onChange(async (value) => {
          this.plugin.settings.templatePath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Long note cutoff (words)')
      .setDesc('Minimum word count for a Zotero note to appear in the notes callout')
      .addSlider(slider => slider
        .setLimits(5, 100, 5)
        .setValue(this.plugin.settings.longNoteCutoff)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.longNoteCutoff = value;
          await this.plugin.saveSettings();
        }));

    // ── Color Map ───────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Color Map' });
    containerEl.createEl('p', {
      text: 'Map annotation highlight colors to section headings. Order determines display order.',
      cls: 'setting-item-description',
    });

    const colorMapContainer = containerEl.createDiv('color-map-container');
    this.renderColorMap(colorMapContainer);

    new Setting(containerEl)
      .addButton(button => button
        .setButtonText('Add color')
        .onClick(async () => {
          this.plugin.settings.colorMap.push({
            color: '#000000',
            colorName: 'Custom',
            heading: 'Custom heading',
            symbol: '<mark style="background: #000000">\u2B1B</mark>',
          });
          await this.plugin.saveSettings();
          this.display();
        }))
      .addButton(button => button
        .setButtonText('Reset to defaults')
        .onClick(async () => {
          this.plugin.settings.colorMap = [...DEFAULT_COLOR_MAP];
          await this.plugin.saveSettings();
          this.display();
        }));

    // ── Image Annotations ─────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Image Annotations' });

    new Setting(containerEl)
      .setName('Image output folder')
      .setDesc('Vault folder where annotation images are saved (e.g. Maintenance/Attachments)')
      .addText(text => text
        .setPlaceholder('Maintenance/Attachments')
        .setValue(this.plugin.settings.imageOutputFolder)
        .onChange(async (value) => {
          this.plugin.settings.imageOutputFolder = value.trim() || 'Maintenance/Attachments';
          await this.plugin.saveSettings();
        }));

    const hostname = require('os').hostname();
    const currentCacheDir = this.plugin.settings.zoteroCacheDirs[hostname] || '';

    new Setting(containerEl)
      .setName(`Zotero annotation cache path (${hostname})`)
      .setDesc(
        'Local path to Zotero\'s annotation image cache. ' +
        'This setting is stored per device. ' +
        'E.g. C:\\Users\\Public\\Zotero\\cache\\library or ~/Zotero/cache/library'
      )
      .addText(text => text
        .setPlaceholder('Leave empty to use Web API only')
        .setValue(currentCacheDir)
        .onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            this.plugin.settings.zoteroCacheDirs[hostname] = trimmed;
          } else {
            delete this.plugin.settings.zoteroCacheDirs[hostname];
          }
          await this.plugin.saveSettings();
        }));

    // ── Advanced ────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Preserve user content')
      .setDesc('Keep the "## Comments" section intact when re-syncing notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.preserveUserContent)
        .onChange(async (value) => {
          this.plugin.settings.preserveUserContent = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Mark orphaned notes')
      .setDesc('Add "zotero-orphaned: true" to frontmatter if item is no longer found in Zotero')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.markOrphaned)
        .onChange(async (value) => {
          this.plugin.settings.markOrphaned = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Clear sync cache')
      .setDesc('Forces a full re-sync on next sync. Use if notes appear out of date.')
      .addButton(button => button
        .setButtonText('Clear cache')
        .setWarning()
        .onClick(async () => {
          await this.plugin.clearSyncCache();
          new Notice('Sync cache cleared. Next sync will be a full sync.');
        }));
  }

  private renderColorMap(container: HTMLElement): void {
    for (let i = 0; i < this.plugin.settings.colorMap.length; i++) {
      const entry = this.plugin.settings.colorMap[i];

      const setting = new Setting(container)
        .setClass('color-map-entry');

      setting.addColorPicker(picker => picker
        .setValue(entry.color)
        .onChange(async (value) => {
          entry.color = value;
          entry.symbol = `<mark style="background: ${value}">${this.getEmojiForColor(value)}</mark>`;
          await this.plugin.saveSettings();
        }));

      setting.addText(text => text
        .setPlaceholder('Color name')
        .setValue(entry.colorName)
        .onChange(async (value) => {
          entry.colorName = value;
          await this.plugin.saveSettings();
        }));

      setting.addText(text => text
        .setPlaceholder('Section heading')
        .setValue(entry.heading)
        .onChange(async (value) => {
          entry.heading = value;
          await this.plugin.saveSettings();
        }));

      if (i > 0) {
        setting.addExtraButton(button => button
          .setIcon('arrow-up')
          .setTooltip('Move up')
          .onClick(async () => {
            const temp = this.plugin.settings.colorMap[i - 1];
            this.plugin.settings.colorMap[i - 1] = entry;
            this.plugin.settings.colorMap[i] = temp;
            await this.plugin.saveSettings();
            this.display();
          }));
      }

      if (i < this.plugin.settings.colorMap.length - 1) {
        setting.addExtraButton(button => button
          .setIcon('arrow-down')
          .setTooltip('Move down')
          .onClick(async () => {
            const temp = this.plugin.settings.colorMap[i + 1];
            this.plugin.settings.colorMap[i + 1] = entry;
            this.plugin.settings.colorMap[i] = temp;
            await this.plugin.saveSettings();
            this.display();
          }));
      }

      setting.addExtraButton(button => button
        .setIcon('trash')
        .setTooltip('Remove')
        .onClick(async () => {
          this.plugin.settings.colorMap.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
    }
  }

  private getEmojiForColor(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    if (r > 200 && g > 200 && b < 100) return '\u{1F7E1}';
    if (r > 200 && g < 100 && b < 100) return '\u{1F534}';
    if (r < 100 && g > 200 && b < 100) return '\u{1F7E2}';
    if (r < 100 && g < 100 && b > 200) return '\u{1F535}';
    if (r > 200 && g > 100 && b < 100) return '\u{1F7E0}';
    if (r > 150 && g > 150 && b > 150) return '\u26AA';
    if (r > 150 && g < 100 && b > 150) return '\u{1F7E3}';
    return '\u2B1B';
  }
}
