// In-browser demo backend. Mirrors the Go API's behaviour and rules:
//   • permission checks on every call (super admins bypass)
//   • no privilege escalation: you can only grant permissions you hold, and only
//     super admins may change their own access or touch other super admins
//   • every change is audited and the affected users are emailed (outbox)
import type {
  Agreement, AuditEntry, DocCategory, Employee, EmployeeDocument, EmployeeEvent, EmployeeInput, Group, MailItem, Me,
  MemberPermission, NotifyEvent, Payroll, Permission, PermState, Project, ProjectMember, ProjectUpdate, PublicAgreement,
  Session, Settings, Stats, Ticket, TicketComment, User,
} from './types';
import type { Api, AuditQuery, MailQuery, PublicApi, UserQuery } from './api';
import { EVENTS, FORCED, renderEmail, type EmailData } from './email';
import { demoAs } from './auth';
import { DOCS, EMPLOYMENT, HEALTH, PRIORITY, PROJECT_STATUS, TICKET_ORDER, TICKET_STATUS, TICKET_TYPE } from './hr';
import { fullName } from './ui';

const KEY = 'tems-demo-v2';
const MAX_MAIL = 400;
const MAX_AUDIT = 600;

type StoredGroup = Omit<Group, 'memberCount'>;
type StoredEmployee = Omit<Employee, 'documentCount' | 'missingDocuments' | 'payroll'> & { payroll: Payroll; submittedById: string | null };
type StoredDoc = EmployeeDocument & { data: string | null }; // data URL; large demo files keep metadata only
type StoredAgreement = Agreement & { token: string | null; sentById: string | null };
type StoredProject = Omit<Project, 'members' | 'ticketCounts' | 'progress' | 'overdue' | 'leadName'> & { seq: number };
type StoredMember = Omit<ProjectMember, 'name' | 'email' | 'jobTitle'> & { projectId: string };
type StoredTicket = Omit<Ticket, 'ref' | 'projectKey' | 'assigneeName' | 'commentCount'> & { number: number };
interface State {
  users: User[];
  groups: StoredGroup[];
  perms: Permission[];
  mail: MailItem[];
  audit: AuditEntry[];
  settings: Settings;
  sessions: Record<string, Session[]>;
  employees: StoredEmployee[];
  docs: StoredDoc[];
  empEvents: Array<EmployeeEvent & { employeeId: string }>;
  agreements: StoredAgreement[];
  projects: StoredProject[];
  members: StoredMember[];
  updates: ProjectUpdate[];
  tickets: StoredTicket[];
  comments: TicketComment[];
}

/* ---------- utilities ---------- */
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const id = (p: string) => `${p}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
const wait = (ms = 140 + Math.random() * 200) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const lc = (s: string) => s.toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function paginate<T>(items: T[], page = 1, size = 10) {
  const p = Math.max(1, page);
  return { items: clone(items.slice((p - 1) * size, p * size)), total: items.length };
}

/* ---------- seed ---------- */
const P = (key: string, category: string, description: string, system = true): Permission => ({ key, category, description, system });

function seedPerms(): Permission[] {
  return [
    P('dashboard:view', 'Dashboard', 'View the dashboard and system statistics'),
    P('users:view', 'Users', 'View users and their profiles'),
    P('users:create', 'Users', 'Create new user accounts'),
    P('users:edit', 'Users', 'Edit profiles, enable and disable accounts'),
    P('users:delete', 'Users', 'Permanently delete user accounts'),
    P('users:reset-password', 'Users', 'Reset passwords and send account setup links'),
    P('users:sessions', 'Users', 'View and revoke active sign-in sessions'),
    P('groups:view', 'Groups', 'View groups and their members'),
    P('groups:create', 'Groups', 'Create new groups'),
    P('groups:edit', 'Groups', 'Rename groups and edit their details'),
    P('groups:delete', 'Groups', 'Delete groups'),
    P('groups:members', 'Groups', 'Add and remove group members'),
    P('permissions:view', 'Permissions', 'View the permission catalog and assignments'),
    P('permissions:manage', 'Permissions', 'Assign permissions to groups and members; edit catalog'),
    P('mail:view', 'Mail', 'View the outbox and delivery status'),
    P('mail:send', 'Mail', 'Compose and send messages to users and groups'),
    P('mail:manage', 'Mail', 'Resend, cancel and delete mail; manage notifications'),
    P('audit:view', 'Audit', 'View the audit log'),
    P('settings:manage', 'Settings', 'Change system settings'),
    P('employees:view', 'Employees', 'View employee records, documents and onboarding status'),
    P('employees:manage', 'Employees', 'Create and edit employees, upload documents, send agreements'),
    P('employees:approve', 'Employees', 'Approve or reject onboarding (cannot approve your own submissions)'),
    P('employees:payroll', 'Employees', 'View and edit salary, EPF/ETF and bank details and payroll documents'),
    P('employees:delete', 'Employees', 'Permanently delete employee records and their documents'),
    P('projects:view', 'Projects', 'View every project, its team and status history'),
    P('projects:manage', 'Projects', 'Create projects, assign people and post status updates'),
    P('tickets:view', 'Tickets', 'View tickets on every project'),
    P('tickets:create', 'Tickets', 'Raise tickets on any project'),
    P('tickets:manage', 'Tickets', 'Edit, assign, close and delete any ticket'),
    P('reports:export', 'Reports', 'Export user and access reports as CSV', false),
  ];
}

function seed(): State {
  const perms = seedPerms();
  const all = perms.map((p) => p.key);
  const groups: StoredGroup[] = [
    { id: 'g_admins', name: 'Administrators', description: 'Full operational access to users, groups, mail and audit', permissions: [...all], createdAt: ago(60 * 24 * 40) },
    { id: 'g_support', name: 'Support', description: 'Help-desk: manage accounts and contact users', permissions: ['dashboard:view', 'users:view', 'users:edit', 'users:reset-password', 'users:sessions', 'groups:view', 'mail:view', 'mail:send', 'audit:view'], createdAt: ago(60 * 24 * 40) },
    { id: 'g_soc', name: 'SOC Analysts', description: 'Security operations: read-only visibility across identities and audit', permissions: ['dashboard:view', 'users:view', 'users:sessions', 'groups:view', 'permissions:view', 'mail:view', 'audit:view'], createdAt: ago(60 * 24 * 21) },
    { id: 'g_staff', name: 'Staff', description: 'Standard employees: sign in and manage their own account', permissions: ['dashboard:view'], createdAt: ago(60 * 24 * 40) },
    { id: 'g_hr', name: 'HR', description: 'Human resources: employee records, documents, payroll and agreements', permissions: ['dashboard:view', 'employees:view', 'employees:manage', 'employees:payroll', 'users:view', 'mail:view'], createdAt: ago(60 * 24 * 30) },
    { id: 'g_pm', name: 'Project Managers', description: 'Run projects: assign people, track status and manage tickets', permissions: ['dashboard:view', 'employees:view', 'projects:view', 'projects:manage', 'tickets:view', 'tickets:create', 'tickets:manage'], createdAt: ago(60 * 24 * 30) },
  ];

  type Seed = [string, string, string, string, string, string, string[], Partial<User>?];
  const rows: Seed[] = [
    ['superadmin', 'Super', 'Admin', 'admin@tems.techzaz.lk', 'IT Governance', 'Platform Owner', ['g_admins'], { superAdmin: true }],
    ['nimal.perera', 'Nimal', 'Perera', 'nimal.perera@techzaz.lk', 'Security Operations', 'SOC Lead', ['g_admins', 'g_soc']],
    ['kasun.liyanage', 'Kasun', 'Liyanage', 'kasun.liyanage@techzaz.lk', 'IT Infrastructure', 'Infrastructure Manager', ['g_admins']],
    ['kavindi.silva', 'Kavindi', 'Silva', 'kavindi.silva@techzaz.lk', 'Customer Success', 'Support Engineer', ['g_support', 'g_staff']],
    ['sachini.bandara', 'Sachini', 'Bandara', 'sachini.bandara@techzaz.lk', 'Project Management', 'Project Manager', ['g_support', 'g_pm', 'g_staff'], { denies: ['users:reset-password'] }],
    ['dilini.perera', 'Dilini', 'Perera', 'dilini.perera@techzaz.lk', 'Human Resources', 'HR Executive', ['g_hr', 'g_staff']],
    ['hiruni.dealwis', 'Hiruni', 'De Alwis', 'hiruni.dealwis@techzaz.lk', 'Customer Success', 'Support Associate', ['g_support', 'g_staff']],
    ['nethmi.karunaratne', 'Nethmi', 'Karunaratne', 'nethmi.karunaratne@techzaz.lk', 'Cybersecurity', 'SOC Analyst', ['g_soc', 'g_staff']],
    ['dilan.wickramasinghe', 'Dilan', 'Wickramasinghe', 'dilan.w@techzaz.lk', 'Cybersecurity', 'Penetration Tester', ['g_staff'], { grants: ['audit:view', 'users:view'] }],
    ['ruwan.fernando', 'Ruwan', 'Fernando', 'ruwan.fernando@techzaz.lk', 'Network Engineering', 'Network Engineer', ['g_staff']],
    ['ishara.jayasinghe', 'Ishara', 'Jayasinghe', 'ishara.j@techzaz.lk', 'Software Engineering', 'Full-stack Developer', ['g_staff']],
    ['tharindu.gunawardena', 'Tharindu', 'Gunawardena', 'tharindu.g@techzaz.lk', 'ISO Audits', 'Compliance Analyst', ['g_staff']],
    ['amaya.rathnayake', 'Amaya', 'Rathnayake', 'amaya.r@techzaz.lk', 'Software Engineering', 'QA Engineer', ['g_staff'], { enabled: false }],
    ['chamod.dias', 'Chamod', 'Dias', 'chamod.dias@techzaz.lk', 'Network Engineering', 'NOC Technician', ['g_staff'], { requiredActions: ['UPDATE_PASSWORD'], lastLogin: null }],
    ['pasindu.herath', 'Pasindu', 'Herath', 'pasindu.herath@techzaz.lk', 'Software Engineering', 'Engineering Intern', ['g_staff']],
    ['old.contractor', 'Legacy', 'Contractor', 'contractor@vendor.invalid', 'External', 'Contractor', [], { enabled: false, lastLogin: ago(60 * 24 * 90) }],
  ];
  const users: User[] = rows.map(([username, firstName, lastName, email, department, jobTitle, gids, extra], i) => ({
    id: `u_${username.replace(/\W/g, '')}`,
    username, firstName, lastName, email,
    enabled: true, emailVerified: true, superAdmin: false,
    groups: gids, grants: [], denies: [], requiredActions: [],
    attributes: { department, jobTitle, phone: `+94 7${(i % 8) + 1} ${String(4100000 + i * 73519).slice(0, 3)} ${String(4100000 + i * 73519).slice(3, 7)}` },
    createdAt: ago(60 * 24 * (40 - i * 2)),
    lastLogin: ago(i === 0 ? 3 : 25 + i * 190),
    ...extra,
  }));

  const sessions: Record<string, Session[]> = {};
  users.forEach((u, i) => {
    if (!u.enabled || !u.lastLogin || Date.now() - new Date(u.lastLogin).getTime() > 2 * 86_400_000) return;
    sessions[u.id] = [{ id: id('s_'), ip: i % 3 ? `112.134.${40 + i}.${10 + i * 7}` : `10.0.4.${20 + i}`, client: 'Techzaz EMS Console', start: ago(40 + i * 120), lastAccess: u.lastLogin }];
    if (i % 4 === 1) sessions[u.id].push({ id: id('s_'), ip: `175.157.${10 + i}.${90 + i}`, client: 'Account Console', start: ago(600 + i * 60), lastAccess: ago(400 + i * 30) });
  });

  const settings: Settings = {
    orgName: 'Techzaz Networks',
    mailFromName: 'Techzaz EMS',
    mailFrom: 'no-reply@tems.techzaz.lk',
    replyTo: 'soc@techzaz.lk',
    notifications: Object.fromEntries((Object.keys(EVENTS) as NotifyEvent[]).map((k) => [k, true])) as Record<NotifyEvent, boolean>,
    sessionIdleMinutes: 30,
    passwordMinLength: 10,
    requiredDocuments: ['birth_certificate', 'nic', 'education'],
  };

  const S: State = {
    users, groups, perms, mail: [], audit: [], settings, sessions,
    employees: [], docs: [], empEvents: [], agreements: [], projects: [], members: [], updates: [], tickets: [], comments: [],
  };
  seedWork(S);

  // history: audit + mail that "already happened"
  const actor = users[0], nimal = users[1];
  const u = (name: string) => users.find((x) => x.username === name)!;
  const past: Array<[number, User, string, AuditEntry['targetType'], User | StoredGroup | null, string, NotifyEvent | null, Partial<EmailData>, User[]]> = [
    [60 * 24 * 6, actor, 'group.create', 'group', groups[2], 'Created group SOC Analysts', null, {}, []],
    [60 * 24 * 6 - 5, actor, 'group.members.add', 'group', groups[2], 'Added Nethmi Karunaratne to SOC Analysts', 'group.member_added', { group: 'SOC Analysts', added: ['permissions:view', 'users:sessions', 'audit:view', 'mail:view'] }, [u('nethmi.karunaratne')]],
    [60 * 24 * 4, nimal, 'user.create', 'user', u('pasindu.herath'), 'Created user pasindu.herath', 'user.created', { setup: 'link' }, [u('pasindu.herath')]],
    [60 * 24 * 3, nimal, 'member.permission.set', 'user', u('dilan.wickramasinghe'), 'Allowed audit:view, users:view for dilan.wickramasinghe', 'member.permissions_changed', { added: ['audit:view', 'users:view'] }, [u('dilan.wickramasinghe')]],
    [60 * 24 * 2, actor, 'member.permission.set', 'user', u('sachini.bandara'), 'Denied users:reset-password for sachini.bandara', 'member.permissions_changed', { removed: ['users:reset-password'] }, [u('sachini.bandara')]],
    [60 * 30, nimal, 'user.disable', 'user', u('amaya.rathnayake'), 'Disabled amaya.rathnayake', 'user.disabled', {}, [u('amaya.rathnayake')]],
    [60 * 20, actor, 'user.update', 'user', u('old.contractor'), 'Updated contractor email', 'user.updated', { changes: ['Email: legacy@vendor.invalid → contractor@vendor.invalid'] }, [u('old.contractor')]],
    [60 * 6, actor, 'user.create', 'user', u('chamod.dias'), 'Created user chamod.dias', 'user.created', { setup: 'temporary' }, [u('chamod.dias')]],
    [60 * 2, actor, 'group.permissions.set', 'group', groups[1], 'Support: +mail:send', 'group.permissions_changed', { group: 'Support', added: ['mail:send'] }, users.filter((x) => x.groups.includes('g_support'))],
    [35, nimal, 'user.password.reset', 'user', u('ruwan.fernando'), 'Sent a password setup link to ruwan.fernando', 'user.password_reset', { setup: 'link' }, [u('ruwan.fernando')]],
    [12, nimal, 'user.sessions.revoke', 'user', u('ishara.jayasinghe'), 'Signed ishara.jayasinghe out of all sessions', 'user.sessions_revoked', {}, [u('ishara.jayasinghe')]],
  ];
  for (const [min, who, action, tt, target, summary, ev, data, recips] of past) {
    const at = ago(min);
    const targetName = target ? ('username' in target ? target.username : target.name) : '';
    S.audit.unshift({ id: id('a_'), at, actorId: who.id, actor: fullName(who), action, targetType: tt, targetId: target?.id ?? '', targetName, summary, details: data as Record<string, unknown>, ip: '10.0.4.27' });
    if (!ev) continue;
    for (const r of recips) {
      const m = renderEmail(ev, { origin: location.origin, firstName: r.firstName, username: r.username, actor: fullName(who), ...data });
      const failed = r.email.endsWith('.invalid');
      S.mail.unshift({
        id: id('m_'), to: r.email, toName: fullName(r), userId: r.id, subject: m.subject, event: ev,
        status: failed ? 'failed' : 'sent', attempts: failed ? 5 : 1,
        error: failed ? '550 5.1.2 <contractor@vendor.invalid>: Recipient address rejected: Domain not found' : null,
        triggeredBy: fullName(who), createdAt: at, sentAt: failed ? null : ago(min - 0.2), html: m.html, text: m.text,
      });
    }
  }
  S.audit.sort((a, b) => b.at.localeCompare(a.at));
  S.mail.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return S;
}

/* ---------- persistence ---------- */
let S: State = load();
function load(): State {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw) as State; } catch {}
  const s = seed();
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}
function save() {
  S.mail.length = Math.min(S.mail.length, MAX_MAIL);
  S.audit.length = Math.min(S.audit.length, MAX_AUDIT);
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {}
}
export function resetDemo() { S = seed(); save(); }

/* ---------- access rules ---------- */
function meUser(): User {
  const as = demoAs();
  return S.users.find((u) => u.id === as && u.enabled) ?? S.users.find((u) => u.superAdmin)!;
}
const groupById = (gid: string) => S.groups.find((g) => g.id === gid);
const userById = (uid: string) => { const u = S.users.find((x) => x.id === uid); if (!u) throw new Error('User not found.'); return u; };
const catalog = () => new Set(S.perms.map((p) => p.key));

function effective(u: User): Set<string> {
  const cat = catalog();
  if (u.superAdmin) return cat;
  const s = new Set<string>();
  u.groups.forEach((g) => groupById(g)?.permissions.forEach((p) => s.add(p)));
  u.grants.forEach((p) => s.add(p));
  u.denies.forEach((p) => s.delete(p));
  return new Set([...s].filter((p) => cat.has(p)));
}
function has(u: User, perm: string) { return effective(u).has(perm); }
function need(...anyOf: string[]): User {
  const u = meUser();
  if (!anyOf.some((p) => has(u, p))) throw new Error(`You need the “${anyOf[0]}” permission to do that.`);
  return u;
}
function needSuper(): User {
  const u = meUser();
  if (!u.superAdmin) throw new Error('Only super administrators can do that.');
  return u;
}
/** Non-super admins can only hand out permissions they hold themselves. */
function canGrant(actor: User, keys: string[]) {
  if (actor.superAdmin) return;
  const mine = effective(actor);
  const bad = keys.filter((k) => !mine.has(k));
  if (bad.length) throw new Error(`You can only grant permissions you hold yourself (${bad.join(', ')}).`);
}
/** Only super admins may change a super admin's account, or their own access. */
function guardTarget(actor: User, target: User, what: 'edit' | 'access') {
  if (actor.superAdmin) return;
  if (target.superAdmin) throw new Error('Only super administrators can change a super administrator.');
  if (what === 'access' && target.id === actor.id) throw new Error('You cannot change your own access.');
}

/* ---------- side effects: audit + notify ---------- */
function audit(action: string, targetType: AuditEntry['targetType'], targetId: string, targetName: string, summary: string, details: Record<string, unknown> = {}) {
  const a = meUser();
  S.audit.unshift({ id: id('a_'), at: now(), actorId: a.id, actor: fullName(a), action, targetType, targetId, targetName, summary, details, ip: '10.0.4.27' });
}

function notify(ev: NotifyEvent, users: User[], data: (u: User) => Partial<EmailData> = () => ({}), force = false): number {
  return notifyTo(ev, users.map(userR), (r) => data(userById(r.userId!)), force);
}

/** Anyone TEMS emails: a sign-in account, an employee or a candidate. */
interface Rcpt { email: string; name: string; first: string; username?: string; userId?: string | null }
const userR = (u: User): Rcpt => ({ email: u.email, name: fullName(u), first: u.firstName, username: u.username, userId: u.id });

function notifyTo(ev: NotifyEvent, rs: Rcpt[], data: (r: Rcpt) => Partial<EmailData> = () => ({}), force = false, actorName?: string): number {
  if (!force && !FORCED.includes(ev) && !S.settings.notifications[ev]) return 0;
  const actor = actorName ?? fullName(meUser());
  const seen = new Set<string>();
  let n = 0;
  for (const u of rs) {
    if (!u.email || seen.has(lc(u.email))) continue;
    seen.add(lc(u.email));
    const r = renderEmail(ev, { origin: location.origin, firstName: u.first, username: u.username, actor, ...data(u) });
    const m: MailItem = {
      id: id('m_'), to: u.email, toName: u.name, userId: u.userId ?? null, subject: r.subject, event: ev,
      status: 'queued', attempts: 0, error: null, triggeredBy: actor, createdAt: now(), sentAt: null, html: r.html, text: r.text,
    };
    S.mail.unshift(m); n++;
    deliver(m.id);
  }
  // direct messages (force) report their own count; admin changes announce who was emailed
  if (n && !force) window.dispatchEvent(new CustomEvent('tems:notified', { detail: { count: n, event: ev } }));
  return n;
}

/** Simulated Postfix delivery: .invalid domains bounce, everything else is delivered. */
function deliver(mid: string) {
  setTimeout(() => {
    const m = S.mail.find((x) => x.id === mid);
    if (!m || m.status !== 'queued') return;
    m.attempts++;
    if (m.to.endsWith('.invalid')) {
      m.status = 'failed';
      m.error = `550 5.1.2 <${m.to}>: Recipient address rejected: Domain not found`;
    } else { m.status = 'sent'; m.sentAt = now(); }
    save();
    window.dispatchEvent(new CustomEvent('tems:mail', { detail: { id: m.id, status: m.status } }));
  }, 1100 + Math.random() * 1600);
}

const permDiff = (before: Set<string>, after: Set<string>) => ({
  added: [...after].filter((k) => !before.has(k)).sort(),
  removed: [...before].filter((k) => !after.has(k)).sort(),
});
const groupWithCount = (g: StoredGroup): Group => ({ ...clone(g), memberCount: S.users.filter((u) => u.groups.includes(g.id)).length });

function validatePassword(pw: string) {
  const min = S.settings.passwordMinLength;
  if (pw.length < min || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/\d/.test(pw))
    throw new Error(`Password must be at least ${min} characters with upper case, lower case and a digit.`);
}

/* ---------- API ---------- */
export const demoApi: Api = {
  async me(): Promise<Me> {
    await wait(60);
    const u = meUser();
    return {
      id: u.id, username: u.username, name: fullName(u), email: u.email, superAdmin: u.superAdmin,
      permissions: [...effective(u)].sort(),
      groups: u.groups.map((g) => groupById(g)?.name ?? '').filter(Boolean),
      employeeId: myEmp()?.id ?? null,
    };
  },

  async stats(): Promise<Stats> {
    await wait();
    need('dashboard:view');
    const day = Date.now() - 86_400_000;
    return {
      users: S.users.length,
      activeUsers: S.users.filter((u) => u.enabled).length,
      disabledUsers: S.users.filter((u) => !u.enabled).length,
      groups: S.groups.length,
      permissions: S.perms.length,
      customPermissions: S.perms.filter((p) => !p.system).length,
      mailSent24h: S.mail.filter((m) => m.status === 'sent' && m.sentAt && new Date(m.sentAt).getTime() > day).length,
      mailFailed: S.mail.filter((m) => m.status === 'failed').length,
      mailQueued: S.mail.filter((m) => m.status === 'queued').length,
      sessions: Object.values(S.sessions).reduce((n, s) => n + s.length, 0),
      superAdmins: S.users.filter((u) => u.superAdmin).length,
      employees: S.employees.filter((e) => e.stage !== 'offboarded').length,
      onboarding: S.employees.filter((e) => ['documents', 'approval', 'agreement'].includes(e.stage)).length,
      pendingApproval: S.employees.filter((e) => e.stage === 'approval').length,
      activeProjects: S.projects.filter((p) => ['planning', 'active', 'on_hold'].includes(p.status)).length,
      openTickets: S.tickets.filter((t) => ['open', 'in_progress', 'in_review'].includes(t.status)).length,
    };
  },

  async mySessions() { await wait(); return clone(S.sessions[meUser().id] ?? []); },

  /* ----- users ----- */
  async listUsers(q: UserQuery = {}) {
    await wait();
    need('users:view', 'groups:view', 'mail:send');
    const s = lc(q.search ?? '');
    let list = S.users.filter((u) =>
      (!s || [u.username, u.email, fullName(u), u.attributes.department ?? '', u.attributes.jobTitle ?? ''].some((v) => lc(v).includes(s))) &&
      (q.status !== 'active' || u.enabled) && (q.status !== 'disabled' || !u.enabled) &&
      (!q.group || u.groups.includes(q.group)));
    list = [...list].sort((a, b) => fullName(a).localeCompare(fullName(b)));
    return paginate(list, q.page, q.size ?? 10);
  },

  async getUser(uid) {
    await wait();
    const me = meUser();
    if (uid !== me.id) need('users:view');
    return clone(userById(uid));
  },

  async createUser(input) {
    await wait(320);
    const actor = need('users:create');
    const username = lc(input.username.trim());
    if (!/^[a-z0-9][a-z0-9._-]{2,40}$/.test(username)) throw new Error('Username must be 3–40 characters: letters, digits, dot, dash or underscore.');
    if (!EMAIL_RE.test(input.email)) throw new Error('Enter a valid email address.');
    if (S.users.some((u) => u.username === username)) throw new Error(`The username “${username}” is already taken.`);
    if (S.users.some((u) => lc(u.email) === lc(input.email))) throw new Error('Another user already uses that email address.');
    const groups = input.groups ?? [];
    if (groups.length) { need('groups:members'); canGrant(actor, groups.flatMap((g) => groupById(g)?.permissions ?? [])); }
    if (input.setup === 'temporary') validatePassword(input.temporaryPassword ?? '');
    const u: User = {
      id: id('u_'), username, email: input.email.trim(), firstName: input.firstName.trim(), lastName: input.lastName.trim(),
      enabled: input.enabled, emailVerified: false, superAdmin: false, groups, grants: [], denies: [],
      attributes: { ...input.attributes }, requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], createdAt: now(), lastLogin: null,
    };
    S.users.push(u);
    audit('user.create', 'user', u.id, u.username, `Created user ${u.username}`, { email: u.email, groups: groups.map((g) => groupById(g)?.name), setup: input.setup });
    notify('user.created', [u], () => ({ setup: input.setup ?? 'link' }));
    save();
    return clone(u);
  },

  async updateUser(uid, patch) {
    await wait(260);
    const actor = need('users:edit');
    const u = userById(uid);
    guardTarget(actor, u, 'edit');
    if (patch.enabled === false && u.id === actor.id) throw new Error('You cannot disable your own account.');
    const changes: string[] = [];
    const set = <K extends 'firstName' | 'lastName' | 'email'>(k: K, label: string) => {
      const v = patch[k]; if (v === undefined || v.trim() === u[k]) return;
      if (k === 'email') {
        if (!EMAIL_RE.test(v)) throw new Error('Enter a valid email address.');
        if (S.users.some((x) => x.id !== u.id && lc(x.email) === lc(v))) throw new Error('Another user already uses that email address.');
      }
      changes.push(`${label}: ${u[k] || '—'} → ${v.trim()}`); u[k] = v.trim();
    };
    const prevEmail = u.email;
    set('firstName', 'First name'); set('lastName', 'Last name'); set('email', 'Email');
    if (patch.attributes) {
      for (const [k, label] of [['department', 'Department'], ['jobTitle', 'Job title'], ['phone', 'Phone']] as const) {
        const v = patch.attributes[k];
        if (v !== undefined && v.trim() !== (u.attributes[k] ?? '')) { changes.push(`${label}: ${u.attributes[k] || '—'} → ${v.trim() || '—'}`); u.attributes[k] = v.trim(); }
      }
    }
    if (changes.length) {
      audit('user.update', 'user', u.id, u.username, `Updated ${u.username}`, { changes });
      notify('user.updated', [u], () => ({ changes }));
      if (prevEmail !== u.email) notify('user.updated', [{ ...u, email: prevEmail }], () => ({ changes: [`Email: ${prevEmail} → ${u.email}`] }));
    }
    if (patch.enabled !== undefined && patch.enabled !== u.enabled) {
      u.enabled = patch.enabled;
      if (!u.enabled) delete S.sessions[u.id];
      audit(u.enabled ? 'user.enable' : 'user.disable', 'user', u.id, u.username, `${u.enabled ? 'Enabled' : 'Disabled'} ${u.username}`);
      notify(u.enabled ? 'user.enabled' : 'user.disabled', [u]);
    }
    save();
    return clone(u);
  },

  async deleteUser(uid) {
    await wait(300);
    const actor = need('users:delete');
    const u = userById(uid);
    if (u.id === actor.id) throw new Error('You cannot delete your own account.');
    guardTarget(actor, u, 'edit');
    if (u.superAdmin && S.users.filter((x) => x.superAdmin).length === 1) throw new Error('You cannot delete the last super administrator.');
    notify('user.deleted', [u]);
    S.users = S.users.filter((x) => x.id !== uid);
    delete S.sessions[uid];
    audit('user.delete', 'user', uid, u.username, `Deleted user ${u.username}`, { email: u.email });
    save();
  },

  async resetPassword(uid, mode, temp) {
    await wait(300);
    const actor = need('users:reset-password');
    const u = userById(uid);
    guardTarget(actor, u, 'edit');
    if (mode === 'temporary') validatePassword(temp ?? '');
    if (!u.requiredActions.includes('UPDATE_PASSWORD')) u.requiredActions.push('UPDATE_PASSWORD');
    audit('user.password.reset', 'user', u.id, u.username, mode === 'link' ? `Sent a password setup link to ${u.username}` : `Set a temporary password for ${u.username}`, { mode });
    notify('user.password_reset', [u], () => ({ setup: mode }));
    save();
  },

  async sessions(uid) {
    await wait();
    if (uid !== meUser().id) need('users:sessions');
    return clone(S.sessions[uid] ?? []);
  },

  async revokeSessions(uid) {
    await wait(260);
    const actor = need('users:sessions');
    const u = userById(uid);
    guardTarget(actor, u, 'edit');
    const n = S.sessions[uid]?.length ?? 0;
    delete S.sessions[uid];
    audit('user.sessions.revoke', 'session', u.id, u.username, `Signed ${u.username} out of ${n} session${n === 1 ? '' : 's'}`, { sessions: n });
    notify('user.sessions_revoked', [u]);
    save();
  },

  async setSuperAdmin(uid, enabled) {
    await wait(260);
    const actor = needSuper();
    const u = userById(uid);
    if (u.superAdmin === enabled) return;
    if (!enabled && u.id === actor.id) throw new Error('You cannot remove your own super administrator rights.');
    if (!enabled && S.users.filter((x) => x.superAdmin).length === 1) throw new Error('At least one super administrator must remain.');
    u.superAdmin = enabled;
    audit(enabled ? 'superadmin.grant' : 'superadmin.revoke', 'user', u.id, u.username, `${enabled ? 'Granted' : 'Revoked'} super administrator for ${u.username}`);
    notify(enabled ? 'superadmin.granted' : 'superadmin.revoked', [u]);
    save();
  },

  async memberPermissions(uid) {
    await wait();
    if (uid !== meUser().id) need('permissions:view', 'users:view');
    const u = userById(uid);
    const eff = effective(u);
    return S.perms.map((p): MemberPermission => ({
      key: p.key, description: p.description, category: p.category,
      fromGroups: u.groups.map(groupById).filter((g): g is StoredGroup => !!g && g.permissions.includes(p.key)).map((g) => g.name),
      state: u.denies.includes(p.key) ? 'deny' : u.grants.includes(p.key) ? 'allow' : 'inherit',
      effective: eff.has(p.key),
    }));
  },

  async setMemberPermission(uid, key, state: PermState) {
    await wait(200);
    const actor = need('permissions:manage');
    const u = userById(uid);
    guardTarget(actor, u, 'access');
    if (!catalog().has(key)) throw new Error('Unknown permission.');
    if (state === 'allow') canGrant(actor, [key]);
    const before = effective(u);
    u.grants = u.grants.filter((k) => k !== key);
    u.denies = u.denies.filter((k) => k !== key);
    if (state === 'allow') u.grants.push(key);
    if (state === 'deny') u.denies.push(key);
    const d = permDiff(before, effective(u));
    const label = state === 'allow' ? 'Allowed' : state === 'deny' ? 'Denied' : 'Reset to inherited';
    audit('member.permission.set', 'user', u.id, u.username, `${label} ${key} for ${u.username}`, { key, state, ...d });
    if (d.added.length || d.removed.length) notify('member.permissions_changed', [u], () => d);
    save();
    return demoApi.memberPermissions(uid);
  },

  /* ----- groups ----- */
  async listGroups() {
    await wait();
    need('groups:view', 'users:view', 'permissions:view', 'mail:send');
    return S.groups.map(groupWithCount).sort((a, b) => a.name.localeCompare(b.name));
  },

  async createGroup(g) {
    await wait(280);
    const actor = need('groups:create');
    const name = g.name.trim();
    if (name.length < 2) throw new Error('Group name must be at least 2 characters.');
    if (S.groups.some((x) => lc(x.name) === lc(name))) throw new Error(`A group named “${name}” already exists.`);
    const permissions = (g.permissions ?? []).filter((p) => catalog().has(p));
    if (permissions.length) { need('permissions:manage'); canGrant(actor, permissions); }
    const ng: StoredGroup = { id: id('g_'), name, description: g.description.trim(), permissions, createdAt: now() };
    S.groups.push(ng);
    audit('group.create', 'group', ng.id, ng.name, `Created group ${ng.name}`, { permissions });
    save();
    return groupWithCount(ng);
  },

  async updateGroup(gid, patch) {
    await wait(240);
    need('groups:edit');
    const g = groupById(gid); if (!g) throw new Error('Group not found.');
    const members = S.users.filter((u) => u.groups.includes(gid));
    if (patch.name !== undefined && patch.name.trim() !== g.name) {
      const name = patch.name.trim();
      if (name.length < 2) throw new Error('Group name must be at least 2 characters.');
      if (S.groups.some((x) => x.id !== gid && lc(x.name) === lc(name))) throw new Error(`A group named “${name}” already exists.`);
      const old = g.name; g.name = name;
      audit('group.rename', 'group', g.id, g.name, `Renamed group ${old} → ${name}`, { from: old, to: name });
      notify('group.renamed', members, () => ({ group: old, newName: name }));
    }
    if (patch.description !== undefined && patch.description.trim() !== g.description) {
      g.description = patch.description.trim();
      audit('group.update', 'group', g.id, g.name, `Updated description of ${g.name}`);
    }
    save();
    return groupWithCount(g);
  },

  async deleteGroup(gid) {
    await wait(300);
    need('groups:delete');
    const g = groupById(gid); if (!g) throw new Error('Group not found.');
    const members = S.users.filter((u) => u.groups.includes(gid));
    const before = new Map(members.map((u) => [u.id, effective(u)]));
    members.forEach((u) => (u.groups = u.groups.filter((x) => x !== gid)));
    S.groups = S.groups.filter((x) => x.id !== gid);
    audit('group.delete', 'group', gid, g.name, `Deleted group ${g.name}`, { members: members.length });
    notify('group.deleted', members, (u) => ({ group: g.name, removed: permDiff(before.get(u.id)!, effective(u)).removed }));
    save();
  },

  async groupMembers(gid) {
    await wait();
    need('groups:view');
    return clone(S.users.filter((u) => u.groups.includes(gid)).sort((a, b) => fullName(a).localeCompare(fullName(b))));
  },

  async addMembers(gid, userIds) {
    await wait(260);
    const actor = need('groups:members');
    const g = groupById(gid); if (!g) throw new Error('Group not found.');
    canGrant(actor, g.permissions);
    const added: User[] = [];
    const before = new Map<string, Set<string>>();
    for (const uid of userIds) {
      const u = userById(uid);
      if (u.groups.includes(gid)) continue;
      guardTarget(actor, u, 'access');
      before.set(u.id, effective(u));
      u.groups.push(gid); added.push(u);
    }
    if (!added.length) return;
    audit('group.members.add', 'group', g.id, g.name, `Added ${added.map((u) => u.username).join(', ')} to ${g.name}`, { users: added.map((u) => u.username) });
    notify('group.member_added', added, (u) => ({ group: g.name, added: permDiff(before.get(u.id)!, effective(u)).added }));
    save();
  },

  async removeMember(gid, uid) {
    await wait(240);
    const actor = need('groups:members');
    const g = groupById(gid); if (!g) throw new Error('Group not found.');
    const u = userById(uid);
    guardTarget(actor, u, 'access');
    const before = effective(u);
    u.groups = u.groups.filter((x) => x !== gid);
    audit('group.members.remove', 'group', g.id, g.name, `Removed ${u.username} from ${g.name}`, { user: u.username });
    notify('group.member_removed', [u], () => ({ group: g.name, removed: permDiff(before, effective(u)).removed }));
    save();
  },

  async setGroupPermissions(gid, permissions) {
    await wait(220);
    const actor = need('permissions:manage');
    const g = groupById(gid); if (!g) throw new Error('Group not found.');
    if (!actor.superAdmin && actor.groups.includes(gid)) throw new Error('You cannot change the permissions of a group you belong to.');
    const next = new Set(permissions.filter((p) => catalog().has(p)));
    const d = permDiff(new Set(g.permissions), next);
    canGrant(actor, d.added);
    if (!d.added.length && !d.removed.length) return groupWithCount(g);
    g.permissions = [...next].sort();
    const members = S.users.filter((u) => u.groups.includes(gid));
    audit('group.permissions.set', 'group', g.id, g.name, `${g.name}: ${[...d.added.map((k) => `+${k}`), ...d.removed.map((k) => `−${k}`)].join(' ')}`, d);
    notify('group.permissions_changed', members, () => ({ group: g.name, ...d }));
    save();
    return groupWithCount(g);
  },

  /* ----- permission catalog ----- */
  async listPermissions() {
    await wait();
    need('permissions:view', 'groups:view', 'users:view');
    return clone(S.perms);
  },

  async createPermission(p) {
    await wait(240);
    needSuper();
    const key = lc(p.key.trim());
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(key)) throw new Error('Use the form resource:action, e.g. reports:export.');
    if (catalog().has(key)) throw new Error(`The permission “${key}” already exists.`);
    const np: Permission = { key, description: p.description.trim(), category: p.category.trim() || 'Custom', system: false };
    S.perms.push(np);
    audit('permission.create', 'permission', key, key, `Created permission ${key}`, { category: np.category });
    save();
    return clone(np);
  },

  async updatePermission(key, patch) {
    await wait(220);
    needSuper();
    const p = S.perms.find((x) => x.key === key); if (!p) throw new Error('Permission not found.');
    if (p.system) throw new Error('Built-in permissions cannot be edited.');
    p.description = patch.description.trim(); p.category = patch.category.trim() || 'Custom';
    audit('permission.update', 'permission', key, key, `Updated permission ${key}`);
    save();
    return clone(p);
  },

  async deletePermission(key) {
    await wait(260);
    needSuper();
    const p = S.perms.find((x) => x.key === key); if (!p) throw new Error('Permission not found.');
    if (p.system) throw new Error('Built-in permissions cannot be deleted.');
    const losers = S.users.filter((u) => effective(u).has(key) && !u.superAdmin);
    S.perms = S.perms.filter((x) => x.key !== key);
    S.groups.forEach((g) => (g.permissions = g.permissions.filter((k) => k !== key)));
    S.users.forEach((u) => { u.grants = u.grants.filter((k) => k !== key); u.denies = u.denies.filter((k) => k !== key); });
    audit('permission.delete', 'permission', key, key, `Deleted permission ${key}`, { affectedUsers: losers.length });
    notify('member.permissions_changed', losers, () => ({ removed: [key] }));
    save();
  },

  /* ----- mail ----- */
  async listMail(q: MailQuery = {}) {
    await wait();
    need('mail:view');
    const s = lc(q.search ?? '');
    const list = S.mail.filter((m) =>
      (!q.status || q.status === 'all' || m.status === q.status) &&
      (!s || [m.to, m.toName, m.subject, EVENTS[m.event]?.label ?? ''].some((v) => lc(v).includes(s))));
    return paginate(list, q.page, q.size ?? 12);
  },

  async getMail(mid) {
    await wait(80);
    need('mail:view');
    const m = S.mail.find((x) => x.id === mid); if (!m) throw new Error('Message not found.');
    return clone(m);
  },

  async resendMail(mid) {
    await wait(220);
    need('mail:manage');
    const m = S.mail.find((x) => x.id === mid); if (!m) throw new Error('Message not found.');
    m.status = 'queued'; m.error = null;
    audit('mail.resend', 'mail', m.id, m.to, `Re-queued “${m.subject}” to ${m.to}`);
    deliver(m.id);
    save();
    return clone(m);
  },

  async deleteMail(mid) {
    await wait(200);
    need('mail:manage');
    const m = S.mail.find((x) => x.id === mid); if (!m) throw new Error('Message not found.');
    S.mail = S.mail.filter((x) => x.id !== mid);
    audit('mail.delete', 'mail', mid, m.to, `Deleted “${m.subject}” to ${m.to}`);
    save();
  },

  async compose(input) {
    await wait(380);
    need('mail:send');
    if (!input.subject.trim()) throw new Error('Add a subject.');
    if (input.message.trim().length < 2) throw new Error('Write a message.');
    const ids = new Set(input.userIds);
    S.users.forEach((u) => { if (u.groups.some((g) => input.groupIds.includes(g))) ids.add(u.id); });
    const recipients = S.users.filter((u) => ids.has(u.id) && u.enabled);
    if (!recipients.length) throw new Error('Choose at least one active recipient.');
    const n = notify('mail.direct', recipients, () => ({ subject: input.subject.trim(), message: input.message.trim() }), true);
    audit('mail.compose', 'mail', '', `${n} recipient${n === 1 ? '' : 's'}`, `Sent “${input.subject.trim()}” to ${n} recipient${n === 1 ? '' : 's'}`, {
      users: input.userIds.length, groups: input.groupIds.map((g) => groupById(g)?.name),
    });
    save();
    return { queued: n };
  },

  async mailHealth() {
    await wait(160);
    need('mail:view');
    return { ok: true, host: 'mail:587 · Postfix + OpenDKIM', detail: 'Demo mode: delivery is simulated in the browser', dkim: true, queue: S.mail.filter((m) => m.status === 'queued').length };
  },

  /* ----- audit ----- */
  async listAudit(q: AuditQuery = {}) {
    await wait();
    need('audit:view');
    const s = lc(q.search ?? '');
    const list = S.audit.filter((a) =>
      (!q.targetType || q.targetType === 'all' || a.targetType === q.targetType) &&
      (!s || [a.actor, a.action, a.summary, a.targetName].some((v) => lc(v).includes(s))));
    return paginate(list, q.page, q.size ?? 15);
  },

  /* ----- settings ----- */
  async getSettings() { await wait(); need('settings:manage', 'mail:manage'); return clone(S.settings); },

  async saveSettings(next) {
    await wait(300);
    need('settings:manage');
    if (!EMAIL_RE.test(next.mailFrom)) throw new Error('Enter a valid sender address.');
    if (next.replyTo && !EMAIL_RE.test(next.replyTo)) throw new Error('Enter a valid reply-to address.');
    if (next.passwordMinLength < 8 || next.passwordMinLength > 64) throw new Error('Minimum password length must be between 8 and 64.');
    if (next.sessionIdleMinutes < 5 || next.sessionIdleMinutes > 1440) throw new Error('Session idle timeout must be between 5 and 1440 minutes.');
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(S.settings[k]));
    S.settings = clone(next);
    if (changed.length) audit('settings.update', 'settings', 'settings', 'System settings', `Updated ${changed.join(', ')}`, { changed });
    save();
    return clone(S.settings);
  },

  /* ----- employees ----- */
  async listEmployees(q = {}) {
    await wait();
    need('employees:view');
    const s = lc(q.search ?? '');
    const list = S.employees.filter((e) =>
      (!s || [empNameOf(e), e.email, e.code, e.department, e.jobTitle, e.nic].some((v) => lc(v).includes(s))) &&
      (!q.stage || q.stage === 'all' || e.stage === q.stage) && (!q.department || e.department === q.department))
      .sort((a, b) => empNameOf(a).localeCompare(empNameOf(b)));
    return { items: list.slice(((q.page ?? 1) - 1) * (q.size ?? 12), (q.page ?? 1) * (q.size ?? 12)).map(toEmployee), total: list.length };
  },

  async getEmployee(eid) {
    await wait();
    const e = empById(eid);
    if (e.userId !== meUser().id) need('employees:view');
    return toEmployee(e);
  },

  async createEmployee(input) {
    await wait(300);
    const actor = need('employees:manage');
    const e: StoredEmployee = {
      id: id('e_'), code: `TZ-${String(S.employees.length + 1).padStart(4, '0')}`, firstName: '', lastName: '', email: '', phone: '', nic: '',
      dateOfBirth: '', address: '', department: '', jobTitle: '', employmentType: 'permanent', startDate: '', stage: 'documents', userId: null,
      submittedBy: null, submittedById: null, lastDecision: null, payroll: { ...EMPTY_PAYROLL }, createdAt: now(), createdBy: fullName(actor), updatedAt: now(),
    };
    applyEmployee(e, input);
    S.employees.push(e);
    empEvent(e, 'employee.create', 'Onboarding started');
    audit('employee.create', 'employee', e.id, empNameOf(e), `Created employee ${empNameOf(e)} (${e.code})`, { email: e.email, jobTitle: e.jobTitle });
    notifyTo('employee.onboarding_started', [empR(e)], () => ({ role: e.jobTitle }));
    save();
    return toEmployee(e);
  },

  async updateEmployee(eid, patch) {
    await wait(260);
    need('employees:manage');
    const e = empById(eid);
    const changes = applyEmployee(e, patch);
    if (changes.length) {
      e.updatedAt = now();
      empEvent(e, 'employee.update', `Updated ${changes.map((c) => lc(c.split(':')[0])).join(', ')}`);
      audit('employee.update', 'employee', e.id, empNameOf(e), `Updated ${empNameOf(e)}`, { changes });
      if (e.stage !== 'offboarded') notifyTo('employee.updated', [empR(e)], () => ({ changes }));
      save();
    }
    return toEmployee(e);
  },

  async deleteEmployee(eid) {
    await wait(300);
    need('employees:delete');
    const e = empById(eid);
    S.employees = S.employees.filter((x) => x.id !== eid);
    S.docs = S.docs.filter((d) => d.employeeId !== eid);
    S.agreements = S.agreements.filter((a) => a.employeeId !== eid);
    S.empEvents = S.empEvents.filter((x) => x.employeeId !== eid);
    S.members = S.members.filter((m) => m.employeeId !== eid);
    S.projects.forEach((p) => { if (p.leadId === eid) p.leadId = null; });
    S.tickets.forEach((t) => { if (t.assigneeId === eid) t.assigneeId = null; });
    audit('employee.delete', 'employee', e.id, empNameOf(e), `Deleted employee ${empNameOf(e)} (${e.code}) and their documents`, { email: e.email });
    save();
  },

  async setPayroll(eid, p) {
    await wait(260);
    need('employees:payroll');
    const e = empById(eid);
    if (p.basicSalary < 0 || p.allowances < 0) throw new Error('Salary amounts must be between 0 and 1,000,000,000.');
    const next: Payroll = { ...p, currency: (p.currency || 'LKR').toUpperCase().slice(0, 3) };
    const old = e.payroll;
    const changed = [
      old.basicSalary !== next.basicSalary && 'Basic salary', old.allowances !== next.allowances && 'Allowances',
      old.epfNumber !== next.epfNumber && 'EPF number', old.etfNumber !== next.etfNumber && 'ETF number',
      (old.bankName !== next.bankName || old.bankAccount !== next.bankAccount) && 'Bank account',
    ].filter(Boolean) as string[];
    e.payroll = next; e.updatedAt = now();
    if (changed.length) {
      empEvent(e, 'employee.payroll', `Updated payroll: ${lc(changed.join(', '))}`);
      audit('employee.payroll', 'employee', e.id, empNameOf(e), `Updated payroll for ${empNameOf(e)}`, { fields: changed });
      if (e.stage !== 'offboarded') notifyTo('employee.payroll_changed', [empR(e)], () => ({ changes: changed.map((f) => `${f} updated`) }));
    }
    save();
    return toEmployee(e);
  },

  async employeeHistory(eid) {
    await wait();
    need('employees:view');
    empById(eid);
    return clone(S.empEvents.filter((x) => x.employeeId === eid).sort((a, b) => b.at.localeCompare(a.at)));
  },

  async listDocuments(eid) {
    await wait();
    need('employees:view');
    empById(eid);
    return S.docs.filter((d) => d.employeeId === eid && canSeeDoc(d.category)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(stripDoc);
  },

  async uploadDocument(eid, { category, title, file }) {
    await wait(400);
    const actor = need('employees:manage');
    const e = empById(eid);
    if (!DOCS[category]) throw new Error('Choose a document type.');
    if (DOCS[category].payroll) need('employees:payroll');
    if (file.size <= 0 || file.size > 10 << 20) throw new Error('Files can be up to 10 MB.');
    const ext = lc(file.name.split('.').pop() ?? '');
    const types: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (!types[ext]) throw new Error('Upload a PDF, an image (PNG, JPEG or WebP) or a Word / Excel document.');
    const data = file.size <= 400 << 10 ? await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); }) : null;
    const d: StoredDoc = { id: id('d_'), employeeId: e.id, category, title: title.trim() || DOCS[category].label, filename: file.name.slice(0, 120),
      contentType: types[ext], size: file.size, uploadedBy: fullName(actor), uploadedAt: now(), data };
    S.docs.push(d);
    empEvent(e, 'document.upload', `Uploaded ${d.title}`);
    audit('document.upload', 'employee', e.id, empNameOf(e), `Uploaded ${d.title} for ${empNameOf(e)}`, { category, filename: d.filename, size: d.size });
    if (e.stage !== 'offboarded') notifyTo('employee.document_added', [empR(e)], () => ({ item: d.title }));
    save();
    return stripDoc(d);
  },

  async downloadDocument(eid, did) {
    await wait(120);
    need('employees:view');
    const d = S.docs.find((x) => x.employeeId === eid && x.id === did);
    if (!d) throw new Error('Document not found.');
    if (!canSeeDoc(d.category)) throw new Error('You need the “employees:payroll” permission to open payroll documents.');
    if (!d.data) return new Blob([`Demo mode keeps only small files in the browser.\n\n${d.title} (${d.filename}) is a sample document.\n`], { type: 'text/plain' });
    const [head, b64] = d.data.split(',');
    const bin = atob(b64);
    return new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: head.slice(5).split(';')[0] });
  },

  async deleteDocument(eid, did) {
    await wait(200);
    need('employees:manage');
    const e = empById(eid);
    const d = S.docs.find((x) => x.employeeId === eid && x.id === did);
    if (!d) throw new Error('Document not found.');
    if (DOCS[d.category].payroll) need('employees:payroll');
    S.docs = S.docs.filter((x) => x.id !== did);
    empEvent(e, 'document.delete', `Removed ${d.title}`);
    audit('document.delete', 'employee', e.id, empNameOf(e), `Removed ${d.title} from ${empNameOf(e)}`, { filename: d.filename });
    save();
  },

  async submitForApproval(eid) {
    await wait(300);
    const actor = need('employees:manage');
    const e = empById(eid);
    if (e.stage !== 'documents') throw new Error('Only employees in the documents stage can be submitted for approval.');
    const missing = missingDocs(e);
    if (missing.length) throw new Error(`Upload the required documents first: ${missing.map((m) => DOCS[m].label).join(', ')}.`);
    e.stage = 'approval'; e.submittedBy = fullName(actor); e.submittedById = actor.id; e.updatedAt = now();
    empEvent(e, 'employee.submit', 'Submitted for approval');
    audit('employee.submit', 'employee', e.id, empNameOf(e), `Submitted ${empNameOf(e)} for onboarding approval`);
    const approvers = S.users.filter((u) => u.enabled && has(u, 'employees:approve')).map(userR);
    notifyTo('employee.approval_requested', others(approvers), () => ({ person: empNameOf(e), role: e.jobTitle, link: `${location.origin}/employees/?id=${e.id}` }));
    save();
    return toEmployee(e);
  },

  async decideApproval(eid, decision, note) {
    await wait(300);
    const actor = need('employees:approve');
    const e = empById(eid);
    note = note.trim();
    if (decision === 'reject' && !note) throw new Error('Tell HR what needs to change.');
    if (e.stage !== 'approval') throw new Error('This employee is not waiting for approval.');
    if (!actor.superAdmin && e.submittedById === actor.id) throw new Error('Someone other than the person who submitted it must approve an onboarding.');
    const approved = decision === 'approve';
    e.stage = approved ? 'agreement' : 'documents';
    e.lastDecision = { decision: approved ? 'approved' : 'rejected', by: fullName(actor), at: now(), note };
    e.updatedAt = now();
    const label = approved ? 'Approved' : 'Sent back for changes';
    empEvent(e, `employee.${e.lastDecision.decision}`, label, note);
    audit(`employee.${e.lastDecision.decision}`, 'employee', e.id, empNameOf(e), `${label}: ${empNameOf(e)}`, { note });
    const sub = S.users.find((u) => u.id === e.submittedById);
    if (sub) notifyTo(approved ? 'employee.approved' : 'employee.rejected', others([userR(sub)]), () => ({ person: empNameOf(e), note, link: `${location.origin}/employees/?id=${e.id}` }));
    save();
    return toEmployee(e);
  },

  async offboardEmployee(eid, note) {
    await wait(300);
    need('employees:manage');
    const e = empById(eid);
    if (e.stage === 'offboarded') throw new Error('This employee is already offboarded.');
    e.stage = 'offboarded'; e.updatedAt = now();
    empEvent(e, 'employee.offboard', 'Offboarded', note.trim());
    audit('employee.offboard', 'employee', e.id, empNameOf(e), `Offboarded ${empNameOf(e)}`, { note });
    notifyTo('employee.offboarded', [empR(e)]);
    save();
    return toEmployee(e);
  },

  /* ----- agreements ----- */
  async listAgreements(eid) {
    await wait();
    need('employees:view');
    return S.agreements.filter((a) => a.employeeId === eid).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(stripAgreement);
  },

  async createAgreement(eid, a) {
    await wait(260);
    const actor = need('employees:manage');
    const e = empById(eid);
    if (e.stage === 'offboarded') throw new Error('This employee is offboarded.');
    checkAgreement(a);
    const x: StoredAgreement = { id: id('ag_'), employeeId: eid, title: a.title.trim(), body: a.body.trim(), status: 'draft', createdAt: now(), createdBy: fullName(actor),
      sentAt: null, viewedAt: null, signedAt: null, expiresAt: null, signerName: '', signerIp: '', signature: null, token: null, sentById: null };
    S.agreements.push(x);
    empEvent(e, 'agreement.create', `Drafted “${x.title}”`);
    audit('agreement.create', 'employee', e.id, empNameOf(e), `Drafted agreement “${x.title}” for ${empNameOf(e)}`);
    save();
    return stripAgreement(x);
  },

  async updateAgreement(eid, aid, a) {
    await wait(220);
    need('employees:manage');
    const x = agreementOf(eid, aid);
    if (x.status !== 'draft') throw new Error('Only drafts can be edited. Void this agreement and draft a new one instead.');
    checkAgreement(a);
    x.title = a.title.trim(); x.body = a.body.trim();
    save();
    return stripAgreement(x);
  },

  async sendAgreement(eid, aid) {
    await wait(360);
    const actor = need('employees:manage');
    const e = empById(eid);
    const x = agreementOf(eid, aid);
    if (e.stage !== 'agreement' && e.stage !== 'active') throw new Error('Agreements can be sent once the onboarding is approved.');
    if (!['draft', 'sent', 'viewed'].includes(x.status)) throw new Error(`This agreement is ${x.status} and can no longer be sent.`);
    const resend = x.status !== 'draft';
    x.token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
    x.status = x.status === 'viewed' ? 'viewed' : 'sent'; x.sentAt = now(); x.sentById = actor.id;
    x.expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const link = `${location.origin}/sign/?t=${x.token}`;
    empEvent(e, 'agreement.send', `${resend ? 'Re-sent (previous link revoked)' : 'Sent'} “${x.title}” for signature`);
    audit('agreement.send', 'employee', e.id, empNameOf(e), `${resend ? 'Re-sent' : 'Sent'} agreement “${x.title}” to ${e.email}`, { expires: x.expiresAt });
    notifyTo('agreement.sent', [empR(e)], () => ({ item: x.title, link, expires: new Date(x.expiresAt!).toLocaleDateString('en-GB', { dateStyle: 'medium' }) }), true);
    save();
    return { ...stripAgreement(x), link };
  },

  async voidAgreement(eid, aid) {
    await wait(220);
    need('employees:manage');
    const e = empById(eid);
    const x = agreementOf(eid, aid);
    if (x.status === 'signed' || x.status === 'void') throw new Error(`This agreement is already ${x.status}.`);
    x.status = 'void'; x.token = null;
    empEvent(e, 'agreement.void', `Voided “${x.title}” (signing link revoked)`);
    audit('agreement.void', 'employee', e.id, empNameOf(e), `Voided agreement “${x.title}”`);
    save();
    return stripAgreement(x);
  },

  /* ----- projects ----- */
  async listProjects(q = {}) {
    await wait();
    let memberOf = '';
    if (q.mine || !has(meUser(), 'projects:view')) {
      if (!q.mine) throw new Error('You need the “projects:view” permission to do that.');
      memberOf = myEmp()?.id ?? '';
      if (!memberOf) return [];
    }
    const s = lc(q.search ?? '');
    const rank = (p: StoredProject) => ({ active: 0, planning: 1, on_hold: 2 } as Record<string, number>)[p.status] ?? 3;
    return S.projects.filter((p) =>
      (!s || [p.name, p.key, p.client, p.description].some((v) => lc(v).includes(s))) &&
      (!q.status || q.status === 'all' || p.status === q.status) &&
      (!memberOf || onProject(p, memberOf)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map(toProject);
  },

  async getProject(pid) { await wait(); return toProject(projectFor(pid)); },

  async createProject(input) {
    await wait(300);
    need('projects:manage');
    const key = input.key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new Error('The key must be 2–10 letters or digits starting with a letter, e.g. TEMS. It prefixes ticket numbers.');
    if (S.projects.some((p) => p.key === key)) throw new Error(`Another project already uses the key ${key}.`);
    const p: StoredProject = { id: id('p_'), key, name: '', description: '', client: '', status: 'planning', health: 'on_track', startDate: '', dueDate: '', leadId: null, createdAt: now(), updatedAt: now(), seq: 0 };
    applyProject(p, input);
    S.projects.push(p);
    S.updates.push({ id: id('pu_'), projectId: p.id, at: now(), author: fullName(meUser()), status: 'planning', health: 'on_track', progress: 0, note: 'Project created.' });
    const lead = p.leadId ? S.employees.find((e) => e.id === p.leadId) : null;
    if (lead) notifyTo('project.assigned', others([empR(lead)]), () => ({ project: p.name, role: 'Project lead', link: `${location.origin}/work/` }));
    audit('project.create', 'project', p.id, p.name, `Created project ${p.key} · ${p.name}`);
    save();
    return toProject(p);
  },

  async updateProject(pid, patch) {
    await wait(260);
    need('projects:manage');
    const p = projectFor(pid);
    const oldLead = p.leadId;
    applyProject(p, patch);
    p.updatedAt = now();
    const lead = p.leadId && p.leadId !== oldLead ? S.employees.find((e) => e.id === p.leadId) : null;
    if (lead) notifyTo('project.assigned', others([empR(lead)]), () => ({ project: p.name, role: 'Project lead', link: `${location.origin}/work/` }));
    audit('project.update', 'project', p.id, p.name, `Updated project ${p.name}`);
    save();
    return toProject(p);
  },

  async deleteProject(pid) {
    await wait(300);
    need('projects:manage');
    const p = projectFor(pid);
    const n = S.tickets.filter((t) => t.projectId === pid).length;
    const tids = new Set(S.tickets.filter((t) => t.projectId === pid).map((t) => t.id));
    S.projects = S.projects.filter((x) => x.id !== pid);
    S.members = S.members.filter((m) => m.projectId !== pid);
    S.updates = S.updates.filter((u) => u.projectId !== pid);
    S.tickets = S.tickets.filter((t) => t.projectId !== pid);
    S.comments = S.comments.filter((cm) => !tids.has(cm.ticketId));
    audit('project.delete', 'project', p.id, p.name, `Deleted project ${p.name} and its ${n} ticket${n === 1 ? '' : 's'}`);
    save();
  },

  async projectUpdates(pid) {
    await wait();
    projectFor(pid);
    return clone(S.updates.filter((u) => u.projectId === pid).sort((a, b) => b.at.localeCompare(a.at)));
  },

  async postProjectUpdate(pid, u) {
    await wait(300);
    const p = projectFor(pid);
    if (!has(meUser(), 'projects:manage') && p.leadId !== myEmp()?.id) throw new Error('Only project managers and the project lead can post status updates.');
    const note = u.note.trim();
    if (!note && u.status === p.status && u.health === p.health) throw new Error('Change the status or health, or write a note.');
    p.status = u.status; p.health = u.health; p.updatedAt = now();
    const pct = toProject(p).progress;
    S.updates.push({ id: id('pu_'), projectId: p.id, at: now(), author: fullName(meUser()), status: u.status, health: u.health, progress: pct, note });
    audit('project.status', 'project', p.id, p.name, `${p.name}: ${PROJECT_STATUS[u.status]} · ${HEALTH[u.health]}`, { status: u.status, health: u.health, progress: pct });
    notifyTo('project.status_changed', others(team(p)), () => ({ project: p.name, note, link: `${location.origin}/work/`,
      changes: [`Status: ${PROJECT_STATUS[u.status]}`, `Health: ${HEALTH[u.health]}`, `Progress: ${pct}%`] }));
    save();
    return toProject(p);
  },

  async addProjectMember(pid, m) {
    await wait(260);
    need('projects:manage');
    const p = projectFor(pid);
    const e = S.employees.find((x) => x.id === m.employeeId && x.stage !== 'offboarded');
    if (!e) throw new Error('Choose a current employee.');
    if (S.members.some((x) => x.projectId === pid && x.employeeId === e.id)) throw new Error(`${empNameOf(e)} is already on this project.`);
    if (m.allocation < 0 || m.allocation > 100) throw new Error('Allocation must be between 0 and 100%.');
    S.members.push({ projectId: pid, employeeId: e.id, role: m.role.trim(), allocation: m.allocation, assignedAt: now() });
    audit('project.member.add', 'project', p.id, p.name, `Assigned ${empNameOf(e)} to ${p.name}`, { role: m.role, allocation: m.allocation });
    notifyTo('project.assigned', others([empR(e)]), () => ({ project: p.name, role: m.role.trim(), link: `${location.origin}/work/` }));
    save();
    return toProject(p);
  },

  async updateProjectMember(pid, eid, m) {
    await wait(200);
    need('projects:manage');
    const p = projectFor(pid);
    const x = S.members.find((y) => y.projectId === pid && y.employeeId === eid);
    if (!x) throw new Error('That person is not on this project.');
    if (m.allocation < 0 || m.allocation > 100) throw new Error('Allocation must be between 0 and 100%.');
    x.role = m.role.trim(); x.allocation = m.allocation;
    save();
    return toProject(p);
  },

  async removeProjectMember(pid, eid) {
    await wait(220);
    need('projects:manage');
    const p = projectFor(pid);
    const e = empById(eid);
    if (!S.members.some((x) => x.projectId === pid && x.employeeId === eid)) throw new Error('That person is not on this project.');
    S.members = S.members.filter((x) => !(x.projectId === pid && x.employeeId === eid));
    audit('project.member.remove', 'project', p.id, p.name, `Removed ${empNameOf(e)} from ${p.name}`);
    notifyTo('project.unassigned', others([empR(e)]), () => ({ project: p.name }));
    save();
    return toProject(p);
  },

  /* ----- tickets ----- */
  async listTickets(q = {}) {
    await wait();
    let assignee = q.assigneeId ?? '';
    if (q.mine) {
      assignee = myEmp()?.id ?? '';
      if (!assignee) return { items: [], total: 0 };
    } else if (!has(meUser(), 'tickets:view')) {
      if (!q.projectId) throw new Error('You need the “tickets:view” permission to do that.');
      projectFor(q.projectId);
    }
    const s = lc(q.search ?? '');
    const rank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const list = S.tickets.map(toTicket).filter((t) =>
      (!s || [t.title, t.description, t.ref].some((v) => lc(v).includes(s))) && (!q.projectId || t.projectId === q.projectId) &&
      (!assignee || t.assigneeId === assignee) && (!q.priority || q.priority === 'all' || t.priority === q.priority) &&
      (!q.status || q.status === 'all' || (q.status === 'active' ? ['open', 'in_progress', 'in_review'].includes(t.status) : t.status === q.status)))
      .sort((a, b) => rank[a.priority] - rank[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
    return paginate(list, q.page, q.size ?? 25);
  },

  async getTicket(tid) { await wait(); return toTicket(ticketFor(tid).t); },

  async createTicket(input) {
    await wait(300);
    const p = projectFor(input.projectId);
    const me = meUser();
    if (!has(me, 'tickets:create') && !has(me, 'tickets:manage') && !onProject(p, myEmp()?.id ?? '')) throw new Error('You need the “tickets:create” permission to do that.');
    if (p.status === 'completed' || p.status === 'cancelled') throw new Error(`This project is ${PROJECT_STATUS[p.status]}. Reopen it to raise tickets.`);
    if (!input.title.trim()) throw new Error('Give the ticket a title.');
    if (input.assigneeId && !has(me, 'tickets:manage') && !has(me, 'projects:manage')) throw new Error('You need the “tickets:manage” permission to assign tickets.');
    if (input.assigneeId && !onProject(p, input.assigneeId)) throw new Error('Tickets can only be assigned to people on the project. Add them to the team first.');
    p.seq++;
    const t: StoredTicket = { id: id('t_'), projectId: p.id, number: p.seq, title: input.title.trim(), description: input.description.trim(),
      type: TICKET_TYPE[input.type] ? input.type : 'task', priority: PRIORITY[input.priority] ? input.priority : 'medium', status: 'open',
      assigneeId: input.assigneeId || null, reporterId: me.id, reporter: fullName(me), dueDate: input.dueDate, createdAt: now(), updatedAt: now() };
    S.tickets.push(t);
    const view = toTicket(t);
    audit('ticket.create', 'ticket', t.id, view.ref, `Raised ${view.ref} · ${t.title}`, { project: p.name, priority: t.priority });
    if (t.assigneeId) notifyAssigned(view, p, empById(t.assigneeId));
    save();
    return view;
  },

  async updateTicket(tid, patch) {
    await wait(260);
    const { t, p, acc } = ticketFor(tid);
    if (!acc.manage) {
      const wording = patch.title !== undefined || patch.description !== undefined || patch.type !== undefined;
      const planning = patch.priority !== undefined || patch.dueDate !== undefined || patch.assigneeId !== undefined;
      if (planning || (wording && !acc.reporter) || (patch.status !== undefined && !acc.assignee && !acc.reporter)) throw new Error('You need the “tickets:manage” permission to do that.');
    }
    const before = { ...t };
    const changes: string[] = [];
    if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== t.title) { t.title = patch.title.trim(); changes.push('Title changed'); }
    if (patch.description !== undefined && patch.description.trim() !== t.description) { t.description = patch.description.trim(); changes.push('Description updated'); }
    if (patch.type && patch.type !== t.type) { changes.push(`Type: ${TICKET_TYPE[t.type]} → ${TICKET_TYPE[patch.type]}`); t.type = patch.type; }
    if (patch.priority && patch.priority !== t.priority) { changes.push(`Priority: ${PRIORITY[t.priority]} → ${PRIORITY[patch.priority]}`); t.priority = patch.priority; }
    if (patch.status && patch.status !== t.status) { changes.push(`Status: ${TICKET_STATUS[t.status]} → ${TICKET_STATUS[patch.status]}`); t.status = patch.status; }
    if (patch.dueDate !== undefined && patch.dueDate !== t.dueDate) { changes.push(`Due: ${t.dueDate || '—'} → ${patch.dueDate || '—'}`); t.dueDate = patch.dueDate; }
    let newAssignee: StoredEmployee | null = null;
    if (patch.assigneeId !== undefined && (patch.assigneeId || null) !== t.assigneeId) {
      if (patch.assigneeId && !onProject(p, patch.assigneeId)) throw new Error('Tickets can only be assigned to people on the project. Add them to the team first.');
      t.assigneeId = patch.assigneeId || null;
      newAssignee = t.assigneeId ? empById(t.assigneeId) : null;
      changes.push(newAssignee ? `Assigned to ${empNameOf(newAssignee)}` : 'Unassigned');
    }
    if (!changes.length) return toTicket(t);
    t.updatedAt = now();
    changes.forEach((ch) => S.comments.push({ id: id('c_'), ticketId: t.id, at: now(), author: fullName(meUser()), authorId: meUser().id, body: ch, system: true }));
    const view = toTicket(t);
    audit('ticket.update', 'ticket', t.id, view.ref, `Updated ${view.ref}: ${changes[0]}`, { changes });
    if (newAssignee) notifyAssigned(view, p, newAssignee);
    const rest = watchers(before).filter((r) => !newAssignee || r.email !== newAssignee.email);
    notifyTo('ticket.updated', rest, () => ({ item: `${view.ref} · ${t.title}`, project: p.name, changes, link: `${location.origin}/tickets/?id=${t.id}` }));
    save();
    return view;
  },

  async deleteTicket(tid) {
    await wait(220);
    need('tickets:manage');
    const { t } = ticketFor(tid);
    const ref = toTicket(t).ref;
    S.tickets = S.tickets.filter((x) => x.id !== tid);
    S.comments = S.comments.filter((cm) => cm.ticketId !== tid);
    audit('ticket.delete', 'ticket', tid, ref, `Deleted ${ref} · ${t.title}`);
    save();
  },

  async ticketComments(tid) {
    await wait();
    ticketFor(tid);
    return clone(S.comments.filter((cm) => cm.ticketId === tid).sort((a, b) => a.at.localeCompare(b.at)));
  },

  async addTicketComment(tid, body) {
    await wait(220);
    const { t, p } = ticketFor(tid);
    body = body.trim();
    if (!body) throw new Error('Write a comment.');
    const me = meUser();
    const cm: TicketComment = { id: id('c_'), ticketId: tid, at: now(), author: fullName(me), authorId: me.id, body, system: false };
    S.comments.push(cm);
    t.updatedAt = now();
    const view = toTicket(t);
    notifyTo('ticket.commented', watchers(t), () => ({ item: `${view.ref} · ${t.title}`, project: p.name, note: body, link: `${location.origin}/tickets/?id=${t.id}` }));
    save();
    return clone(cm);
  },
};

/** For the demo "view as" switcher. */
export function demoUsers(): Array<{ id: string; name: string; label: string }> {
  return S.users.filter((u) => u.enabled).map((u) => ({
    id: u.id, name: fullName(u),
    label: u.superAdmin ? 'Super admin' : u.groups.map((g) => groupById(g)?.name).filter(Boolean).join(', ') || 'No groups',
  }));
}

/* ---------- people, projects, tickets: helpers ---------- */
const EMPTY_PAYROLL: Payroll = { basicSalary: 0, allowances: 0, currency: 'LKR', epfNumber: '', etfNumber: '', bankName: '', bankAccount: '' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => !d || (DATE_RE.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d));
const empNameOf = (e: Pick<Employee, 'firstName' | 'lastName'>) => [e.firstName, e.lastName].filter(Boolean).join(' ');
function empById(eid: string) { const e = S.employees.find((x) => x.id === eid); if (!e) throw new Error('Employee not found.'); return e; }
function myEmp() { const me = meUser(); return S.employees.find((e) => e.userId === me.id) ?? null; }
const canSeeDoc = (c: DocCategory) => !DOCS[c]?.payroll || has(meUser(), 'employees:payroll');
const missingDocs = (e: StoredEmployee) => S.settings.requiredDocuments.filter((c) => !S.docs.some((d) => d.employeeId === e.id && d.category === c));
const empR = (e: StoredEmployee): Rcpt => ({ email: e.email, name: empNameOf(e), first: e.firstName, userId: e.userId });
function others(rs: Rcpt[]) { const me = meUser(); return rs.filter((r) => r.userId !== me.id && lc(r.email) !== lc(me.email)); }

function toEmployee(e: StoredEmployee): Employee {
  const { submittedById: _s, payroll, ...rest } = clone(e);
  return { ...rest, documentCount: S.docs.filter((d) => d.employeeId === e.id).length, missingDocuments: missingDocs(e),
    payroll: has(meUser(), 'employees:payroll') ? payroll : null };
}
const stripDoc = ({ data: _d, ...d }: StoredDoc): EmployeeDocument => clone(d);
const stripAgreement = ({ token: _t, sentById: _s, ...a }: StoredAgreement): Agreement => clone(a);

function empEvent(e: StoredEmployee, action: string, summary: string, note = '', actor = fullName(meUser())) {
  S.empEvents.push({ id: id('ev_'), employeeId: e.id, at: now(), actor, action, summary, note });
}

function applyEmployee(e: StoredEmployee, input: Partial<EmployeeInput>): string[] {
  const changes: string[] = [];
  const labels: Array<[keyof EmployeeInput, string]> = [['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['nic', 'NIC'],
    ['dateOfBirth', 'Date of birth'], ['address', 'Address'], ['department', 'Department'], ['jobTitle', 'Job title'], ['employmentType', 'Employment type'], ['startDate', 'Start date']];
  const next = { ...e };
  for (const [k, label] of labels) {
    const v = input[k];
    if (typeof v !== 'string') continue;
    const nv = v.trim();
    if (nv !== (e as unknown as Record<string, string>)[k]) { changes.push(`${label}: ${(e as unknown as Record<string, string>)[k] || '—'} → ${nv || '—'}`); (next as unknown as Record<string, string>)[k] = nv; }
  }
  if (!next.firstName) throw new Error('First name is required.');
  if (!EMAIL_RE.test(next.email)) throw new Error('Enter a valid email address.');
  if (!EMPLOYMENT[next.employmentType]) throw new Error('Employment type must be permanent, contract, probation or intern.');
  if (!validDate(next.dateOfBirth) || !validDate(next.startDate)) throw new Error('Dates must be in the form YYYY-MM-DD.');
  if (S.employees.some((x) => x.id !== e.id && lc(x.email) === lc(next.email))) throw new Error('Another employee already uses that email address.');
  if (input.userId !== undefined && (input.userId || null) !== e.userId) {
    if (input.userId && !S.users.some((u) => u.id === input.userId)) throw new Error('The selected sign-in account does not exist.');
    if (input.userId && S.employees.some((x) => x.id !== e.id && x.userId === input.userId)) throw new Error('That sign-in account is already linked to another employee.');
    next.userId = input.userId || null;
    changes.push('Linked sign-in account changed');
  }
  Object.assign(e, next);
  return changes;
}

function checkAgreement(a: { title: string; body: string }) {
  if (!a.title.trim()) throw new Error('Give the agreement a title.');
  if (a.body.trim().length < 20) throw new Error('The agreement text must be between 20 and 100,000 characters.');
}
function agreementOf(eid: string, aid: string) {
  empById(eid);
  const a = S.agreements.find((x) => x.employeeId === eid && x.id === aid);
  if (!a) throw new Error('Agreement not found.');
  return a;
}

const onProject = (p: StoredProject, eid: string) => !!eid && (p.leadId === eid || S.members.some((m) => m.projectId === p.id && m.employeeId === eid));
function projectFor(pid: string) {
  const p = S.projects.find((x) => x.id === pid);
  if (!p) throw new Error('Project not found.');
  if (!has(meUser(), 'projects:view') && !onProject(p, myEmp()?.id ?? '')) throw new Error('You need the “projects:view” permission to do that.');
  return p;
}
function toProject(p: StoredProject): Project {
  const { seq: _s, ...rest } = clone(p);
  const counts = Object.fromEntries(TICKET_ORDER.map((st) => [st, S.tickets.filter((t) => t.projectId === p.id && t.status === st).length])) as Project['ticketCounts'];
  const total = TICKET_ORDER.reduce((n, st) => n + counts[st], 0);
  const lead = S.employees.find((e) => e.id === p.leadId);
  return {
    ...rest, leadName: lead ? empNameOf(lead) : '',
    members: S.members.filter((m) => m.projectId === p.id).map((m) => {
      const e = S.employees.find((x) => x.id === m.employeeId)!;
      return { employeeId: m.employeeId, name: empNameOf(e), email: e.email, jobTitle: e.jobTitle, role: m.role, allocation: m.allocation, assignedAt: m.assignedAt };
    }),
    ticketCounts: counts,
    progress: p.status === 'completed' ? 100 : total ? Math.round(((counts.resolved + counts.closed) * 100) / total) : 0,
    overdue: !!p.dueDate && p.dueDate < new Date().toISOString().slice(0, 10) && p.status !== 'completed' && p.status !== 'cancelled',
  };
}
function applyProject(p: StoredProject, input: Partial<Omit<Project, 'id'>> & { leadId?: string | null }) {
  for (const k of ['name', 'description', 'client', 'startDate', 'dueDate'] as const) if (typeof input[k] === 'string') p[k] = (input[k] as string).trim();
  if (input.leadId !== undefined) {
    if (input.leadId && !S.employees.some((e) => e.id === input.leadId && e.stage !== 'offboarded')) throw new Error('Choose a current employee as the project lead.');
    p.leadId = input.leadId || null;
  }
  if (!p.name) throw new Error('Give the project a name.');
  if (!validDate(p.startDate) || !validDate(p.dueDate)) throw new Error('Dates must be in the form YYYY-MM-DD.');
  if (p.startDate && p.dueDate && p.dueDate < p.startDate) throw new Error('The due date must be after the start date.');
}
function team(p: StoredProject): Rcpt[] {
  const ids = new Set(S.members.filter((m) => m.projectId === p.id).map((m) => m.employeeId));
  if (p.leadId) ids.add(p.leadId);
  return S.employees.filter((e) => ids.has(e.id)).map(empR);
}

function toTicket(t: StoredTicket): Ticket {
  const { number, ...rest } = clone(t);
  const p = S.projects.find((x) => x.id === t.projectId)!;
  const a = S.employees.find((e) => e.id === t.assigneeId);
  return { ...rest, projectKey: p.key, ref: `${p.key}-${number}`, assigneeName: a ? empNameOf(a) : '',
    commentCount: S.comments.filter((cm) => cm.ticketId === t.id && !cm.system).length };
}
function ticketFor(tid: string) {
  const t = S.tickets.find((x) => x.id === tid);
  if (!t) throw new Error('Ticket not found.');
  const p = S.projects.find((x) => x.id === t.projectId)!;
  const me = meUser(), mine = myEmp()?.id ?? '';
  const acc = { manage: has(me, 'tickets:manage'), assignee: !!mine && t.assigneeId === mine, reporter: t.reporterId === me.id };
  if (!acc.manage && !acc.assignee && !acc.reporter && !has(me, 'tickets:view') && !onProject(p, mine)) throw new Error('You need the “tickets:view” permission to do that.');
  return { t, p, acc };
}
function notifyAssigned(t: Ticket, p: StoredProject, e: StoredEmployee) {
  notifyTo('ticket.assigned', others([empR(e)]), () => ({
    item: `${t.ref} · ${t.title}`, project: p.name, link: `${location.origin}/tickets/?id=${t.id}`,
    changes: [`Priority: ${PRIORITY[t.priority]}`, `Type: ${TICKET_TYPE[t.type]}`, ...(t.dueDate ? [`Due: ${t.dueDate}`] : [])],
  }));
}
function watchers(t: Pick<StoredTicket, 'assigneeId' | 'reporterId'>): Rcpt[] {
  const rs: Rcpt[] = [];
  const a = S.employees.find((e) => e.id === t.assigneeId); if (a) rs.push(empR(a));
  const r = S.users.find((u) => u.id === t.reporterId); if (r) rs.push(userR(r));
  return others(rs);
}

/* ---------- public signing (demo) ---------- */
function byToken(token: string) {
  const a = token ? S.agreements.find((x) => x.token === token && x.status !== 'void') : undefined;
  if (!a) throw new Error('This signing link is not valid. Ask HR to send you a new one.');
  if (a.expiresAt && new Date(a.expiresAt) < new Date()) throw new Error('This signing link has expired. Ask HR to send you a new one.');
  return { a, e: empById(a.employeeId) };
}
const toPublic = (a: StoredAgreement, e: StoredEmployee): PublicAgreement => ({
  title: a.title, body: a.body, orgName: S.settings.orgName, employeeName: empNameOf(e), status: a.status,
  expiresAt: a.expiresAt, signedAt: a.signedAt, signerName: a.signerName, signature: a.signature,
});

export const demoPublicApi: PublicApi = {
  async getAgreement(token) {
    await wait(200);
    const { a, e } = byToken(token);
    if (a.status === 'sent') { a.status = 'viewed'; a.viewedAt = now(); empEvent(e, 'agreement.view', `Opened “${a.title}”`, '', empNameOf(e)); save(); }
    return toPublic(a, e);
  },
  async signAgreement(token, { name, signature }) {
    await wait(500);
    const { a, e } = byToken(token);
    if (a.status === 'signed') throw new Error('This agreement is already signed.');
    name = name.trim();
    if (name.length < 3) throw new Error('Type your full name.');
    if (!signature.startsWith('data:image/png;base64,') || signature.length < 200) throw new Error('Draw your signature in the box.');
    Object.assign(a, { status: 'signed', signedAt: now(), signerName: name, signerIp: '10.0.4.27', signature });
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const copy = `<!doctype html><meta charset="utf-8"><title>${esc(a.title)}</title><body style="font:15px/1.65 Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px">
<div style="font:600 12px Arial;letter-spacing:.12em;color:#6229c9">${esc(S.settings.orgName.toUpperCase())}</div><h1 style="font:700 26px Arial">${esc(a.title)}</h1>
${a.body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
<div style="margin-top:36px;border-top:2px solid #000;padding-top:16px"><img src="${signature}" style="max-width:320px"><div><b>${esc(name)}</b></div><div style="font:13px Arial;color:#555">Signed electronically on ${esc(new Date().toUTCString())} · IP ${a.signerIp}</div></div></body>`;
    S.docs.push({ id: id('d_'), employeeId: e.id, category: 'agreement', title: `Signed: ${a.title}`, filename: `Signed - ${a.title}.html`.slice(0, 120),
      contentType: 'text/html; charset=utf-8', size: copy.length, uploadedBy: name, uploadedAt: now(),
      data: `data:text/html;base64,${btoa(Array.from(new TextEncoder().encode(copy), (b) => String.fromCharCode(b)).join(''))}` });
    empEvent(e, 'agreement.sign', `Signed “${a.title}” as ${name}`, '', name);
    S.audit.unshift({ id: id('a_'), at: now(), actorId: '', actor: name, action: 'agreement.sign', targetType: 'employee', targetId: e.id, targetName: empNameOf(e), summary: `${empNameOf(e)} signed agreement “${a.title}”`, details: {}, ip: a.signerIp });
    if (e.stage === 'agreement') { e.stage = 'active'; e.updatedAt = now(); empEvent(e, 'employee.active', 'Onboarding complete', '', name); }
    notifyTo('agreement.signed', [empR(e)], () => ({ item: a.title, link: `${location.origin}/sign/?t=${token}` }), false, name);
    const sender = S.users.find((u) => u.id === a.sentById);
    if (sender) notifyTo('agreement.signed', [userR(sender)], () => ({ item: a.title, person: empNameOf(e), link: `${location.origin}/employees/?id=${e.id}` }), false, name);
    save();
    return toPublic(a, e);
  },
};

/* ---------- seed: people, projects, tickets ---------- */
/** A hand-drawn-looking signature for seeded, already-signed agreements. */
function demoSignature(name: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="70"><text x="10" y="48" font-family="Brush Script MT, Segoe Script, cursive" font-size="40" fill="#1c1b20">${name}</text><path d="M8 58 C 80 50, 160 64, 250 52" stroke="#1c1b20" fill="none" stroke-width="1.5"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Runs while the state is being created, so it only touches the state it is given.
function seedWork(S: State) {
  const user = (u: string) => S.users.find((x) => x.username === u)!;
  const hr = user('dilini.perera'), pm = user('sachini.bandara'), boss = user('superadmin');
  const pay = (basic: number, allow: number, n: number): Payroll => ({ basicSalary: basic, allowances: allow, currency: 'LKR', epfNumber: `EPF-${4100 + n}`, etfNumber: `ETF-${4100 + n}`, bankName: ['Commercial Bank', 'Sampath Bank', 'HNB'][n % 3], bankAccount: String(8001200000 + n * 7919) });
  type Row = [string, string, string, string, string, Employee['employmentType'], Employee['stage'], number, string | null, number];
  const rows: Row[] = [
    ['Ishara', 'Jayasinghe', 'ishara.j@techzaz.lk', 'Software Engineering', 'Full-stack Developer', 'permanent', 'active', 420, 'ishara.jayasinghe', 260000],
    ['Ruwan', 'Fernando', 'ruwan.fernando@techzaz.lk', 'Network Engineering', 'Network Engineer', 'permanent', 'active', 380, 'ruwan.fernando', 240000],
    ['Pasindu', 'Herath', 'pasindu.herath@techzaz.lk', 'Software Engineering', 'Engineering Intern', 'intern', 'active', 60, 'pasindu.herath', 65000],
    ['Nethmi', 'Karunaratne', 'nethmi.karunaratne@techzaz.lk', 'Cybersecurity', 'SOC Analyst', 'permanent', 'active', 300, 'nethmi.karunaratne', 210000],
    ['Kaveesha', 'Wijesinghe', 'kaveesha.w@gmail.com', 'Software Engineering', 'QA Engineer', 'probation', 'agreement', 6, null, 175000],
    ['Nadeesha', 'Fernando', 'nadeesha.f@gmail.com', 'Cybersecurity', 'Security Engineer', 'probation', 'approval', 4, null, 230000],
    ['Tharushi', 'Mendis', 'tharushi.mendis@yahoo.com', 'Customer Success', 'Support Engineer', 'contract', 'documents', 3, null, 150000],
    ['Hasitha', 'Rajapaksha', 'hasitha.r@gmail.com', 'Network Engineering', 'NOC Technician', 'probation', 'documents', 1, null, 120000],
    ['Legacy', 'Contractor', 'contractor@vendor.invalid', 'External', 'Contractor', 'contract', 'offboarded', 500, null, 0],
  ];
  rows.forEach(([firstName, lastName, email, department, jobTitle, employmentType, stage, daysAgo, username, basic], i) => {
    const e: StoredEmployee = {
      id: `e_${firstName.toLowerCase()}`, code: `TZ-${String(i + 1).padStart(4, '0')}`, firstName, lastName, email,
      phone: `+94 77 ${String(2100000 + i * 41113).slice(0, 3)} ${String(2100000 + i * 41113).slice(3, 7)}`, nic: `19${94 + (i % 6)}${String(10234567 + i * 9871).slice(0, 8)}`,
      dateOfBirth: `${1994 + (i % 6)}-0${(i % 9) + 1}-1${i % 9}`, address: `${12 + i} Galle Road, Colombo 0${(i % 6) + 3}`, department, jobTitle, employmentType,
      startDate: new Date(Date.now() - (daysAgo - 14) * 86_400_000).toISOString().slice(0, 10), stage, userId: username ? user(username).id : null,
      submittedBy: null, submittedById: null, lastDecision: null, payroll: basic ? pay(basic, Math.round(basic / 10), i) : { ...pay(0, 0, i), epfNumber: '', etfNumber: '' },
      createdAt: ago(60 * 24 * daysAgo), createdBy: fullName(hr), updatedAt: ago(60 * 24 * Math.max(1, daysAgo - 2)),
    };
    S.employees.push(e);
    const ev = (min: number, action: string, summary: string, note = '', actor = fullName(hr)) => S.empEvents.push({ id: `ev_${e.id}_${S.empEvents.length}`, employeeId: e.id, at: ago(min), actor, action, summary, note });
    ev(60 * 24 * daysAgo, 'employee.create', 'Onboarding started');
    const docs: DocCategory[] = stage === 'documents' ? (i === 6 ? ['birth_certificate', 'nic', 'education'] : ['birth_certificate', 'cv']) : ['birth_certificate', 'nic', 'education', 'cv', ...(basic ? ['epf', 'etf'] as DocCategory[] : [])];
    docs.forEach((c, k) => {
      S.docs.push({ id: `d_${e.id}_${c}`, employeeId: e.id, category: c, title: c === 'education' ? 'BSc (Hons) Computing' : DOCS[c].label, filename: `${c.replace('_', '-')}-${firstName.toLowerCase()}.pdf`,
        contentType: 'application/pdf', size: 180_000 + k * 53_211, uploadedBy: fullName(hr), uploadedAt: ago(60 * 24 * daysAgo - 60 * (k + 1)), data: null });
      ev(60 * 24 * daysAgo - 60 * (k + 1), 'document.upload', `Uploaded ${DOCS[c].label}`);
    });
    if (i === 6) { e.lastDecision = { decision: 'rejected', by: fullName(boss), at: ago(60 * 20), note: 'The NIC copy is unreadable. Please upload a clearer scan of both sides.' };
      ev(60 * 22, 'employee.submit', 'Submitted for approval'); ev(60 * 20, 'employee.rejected', 'Sent back for changes', e.lastDecision.note, fullName(boss)); }
    if (stage !== 'documents' && stage !== 'offboarded') { e.submittedBy = fullName(hr); e.submittedById = hr.id; ev(60 * 24 * (daysAgo - 1), 'employee.submit', 'Submitted for approval'); }
    if (['agreement', 'active'].includes(stage)) {
      e.lastDecision = { decision: 'approved', by: fullName(boss), at: ago(60 * 24 * (daysAgo - 2)), note: 'Documents verified.' };
      ev(60 * 24 * (daysAgo - 2), 'employee.approved', 'Approved', 'Documents verified.', fullName(boss));
      const signed = stage === 'active';
      S.agreements.push({
        id: `ag_${e.id}`, employeeId: e.id, title: `Employment Agreement — ${firstName} ${lastName}`, status: signed ? 'signed' : 'viewed',
        body: `This Employment Agreement is made between Techzaz Networks and ${firstName} ${lastName}.\n\n1. Position. ${jobTitle}, ${department}.\n\n2. Remuneration. A monthly basic salary of LKR ${basic.toLocaleString('en-LK')}, subject to statutory deductions.\n\n3. EPF and ETF. The Company contributes 12% (EPF) and 3% (ETF) of the basic salary; the Employee contributes 8% (EPF).\n\n4. Termination. Either party may end this agreement with one month's written notice.`,
        createdAt: ago(60 * 24 * (daysAgo - 2)), createdBy: fullName(hr), sentAt: ago(60 * 24 * (daysAgo - 2) - 30), viewedAt: ago(60 * 24 * (daysAgo - 3)),
        signedAt: signed ? ago(60 * 24 * (daysAgo - 3)) : null, expiresAt: new Date(Date.now() + (signed ? -1 : 10) * 86_400_000).toISOString(),
        signerName: signed ? `${firstName} ${lastName}` : '', signerIp: signed ? '112.134.40.17' : '', signature: signed ? demoSignature(firstName) : null,
        token: signed ? null : 'demo-sign-kaveesha-0000000000000000000000', sentById: hr.id,
      });
      ev(60 * 24 * (daysAgo - 2) - 30, 'agreement.send', `Sent “Employment Agreement — ${firstName} ${lastName}” for signature`);
      ev(60 * 24 * (daysAgo - 3), 'agreement.view', `Opened “Employment Agreement — ${firstName} ${lastName}”`, '', `${firstName} ${lastName}`);
      if (signed) ev(60 * 24 * (daysAgo - 3) + 10, 'employee.active', 'Onboarding complete', '', `${firstName} ${lastName}`);
    }
    if (stage === 'offboarded') ev(60 * 24 * 90, 'employee.offboard', 'Offboarded', 'Contract ended.');
  });

  const E = (first: string) => `e_${first.toLowerCase()}`;
  const P = (key: string, name: string, client: string, status: Project['status'], health: Project['health'], start: number, due: number, lead: string, description: string): StoredProject =>
    ({ id: `p_${key.toLowerCase()}`, key, name, description, client, status, health, leadId: E(lead), seq: 0,
      startDate: new Date(Date.now() - start * 86_400_000).toISOString().slice(0, 10), dueDate: new Date(Date.now() + due * 86_400_000).toISOString().slice(0, 10),
      createdAt: ago(60 * 24 * start), updatedAt: ago(60 * 3) });
  S.projects.push(
    P('TEMS', 'TEMS Rollout', 'Internal', 'active', 'at_risk', 40, 20, 'Ishara', 'Deploy Techzaz EMS to tems.techzaz.lk, publish mail DNS and onboard every team.'),
    P('NOC', 'NOC Monitoring Upgrade', 'Lanka Logistics (Pvt) Ltd', 'active', 'on_track', 25, 45, 'Ruwan', 'Replace the legacy Nagios stack with Zabbix and on-call alerting.'),
    P('SOC', 'Managed SOC Onboarding', 'Ceylon Finance PLC', 'planning', 'on_track', 5, 75, 'Nethmi', 'Onboard log sources, tune detections and agree the incident runbook.'),
    P('WEB', 'Corporate Website Refresh', 'Internal', 'completed', 'on_track', 120, -10, 'Ishara', 'New techzaz.lk with services, case studies and the assessment form.'),
  );
  const member = (pkey: string, first: string, role: string, allocation: number, days: number) =>
    S.members.push({ projectId: `p_${pkey.toLowerCase()}`, employeeId: E(first), role, allocation, assignedAt: ago(60 * 24 * days) });
  member('TEMS', 'Ishara', 'Tech lead', 60, 38); member('TEMS', 'Pasindu', 'Developer', 100, 30); member('TEMS', 'Ruwan', 'Mail & DNS', 20, 20);
  member('NOC', 'Ruwan', 'Network lead', 70, 24); member('NOC', 'Pasindu', 'Automation', 0, 10);
  member('SOC', 'Nethmi', 'SOC lead', 80, 5);
  member('WEB', 'Ishara', 'Developer', 40, 118);

  type T = [string, string, Ticket['type'], Ticket['priority'], Ticket['status'], string | null, number, string];
  const tickets: T[] = [
    ['TEMS', 'Publish SPF, DKIM and DMARC records', 'task', 'urgent', 'in_progress', 'Ruwan', 3, 'Run scripts/mail-dns.sh on the server and add the records to the techzaz.lk zone.'],
    ['TEMS', 'Ask the provider to set reverse DNS', 'task', 'high', 'open', 'Ruwan', 5, 'PTR for the server IP → mail.tems.techzaz.lk.'],
    ['TEMS', 'Nightly backups to off-site storage', 'task', 'medium', 'in_review', 'Pasindu', 9, 'Cron scripts/backup.sh and sync backups/ to object storage.'],
    ['TEMS', 'Login page shows English only', 'bug', 'low', 'open', null, 12, 'Add Sinhala and Tamil messages to the Keycloak theme.'],
    ['TEMS', 'Import existing staff from the HR spreadsheet', 'feature', 'high', 'resolved', 'Ishara', 15, '120 staff records with their documents.'],
    ['TEMS', 'Configure Caddy TLS', 'task', 'medium', 'closed', 'Ishara', 20, 'deploy/Caddyfile'],
    ['NOC', 'Inventory every device with SNMP', 'task', 'high', 'in_progress', 'Ruwan', 4, ''],
    ['NOC', 'Zabbix templates for Fortigate', 'feature', 'medium', 'open', 'Pasindu', 7, ''],
    ['NOC', 'On-call rota in PagerDuty', 'support', 'low', 'resolved', 'Ruwan', 11, ''],
    ['SOC', 'Kick-off workshop with Ceylon Finance', 'task', 'medium', 'open', 'Nethmi', 2, 'Agree log sources and escalation contacts.'],
    ['WEB', 'Launch the new website', 'task', 'high', 'closed', 'Ishara', 100, ''],
  ];
  tickets.forEach(([key, title, type, priority, status, who, days, description], i) => {
    const p = S.projects.find((x) => x.key === key)!;
    p.seq++;
    const t: StoredTicket = { id: `t_${key.toLowerCase()}_${p.seq}`, projectId: p.id, number: p.seq, title, description, type, priority, status,
      assigneeId: who ? E(who) : null, reporterId: pm.id, reporter: fullName(pm), dueDate: status === 'closed' ? '' : new Date(Date.now() + (days - 4) * 86_400_000).toISOString().slice(0, 10),
      createdAt: ago(60 * 24 * days), updatedAt: ago(60 * (i + 2)) };
    S.tickets.push(t);
    if (status !== 'open') S.comments.push({ id: `c_${t.id}_s`, ticketId: t.id, at: ago(60 * (i + 2)), author: who ? `${who}` : fullName(pm), authorId: '', body: `Status: Open → ${TICKET_STATUS[status]}`, system: true });
  });
  S.comments.push({ id: 'c_dns_1', ticketId: 't_tems_1', at: ago(90), author: 'Ruwan Fernando', authorId: user('ruwan.fernando').id, body: 'DKIM key generated. Waiting for the registrar to accept the 2048-bit TXT record.', system: false });
  S.comments.push({ id: 'c_dns_2', ticketId: 't_tems_1', at: ago(45), author: fullName(pm), authorId: pm.id, body: 'Thanks. If they cap TXT length, split it into two strings.', system: false });
  const up = (key: string, min: number, status: Project['status'], health: Project['health'], progress: number, note: string, author = fullName(pm)) =>
    S.updates.push({ id: `pu_${key}_${min}`, projectId: `p_${key.toLowerCase()}`, at: ago(min), author, status, health, progress, note });
  up('TEMS', 60 * 24 * 40, 'planning', 'on_track', 0, 'Project created.');
  up('TEMS', 60 * 24 * 30, 'active', 'on_track', 10, 'Kick-off done. Server ordered.');
  up('TEMS', 60 * 3, 'active', 'at_risk', 33, 'Registrar has not published the DKIM record yet; mail to Gmail lands in spam until it does.');
  up('NOC', 60 * 24 * 25, 'active', 'on_track', 0, 'Project created.');
  up('NOC', 60 * 24 * 2, 'active', 'on_track', 33, 'SNMP inventory 70% complete.');
  up('SOC', 60 * 24 * 5, 'planning', 'on_track', 0, 'Project created.');
  up('WEB', 60 * 24 * 120, 'planning', 'on_track', 0, 'Project created.');
  up('WEB', 60 * 24 * 10, 'completed', 'on_track', 100, 'Launched. Thanks everyone!');
}
