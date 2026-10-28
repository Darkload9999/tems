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
  /** Personal (e.g. Gmail) address, set by super admins; Outlook setup emails go here. */
  personalEmail?: string;
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
  targetType: 'user' | 'group' | 'permission' | 'mail' | 'settings' | 'session' | 'employee' | 'project' | 'ticket';
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
  | 'employee.onboarding_started' | 'employee.updated' | 'employee.payroll_changed' | 'employee.document_added'
  | 'employee.approval_requested' | 'employee.approved' | 'employee.rejected' | 'employee.offboarded'
  | 'agreement.sent' | 'agreement.signed'
  | 'project.assigned' | 'project.unassigned' | 'project.status_changed'
  | 'ticket.assigned' | 'ticket.updated' | 'ticket.commented'
  | 'mailbox.setup'
  | 'mail.direct';

/** A person's or team's sign-off appended to emails. */
export interface Signature {
  id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  web: string;
}
/** Notification categories that each get a signature (see signatureCategory in email.ts). */
export type SignatureCategory = 'accounts' | 'people' | 'work';

export interface SignatureFooter {
  hideBadges: boolean;
  disclaimer: string;
}

/** Work mailbox servers sent to people in Outlook setup emails. */
export interface MailboxConfig {
  incomingHost: string;
  incomingPort: number;
  incomingSecurity: MailSecurity;
  outgoingHost: string;
  outgoingPort: number;
  outgoingSecurity: MailSecurity;
  webmail: string;
}
export type MailSecurity = 'SSL/TLS' | 'STARTTLS' | 'None';

export interface Settings {
  orgName: string;
  mailFromName: string;
  mailFrom: string;
  replyTo: string;
  notifications: Record<NotifyEvent, boolean>;
  sessionIdleMinutes: number;
  passwordMinLength: number;
  /** Documents HR must upload before an employee can be submitted for approval. */
  requiredDocuments: DocCategory[];
  signatures: Signature[];
  /** Signature id per notification category ('' = none). */
  signatureFor: Record<SignatureCategory, string>;
  /** Partner badges and disclaimer shown under every signature. */
  signatureFooter: SignatureFooter;
  mailbox: MailboxConfig;
}

export interface Me {
  id: string;
  username: string;
  name: string;
  email: string;
  superAdmin: boolean;
  permissions: string[];
  groups: string[];
  /** The employee record linked to this sign-in account, if any (powers "My work"). */
  employeeId: string | null;
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
  employees: number;
  onboarding: number;
  pendingApproval: number;
  activeProjects: number;
  openTickets: number;
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
  /** Signature id ('' = none). */
  signature?: string;
}

/* ---------- HR: employees, documents, onboarding, agreements ---------- */

/** Onboarding pipeline: documents → approval → agreement → active (offboarded when they leave). */
export type EmployeeStage = 'documents' | 'approval' | 'agreement' | 'active' | 'offboarded';
export type EmploymentType = 'permanent' | 'contract' | 'probation' | 'intern';
export type DocCategory =
  | 'birth_certificate' | 'nic' | 'education' | 'cv' | 'agreement'
  | 'epf' | 'etf' | 'salary' | 'bank' | 'other';

export interface Payroll {
  basicSalary: number;
  allowances: number;
  currency: string;
  epfNumber: string;
  etfNumber: string;
  bankName: string;
  bankAccount: string;
}

export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  by: string;
  at: string;
  note: string;
}

export interface Employee {
  id: string;
  code: string;            // e.g. TZ-0007
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nic: string;
  dateOfBirth: string;     // YYYY-MM-DD or ''
  address: string;
  department: string;
  jobTitle: string;
  employmentType: EmploymentType;
  startDate: string;       // YYYY-MM-DD or ''
  stage: EmployeeStage;
  userId: string | null;   // linked TEMS sign-in account
  submittedBy: string | null;
  lastDecision: ApprovalDecision | null;
  documentCount: number;
  missingDocuments: DocCategory[];
  /** null when the caller lacks employees:payroll. */
  payroll: Payroll | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nic: string;
  dateOfBirth: string;
  address: string;
  department: string;
  jobTitle: string;
  employmentType: EmploymentType;
  startDate: string;
  userId?: string | null;
}

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  category: DocCategory;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface EmployeeEvent {
  id: string;
  at: string;
  actor: string;
  action: string;          // e.g. "employee.submitted"
  summary: string;
  note: string;
}

export type AgreementStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'void';

export interface Agreement {
  id: string;
  employeeId: string;
  title: string;
  body: string;
  status: AgreementStatus;
  createdAt: string;
  createdBy: string;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  expiresAt: string | null;
  signerName: string;
  signerIp: string;
  signature: string | null; // PNG data URL once signed
  /** The shareable signing link; only returned by sendAgreement (the server keeps a hash). */
  link?: string;
}

/** What a candidate sees on the public signing page. */
export interface PublicAgreement {
  title: string;
  body: string;
  orgName: string;
  employeeName: string;
  status: AgreementStatus;
  expiresAt: string | null;
  signedAt: string | null;
  signerName: string;
  signature: string | null;
}

/* ---------- projects + tickets ---------- */

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track';
export type TicketStatus = 'open' | 'in_progress' | 'in_review' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketType = 'task' | 'bug' | 'feature' | 'support';

export interface ProjectMember {
  employeeId: string;
  name: string;
  email: string;
  jobTitle: string;
  role: string;
  allocation: number;      // % of their time
  assignedAt: string;
}

export interface Project {
  id: string;
  key: string;             // ticket prefix, e.g. TEMS
  name: string;
  description: string;
  client: string;
  status: ProjectStatus;
  health: ProjectHealth;
  startDate: string;
  dueDate: string;
  leadId: string | null;   // employee
  leadName: string;
  members: ProjectMember[];
  ticketCounts: Record<TicketStatus, number>;
  progress: number;        // 0–100, from resolved + closed tickets
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  key: string;
  name: string;
  description: string;
  client: string;
  startDate: string;
  dueDate: string;
  leadId: string | null;
}

export interface ProjectUpdate {
  id: string;
  projectId: string;
  at: string;
  author: string;
  status: ProjectStatus;
  health: ProjectHealth;
  progress: number;
  note: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  projectKey: string;
  ref: string;             // e.g. TEMS-12
  title: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  assigneeId: string | null; // employee
  assigneeName: string;
  reporterId: string;        // TEMS user
  reporter: string;
  dueDate: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
}

export interface TicketInput {
  projectId: string;
  title: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  assigneeId: string | null;
  dueDate: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  at: string;
  author: string;
  authorId: string;
  body: string;
  system: boolean;         // status / assignment changes
}
