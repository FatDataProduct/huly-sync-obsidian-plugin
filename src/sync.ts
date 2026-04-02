import {
  normalizePath,
  requestUrl,
  TFile,
  type App,
  type Vault,
} from "obsidian";
import filenamify from "filenamify/browser";

import type {
  HulyAttachment,
  HulyComment,
  HulyComponent,
  HulyEmployeeProfile,
  HulyIssue,
  HulyIssueHistoryEntry,
  HulyIssueParent,
  HulyIssueTemplate,
  HulyMilestone,
  IssueNoteFileNameMode,
  HulyProject,
  HulyTimeReport,
  NoteStyle,
  ProjectNoteFileNameMode,
  SyncProgress,
  HulySyncSettings,
  SyncOptions,
  SyncStats,
} from "./types";
import { mapLimit } from "./async";

interface NoteRenderOptions {
  noteStyle: NoteStyle;
  useMetaBind: boolean;
  rootFolder: string;
  hulyUrl: string;
  workspace: string;
  employeePathsByRef: ReadonlyMap<string, string>;
}

const WRITE_CONCURRENCY = 8;
const DEFAULT_WORKDAY_HOURS = 8;
let activeWorkdayHours = DEFAULT_WORKDAY_HOURS;

type YamlScalarValue = string | number | boolean | null;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizePathPart(value: string, fallback = "untitled"): string {
  const cleaned = filenamify(value.trim().replace(/\s+/g, " "), {
    replacement: "-",
  }).trim();
  return cleaned || fallback;
}

function joinVaultPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.trim().length > 0).join("/"));
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function hulyIssueUrl(opts: NoteRenderOptions, issue: HulyIssue): string | null {
  const baseUrl = normalizeBaseUrl(opts.hulyUrl);
  const workspace = opts.workspace.trim();
  const identifier = issue.identifier.trim();

  if (!baseUrl || !workspace || !identifier) {
    return null;
  }

  return `${baseUrl}/workbench/${encodeURIComponent(workspace)}/tracker/${encodeURIComponent(identifier)}`;
}

function toIsoDate(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function toDateOnlyString(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 10);
}

function formatDateRange(startDate: number | null, dueDate: number | null): string | null {
  const start = toDateOnlyString(startDate);
  const end = toDateOnlyString(dueDate);
  if (start && end && start !== end) {
    return `${start} -> ${end}`;
  }
  return start ?? end;
}

function yamlScalarValue(value: YamlScalarValue): string {
  if (value === null) {
    return "null";
  }

  return JSON.stringify(value);
}

function yamlScalar(name: string, value: YamlScalarValue): string {
  return `${name}: ${yamlScalarValue(value)}`;
}

function yamlList(name: string, values: string[]): string {
  if (values.length === 0) {
    return `${name}: []`;
  }

  return [name + ":", ...values.map((value) => `  - ${yamlScalarValue(value)}`)].join(
    "\n",
  );
}

function yamlObjectList(name: string, values: Record<string, YamlScalarValue>[]): string {
  if (values.length === 0) {
    return `${name}: []`;
  }

  return [
    name + ":",
    ...values.flatMap((value) => {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        return ["  - {}"];
      }

      return entries.map(([key, entryValue], index) =>
        index === 0
          ? `  - ${key}: ${yamlScalarValue(entryValue)}`
          : `    ${key}: ${yamlScalarValue(entryValue)}`,
      );
    }),
  ].join("\n");
}

function formatDuration(duration: number | null | undefined): string {
  if (duration === null || duration === undefined) {
    return "Not set";
  }

  if (duration <= 0) {
    return "0m";
  }

  const totalMinutes = Math.round(duration / 60000);
  const workdayMinutes = Math.max(1, Math.round(activeWorkdayHours * 60));
  const days = Math.floor(totalMinutes / workdayMinutes);
  const hours = Math.floor((totalMinutes % workdayMinutes) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(" ");
}

function formatDurationShort(duration: number): string {
  return formatDuration(duration);
}

function roundMetric(value: number, precision = 2): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function durationToHours(duration: number): number {
  return roundMetric(duration / (60 * 60 * 1000));
}

function durationToMinutes(duration: number): number {
  return Math.round(duration / (60 * 1000));
}

function durationToDays(duration: number): number {
  return roundMetric(duration / (Math.max(1, activeWorkdayHours) * 60 * 60 * 1000));
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dueInDays(timestamp: number | null): number | null {
  if (timestamp === null) {
    return null;
  }

  const today = startOfLocalDay(Date.now());
  const due = startOfLocalDay(timestamp);
  return Math.round((due - today) / (24 * 60 * 60 * 1000));
}

function timeProgressPct(estimation: number, reported: number): number | null {
  if (estimation <= 0) {
    return reported > 0 ? 100 : null;
  }

  return roundMetric((reported / estimation) * 100);
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

function fileStem(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDirectChildMarkdownFile(path: string, folderPath: string): boolean {
  const normalizedFolder = normalizePath(folderPath);
  const folderPrefix = `${normalizedFolder}/`;
  if (!path.startsWith(folderPrefix) || !path.toLowerCase().endsWith(".md")) {
    return false;
  }

  return !path.slice(folderPrefix.length).includes("/");
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

function milestoneTag(milestoneLabel: string | null): string[] {
  if (!milestoneLabel) {
    return [];
  }

  return [`huly/milestone/${slugify(milestoneLabel)}`];
}

function projectDisplayName(project: HulyProject): string {
  const name = project.name.trim();
  const identifier = project.identifier.trim();

  return name || identifier || "Untitled project";
}

function projectHeading(project: HulyProject): string {
  return `${project.identifier} ${project.name}`.trim() || projectDisplayName(project);
}

function projectFolderName(project: HulyProject): string {
  return sanitizePathPart(project.identifier || project.name, "untitled-project");
}

function projectNoteBaseName(
  project: HulyProject,
  mode: ProjectNoteFileNameMode,
): string {
  return mode === "name-only" ? projectDisplayName(project) : projectHeading(project);
}

function projectNoteFileName(
  project: HulyProject,
  mode: ProjectNoteFileNameMode,
): string {
  return `${sanitizePathPart(projectNoteBaseName(project, mode), "project")}.md`;
}

function issueNoteBaseName(issue: HulyIssue, mode: IssueNoteFileNameMode): string {
  const title = issue.title.trim();
  if (mode === "identifier-and-title" && title.length > 0) {
    return `${issue.identifier} ${title}`;
  }

  return issue.identifier;
}

function issueNoteFileName(issue: HulyIssue, mode: IssueNoteFileNameMode): string {
  return `${sanitizePathPart(issueNoteBaseName(issue, mode), issue.identifier || "issue")}.md`;
}

function projectNoteCandidateStems(project: HulyProject): Set<string> {
  return new Set([
    sanitizePathPart(projectNoteBaseName(project, "identifier-and-name"), "project"),
    sanitizePathPart(projectNoteBaseName(project, "name-only"), "project"),
    "_project",
  ]);
}

function issueNoteCandidateStems(issue: HulyIssue): Set<string> {
  return new Set([
    sanitizePathPart(issueNoteBaseName(issue, "identifier-only"), issue.identifier || "issue"),
    sanitizePathPart(
      issueNoteBaseName(issue, "identifier-and-title"),
      issue.identifier || "issue",
    ),
  ]);
}

function milestoneNoteCandidateStems(milestone: HulyMilestone): Set<string> {
  return new Set([
    sanitizePathPart(`${milestone.label} ${milestone.id.slice(-8)}`, "milestone"),
    sanitizePathPart(milestone.label, "milestone"),
  ]);
}

function issueTemplateNoteCandidateStems(template: HulyIssueTemplate): Set<string> {
  return new Set([
    sanitizePathPart(`${template.title} ${template.id.slice(-8)}`, "template"),
    sanitizePathPart(template.title, "template"),
  ]);
}

function projectFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(rootFolder, projectFolderName(project));
}

function projectNotePath(
  rootFolder: string,
  project: HulyProject,
  mode: ProjectNoteFileNameMode,
): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), projectNoteFileName(project, mode));
}

function projectTasksFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "tasks");
}

function projectComponentsFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "components");
}

function projectMilestonesFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "milestones");
}

function projectIssueTemplatesFolderPath(rootFolder: string, project: HulyProject): string {
  return joinVaultPath(projectFolderPath(rootFolder, project), "issue-templates");
}

function milestoneNoteFileName(milestone: HulyMilestone): string {
  return `${sanitizePathPart(`${milestone.label} ${milestone.id.slice(-8)}`, "milestone")}.md`;
}

function milestoneNotePath(
  rootFolder: string,
  project: HulyProject,
  milestone: HulyMilestone,
): string {
  return joinVaultPath(
    projectMilestonesFolderPath(rootFolder, project),
    milestoneNoteFileName(milestone),
  );
}

function issueTemplateNoteFileName(template: HulyIssueTemplate): string {
  return `${sanitizePathPart(`${template.title} ${template.id.slice(-8)}`, "template")}.md`;
}

function issueTemplateNotePath(
  rootFolder: string,
  project: HulyProject,
  template: HulyIssueTemplate,
): string {
  return joinVaultPath(
    projectIssueTemplatesFolderPath(rootFolder, project),
    issueTemplateNoteFileName(template),
  );
}

function issueNotePath(
  rootFolder: string,
  project: HulyProject,
  issue: HulyIssue,
  mode: IssueNoteFileNameMode,
): string {
  return joinVaultPath(projectTasksFolderPath(rootFolder, project), issueNoteFileName(issue, mode));
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

function employeeFolderPath(rootFolder: string): string {
  return joinVaultPath(rootFolder, "employees");
}

function employeeStableKey(employee: HulyEmployeeProfile): string {
  return sanitizePathPart(employee.personUuid ?? employee.personRef, "employee");
}

function employeeDisplayStem(employee: HulyEmployeeProfile): string {
  return sanitizePathPart(employee.displayName, employeeStableKey(employee));
}

function employeeLegacyStem(employee: HulyEmployeeProfile): string {
  return sanitizePathPart(
    `${employee.displayName} ${employeeStableKey(employee)}`,
    employeeStableKey(employee),
  );
}

function employeeNoteFileName(employee: HulyEmployeeProfile, collisionIndex = 0): string {
  const suffix = collisionIndex > 0 ? ` ${collisionIndex + 1}` : "";
  return `${employeeDisplayStem(employee)}${suffix}.md`;
}

function buildEmployeeNotePaths(
  rootFolder: string,
  employees: HulyEmployeeProfile[],
): ReadonlyMap<string, string> {
  const sortedEmployees = [...employees].sort(
    (left, right) =>
      compareStrings(left.displayName, right.displayName) ||
      compareStrings(employeeStableKey(left), employeeStableKey(right)),
  );
  const totalsByStem = new Map<string, number>();
  for (const employee of sortedEmployees) {
    const stem = employeeDisplayStem(employee);
    totalsByStem.set(stem, (totalsByStem.get(stem) ?? 0) + 1);
  }

  const countsByStem = new Map<string, number>();
  const pathsByRef = new Map<string, string>();
  for (const employee of sortedEmployees) {
    const stem = employeeDisplayStem(employee);
    const nextCount = (countsByStem.get(stem) ?? 0) + 1;
    countsByStem.set(stem, nextCount);
    const collisionIndex = (totalsByStem.get(stem) ?? 0) > 1 ? nextCount - 1 : 0;
    pathsByRef.set(
      employee.personRef,
      joinVaultPath(employeeFolderPath(rootFolder), employeeNoteFileName(employee, collisionIndex)),
    );
  }

  return pathsByRef;
}

function frontmatterScalar(content: string, key: string): string | null {
  if (!content.startsWith("---\n")) {
    return null;
  }

  const frontmatterEnd = content.indexOf("\n---\n", 4);
  if (frontmatterEnd === -1) {
    return null;
  }

  const frontmatter = content.slice(4, frontmatterEnd);
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  if (!match) {
    return null;
  }

  const captured = match[1];
  if (captured === undefined) {
    return null;
  }

  const rawValue = captured.trim();
  if (rawValue.length === 0 || rawValue === "null") {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return typeof parsed === "string" ? parsed : parsed === null ? null : String(parsed);
  } catch {
    return rawValue.replace(/^['"]|['"]$/g, "");
  }
}

async function fileMatchesEmployeeIdentity(
  vault: Vault,
  file: TFile,
  employee: HulyEmployeeProfile,
): Promise<boolean> {
  const content = await vault.cachedRead(file);
  return (
    frontmatterScalar(content, "huly_person_ref") === employee.personRef ||
    frontmatterScalar(content, "huly_employee_ref") === employee.employeeRef ||
    frontmatterScalar(content, "huly_person_uuid") === employee.personUuid
  );
}

async function findExistingEmployeeNote(
  vault: Vault,
  employeesFolder: string,
  employee: HulyEmployeeProfile,
  targetPath: string,
): Promise<TFile | null> {
  const stableKey = employeeStableKey(employee);
  const displayStem = employeeDisplayStem(employee);
  const legacyStem = employeeLegacyStem(employee);
  const targetStem = fileStem(targetPath);
  const candidates = vault
    .getMarkdownFiles()
    .filter((file) => isDirectChildMarkdownFile(file.path, employeesFolder))
    .filter((file) => file.path !== targetPath)
    .sort((left, right) => {
      const leftStem = fileStem(left.path);
      const rightStem = fileStem(right.path);
      const leftScore =
        Number(leftStem === targetStem) * 4 +
        Number(leftStem === displayStem) * 3 +
        Number(leftStem === legacyStem) * 2 +
        Number(leftStem.includes(stableKey));
      const rightScore =
        Number(rightStem === targetStem) * 4 +
        Number(rightStem === displayStem) * 3 +
        Number(rightStem === legacyStem) * 2 +
        Number(rightStem.includes(stableKey));
      return rightScore - leftScore || compareStrings(leftStem, rightStem);
    });

  for (const candidate of candidates) {
    if (await fileMatchesEmployeeIdentity(vault, candidate, employee)) {
      return candidate;
    }
  }

  return (
    candidates.find((file) => {
      const stem = fileStem(file.path);
      return (
        stem === targetStem ||
        stem === displayStem ||
        stem === legacyStem ||
        stem.includes(stableKey)
      );
    }) ?? null
  );
}

function findExistingProjectNote(
  vault: Vault,
  projectFolder: string,
  candidateStems: Set<string>,
  targetPath: string,
): TFile | null {
  const candidates = vault
    .getMarkdownFiles()
    .filter((file) => isDirectChildMarkdownFile(file.path, projectFolder))
    .filter((file) => candidateStems.has(fileStem(file.path)))
    .sort((left, right) => {
      const leftStem = fileStem(left.path);
      const rightStem = fileStem(right.path);
      return compareStrings(leftStem, rightStem);
    });

  return candidates.find((file) => file.path !== targetPath) ?? null;
}

function findExistingIssueNote(
  vault: Vault,
  tasksFolder: string,
  candidateStems: Set<string>,
  targetPath: string,
): TFile | null {
  const candidates = vault
    .getMarkdownFiles()
    .filter((file) => isDirectChildMarkdownFile(file.path, tasksFolder))
    .filter((file) => candidateStems.has(fileStem(file.path)))
    .sort((left, right) => {
      const leftStem = fileStem(left.path);
      const rightStem = fileStem(right.path);
      const leftScore = leftStem === fileStem(targetPath) ? 0 : 1;
      const rightScore = rightStem === fileStem(targetPath) ? 0 : 1;
      return leftScore - rightScore || compareStrings(leftStem, rightStem);
    });

  return candidates.find((file) => file.path !== targetPath) ?? null;
}

function findExistingMilestoneNote(
  vault: Vault,
  milestonesFolder: string,
  candidateStems: Set<string>,
  targetPath: string,
): TFile | null {
  const candidates = vault
    .getMarkdownFiles()
    .filter((file) => isDirectChildMarkdownFile(file.path, milestonesFolder))
    .filter((file) => candidateStems.has(fileStem(file.path)))
    .sort((left, right) => {
      const leftStem = fileStem(left.path);
      const rightStem = fileStem(right.path);
      const leftScore = leftStem === fileStem(targetPath) ? 0 : 1;
      const rightScore = rightStem === fileStem(targetPath) ? 0 : 1;
      return leftScore - rightScore || compareStrings(leftStem, rightStem);
    });

  return candidates.find((file) => file.path !== targetPath) ?? null;
}

function findExistingIssueTemplateNote(
  vault: Vault,
  templatesFolder: string,
  candidateStems: Set<string>,
  targetPath: string,
): TFile | null {
  const candidates = vault
    .getMarkdownFiles()
    .filter((file) => isDirectChildMarkdownFile(file.path, templatesFolder))
    .filter((file) => candidateStems.has(fileStem(file.path)))
    .sort((left, right) => {
      const leftStem = fileStem(left.path);
      const rightStem = fileStem(right.path);
      const leftScore = leftStem === fileStem(targetPath) ? 0 : 1;
      const rightScore = rightStem === fileStem(targetPath) ? 0 : 1;
      return leftScore - rightScore || compareStrings(leftStem, rightStem);
    });

  return candidates.find((file) => file.path !== targetPath) ?? null;
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

function isLocalAttachment(attachment: HulyAttachment): boolean {
  return !attachment.url.startsWith("http://") && !attachment.url.startsWith("https://");
}

function formatAttachmentLink(attachment: HulyAttachment): string {
  const meta = [attachment.mimeType, humanFileSize(attachment.size)]
    .filter((part) => part.trim().length > 0)
    .join(", ");
  const link = isLocalAttachment(attachment)
    ? `[[${attachment.url}|${attachment.name}]]`
    : `[${attachment.name}](${attachment.url})`;
  return `${link}${meta ? ` _(${meta})_` : ""}`;
}

function attachmentLinks(attachments: HulyAttachment[]): string[] {
  return [...attachments]
    .sort((left, right) => compareStrings(left.name, right.name))
    .map((attachment) => formatAttachmentLink(attachment));
}

function renderCommentsSection(
  comments: HulyComment[],
  employeePathsByRef: ReadonlyMap<string, string>,
): string[] {
  if (comments.length === 0) {
    return ["## Comments", "", "_No comments_"];
  }

  return [
    "## Comments",
    "",
    ...[...comments]
      .sort((left, right) => left.createdAt - right.createdAt || left.updatedAt - right.updatedAt)
      .flatMap((comment, index) => {
        const authorDisplay = employeeLink(
          comment.authorName,
          comment.authorPersonRef,
          employeePathsByRef,
        );
        const header = `### ${index + 1}. ${authorDisplay} - ${toIsoDate(comment.updatedAt) ?? "Unknown date"}`;
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

function employeeLinkForTable(
  employeeName: string,
  employeeRef: string | null,
  employeePathsByRef: ReadonlyMap<string, string>,
): string {
  if (employeeRef) {
    const employeePath = employeePathsByRef.get(employeeRef);
    if (employeePath) {
      return `[[${withoutExtension(employeePath)}]]`;
    }
  }
  return employeeName;
}

function fieldLabel(field: string): string {
  switch (field) {
    case "status": return "Status";
    case "assignee": return "Assignee";
    case "priority": return "Priority";
    default: return field;
  }
}

function renderIssueHistorySection(
  history: HulyIssueHistoryEntry[],
  employeePathsByRef: ReadonlyMap<string, string>,
): string[] {
  if (history.length === 0) {
    return ["## History", "", "_No recorded changes_"];
  }

  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);
  const lines: string[] = [
    "## History",
    "",
    "| Date | Field | From | To | By |",
    "|------|-------|------|----|----|",
  ];

  for (const entry of sorted) {
    const date = toIsoDate(entry.timestamp) ?? "Unknown";
    const field = fieldLabel(entry.field);
    const from = entry.fromValue ?? "—";
    const to = entry.toValue ?? "—";
    const by = employeeLinkForTable(entry.changedBy, entry.changedByPersonRef, employeePathsByRef);
    lines.push(`| ${date} | ${field} | ${from} | ${to} | ${by} |`);
  }

  return lines;
}

type EmployeeTimeSummary = {
  employeeName: string;
  employeeRef: string | null;
  employeePersonUuid: string | null;
  total: number;
};

type EmployeeTimeFrontmatterEntry = {
  employee_name: string;
  employee_slug: string;
  employee_ref: string | null;
  employee_person_uuid: string | null;
  employee_note: string | null;
  employee_link: string | null;
  reported_time_ms: number;
  reported_time_hours: number;
  reported_time_minutes: number;
  reported_time_display: string;
};

function summarizeTimeReports(reports: HulyTimeReport[]): EmployeeTimeSummary[] {
  const totals = new Map<string, EmployeeTimeSummary>();
  for (const report of reports) {
    const key = report.employeeRef ?? (report.employeeName.trim() || "Unknown employee");
    const existing = totals.get(key);
    if (existing) {
      existing.total += report.value;
      if (!existing.employeeRef && report.employeeRef) {
        existing.employeeRef = report.employeeRef;
      }
      if (!existing.employeePersonUuid && report.employeePersonUuid) {
        existing.employeePersonUuid = report.employeePersonUuid;
      }
      if (
        existing.employeeName === "Unknown employee" &&
        report.employeeName.trim().length > 0
      ) {
        existing.employeeName = report.employeeName;
      }
      continue;
    }

    totals.set(key, {
      employeeName: report.employeeName.trim() || "Unknown employee",
      employeeRef: report.employeeRef,
      employeePersonUuid: report.employeePersonUuid,
      total: report.value,
    });
  }

  return Array.from(totals.values())
    .sort(
      (left, right) =>
        right.total - left.total || compareStrings(left.employeeName, right.employeeName),
    );
}

function topTimeReporter(summary: EmployeeTimeSummary[]): EmployeeTimeSummary | null {
  const first = summary[0];
  return first ?? null;
}

function projectTimeSummary(issues: HulyIssue[]): EmployeeTimeSummary[] {
  return summarizeTimeReports(issues.flatMap((issue) => issue.timeReports));
}

function timeSummaryFrontmatter(
  summary: EmployeeTimeSummary[],
  employeePathsByRef: ReadonlyMap<string, string>,
): EmployeeTimeFrontmatterEntry[] {
  return summary.map((item) => ({
    employee_name: item.employeeName,
    employee_slug: slugify(item.employeeName),
    employee_ref: item.employeeRef,
    employee_person_uuid: item.employeePersonUuid,
    employee_note: item.employeeRef ? withoutExtension(employeePathsByRef.get(item.employeeRef) ?? "") || null : null,
    employee_link:
      item.employeeRef && employeePathsByRef.get(item.employeeRef)
        ? wikilink(employeePathsByRef.get(item.employeeRef) ?? "", item.employeeName)
        : null,
    reported_time_ms: item.total,
    reported_time_hours: durationToHours(item.total),
    reported_time_minutes: durationToMinutes(item.total),
    reported_time_display: formatDurationShort(item.total),
  }));
}

function sumIssueDurations(issues: HulyIssue[]) {
  return issues.reduce(
    (acc, issue) => {
      acc.estimation += issue.estimation;
      acc.reported += issue.reportedTime;
      acc.remaining += issue.remainingTime;
      return acc;
    },
    { estimation: 0, reported: 0, remaining: 0 },
  );
}

function employeeLink(
  employeeName: string,
  employeeRef: string | null,
  employeePathsByRef: ReadonlyMap<string, string>,
): string {
  if (employeeRef) {
    const employeePath = employeePathsByRef.get(employeeRef);
    if (employeePath) {
      return wikilink(employeePath, employeeName);
    }
  }

  return employeeName;
}

function renderTimeSummaryLines(
  summary: EmployeeTimeSummary[],
  emptyText: string,
  employeePathsByRef: ReadonlyMap<string, string>,
): string[] {
  if (summary.length === 0) {
    return [emptyText];
  }

  return summary.map(
    (item) =>
      `- ${employeeLink(item.employeeName, item.employeeRef, employeePathsByRef)}: ${formatDurationShort(item.total)}`,
  );
}

function renderIssueTimeReportsSection(
  issue: HulyIssue,
  employeePathsByRef: ReadonlyMap<string, string>,
  title = "## Time reports",
): string[] {
  const summary = summarizeTimeReports(issue.timeReports);
  const lines = [
    title,
    "",
    `- Estimate: ${formatDuration(issue.estimation)}`,
    `- Time spent: ${formatDuration(issue.reportedTime)}`,
    `- Remaining: ${formatDuration(issue.remainingTime)}`,
    `- Due date: ${toDateOnlyString(issue.dueDate) ?? "Not set"}`,
    "",
    "### By employee",
    "",
    ...renderTimeSummaryLines(summary, "_No time reports_", employeePathsByRef),
  ];

  if (issue.timeReports.length > 0) {
    lines.push("", "### Entries", "");
    for (const report of [...issue.timeReports].sort((left, right) => {
      const leftDate = left.date ?? 0;
      const rightDate = right.date ?? 0;
      return rightDate - leftDate || compareStrings(left.employeeName, right.employeeName);
    })) {
      const date = report.date ? formatReadableDatetime(report.date) : "Unknown date";
      const description = report.description.trim() || "_No description_";
      lines.push(
        `- ${employeeLink(report.employeeName, report.employeeRef, employeePathsByRef)}: ${formatDurationShort(report.value)} on ${date}`,
        `  - ${description}`,
      );
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Rich template helpers
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatReadableDate(timestamp: number | null): string {
  if (timestamp === null) return "—";
  const d = new Date(timestamp);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function formatReadableDatetime(timestamp: number | null): string {
  if (timestamp === null) return "—";
  const d = new Date(timestamp);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h}:${m}`;
}

function priorityEmoji(priority: string, isClosed: boolean): string {
  if (isClosed) return "✅";
  switch (priority) {
    case "Urgent": return "🔴";
    case "High": return "🟠";
    case "Medium": return "🟡";
    case "Low": return "🟢";
    default: return "⚪";
  }
}

function statusDot(statusName: string): string {
  const s = statusName.toLowerCase();
  if (s.includes("done") || s.includes("cancel")) return "🟢";
  if (s.includes("progress")) return "🔵";
  if (s.includes("review")) return "🟣";
  if (s.includes("todo")) return "🟡";
  if (s.includes("backlog")) return "⚪";
  return "🔘";
}

function issueHeaderVariant(priority: string, isClosed: boolean): string {
  if (isClosed) return "success";
  switch (priority) {
    case "Urgent": return "danger";
    case "High": return "warning";
    default: return "info";
  }
}

/** Prefix a line for level-2 callout nesting (> > ) */
function L2(line: string): string {
  return line === "" ? "> >" : `> > ${line}`;
}

/** Convert multi-line text into L2-prefixed lines */
function contentToL2(content: string): string[] {
  return content.split("\n").map(L2);
}

// ---------------------------------------------------------------------------
// Template file content (Meta Bind embeds)
// ---------------------------------------------------------------------------

function issueSidebarTemplate(): string {
  return [
    "##### Details",
    "",
    "| | |",
    "|:--|:--|",
    "| 🔖 **Status** | `VIEW[{huly_status_display}][text]` |",
    "| ⚡ **Priority** | `VIEW[{huly_priority_display}][text]` |",
    "| 👤 **Assignee** | `VIEW[{huly_assignee}][text]` |",
    "| 📅 **Due Date** | `VIEW[{huly_due_display}][text]` |",
    "| ⏳ **Estimate** | `VIEW[{huly_estimation_display}][text]` |",
    "| 🕒 **Spent** | `VIEW[{huly_reported_display}][text]` |",
    "| ⌛ **Remaining** | `VIEW[{huly_remaining_display}][text]` |",
    "| 🏷️ **Labels** | `VIEW[{huly_labels_display}][text]` |",
    "| 🔄 **Updated** | `VIEW[{huly_updated_display}][text]` |",
    "| 🎯 **Milestone** | `VIEW[{huly_milestone_display}][text(renderMarkdown)]` |",
    "| 📄 **Template** | `VIEW[{huly_issue_template_display}][text(renderMarkdown)]` |",
    "",
    "---",
    "",
    "##### Relations",
    "",
    "| | |",
    "|:--|:--|",
    "| 📂 **Project** | `VIEW[{huly_project_link}][text(renderMarkdown)]` |",
    "| 🧩 **Component** | `VIEW[{huly_component_link}][text(renderMarkdown)]` |",
    "| 🎯 **Milestone** | `VIEW[{huly_milestone_display}][text(renderMarkdown)]` |",
    "| 📄 **Issue template** | `VIEW[{huly_issue_template_display}][text(renderMarkdown)]` |",
    "| ⬆️ **Parent** | `VIEW[{huly_parent_link}][text(renderMarkdown)]` |",
    "",
    "---",
    "",
    "##### Actions",
    "",
    "```meta-bind-button",
    "label: \"🔄 Sync Now\"",
    "hidden: true",
    "id: \"huly-sidebar-sync\"",
    "style: primary",
    "action:",
    "  type: command",
    "  command: huly-sync:huly-sync-run-manual",
    "```",
    "",
    "`BUTTON[huly-sidebar-sync]`",
  ].join("\n");
}

function projectHeaderTemplate(): string {
  return [
    "```meta-bind-button",
    "label: \"🔄 Sync Now\"",
    "hidden: true",
    "id: \"huly-project-sync\"",
    "style: primary",
    "action:",
    "  type: command",
    "  command: huly-sync:huly-sync-run-manual",
    "```",
    "",
    "```meta-bind-button",
    "label: \"📥 Reload Projects\"",
    "hidden: true",
    "id: \"huly-reload\"",
    "style: default",
    "action:",
    "  type: command",
    "  command: huly-sync:huly-sync-refresh-projects",
    "```",
    "",
    "`BUTTON[huly-project-sync, huly-reload]`",
  ].join("\n");
}

async function writeTemplateFiles(vault: Vault, rootFolder: string): Promise<void> {
  const tplFolder = joinVaultPath(rootFolder, "_templates");
  await ensureFolder(vault, tplFolder);
  await upsertFile(vault, joinVaultPath(tplFolder, "issue_sidebar.md"), issueSidebarTemplate());
  await upsertFile(vault, joinVaultPath(tplFolder, "project_header.md"), projectHeaderTemplate());
}

// ---------------------------------------------------------------------------
// Rich renderers — multi-layout system
// ---------------------------------------------------------------------------

function renderRichProjectNote(
  project: HulyProject,
  issues: HulyIssue[],
  componentLinks: string[],
  issueLinks: string[],
  milestoneLinks: string[],
  issueTemplateLinks: string[],
  opts: NoteRenderOptions,
): string {
  const tags = unique(["huly", "huly/type/project", projectTag(project)]);
  const tasksFolder = projectTasksFolderPath(opts.rootFolder, project);
  const tplPath = withoutExtension(joinVaultPath(opts.rootFolder, "_templates/project_header"));
  const mb = opts.useMetaBind;
  const totals = sumIssueDurations(issues);
  const timeSummary = projectTimeSummary(issues);
  const topReporter = topTimeReporter(timeSummary);
  const timeSummaryFrontmatterRows = timeSummaryFrontmatter(timeSummary, opts.employeePathsByRef);
  const dueIssues = [...issues].filter((issue) => issue.dueDate !== null);
  const overdueOpenIssues = issues.filter(
    (issue) => !issue.isClosed && issue.dueDate !== null && (dueInDays(issue.dueDate) ?? 1) < 0,
  );

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-project", "huly-card"]),
    yamlScalar("huly_type", "project"),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_name", project.name),
    yamlScalar("huly_component_count", componentLinks.length),
    yamlScalar("huly_task_count", issueLinks.length),
    yamlScalar("huly_milestone_count", milestoneLinks.length),
    yamlScalar("huly_issue_template_count", issueTemplateLinks.length),
    yamlScalar("huly_total_estimation_ms", totals.estimation),
    yamlScalar("huly_total_estimation_hours", durationToHours(totals.estimation)),
    yamlScalar("huly_total_estimation_minutes", durationToMinutes(totals.estimation)),
    yamlScalar("huly_total_reported_time_ms", totals.reported),
    yamlScalar("huly_total_reported_time_hours", durationToHours(totals.reported)),
    yamlScalar("huly_total_reported_time_minutes", durationToMinutes(totals.reported)),
    yamlScalar("huly_total_remaining_time_ms", totals.remaining),
    yamlScalar("huly_total_remaining_time_hours", durationToHours(totals.remaining)),
    yamlScalar("huly_total_remaining_time_minutes", durationToMinutes(totals.remaining)),
    yamlScalar("huly_total_progress_pct", timeProgressPct(totals.estimation, totals.reported)),
    yamlScalar("huly_has_project_time_reports", timeSummary.length > 0),
    yamlScalar("huly_overdue_open_task_count", overdueOpenIssues.length),
    yamlScalar("huly_due_task_count", dueIssues.length),
    yamlScalar("huly_top_reporter", topReporter?.employeeName ?? null),
    yamlScalar("huly_top_reported_time_ms", topReporter?.total ?? null),
    yamlScalar(
      "huly_top_reported_time_hours",
      topReporter ? durationToHours(topReporter.total) : null,
    ),
    yamlList("huly_time_reporters", timeSummary.map((item) => item.employeeName)),
    yamlList(
      "huly_time_by_employee_display",
      timeSummary.map((item) => `${item.employeeName}: ${formatDurationShort(item.total)}`),
    ),
    yamlObjectList("huly_time_by_employee", timeSummaryFrontmatterRows),
    yamlList("tags", tags),
    "---",
    "",
    `# 📂 ${projectHeading(project)}`.trim(),
    "",
  ];

  // -- Stats row --
  lines.push(
    "> [!huly-stats]",
    ">",
    "> > [!huly-stat]",
    "> > **" + String(componentLinks.length) + "**",
    "> > 🧩 Components",
    ">",
    "> > [!huly-stat]",
    "> > **" + String(issueLinks.length) + "**",
    "> > 📋 Tasks",
    ">",
    "> > [!huly-stat]",
    "> > **" + project.identifier + "**",
    "> > 🆔 Identifier",
    ">",
    "> > [!huly-stat]",
    `> > **${formatDurationShort(totals.reported)}**`,
    "> > 🕒 Time Spent",
    "",
  );

  // -- Meta Bind actions (embed or nothing) --
  if (mb) {
    lines.push(
      "```meta-bind-embed",
      `[[${tplPath}]]`,
      "```",
      "",
    );
  }

  // -- Description --
  lines.push(
    "---",
    "",
    "## 📝 Description",
    "",
    project.description || "_No project description._",
    "",
    "---",
    "",
  );

  // -- Two-column: components + dataview tasks table --
  lines.push(
    "> [!huly-columns]",
    ">",
    "> > [!huly-col]",
    "> > ### 🧩 Components",
    "> >",
  );

  if (componentLinks.length === 0) {
    lines.push("> > _No components_");
  } else {
    for (const link of componentLinks) {
      lines.push(`> > - ${link}`);
    }
  }

  lines.push(
    ">",
    "> > [!huly-col]",
    "> > ### 📋 Tasks",
    "> >",
  );

  lines.push(
    "> > ```dataview",
    "> > TABLE WITHOUT ID",
    "> >   file.link AS \"Task\",",
    "> >   huly_status AS \"Status\",",
    "> >   huly_priority AS \"Priority\",",
    "> >   due AS \"Due\",",
    "> >   huly_estimation_display AS \"Estimate\",",
    "> >   huly_reported_display AS \"Spent\",",
    "> >   huly_remaining_display AS \"Remaining\"",
    `> > FROM "${tasksFolder}"`,
    "> > SORT due ASC, huly_priority DESC",
    "> > ```",
    "",
  );

  lines.push(
    "---",
    "",
    "## ⏱ Time Tracking",
    "",
    `- Total estimate: ${formatDuration(totals.estimation)}`,
    `- Total time spent: ${formatDuration(totals.reported)}`,
    `- Total remaining: ${formatDuration(totals.remaining)}`,
    "",
    "### By employee",
    "",
    ...renderTimeSummaryLines(timeSummary, "_No time reports_", opts.employeePathsByRef),
    "",
    "### Upcoming deadlines",
    "",
  );

  const upcomingDeadlines = [...issues]
    .filter((issue) => issue.dueDate !== null)
    .sort((left, right) => (left.dueDate ?? 0) - (right.dueDate ?? 0));
  if (upcomingDeadlines.length === 0) {
    lines.push("_No due dates_", "");
  } else {
    for (const issue of upcomingDeadlines.slice(0, 10)) {
      lines.push(
        `- ${issue.identifier} ${issue.title} :: ${toDateOnlyString(issue.dueDate)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "## 🎯 Milestones",
    "",
  );
  if (milestoneLinks.length === 0) {
    lines.push("_No milestones_", "");
  } else {
    for (const link of milestoneLinks) {
      lines.push(`- ${link}`);
    }
    lines.push("");
  }

  lines.push("---", "", "## 📄 Issue templates", "", "");
  if (issueTemplateLinks.length === 0) {
    lines.push("_No issue templates_", "");
  } else {
    for (const link of issueTemplateLinks) {
      lines.push(`- ${link}`);
    }
    lines.push("");
  }

  // -- Full task list fallback (in case Dataview is not installed) --
  lines.push(
    "---",
    "",
    "## 📋 All Tasks",
    "",
  );

  if (issueLinks.length === 0) {
    lines.push("_No tasks_");
  } else {
    for (const link of issueLinks) {
      lines.push(`- ${link}`);
    }
  }

  return lines.join("\n");
}

function renderRichComponentNote(
  project: HulyProject,
  component: HulyComponent,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  const tags = unique([
    "huly",
    "huly/type/component",
    projectTag(project),
    ...componentTag(component.label),
  ]);

  const projectDisplay = wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim());
  const updatedDisplay = formatReadableDatetime(component.modifiedOn);

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-component", "huly-card"]),
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
    `# 🧩 ${component.label}`,
    "",
    // -- Header bar with breadcrumb --
    `> [!huly-header]`,
    `> 📂 ${projectDisplay} · 🔄 ${updatedDisplay}`,
    "",
    "---",
    "",
    "## 📝 Description",
    "",
    component.description || "_No component description._",
    "",
  ];

  // -- Attachments --
  if (component.attachments.length > 0) {
    lines.push("---", "", "## 📎 Attachments", "");
    for (const att of component.attachments) {
      lines.push(`- ${formatAttachmentLink(att)}`);
    }
    lines.push("");
  }

  // -- Comments --
  lines.push(...renderCommentsRich(component.comments, opts.employeePathsByRef));

  return lines.join("\n");
}

function renderRichIssueNote(
  project: HulyProject,
  issue: HulyIssue,
  projectNoteLink: string,
  componentNoteLink: string | null,
  parentLinks: string[],
  milestoneNoteLink: string | null,
  issueTemplateNoteLink: string | null,
  opts: NoteRenderOptions,
): string {
  const sortedLabels = [...issue.labels].sort(compareStrings);
  const tags = unique([
    "huly",
    "huly/type/issue",
    projectTag(project),
    statusTag(issue.statusName),
    ...componentTag(issue.componentName),
    ...milestoneTag(issue.milestoneLabel),
    ...labelTags(sortedLabels),
  ]);

  const mb = opts.useMetaBind;
  const pEmoji = priorityEmoji(issue.priority, issue.isClosed);
  const variant = issueHeaderVariant(issue.priority, issue.isClosed);

  const statusDisp = `${statusDot(issue.statusName)} ${issue.statusName}`;
  const priorityDisp = `${pEmoji} ${issue.priority}`;
  const dueDisp = issue.dueDate !== null ? formatReadableDate(issue.dueDate) : "Not set";
  const updatedDisp = formatReadableDatetime(issue.modifiedOn);
  const labelsDisp = sortedLabels.length > 0 ? sortedLabels.join(", ") : "None";
  const labelsInline = sortedLabels.length > 0
    ? sortedLabels.map((l) => `\`${l}\``).join(" ")
    : "—";
  const estimateDisp = formatDuration(issue.estimation);
  const reportedDisp = formatDuration(issue.reportedTime);
  const remainingDisp = formatDuration(issue.remainingTime);
  const reportSummary = summarizeTimeReports(issue.timeReports);
  const topReporter = topTimeReporter(reportSummary);
  const timeSummaryFrontmatterRows = timeSummaryFrontmatter(
    reportSummary,
    opts.employeePathsByRef,
  );
  const dueDays = dueInDays(issue.dueDate);
  const progressPct = timeProgressPct(issue.estimation, issue.reportedTime);

  const componentDisplay = componentNoteLink && issue.componentName
    ? wikilink(componentNoteLink, issue.componentName)
    : issue.componentName ?? "—";
  const milestoneDisplay =
    milestoneNoteLink && issue.milestoneLabel
      ? wikilink(milestoneNoteLink, issue.milestoneLabel)
      : issue.milestoneLabel ?? "—";
  const issueTemplateDisplay =
    issueTemplateNoteLink && issue.issueTemplateTitle
      ? wikilink(issueTemplateNoteLink, issue.issueTemplateTitle)
      : issue.issueTemplateTitle ?? "—";
  const projectLinkMd = wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim());
  const parentLinkMd = parentLinks.length > 0 ? parentLinks.join(", ") : "None";
  const externalIssueUrl = hulyIssueUrl(opts, issue);
  const issueLinkMd = externalIssueUrl ? `[Open in Huly](${externalIssueUrl})` : "Not available";
  const assigneeDisplay = employeeLink(
    issue.assigneeName ?? "Unassigned",
    issue.assigneePersonRef,
    opts.employeePathsByRef,
  );
  const assigneeNotePath = issue.assigneePersonRef
    ? opts.employeePathsByRef.get(issue.assigneePersonRef) ?? null
    : null;

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-issue", "huly-card"]),
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
    yamlScalar("huly_assignee_person_id", issue.assigneePersonRef),
    yamlScalar("huly_assignee_employee_id", issue.assigneeEmployeeRef),
    yamlScalar("huly_assignee_person_uuid", issue.assigneePersonUuid),
    yamlScalar("huly_assignee_note", assigneeNotePath ? withoutExtension(assigneeNotePath) : null),
    yamlScalar("huly_assignee_link", assigneeNotePath ? wikilink(assigneeNotePath, issue.assigneeName ?? "Unassigned") : null),
    yamlScalar("huly_component", issue.componentName),
    yamlScalar("huly_component_note", componentNoteLink ? withoutExtension(componentNoteLink) : null),
    yamlScalar("huly_milestone_id", issue.milestoneId),
    yamlScalar("huly_milestone", issue.milestoneLabel),
    yamlScalar("huly_milestone_note", milestoneNoteLink ? withoutExtension(milestoneNoteLink) : null),
    yamlScalar(
      "huly_milestone_link",
      milestoneNoteLink && issue.milestoneLabel
        ? wikilink(milestoneNoteLink, issue.milestoneLabel)
        : null,
    ),
    yamlScalar("huly_issue_template_id", issue.issueTemplateId),
    yamlScalar("huly_issue_template_title", issue.issueTemplateTitle),
    yamlScalar(
      "huly_issue_template_note",
      issueTemplateNoteLink ? withoutExtension(issueTemplateNoteLink) : null,
    ),
    yamlScalar(
      "huly_issue_template_link",
      issueTemplateNoteLink && issue.issueTemplateTitle
        ? wikilink(issueTemplateNoteLink, issue.issueTemplateTitle)
        : null,
    ),
    yamlScalar("huly_issue_template_child_id", issue.issueTemplateChildId),
    yamlScalar("huly_due_date", toIsoDate(issue.dueDate)),
    yamlScalar("due", toDateOnlyString(issue.dueDate)),
    yamlScalar("huly_estimation_ms", issue.estimation),
    yamlScalar("huly_estimation_hours", durationToHours(issue.estimation)),
    yamlScalar("huly_estimation_minutes", durationToMinutes(issue.estimation)),
    yamlScalar("huly_reported_time_ms", issue.reportedTime),
    yamlScalar("huly_reported_time_hours", durationToHours(issue.reportedTime)),
    yamlScalar("huly_reported_time_minutes", durationToMinutes(issue.reportedTime)),
    yamlScalar("huly_remaining_time_ms", issue.remainingTime),
    yamlScalar("huly_remaining_time_hours", durationToHours(issue.remainingTime)),
    yamlScalar("huly_remaining_time_minutes", durationToMinutes(issue.remainingTime)),
    yamlScalar("huly_remaining_time_days", durationToDays(issue.remainingTime)),
    yamlScalar("huly_time_progress_pct", progressPct),
    yamlScalar("huly_has_time_reports", issue.timeReports.length > 0),
    yamlScalar("huly_time_report_count", issue.timeReports.length),
    yamlScalar("huly_time_reporter_count", reportSummary.length),
    yamlScalar("huly_is_over_estimate", issue.reportedTime > issue.estimation && issue.estimation > 0),
    yamlScalar("huly_due_in_days", dueDays),
    yamlScalar(
      "huly_is_overdue",
      issue.dueDate !== null && !issue.isClosed && (dueDays ?? 1) < 0,
    ),
    yamlScalar(
      "huly_is_due_soon",
      issue.dueDate !== null && !issue.isClosed && dueDays !== null && dueDays >= 0 && dueDays <= 7,
    ),
    yamlScalar("huly_top_reporter", topReporter?.employeeName ?? null),
    yamlScalar("huly_top_reported_time_ms", topReporter?.total ?? null),
    yamlScalar(
      "huly_top_reported_time_hours",
      topReporter ? durationToHours(topReporter.total) : null,
    ),
    yamlList("huly_time_reporters", reportSummary.map((item) => item.employeeName)),
    yamlList(
      "huly_time_by_employee_display",
      reportSummary.map((item) => `${item.employeeName}: ${formatDurationShort(item.total)}`),
    ),
    yamlObjectList("huly_time_by_employee", timeSummaryFrontmatterRows),
    yamlScalar("huly_updated_at", toIsoDate(issue.modifiedOn)),
    yamlScalar("huly_is_closed", issue.isClosed),
    yamlList("huly_labels", sortedLabels),
    // display properties for Meta Bind VIEW fields
    yamlScalar("huly_status_display", statusDisp),
    yamlScalar("huly_priority_display", priorityDisp),
    yamlScalar("huly_due_display", dueDisp),
    yamlScalar("huly_estimation_display", estimateDisp),
    yamlScalar("huly_reported_display", reportedDisp),
    yamlScalar("huly_remaining_display", remainingDisp),
    yamlScalar("huly_updated_display", updatedDisp),
    yamlScalar("huly_labels_display", labelsDisp),
    yamlScalar("huly_issue_url", externalIssueUrl),
    yamlScalar("huly_issue_link", issueLinkMd),
    yamlScalar("huly_project_link", projectLinkMd),
    yamlScalar("huly_component_link", componentDisplay),
    yamlScalar("huly_milestone_display", milestoneDisplay),
    yamlScalar("huly_issue_template_display", issueTemplateDisplay),
    yamlScalar("huly_parent_link", parentLinkMd),
    yamlList("tags", tags),
    "---",
    "",
  ];

  // -- Hidden Meta Bind button (outside callouts) --
  if (mb) {
    lines.push(
      "```meta-bind-button",
      "label: \"🔄 Sync\"",
      "hidden: true",
      "id: \"huly-sync-btn\"",
      "style: primary",
      "action:",
      "  type: command",
      "  command: huly-sync:huly-sync-run-manual",
      "```",
      "",
    );
  }

  // -- Title --
  lines.push(`# ${pEmoji} ${issue.identifier} ${issue.title}`.trim(), "");

  // -- Header bar --
  const assigneeStr = issue.assigneeName ? `👤 ${assigneeDisplay}` : "👤 Unassigned";
  lines.push(
    `> [!huly-header|${variant}]`,
    `> ${statusDisp} · ⚡ ${issue.priority} · ${assigneeStr} · 📅 ${dueDisp}`,
    "",
  );

  // == Two-column layout ==
  lines.push("> [!huly-layout]", ">");

  // ---- LEFT: Main content ----
  lines.push(L2("[!huly-main]"), L2(""));

  // Description
  lines.push(L2("### 📝 Description"), L2(""));
  const desc = issue.description.trim() || "_No description_";
  lines.push(...contentToL2(desc));

  // Attachments
  if (issue.attachments.length > 0) {
    lines.push(L2(""), L2("---"), L2(""), L2("### 📎 Attachments"), L2(""));
    for (const att of issue.attachments) {
      lines.push(L2(`- ${formatAttachmentLink(att)}`));
    }
  }

  lines.push(L2(""), L2("---"), L2(""), L2("### ⏱ Time Tracking"), L2(""));
  lines.push(
    L2(`- Estimate: ${estimateDisp}`),
    L2(`- Time spent: ${reportedDisp}`),
    L2(`- Remaining: ${remainingDisp}`),
    L2(`- Due date: ${toDateOnlyString(issue.dueDate) ?? "Not set"}`),
  );

  lines.push(L2(""), L2("#### By employee"), L2(""));
  if (reportSummary.length === 0) {
    lines.push(L2("_No time reports_"));
  } else {
    for (const item of reportSummary) {
      lines.push(
        L2(
          `- ${employeeLink(item.employeeName, item.employeeRef, opts.employeePathsByRef)}: ${formatDurationShort(item.total)}`,
        ),
      );
    }
  }

  if (issue.timeReports.length > 0) {
    lines.push(L2(""), L2("#### Entries"), L2(""));
    for (const report of [...issue.timeReports].sort((left, right) => {
      const leftDate = left.date ?? 0;
      const rightDate = right.date ?? 0;
      return rightDate - leftDate || compareStrings(left.employeeName, right.employeeName);
    })) {
      const date = report.date ? formatReadableDatetime(report.date) : "Unknown date";
      const description = report.description.trim() || "_No description_";
      lines.push(
        L2(
          `- ${employeeLink(report.employeeName, report.employeeRef, opts.employeePathsByRef)}: ${formatDurationShort(report.value)} on ${date}`,
        ),
      );
      lines.push(L2(`  - ${description}`));
    }
  }

  // History
  lines.push(L2(""), L2("---"), L2(""));
  if (issue.history.length === 0) {
    lines.push(L2("### 📋 History"), L2(""), L2("_No recorded changes_"));
  } else {
    const sortedHistory = [...issue.history].sort((a, b) => a.timestamp - b.timestamp);
    lines.push(L2(`### 📋 History (${issue.history.length})`));
    lines.push(L2(""));
    lines.push(L2("| Date | Field | From | To | By |"));
    lines.push(L2("|------|-------|------|----|----|"));
    for (const entry of sortedHistory) {
      const date = formatReadableDatetime(entry.timestamp);
      const field = fieldLabel(entry.field);
      const from = entry.fromValue ?? "—";
      const to = entry.toValue ?? "—";
      const by = employeeLinkForTable(entry.changedBy, entry.changedByPersonRef, opts.employeePathsByRef);
      lines.push(L2(`| ${date} | ${field} | ${from} | ${to} | ${by} |`));
    }
  }

  // Comments
  lines.push(L2(""), L2("---"), L2(""));
  if (issue.comments.length === 0) {
    lines.push(L2("### 💬 Comments"), L2(""), L2("_No comments_"));
  } else {
    lines.push(L2(`### 💬 Comments (${issue.comments.length})`));
    for (const comment of issue.comments) {
      const cDate = formatReadableDatetime(comment.updatedAt);
      const cBody = comment.body.trim() || "_Empty comment_";
      const authorDisplay = employeeLink(
        comment.authorName,
        comment.authorPersonRef,
        opts.employeePathsByRef,
      );
      lines.push(L2(""), L2("---"), L2(""));
      lines.push(L2(`**💬 ${authorDisplay}** · _${cDate}_`));
      lines.push(L2(""));
      lines.push(...contentToL2(cBody));
      if (comment.attachments.length > 0) {
        lines.push(L2(""));
        for (const att of comment.attachments) {
          lines.push(L2(`- ${formatAttachmentLink(att)}`));
        }
      }
    }
  }

  // ---- Separator between nested callouts ----
  lines.push(">");

  // ---- RIGHT: Sidebar ----
  lines.push(L2("[!huly-sidebar]"), L2(""));

  if (mb) {
    // Use Meta Bind embed — template binds to this note's frontmatter
    const tplPath = withoutExtension(joinVaultPath(opts.rootFolder, "_templates/issue_sidebar"));
    lines.push(
      L2("```meta-bind-embed"),
      L2(`[[${tplPath}]]`),
      L2("```"),
    );
  } else {
    // Direct rendering without Meta Bind
    lines.push(
      L2("##### Details"),
      L2(""),
      L2("| | |"),
      L2("|:--|:--|"),
      L2(`| 🔖 **Status** | ${statusDisp} |`),
      L2(`| ⚡ **Priority** | ${priorityDisp} |`),
      L2(`| 👤 **Assignee** | ${assigneeDisplay} |`),
      L2(`| 📅 **Due Date** | ${dueDisp} |`),
      L2(`| ⏳ **Estimate** | ${estimateDisp} |`),
      L2(`| 🕒 **Spent** | ${reportedDisp} |`),
      L2(`| ⌛ **Remaining** | ${remainingDisp} |`),
      L2(`| 🏷️ **Labels** | ${labelsInline} |`),
      L2(`| 🔄 **Updated** | ${updatedDisp} |`),
      L2(`| 🎯 **Milestone** | ${milestoneDisplay} |`),
      L2(`| 📄 **Template** | ${issueTemplateDisplay} |`),
      L2(""),
      L2("---"),
      L2(""),
      L2("##### Relations"),
      L2(""),
      L2("| | |"),
      L2("|:--|:--|"),
      L2(`| 🔗 **Huly** | ${issueLinkMd} |`),
      L2(`| 📂 **Project** | ${projectLinkMd} |`),
      L2(`| 🧩 **Component** | ${componentDisplay} |`),
      L2(`| 🎯 **Milestone** | ${milestoneDisplay} |`),
      L2(`| 📄 **Issue template** | ${issueTemplateDisplay} |`),
      L2(`| ⬆️ **Parent** | ${parentLinkMd} |`),
    );
  }

  lines.push("");

  return lines.join("\n");
}

/** Full-width comments for component notes (not inside a nested callout) */
function renderCommentsRich(
  comments: HulyComment[],
  employeePathsByRef: ReadonlyMap<string, string>,
): string[] {
  if (comments.length === 0) {
    return ["---", "", "## 💬 Comments", "", "_No comments_"];
  }

  const blocks: string[] = ["---", "", `## 💬 Comments (${comments.length})`, ""];

  for (const comment of comments) {
    const date = formatReadableDatetime(comment.updatedAt);
    const body = comment.body.trim() || "_Empty comment_";
    const authorDisplay = employeeLink(comment.authorName, comment.authorPersonRef, employeePathsByRef);

    blocks.push(
      "---",
      "",
      `**💬 ${authorDisplay}** · _${date}_`,
      "",
      body,
      "",
    );

    if (comment.attachments.length > 0) {
      for (const att of comment.attachments) {
        blocks.push(`- ${formatAttachmentLink(att)}`);
      }
      blocks.push("");
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Classic renderers (original format)
// ---------------------------------------------------------------------------

function renderProjectNote(
  project: HulyProject,
  issues: HulyIssue[],
  componentLinks: string[],
  issueLinks: string[],
  milestoneLinks: string[],
  issueTemplateLinks: string[],
  opts: NoteRenderOptions,
): string {
  const tags = unique(["huly", "huly/type/project", projectTag(project)]);
  const totals = sumIssueDurations(issues);
  const timeSummary = projectTimeSummary(issues);
  const topReporter = topTimeReporter(timeSummary);
  const timeSummaryFrontmatterRows = timeSummaryFrontmatter(
    timeSummary,
    opts.employeePathsByRef,
  );
  const dueIssues = [...issues]
    .filter((issue) => issue.dueDate !== null)
    .sort((left, right) => (left.dueDate ?? 0) - (right.dueDate ?? 0));
  const overdueOpenIssues = issues.filter(
    (issue) => !issue.isClosed && issue.dueDate !== null && (dueInDays(issue.dueDate) ?? 1) < 0,
  );
  const body = [
    "---",
    yamlScalar("huly_type", "project"),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_name", project.name),
    yamlScalar("huly_total_estimation_ms", totals.estimation),
    yamlScalar("huly_total_estimation_hours", durationToHours(totals.estimation)),
    yamlScalar("huly_total_estimation_minutes", durationToMinutes(totals.estimation)),
    yamlScalar("huly_total_reported_time_ms", totals.reported),
    yamlScalar("huly_total_reported_time_hours", durationToHours(totals.reported)),
    yamlScalar("huly_total_reported_time_minutes", durationToMinutes(totals.reported)),
    yamlScalar("huly_total_remaining_time_ms", totals.remaining),
    yamlScalar("huly_total_remaining_time_hours", durationToHours(totals.remaining)),
    yamlScalar("huly_total_remaining_time_minutes", durationToMinutes(totals.remaining)),
    yamlScalar("huly_total_progress_pct", timeProgressPct(totals.estimation, totals.reported)),
    yamlScalar("huly_has_project_time_reports", timeSummary.length > 0),
    yamlScalar("huly_overdue_open_task_count", overdueOpenIssues.length),
    yamlScalar("huly_due_task_count", dueIssues.length),
    yamlScalar("huly_top_reporter", topReporter?.employeeName ?? null),
    yamlScalar("huly_top_reported_time_ms", topReporter?.total ?? null),
    yamlScalar(
      "huly_top_reported_time_hours",
      topReporter ? durationToHours(topReporter.total) : null,
    ),
    yamlList("huly_time_reporters", timeSummary.map((item) => item.employeeName)),
    yamlList(
      "huly_time_by_employee_display",
      timeSummary.map((item) => `${item.employeeName}: ${formatDurationShort(item.total)}`),
    ),
    yamlObjectList("huly_time_by_employee", timeSummaryFrontmatterRows),
    yamlList("tags", tags),
    "---",
    "",
    `# ${projectHeading(project)}`.trim(),
    "",
    project.description || "No project description.",
    "",
    "## Time Tracking",
    "",
    `- Total estimate: ${formatDuration(totals.estimation)}`,
    `- Total time spent: ${formatDuration(totals.reported)}`,
    `- Total remaining: ${formatDuration(totals.remaining)}`,
    "",
    "### By employee",
    "",
    ...renderTimeSummaryLines(timeSummary, "_No time reports_", opts.employeePathsByRef),
    "",
    "## Upcoming deadlines",
    "",
    ...(dueIssues.length > 0
      ? dueIssues.map((issue) => `- ${issue.identifier} ${issue.title} :: ${toDateOnlyString(issue.dueDate)}`)
      : ["_No due dates_"]),
    "",
    ...renderLinksSection("## Components", componentLinks),
    "",
    ...renderLinksSection("## Tasks", issueLinks),
    "",
    ...renderLinksSection("## Milestones", milestoneLinks),
    "",
    ...renderLinksSection("## Issue templates", issueTemplateLinks),
  ];

  return body.join("\n");
}

function renderComponentNote(
  project: HulyProject,
  component: HulyComponent,
  projectNoteLink: string,
  opts: NoteRenderOptions,
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
    ...renderCommentsSection(component.comments, opts.employeePathsByRef),
  ].join("\n");
}

function milestoneTasksDataview(
  rootFolder: string,
  project: HulyProject,
  milestone: HulyMilestone,
): string[] {
  const tasksFolder = projectTasksFolderPath(rootFolder, project);
  return [
    "## Tasks",
    "",
    "```dataview",
    "TABLE WITHOUT ID",
    '  file.link AS "Task",',
    '  huly_status AS "Status",',
    '  huly_priority AS "Priority",',
    '  due AS "Due"',
    `FROM "${tasksFolder}"`,
    `WHERE huly_type = "issue" AND huly_milestone_id = "${milestone.id}"`,
    "SORT huly_is_closed ASC, due ASC",
    "```",
    "",
  ];
}

function issueTemplateIssuesDataview(
  rootFolder: string,
  project: HulyProject,
  template: HulyIssueTemplate,
): string[] {
  const tasksFolder = projectTasksFolderPath(rootFolder, project);
  return [
    "## Issues from this template",
    "",
    "```dataview",
    "TABLE WITHOUT ID",
    '  file.link AS "Task",',
    '  huly_status AS "Status",',
    '  due AS "Due"',
    `FROM "${tasksFolder}"`,
    `WHERE huly_type = "issue" AND huly_issue_template_id = "${template.id}"`,
    "SORT huly_is_closed ASC, due ASC",
    "```",
    "",
  ];
}

function renderMilestoneNote(
  project: HulyProject,
  milestone: HulyMilestone,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  const tags = unique([
    "huly",
    "huly/type/milestone",
    projectTag(project),
    ...milestoneTag(milestone.label),
  ]);
  const targetDisp = toDateOnlyString(milestone.targetDate) ?? "Not set";

  return [
    "---",
    yamlScalar("huly_type", "milestone"),
    yamlScalar("huly_milestone_id", milestone.id),
    yamlScalar("huly_milestone_label", milestone.label),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_milestone_status", milestone.statusName),
    yamlScalar("huly_target_date", toIsoDate(milestone.targetDate)),
    yamlScalar("due", toDateOnlyString(milestone.targetDate)),
    yamlScalar("huly_updated_at", toIsoDate(milestone.modifiedOn)),
    yamlList("tags", tags),
    "---",
    "",
    `# ${milestone.label}`,
    "",
    "## Links",
    "",
    `- Project: ${wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim())}`,
    "",
    `- Status: ${milestone.statusName}`,
    `- Target date: ${targetDisp}`,
    "",
    "## Description",
    "",
    milestone.description.trim() || "_No description_",
    "",
    ...renderLinksSection("## Attachments", attachmentLinks(milestone.attachments)),
    "",
    ...renderCommentsSection(milestone.comments, opts.employeePathsByRef),
    "",
    ...milestoneTasksDataview(opts.rootFolder, project, milestone),
  ].join("\n");
}

function renderRichMilestoneNote(
  project: HulyProject,
  milestone: HulyMilestone,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  const tags = unique([
    "huly",
    "huly/type/milestone",
    projectTag(project),
    ...milestoneTag(milestone.label),
  ]);
  const projectDisplay = wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim());
  const targetDisp = toDateOnlyString(milestone.targetDate) ?? "Not set";
  const updatedDisplay = formatReadableDatetime(milestone.modifiedOn);

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-milestone", "huly-card"]),
    yamlScalar("huly_type", "milestone"),
    yamlScalar("huly_milestone_id", milestone.id),
    yamlScalar("huly_milestone_label", milestone.label),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_milestone_status", milestone.statusName),
    yamlScalar("huly_target_date", toIsoDate(milestone.targetDate)),
    yamlScalar("due", toDateOnlyString(milestone.targetDate)),
    yamlScalar("huly_updated_at", toIsoDate(milestone.modifiedOn)),
    yamlList("tags", tags),
    "---",
    "",
    `# 🎯 ${milestone.label}`,
    "",
    `> [!huly-header]`,
    `> 📂 ${projectDisplay} · ${milestone.statusName} · 📅 ${targetDisp} · 🔄 ${updatedDisplay}`,
    "",
    "---",
    "",
    "## 📝 Description",
    "",
    milestone.description.trim() || "_No description_",
    "",
  ];

  if (milestone.attachments.length > 0) {
    lines.push("---", "", "## 📎 Attachments", "");
    for (const att of milestone.attachments) {
      lines.push(`- ${formatAttachmentLink(att)}`);
    }
    lines.push("");
  }

  lines.push(...renderCommentsRich(milestone.comments, opts.employeePathsByRef));
  lines.push(...milestoneTasksDataview(opts.rootFolder, project, milestone));

  return lines.join("\n");
}

function renderIssueTemplateNote(
  project: HulyProject,
  template: HulyIssueTemplate,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  const sortedLabels = [...template.labels].sort(compareStrings);
  const tags = unique([
    "huly",
    "huly/type/issue-template",
    projectTag(project),
    ...labelTags(sortedLabels),
  ]);
  const assigneeDisplay = employeeLink(
    template.assigneeName ?? "Unassigned",
    template.assigneePersonRef,
    opts.employeePathsByRef,
  );
  const labelsDisp = sortedLabels.length > 0 ? sortedLabels.join(", ") : "None";
  const labelsInline = sortedLabels.length > 0
    ? sortedLabels.map((l) => `\`${l}\``).join(" ")
    : "—";

  const lines: string[] = [
    "---",
    yamlScalar("huly_type", "issue-template"),
    yamlScalar("huly_issue_template_id", template.id),
    yamlScalar("huly_issue_template_title", template.title),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_priority", template.priority),
    yamlScalar("huly_assignee", template.assigneeName),
    yamlScalar("huly_assignee_person_id", template.assigneePersonRef),
    yamlScalar("huly_component", template.componentName),
    yamlScalar("huly_milestone", template.milestoneLabel),
    yamlScalar("huly_estimation_ms", template.estimation),
    yamlScalar("huly_estimation_display", formatDuration(template.estimation)),
    yamlScalar("huly_updated_at", toIsoDate(template.modifiedOn)),
    yamlList("huly_labels", sortedLabels),
    yamlScalar("huly_labels_display", labelsDisp),
    yamlScalar("huly_labels_inline", labelsInline),
    yamlList("tags", tags),
    "---",
    "",
    `# ${template.title}`,
    "",
    "## Metadata",
    "",
    `- Priority: ${template.priority}`,
    `- Assignee: ${assigneeDisplay}`,
    `- Component: ${template.componentName ?? "None"}`,
    `- Milestone: ${template.milestoneLabel ?? "None"}`,
    `- Estimate: ${formatDuration(template.estimation)}`,
    sortedLabels.length > 0 ? `- Labels: ${sortedLabels.join(", ")}` : "- Labels: None",
    "",
    "## Description",
    "",
    template.description.trim() || "_No description_",
    "",
  ];

  if (template.children.length > 0) {
    lines.push("## Subtask templates", "");
    for (const child of template.children) {
      lines.push(`### ${child.title}`, "");
      lines.push(`- Priority: ${child.priority}`);
      lines.push(
        `- Assignee: ${employeeLink(
          child.assigneeName ?? "Unassigned",
          child.assigneePersonRef,
          opts.employeePathsByRef,
        )}`,
      );
      lines.push(`- Component: ${child.componentName ?? "None"}`);
      lines.push(`- Milestone: ${child.milestoneLabel ?? "None"}`);
      lines.push(`- Estimate: ${formatDuration(child.estimation)}`);
      lines.push("");
      lines.push(child.description.trim() || "_No description_");
      lines.push("");
    }
  }

  lines.push(
    ...renderLinksSection("## Attachments", attachmentLinks(template.attachments)),
    "",
    ...renderCommentsSection(template.comments, opts.employeePathsByRef),
    "",
  );
  lines.push(...issueTemplateIssuesDataview(opts.rootFolder, project, template));

  return lines.join("\n");
}

function renderRichIssueTemplateNote(
  project: HulyProject,
  template: HulyIssueTemplate,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  const sortedLabels = [...template.labels].sort(compareStrings);
  const tags = unique([
    "huly",
    "huly/type/issue-template",
    projectTag(project),
    ...labelTags(sortedLabels),
  ]);
  const projectDisplay = wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim());
  const assigneeDisplay = employeeLink(
    template.assigneeName ?? "Unassigned",
    template.assigneePersonRef,
    opts.employeePathsByRef,
  );
  const updatedDisplay = formatReadableDatetime(template.modifiedOn);
  const labelsDisp = sortedLabels.length > 0 ? sortedLabels.join(", ") : "None";
  const labelsInline = sortedLabels.length > 0
    ? sortedLabels.map((l) => `\`${l}\``).join(" ")
    : "—";

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-issue-template", "huly-card"]),
    yamlScalar("huly_type", "issue-template"),
    yamlScalar("huly_issue_template_id", template.id),
    yamlScalar("huly_issue_template_title", template.title),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_note", withoutExtension(projectNoteLink)),
    yamlScalar("huly_priority", template.priority),
    yamlScalar("huly_assignee", template.assigneeName),
    yamlScalar("huly_assignee_person_id", template.assigneePersonRef),
    yamlScalar("huly_component", template.componentName),
    yamlScalar("huly_milestone", template.milestoneLabel),
    yamlScalar("huly_estimation_ms", template.estimation),
    yamlScalar("huly_estimation_display", formatDuration(template.estimation)),
    yamlScalar("huly_updated_at", toIsoDate(template.modifiedOn)),
    yamlList("huly_labels", sortedLabels),
    yamlScalar("huly_labels_display", labelsDisp),
    yamlScalar("huly_labels_inline", labelsInline),
    yamlList("tags", tags),
    "---",
    "",
    `# 📄 ${template.title}`,
    "",
    `> [!huly-header]`,
    `> 📂 ${projectDisplay} · ⚡ ${template.priority} · ${assigneeDisplay} · 🔄 ${updatedDisplay}`,
    "",
    "---",
    "",
    "## 📝 Description",
    "",
    template.description.trim() || "_No description_",
    "",
  ];

  if (template.children.length > 0) {
    lines.push("## 📑 Subtask templates", "");
    for (const child of template.children) {
      lines.push(`### ${child.title}`, "");
      lines.push(`- Priority: ${child.priority}`);
      lines.push(
        `- Assignee: ${employeeLink(
          child.assigneeName ?? "Unassigned",
          child.assigneePersonRef,
          opts.employeePathsByRef,
        )}`,
      );
      lines.push(`- Component: ${child.componentName ?? "None"}`);
      lines.push(`- Milestone: ${child.milestoneLabel ?? "None"}`);
      lines.push(`- Estimate: ${formatDuration(child.estimation)}`);
      lines.push("");
      lines.push(child.description.trim() || "_No description_");
      lines.push("");
    }
  }

  if (template.attachments.length > 0) {
    lines.push("---", "", "## 📎 Attachments", "");
    for (const att of template.attachments) {
      lines.push(`- ${formatAttachmentLink(att)}`);
    }
    lines.push("");
  }

  lines.push(...renderCommentsRich(template.comments, opts.employeePathsByRef));
  lines.push(...issueTemplateIssuesDataview(opts.rootFolder, project, template));

  return lines.join("\n");
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
  milestoneNoteLink: string | null,
  issueTemplateNoteLink: string | null,
  opts: NoteRenderOptions,
): string {
  const sortedLabels = [...issue.labels].sort(compareStrings);
  const reportSummary = summarizeTimeReports(issue.timeReports);
  const topReporter = topTimeReporter(reportSummary);
  const timeSummaryFrontmatterRows = timeSummaryFrontmatter(
    reportSummary,
    opts.employeePathsByRef,
  );
  const dueDays = dueInDays(issue.dueDate);
  const progressPct = timeProgressPct(issue.estimation, issue.reportedTime);
  const tags = unique([
    "huly",
    "huly/type/issue",
    projectTag(project),
    statusTag(issue.statusName),
    ...componentTag(issue.componentName),
    ...milestoneTag(issue.milestoneLabel),
    ...labelTags(sortedLabels),
  ]);
  const externalIssueUrl = hulyIssueUrl(opts, issue);
  const assigneeDisplay = employeeLink(
    issue.assigneeName ?? "Unassigned",
    issue.assigneePersonRef,
    opts.employeePathsByRef,
  );
  const assigneeNotePath = issue.assigneePersonRef
    ? opts.employeePathsByRef.get(issue.assigneePersonRef) ?? null
    : null;

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
    yamlScalar("huly_assignee_person_id", issue.assigneePersonRef),
    yamlScalar("huly_assignee_employee_id", issue.assigneeEmployeeRef),
    yamlScalar("huly_assignee_person_uuid", issue.assigneePersonUuid),
    yamlScalar("huly_assignee_note", assigneeNotePath ? withoutExtension(assigneeNotePath) : null),
    yamlScalar("huly_assignee_link", assigneeNotePath ? wikilink(assigneeNotePath, issue.assigneeName ?? "Unassigned") : null),
    yamlScalar("huly_component", issue.componentName),
    yamlScalar(
      "huly_component_note",
      componentNoteLink ? withoutExtension(componentNoteLink) : null,
    ),
    yamlScalar("huly_milestone_id", issue.milestoneId),
    yamlScalar("huly_milestone", issue.milestoneLabel),
    yamlScalar("huly_milestone_note", milestoneNoteLink ? withoutExtension(milestoneNoteLink) : null),
    yamlScalar(
      "huly_milestone_link",
      milestoneNoteLink && issue.milestoneLabel
        ? wikilink(milestoneNoteLink, issue.milestoneLabel)
        : null,
    ),
    yamlScalar("huly_issue_template_id", issue.issueTemplateId),
    yamlScalar("huly_issue_template_title", issue.issueTemplateTitle),
    yamlScalar(
      "huly_issue_template_note",
      issueTemplateNoteLink ? withoutExtension(issueTemplateNoteLink) : null,
    ),
    yamlScalar(
      "huly_issue_template_link",
      issueTemplateNoteLink && issue.issueTemplateTitle
        ? wikilink(issueTemplateNoteLink, issue.issueTemplateTitle)
        : null,
    ),
    yamlScalar("huly_issue_template_child_id", issue.issueTemplateChildId),
    yamlScalar("huly_due_date", toIsoDate(issue.dueDate)),
    yamlScalar("due", toDateOnlyString(issue.dueDate)),
    yamlScalar("huly_estimation_ms", issue.estimation),
    yamlScalar("huly_estimation_hours", durationToHours(issue.estimation)),
    yamlScalar("huly_estimation_minutes", durationToMinutes(issue.estimation)),
    yamlScalar("huly_reported_time_ms", issue.reportedTime),
    yamlScalar("huly_reported_time_hours", durationToHours(issue.reportedTime)),
    yamlScalar("huly_reported_time_minutes", durationToMinutes(issue.reportedTime)),
    yamlScalar("huly_remaining_time_ms", issue.remainingTime),
    yamlScalar("huly_remaining_time_hours", durationToHours(issue.remainingTime)),
    yamlScalar("huly_remaining_time_minutes", durationToMinutes(issue.remainingTime)),
    yamlScalar("huly_remaining_time_days", durationToDays(issue.remainingTime)),
    yamlScalar("huly_time_progress_pct", progressPct),
    yamlScalar("huly_has_time_reports", issue.timeReports.length > 0),
    yamlScalar("huly_time_report_count", issue.timeReports.length),
    yamlScalar("huly_time_reporter_count", reportSummary.length),
    yamlScalar("huly_is_over_estimate", issue.reportedTime > issue.estimation && issue.estimation > 0),
    yamlScalar("huly_due_in_days", dueDays),
    yamlScalar(
      "huly_is_overdue",
      issue.dueDate !== null && !issue.isClosed && (dueDays ?? 1) < 0,
    ),
    yamlScalar(
      "huly_is_due_soon",
      issue.dueDate !== null && !issue.isClosed && dueDays !== null && dueDays >= 0 && dueDays <= 7,
    ),
    yamlScalar("huly_top_reporter", topReporter?.employeeName ?? null),
    yamlScalar("huly_top_reported_time_ms", topReporter?.total ?? null),
    yamlScalar(
      "huly_top_reported_time_hours",
      topReporter ? durationToHours(topReporter.total) : null,
    ),
    yamlList("huly_time_reporters", reportSummary.map((item) => item.employeeName)),
    yamlList(
      "huly_time_by_employee_display",
      reportSummary.map((item) => `${item.employeeName}: ${formatDurationShort(item.total)}`),
    ),
    yamlObjectList("huly_time_by_employee", timeSummaryFrontmatterRows),
    yamlScalar("huly_issue_url", externalIssueUrl),
    yamlScalar("huly_estimation_display", formatDuration(issue.estimation)),
    yamlScalar("huly_reported_display", formatDuration(issue.reportedTime)),
    yamlScalar("huly_remaining_display", formatDuration(issue.remainingTime)),
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
    `- Huly: ${externalIssueUrl ? `[Open in Huly](${externalIssueUrl})` : "Not available"}`,
    `- Project: ${wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim())}`,
    `- Component: ${
      componentNoteLink && issue.componentName
        ? wikilink(componentNoteLink, issue.componentName)
        : issue.componentName ?? "None"
    }`,
    `- Milestone: ${
      milestoneNoteLink && issue.milestoneLabel
        ? wikilink(milestoneNoteLink, issue.milestoneLabel)
        : issue.milestoneLabel ?? "None"
    }`,
    `- Issue template: ${
      issueTemplateNoteLink && issue.issueTemplateTitle
        ? wikilink(issueTemplateNoteLink, issue.issueTemplateTitle)
        : issue.issueTemplateTitle ?? "None"
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
    `- Assignee: ${assigneeDisplay}`,
    `- Due date: ${toIsoDate(issue.dueDate) ?? "Not set"}`,
    `- Estimate: ${formatDuration(issue.estimation)}`,
    `- Time spent: ${formatDuration(issue.reportedTime)}`,
    `- Remaining: ${formatDuration(issue.remainingTime)}`,
    sortedLabels.length > 0 ? `- Labels: ${sortedLabels.join(", ")}` : "- Labels: None",
    "",
    ...renderIssueTimeReportsSection(issue, opts.employeePathsByRef),
    "",
    ...renderIssueHistorySection(issue.history, opts.employeePathsByRef),
    "",
    "## Description",
    "",
    issue.description.trim() || "_No description_",
    "",
    ...renderCommentsSection(issue.comments, opts.employeePathsByRef),
  ].join("\n");
}

function employeeDepartmentTags(employee: HulyEmployeeProfile): string[] {
  return employee.departments.map((department) => `huly/department/${slugify(department)}`);
}

function employeeStatusTags(employee: HulyEmployeeProfile): string[] {
  return employee.vacations.length > 0 ? ["huly/employee/has-vacation"] : [];
}

function employeeMatchesTimeReport(employee: HulyEmployeeProfile, report: HulyTimeReport): boolean {
  if (employee.personRef && report.employeeRef && employee.personRef === report.employeeRef) {
    return true;
  }
  if (
    employee.personUuid &&
    report.employeePersonUuid &&
    employee.personUuid === report.employeePersonUuid
  ) {
    return true;
  }
  return false;
}

function issueLinkById(issue: HulyIssue, issuePathsById: ReadonlyMap<string, string>): string {
  const path = issuePathsById.get(issue.id);
  const alias = `${issue.identifier} ${issue.title}`.trim();
  return path ? wikilink(path, alias) : alias;
}

function employeeNoteDataviewSection(employee: HulyEmployeeProfile, rootFolder: string): string[] {
  return [
    "## Assigned Tasks (live)",
    "",
    "```dataview",
    "TABLE WITHOUT ID",
    '  file.link AS "Task",',
    '  huly_project_identifier AS "Project",',
    '  huly_status AS "Status",',
    '  due AS "Due",',
    '  huly_updated_display AS "Updated"',
    `FROM "${rootFolder}"`,
    `WHERE huly_type = "issue" AND huly_assignee_person_id = "${employee.personRef}"`,
    "SORT huly_is_closed ASC, due ASC, huly_updated_at DESC",
    "```",
  ];
}

function renderEmployeeNote(
  employee: HulyEmployeeProfile,
  assignedIssues: HulyIssue[],
  timeTrackedIssues: HulyIssue[],
  issuePathsById: ReadonlyMap<string, string>,
  opts: NoteRenderOptions,
): string {
  const tags = unique([
    "huly",
    "huly/type/employee",
    ...employeeDepartmentTags(employee),
    ...employeeStatusTags(employee),
  ]);
  const activeAssigned = assignedIssues.filter((issue) => !issue.isClosed);
  const doneAssigned = assignedIssues.filter((issue) => issue.statusName === "Done");
  const canceledAssigned = assignedIssues.filter((issue) => issue.statusName === "Canceled");
  const uniqueProjects = new Set(
    [...assignedIssues, ...timeTrackedIssues].map((issue) => issue.projectIdentifier),
  ).size;
  const totalReportedMs = timeTrackedIssues.reduce((sum, issue) => {
    return (
      sum +
      issue.timeReports.reduce(
        (issueSum, report) =>
          employeeMatchesTimeReport(employee, report) ? issueSum + report.value : issueSum,
        0,
      )
    );
  }, 0);
  const sortedStatuses = [...employee.statuses].sort(
    (left, right) =>
      (left.dueDate ?? Number.MAX_SAFE_INTEGER) - (right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
      compareStrings(left.name, right.name),
  );
  const sortedVacations = [...employee.vacations].sort(
    (left, right) =>
      (left.startDate ?? left.dueDate ?? Number.MAX_SAFE_INTEGER) -
        (right.startDate ?? right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
      (left.dueDate ?? Number.MAX_SAFE_INTEGER) - (right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
      compareStrings(left.name, right.name),
  );
  const sortedAssigned = [...assignedIssues].sort(
    (left, right) =>
      Number(left.isClosed) - Number(right.isClosed) ||
      (left.dueDate ?? Number.MAX_SAFE_INTEGER) - (right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
      right.modifiedOn - left.modifiedOn,
  );
  const sortedTimeTracked = [...timeTrackedIssues].sort((left, right) => right.modifiedOn - left.modifiedOn);

  const lines = [
    "---",
    yamlList("cssclasses", ["huly-employee", "huly-card"]),
    yamlScalar("huly_type", "employee"),
    yamlScalar("huly_person_ref", employee.personRef),
    yamlScalar("huly_employee_ref", employee.employeeRef),
    yamlScalar("huly_person_uuid", employee.personUuid),
    yamlScalar("huly_employee_name", employee.displayName),
    yamlScalar("huly_employee_active", employee.active),
    yamlScalar("huly_employee_role", employee.role),
    yamlScalar("huly_employee_position", employee.position),
    yamlScalar("huly_city", employee.city),
    yamlScalar("huly_country", employee.country),
    yamlScalar("huly_birthday", toIsoDate(employee.birthday)),
    yamlScalar("huly_email", employee.email),
    yamlScalar("huly_phone", employee.phone),
    yamlScalar("huly_website", employee.website),
    yamlScalar("huly_profile_public", employee.isProfilePublic),
    yamlScalar("huly_profile_ref", employee.profileRef),
    yamlScalar("huly_avatar_type", employee.avatarType),
    yamlScalar("huly_avatar_url", employee.avatarUrl),
    yamlScalar("huly_avatar_color", employee.avatarColor),
    yamlScalar("huly_primary_social_type", employee.primarySocialType),
    yamlScalar("huly_primary_social_value", employee.primarySocialValue),
    yamlScalar("huly_primary_social_display", employee.primarySocialDisplay),
    yamlList("huly_social_strings", employee.socialStrings),
    yamlList("huly_department_names", employee.departments),
    yamlList("huly_org_unit_names", employee.departments),
    yamlObjectList(
      "huly_channels",
      employee.channels.map((channel) => ({
        channel_id: channel.id,
        provider: channel.provider,
        kind: channel.kind,
        value: channel.value,
      })),
    ),
    yamlObjectList(
      "huly_employee_statuses",
      sortedStatuses.map((status) => ({
        status_id: status.id,
        status_name: status.name,
        due_date: toIsoDate(status.dueDate),
      })),
    ),
    yamlObjectList(
      "huly_employee_vacations",
      sortedVacations.map((vacation) => ({
        vacation_id: vacation.id,
        type_id: vacation.typeId,
        vacation_name: vacation.name,
        start_date: toIsoDate(vacation.startDate),
        due_date: toIsoDate(vacation.dueDate),
        department_id: vacation.departmentId,
        department_name: vacation.departmentName,
        description: vacation.description || null,
      })),
    ),
    yamlScalar("huly_assigned_task_count", assignedIssues.length),
    yamlScalar("huly_assigned_open_task_count", activeAssigned.length),
    yamlScalar("huly_assigned_done_task_count", doneAssigned.length),
    yamlScalar("huly_assigned_canceled_task_count", canceledAssigned.length),
    yamlScalar("huly_time_task_count", timeTrackedIssues.length),
    yamlScalar("huly_total_reported_time_ms", totalReportedMs),
    yamlScalar("huly_total_reported_time_hours", durationToHours(totalReportedMs)),
    yamlScalar("huly_total_reported_time_minutes", durationToMinutes(totalReportedMs)),
    yamlScalar("huly_project_count", uniqueProjects),
    yamlList("tags", tags),
    "---",
    "",
    `# 👤 ${employee.displayName}`,
    "",
    "## Profile",
    "",
    `- Person ref: ${employee.personRef}`,
    `- Employee ref: ${employee.employeeRef ?? "—"}`,
    `- Person UUID: ${employee.personUuid ?? "—"}`,
    `- Active: ${employee.active ? "Yes" : "No"}`,
    `- Role: ${employee.role ?? "—"}`,
    `- Position: ${employee.position ?? "—"}`,
    `- Email: ${employee.email ?? "—"}`,
    `- Phone: ${employee.phone ?? "—"}`,
    `- Website: ${employee.website ?? "—"}`,
    `- City: ${employee.city ?? "—"}`,
    `- Country: ${employee.country ?? "—"}`,
    `- Birthday: ${toIsoDate(employee.birthday) ?? "—"}`,
    `- Primary social: ${employee.primarySocialDisplay ?? employee.primarySocialValue ?? "—"}`,
    employee.avatarUrl ? `- Avatar URL: ${employee.avatarUrl}` : "- Avatar URL: —",
    "",
    "## Bio",
    "",
    employee.bio.trim() || "_No bio_",
    "",
    "## Departments / Teams",
    "",
    ...(employee.departments.length > 0
      ? employee.departments.map((department) => `- ${department}`)
      : ["_No org unit data_"]),
    "",
    "## Statuses",
    "",
    ...(sortedStatuses.length > 0
      ? sortedStatuses.map((status) => `- ${status.name}${status.dueDate ? ` · until ${toIsoDate(status.dueDate)}` : ""}`)
      : ["_No employee statuses_"]),
    "",
    "## Vacations / Absences",
    "",
    ...(sortedVacations.length > 0
      ? sortedVacations.map((vacation) => {
          const range = formatDateRange(vacation.startDate, vacation.dueDate);
          const department = vacation.departmentName ? ` · ${vacation.departmentName}` : "";
          const description = vacation.description ? ` · ${vacation.description}` : "";
          return `- ${vacation.name}${range ? ` · ${range}` : ""}${department}${description}`;
        })
      : ["_No HR requests found in Huly_"]),
    "",
    "## Channels",
    "",
    ...(employee.channels.length > 0
      ? employee.channels.map((channel) => `- ${channel.kind ?? channel.provider}: ${channel.value}`)
      : ["_No contact channels_"]),
    "",
    "## Social Links",
    "",
    ...(Object.entries(employee.socialLinks).length > 0
      ? Object.entries(employee.socialLinks)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([kind, value]) => `- ${kind}: ${value}`)
      : ["_No public social links_"]),
    "",
    "## Task Summary",
    "",
    `- Assigned tasks: ${assignedIssues.length}`,
    `- Open assigned tasks: ${activeAssigned.length}`,
    `- Done assigned tasks: ${doneAssigned.length}`,
    `- Time-tracked tasks: ${timeTrackedIssues.length}`,
    `- Projects involved: ${uniqueProjects}`,
    `- Total reported time: ${formatDuration(totalReportedMs)}`,
    "",
    ...employeeNoteDataviewSection(employee, opts.rootFolder),
    "",
    "## Assigned Tasks (snapshot)",
    "",
    ...(sortedAssigned.length > 0
      ? sortedAssigned.map((issue) => `- ${issueLinkById(issue, issuePathsById)} · ${issue.statusName}`)
      : ["_No assigned tasks_"]),
    "",
    "## Time-tracked Tasks (snapshot)",
    "",
    ...(sortedTimeTracked.length > 0
      ? sortedTimeTracked.map((issue) => {
          const issueTime = issue.timeReports.reduce(
            (sum, report) =>
              employeeMatchesTimeReport(employee, report) ? sum + report.value : sum,
            0,
          );
          return `- ${issueLinkById(issue, issuePathsById)} · ${formatDuration(issueTime)}`;
        })
      : ["_No time-tracked tasks_"]),
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Render dispatch — choose renderer based on settings
// ---------------------------------------------------------------------------

function dispatchProjectNote(
  project: HulyProject,
  issues: HulyIssue[],
  componentLinks: string[],
  issueLinks: string[],
  milestoneLinks: string[],
  issueTemplateLinks: string[],
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichProjectNote(
      project,
      issues,
      componentLinks,
      issueLinks,
      milestoneLinks,
      issueTemplateLinks,
      opts,
    );
  }
  return renderProjectNote(
    project,
    issues,
    componentLinks,
    issueLinks,
    milestoneLinks,
    issueTemplateLinks,
    opts,
  );
}

function dispatchComponentNote(
  project: HulyProject,
  component: HulyComponent,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichComponentNote(project, component, projectNoteLink, opts);
  }
  return renderComponentNote(project, component, projectNoteLink, opts);
}

function dispatchIssueNote(
  project: HulyProject,
  issue: HulyIssue,
  projectNoteLink: string,
  componentNoteLink: string | null,
  parentLinks: string[],
  milestoneNoteLink: string | null,
  issueTemplateNoteLink: string | null,
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichIssueNote(
      project,
      issue,
      projectNoteLink,
      componentNoteLink,
      parentLinks,
      milestoneNoteLink,
      issueTemplateNoteLink,
      opts,
    );
  }
  return renderIssueNote(
    project,
    issue,
    projectNoteLink,
    componentNoteLink,
    parentLinks,
    milestoneNoteLink,
    issueTemplateNoteLink,
    opts,
  );
}

function dispatchMilestoneNote(
  project: HulyProject,
  milestone: HulyMilestone,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichMilestoneNote(project, milestone, projectNoteLink, opts);
  }
  return renderMilestoneNote(project, milestone, projectNoteLink, opts);
}

function dispatchIssueTemplateNote(
  project: HulyProject,
  template: HulyIssueTemplate,
  projectNoteLink: string,
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichIssueTemplateNote(project, template, projectNoteLink, opts);
  }
  return renderIssueTemplateNote(project, template, projectNoteLink, opts);
}

function dispatchEmployeeNote(
  employee: HulyEmployeeProfile,
  assignedIssues: HulyIssue[],
  timeTrackedIssues: HulyIssue[],
  issuePathsById: ReadonlyMap<string, string>,
  opts: NoteRenderOptions,
): string {
  return renderEmployeeNote(employee, assignedIssues, timeTrackedIssues, issuePathsById, opts);
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

async function renameFileIfNeeded(
  app: App,
  currentFile: TFile | null,
  targetPath: string,
): Promise<void> {
  if (!currentFile || currentFile.path === targetPath) {
    return;
  }

  if (app.vault.getAbstractFileByPath(targetPath)) {
    return;
  }

  await app.fileManager.renameFile(currentFile, targetPath);
}

const ATTACHMENT_DOWNLOAD_CONCURRENCY = 4;

function attachmentLocalPath(rootFolder: string, attachment: HulyAttachment): string {
  const shortId = attachment.id.slice(-8);
  const safeName = sanitizePathPart(attachment.name, "file");
  return joinVaultPath(rootFolder, "_attachments", `${shortId}-${safeName}`);
}

async function downloadAttachmentToVault(
  vault: Vault,
  localPath: string,
  remoteUrl: string,
  expectedSize: number,
  token: string,
): Promise<boolean> {
  const existing = vault.getAbstractFileByPath(localPath);
  if (existing instanceof TFile && existing.stat.size === expectedSize) {
    return true;
  }

  try {
    const response = await requestUrl({
      url: remoteUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) {
      return false;
    }
    const data = response.arrayBuffer;
    if (existing instanceof TFile) {
      await vault.modifyBinary(existing, data);
    } else {
      await vault.createBinary(localPath, data);
    }
    return true;
  } catch {
    return false;
  }
}

function collectAllAttachments(
  issues: HulyIssue[],
  components: HulyComponent[],
  milestones: HulyMilestone[],
  issueTemplates: HulyIssueTemplate[],
): HulyAttachment[] {
  const seen = new Set<string>();
  const result: HulyAttachment[] = [];
  const add = (att: HulyAttachment) => {
    if (!seen.has(att.id)) {
      seen.add(att.id);
      result.push(att);
    }
  };
  for (const issue of issues) {
    issue.attachments.forEach(add);
    for (const comment of issue.comments) {
      comment.attachments.forEach(add);
    }
  }
  for (const component of components) {
    component.attachments.forEach(add);
    for (const comment of component.comments) {
      comment.attachments.forEach(add);
    }
  }
  for (const milestone of milestones) {
    milestone.attachments.forEach(add);
    for (const comment of milestone.comments) {
      comment.attachments.forEach(add);
    }
  }
  for (const template of issueTemplates) {
    template.attachments.forEach(add);
    for (const comment of template.comments) {
      comment.attachments.forEach(add);
    }
  }
  return result;
}

export class VaultSyncService {
  constructor(private readonly app: App) {}

  async sync(
    settings: HulySyncSettings,
    projects: HulyProject[],
    components: HulyComponent[],
    issues: HulyIssue[],
    employees: HulyEmployeeProfile[],
    milestones: HulyMilestone[],
    issueTemplates: HulyIssueTemplate[],
    _options: SyncOptions,
    filesToken: string,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncStats> {
    const rootFolder = settings.targetFolder.trim() || "huly";
    const projectNoteFileNameMode = settings.projectNoteFileNameMode ?? "identifier-and-name";
    const issueNoteFileNameMode = settings.issueNoteFileNameMode ?? "identifier-only";
    activeWorkdayHours =
      Number.isFinite(settings.workdayHours) && settings.workdayHours > 0
        ? settings.workdayHours
        : DEFAULT_WORKDAY_HOURS;
    const employeePathsByRef = buildEmployeeNotePaths(rootFolder, employees);
    const renderOpts: NoteRenderOptions = {
      noteStyle: settings.noteStyle ?? "rich",
      useMetaBind: settings.useMetaBind ?? true,
      rootFolder,
      hulyUrl: settings.hulyUrl,
      workspace: settings.workspace,
      employeePathsByRef,
    };
    const PROGRESS_THROTTLE_MS = 150;
    let lastProgressTime = 0;
    let pendingProgress: SyncProgress | null = null;
    const throttledProgress = (progress: SyncProgress): void => {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        lastProgressTime = now;
        pendingProgress = null;
        onProgress(progress);
      } else {
        pendingProgress = progress;
      }
    };
    const flushProgress = (): void => {
      if (pendingProgress && onProgress) {
        onProgress(pendingProgress);
        pendingProgress = null;
      }
    };

    await ensureFolder(this.app.vault, rootFolder);
    await ensureFolder(this.app.vault, employeeFolderPath(rootFolder));

    const attachmentsFolder = joinVaultPath(rootFolder, "_attachments");
    await ensureFolder(this.app.vault, attachmentsFolder);

    const allAttachments = collectAllAttachments(issues, components, milestones, issueTemplates);
    const localPathByAttId = new Map<string, string>();
    const totalAttachments = allAttachments.length;
    let downloadedAttachments = 0;

    if (totalAttachments > 0) {
      onProgress?.({
        active: true,
        phase: "download",
        current: 0,
        total: totalAttachments,
        percentage: 0,
        message: `Downloading attachments: 0/${totalAttachments}`,
      });
    }

    await mapLimit(allAttachments, ATTACHMENT_DOWNLOAD_CONCURRENCY, async (att) => {
      const localPath = attachmentLocalPath(rootFolder, att);
      const ok = await downloadAttachmentToVault(
        this.app.vault,
        localPath,
        att.url,
        att.size,
        filesToken,
      );
      if (ok) {
        localPathByAttId.set(att.id, localPath);
        att.url = localPath;
      }
      downloadedAttachments++;
      throttledProgress({
        active: true,
        phase: "download",
        current: downloadedAttachments,
        total: totalAttachments,
        percentage: Math.round((downloadedAttachments / totalAttachments) * 100),
        message: `Attachment: ${att.name}`,
      });
    });
    flushProgress();

    if (renderOpts.noteStyle === "rich" && renderOpts.useMetaBind) {
      await writeTemplateFiles(this.app.vault, rootFolder);
    }

    const componentsByProject = new Map<string, HulyComponent[]>();
    const issuesByProject = new Map<string, HulyIssue[]>();
    const milestonesByProject = new Map<string, HulyMilestone[]>();
    const issueTemplatesByProject = new Map<string, HulyIssueTemplate[]>();
    const issuePathsById = new Map<string, string>();
    const componentPathsById = new Map<string, string>();
    const milestonePathsById = new Map<string, string>();
    const issueTemplatePathsById = new Map<string, string>();
    const totalWrites =
      projects.length +
      components.length +
      issues.length +
      employees.length +
      milestones.length +
      issueTemplates.length;
    let completedWrites = 0;

    const reportWriteProgress = (message: string): void => {
      throttledProgress({
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

    for (const milestone of milestones) {
      const existing = milestonesByProject.get(milestone.projectId) ?? [];
      existing.push(milestone);
      milestonesByProject.set(milestone.projectId, existing);
    }

    for (const template of issueTemplates) {
      const existing = issueTemplatesByProject.get(template.projectId) ?? [];
      existing.push(template);
      issueTemplatesByProject.set(template.projectId, existing);
    }

    for (const project of projects) {
      for (const component of componentsByProject.get(project.id) ?? []) {
        componentPathsById.set(component.id, componentNotePath(rootFolder, project, component));
      }

      for (const issue of issuesByProject.get(project.id) ?? []) {
        issuePathsById.set(
          issue.id,
          issueNotePath(rootFolder, project, issue, issueNoteFileNameMode),
        );
      }

      for (const milestone of milestonesByProject.get(project.id) ?? []) {
        milestonePathsById.set(milestone.id, milestoneNotePath(rootFolder, project, milestone));
      }

      for (const template of issueTemplatesByProject.get(project.id) ?? []) {
        issueTemplatePathsById.set(
          template.id,
          issueTemplateNotePath(rootFolder, project, template),
        );
      }
    }

    for (const project of projects) {
      const projectFolder = projectFolderPath(rootFolder, project);
      const tasksFolder = projectTasksFolderPath(rootFolder, project);
      const componentsFolder = projectComponentsFolderPath(rootFolder, project);
      const milestonesFolder = projectMilestonesFolderPath(rootFolder, project);
      const templatesFolder = projectIssueTemplatesFolderPath(rootFolder, project);
      const projectNote = projectNotePath(rootFolder, project, projectNoteFileNameMode);
      const legacyProjectNote = joinVaultPath(projectFolder, "_project.md");
      const projectComponents = componentsByProject.get(project.id) ?? [];
      const projectIssues = issuesByProject.get(project.id) ?? [];
      const projectMilestones = milestonesByProject.get(project.id) ?? [];
      const projectIssueTemplates = issueTemplatesByProject.get(project.id) ?? [];

      await ensureFolder(this.app.vault, projectFolder);
      await ensureFolder(this.app.vault, tasksFolder);
      await ensureFolder(this.app.vault, componentsFolder);
      await ensureFolder(this.app.vault, milestonesFolder);
      await ensureFolder(this.app.vault, templatesFolder);
      await renameFileIfNeeded(
        this.app,
        findExistingProjectNote(
          this.app.vault,
          projectFolder,
          projectNoteCandidateStems(project),
          projectNote,
        ),
        projectNote,
      );
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
            issuePathsById.get(issue.id) ??
              issueNotePath(rootFolder, project, issue, issueNoteFileNameMode),
            `${issue.identifier} ${issue.title}`.trim(),
          ),
        );
      const milestoneLinks = [...projectMilestones]
        .sort((left, right) => compareStrings(left.label, right.label))
        .map((milestone) =>
          wikilink(
            milestonePathsById.get(milestone.id) ??
              milestoneNotePath(rootFolder, project, milestone),
            milestone.label,
          ),
        );
      const issueTemplateLinks = [...projectIssueTemplates]
        .sort((left, right) => compareStrings(left.title, right.title))
        .map((template) =>
          wikilink(
            issueTemplatePathsById.get(template.id) ??
              issueTemplateNotePath(rootFolder, project, template),
            template.title,
          ),
        );

      await upsertFile(
        this.app.vault,
        projectNote,
        dispatchProjectNote(
          project,
          projectIssues,
          componentLinks,
          issueLinks,
          milestoneLinks,
          issueTemplateLinks,
          renderOpts,
        ),
      );
      completedWrites += 1;
      reportWriteProgress(`Project note: ${project.identifier}`);

      await mapLimit(projectComponents, WRITE_CONCURRENCY, async (component) => {
        const componentPath =
          componentPathsById.get(component.id) ?? componentNotePath(rootFolder, project, component);
        await upsertFile(
          this.app.vault,
          componentPath,
          dispatchComponentNote(project, component, projectNote, renderOpts),
        );
        completedWrites += 1;
        reportWriteProgress(`Component: ${project.identifier} / ${component.label}`);
      });

      await mapLimit(projectIssues, WRITE_CONCURRENCY, async (issue) => {
        const issuePath =
          issuePathsById.get(issue.id) ??
          issueNotePath(rootFolder, project, issue, issueNoteFileNameMode);
        const componentNoteLink = issue.componentId
          ? componentPathsById.get(issue.componentId) ?? null
          : null;
        const milestoneNoteLink = issue.milestoneId
          ? milestonePathsById.get(issue.milestoneId) ?? null
          : null;
        const issueTemplateNoteLink = issue.issueTemplateId
          ? issueTemplatePathsById.get(issue.issueTemplateId) ?? null
          : null;
        const linksToParents = parentIssueLinks(issue.parents, issuePathsById);

        await renameFileIfNeeded(
          this.app,
          findExistingIssueNote(
            this.app.vault,
            tasksFolder,
            issueNoteCandidateStems(issue),
            issuePath,
          ),
          issuePath,
        );

        await upsertFile(
          this.app.vault,
          issuePath,
          dispatchIssueNote(
            project,
            issue,
            projectNote,
            componentNoteLink,
            linksToParents,
            milestoneNoteLink,
            issueTemplateNoteLink,
            renderOpts,
          ),
        );
        completedWrites += 1;
        reportWriteProgress(`Issue: ${issue.identifier}`);
      });

      await mapLimit(projectMilestones, WRITE_CONCURRENCY, async (milestone) => {
        const milestonePath =
          milestonePathsById.get(milestone.id) ??
          milestoneNotePath(rootFolder, project, milestone);
        await renameFileIfNeeded(
          this.app,
          findExistingMilestoneNote(
            this.app.vault,
            milestonesFolder,
            milestoneNoteCandidateStems(milestone),
            milestonePath,
          ),
          milestonePath,
        );
        await upsertFile(
          this.app.vault,
          milestonePath,
          dispatchMilestoneNote(project, milestone, projectNote, renderOpts),
        );
        completedWrites += 1;
        reportWriteProgress(`Milestone: ${project.identifier} / ${milestone.label}`);
      });

      await mapLimit(projectIssueTemplates, WRITE_CONCURRENCY, async (template) => {
        const templatePath =
          issueTemplatePathsById.get(template.id) ??
          issueTemplateNotePath(rootFolder, project, template);
        await renameFileIfNeeded(
          this.app,
          findExistingIssueTemplateNote(
            this.app.vault,
            templatesFolder,
            issueTemplateNoteCandidateStems(template),
            templatePath,
          ),
          templatePath,
        );
        await upsertFile(
          this.app.vault,
          templatePath,
          dispatchIssueTemplateNote(project, template, projectNote, renderOpts),
        );
        completedWrites += 1;
        reportWriteProgress(`Issue template: ${project.identifier} / ${template.title}`);
      });
    }

    const employeesFolder = employeeFolderPath(rootFolder);
    const issuesByAssigneeRef = new Map<string, HulyIssue[]>();
    const timeTrackedIssuesByEmployeeRef = new Map<string, HulyIssue[]>();
    for (const issue of issues) {
      if (issue.assigneePersonRef) {
        const existing = issuesByAssigneeRef.get(issue.assigneePersonRef) ?? [];
        existing.push(issue);
        issuesByAssigneeRef.set(issue.assigneePersonRef, existing);
      }
      for (const report of issue.timeReports) {
        if (report.employeeRef) {
          if (!timeTrackedIssuesByEmployeeRef.has(report.employeeRef)) {
            timeTrackedIssuesByEmployeeRef.set(report.employeeRef, []);
          }
          const list = timeTrackedIssuesByEmployeeRef.get(report.employeeRef)!;
          if (!list.includes(issue)) {
            list.push(issue);
          }
        }
        if (report.employeePersonUuid) {
          if (!timeTrackedIssuesByEmployeeRef.has(report.employeePersonUuid)) {
            timeTrackedIssuesByEmployeeRef.set(report.employeePersonUuid, []);
          }
          const list = timeTrackedIssuesByEmployeeRef.get(report.employeePersonUuid)!;
          if (!list.includes(issue)) {
            list.push(issue);
          }
        }
      }
    }

    for (const employee of employees) {
      const employeePath =
        employeePathsByRef.get(employee.personRef) ??
        joinVaultPath(employeeFolderPath(rootFolder), employeeNoteFileName(employee));
      await renameFileIfNeeded(
        this.app,
        await findExistingEmployeeNote(this.app.vault, employeesFolder, employee, employeePath),
        employeePath,
      );

      const assignedIssues = issuesByAssigneeRef.get(employee.personRef) ?? [];
      const timeTrackedIssues = [
        ...(employee.personRef ? timeTrackedIssuesByEmployeeRef.get(employee.personRef) ?? [] : []),
        ...(employee.personUuid ? timeTrackedIssuesByEmployeeRef.get(employee.personUuid) ?? [] : []),
      ].filter((issue, idx, arr) => arr.indexOf(issue) === idx);

      await upsertFile(
        this.app.vault,
        employeePath,
        dispatchEmployeeNote(employee, assignedIssues, timeTrackedIssues, issuePathsById, renderOpts),
      );
      completedWrites += 1;
      reportWriteProgress(`Employee: ${employee.displayName}`);
    }
    flushProgress();

    return {
      projectCount: projects.length,
      componentCount: components.length,
      issueCount: issues.length,
      employeeCount: employees.length,
      milestoneCount: milestones.length,
      issueTemplateCount: issueTemplates.length,
    };
  }
}
