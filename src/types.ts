export type AuthMethod = "password" | "token";

export type NoteStyle = "classic" | "rich";

export type ProjectNoteFileNameMode = "identifier-and-name" | "name-only";

export type IssueNoteFileNameMode = "identifier-only" | "identifier-and-title";

export type ScheduledSyncStatus = "idle" | "success" | "error" | "skipped";

export interface StoredProjectConfig {
  id: string;
  identifier: string;
  name: string;
  description: string;
  selected: boolean;
}

export interface HulySyncSettings {
  hulyUrl: string;
  authMethod: AuthMethod;
  email: string;
  password: string;
  token: string;
  workspace: string;
  workdayHours: number;
  targetFolder: string;
  syncIntervalMinutes: number;
  noteStyle: NoteStyle;
  useMetaBind: boolean;
  projectNoteFileNameMode: ProjectNoteFileNameMode;
  issueNoteFileNameMode: IssueNoteFileNameMode;
  projects: StoredProjectConfig[];
  lastSyncAt: string | null;
  lastScheduledSyncAt: string | null;
  lastScheduledSyncStatus: ScheduledSyncStatus;
  lastScheduledSyncMessage: string | null;
}

export interface ConnectionConfig {
  hulyUrl: string;
  authMethod: AuthMethod;
  email: string;
  password: string;
  token: string;
  workspace: string;
}

export interface HulyProject {
  id: string;
  identifier: string;
  name: string;
  description: string;
}

export interface HulyComponent {
  id: string;
  projectId: string;
  projectIdentifier: string;
  label: string;
  description: string;
  attachments: HulyAttachment[];
  comments: HulyComment[];
  modifiedOn: number;
}

export interface HulyAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
}

export interface HulyComment {
  id: string;
  authorName: string;
  authorPersonId: string;
  authorPersonRef: string | null;
  authorEmployeeRef: string | null;
  createdAt: number;
  updatedAt: number;
  body: string;
  attachments: HulyAttachment[];
}

export interface HulyEmployeeChannel {
  id: string;
  provider: string;
  kind: string | null;
  value: string;
}

export interface HulyEmployeeStatus {
  id: string;
  name: string;
  dueDate: number | null;
}

export interface HulyEmployeeVacation {
  id: string;
  typeId: string | null;
  name: string;
  startDate: number | null;
  dueDate: number | null;
  departmentId: string | null;
  departmentName: string | null;
  description: string;
}

export interface HulyEmployeeProfile {
  id: string;
  personRef: string;
  employeeRef: string | null;
  personUuid: string | null;
  displayName: string;
  active: boolean;
  role: string | null;
  position: string | null;
  city: string | null;
  birthday: number | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  country: string | null;
  bio: string;
  isProfilePublic: boolean | null;
  avatarType: string | null;
  avatarUrl: string | null;
  avatarColor: string | null;
  profileRef: string | null;
  primarySocialType: string | null;
  primarySocialValue: string | null;
  primarySocialDisplay: string | null;
  socialStrings: string[];
  socialLinks: Record<string, string>;
  channels: HulyEmployeeChannel[];
  departments: string[];
  statuses: HulyEmployeeStatus[];
  vacations: HulyEmployeeVacation[];
}

export interface HulyTimeReport {
  id: string;
  employeeName: string;
  employeeRef: string | null;
  employeePersonUuid: string | null;
  date: number | null;
  value: number;
  description: string;
}

export interface HulyIssueParent {
  parentId: string;
  identifier: string;
  title: string;
  projectId: string;
}

export interface HulyMilestone {
  id: string;
  projectId: string;
  projectIdentifier: string;
  label: string;
  description: string;
  statusName: string;
  targetDate: number | null;
  modifiedOn: number;
  attachments: HulyAttachment[];
  comments: HulyComment[];
}

export interface HulyIssueTemplateChild {
  id: string;
  title: string;
  description: string;
  priority: string;
  assigneeName: string | null;
  assigneePersonRef: string | null;
  componentName: string | null;
  milestoneLabel: string | null;
  estimation: number;
}

export interface HulyIssueTemplate {
  id: string;
  projectId: string;
  projectIdentifier: string;
  title: string;
  description: string;
  priority: string;
  assigneeName: string | null;
  assigneePersonRef: string | null;
  componentName: string | null;
  milestoneLabel: string | null;
  estimation: number;
  modifiedOn: number;
  labels: string[];
  attachments: HulyAttachment[];
  comments: HulyComment[];
  children: HulyIssueTemplateChild[];
}

export interface HulyIssueHistoryEntry {
  id: string;
  timestamp: number;
  changedBy: string;
  changedByPersonRef: string | null;
  field: string;
  action: string;
  fromValue: string | null;
  toValue: string | null;
}

export interface HulyIssue {
  id: string;
  identifier: string;
  title: string;
  projectId: string;
  projectIdentifier: string;
  projectName: string;
  description: string;
  statusId: string;
  statusName: string;
  priority: string;
  assigneeName: string | null;
  assigneePersonRef: string | null;
  assigneeEmployeeRef: string | null;
  assigneePersonUuid: string | null;
  componentId: string | null;
  componentName: string | null;
  milestoneId: string | null;
  milestoneLabel: string | null;
  issueTemplateId: string | null;
  issueTemplateTitle: string | null;
  issueTemplateChildId: string | null;
  dueDate: number | null;
  estimation: number;
  remainingTime: number;
  reportedTime: number;
  labels: string[];
  parents: HulyIssueParent[];
  attachments: HulyAttachment[];
  comments: HulyComment[];
  timeReports: HulyTimeReport[];
  modifiedOn: number;
  isClosed: boolean;
  history: HulyIssueHistoryEntry[];
}

export interface SyncOptions {
  reason: "manual" | "scheduled";
}

export type SyncProgressPhase = "idle" | "fetch" | "write" | "done" | "error";

export interface SyncProgress {
  active: boolean;
  phase: SyncProgressPhase;
  current: number;
  total: number;
  percentage: number;
  message: string;
}

export interface SyncStats {
  projectCount: number;
  componentCount: number;
  issueCount: number;
  employeeCount: number;
  milestoneCount: number;
  issueTemplateCount: number;
}

export const DEFAULT_SETTINGS: HulySyncSettings = {
  hulyUrl: "https://huly.app",
  authMethod: "password",
  email: "",
  password: "",
  token: "",
  workspace: "",
  workdayHours: 8,
  targetFolder: "huly",
  syncIntervalMinutes: 15,
  noteStyle: "rich",
  useMetaBind: true,
  projectNoteFileNameMode: "identifier-and-name",
  issueNoteFileNameMode: "identifier-only",
  projects: [],
  lastSyncAt: null,
  lastScheduledSyncAt: null,
  lastScheduledSyncStatus: "idle",
  lastScheduledSyncMessage: null,
};
