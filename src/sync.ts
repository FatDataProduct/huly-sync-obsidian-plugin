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
  NoteStyle,
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
}

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
    "| 🏷️ **Labels** | `VIEW[{huly_labels_display}][text]` |",
    "| 🔄 **Updated** | `VIEW[{huly_updated_display}][text]` |",
    "",
    "---",
    "",
    "##### Relations",
    "",
    "| | |",
    "|:--|:--|",
    "| 📂 **Project** | `VIEW[{huly_project_link}][text(renderMarkdown)]` |",
    "| 🧩 **Component** | `VIEW[{huly_component_link}][text(renderMarkdown)]` |",
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
  componentLinks: string[],
  issueLinks: string[],
  opts: NoteRenderOptions,
): string {
  const tags = unique(["huly", "huly/type/project", projectTag(project)]);
  const tasksFolder = projectTasksFolderPath(opts.rootFolder, project);
  const tplPath = withoutExtension(joinVaultPath(opts.rootFolder, "_templates/project_header"));
  const mb = opts.useMetaBind;

  const lines: string[] = [
    "---",
    yamlList("cssclasses", ["huly-project", "huly-card"]),
    yamlScalar("huly_type", "project"),
    yamlScalar("huly_project_id", project.id),
    yamlScalar("huly_project_identifier", project.identifier),
    yamlScalar("huly_project_name", project.name),
    yamlScalar("huly_component_count", componentLinks.length),
    yamlScalar("huly_task_count", issueLinks.length),
    yamlList("tags", tags),
    "---",
    "",
    `# 📂 ${project.identifier} ${project.name}`.trim(),
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
    "> >   huly_priority AS \"Priority\"",
    `> > FROM "${tasksFolder}"`,
    "> > SORT huly_priority DESC",
    "> > ```",
    "",
  );

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
      const meta = [att.mimeType, humanFileSize(att.size)]
        .filter((p) => p.trim().length > 0)
        .join(", ");
      lines.push(`- [${att.name}](${att.url})${meta ? ` _(${meta})_` : ""}`);
    }
    lines.push("");
  }

  // -- Comments --
  lines.push(...renderCommentsRich(component.comments));

  return lines.join("\n");
}

function renderRichIssueNote(
  project: HulyProject,
  issue: HulyIssue,
  projectNoteLink: string,
  componentNoteLink: string | null,
  parentLinks: string[],
  opts: NoteRenderOptions,
): string {
  const tags = unique([
    "huly",
    "huly/type/issue",
    projectTag(project),
    statusTag(issue.statusName),
    ...componentTag(issue.componentName),
    ...labelTags(issue.labels),
  ]);

  const mb = opts.useMetaBind;
  const pEmoji = priorityEmoji(issue.priority, issue.isClosed);
  const variant = issueHeaderVariant(issue.priority, issue.isClosed);

  const statusDisp = `${statusDot(issue.statusName)} ${issue.statusName}`;
  const priorityDisp = `${pEmoji} ${issue.priority}`;
  const dueDisp = issue.dueDate !== null ? formatReadableDate(issue.dueDate) : "Not set";
  const updatedDisp = formatReadableDatetime(issue.modifiedOn);
  const labelsDisp = issue.labels.length > 0 ? issue.labels.join(", ") : "None";
  const labelsInline = issue.labels.length > 0
    ? issue.labels.map((l) => `\`${l}\``).join(" ")
    : "—";

  const componentDisplay = componentNoteLink && issue.componentName
    ? wikilink(componentNoteLink, issue.componentName)
    : issue.componentName ?? "—";
  const projectLinkMd = wikilink(projectNoteLink, `${project.identifier} ${project.name}`.trim());
  const parentLinkMd = parentLinks.length > 0 ? parentLinks.join(", ") : "None";

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
    yamlScalar("huly_component", issue.componentName),
    yamlScalar("huly_component_note", componentNoteLink ? withoutExtension(componentNoteLink) : null),
    yamlScalar("huly_due_date", toIsoDate(issue.dueDate)),
    yamlScalar("huly_updated_at", toIsoDate(issue.modifiedOn)),
    yamlScalar("huly_is_closed", issue.isClosed),
    yamlList("huly_labels", issue.labels),
    // display properties for Meta Bind VIEW fields
    yamlScalar("huly_status_display", statusDisp),
    yamlScalar("huly_priority_display", priorityDisp),
    yamlScalar("huly_due_display", dueDisp),
    yamlScalar("huly_updated_display", updatedDisp),
    yamlScalar("huly_labels_display", labelsDisp),
    yamlScalar("huly_project_link", projectLinkMd),
    yamlScalar("huly_component_link", componentDisplay),
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
  const assigneeStr = issue.assigneeName ? `👤 ${issue.assigneeName}` : "👤 Unassigned";
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
      const meta = [att.mimeType, humanFileSize(att.size)]
        .filter((p) => p.trim().length > 0)
        .join(", ");
      lines.push(L2(`- [${att.name}](${att.url})${meta ? ` _(${meta})_` : ""}`));
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
      lines.push(L2(""), L2("---"), L2(""));
      lines.push(L2(`**💬 ${comment.authorName}** · _${cDate}_`));
      lines.push(L2(""));
      lines.push(...contentToL2(cBody));
      if (comment.attachments.length > 0) {
        lines.push(L2(""));
        for (const att of comment.attachments) {
          const meta = [att.mimeType, humanFileSize(att.size)]
            .filter((p) => p.trim().length > 0)
            .join(", ");
          lines.push(L2(`- [${att.name}](${att.url})${meta ? ` _(${meta})_` : ""}`));
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
      L2(`| 👤 **Assignee** | ${issue.assigneeName ?? "Unassigned"} |`),
      L2(`| 📅 **Due Date** | ${dueDisp} |`),
      L2(`| 🏷️ **Labels** | ${labelsInline} |`),
      L2(`| 🔄 **Updated** | ${updatedDisp} |`),
      L2(""),
      L2("---"),
      L2(""),
      L2("##### Relations"),
      L2(""),
      L2("| | |"),
      L2("|:--|:--|"),
      L2(`| 📂 **Project** | ${projectLinkMd} |`),
      L2(`| 🧩 **Component** | ${componentDisplay} |`),
      L2(`| ⬆️ **Parent** | ${parentLinkMd} |`),
    );
  }

  lines.push("");

  return lines.join("\n");
}

/** Full-width comments for component notes (not inside a nested callout) */
function renderCommentsRich(comments: HulyComment[]): string[] {
  if (comments.length === 0) {
    return ["---", "", "## 💬 Comments", "", "_No comments_"];
  }

  const blocks: string[] = ["---", "", `## 💬 Comments (${comments.length})`, ""];

  for (const comment of comments) {
    const date = formatReadableDatetime(comment.updatedAt);
    const body = comment.body.trim() || "_Empty comment_";

    blocks.push(
      "---",
      "",
      `**💬 ${comment.authorName}** · _${date}_`,
      "",
      body,
      "",
    );

    if (comment.attachments.length > 0) {
      for (const att of comment.attachments) {
        const meta = [att.mimeType, humanFileSize(att.size)]
          .filter((p) => p.trim().length > 0)
          .join(", ");
        blocks.push(`- [${att.name}](${att.url})${meta ? ` _(${meta})_` : ""}`);
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

// ---------------------------------------------------------------------------
// Render dispatch — choose renderer based on settings
// ---------------------------------------------------------------------------

function dispatchProjectNote(
  project: HulyProject,
  componentLinks: string[],
  issueLinks: string[],
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichProjectNote(project, componentLinks, issueLinks, opts);
  }
  return renderProjectNote(project, componentLinks, issueLinks);
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
  return renderComponentNote(project, component, projectNoteLink);
}

function dispatchIssueNote(
  project: HulyProject,
  issue: HulyIssue,
  projectNoteLink: string,
  componentNoteLink: string | null,
  parentLinks: string[],
  opts: NoteRenderOptions,
): string {
  if (opts.noteStyle === "rich") {
    return renderRichIssueNote(project, issue, projectNoteLink, componentNoteLink, parentLinks, opts);
  }
  return renderIssueNote(project, issue, projectNoteLink, componentNoteLink, parentLinks);
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
    const renderOpts: NoteRenderOptions = {
      noteStyle: settings.noteStyle ?? "rich",
      useMetaBind: settings.useMetaBind ?? true,
      rootFolder,
    };
    await ensureFolder(this.app.vault, rootFolder);

    if (renderOpts.noteStyle === "rich" && renderOpts.useMetaBind) {
      await writeTemplateFiles(this.app.vault, rootFolder);
    }

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
        dispatchProjectNote(project, componentLinks, issueLinks, renderOpts),
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
          issuePathsById.get(issue.id) ?? issueNotePath(rootFolder, project, issue);
        const componentNoteLink = issue.componentId
          ? componentPathsById.get(issue.componentId) ?? null
          : null;
        const linksToParents = parentIssueLinks(issue.parents, issuePathsById);

        await upsertFile(
          this.app.vault,
          issuePath,
          dispatchIssueNote(
            project,
            issue,
            projectNote,
            componentNoteLink,
            linksToParents,
            renderOpts,
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
