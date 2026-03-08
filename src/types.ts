export type AuthMethod = "password" | "token";

export type NoteStyle = "classic" | "rich";

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
  targetFolder: string;
  syncIntervalMinutes: number;
  noteStyle: NoteStyle;
  useMetaBind: boolean;
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
  createdAt: number;
  updatedAt: number;
  body: string;
  attachments: HulyAttachment[];
}

export interface HulyTimeReport {
  id: string;
  employeeName: string;
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
  componentId: string | null;
  componentName: string | null;
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
}

export const DEFAULT_SETTINGS: HulySyncSettings = {
  hulyUrl: "https://huly.app",
  authMethod: "password",
  email: "",
  password: "",
  token: "",
  workspace: "",
  targetFolder: "huly",
  syncIntervalMinutes: 15,
  noteStyle: "rich",
  useMetaBind: true,
  projects: [],
  lastSyncAt: null,
  lastScheduledSyncAt: null,
  lastScheduledSyncStatus: "idle",
  lastScheduledSyncMessage: null,
};
