import {
  BrowserWebSocketFactory,
  connect,
  getWorkspaceToken,
  loadServerConfig,
  type PlatformClient,
} from "@hcengineering/api-client";
import attachmentModule from "@hcengineering/attachment";
import chunterModule from "@hcengineering/chunter";
import contactModule from "@hcengineering/contact";
import { SortingOrder, type Ref } from "@hcengineering/core";
import tagsModule from "@hcengineering/tags";
import { jsonToHTML, markupToJSON, stripTags } from "@hcengineering/text";
import { markupToMarkdown } from "@hcengineering/text-markdown";
import trackerModule, {
  type IssueStatus,
} from "@hcengineering/tracker";

import type {
  ConnectionConfig,
  HulyAttachment,
  HulyComment,
  HulyComponent,
  HulyIssue,
  HulyIssueParent,
  HulyProject,
} from "./types";
import { mapLimit } from "./async";

type LookupIssue = {
  _id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: Ref<IssueStatus>;
  priority: IssuePriority;
  assignee: string | null;
  component: string | null;
  dueDate: number | null;
  parents: Array<{
    parentId: string;
    identifier: string;
    parentTitle: string;
    space: string;
  }>;
  modifiedOn: number;
  $lookup?: {
    status?: { name?: string };
    assignee?: { name?: string };
    component?: { label?: string };
  };
};

type LookupTagReference = {
  attachedTo: string;
  title: string;
};

type LookupComponent = {
  _id: string;
  label: string;
  description?: string;
  modifiedOn: number;
};

type LookupAttachment = {
  _id: string;
  attachedTo: string;
  name: string;
  file: string;
  type: string;
  size: number;
};

type LookupComment = {
  _id: string;
  attachedTo: string;
  message: string;
  modifiedBy: string;
  modifiedOn: number;
  createdOn?: number;
};

type LookupProject = {
  _id: string;
  identifier: string;
  name: string;
  description?: string;
  members?: string[];
  owners?: string[];
};

const tracker = (trackerModule as typeof trackerModule & { default?: typeof trackerModule })
  .default ?? trackerModule;
const attachment = (
  attachmentModule as typeof attachmentModule & { default?: typeof attachmentModule }
).default ?? attachmentModule;
const chunter = (chunterModule as typeof chunterModule & { default?: typeof chunterModule })
  .default ?? chunterModule;
const contact = (contactModule as typeof contactModule & { default?: typeof contactModule })
  .default ?? contactModule;
const tags = (tagsModule as typeof tagsModule & { default?: typeof tagsModule })
  .default ?? tagsModule;
const IssuePriority = (trackerModule as typeof trackerModule & {
  IssuePriority?: typeof trackerModule.IssuePriority;
}).IssuePriority ?? tracker.IssuePriority;
const getPersonByPersonId = (
  contactModule as typeof contactModule & {
    getPersonByPersonId?: (
      client: PlatformClient,
      personId: string,
    ) => Promise<{ name?: string } | null>;
  }
).getPersonByPersonId;
const getSocialIdByPersonId = (
  contactModule as typeof contactModule & {
    getSocialIdByPersonId?: (
      client: PlatformClient,
      personId: string,
    ) => Promise<{ type?: string; value?: string; displayValue?: string } | null>;
  }
).getSocialIdByPersonId;
const getPrimarySocialId = (
  contactModule as typeof contactModule & {
    getPrimarySocialId?: (
      client: PlatformClient,
      personRef: string,
    ) => Promise<string | undefined>;
  }
).getPrimarySocialId;
const formatName = (
  contactModule as typeof contactModule & {
    formatName?: (name: string, lastNameFirst?: string) => string;
  }
).formatName;

const PROJECT_FETCH_CONCURRENCY = 3;
const AUTHOR_LOOKUP_CONCURRENCY = 8;

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "huly.io" || parsed.hostname === "www.huly.io") {
      parsed.hostname = "huly.app";
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

function ensureConnectionConfig(config: ConnectionConfig): void {
  if (!config.workspace.trim()) {
    throw new Error("Укажите workspace.");
  }

  if (config.authMethod === "token") {
    if (!config.token.trim()) {
      throw new Error("Укажите Huly token.");
    }

    return;
  }

  if (!config.email.trim() || !config.password.trim()) {
    throw new Error("Укажите email и password для авторизации в Huly.");
  }
}

function priorityToLabel(priority: IssuePriority): string {
  switch (priority) {
    case IssuePriority.Urgent:
      return "Urgent";
    case IssuePriority.High:
      return "High";
    case IssuePriority.Medium:
      return "Medium";
    case IssuePriority.Low:
      return "Low";
    case IssuePriority.NoPriority:
    default:
      return "No priority";
  }
}

function isClosedStatus(statusId: string): boolean {
  return statusId === tracker.status.Done || statusId === tracker.status.Canceled;
}

function attachmentUrlTemplate(baseUrl: string, filesUrl: string, workspaceId: string): string {
  const absoluteFilesUrl = filesUrl.startsWith("/")
    ? new URL(filesUrl, `${baseUrl}/`).toString()
    : filesUrl;

  return absoluteFilesUrl.replace(":workspace", workspaceId);
}

function buildAttachmentUrl(template: string, blobId: string, fileName: string): string {
  return template
    .replace(":blobId", encodeURIComponent(blobId))
    .replace(":filename", encodeURIComponent(fileName));
}

function authOptions(config: ConnectionConfig) {
  return config.authMethod === "token"
    ? {
        token: config.token.trim(),
        workspace: config.workspace.trim(),
      }
    : {
        email: config.email.trim(),
        password: config.password,
        workspace: config.workspace.trim(),
      };
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Huly markdown serializer emits many hard-break escapes. In Obsidian notes
    // they often hurt readability more than they help, so flatten them.
    .replace(/\\\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatReadableName(name: string | null | undefined): string | null {
  if (!name || name.trim().length === 0) {
    return null;
  }

  if (formatName) {
    try {
      return formatName(name, "false");
    } catch {
      return name;
    }
  }

  return name;
}

function formatNickname(
  social: { type?: string; value?: string; displayValue?: string } | null | undefined,
): string | null {
  if (!social) {
    return null;
  }

  const raw = social.displayValue?.trim() || social.value?.trim() || "";
  if (raw.length === 0) {
    return null;
  }

  if (social.type === "huly" || social.type === "telegram" || social.type === "github") {
    return raw.startsWith("@") ? raw : `@${raw}`;
  }

  return raw;
}

async function resolveCommentAuthorName(
  client: PlatformClient,
  personId: string,
): Promise<string> {
  if (getSocialIdByPersonId) {
    try {
      const social = await getSocialIdByPersonId(client, personId);
      const nickname = formatNickname(social);
      if (nickname) {
        return nickname;
      }
    } catch {
      // Ignore social identity lookup issues and continue to readable name fallback.
    }
  }

  if (getPersonByPersonId) {
    try {
      const person = await getPersonByPersonId(client, personId);
      const readableName = formatReadableName(person?.name);
      if (readableName) {
        return readableName;
      }
    } catch {
      // Ignore cache/person lookup issues and fall back to the raw person id.
    }
  }

  return personId;
}

async function resolveAssigneeName(
  client: PlatformClient,
  assigneeRef: string | null,
  fallbackName: string | null,
): Promise<string | null> {
  if (!assigneeRef) {
    return null;
  }

  if (getPrimarySocialId && getSocialIdByPersonId) {
    try {
      const primarySocialId = await getPrimarySocialId(client, assigneeRef);
      if (primarySocialId) {
        const social = await getSocialIdByPersonId(client, primarySocialId);
        const nickname = formatNickname(social);
        if (nickname) {
          return nickname;
        }
      }
    } catch {
      // Ignore social lookup issues and continue to readable fallback name.
    }
  }

  return formatReadableName(fallbackName) ?? fallbackName;
}

function renderStoredMarkup(markup: string | null | undefined): string {
  if (!markup || markup.trim().length === 0) {
    return "";
  }

  try {
    const json = markupToJSON(markup);
    return cleanupMarkdown(markupToMarkdown(json));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      const json = markupToJSON(markup);
      const html = jsonToHTML(json);
      return [
        "> [!warning] Huly markup fallback",
        `> Failed to convert rich text to markdown: ${message}`,
        "",
        html,
      ].join("\n");
    } catch {
      return [
        "> [!warning] Huly markup fallback",
        `> Failed to convert rich text to markdown: ${message}`,
        "",
        stripTags(markup) || "_Original rich text could not be rendered._",
      ].join("\n");
    }
  }
}

async function fetchIssueDescription(
  client: PlatformClient,
  issueId: string,
  markupRef: string | null,
): Promise<string> {
  if (!markupRef) {
    return "";
  }

  try {
    return cleanupMarkdown(
      await client.fetchMarkup(
        tracker.class.Issue,
        issueId as never,
        "description",
        markupRef as never,
        "markdown",
      ),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      const html = await client.fetchMarkup(
        tracker.class.Issue,
        issueId as never,
        "description",
        markupRef as never,
        "html",
      );

      return [
        "> [!warning] Huly markup fallback",
        "> Description contains unsupported rich-text marks for Markdown export.",
        "",
        html,
      ].join("\n");
    } catch {
      return [
        "> [!warning] Huly markup fallback",
        `> Failed to convert issue description from Huly markup: ${message}`,
        "",
        "_Original description could not be rendered by the current Huly SDK._",
      ].join("\n");
    }
  }
}

export class HulyApiClient {
  private async withClient<T>(
    config: ConnectionConfig,
    action: (client: PlatformClient) => Promise<T>,
  ): Promise<T> {
    ensureConnectionConfig(config);

    const normalizedUrl = normalizeUrl(config.hulyUrl);
    const auth = authOptions(config);

    let client: PlatformClient | null = null;
    try {
      client = await connect(normalizedUrl, {
        ...auth,
        socketFactory: BrowserWebSocketFactory,
        connectionTimeout: 30000,
      });
      return await action(client);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Failed to fetch config")) {
        throw new Error(
          `Не удалось загрузить config.json с ${normalizedUrl}. Для Huly Cloud используйте https://huly.app. Если у вас self-hosted инстанс, укажите базовый URL, на котором доступен /config.json.`,
        );
      }

      throw error;
    } finally {
      if (client !== null) {
        await client.close();
      }
    }
  }

  async fetchProjects(config: ConnectionConfig): Promise<HulyProject[]> {
    return this.withClient(config, async (client) => {
      const account = await client.getAccount();
      const projects = await client.findAll(
        tracker.class.Project,
        {},
        {
          sort: {
            identifier: SortingOrder.Ascending,
          },
          showArchived: false,
        },
      );

      return (projects as unknown as LookupProject[])
        .filter((project) => {
          const members = project.members ?? [];
          const owners = project.owners ?? [];
          return members.includes(account.uuid) || owners.includes(account.uuid);
        })
        .map((project) => ({
          id: project._id,
          identifier: project.identifier,
          name: project.name,
          description: renderStoredMarkup(project.description),
        }));
    });
  }

  async fetchProjectData(
    config: ConnectionConfig,
    selectedProjects: HulyProject[],
  ): Promise<{ components: HulyComponent[]; issues: HulyIssue[] }> {
    return this.withClient(config, async (client) => {
      const normalizedUrl = normalizeUrl(config.hulyUrl);
      const serverConfig = await loadServerConfig(normalizedUrl);
      const workspaceToken = await getWorkspaceToken(
        normalizedUrl,
        authOptions(config),
        serverConfig,
      );
      const filesUrl = attachmentUrlTemplate(
        normalizedUrl,
        serverConfig.FILES_URL,
        workspaceToken.workspaceId,
      );

      const projectResults = await mapLimit(
        selectedProjects,
        PROJECT_FETCH_CONCURRENCY,
        async (project) => {
          const [components, issues] = await Promise.all([
            client.findAll(
              tracker.class.Component,
              {
                space: project.id as never,
              },
              {
                sort: {
                  label: SortingOrder.Ascending,
                },
                showArchived: true,
              },
            ),
            client.findAll(
              tracker.class.Issue,
              {
                space: project.id as never,
              },
              {
                sort: {
                  modifiedOn: SortingOrder.Descending,
                },
                lookup: {
                  status: tracker.class.IssueStatus,
                  assignee: contact.class.Person,
                  component: tracker.class.Component,
                },
                showArchived: true,
              },
            ),
          ]);

          const typedIssues = issues as unknown as LookupIssue[];
          const typedComponents = components as unknown as LookupComponent[];
          const issueIds = typedIssues.map((issue) => issue._id);
          const componentIds = typedComponents.map((component) => component._id);

          const [
            issueComments,
            componentComments,
            issueAttachments,
            componentAttachments,
            labels,
            descriptions,
          ] = await Promise.all([
            issueIds.length
              ? client.findAll(
                  chunter.class.ChatMessage,
                  {
                    attachedToClass: tracker.class.Issue,
                    attachedTo: {
                      $in: issueIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      modifiedOn: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            componentIds.length
              ? client.findAll(
                  chunter.class.ChatMessage,
                  {
                    attachedToClass: tracker.class.Component,
                    attachedTo: {
                      $in: componentIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      modifiedOn: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            issueIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: tracker.class.Issue,
                    attachedTo: {
                      $in: issueIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      name: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            componentIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: tracker.class.Component,
                    attachedTo: {
                      $in: componentIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      name: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            client.findAll(
              tags.class.TagReference,
              {
                attachedToClass: tracker.class.Issue,
                collection: "labels",
                space: project.id as never,
              },
              {
                sort: {
                  title: SortingOrder.Ascending,
                },
                showArchived: true,
              },
            ),
            Promise.all(
              typedIssues.map(async (issue) => {
                const description = await fetchIssueDescription(client, issue._id, issue.description);
                return [issue._id, description] as const;
              }),
            ),
          ]);

          const typedIssueComments = issueComments as unknown as LookupComment[];
          const typedComponentComments = componentComments as unknown as LookupComment[];
          const issueCommentIds = typedIssueComments.map((comment) => comment._id);
          const componentCommentIds = typedComponentComments.map((comment) => comment._id);

          const [issueCommentAttachments, componentCommentAttachments] = await Promise.all([
            issueCommentIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: chunter.class.ChatMessage,
                    attachedTo: {
                      $in: issueCommentIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      name: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            componentCommentIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: chunter.class.ChatMessage,
                    attachedTo: {
                      $in: componentCommentIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      name: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
          ]);

          const toAttachment = (item: LookupAttachment): HulyAttachment => ({
            id: item._id,
            name: item.name,
            url: buildAttachmentUrl(filesUrl, item.file, item.name),
            mimeType: item.type,
            size: item.size,
          });

          const toAttachmentMap = (
            items: LookupAttachment[],
          ): Map<string, HulyAttachment[]> => {
            const map = new Map<string, HulyAttachment[]>();
            for (const item of items) {
              const existing = map.get(item.attachedTo) ?? [];
              existing.push(toAttachment(item));
              map.set(item.attachedTo, existing);
            }
            return map;
          };

          const issueAttachmentsByParent = toAttachmentMap(
            issueAttachments as unknown as LookupAttachment[],
          );
          const componentAttachmentsByParent = toAttachmentMap(
            componentAttachments as unknown as LookupAttachment[],
          );
          const issueCommentAttachmentsByParent = toAttachmentMap(
            issueCommentAttachments as unknown as LookupAttachment[],
          );
          const componentCommentAttachmentsByParent = toAttachmentMap(
            componentCommentAttachments as unknown as LookupAttachment[],
          );

          const authorIds = Array.from(
            new Set(
              [...typedIssueComments, ...typedComponentComments].map((comment) => comment.modifiedBy),
            ),
          );
          const authorEntries = await mapLimit(
            authorIds,
            AUTHOR_LOOKUP_CONCURRENCY,
            async (authorId) =>
              [authorId, await resolveCommentAuthorName(client, authorId)] as const,
          );
          const authorNames = new Map(authorEntries);

          const toCommentsMap = (
            items: LookupComment[],
            attachmentsByParent: Map<string, HulyAttachment[]>,
          ): Map<string, HulyComment[]> => {
            const map = new Map<string, HulyComment[]>();
            for (const comment of items) {
              const existing = map.get(comment.attachedTo) ?? [];
              existing.push({
                id: comment._id,
                authorName: authorNames.get(comment.modifiedBy) ?? comment.modifiedBy,
                createdAt: comment.createdOn ?? comment.modifiedOn,
                updatedAt: comment.modifiedOn,
                body: renderStoredMarkup(comment.message),
                attachments: attachmentsByParent.get(comment._id) ?? [],
              });
              map.set(comment.attachedTo, existing);
            }
            return map;
          };

          const componentCommentsByParent = toCommentsMap(
            typedComponentComments,
            componentCommentAttachmentsByParent,
          );
          const issueCommentsByParent = toCommentsMap(
            typedIssueComments,
            issueCommentAttachmentsByParent,
          );

          const labelsByIssue = new Map<string, string[]>();
          for (const label of labels as unknown as LookupTagReference[]) {
            const existing = labelsByIssue.get(label.attachedTo) ?? [];
            existing.push(label.title);
            labelsByIssue.set(label.attachedTo, existing);
          }

          const descriptionByIssue = new Map(descriptions);

          const mappedComponents: HulyComponent[] = typedComponents.map((component) => ({
            id: component._id,
            projectId: project.id,
            projectIdentifier: project.identifier,
            label: component.label,
            description: renderStoredMarkup(component.description),
            attachments: componentAttachmentsByParent.get(component._id) ?? [],
            comments: componentCommentsByParent.get(component._id) ?? [],
            modifiedOn: component.modifiedOn,
          }));

          const mappedIssues: HulyIssue[] = await Promise.all(
            typedIssues.map(async (issue) => {
              const statusName = issue.$lookup?.status?.name ?? issue.status;
              const componentName = issue.$lookup?.component?.label ?? null;
              const parents: HulyIssueParent[] = (issue.parents ?? []).map((parent) => ({
                parentId: parent.parentId,
                identifier: parent.identifier,
                title: parent.parentTitle,
                projectId: parent.space,
              }));
              const assigneeName = await resolveAssigneeName(
                client,
                issue.assignee,
                issue.$lookup?.assignee?.name ?? null,
              );

              return {
                id: issue._id,
                identifier: issue.identifier,
                title: issue.title,
                projectId: project.id,
                projectIdentifier: project.identifier,
                projectName: project.name,
                description: descriptionByIssue.get(issue._id) ?? "",
                statusId: issue.status,
                statusName,
                priority: priorityToLabel(issue.priority),
                assigneeName,
                componentId: issue.component,
                componentName,
                dueDate: issue.dueDate,
                labels: labelsByIssue.get(issue._id) ?? [],
                parents,
                attachments: issueAttachmentsByParent.get(issue._id) ?? [],
                comments: issueCommentsByParent.get(issue._id) ?? [],
                modifiedOn: issue.modifiedOn,
                isClosed: isClosedStatus(issue.status),
              };
            }),
          );

          return {
            components: mappedComponents,
            issues: mappedIssues,
          };
        },
      );

      return {
        components: projectResults.flatMap((result) => result.components),
        issues: projectResults.flatMap((result) => result.issues),
      };
    });
  }
}
