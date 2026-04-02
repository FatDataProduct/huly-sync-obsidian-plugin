import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  type App,
} from "obsidian";

import { HulyApiClient } from "./huly-api";
import { VaultSyncService } from "./sync";
import {
  DEFAULT_SETTINGS,
  type ConnectionConfig,
  type HulyProject,
  type IssueNoteFileNameMode,
  type NoteStyle,
  type ProjectNoteFileNameMode,
  type ScheduledSyncStatus,
  type SyncProgress,
  type HulySyncSettings,
  type StoredProjectConfig,
  type SyncOptions,
} from "./types";

function projectFolderPreview(rootFolder: string, identifier: string): string {
  return normalizePath(`${rootFolder || "huly"}/${identifier}`);
}

function formatTimestamp(value: string | number | null): string | null {
  if (value === null) {
    return null;
  }

  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString();
}

export default class HulySyncPlugin extends Plugin {
  settings: HulySyncSettings = DEFAULT_SETTINGS;

  private readonly apiClient = new HulyApiClient();

  private readonly vaultSync = new VaultSyncService(this.app);

  private syncIntervalId: number | null = null;

  private nextScheduledSyncAt: number | null = null;

  private isSyncing = false;

  private settingsTab: HulySyncSettingTab | null = null;

  private syncProgress: SyncProgress = {
    active: false,
    phase: "idle",
    current: 0,
    total: 0,
    percentage: 0,
    message: "Idle",
  };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "huly-sync-refresh-projects",
      name: "Huly Sync: reload projects",
      callback: async () => {
        await this.refreshProjects();
      },
    });

    this.addCommand({
      id: "huly-sync-run-manual",
      name: "Huly Sync: sync now",
      callback: async () => {
        await this.runSync({
          reason: "manual",
        });
      },
    });

    this.settingsTab = new HulySyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.rescheduleSync();
  }

  onunload(): void {
    this.clearSyncInterval();
  }

  getConnectionConfig(): ConnectionConfig {
    return {
      hulyUrl: this.settings.hulyUrl,
      authMethod: this.settings.authMethod,
      email: this.settings.email,
      password: this.settings.password,
      token: this.settings.token,
      workspace: this.settings.workspace,
    };
  }

  getSelectedProjects(): HulyProject[] {
    return this.settings.projects
      .filter((project) => project.selected)
      .map((project) => ({
        id: project.id,
        identifier: project.identifier,
        name: project.name,
        description: project.description,
      }));
  }

  getSyncProgress(): SyncProgress {
    return this.syncProgress;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.projects = [...(this.settings.projects ?? [])].sort((left, right) =>
      left.identifier.localeCompare(right.identifier),
    );
  }

  getNextScheduledSyncAt(): number | null {
    return this.nextScheduledSyncAt;
  }

  async persistSettings(options?: { reschedule?: boolean }): Promise<void> {
    await this.saveData(this.settings);
    if (options?.reschedule) {
      this.rescheduleSync();
    }
  }

  async refreshProjects(): Promise<void> {
    new Notice("Huly Sync: loading projects...");

    const remoteProjects = await this.apiClient.fetchProjects(this.getConnectionConfig());
    const existingById = new Map(
      this.settings.projects.map((project) => [project.id, project] as const),
    );

    this.settings.projects = remoteProjects
      .map((project): StoredProjectConfig => {
        const existing = existingById.get(project.id);
        return {
          id: project.id,
          identifier: project.identifier,
          name: project.name,
          description: project.description,
          selected: existing?.selected ?? false,
        };
      })
      .sort((left, right) => left.identifier.localeCompare(right.identifier));

    await this.persistSettings();
    new Notice(`Huly Sync: loaded ${this.settings.projects.length} projects.`);
  }

  async runSync(options: SyncOptions): Promise<void> {
    if (this.isSyncing) {
      if (options.reason === "manual") {
        new Notice("Huly Sync: synchronization is already running.");
      } else {
        await this.recordScheduledSync("skipped", "Skipped: another sync is already running.");
      }
      return;
    }

    const selectedProjects = this.getSelectedProjects();
    if (selectedProjects.length === 0) {
      if (options.reason === "scheduled") {
        await this.recordScheduledSync("skipped", "Skipped: no Huly projects selected.");
        return;
      }

      throw new Error("Выберите хотя бы один проект Huly для синхронизации.");
    }

    this.isSyncing = true;
    try {
      this.setSyncProgress({
        active: true,
        phase: "fetch",
        current: 0,
        total: 0,
        percentage: 0,
        message: "Fetching data from Huly...",
      });

      const { components, issues, employees, milestones, issueTemplates, filesToken } =
        await this.apiClient.fetchProjectData(
        this.getConnectionConfig(),
        selectedProjects,
      );

      const totalWrites =
        selectedProjects.length +
        components.length +
        issues.length +
        employees.length +
        milestones.length +
        issueTemplates.length;
      this.setSyncProgress({
        active: true,
        phase: "write",
        current: 0,
        total: totalWrites,
        percentage: 0,
        message: `Fetched ${selectedProjects.length} projects, ${components.length} components, ${issues.length} issues, ${milestones.length} milestones, ${issueTemplates.length} templates, ${employees.length} employees.`,
      });

      const stats = await this.vaultSync.sync(
        this.settings,
        selectedProjects,
        components,
        issues,
        employees,
        milestones,
        issueTemplates,
        options,
        filesToken,
        (progress) => {
          this.setSyncProgress(progress);
        },
      );

      this.settings.lastSyncAt = new Date().toISOString();
      if (options.reason === "scheduled") {
        this.setScheduledSyncState("success", null);
      }
      await this.persistSettings();
      this.settingsTab?.display();

      const successMessage = `Synced ${stats.projectCount} projects, ${stats.componentCount} components, ${stats.issueCount} issues, ${stats.milestoneCount} milestones, ${stats.issueTemplateCount} templates and ${stats.employeeCount} employees.`;
      this.setSyncProgress({
        active: false,
        phase: "done",
        current:
          stats.projectCount +
          stats.componentCount +
          stats.issueCount +
          stats.milestoneCount +
          stats.issueTemplateCount +
          stats.employeeCount,
        total:
          stats.projectCount +
          stats.componentCount +
          stats.issueCount +
          stats.milestoneCount +
          stats.issueTemplateCount +
          stats.employeeCount,
        percentage: 100,
        message: successMessage,
      });

      if (options.reason === "manual") {
        new Notice(`Huly Sync: ${successMessage}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.reason === "scheduled") {
        this.setScheduledSyncState("error", message);
        await this.persistSettings();
        this.settingsTab?.display();
      }
      this.setSyncProgress({
        active: false,
        phase: "error",
        current: 0,
        total: 0,
        percentage: 0,
        message: `Sync failed: ${message}`,
      });
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  private clearSyncInterval(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    this.nextScheduledSyncAt = null;
  }

  private rescheduleSync(): void {
    this.clearSyncInterval();

    const minutes = this.settings.syncIntervalMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return;
    }

    const intervalMs = minutes * 60 * 1000;
    this.nextScheduledSyncAt = Date.now() + intervalMs;

    this.syncIntervalId = window.setInterval(() => {
      this.nextScheduledSyncAt = Date.now() + intervalMs;
      this.settingsTab?.display();
      void this.runSync({
        reason: "scheduled",
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Huly Sync scheduled error", error);
        new Notice(`Huly Sync scheduled sync failed: ${message}`);
      });
    }, intervalMs);
  }

  private setScheduledSyncState(
    status: ScheduledSyncStatus,
    message: string | null,
  ): void {
    this.settings.lastScheduledSyncAt = new Date().toISOString();
    this.settings.lastScheduledSyncStatus = status;
    this.settings.lastScheduledSyncMessage = message;
  }

  private async recordScheduledSync(
    status: ScheduledSyncStatus,
    message: string | null,
  ): Promise<void> {
    this.setScheduledSyncState(status, message);
    await this.persistSettings();
    this.settingsTab?.display();
  }

  private setSyncProgress(progress: SyncProgress): void {
    this.syncProgress = progress;
    this.settingsTab?.updateProgressDisplay();
  }
}

class HulySyncSettingTab extends PluginSettingTab {
  private progressMessageEl: HTMLElement | null = null;

  private progressBarEl: HTMLProgressElement | null = null;

  private progressMetaEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: HulySyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Huly Sync" });
    containerEl.createEl("h3", { text: "Synchronization" });

    this.progressMessageEl = containerEl.createEl("div", {
      cls: "huly-sync-progress-message",
    });
    this.progressBarEl = containerEl.createEl("progress", {
      cls: "huly-sync-progress-bar",
    });
    this.progressMetaEl = containerEl.createEl("div", {
      cls: "huly-sync-progress-meta huly-sync-muted",
    });
    this.updateProgressDisplay();

    new Setting(containerEl)
      .setName("Huly URL")
      .setDesc("Base URL of your Huly instance. For Huly Cloud use https://huly.app")
      .addText((text) =>
        text
          .setPlaceholder("https://huly.app")
          .setValue(this.plugin.settings.hulyUrl)
          .onChange(async (value) => {
            this.plugin.settings.hulyUrl = value.trim();
            await this.plugin.persistSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Workspace")
      .setDesc("Workspace slug used by Huly API authentication.")
      .addText((text) =>
        text
          .setPlaceholder("my-workspace")
          .setValue(this.plugin.settings.workspace)
          .onChange(async (value) => {
            this.plugin.settings.workspace = value.trim();
            await this.plugin.persistSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth method")
      .setDesc("Use email/password or a personal token.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("password", "Email + password")
          .addOption("token", "Token")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async (value) => {
            this.plugin.settings.authMethod = value as HulySyncSettings["authMethod"];
            await this.plugin.persistSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.authMethod === "password") {
      new Setting(containerEl)
        .setName("Email")
        .addText((text) =>
          text
            .setPlaceholder("user@example.com")
            .setValue(this.plugin.settings.email)
            .onChange(async (value) => {
              this.plugin.settings.email = value.trim();
              await this.plugin.persistSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Password")
        .setDesc("Stored in plugin data as-is.")
        .addText((text) => {
          text.inputEl.type = "password";
          return text.setValue(this.plugin.settings.password).onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.persistSettings();
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Token")
        .setDesc("Stored in plugin data as-is.")
        .addText((text) => {
          text.inputEl.type = "password";
          return text.setValue(this.plugin.settings.token).onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.persistSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Target folder")
      .setDesc("Root folder inside the vault where synced data will be written.")
      .addText((text) =>
        text
          .setPlaceholder("huly")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = normalizePath(value.trim() || "huly");
            await this.plugin.persistSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Workday hours")
      .setDesc(
        "Length of one workday used to convert Huly time fractions into real hours. " +
        "Example: `8` means `1.0 = 8 hours`.",
      )
      .addText((text) =>
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.workdayHours ?? DEFAULT_SETTINGS.workdayHours))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            this.plugin.settings.workdayHours =
              Number.isFinite(parsed) && parsed > 0
                ? parsed
                : DEFAULT_SETTINGS.workdayHours;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync interval in minutes")
      .setDesc("Scheduled sync refreshes selected projects. Set `0` to disable auto sync.")
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes = Number.isFinite(parsed)
              ? parsed
              : DEFAULT_SETTINGS.syncIntervalMinutes;
            await this.plugin.persistSettings({ reschedule: true });
            this.display();
          }),
      );

    const intervalMinutes = this.plugin.settings.syncIntervalMinutes;
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      containerEl.createEl("p", {
        text: "Auto sync: disabled",
        cls: "huly-sync-muted",
      });
    } else {
      containerEl.createEl("p", {
        text: `Auto sync: every ${intervalMinutes} minute(s)`,
        cls: "huly-sync-muted",
      });
    }

    const nextScheduledSyncAt = formatTimestamp(this.plugin.getNextScheduledSyncAt());
    if (nextScheduledSyncAt) {
      containerEl.createEl("p", {
        text: `Next scheduled sync: ${nextScheduledSyncAt}`,
        cls: "huly-sync-muted",
      });
    }

    if (this.plugin.settings.lastScheduledSyncAt) {
      const lastScheduledAt =
        formatTimestamp(this.plugin.settings.lastScheduledSyncAt) ??
        this.plugin.settings.lastScheduledSyncAt;
      const lastScheduledStatus = this.plugin.settings.lastScheduledSyncStatus;
      const lastScheduledMessage = this.plugin.settings.lastScheduledSyncMessage;
      const details = lastScheduledMessage ? ` (${lastScheduledMessage})` : "";

      containerEl.createEl("p", {
        text: `Last scheduled sync: ${lastScheduledAt} [${lastScheduledStatus}]${details}`,
        cls: "huly-sync-muted",
      });
    }

    containerEl.createEl("h3", { text: "Note appearance" });

    new Setting(containerEl)
      .setName("Note style")
      .setDesc(
        "Classic: plain markdown. Rich: multi-layout with sidebar, stats cards, " +
        "Dataview tables, Meta Bind widgets and visual status indicators.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("rich", "Rich (recommended)")
          .addOption("classic", "Classic")
          .setValue(this.plugin.settings.noteStyle ?? "rich")
          .onChange(async (value) => {
            this.plugin.settings.noteStyle = value as NoteStyle;
            await this.plugin.persistSettings();
            this.display();
          }),
      );

    if ((this.plugin.settings.noteStyle ?? "rich") === "rich") {
      new Setting(containerEl)
        .setName("Use Meta Bind")
        .setDesc(
          "Enable Meta Bind embeds, VIEW fields and action buttons in notes. " +
          "Requires the Meta Bind community plugin.",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.useMetaBind ?? true)
            .onChange(async (value) => {
              this.plugin.settings.useMetaBind = value;
              await this.plugin.persistSettings();
            }),
        );

      containerEl.createEl("p", {
        text: "Rich style recommended plugins: Meta Bind (interactive widgets), " +
          "Dataview (live task tables in project dashboards). " +
          "Install them from Settings \u2192 Community plugins \u2192 Browse.",
        cls: "huly-sync-muted",
      });
    }

    containerEl.createEl("h3", { text: "File naming" });

    new Setting(containerEl)
      .setName("Project note filename")
      .setDesc(
        "Choose how the main project note is named. Default keeps the current format: `TG-AU TG-Autoposting.md`.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("identifier-and-name", "Identifier + project name")
          .addOption("name-only", "Project name only")
          .setValue(
            this.plugin.settings.projectNoteFileNameMode ??
              DEFAULT_SETTINGS.projectNoteFileNameMode,
          )
          .onChange(async (value) => {
            this.plugin.settings.projectNoteFileNameMode = value as ProjectNoteFileNameMode;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Issue note filename")
      .setDesc(
        "Choose how issue files are named. Default keeps the current format: `TG-AU-100.md`.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("identifier-only", "Issue identifier only")
          .addOption("identifier-and-title", "Identifier + issue title")
          .setValue(
            this.plugin.settings.issueNoteFileNameMode ?? DEFAULT_SETTINGS.issueNoteFileNameMode,
          )
          .onChange(async (value) => {
            this.plugin.settings.issueNoteFileNameMode = value as IssueNoteFileNameMode;
            await this.plugin.persistSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Load projects from Huly using the current credentials.")
      .addButton((button) =>
        button.setButtonText("Reload projects").onClick(async () => {
          try {
            await this.plugin.refreshProjects();
            this.display();
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Huly Sync: ${message}`);
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("Sync now").setCta().onClick(async () => {
          try {
            await this.plugin.runSync({
              reason: "manual",
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Huly Sync: ${message}`);
          }
        }),
      );

    containerEl.createEl("h3", { text: "Projects" });

    if (this.plugin.settings.projects.length === 0) {
      containerEl.createEl("p", {
        text: "No projects loaded yet. Click “Reload projects” after filling in Huly credentials.",
        cls: "huly-sync-muted",
      });
    }

    for (const project of this.plugin.settings.projects) {
      new Setting(containerEl)
        .setName(`${project.identifier} - ${project.name}`.trim())
        .setDesc(
          `${project.description || "No description"}\nVault folder: ${projectFolderPreview(this.plugin.settings.targetFolder, project.identifier)}`,
        )
        .addToggle((toggle) =>
          toggle.setValue(project.selected).onChange(async (value) => {
            project.selected = value;
            await this.plugin.persistSettings();
          }),
        );
    }

    if (this.plugin.settings.lastSyncAt) {
      const lastSyncAt =
        formatTimestamp(this.plugin.settings.lastSyncAt) ?? this.plugin.settings.lastSyncAt;
      containerEl.createEl("p", {
        text: `Last sync: ${lastSyncAt}`,
        cls: "huly-sync-muted",
      });
    }
  }

  updateProgressDisplay(): void {
    if (!this.progressMessageEl || !this.progressBarEl || !this.progressMetaEl) {
      return;
    }

    const progress = this.plugin.getSyncProgress();
    this.progressMessageEl.setText(progress.message);

    if (progress.total > 0) {
      this.progressBarEl.max = progress.total;
      this.progressBarEl.value = Math.min(progress.current, progress.total);
      this.progressBarEl.removeClass("is-indeterminate");
    } else if (progress.phase === "fetch") {
      this.progressBarEl.max = 1;
      this.progressBarEl.value = 1;
      this.progressBarEl.addClass("is-indeterminate");
    } else {
      this.progressBarEl.max = 1;
      this.progressBarEl.value = progress.phase === "done" ? 1 : 0;
      this.progressBarEl.removeClass("is-indeterminate");
    }

    if (progress.active) {
      if (progress.phase === "fetch") {
        this.progressMetaEl.setText("Fetching data...");
      } else if (progress.phase === "download") {
        this.progressMetaEl.setText(
          `Downloading ${progress.current}/${progress.total} (${progress.percentage}%)`,
        );
      } else {
        this.progressMetaEl.setText(
          `${progress.current}/${progress.total} (${progress.percentage}%)`,
        );
      }
      return;
    }

    switch (progress.phase) {
      case "done":
        this.progressMetaEl.setText("Completed");
        break;
      case "error":
        this.progressMetaEl.setText("Failed");
        break;
      default:
        this.progressMetaEl.setText("Idle");
        break;
    }
  }
}
