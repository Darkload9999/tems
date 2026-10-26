// The console's single data contract. `api` is either the live HTTP client (Go API)
// or the in-browser demo store — both implement exactly the same interface and rules.
import type {
  Agreement, AuditEntry, ComposeInput, DocCategory, Employee, EmployeeDocument, EmployeeEvent, EmployeeInput,
  EmployeeStage, Group, MailItem, MailStatus, Me, MemberPermission, Page, Payroll, PermState, Permission, Project,
  ProjectHealth, ProjectInput, ProjectStatus, ProjectUpdate, PublicAgreement, Session, Settings, Stats, Ticket,
  TicketComment, TicketInput, TicketPriority, TicketStatus, TicketType, User, UserInput,
} from './types';
import { DEMO, token } from './auth';

export interface UserQuery { search?: string; status?: 'all' | 'active' | 'disabled'; group?: string; page?: number; size?: number; }
export interface MailQuery { search?: string; status?: MailStatus | 'all'; page?: number; size?: number; }
export interface AuditQuery { search?: string; targetType?: string; page?: number; size?: number; }
export interface EmployeeQuery { search?: string; stage?: EmployeeStage | 'all'; department?: string; page?: number; size?: number; }
export interface ProjectQuery { search?: string; status?: ProjectStatus | 'all'; mine?: boolean; }
export interface TicketQuery {
  search?: string; projectId?: string; status?: TicketStatus | 'all' | 'active'; assigneeId?: string;
  priority?: TicketPriority | 'all'; mine?: boolean; page?: number; size?: number;
}
export interface TicketPatch {
  title?: string; description?: string; type?: TicketType; priority?: TicketPriority;
  status?: TicketStatus; assigneeId?: string | null; dueDate?: string;
}
export interface MailHealth { ok: boolean; host: string; detail: string; dkim: boolean; queue: number; }

export interface Api {
  me(): Promise<Me>;
  stats(): Promise<Stats>;
  mySessions(): Promise<Session[]>;

  listUsers(q?: UserQuery): Promise<Page<User>>;
  getUser(id: string): Promise<User>;
  createUser(input: UserInput): Promise<User>;
  updateUser(id: string, patch: Partial<UserInput>): Promise<User>;
  deleteUser(id: string): Promise<void>;
  resetPassword(id: string, mode: 'link' | 'temporary', temporaryPassword?: string): Promise<void>;
  sessions(id: string): Promise<Session[]>;
  revokeSessions(id: string): Promise<void>;
  setSuperAdmin(id: string, enabled: boolean): Promise<void>;
  memberPermissions(userId: string): Promise<MemberPermission[]>;
  setMemberPermission(userId: string, key: string, state: PermState): Promise<MemberPermission[]>;

  listGroups(): Promise<Group[]>;
  createGroup(g: { name: string; description: string; permissions?: string[] }): Promise<Group>;
  updateGroup(id: string, g: { name?: string; description?: string }): Promise<Group>;
  deleteGroup(id: string): Promise<void>;
  groupMembers(id: string): Promise<User[]>;
  addMembers(id: string, userIds: string[]): Promise<void>;
  removeMember(id: string, userId: string): Promise<void>;
  setGroupPermissions(id: string, permissions: string[]): Promise<Group>;

  listPermissions(): Promise<Permission[]>;
  createPermission(p: Omit<Permission, 'system'>): Promise<Permission>;
  updatePermission(key: string, p: { description: string; category: string }): Promise<Permission>;
  deletePermission(key: string): Promise<void>;

  listMail(q?: MailQuery): Promise<Page<MailItem>>;
  getMail(id: string): Promise<MailItem>;
  resendMail(id: string): Promise<MailItem>;
  deleteMail(id: string): Promise<void>;
  compose(input: ComposeInput): Promise<{ queued: number }>;
  mailHealth(): Promise<MailHealth>;

  listAudit(q?: AuditQuery): Promise<Page<AuditEntry>>;

  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;

  // HR: employees, documents, onboarding pipeline
  listEmployees(q?: EmployeeQuery): Promise<Page<Employee>>;
  getEmployee(id: string): Promise<Employee>;
  createEmployee(input: EmployeeInput): Promise<Employee>;
  updateEmployee(id: string, patch: Partial<EmployeeInput>): Promise<Employee>;
  deleteEmployee(id: string): Promise<void>;
  setPayroll(id: string, p: Payroll): Promise<Employee>;
  employeeHistory(id: string): Promise<EmployeeEvent[]>;
  listDocuments(employeeId: string): Promise<EmployeeDocument[]>;
  uploadDocument(employeeId: string, d: { category: DocCategory; title: string; file: File }): Promise<EmployeeDocument>;
  downloadDocument(employeeId: string, docId: string): Promise<Blob>;
  deleteDocument(employeeId: string, docId: string): Promise<void>;
  submitForApproval(id: string): Promise<Employee>;
  decideApproval(id: string, decision: 'approve' | 'reject', note: string): Promise<Employee>;
  offboardEmployee(id: string, note: string): Promise<Employee>;

  // agreements + public signing links
  listAgreements(employeeId: string): Promise<Agreement[]>;
  createAgreement(employeeId: string, a: { title: string; body: string }): Promise<Agreement>;
  updateAgreement(employeeId: string, agreementId: string, a: { title: string; body: string }): Promise<Agreement>;
  sendAgreement(employeeId: string, agreementId: string): Promise<Agreement>;
  voidAgreement(employeeId: string, agreementId: string): Promise<Agreement>;

  // projects
  listProjects(q?: ProjectQuery): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: ProjectInput): Promise<Project>;
  updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  projectUpdates(id: string): Promise<ProjectUpdate[]>;
  postProjectUpdate(id: string, u: { status: ProjectStatus; health: ProjectHealth; note: string }): Promise<Project>;
  addProjectMember(id: string, m: { employeeId: string; role: string; allocation: number }): Promise<Project>;
  updateProjectMember(id: string, employeeId: string, m: { role: string; allocation: number }): Promise<Project>;
  removeProjectMember(id: string, employeeId: string): Promise<Project>;

  // tickets
  listTickets(q?: TicketQuery): Promise<Page<Ticket>>;
  getTicket(id: string): Promise<Ticket>;
  createTicket(input: TicketInput): Promise<Ticket>;
  updateTicket(id: string, patch: TicketPatch): Promise<Ticket>;
  deleteTicket(id: string): Promise<void>;
  ticketComments(id: string): Promise<TicketComment[]>;
  addTicketComment(id: string, body: string): Promise<TicketComment>;
}

/** Unauthenticated calls used by the candidate's agreement signing page (/sign/). */
export interface PublicApi {
  getAgreement(token: string): Promise<PublicAgreement>;
  signAgreement(token: string, s: { name: string; signature: string }): Promise<PublicAgreement>;
}

/* ---------- live HTTP client ---------- */
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  // The API reports how many affected users it emailed for this change.
  const notified = Number(res.headers.get('X-TEMS-Notified') ?? 0);
  if (notified > 0) window.dispatchEvent(new CustomEvent('tems:notified', { detail: { count: notified } }));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}
const qs = (o: object) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== 'all') p.set(k, String(v)); });
  const s = p.toString(); return s ? `?${s}` : '';
};
const e = encodeURIComponent;

const http: Api = {
  me: () => call('GET', '/me'),
  stats: () => call('GET', '/stats'),
  mySessions: () => call('GET', '/me/sessions'),

  listUsers: (q = {}) => call('GET', `/users${qs(q)}`),
  getUser: (id) => call('GET', `/users/${e(id)}`),
  createUser: (input) => call('POST', '/users', input),
  updateUser: (id, patch) => call('PATCH', `/users/${e(id)}`, patch),
  deleteUser: (id) => call('DELETE', `/users/${e(id)}`),
  resetPassword: (id, mode, temporaryPassword) => call('POST', `/users/${e(id)}/reset-password`, { mode, temporaryPassword }),
  sessions: (id) => call('GET', `/users/${e(id)}/sessions`),
  revokeSessions: (id) => call('DELETE', `/users/${e(id)}/sessions`),
  setSuperAdmin: (id, enabled) => call('PUT', `/users/${e(id)}/super-admin`, { enabled }),
  memberPermissions: (id) => call('GET', `/users/${e(id)}/permissions`),
  setMemberPermission: (id, key, state) => call('PUT', `/users/${e(id)}/permissions/${e(key)}`, { state }),

  listGroups: () => call('GET', '/groups'),
  createGroup: (g) => call('POST', '/groups', g),
  updateGroup: (id, g) => call('PATCH', `/groups/${e(id)}`, g),
  deleteGroup: (id) => call('DELETE', `/groups/${e(id)}`),
  groupMembers: (id) => call('GET', `/groups/${e(id)}/members`),
  addMembers: (id, userIds) => call('POST', `/groups/${e(id)}/members`, { userIds }),
  removeMember: (id, uid) => call('DELETE', `/groups/${e(id)}/members/${e(uid)}`),
  setGroupPermissions: (id, permissions) => call('PUT', `/groups/${e(id)}/permissions`, { permissions }),

  listPermissions: () => call('GET', '/permissions'),
  createPermission: (p) => call('POST', '/permissions', p),
  updatePermission: (key, p) => call('PATCH', `/permissions/${e(key)}`, p),
  deletePermission: (key) => call('DELETE', `/permissions/${e(key)}`),

  listMail: (q = {}) => call('GET', `/mail${qs(q)}`),
  getMail: (id) => call('GET', `/mail/${e(id)}`),
  resendMail: (id) => call('POST', `/mail/${e(id)}/resend`),
  deleteMail: (id) => call('DELETE', `/mail/${e(id)}`),
  compose: (input) => call('POST', '/mail/compose', input),
  mailHealth: () => call('GET', '/mail/health'),

  listAudit: (q = {}) => call('GET', `/audit${qs(q)}`),

  getSettings: () => call('GET', '/settings'),
  saveSettings: (s) => call('PUT', '/settings', s),

  listEmployees: (q = {}) => call('GET', `/employees${qs(q)}`),
  getEmployee: (id) => call('GET', `/employees/${e(id)}`),
  createEmployee: (input) => call('POST', '/employees', input),
  updateEmployee: (id, patch) => call('PATCH', `/employees/${e(id)}`, patch),
  deleteEmployee: (id) => call('DELETE', `/employees/${e(id)}`),
  setPayroll: (id, p) => call('PUT', `/employees/${e(id)}/payroll`, p),
  employeeHistory: (id) => call('GET', `/employees/${e(id)}/history`),
  listDocuments: (id) => call('GET', `/employees/${e(id)}/documents`),
  uploadDocument: (id, d) => {
    const f = new FormData();
    f.set('category', d.category); f.set('title', d.title); f.set('file', d.file);
    return call('POST', `/employees/${e(id)}/documents`, f);
  },
  downloadDocument: async (id, docId) => {
    const res = await fetch(`/api/employees/${e(id)}/documents/${e(docId)}/file`, { headers: { Authorization: `Bearer ${await token()}` } });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `Download failed (${res.status})`);
    return res.blob();
  },
  deleteDocument: (id, docId) => call('DELETE', `/employees/${e(id)}/documents/${e(docId)}`),
  submitForApproval: (id) => call('POST', `/employees/${e(id)}/submit`),
  decideApproval: (id, decision, note) => call('POST', `/employees/${e(id)}/decision`, { decision, note }),
  offboardEmployee: (id, note) => call('POST', `/employees/${e(id)}/offboard`, { note }),

  listAgreements: (id) => call('GET', `/employees/${e(id)}/agreements`),
  createAgreement: (id, a) => call('POST', `/employees/${e(id)}/agreements`, a),
  updateAgreement: (id, aid, a) => call('PATCH', `/employees/${e(id)}/agreements/${e(aid)}`, a),
  sendAgreement: (id, aid) => call('POST', `/employees/${e(id)}/agreements/${e(aid)}/send`),
  voidAgreement: (id, aid) => call('POST', `/employees/${e(id)}/agreements/${e(aid)}/void`),

  listProjects: (q = {}) => call('GET', `/projects${qs(q)}`),
  getProject: (id) => call('GET', `/projects/${e(id)}`),
  createProject: (input) => call('POST', '/projects', input),
  updateProject: (id, patch) => call('PATCH', `/projects/${e(id)}`, patch),
  deleteProject: (id) => call('DELETE', `/projects/${e(id)}`),
  projectUpdates: (id) => call('GET', `/projects/${e(id)}/updates`),
  postProjectUpdate: (id, u) => call('POST', `/projects/${e(id)}/updates`, u),
  addProjectMember: (id, m) => call('POST', `/projects/${e(id)}/members`, m),
  updateProjectMember: (id, eid, m) => call('PATCH', `/projects/${e(id)}/members/${e(eid)}`, m),
  removeProjectMember: (id, eid) => call('DELETE', `/projects/${e(id)}/members/${e(eid)}`),

  listTickets: (q = {}) => call('GET', `/tickets${qs(q)}`),
  getTicket: (id) => call('GET', `/tickets/${e(id)}`),
  createTicket: (input) => call('POST', '/tickets', input),
  updateTicket: (id, patch) => call('PATCH', `/tickets/${e(id)}`, patch),
  deleteTicket: (id) => call('DELETE', `/tickets/${e(id)}`),
  ticketComments: (id) => call('GET', `/tickets/${e(id)}/comments`),
  addTicketComment: (id, body) => call('POST', `/tickets/${e(id)}/comments`, { body }),
};

async function publicCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/public${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const httpPublic: PublicApi = {
  getAgreement: (t) => publicCall('GET', `/agreements/${e(t)}`),
  signAgreement: (t, s) => publicCall('POST', `/agreements/${e(t)}/sign`, s),
};

let impl: Api | null = DEMO ? null : http;
let publicImpl: PublicApi | null = DEMO ? null : httpPublic;
export async function getPublicApi(): Promise<PublicApi> {
  if (!publicImpl) publicImpl = (await import('./demo')).demoPublicApi;
  return publicImpl;
}
/** Resolved lazily so the demo store (and its seed data) is only bundled-in when used. */
export async function getApi(): Promise<Api> {
  if (!impl) impl = (await import('./demo')).demoApi;
  return impl;
}
