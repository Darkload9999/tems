// Notification email catalogue + renderer (table layout, inline styles, mail-client safe).
// The Go API renders the same design server-side; this copy powers previews and demo mode.
import type { NotifyEvent } from './types';
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
  'group.member_added':        { group: 'Access',      label: 'Added to a group',          desc: 'Includes the permissions the group grants' },
  'group.member_removed':      { group: 'Access',      label: 'Removed from a group',      desc: 'Includes the permissions that were lost' },
  'group.permissions_changed': { group: 'Access',      label: 'Group permissions changed', desc: 'Sent to every member of the group' },
  'group.renamed':             { group: 'Access',      label: 'Group renamed',             desc: 'Sent to every member of the group' },
  'group.deleted':             { group: 'Access',      label: 'Group deleted',             desc: 'Sent to every former member' },
  'member.permissions_changed':{ group: 'Access',      label: 'Personal permissions changed', desc: 'A member-level allow or deny was changed' },
  'mail.direct':               { group: 'Messages',    label: 'Direct messages',           desc: 'Messages composed by admins in the Mail section' },
};

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
  ${listRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1ecfd;border-radius:12px;margin:4px 0 18px"><tr><td style="padding:14px 18px"><table role="presentation" cellpadding="0" cellspacing="0">${listRows}</table></td></tr></table>` : ''}
  ${c.body ? `<p style="margin:0 0 14px">${esc(c.body)}</p>` : ''}
  ${c.cta ? `<p style="margin:22px 0 22px"><a href="${esc(d.origin)}" style="display:inline-block;background:#22094d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px">${esc(c.cta)} &rarr;</a></p>` : ''}
  <p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #ece7f6;font-size:12.5px;color:#6d6884">${ev === 'mail.direct' ? 'Sent' : 'Changed'} by ${esc(d.actor)} · ${esc(when)}.<br>If you did not expect this email, contact <a href="mailto:soc@techzaz.lk" style="color:#5b3fd6">soc@techzaz.lk</a>.</p>
</td></tr>
<tr><td style="padding:16px 30px 22px;font-size:11.5px;color:#9a95ad;line-height:1.6">Techzaz Networks · 476/2 Sri Rajasinghe Mawatha, Wattala 11104, Sri Lanka<br>This is an automated message from Techzaz EMS. Please do not reply.</td></tr>
</table></td></tr></table></body></html>`;

  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  const text = [
    `Hi ${d.firstName || d.username || 'there'},`, '',
    strip(c.lead), ev === 'mail.direct' ? (d.message ?? '') : '',
    ...(d.added ?? []).map((x) => `+ ${x}`), ...(d.removed ?? []).map((x) => `- ${x}`), ...(d.changes ?? []).map((x) => `* ${x}`),
    c.body ?? '', c.cta ? `${c.cta}: ${d.origin}` : '', '',
    `${ev === 'mail.direct' ? 'Sent' : 'Changed'} by ${d.actor} · ${when}.`, 'Techzaz Networks — automated message from Techzaz EMS.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  return { subject: c.subject, html, text };
}
