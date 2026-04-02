import {
  BrowserWebSocketFactory,
  connect,
  getWorkspaceToken,
  loadServerConfig,
  type PlatformClient,
} from "@hcengineering/api-client";
import { getClient as getAccountClient } from "@hcengineering/account-client";
import activityModule from "@hcengineering/activity";
import attachmentModule from "@hcengineering/attachment";
import chunterModule from "@hcengineering/chunter";
import contactModule from "@hcengineering/contact";
import { SortingOrder, type Ref } from "@hcengineering/core";
import tagsModule from "@hcengineering/tags";
import { jsonToHTML, markupToJSON, stripTags } from "@hcengineering/text";
import { markupToMarkdown } from "@hcengineering/text-markdown";
import trackerModule, {
  IssuePriority,
  MilestoneStatus,
  type IssueStatus,
} from "@hcengineering/tracker";

import type {
  ConnectionConfig,
  HulyAttachment,
  HulyComment,
  HulyComponent,
  HulyEmployeeChannel,
  HulyEmployeeProfile,
  HulyEmployeeStatus,
  HulyEmployeeVacation,
  HulyIssue,
  HulyIssueHistoryEntry,
  HulyIssueParent,
  HulyIssueTemplate,
  HulyIssueTemplateChild,
  HulyMilestone,
  HulyProject,
  HulyTimeReport,
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
  milestone?: string | null;
  template?: {
    template: string;
    childId?: string;
  } | null;
  dueDate: number | null;
  estimation: number;
  remainingTime: number;
  reportedTime: number;
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
    milestone?: { label?: string };
  };
};

type LookupMilestone = {
  _id: string;
  label: string;
  description?: string | null;
  status: MilestoneStatus;
  targetDate: number;
  modifiedOn: number;
};

type LookupIssueTemplate = {
  _id: string;
  title: string;
  description?: string | null;
  priority: IssuePriority;
  assignee: string | null;
  component: string | null;
  milestone: string | null;
  estimation: number;
  modifiedOn: number;
  labels?: string[] | null;
  children: Array<{
    id: string;
    title: string;
    description?: string | null;
    priority: IssuePriority;
    assignee: string | null;
    component: string | null;
    milestone: string | null;
    estimation: number;
  }>;
  $lookup?: {
    component?: { label?: string };
    assignee?: { name?: string };
    milestone?: { label?: string };
  };
};

type LookupTagElement = {
  _id: string;
  title: string;
};

type LookupTagReference = {
  attachedTo: string;
  title: string;
};

type LookupDocUpdateMessage = {
  _id: string;
  objectId: string;
  objectClass: string;
  action: string;
  modifiedBy: string;
  modifiedOn: number;
  attributeUpdates?: {
    attrKey: string;
    attrClass: string;
    set: (string | number | null)[];
    prevValue?: unknown;
    added: (string | number | null)[];
    removed: (string | number | null)[];
    isMixin: boolean;
  };
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

type LookupTimeSpendReport = {
  _id: string;
  attachedTo: string;
  employee: string | null;
  date: number | null;
  value: number;
  description: string;
};

type LookupPerson = {
  _id: string;
  name?: string;
  city?: string;
  birthday?: number | null;
  profile?: string | null;
  avatarType?: string;
  avatarProps?: {
    color?: string;
    url?: string;
  };
};

type LookupEmployee = LookupPerson & {
  active?: boolean;
  role?: "USER" | "GUEST";
  position?: string | null;
  personUuid?: string;
  "hr:mixin:Staff"?: {
    department?: string | null;
  };
};

type LookupChannel = {
  _id: string;
  attachedTo: string;
  provider: string;
  value: string;
};

type LookupEmployeeStatus = {
  _id: string;
  attachedTo: string;
  name: string;
  dueDate: number | null;
};

type LookupMember = {
  _id: string;
  attachedTo: string;
  contact: string;
};

type LookupOrganization = {
  _id: string;
  name?: string;
  title?: string;
};

type LookupHrDepartment = {
  _id: string;
  name?: string;
  parent?: string | null;
};

type LookupHrDate = {
  day?: number;
  month?: number;
  year?: number;
  offset?: number;
};

type LookupHrRequest = {
  _id: string;
  attachedTo: string;
  type?: string | null;
  department?: string | null;
  description?: string;
  tzDate?: LookupHrDate | null;
  tzDueDate?: LookupHrDate | null;
};

const activity = (activityModule as typeof activityModule & { default?: typeof activityModule })
  .default ?? activityModule;
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
    ) => Promise<{
      type?: string;
      value?: string;
      displayValue?: string;
      attachedTo?: string;
    } | null>;
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
const getPersonByPersonRef = (
  contactModule as typeof contactModule & {
    getPersonByPersonRef?: (
      client: PlatformClient,
      personRef: string,
    ) => Promise<{ name?: string } | null>;
  }
).getPersonByPersonRef;
const getPersonRefByPersonId = (
  contactModule as typeof contactModule & {
    getPersonRefByPersonId?: (
      client: PlatformClient,
      personId: string,
    ) => Promise<string | null>;
  }
).getPersonRefByPersonId;
const formatName = (
  contactModule as typeof contactModule & {
    formatName?: (name: string, lastNameFirst?: string) => string;
  }
).formatName;

const PROJECT_FETCH_CONCURRENCY = 3;
const AUTHOR_LOOKUP_CONCURRENCY = 8;
const HOUR_MS = 60 * 60 * 1000;
const HR_DEPARTMENT_CLASS = "hr:class:Department";
const HR_REQUEST_CLASS = "hr:class:Request";
const HR_ROOT_DEPARTMENT = "hr:ids:Head";

function trackedHoursToMs(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * HOUR_MS);
}

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

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
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

function milestoneStatusToLabel(status: MilestoneStatus): string {
  switch (status) {
    case MilestoneStatus.Planned:
      return "Planned";
    case MilestoneStatus.InProgress:
      return "In Progress";
    case MilestoneStatus.Completed:
      return "Completed";
    case MilestoneStatus.Canceled:
      return "Canceled";
    default:
      return "Unknown";
  }
}

function isClosedStatus(statusId: string): boolean {
  return statusId === tracker.status.Done || statusId === tracker.status.Canceled;
}

function attachmentUrlTemplate(baseUrl: string, filesUrl: string, workspaceId: string): string {
  const absoluteFilesUrl = filesUrl.startsWith("/")
    ? new URL(filesUrl, `${baseUrl}/`).toString()
    : filesUrl;

  return absoluteFilesUrl.split(":workspace").join(workspaceId);
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

  // Technical Huly ids are UUID-like strings, not human nicknames.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return null;
  }

  if (social.type === "huly" || social.type === "telegram" || social.type === "github") {
    return raw.startsWith("@") ? raw : `@${raw}`;
  }

  return raw;
}

async function resolveReadablePersonName(
  client: PlatformClient,
  personRef: string | null | undefined,
): Promise<string | null> {
  if (!personRef || !getPersonByPersonRef) {
    return null;
  }

  try {
    const person = await getPersonByPersonRef(client, personRef);
    return formatReadableName(person?.name);
  } catch {
    return null;
  }
}

async function resolveEmployeeName(
  client: PlatformClient,
  employeeRef: string | null | undefined,
): Promise<string | null> {
  if (!employeeRef) {
    return null;
  }

  const readablePersonName = await resolveReadablePersonName(client, employeeRef);
  if (readablePersonName) {
    return readablePersonName;
  }

  try {
    const employee = await client.findOne(contact.mixin.Employee, {
      _id: employeeRef as never,
      active: true,
    });
    return formatReadableName(employee?.name);
  } catch {
    return null;
  }
}

async function resolveSocialDisplayName(
  client: PlatformClient,
  social: { type?: string; value?: string; displayValue?: string; attachedTo?: string } | null,
): Promise<string | null> {
  if (!social) {
    return null;
  }

  const nickname = formatNickname(social);
  if (nickname) {
    return nickname;
  }

  return await resolveReadablePersonName(client, social.attachedTo);
}

async function resolveCommentAuthorName(
  client: PlatformClient,
  personId: string,
): Promise<string> {
  if (getSocialIdByPersonId) {
    try {
      const social = await getSocialIdByPersonId(client, personId);
      const displayName = await resolveSocialDisplayName(client, social);
      if (displayName) {
        return displayName;
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

  try {
    const employee = await client.findOne(contact.mixin.Employee, {
      personUuid: personId as never,
      active: true,
    });
    const readableName = formatReadableName(employee?.name);
    if (readableName) {
      return readableName;
    }
  } catch {
    // Ignore employee lookup issues and fall back to the raw author id.
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
        const displayName = await resolveSocialDisplayName(client, social);
        if (displayName) {
          return displayName;
        }
      }
    } catch {
      // Ignore social lookup issues and continue to readable fallback name.
    }
  }

  return formatReadableName(fallbackName) ?? fallbackName;
}

function channelKind(provider: string): string | null {
  if (provider === contact.channelProvider.Email) {
    return "email";
  }
  if (provider === contact.channelProvider.Phone) {
    return "phone";
  }
  if (provider === contact.channelProvider.Homepage || provider === contact.channelProvider.Profile) {
    return "website";
  }
  if (provider === contact.channelProvider.Telegram) {
    return "telegram";
  }
  if (provider === contact.channelProvider.GitHub) {
    return "github";
  }

  return null;
}

function hrDateToTimestamp(value: LookupHrDate | null | undefined): number | null {
  if (!value?.year || !value?.month || !value?.day) {
    return null;
  }

  return Date.UTC(value.year, value.month - 1, value.day);
}

function humanizeHrRequestType(typeId: string | null | undefined): string {
  if (!typeId) {
    return "HR request";
  }

  const knownNames: Record<string, string> = {
    "hr:ids:Vacation": "Vacation days",
    "hr:ids:PTO": "PTO",
    "hr:ids:PTOTwo": "PTO/2",
    "hr:ids:Sick": "Sick days",
    "hr:ids:Overtime": "Overtime",
    "hr:ids:OvertimeTwo": "Overtime/2",
    "hr:ids:Remote": "Remote days",
  };
  if (knownNames[typeId]) {
    return knownNames[typeId];
  }

  const rawName = typeId.split(":").pop() ?? typeId;
  return rawName.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function uniqueOrdered(values: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function fetchHrDepartments(
  client: PlatformClient,
  departmentIds: string[],
): Promise<Map<string, LookupHrDepartment>> {
  const departmentsById = new Map<string, LookupHrDepartment>();
  let pendingIds = Array.from(
    new Set(departmentIds.filter((id) => id.trim().length > 0 && id !== HR_ROOT_DEPARTMENT)),
  );

  while (pendingIds.length > 0) {
    const chunk = pendingIds.filter((id) => !departmentsById.has(id));
    if (chunk.length === 0) {
      break;
    }

    const departments = (await client.findAll(
      HR_DEPARTMENT_CLASS as never,
      {
        _id: {
          $in: chunk as never,
        },
      },
      {
        showArchived: true,
      },
    )) as unknown as LookupHrDepartment[];

    pendingIds = [];
    for (const department of departments) {
      departmentsById.set(department._id, department);
      if (
        department.parent &&
        department.parent !== HR_ROOT_DEPARTMENT &&
        !departmentsById.has(department.parent)
      ) {
        pendingIds.push(department.parent);
      }
    }
  }

  return departmentsById;
}

function departmentChain(
  departmentId: string | null | undefined,
  departmentsById: ReadonlyMap<string, LookupHrDepartment>,
): string[] {
  if (!departmentId || departmentId === HR_ROOT_DEPARTMENT) {
    return [];
  }

  const names: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null | undefined = departmentId;
  while (currentId && currentId !== HR_ROOT_DEPARTMENT && !seen.has(currentId)) {
    seen.add(currentId);
    const department = departmentsById.get(currentId);
    if (!department) {
      break;
    }
    if (department.name?.trim()) {
      names.push(department.name.trim());
    }
    currentId = department.parent;
  }

  return names.reverse();
}

async function resolvePrimarySocial(
  client: PlatformClient,
  personRef: string,
): Promise<{
  primarySocialType: string | null;
  primarySocialValue: string | null;
  primarySocialDisplay: string | null;
  socialStrings: string[];
}> {
  let primarySocialType: string | null = null;
  let primarySocialValue: string | null = null;
  let primarySocialDisplay: string | null = null;
  let socialStrings: string[] = [];

  if (getPrimarySocialId && getSocialIdByPersonId) {
    try {
      const primarySocialId = await getPrimarySocialId(client, personRef);
      if (primarySocialId) {
        primarySocialValue = primarySocialId;
        socialStrings = [primarySocialId];
        const social = await getSocialIdByPersonId(client, primarySocialId);
        primarySocialType = social?.type ?? null;
        primarySocialDisplay =
          formatNickname(social) ?? social?.displayValue ?? social?.value ?? primarySocialId;
      }
    } catch {
      // Ignore account/social lookup issues and keep a minimal profile.
    }
  }

  return {
    primarySocialType,
    primarySocialValue,
    primarySocialDisplay,
    socialStrings,
  };
}

async function resolveAuthorPersonRef(
  client: PlatformClient,
  personId: string,
): Promise<string | null> {
  if (!getPersonRefByPersonId) {
    return null;
  }

  try {
    return await getPersonRefByPersonId(client, personId);
  } catch {
    return null;
  }
}

async function fetchEmployeeProfiles(
  client: PlatformClient,
  accountClient: ReturnType<typeof getAccountClient>,
  personRefs: string[],
): Promise<HulyEmployeeProfile[]> {
  const uniquePersonRefs = Array.from(new Set(personRefs.filter((ref) => ref.trim().length > 0)));
  if (uniquePersonRefs.length === 0) {
    return [];
  }

  const persons = (await client.findAll(
    contact.class.Person,
    {
      _id: {
        $in: uniquePersonRefs as never,
      },
    },
    {
      showArchived: true,
    },
  )) as unknown as LookupPerson[];

  const employees = (await client.findAll(
    contact.mixin.Employee,
    {
      _id: {
        $in: uniquePersonRefs as never,
      },
    },
    {
      showArchived: true,
    },
  )) as unknown as LookupEmployee[];

  const channels = (await client.findAll(
    contact.class.Channel,
    {
      attachedTo: {
        $in: uniquePersonRefs as never,
      },
    },
    {
      showArchived: true,
    },
  )) as unknown as LookupChannel[];

  const members = (await client.findAll(
    contact.class.Member,
    {
      contact: {
        $in: uniquePersonRefs as never,
      },
    },
    {
      showArchived: true,
    },
  )) as unknown as LookupMember[];

  const departmentIds = employees
    .map((employee) => employee["hr:mixin:Staff"]?.department ?? null)
    .filter((departmentId): departmentId is string => !!departmentId && departmentId.trim().length > 0);
  const departmentsById = await fetchHrDepartments(client, departmentIds);

  const organizationIds = Array.from(
    new Set(members.map((member) => member.attachedTo).filter((value) => value.trim().length > 0)),
  );
  const organizations = organizationIds.length
    ? ((await client.findAll(
        contact.class.Contact,
        {
          _id: {
            $in: organizationIds as never,
          },
        },
        {
          showArchived: true,
        },
      )) as unknown as LookupOrganization[])
    : [];

  const hrRequests = (await client.findAll(
    HR_REQUEST_CLASS as never,
    {
      attachedTo: {
        $in: uniquePersonRefs as never,
      },
    },
    {
      showArchived: true,
    },
  )) as unknown as LookupHrRequest[];

  const personByRef = new Map(persons.map((person) => [person._id, person]));
  const employeeByRef = new Map(employees.map((employee) => [employee._id, employee]));
  const organizationById = new Map(organizations.map((organization) => [organization._id, organization]));
  const employeeIds = employees.map((employee) => employee._id).filter((value) => value.trim().length > 0);
  const statuses = employeeIds.length
    ? ((await client.findAll(
        contact.class.Status,
        {
          attachedTo: {
            $in: employeeIds as never,
          },
        },
        {
          showArchived: true,
        },
      )) as unknown as LookupEmployeeStatus[])
    : [];

  const channelsByRef = new Map<string, HulyEmployeeChannel[]>();
  for (const channel of channels) {
    const existing = channelsByRef.get(channel.attachedTo) ?? [];
    existing.push({
      id: channel._id,
      provider: channel.provider,
      kind: channelKind(channel.provider),
      value: channel.value,
    });
    channelsByRef.set(channel.attachedTo, existing);
  }

  const statusesByRef = new Map<string, HulyEmployeeStatus[]>();
  for (const status of statuses) {
    const existing = statusesByRef.get(status.attachedTo) ?? [];
    existing.push({
      id: status._id,
      name: status.name,
      dueDate: status.dueDate,
    });
    statusesByRef.set(status.attachedTo, existing);
  }

  const vacationsByRef = new Map<string, HulyEmployeeVacation[]>();
  for (const request of hrRequests) {
    const existing = vacationsByRef.get(request.attachedTo) ?? [];
    const departmentName = request.department
      ? departmentsById.get(request.department)?.name?.trim() ?? null
      : null;
    existing.push({
      id: request._id,
      typeId: request.type ?? null,
      name: humanizeHrRequestType(request.type),
      startDate: hrDateToTimestamp(request.tzDate),
      dueDate: hrDateToTimestamp(request.tzDueDate),
      departmentId: request.department ?? null,
      departmentName,
      description: renderStoredMarkup(request.description).trim(),
    });
    vacationsByRef.set(request.attachedTo, existing);
  }

  const departmentsByRef = new Map<string, string[]>();
  for (const member of members) {
    const organization = organizationById.get(member.attachedTo);
    const organizationName = organization?.name?.trim() || organization?.title?.trim() || "";
    if (organizationName.length === 0) {
      continue;
    }

    const existing = departmentsByRef.get(member.contact) ?? [];
    existing.push(organizationName);
    departmentsByRef.set(member.contact, existing);
  }

  const profiles = await mapLimit(uniquePersonRefs, AUTHOR_LOOKUP_CONCURRENCY, async (personRef) => {
    const person = personByRef.get(personRef);
    const employee = employeeByRef.get(personRef) ?? null;
    const profile = employee?.personUuid
      ? await accountClient.getUserProfile(employee.personUuid as never).catch(() => null)
      : null;
    const primarySocial = await resolvePrimarySocial(client, personRef);
    const employeeChannels = (channelsByRef.get(personRef) ?? []).sort((left, right) =>
      compareStrings(left.kind ?? left.provider, right.kind ?? right.provider),
    );
    const employeeStatuses = (
      statusesByRef.get(employee?._id ?? personRef) ?? []
    ).sort(
      (left, right) => (left.dueDate ?? 0) - (right.dueDate ?? 0) || compareStrings(left.name, right.name),
    );
    const hrDepartmentNames = departmentChain(
      employee?.["hr:mixin:Staff"]?.department ?? null,
      departmentsById,
    );
    const organizationNames = [...(departmentsByRef.get(personRef) ?? [])].sort(compareStrings);
    const departments = uniqueOrdered([...organizationNames, ...hrDepartmentNames]);
    const vacations = [...(vacationsByRef.get(personRef) ?? [])].sort(
      (left, right) =>
        (left.startDate ?? left.dueDate ?? Number.MAX_SAFE_INTEGER) -
          (right.startDate ?? right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
        (left.dueDate ?? Number.MAX_SAFE_INTEGER) - (right.dueDate ?? Number.MAX_SAFE_INTEGER) ||
        compareStrings(left.name, right.name),
    );

    const email =
      employeeChannels.find((channel) => channel.kind === "email")?.value ?? null;
    const phone =
      employeeChannels.find((channel) => channel.kind === "phone")?.value ?? null;
    const website =
      profile?.website ??
      employeeChannels.find((channel) => channel.kind === "website")?.value ??
      null;

    const accountProfileName =
      profile && typeof profile === "object" && "name" in profile
        ? String((profile as { name?: unknown }).name ?? "").trim() || undefined
        : undefined;

    return {
      id: personRef,
      personRef,
      employeeRef: employee?._id ?? (employee ? personRef : null),
      personUuid: employee?.personUuid ?? null,
      displayName:
        formatReadableName(accountProfileName ?? employee?.name ?? person?.name) ??
        accountProfileName ??
        employee?.name ??
        person?.name ??
        personRef,
      active: employee?.active ?? false,
      role: employee?.role ?? null,
      position: employee?.position ?? null,
      city: profile?.city ?? person?.city ?? null,
      birthday: person?.birthday ?? null,
      email,
      phone,
      website,
      country: profile?.country ?? null,
      bio: profile?.bio ?? "",
      isProfilePublic: profile?.isPublic ?? null,
      avatarType: person?.avatarType ?? employee?.avatarType ?? null,
      avatarUrl: person?.avatarProps?.url ?? employee?.avatarProps?.url ?? null,
      avatarColor: person?.avatarProps?.color ?? employee?.avatarProps?.color ?? null,
      profileRef: person?.profile ?? null,
      primarySocialType: primarySocial.primarySocialType,
      primarySocialValue: primarySocial.primarySocialValue,
      primarySocialDisplay: primarySocial.primarySocialDisplay,
      socialStrings: primarySocial.socialStrings,
      socialLinks: profile?.socialLinks ?? {},
      channels: employeeChannels,
      departments,
      statuses: employeeStatuses,
      vacations,
    } satisfies HulyEmployeeProfile;
  });

  return profiles.sort((left, right) => compareStrings(left.displayName, right.displayName));
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

type TrackerMarkupClass =
  | typeof tracker.class.Issue
  | typeof tracker.class.IssueTemplate
  | typeof tracker.class.Milestone;

async function fetchMarkupFieldMarkdown(
  client: PlatformClient,
  objectClass: TrackerMarkupClass,
  objectId: string,
  attribute: string,
  markupRef: string | null | undefined,
  label: string,
): Promise<string> {
  if (!markupRef) {
    return "";
  }

  try {
    return cleanupMarkdown(
      await client.fetchMarkup(
        objectClass,
        objectId as never,
        attribute,
        markupRef as never,
        "markdown",
      ),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      const html = await client.fetchMarkup(
        objectClass,
        objectId as never,
        attribute,
        markupRef as never,
        "html",
      );

      return [
        "> [!warning] Huly markup fallback",
        "> Rich text contains unsupported marks for Markdown export.",
        "",
        html,
      ].join("\n");
    } catch {
      return [
        "> [!warning] Huly markup fallback",
        `> Failed to convert ${label} from Huly markup: ${message}`,
        "",
        "_Original rich text could not be rendered by the current Huly SDK._",
      ].join("\n");
    }
  }
}

async function fetchIssueDescription(
  client: PlatformClient,
  issueId: string,
  markupRef: string | null,
): Promise<string> {
  return fetchMarkupFieldMarkdown(
    client,
    tracker.class.Issue,
    issueId,
    "description",
    markupRef,
    "issue description",
  );
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
  ): Promise<{
    components: HulyComponent[];
    issues: HulyIssue[];
    employees: HulyEmployeeProfile[];
    milestones: HulyMilestone[];
    issueTemplates: HulyIssueTemplate[];
    filesToken: string;
  }> {
    return this.withClient(config, async (client) => {
      const normalizedUrl = normalizeUrl(config.hulyUrl);
      const serverConfig = await loadServerConfig(normalizedUrl);
      const workspaceToken = await getWorkspaceToken(
        normalizedUrl,
        authOptions(config),
        serverConfig,
      );
      const accountClient = getAccountClient(serverConfig.ACCOUNTS_URL, workspaceToken.token);
      const filesUrl = attachmentUrlTemplate(
        normalizedUrl,
        serverConfig.FILES_URL,
        workspaceToken.workspaceId,
      );

      const projectResults = await mapLimit(
        selectedProjects,
        PROJECT_FETCH_CONCURRENCY,
        async (project) => {
          const [components, issues, milestones, issueTemplates] = await Promise.all([
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
                  milestone: tracker.class.Milestone,
                },
                showArchived: true,
              },
            ),
            client.findAll(
              tracker.class.Milestone,
              {
                space: project.id as never,
              },
              {
                sort: {
                  targetDate: SortingOrder.Ascending,
                },
                showArchived: true,
              },
            ),
            client.findAll(
              tracker.class.IssueTemplate,
              {
                space: project.id as never,
              },
              {
                sort: {
                  modifiedOn: SortingOrder.Descending,
                },
                lookup: {
                  component: tracker.class.Component,
                  assignee: contact.class.Person,
                  milestone: tracker.class.Milestone,
                },
                showArchived: true,
              },
            ),
          ]);

          const typedIssues = issues as unknown as LookupIssue[];
          const typedComponents = components as unknown as LookupComponent[];
          const typedMilestones = milestones as unknown as LookupMilestone[];
          const typedIssueTemplates = issueTemplates as unknown as LookupIssueTemplate[];

          const milestoneLabelById = new Map(
            typedMilestones.map((item) => [item._id, item.label] as const),
          );
          const componentLabelById = new Map(
            typedComponents.map((item) => [item._id, item.label] as const),
          );
          const templateTitleById = new Map(
            typedIssueTemplates.map((item) => [item._id, item.title] as const),
          );

          const issueIds = typedIssues.map((issue) => issue._id);
          const componentIds = typedComponents.map((component) => component._id);
          const milestoneIds = typedMilestones.map((item) => item._id);
          const templateIds = typedIssueTemplates.map((item) => item._id);

          const [
            issueComments,
            componentComments,
            issueAttachments,
            componentAttachments,
            labels,
            descriptions,
            timeReports,
            issueActivityMessages,
            projectStatuses,
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
            issueIds.length
              ? client.findAll(
                  tracker.class.TimeSpendReport,
                  {
                    attachedToClass: tracker.class.Issue,
                    attachedTo: {
                      $in: issueIds as never,
                    },
                    space: project.id as never,
                  },
                  {
                    sort: {
                      date: SortingOrder.Descending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            issueIds.length
              ? client.findAll(
                  activity.class.DocUpdateMessage,
                  {
                    objectClass: tracker.class.Issue,
                    objectId: {
                      $in: issueIds as never,
                    },
                    action: "update" as never,
                  },
                  {
                    sort: {
                      modifiedOn: SortingOrder.Ascending,
                    },
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
            client.findAll(
              tracker.class.IssueStatus,
              {},
              {
                showArchived: true,
              },
            ),
          ]);

          const templateLabelRefs = Array.from(
            new Set(typedIssueTemplates.flatMap((tpl) => tpl.labels ?? [])),
          );

          const [
            milestoneComments,
            templateComments,
            milestoneAttachments,
            templateAttachments,
            templateTagElements,
          ] = await Promise.all([
            milestoneIds.length
              ? client.findAll(
                  chunter.class.ChatMessage,
                  {
                    attachedToClass: tracker.class.Milestone,
                    attachedTo: {
                      $in: milestoneIds as never,
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
            templateIds.length
              ? client.findAll(
                  chunter.class.ChatMessage,
                  {
                    attachedToClass: tracker.class.IssueTemplate,
                    attachedTo: {
                      $in: templateIds as never,
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
            milestoneIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: tracker.class.Milestone,
                    attachedTo: {
                      $in: milestoneIds as never,
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
            templateIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: tracker.class.IssueTemplate,
                    attachedTo: {
                      $in: templateIds as never,
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
            templateLabelRefs.length
              ? client.findAll(
                  tags.class.TagElement,
                  {
                    _id: {
                      $in: templateLabelRefs as never,
                    },
                  },
                  {
                    showArchived: true,
                  },
                )
              : Promise.resolve([]),
          ]);

          const typedIssueComments = issueComments as unknown as LookupComment[];
          const typedComponentComments = componentComments as unknown as LookupComment[];
          const typedMilestoneComments = milestoneComments as unknown as LookupComment[];
          const typedTemplateComments = templateComments as unknown as LookupComment[];
          const issueCommentIds = typedIssueComments.map((comment) => comment._id);
          const componentCommentIds = typedComponentComments.map((comment) => comment._id);
          const milestoneCommentIds = typedMilestoneComments.map((comment) => comment._id);
          const templateCommentIds = typedTemplateComments.map((comment) => comment._id);

          const tagTitleById = new Map(
            (templateTagElements as unknown as LookupTagElement[]).map((el) => [el._id, el.title] as const),
          );

          const [
            issueCommentAttachments,
            componentCommentAttachments,
            milestoneCommentAttachments,
            templateCommentAttachments,
          ] = await Promise.all([
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
            milestoneCommentIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: chunter.class.ChatMessage,
                    attachedTo: {
                      $in: milestoneCommentIds as never,
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
            templateCommentIds.length
              ? client.findAll(
                  attachment.class.Attachment,
                  {
                    attachedToClass: chunter.class.ChatMessage,
                    attachedTo: {
                      $in: templateCommentIds as never,
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
          const milestoneDocAttachmentsByParent = toAttachmentMap(
            milestoneAttachments as unknown as LookupAttachment[],
          );
          const templateDocAttachmentsByParent = toAttachmentMap(
            templateAttachments as unknown as LookupAttachment[],
          );
          const milestoneCommentAttachmentsByParent = toAttachmentMap(
            milestoneCommentAttachments as unknown as LookupAttachment[],
          );
          const templateCommentAttachmentsByParent = toAttachmentMap(
            templateCommentAttachments as unknown as LookupAttachment[],
          );

          const authorIds = Array.from(
            new Set(
              [
                ...typedIssueComments,
                ...typedComponentComments,
                ...typedMilestoneComments,
                ...typedTemplateComments,
              ].map((comment) => comment.modifiedBy),
            ),
          );
          const authorEntries = await mapLimit(
            authorIds,
            AUTHOR_LOOKUP_CONCURRENCY,
            async (authorId) =>
              [
                authorId,
                {
                  name: await resolveCommentAuthorName(client, authorId),
                  personRef: await resolveAuthorPersonRef(client, authorId),
                },
              ] as const,
          );
          const authorInfo = new Map(authorEntries);

          const typedTimeReports = timeReports as unknown as LookupTimeSpendReport[];
          const employeeRefs = Array.from(
            new Set(
              typedTimeReports
                .map((report) => report.employee)
                .filter((employeeRef): employeeRef is string => employeeRef !== null),
            ),
          );
          const employeeEntries = await mapLimit(
            employeeRefs,
            AUTHOR_LOOKUP_CONCURRENCY,
            async (employeeRef) => [employeeRef, await resolveEmployeeName(client, employeeRef)] as const,
          );
          const employeeNames = new Map(employeeEntries);

          const toCommentsMap = (
            items: LookupComment[],
            attachmentsByParent: Map<string, HulyAttachment[]>,
          ): Map<string, HulyComment[]> => {
            const map = new Map<string, HulyComment[]>();
            for (const comment of items) {
              const existing = map.get(comment.attachedTo) ?? [];
              const info = authorInfo.get(comment.modifiedBy);
              existing.push({
                id: comment._id,
                authorName: info?.name ?? comment.modifiedBy,
                authorPersonId: comment.modifiedBy,
                authorPersonRef: info?.personRef ?? null,
                authorEmployeeRef: null,
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
          const milestoneCommentsByParent = toCommentsMap(
            typedMilestoneComments,
            milestoneCommentAttachmentsByParent,
          );
          const templateCommentsByParent = toCommentsMap(
            typedTemplateComments,
            templateCommentAttachmentsByParent,
          );

          const timeReportsByIssue = new Map<string, HulyTimeReport[]>();
          for (const report of typedTimeReports) {
            const existing = timeReportsByIssue.get(report.attachedTo) ?? [];
            existing.push({
              id: report._id,
              employeeName: employeeNames.get(report.employee ?? "") ?? "Unknown employee",
              employeeRef: report.employee,
              employeePersonUuid: null,
              date: report.date,
              value: trackedHoursToMs(report.value),
              description: report.description.trim(),
            });
            timeReportsByIssue.set(report.attachedTo, existing);
          }

          const labelsByIssue = new Map<string, string[]>();
          for (const label of labels as unknown as LookupTagReference[]) {
            const existing = labelsByIssue.get(label.attachedTo) ?? [];
            existing.push(label.title);
            labelsByIssue.set(label.attachedTo, existing);
          }

          const descriptionByIssue = new Map(descriptions);

          const typedActivityMessages = issueActivityMessages as unknown as LookupDocUpdateMessage[];
          const statusNameById = new Map(
            (projectStatuses as unknown as { _id: string; name?: string }[]).map(
              (s) => [s._id, s.name ?? s._id] as const,
            ),
          );
          for (const issue of typedIssues) {
            const lookupName = issue.$lookup?.status?.name;
            if (lookupName && issue.status) {
              statusNameById.set(issue.status, lookupName);
            }
          }

          const assigneeNameByRef = new Map(
            typedIssues
              .filter((issue) => issue.assignee && issue.$lookup?.assignee?.name)
              .map((issue) => [issue.assignee!, issue.$lookup!.assignee!.name!] as const),
          );

          const TRACKED_FIELDS = new Set(["status", "assignee", "priority"]);
          const activityAuthorIds = Array.from(
            new Set(typedActivityMessages.map((m) => m.modifiedBy)),
          );
          const activityAuthorEntries = await mapLimit(
            activityAuthorIds,
            AUTHOR_LOOKUP_CONCURRENCY,
            async (authorId) =>
              [
                authorId,
                {
                  name: await resolveCommentAuthorName(client, authorId),
                  personRef: await resolveAuthorPersonRef(client, authorId),
                },
              ] as const,
          );
          const activityAuthorInfo = new Map(activityAuthorEntries);

          const resolveFieldValue = async (
            field: string,
            raw: unknown,
          ): Promise<string | null> => {
            if (raw === null || raw === undefined) {
              return null;
            }
            const value = String(raw);
            if (value.trim().length === 0) {
              return null;
            }
            if (field === "status") {
              const cached = statusNameById.get(value);
              if (cached) {
                return cached;
              }
              const wellKnownMatch = value.match(/^tracker:status:(\w+)$/);
              if (wellKnownMatch?.[1]) {
                return wellKnownMatch[1].replace(/([a-z])([A-Z])/g, "$1 $2");
              }
              return value;
            }
            if (field === "assignee") {
              const cached = assigneeNameByRef.get(value);
              if (cached) {
                return formatReadableName(cached) ?? cached;
              }
              const resolved = await resolveAssigneeName(client, value, null);
              if (resolved) {
                assigneeNameByRef.set(value, resolved);
              }
              return resolved ?? value;
            }
            return value;
          };

          const historyByIssue = new Map<string, HulyIssueHistoryEntry[]>();
          for (const msg of typedActivityMessages) {
            const updates = msg.attributeUpdates;
            if (!updates || !TRACKED_FIELDS.has(updates.attrKey)) {
              continue;
            }
            const existing = historyByIssue.get(msg.objectId) ?? [];
            const authorData = activityAuthorInfo.get(msg.modifiedBy);
            const newValue = updates.set.length > 0 ? updates.set[0] : null;
            const entry: HulyIssueHistoryEntry = {
              id: msg._id,
              timestamp: msg.modifiedOn,
              changedBy: authorData?.name ?? msg.modifiedBy,
              changedByPersonRef: authorData?.personRef ?? null,
              field: updates.attrKey,
              action: msg.action,
              fromValue: await resolveFieldValue(updates.attrKey, updates.prevValue),
              toValue: await resolveFieldValue(updates.attrKey, newValue),
            };
            existing.push(entry);
            historyByIssue.set(msg.objectId, existing);
          }

          const milestoneDescriptionEntries = await Promise.all(
            typedMilestones.map(async (item) =>
              [
                item._id,
                await fetchMarkupFieldMarkdown(
                  client,
                  tracker.class.Milestone,
                  item._id,
                  "description",
                  item.description,
                  "milestone description",
                ),
              ] as const,
            ),
          );
          const descriptionByMilestone = new Map(milestoneDescriptionEntries);

          const templateDescriptionEntries = await Promise.all(
            typedIssueTemplates.map(async (item) =>
              [
                item._id,
                await fetchMarkupFieldMarkdown(
                  client,
                  tracker.class.IssueTemplate,
                  item._id,
                  "description",
                  item.description,
                  "template description",
                ),
              ] as const,
            ),
          );
          const descriptionByTemplate = new Map(templateDescriptionEntries);

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

          const mappedMilestones: HulyMilestone[] = typedMilestones.map((item) => ({
            id: item._id,
            projectId: project.id,
            projectIdentifier: project.identifier,
            label: item.label,
            description: descriptionByMilestone.get(item._id) ?? "",
            statusName: milestoneStatusToLabel(item.status),
            targetDate:
              Number.isFinite(item.targetDate) && item.targetDate > 0 ? item.targetDate : null,
            modifiedOn: item.modifiedOn,
            attachments: milestoneDocAttachmentsByParent.get(item._id) ?? [],
            comments: milestoneCommentsByParent.get(item._id) ?? [],
          }));

          const mappedIssueTemplates: HulyIssueTemplate[] = await Promise.all(
            typedIssueTemplates.map(async (tpl) => {
              const assigneeName = await resolveAssigneeName(
                client,
                tpl.assignee,
                tpl.$lookup?.assignee?.name ?? null,
              );
              const componentName =
                tpl.$lookup?.component?.label ??
                (tpl.component ? componentLabelById.get(tpl.component) ?? null : null);
              const milestoneLabel =
                tpl.$lookup?.milestone?.label ??
                (tpl.milestone ? milestoneLabelById.get(tpl.milestone) ?? null : null);
              const children: HulyIssueTemplateChild[] = await Promise.all(
                (tpl.children ?? []).map(async (child) => {
                  const childAssigneeName = await resolveAssigneeName(client, child.assignee, null);
                  return {
                    id: child.id,
                    title: child.title,
                    description: renderStoredMarkup(child.description),
                    priority: priorityToLabel(child.priority),
                    assigneeName: childAssigneeName,
                    assigneePersonRef: child.assignee,
                    componentName: child.component ? componentLabelById.get(child.component) ?? null : null,
                    milestoneLabel: child.milestone ? milestoneLabelById.get(child.milestone) ?? null : null,
                    estimation: trackedHoursToMs(child.estimation),
                  };
                }),
              );

              const templateLabelTitles = (tpl.labels ?? [])
                .map((ref) => tagTitleById.get(ref) ?? ref)
                .filter((title) => title.trim().length > 0)
                .sort(compareStrings);

              return {
                id: tpl._id,
                projectId: project.id,
                projectIdentifier: project.identifier,
                title: tpl.title,
                description: descriptionByTemplate.get(tpl._id) ?? "",
                priority: priorityToLabel(tpl.priority),
                assigneeName,
                assigneePersonRef: tpl.assignee,
                componentName,
                milestoneLabel,
                estimation: trackedHoursToMs(tpl.estimation),
                modifiedOn: tpl.modifiedOn,
                labels: templateLabelTitles,
                attachments: templateDocAttachmentsByParent.get(tpl._id) ?? [],
                comments: templateCommentsByParent.get(tpl._id) ?? [],
                children,
              };
            }),
          );

          const mappedIssues: HulyIssue[] = await Promise.all(
            typedIssues.map(async (issue) => {
              const statusName = issue.$lookup?.status?.name ?? issue.status;
              const componentName = issue.$lookup?.component?.label ?? null;
              const milestoneId = issue.milestone ?? null;
              const milestoneLabel =
                issue.$lookup?.milestone?.label ??
                (milestoneId ? milestoneLabelById.get(milestoneId) ?? null : null);
              const templateRef = issue.template?.template ?? null;
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
                assigneePersonRef: issue.assignee,
                assigneeEmployeeRef: null,
                assigneePersonUuid: null,
                componentId: issue.component,
                componentName,
                milestoneId,
                milestoneLabel,
                issueTemplateId: templateRef,
                issueTemplateTitle: templateRef ? templateTitleById.get(templateRef) ?? null : null,
                issueTemplateChildId: issue.template?.childId ?? null,
                dueDate: issue.dueDate,
                estimation: trackedHoursToMs(issue.estimation),
                remainingTime: trackedHoursToMs(issue.remainingTime),
                reportedTime: trackedHoursToMs(issue.reportedTime),
                labels: labelsByIssue.get(issue._id) ?? [],
                parents,
                attachments: issueAttachmentsByParent.get(issue._id) ?? [],
                comments: issueCommentsByParent.get(issue._id) ?? [],
                timeReports: timeReportsByIssue.get(issue._id) ?? [],
                modifiedOn: issue.modifiedOn,
                isClosed: isClosedStatus(issue.status),
                history: historyByIssue.get(issue._id) ?? [],
              };
            }),
          );

          return {
            components: mappedComponents,
            issues: mappedIssues,
            milestones: mappedMilestones,
            issueTemplates: mappedIssueTemplates,
          };
        },
      );

      const components = projectResults.flatMap((result) => result.components);
      const issues = projectResults.flatMap((result) => result.issues);
      const milestones = projectResults.flatMap((result) => result.milestones);
      const issueTemplates = projectResults.flatMap((result) => result.issueTemplates);

      const employeeRefs = Array.from(
        new Set([
          ...issues.flatMap((issue) => {
            const refs: string[] = [];
            if (issue.assigneePersonRef) {
              refs.push(issue.assigneePersonRef);
            }
            for (const comment of issue.comments) {
              if (comment.authorPersonRef) {
                refs.push(comment.authorPersonRef);
              }
            }
            for (const report of issue.timeReports) {
              if (report.employeeRef) {
                refs.push(report.employeeRef);
              }
            }
            return refs;
          }),
          ...issueTemplates.flatMap((template) => {
            const refs: string[] = [];
            if (template.assigneePersonRef) {
              refs.push(template.assigneePersonRef);
            }
            for (const child of template.children) {
              if (child.assigneePersonRef) {
                refs.push(child.assigneePersonRef);
              }
            }
            for (const comment of template.comments) {
              if (comment.authorPersonRef) {
                refs.push(comment.authorPersonRef);
              }
            }
            return refs;
          }),
          ...milestones.flatMap((milestone) =>
            milestone.comments
              .map((comment) => comment.authorPersonRef)
              .filter((ref): ref is string => ref !== null),
          ),
        ]),
      );

      const employees = await fetchEmployeeProfiles(client, accountClient, employeeRefs);
      const employeeByPersonRef = new Map(employees.map((employee) => [employee.personRef, employee]));

      const hydrateCommentAuthors = (comment: HulyComment): HulyComment => ({
        ...comment,
        authorEmployeeRef:
          comment.authorPersonRef ? employeeByPersonRef.get(comment.authorPersonRef)?.employeeRef ?? null : null,
      });

      const hydratedMilestones = milestones.map((milestone) => ({
        ...milestone,
        comments: milestone.comments.map(hydrateCommentAuthors),
      }));

      const hydratedIssueTemplates = issueTemplates.map((template) => ({
        ...template,
        comments: template.comments.map(hydrateCommentAuthors),
      }));

      const hydratedIssues = issues.map((issue) => ({
        ...issue,
        assigneeEmployeeRef:
          issue.assigneePersonRef ? employeeByPersonRef.get(issue.assigneePersonRef)?.employeeRef ?? null : null,
        assigneePersonUuid:
          issue.assigneePersonRef ? employeeByPersonRef.get(issue.assigneePersonRef)?.personUuid ?? null : null,
        comments: issue.comments.map(hydrateCommentAuthors),
        timeReports: issue.timeReports.map((report) => ({
          ...report,
          employeePersonUuid:
            report.employeeRef ? employeeByPersonRef.get(report.employeeRef)?.personUuid ?? null : null,
        })),
      }));

      return {
        components,
        issues: hydratedIssues,
        employees,
        milestones: hydratedMilestones,
        issueTemplates: hydratedIssueTemplates,
        filesToken: workspaceToken.token,
      };
    });
  }
}
