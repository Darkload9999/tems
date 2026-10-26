// In-browser demo backend. Mirrors the Go API's behaviour and rules:
//   • permission checks on every call (super admins bypass)
//   • no privilege escalation: you can only grant permissions you hold, and only
//     super admins may change their own access or touch other super admins
//   • every change is audited and the affected users are emailed (outbox)
import type {
  AuditEntry, Group, MailItem, Me, MemberPermission, NotifyEvent, Permission, PermState,
  Session, Settings, Stats, User,
} from './types';
import type { Api, AuditQuery, MailQuery, UserQuery } from './api';
import { EVENTS, renderEmail, type EmailData } from './email';
import { demoAs } from './auth';
import { fullName } from './ui';

const KEY = 'tems-demo-v1';
const MAX_MAIL = 400;
const MAX_AUDIT = 600;

type StoredGroup = Omit<Group, 'memberCount'>;
interface State {
  users: User[];
  groups: StoredGroup[];
  perms: Permission[];
  mail: MailItem[];
  audit: AuditEntry[];
  settings: Settings;
  sessions: Record<string, Session[]>;
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
  ];

  type Seed = [string, string, string, string, string, string, string[], Partial<User>?];
  const rows: Seed[] = [
    ['superadmin', 'Super', 'Admin', 'admin@tems.techzaz.lk', 'IT Governance', 'Platform Owner', ['g_admins'], { superAdmin: true }],
    ['nimal.perera', 'Nimal', 'Perera', 'nimal.perera@techzaz.lk', 'Security Operations', 'SOC Lead', ['g_admins', 'g_soc']],
    ['kasun.liyanage', 'Kasun', 'Liyanage', 'kasun.liyanage@techzaz.lk', 'IT Infrastructure', 'Infrastructure Manager', ['g_admins']],
    ['kavindi.silva', 'Kavindi', 'Silva', 'kavindi.silva@techzaz.lk', 'Customer Success', 'Support Engineer', ['g_support', 'g_staff']],
    ['sachini.bandara', 'Sachini', 'Bandara', 'sachini.bandara@techzaz.lk', 'Project Management', 'Project Manager', ['g_support', 'g_staff'], { denies: ['users:reset-password'] }],
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
  };

  const S: State = { users, groups, perms, mail: [], audit: [], settings, sessions };

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
  if (!force && !S.settings.notifications[ev]) return 0;
  const actor = fullName(meUser());
  let n = 0;
  for (const u of users) {
    if (!u.email) continue;
    const r = renderEmail(ev, { origin: location.origin, firstName: u.firstName, username: u.username, actor, ...data(u) });
    const m: MailItem = {
      id: id('m_'), to: u.email, toName: fullName(u), userId: u.id, subject: r.subject, event: ev,
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
};

/** For the demo "view as" switcher. */
export function demoUsers(): Array<{ id: string; name: string; label: string }> {
  return S.users.filter((u) => u.enabled).map((u) => ({
    id: u.id, name: fullName(u),
    label: u.superAdmin ? 'Super admin' : u.groups.map((g) => groupById(g)?.name).filter(Boolean).join(', ') || 'No groups',
  }));
}
