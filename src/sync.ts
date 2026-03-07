import {
  normalizePath,
  TFile,
  type App,
  type Vault,
} from "obsidian";

import type {
  HulyAttachment,
  HulyComment,
  HulyComponent,
  HulyIssue,
  HulyIssueParent,
  HulyProject,
  SyncProgress,
  HulySyncSettings,
  SyncOptions,
  SyncStats,
} from "./types";
import { mapLimit } from "./async";

const WRITE_CONCURRENCY = 8;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizePathPart(value: string): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|#^[\]]+/g, "-");
  return cleaned || "untitled";
}

function joinVaultPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.trim().length > 0).join("/"));
}

function toIsoDate(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function yamlScalar(name: string, value: string | number | boolean | null): string {
  if (value === null) {
    return `${name}: null`;
  }

  return `${name}: ${JSON.stringify(value)}`;
}

function yamlList(name: string, values: string[]): string {
  if (values.length === 0) {
    return `${name}: []`;
  }

  return [name + ":", ...values.map((value) => `  - ${JSON.stringify(value)}`)].join(
    "\n",
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function withoutExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function wikilink(path: string, alias?: string): string {
  const target = withoutExtension(path);
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
}

function projectTag(project: HulyProject): string {
  return `huly/project/${slugify(project.name || project.identifier)}`;
}

function statusTag(statusName: string): string {
  return `huly/status/${slugify(statusName)}`;
}

function labelTags(labels: string[]): string[] {
  return labels.map((label) => `huly/label/${slugify(label)}`);
}

function componentTag(componentName: string | null): string[] {
  if (!componentName) {
    return [];
  }

  return [`huly/component/${slugify(componentName)}`];
}

function projectFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(rootFolder, sanitizePathPart(project.identifier || project.name));
}

function projectNotePath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(
    projectFolderPath(rootFolder, project),
    `${sanitizePathPart(`${project.identifier} ${project.name}`.trim())}.md`,
  );
}

function projectTasksFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "tasks");
}

function projectComponentsFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "components");
}

function issueNotePath(rootFolder: string, project: HulyProject, issue: HulyIssue): string {
  return joinVaultPath(
    projectTasksFolderPath(rootFolder, project),
    `${sanitizePathPart(issue.identifier)}.md`,
  );
}

function componentNotePath(
  rootFolder: string,
  project: HulyProject,
  component: HulyComponent,
): string {
  return joinVaultPath(
    projectComponentsFolderPath(rootFolder, project),
    `${sanitizePathPart(component.label)}.md`,
  );
}

function renderLinksSection(title: string, links: string[]): string[] {
  if (links.length === 0) {
    return [title, "", "- None"];
  }

  return [title, "", ...links.map((link) => `- ${link}`)];
}

function humanFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function attachmentLinks(attachments: HulyAttachment[]): string[] {
  return [...attachments]
    .sort((left, right) => compareStrings(left.name, right.name))
    .map((attachment) => {
      const meta = [attachment.mimeType, humanFileSize(attachment.size)]
        .filter((part) => part.trim().length > 0)
        .join(", ");
      return `[${attachment.name}](${attachment.url})${meta ? ` (${meta})` : ""}`;
    });
}

function renderCommentsSection(comments: HulyComment[]): string[] {
  if (comments.length === 0) {
    return ["## Comments", "", "_No comments_"];
  }

  return [
    "## Comments",
    "",
    ...[...comments]
      .sort((left, right) => left.createdAt - right.createdAt || left.updatedAt - right.updatedAt)
      .flatMap((comment, index) => {
        const header = `### ${index + 1}. ${comment.authorName} - ${toIsoDate(comment.updatedAt) ?? "Unknown date"}`;
        const attachmentSection =
          comment.attachments.length > 0
            ? ["", ...renderLinksSection("Attachments", attachmentLinks(comment.attachments))]
            : [];

        return [
          header,
          "",
          comment.body.trim() || "_Empty comment_",
          ...attachmentSection,
          "",
        ];
      }),
  ];
}

function renderProjectNote(
  project: HulyProject,
  componentLinks: string[],
  issueLinks: string[],
): string {
  const tags = unique(["huly", "huly/type/project", projectTag(project)]);
  const body = [
    "---",
    yamlScalar("huly_type", "project"),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_name", project.name),
    yamlList("tags", tags),
    "---",
    "",
    `# ${project.identifier} ${project.name}`.trim(),
    "",
    project.description || "No project description.",
    "",
    ...renderLinksSection("## Components", componentLinks),
    "",
    ...renderLinksSection("## Tasks", issueLinks),
  ];

  return body.join("\n");
}

function renderComponentNote(
  project: HulyProject,
  component: HulyComponent,
  projectNoteLink: string,
): string {
  const tags = unique([
    "huly",
    "huly/type/component",
    projectTag(project),
    ...componentTag(component.label),
  ]);

  return [
    "---",
    yamlScalar("huly_type", "component"),
    yamlScalar("huly_component_id", component.id),
    yamlScalar("huly_component_name", component.label),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_updated_at", toIsoDate(component.modifiedOn)),
    yamlList("tags", tags),
    "---",
    "",
    `# ${component.label}`,
    "",
    "## Links",
    "",
    `- Project: ${wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim())}`,
    "",
    ...renderLinksSection("## Attachments", attachmentLinks(component.attachments)),
    "",
    component.description || "No component description.",
    "",
    ...renderCommentsSection(component.comments),
  ].join("\n");
}

function parentIssueLinks(
  parents: HulyIssueParent[],
  issuePathsById: Map<string, string>,
): string[] {
  return [...parents]
    .sort((left, right) => compareStrings(left.identifier, right.identifier))
    .map((parent) => {
      const path = issuePathsById.get(parent.parentId);
      const alias = `${parent.identifier} ${parent.title}`.trim();
      return path ? wikilink(path, alias) : alias;
    });
}

function renderIssueNote(
  project: HulyProject,
  issue: HulyIssue,
  projectNoteLink: string,
  componentNoteLink: string | null,
  parentLinks: string[],
): string {
  const sortedLabels = [...issue.labels].sort(compareStrings);
  const tags = unique([
    "huly",
    "huly/type/issue",
    projectTag(project),
    statusTag(issue.statusName),
    ...componentTag(issue.componentName),
    ...labelTags(sortedLabels),
  ]);

  return [
    "---",
    yamlScalar("huly_type", "issue"),
    yamlScalar("huly_issue_id", issue.id),
    yamlScalar("huly_issue_identifier", issue.identifier),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_name", project.name),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_status", issue.statusName),
    yamlScalar("huly_priority", issue.priority),
    yamlScalar("huly_assignee", issue.assigneeName),
    yamlScalar("huly_component", issue.componentName),
    yamlScalar(
      "huly_component_note",
      componentNoteLink ? withoutExtension(componentNoteLink) : null,
    ),
    yamlScalar("huly_due_date", toIsoDate(issue.dueDate)),
    yamlScalar("huly_updated_at", toIsoDate(issue.modifiedOn)),
    yamlScalar("huly_is_closed", issue.isClosed),
    yamlList("huly_labels", sortedLabels),
    yamlList("tags", tags),
    "---",
    "",
    `# ${issue.identifier} ${issue.title}`.trim(),
    "",
    "## Links",
    "",
    `- Project: ${wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim())}`,
    `- Component: ${
      componentNoteLink && issue.componentName
        ? wikilink(componentNoteLink, issue.componentName)
        : issue.componentName ?? "None"
    }`,
    ...(parentLinks.length > 0
      ? parentLinks.map((link) => `- Parent: ${link}`)
      : ["- Parent: None"]),
    "",
    ...renderLinksSection("## Attachments", attachmentLinks(issue.attachments)),
    "",
    "## Metadata",
    "",
    `- Status: ${issue.statusName}`,
    `- Priority: ${issue.priority}`,
    `- Assignee: ${issue.assigneeName ?? "Unassigned"}`,
    `- Due date: ${toIsoDate(issue.dueDate) ?? "Not set"}`,
    sortedLabels.length > 0 ? `- Labels: ${sortedLabels.join(", ")}` : "- Labels: None",
    "",
    "## Description",
    "",
    issue.description.trim() || "_No description_",
    "",
    ...renderCommentsSection(issue.comments),
  ].join("\n");
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (normalized === ".") {
    return;
  }

  const existing = vault.getAbstractFileByPath(normalized);
  if (existing) {
    return;
  }

  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const currentPath = parts.slice(0, index + 1).join("/");
    if (!vault.getAbstractFileByPath(currentPath)) {
      await vault.createFolder(currentPath);
    }
  }
}

async function upsertFile(vault: Vault, path: string, content: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    const currentContent = await vault.cachedRead(existing);
    if (currentContent === content) {
      return;
    }

    await vault.modify(existing, content);
    return;
  }

  await vault.create(path, content);
}

async function deleteFileIfExists(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.delete(existing);
  }
}

export class VaultSyncService {
  constructor(private readonly app: App) {}

  async sync(
    settings: HulySyncSettings,
    projects: HulyProject[],
    components: HulyComponent[],
    issues: HulyIssue[],
    _options: SyncOptions,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncStats> {
    const rootFolder = settings.targetFolder.trim() || "huly";
    await ensureFolder(this.app.vault, rootFolder);

    const componentsByProject = new Map<string, HulyComponent[]>();
    const issuesByProject = new Map<string, HulyIssue[]>();
    const issuePathsById = new Map<string, string>();
    const componentPathsById = new Map<string, string>();
    const totalWrites = projects.length + components.length + issues.length;
    let completedWrites = 0;

    const reportWriteProgress = (message: string): void => {
      onProgress?.({
        active: true,
        phase: "write",
        current: completedWrites,
        total: totalWrites,
        percentage:
          totalWrites > 0 ? Math.round((completedWrites / totalWrites) * 100) : 100,
        message,
      });
    };

    for (const component of components) {
      const existing = componentsByProject.get(component.projectId) ?? [];
      existing.push(component);
      componentsByProject.set(component.projectId, existing);
    }

    for (const issue of issues) {
      const existing = issuesByProject.get(issue.projectId) ?? [];
      existing.push(issue);
      issuesByProject.set(issue.projectId, existing);
    }

    for (const project of projects) {
      for (const component of componentsByProject.get(project.id) ?? []) {
        componentPathsById.set(component.id, componentNotePath(rootFolder, project, component));
      }

      for (const issue of issuesByProject.get(project.id) ?? []) {
        issuePathsById.set(issue.id, issueNotePath(rootFolder, project, issue));
      }
    }

    for (const project of projects) {
      const projectFolder = projectFolderPath(rootFolder, project);
      const tasksFolder = projectTasksFolderPath(rootFolder, project);
      const componentsFolder = projectComponentsFolderPath(rootFolder, project);
      const projectNote = projectNotePath(rootFolder, project);
      const legacyProjectNote = joinVaultPath(projectFolder, "_project.md");
      const projectComponents = componentsByProject.get(project.id) ?? [];
      const projectIssues = issuesByProject.get(project.id) ?? [];

      await ensureFolder(this.app.vault, projectFolder);
      await ensureFolder(this.app.vault, tasksFolder);
      await ensureFolder(this.app.vault, componentsFolder);
      if (legacyProjectNote !== projectNote) {
        await deleteFileIfExists(this.app.vault, legacyProjectNote);
      }

      const componentLinks = [...projectComponents]
        .sort((left, right) => compareStrings(left.label, right.label))
        .map((component) =>
          wikilink(
            componentPathsById.get(component.id) ?? componentNotePath(rootFolder, project, component),
            component.label,
          ),
        );
      const issueLinks = [...projectIssues]
        .sort((left, right) => compareStrings(left.identifier, right.identifier))
        .map((issue) =>
          wikilink(
            issuePathsById.get(issue.id) ?? issueNotePath(rootFolder, project, issue),
            `${issue.identifier} ${issue.title}`.trim(),
          ),
        );

      await upsertFile(
        this.app.vault,
        projectNote,
        renderProjectNote(project, componentLinks, issueLinks),
      );
      completedWrites += 1;
      reportWriteProgress(`Project note: ${project.identifier}`);

      await mapLimit(projectComponents, WRITE_CONCURRENCY, async (component) => {
        const componentPath =
          componentPathsById.get(component.id) ?? componentNotePath(rootFolder, project, component);
        await upsertFile(
          this.app.vault,
          componentPath,
          renderComponentNote(project, component, projectNote),
        );
        completedWrites += 1;
        reportWriteProgress(`Component: ${project.identifier} / ${component.label}`);
      });

      await mapLimit(projectIssues, WRITE_CONCURRENCY, async (issue) => {
        const issuePath =
          issuePathsById.get(issue.id) ?? issueNotePath(rootFolder, project, issue);
        const componentNoteLink = issue.componentId
          ? componentPathsById.get(issue.componentId) ?? null
          : null;
        const linksToParents = parentIssueLinks(issue.parents, issuePathsById);

        await upsertFile(
          this.app.vault,
          issuePath,
          renderIssueNote(
            project,
            issue,
            projectNote,
            componentNoteLink,
            linksToParents,
          ),
        );
        completedWrites += 1;
        reportWriteProgress(`Issue: ${issue.identifier}`);
      });
    }

    return {
      projectCount: projects.length,
      componentCount: components.length,
      issueCount: issues.length,
    };
  }
}
