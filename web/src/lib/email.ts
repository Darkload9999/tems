// Notification email catalogue + renderer (table layout, inline styles, mail-client safe).
// The Go API renders the same design server-side; this copy powers previews and demo mode.
import type { MailboxConfig, NotifyEvent, Signature, SignatureCategory } from './types';
import { esc } from './ui';

export const EVENTS: Record<NotifyEvent, { label: string; desc: string; group: string }> = {
  'user.created':              { group: 'Accounts',    label: 'Account created',           desc: 'Welcome email when an admin creates the account' },
  'user.updated':              { group: 'Accounts',    label: 'Profile updated',           desc: 'Name, email or profile details changed by an admin' },
  'user.disabled':             { group: 'Accounts',    label: 'Account disabled',          desc: 'Sign-in was blocked by an admin' },
  'user.enabled':              { group: 'Accounts',    label: 'Account re-enabled',        desc: 'Sign-in was restored by an admin' },
  'user.deleted':              { group: 'Accounts',    label: 'Account removed',           desc: 'Sent just before the account is deleted' },
  'user.password_reset':       { group: 'Security',    label: 'Password reset',            desc: 'An admin reset the password or sent a setup link' },
  'user.sessions_revoked':     { group: 'Security',    label: 'Signed out everywhere',     desc: 'An admin ended all active sessions' },
  'superadmin.granted':        { group: 'Security',    label: 'Super admin granted',       desc: 'Unrestricted access was granted' },
  'superadmin.revoked':        { group: 'Security',    label: 'Super admin revoked',       desc: 'Unrestricted access was removed' },
  'mailbox.setup':             { group: 'Accounts',    label: 'Outlook setup',             desc: 'Work email and Outlook settings, sent to the personal address. Always sent.' },
  'group.member_added':        { group: 'Access',      label: 'Added to a group',          desc: 'Includes the permissions the group grants' },
  'group.member_removed':      { group: 'Access',      label: 'Removed from a group',      desc: 'Includes the permissions that were lost' },
  'group.permissions_changed': { group: 'Access',      label: 'Group permissions changed', desc: 'Sent to every member of the group' },
  'group.renamed':             { group: 'Access',      label: 'Group renamed',             desc: 'Sent to every member of the group' },
  'group.deleted':             { group: 'Access',      label: 'Group deleted',             desc: 'Sent to every former member' },
  'member.permissions_changed':{ group: 'Access',      label: 'Personal permissions changed', desc: 'A member-level allow or deny was changed' },
  'employee.onboarding_started': { group: 'Employees', label: 'Onboarding started',       desc: 'Welcome email to a new employee explaining the next steps' },
  'employee.updated':          { group: 'Employees',   label: 'Employee record updated',   desc: 'HR changed details in the employee record' },
  'employee.payroll_changed':  { group: 'Employees',   label: 'Payroll updated',           desc: 'Salary, EPF/ETF or bank details changed (amounts are never emailed)' },
  'employee.document_added':   { group: 'Employees',   label: 'Document added',            desc: 'HR added a document to the employee file' },
  'employee.approval_requested': { group: 'Employees', label: 'Approval requested',        desc: 'Sent to approvers when HR submits an employee' },
  'employee.approved':         { group: 'Employees',   label: 'Onboarding approved',       desc: 'Sent to the HR member who submitted the employee' },
  'employee.rejected':         { group: 'Employees',   label: 'Sent back for changes',     desc: 'Sent to the HR member who submitted the employee, with the note' },
  'employee.offboarded':       { group: 'Employees',   label: 'Offboarded',                desc: 'Sent to the employee when their record is closed' },
  'agreement.sent':            { group: 'Agreements',  label: 'Agreement to sign',         desc: 'The private signing link. Always sent.' },
  'agreement.signed':          { group: 'Agreements',  label: 'Agreement signed',          desc: 'Confirmation to the employee and to the HR member who sent it' },
  'project.assigned':          { group: 'Projects',    label: 'Assigned to a project',     desc: 'Includes the role on the project' },
  'project.unassigned':        { group: 'Projects',    label: 'Removed from a project',    desc: '' },
  'project.status_changed':    { group: 'Projects',    label: 'Project status update',     desc: 'Sent to the whole team when a status update is posted' },
  'ticket.assigned':           { group: 'Tickets',     label: 'Ticket assigned',           desc: 'Sent to the new assignee' },
  'ticket.updated':            { group: 'Tickets',     label: 'Ticket updated',            desc: 'Status, priority or due date changes, to the assignee and reporter' },
  'ticket.commented':          { group: 'Tickets',     label: 'Ticket comment',            desc: 'New comments, to the assignee and reporter' },
  'mail.direct':               { group: 'Messages',    label: 'Direct messages',           desc: 'Messages composed by admins in the Mail section' },
};

/** Always delivered, whatever the notification settings say. */
export const FORCED: NotifyEvent[] = ['mail.direct', 'agreement.sent', 'mailbox.setup'];

/* ---------- signatures + mailbox (same defaults as the Go API) ---------- */
export const DEFAULT_SIGNATURES: Signature[] = [
  { id: 'hr', team: 'Human Resource Team', company: 'Techzaz Networks (Pvt) Ltd', email: 'hr@techzaz.lk', phone: '+76 766 2071', web: 'techzaz.lk' },
  { id: 'it', team: 'IT Department', company: 'Techzaz Networks (Pvt) Ltd', email: 'hr@techzaz.lk', phone: '+76 766 2071', web: 'techzaz.lk' },
  { id: 'marketing', team: 'Marketing Team', company: 'Techzaz Networks (Pvt) Ltd', email: 'hr@techzaz.lk', phone: '+76 766 2071', web: 'techzaz.lk' },
];
export const DEFAULT_SIGNATURE_FOR: Record<SignatureCategory, string> = { accounts: 'it', people: 'hr', work: 'it' };
export const SIGNATURE_CATEGORIES: Record<SignatureCategory, { label: string; desc: string }> = {
  accounts: { label: 'Accounts & access', desc: 'Accounts, security, groups, permissions and Outlook setup' },
  people:   { label: 'People',            desc: 'Onboarding, employee records and agreements' },
  work:     { label: 'Projects & tickets', desc: 'Project assignments, status updates and tickets' },
};
export const DEFAULT_MAILBOX: MailboxConfig = {
  incomingHost: 'mail.techzaz.lk', incomingPort: 993, incomingSecurity: 'SSL/TLS',
  outgoingHost: 'mail.techzaz.lk', outgoingPort: 587, outgoingSecurity: 'STARTTLS',
  webmail: 'https://mail.techzaz.lk',
};

/** Which signature category signs an event ('' for direct messages, which pick their own). */
export function signatureCategory(ev: NotifyEvent): SignatureCategory | '' {
  if (ev === 'mail.direct') return '';
  if (ev.startsWith('employee.') || ev.startsWith('agreement.')) return 'people';
  if (ev.startsWith('project.') || ev.startsWith('ticket.')) return 'work';
  return 'accounts';
}

const webHref = (w: string) => (/^https?:\/\//.test(w) ? w : `https://${w}`);
const webLabel = (w: string) => w.replace(/^https?:\/\//, '').replace(/\/$/, '');
const telHref = (p: string) => `tel:${p.replace(/[^+\d]/g, '')}`;

/** A signature as an email-safe table in the copper brand palette. */
export function signatureHtml(s: Signature | null | undefined, origin: string): string {
  if (!s?.team) return '';
  const row = (label: string, value: string, href: string) => value
    ? `<tr><td style="padding:1px 10px 1px 0;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b98a63">${label}</td><td style="padding:1px 0;font-size:13px"><a href="${esc(href)}" style="color:#5b3d28;text-decoration:none">${esc(value)}</a></td></tr>`
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;font-family:'Plus Jakarta Sans','Segoe UI',Arial,sans-serif"><tr>`
    + `<td style="padding:0 18px 0 0;vertical-align:middle"><img src="${esc(origin)}/brand/logo-full.png" width="112" alt="Techzaz Networks" style="display:block;width:112px;height:auto"></td>`
    + `<td style="width:3px;background:#c99a72;background-image:linear-gradient(180deg,#e8c39f,#a86f45);border-radius:3px;font-size:0;line-height:0">&nbsp;</td>`
    + `<td style="padding:2px 0 2px 16px;vertical-align:middle;line-height:1.5">`
    + `<div style="font-size:15px;font-weight:700;color:#4a2f1d;letter-spacing:.005em">${esc(s.team)}</div>`
    + (s.company ? `<div style="font-size:13px;color:#8a6a52;margin-bottom:6px">${esc(s.company)}</div>` : '')
    + `<table role="presentation" cellpadding="0" cellspacing="0">${row('Email', s.email, `mailto:${s.email}`)}${row('Mobile', s.phone, telHref(s.phone))}${s.web ? row('Web', webLabel(s.web), webHref(s.web)) : ''}</table>`
    + `</td></tr></table>`;
}

const signatureText = (s: Signature | null | undefined) => !s?.team ? [] : [
  '--', s.team, s.company, s.email && `Email: ${s.email}`, s.phone && `Mobile: ${s.phone}`, s.web && `Web: ${webLabel(s.web)}`,
].filter(Boolean) as string[];

const mailboxRows = (work: string, m: MailboxConfig): [string, string][] => [
  ['Email address', work],
  ['Account type', 'IMAP'],
  ['Incoming server', `${m.incomingHost} · port ${m.incomingPort} · ${m.incomingSecurity}`],
  ['Outgoing server (SMTP)', `${m.outgoingHost} · port ${m.outgoingPort} · ${m.outgoingSecurity}`],
  ['User name', work],
  ['Password', 'Your mailbox password (shared with you separately by IT)'],
  ['Outgoing authentication', 'Required · same user name and password'],
];
const OUTLOOK_STEPS = [
  'Open Outlook and go to <b>File → Add account</b> (on the new Outlook: <b>Settings → Accounts → Add account</b>).',
  'Enter your work email address, open <b>Advanced options</b>, tick <b>Let me set up my account manually</b> and select <b>Connect</b>.',
  'Choose <b>IMAP</b> and enter the incoming and outgoing server settings above.',
  'Enter your mailbox password, select <b>Connect</b>, then <b>Done</b>. Your inbox syncs in a minute or two.',
  'On your phone: install <b>Microsoft Outlook</b>, tap <b>Add account</b>, enter your work email, choose <b>IMAP</b> and use the same settings.',
];
const mailboxHtml = (work: string, m: MailboxConfig) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1ecfd;border-radius:12px;margin:4px 0 18px"><tr><td style="padding:16px 18px">`
  + `<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6d6884;margin-bottom:8px">Outlook account settings</div>`
  + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${mailboxRows(work, m).map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;font-size:13px;color:#6d6884;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0;font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:#2a1066">${esc(v)}</td></tr>`).join('')}</table></td></tr></table>`
  + `<p style="margin:0 0 8px;font-weight:700">Set it up in Outlook</p><ol style="margin:0 0 16px;padding-left:20px">${OUTLOOK_STEPS.map((s) => `<li style="margin:0 0 6px">${s}</li>`).join('')}</ol>`
  + (m.webmail ? `<p style="margin:0 0 14px">You can also read your mail in a browser at <a href="${esc(webHref(m.webmail))}" style="color:#5b3fd6">${esc(webLabel(m.webmail))}</a>.</p>` : '');
const mailboxText = (work: string, m: MailboxConfig) => [
  '', 'Outlook account settings', ...mailboxRows(work, m).map(([k, v]) => `  ${k}: ${v}`),
  '', 'Set it up in Outlook', ...OUTLOOK_STEPS.map((s, i) => `  ${i + 1}. ${s.replace(/<[^>]+>/g, '')}`),
  ...(m.webmail ? ['', `Webmail: ${webHref(m.webmail)}`] : []),
];

export interface EmailData {
  origin: string;
  firstName: string;
  username?: string;
  actor: string;
  group?: string;
  newName?: string;
  added?: string[];
  removed?: string[];
  changes?: string[];
  setup?: 'link' | 'temporary';
  subject?: string;
  message?: string;
  link?: string;      // call-to-action target (defaults to origin)
  person?: string;    // the employee a staff-facing email is about
  role?: string;
  item?: string;      // document, agreement or ticket title
  project?: string;
  note?: string;
  expires?: string;
  workEmail?: string;          // mailbox.setup: the work address being set up
  mailbox?: MailboxConfig;     // mailbox.setup: server settings (defaults when absent)
  signature?: Signature | null; // team sign-off
}

interface Copy { subject: string; title: string; lead: string; body?: string; cta?: string; tone?: 'warn' | 'ok' }

function copyFor(ev: NotifyEvent, d: EmailData): Copy {
  const g = d.group ?? 'a group';
  switch (ev) {
    case 'user.created': return {
      subject: 'Welcome to Techzaz EMS', title: 'Welcome aboard.',
      lead: `An administrator created your Techzaz EMS account. Your username is <b>${esc(d.username)}</b>.`,
      body: d.setup === 'temporary'
        ? 'Your administrator will share a temporary password with you. You will be asked to choose your own password the first time you sign in.'
        : 'You will receive a separate email with a secure link to set your password. The link expires in 12 hours.',
      cta: 'Sign in to Techzaz EMS', tone: 'ok' };
    case 'user.updated': return {
      subject: 'Your account details were updated', title: 'Profile updated.',
      lead: 'An administrator updated the following details on your account:' };
    case 'user.disabled': return {
      subject: 'Your account has been disabled', title: 'Access paused.', tone: 'warn',
      lead: 'Your Techzaz EMS account has been disabled and you can no longer sign in. If you believe this is a mistake, contact your administrator.' };
    case 'user.enabled': return {
      subject: 'Your account has been re-enabled', title: 'Welcome back.', tone: 'ok',
      lead: 'Your Techzaz EMS account is active again. You can sign in as usual.', cta: 'Sign in' };
    case 'user.deleted': return {
      subject: 'Your account has been removed', title: 'Account removed.', tone: 'warn',
      lead: 'Your Techzaz EMS account has been permanently removed by an administrator. You will no longer be able to sign in.' };
    case 'user.password_reset': return {
      subject: 'Your password was reset', title: 'Password reset.', tone: 'warn',
      lead: d.setup === 'temporary'
        ? 'An administrator reset your password. They will share a temporary password with you, and you will choose a new one on your next sign-in.'
        : 'An administrator reset your password. You will receive a separate email with a secure link to choose a new one.' };
    case 'mailbox.setup': return {
      subject: `Your Techzaz work email is ready: ${d.workEmail}`, title: 'Your mailbox.', tone: 'ok', cta: 'Sign in to Techzaz EMS',
      lead: `Your Techzaz Networks work email <b>${esc(d.workEmail)}</b> is ready. We sent these setup details to your personal address so you can add it to Outlook on your computer and phone.` };
    case 'user.sessions_revoked': return {
      subject: 'You were signed out of all devices', title: 'Signed out.', tone: 'warn',
      lead: 'An administrator ended all of your active sessions. Sign in again to continue.', cta: 'Sign in' };
    case 'superadmin.granted': return {
      subject: 'You are now a super administrator', title: 'Full access.', tone: 'ok',
      lead: 'You were granted <b>super administrator</b> rights. You now have unrestricted access to every part of Techzaz EMS. Please use it carefully.' };
    case 'superadmin.revoked': return {
      subject: 'Your super administrator rights were removed', title: 'Access changed.', tone: 'warn',
      lead: 'Your super administrator rights were removed. Your access now follows your group and personal permissions.' };
    case 'group.member_added': return {
      subject: `You were added to ${g}`, title: 'New group.', tone: 'ok',
      lead: `You are now a member of <b>${esc(g)}</b>.` };
    case 'group.member_removed': return {
      subject: `You were removed from ${g}`, title: 'Group left.',
      lead: `You are no longer a member of <b>${esc(g)}</b>.` };
    case 'group.permissions_changed': return {
      subject: `Permissions for ${g} changed`, title: 'Access updated.',
      lead: `The permissions granted by <b>${esc(g)}</b>, a group you belong to, have changed:` };
    case 'group.renamed': return {
      subject: `${g} is now ${d.newName}`, title: 'Group renamed.',
      lead: `The group <b>${esc(g)}</b> has been renamed to <b>${esc(d.newName)}</b>. Your access is unchanged.` };
    case 'group.deleted': return {
      subject: `${g} was deleted`, title: 'Group deleted.', tone: 'warn',
      lead: `The group <b>${esc(g)}</b> was deleted. Any permissions it granted you have been removed.` };
    case 'member.permissions_changed': return {
      subject: 'Your permissions changed', title: 'Access updated.',
      lead: 'An administrator changed your personal permissions:' };
    case 'employee.onboarding_started': return {
      subject: 'Welcome to Techzaz Networks', title: 'Welcome.', tone: 'ok',
      lead: `Our HR team has started your onboarding at Techzaz Networks${d.role ? ` as <b>${esc(d.role)}</b>` : ''}.`,
      body: "Next, HR will collect your documents (birth certificate, NIC and educational qualifications). After an approval, you will receive your employment agreement to review and sign online. You don't need to do anything yet." };
    case 'employee.updated': return { subject: 'Your employee record was updated', title: 'Record updated.', lead: 'HR updated the following details in your employee record:' };
    case 'employee.payroll_changed': return { subject: 'Your payroll details were updated', title: 'Payroll updated.', lead: 'HR updated your payroll details:', body: 'If anything looks wrong, contact HR.' };
    case 'employee.document_added': return { subject: 'A document was added to your employee file', title: 'File updated.', lead: `HR added <b>${esc(d.item)}</b> to your employee file.` };
    case 'employee.approval_requested': return {
      subject: `Approval needed: ${d.person}`, title: 'Approval needed.', cta: 'Review in Techzaz EMS',
      lead: `<b>${esc(d.actor)}</b> submitted <b>${esc(d.person)}</b>${d.role ? ` as <b>${esc(d.role)}</b>` : ''} for onboarding approval. All required documents are uploaded.` };
    case 'employee.approved': return { subject: `${d.person} was approved`, title: 'Approved.', tone: 'ok', cta: 'Open employee',
      lead: `The onboarding of <b>${esc(d.person)}</b> was approved. You can now send their employment agreement.` };
    case 'employee.rejected': return { subject: `${d.person} needs changes`, title: 'Changes needed.', tone: 'warn', cta: 'Open employee',
      lead: `The onboarding of <b>${esc(d.person)}</b> was sent back for changes.` };
    case 'employee.offboarded': return { subject: 'Your employee record was closed', title: 'Farewell.', tone: 'warn',
      lead: 'Your employee record at Techzaz Networks has been closed. Thank you for everything you contributed.' };
    case 'agreement.sent': return {
      subject: `Please review and sign: ${d.item}`, title: 'Your agreement.', tone: 'ok', cta: 'Review and sign',
      lead: `Techzaz Networks has sent you <b>${esc(d.item)}</b> to review and sign online.`,
      body: `Open the secure link below, read the agreement carefully, then sign in the signature box. The link is personal to you; please don't forward it.${d.expires ? ` It expires on ${d.expires}.` : ''}` };
    case 'agreement.signed': return d.person
      ? { subject: `${d.person} signed ${d.item}`, title: 'Signed.', tone: 'ok', cta: 'Open employee', lead: `<b>${esc(d.person)}</b> signed <b>${esc(d.item)}</b>. A signed copy was added to their employee file.` }
      : { subject: `You signed ${d.item}`, title: 'Signed.', tone: 'ok', cta: 'View the signed agreement', lead: `Thank you. You signed <b>${esc(d.item)}</b>. A signed copy is kept in your employee file.` };
    case 'project.assigned': return { subject: `You were added to ${d.project}`, title: 'New project.', tone: 'ok', cta: 'Open my work',
      lead: `You were assigned to <b>${esc(d.project)}</b>${d.role ? ` as <b>${esc(d.role)}</b>` : ''}.` };
    case 'project.unassigned': return { subject: `You were removed from ${d.project}`, title: 'Project left.', lead: `You are no longer assigned to <b>${esc(d.project)}</b>.` };
    case 'project.status_changed': return { subject: `${d.project}: status update`, title: 'Status update.', cta: 'Open my work',
      lead: `There is a new status update for <b>${esc(d.project)}</b>:` };
    case 'ticket.assigned': return { subject: `Assigned to you: ${d.item}`, title: 'New ticket.', cta: 'Open ticket',
      lead: `<b>${esc(d.actor)}</b> assigned you <b>${esc(d.item)}</b> in ${esc(d.project)}.` };
    case 'ticket.updated': return { subject: `Updated: ${d.item}`, title: 'Ticket update.', cta: 'Open ticket', lead: `<b>${esc(d.item)}</b> in ${esc(d.project)} was updated:` };
    case 'ticket.commented': return { subject: `New comment: ${d.item}`, title: 'New comment.', cta: 'Open ticket', lead: `<b>${esc(d.actor)}</b> commented on <b>${esc(d.item)}</b>:` };
    case 'mail.direct': return {
      subject: d.subject || 'Message from Techzaz EMS', title: 'Message.', lead: '' };
  }
}

const li = (items: string[], color: string, sign: string) =>
  items.map((x) => `<tr><td style="padding:3px 0;font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:${color}">${sign} ${esc(x)}</td></tr>`).join('');

export function renderEmail(ev: NotifyEvent, d: EmailData): { subject: string; html: string; text: string } {
  const c = copyFor(ev, d);
  const accent = c.tone === 'warn' ? '#b7791f' : c.tone === 'ok' ? '#0f9f6e' : '#7b46e3';
  const listRows =
    li(d.added ?? [], '#0f9f6e', '+') +
    li(d.removed ?? [], '#d12b55', '−') +
    li(d.changes ?? [], '#2a1066', '•');
  const message = ev === 'mail.direct'
    ? esc(d.message).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('')
    : '';
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const mb = d.mailbox ?? DEFAULT_MAILBOX;
  const sent = ev === 'mail.direct' || ev === 'agreement.sent' || ev === 'mailbox.setup';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.subject)}</title><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;700&family=Plus+Jakarta+Sans:wght@400;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#efeaf9;font-family:'Plus Jakarta Sans','Segoe UI',Arial,sans-serif;color:#1c1b20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efeaf9;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(34,9,77,.45)">
<tr><td style="background:#2d0d60;background-image:radial-gradient(60% 80% at 25% 10%,rgba(140,92,240,.55),transparent 70%),repeating-linear-gradient(90deg,rgba(255,255,255,.06) 0 1px,transparent 1px 37px),repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 12px,transparent 12px 97px);padding:24px 30px 30px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${esc(d.origin)}/brand/logo-mark.png" width="34" alt="Techzaz" style="display:block"></td>
    <td style="padding-left:10px;font-family:Montserrat,Arial,sans-serif;font-size:19px;color:#1a0846;letter-spacing:.01em"><span style="font-weight:300;color:#e9e2ff">TECHZAZ</span><span style="color:#e9e2ff">+</span><b style="color:#ffffff">EMS</b></td>
  </tr></table>
  <div style="margin-top:44px;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:40px;line-height:1;color:#ffffff;text-align:right;text-transform:uppercase;letter-spacing:-.01em">${esc(c.title)}</div>
</td></tr>
<tr><td style="height:4px;background:${accent}"></td></tr>
<tr><td style="padding:30px 30px 8px;font-size:15px;line-height:1.65">
  <p style="margin:0 0 14px">Hi ${esc(d.firstName || d.username || 'there')},</p>
  ${c.lead ? `<p style="margin:0 0 14px">${c.lead}</p>` : ''}
  ${message}
  ${ev === 'mailbox.setup' ? mailboxHtml(d.workEmail ?? '', mb) : ''}
  ${listRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1ecfd;border-radius:12px;margin:4px 0 18px"><tr><td style="padding:14px 18px"><table role="presentation" cellpadding="0" cellspacing="0">${listRows}</table></td></tr></table>` : ''}
  ${d.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px"><tr><td style="border-left:3px solid ${accent};background:#f7f4fd;border-radius:0 10px 10px 0;padding:12px 16px;font-size:14px;color:#3a3647">${esc(d.note).replace(/\n/g, '<br>')}</td></tr></table>` : ''}
  ${c.body ? `<p style="margin:0 0 14px">${esc(c.body)}</p>` : ''}
  ${c.cta ? `<p style="margin:22px 0 22px"><a href="${esc(d.link || d.origin)}" style="display:inline-block;background:#22094d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px">${esc(c.cta)} &rarr;</a></p>` : ''}
  ${signatureHtml(d.signature, d.origin)}
  <p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #ece7f6;font-size:12.5px;color:#6d6884">${sent ? 'Sent' : 'Changed'} by ${esc(d.actor)} · ${esc(when)}.<br>If you did not expect this email, contact <a href="mailto:soc@techzaz.lk" style="color:#5b3fd6">soc@techzaz.lk</a>.</p>
</td></tr>
<tr><td style="padding:16px 30px 22px;font-size:11.5px;color:#9a95ad;line-height:1.6">Techzaz Networks · 476/2 Sri Rajasinghe Mawatha, Wattala 11104, Sri Lanka<br>This is an automated message from Techzaz EMS. Please do not reply.</td></tr>
</table></td></tr></table></body></html>`;

  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  const text = [
    `Hi ${d.firstName || d.username || 'there'},`, '',
    strip(c.lead), ev === 'mail.direct' ? (d.message ?? '') : '',
    ...(ev === 'mailbox.setup' ? mailboxText(d.workEmail ?? '', mb) : []),
    ...(d.added ?? []).map((x) => `+ ${x}`), ...(d.removed ?? []).map((x) => `- ${x}`), ...(d.changes ?? []).map((x) => `* ${x}`),
    d.note ? `> ${d.note.replace(/\n/g, '\n> ')}` : '',
    c.body ?? '', c.cta ? `${c.cta}: ${d.link || d.origin}` : '', '', ...signatureText(d.signature), '',
    `${sent ? 'Sent' : 'Changed'} by ${d.actor} · ${when}.`, 'Techzaz Networks — automated message from Techzaz EMS.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  return { subject: c.subject, html, text };
}
