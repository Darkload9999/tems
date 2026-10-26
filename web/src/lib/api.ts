// The console's single data contract. `api` is either the live HTTP client (Go API)
// or the in-browser demo store — both implement exactly the same interface and rules.
import type {
  AuditEntry, ComposeInput, Group, MailItem, MailStatus, Me, MemberPermission, Page,
  PermState, Permission, Session, Settings, Stats, User, UserInput,
} from './types';
import { DEMO, token } from './auth';

export interface UserQuery { search?: string; status?: 'all' | 'active' | 'disabled'; group?: string; page?: number; size?: number; }
export interface MailQuery { search?: string; status?: MailStatus | 'all'; page?: number; size?: number; }
export interface AuditQuery { search?: string; targetType?: string; page?: number; size?: number; }
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
}

/* ---------- live HTTP client ---------- */
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
};

let impl: Api | null = DEMO ? null : http;
/** Resolved lazily so the demo store (and its seed data) is only bundled-in when used. */
export async function getApi(): Promise<Api> {
  if (!impl) impl = (await import('./demo')).demoApi;
  return impl;
}
