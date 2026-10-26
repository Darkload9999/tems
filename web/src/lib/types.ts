// Shared shapes for the TEMS console. The Go API returns exactly these.

export interface Permission {
  key: string;            // e.g. "users:edit" (a Keycloak client role on tems-api)
  description: string;
  category: string;
  system: boolean;        // built-in permissions cannot be deleted
}

export interface Group {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  memberCount: number;
  createdAt: string;
}

export interface UserAttrs {
  department?: string;
  jobTitle?: string;
  phone?: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified: boolean;
  superAdmin: boolean;
  groups: string[];       // group ids
  grants: string[];       // direct per-member grants
  denies: string[];       // per-member denies (override group grants)
  attributes: UserAttrs;
  requiredActions: string[];
  createdAt: string;
  lastLogin: string | null;
}

export interface Session {
  id: string;
  ip: string;
  client: string;
  start: string;
  lastAccess: string;
}

export type PermState = 'inherit' | 'allow' | 'deny';

export interface MemberPermission {
  key: string;
  description: string;
  category: string;
  fromGroups: string[];   // names of groups that grant it
  state: PermState;       // the member-level override
  effective: boolean;
}

export type MailStatus = 'queued' | 'sent' | 'failed';

export interface MailItem {
  id: string;
  to: string;
  toName: string;
  userId: string | null;
  subject: string;
  event: NotifyEvent;
  status: MailStatus;
  attempts: number;
  error: string | null;
  triggeredBy: string;
  createdAt: string;
  sentAt: string | null;
  html: string;
  text: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actor: string;
  action: string;         // e.g. "user.update"
  targetType: 'user' | 'group' | 'permission' | 'mail' | 'settings' | 'session';
  targetId: string;
  targetName: string;
  summary: string;
  details: Record<string, unknown>;
  ip: string;
}

export type NotifyEvent =
  | 'user.created' | 'user.updated' | 'user.disabled' | 'user.enabled' | 'user.deleted'
  | 'user.password_reset' | 'user.sessions_revoked'
  | 'group.member_added' | 'group.member_removed' | 'group.permissions_changed'
  | 'group.renamed' | 'group.deleted'
  | 'member.permissions_changed' | 'superadmin.granted' | 'superadmin.revoked'
  | 'mail.direct';

export interface Settings {
  orgName: string;
  mailFromName: string;
  mailFrom: string;
  replyTo: string;
  notifications: Record<NotifyEvent, boolean>;
  sessionIdleMinutes: number;
  passwordMinLength: number;
}

export interface Me {
  id: string;
  username: string;
  name: string;
  email: string;
  superAdmin: boolean;
  permissions: string[];
  groups: string[];
}

export interface Stats {
  users: number;
  activeUsers: number;
  disabledUsers: number;
  groups: number;
  permissions: number;
  customPermissions: number;
  mailSent24h: number;
  mailFailed: number;
  mailQueued: number;
  sessions: number;
  superAdmins: number;
}

export interface Page<T> { items: T[]; total: number; }

export interface UserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  attributes: UserAttrs;
  groups?: string[];
  setup?: 'link' | 'temporary';
  temporaryPassword?: string;
}

export interface ComposeInput {
  userIds: string[];
  groupIds: string[];
  subject: string;
  message: string;
}
