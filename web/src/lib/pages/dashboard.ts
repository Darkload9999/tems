import type { PageCtx } from '../app';
import { EVENTS } from '../email';
import { html, ico, mount, rel, stagger } from '../ui';
import { mailStatusTag } from './mail';

export default async function dashboard({ api, me, can, main, ctx }: PageCtx) {
  const [stats, mail, audit, groups] = await Promise.all([
    api.stats(),
    can('mail:view') ? api.listMail({ size: 6 }) : Promise.resolve(null),
    can('audit:view') ? api.listAudit({ size: 6 }) : Promise.resolve(null),
    can('groups:view') ? api.listGroups() : Promise.resolve(null),
  ]);

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (me.name || me.username).split(' ')[0];

  const cards = [
    { t: 'Users', v: stats.users, s: `${stats.activeUsers} active · ${stats.disabledUsers} disabled`, i: 'users', href: '/users/', p: 'users:view' },
    { t: 'Groups', v: stats.groups, s: 'Permission bundles for teams', i: 'group', href: '/groups/', p: 'groups:view' },
    { t: 'Permissions', v: stats.permissions, s: `${stats.customPermissions} custom in the catalog`, i: 'shield', href: '/permissions/', p: 'permissions:view' },
    { t: 'Mail sent · 24h', v: stats.mailSent24h, s: `${stats.mailQueued} queued right now`, i: 'send', href: '/mail/', p: 'mail:view' },
    { t: 'Failed deliveries', v: stats.mailFailed, s: stats.mailFailed ? 'Needs attention' : 'All clear', i: 'warn', href: '/mail/?status=failed', p: 'mail:view' },
    { t: 'Active sessions', v: stats.sessions, s: 'Signed-in browsers right now', i: 'activity', href: '/users/', p: 'users:sessions' },
    { t: 'Super admins', v: stats.superAdmins, s: 'Unrestricted access holders', i: 'crown', href: '/settings/#super-admins', p: 'settings:manage' },
    { t: 'Employees', v: stats.employees, s: `${stats.onboarding} onboarding right now`, i: 'briefcase', href: '/employees/', p: 'employees:view', own: true },
    { t: 'Awaiting approval', v: stats.pendingApproval, s: stats.pendingApproval ? 'Onboardings to review' : 'Nothing to review', i: 'shield', href: '/employees/?stage=approval', p: 'employees:view', own: true },
    { t: 'Active projects', v: stats.activeProjects, s: 'Planning, active or on hold', i: 'layers', href: '/projects/', p: 'projects:view', own: true },
    { t: 'Open tickets', v: stats.openTickets, s: 'Open, in progress or in review', i: 'inbox', href: '/tickets/', p: 'tickets:view', own: true },
  ];

  const recentAudit = (audit?.items ?? []).slice(0, 6);
  const recentMail = (mail?.items ?? []).slice(0, 6);

  mount(main, html`
    <div class="welcome reveal">
      <div>
        <h2>${greet}, ${first}</h2>
        <p>You're signed in as <b>${me.username}</b>${me.superAdmin ? html` with <b>super administrator</b> rights` : html` with <b>${me.permissions.length}</b> permission${me.permissions.length === 1 ? '' : 's'}`}${me.groups.length ? html` through ${me.groups.join(', ')}` : ''}.</p>
      </div>
      <div class="welcome-actions">
        ${can('users:create') ? html`<a class="btn soft sm" href="/users/?new=1">${ico('userPlus')}New user</a>` : ''}
        ${can('mail:send') ? html`<a class="btn sm" href="/mail/compose/">${ico('send')}Compose</a>` : ''}
      </div>
    </div>

    <div class="cards" id="glance">
      ${cards.filter((c) => !('own' in c) || can(c.p)).map((c) => {
        const inner = html`${ico(c.i, 'card-ico')}<h4>${c.t}</h4><div class="big">${c.v}</div><div class="trend">${c.s}</div>`;
        return can(c.p) ? html`<a class="card reveal-item" href="${c.href}">${inner}</a>` : html`<div class="card reveal-item">${inner}</div>`;
      })}
    </div>

    <div class="dash-grid" id="activity">
      ${audit ? html`<section class="panel reveal-item">
        <div class="panel-head"><h3>Recent activity</h3><a class="btn ghost sm" href="/audit/">View all</a></div>
        ${recentAudit.length ? html`<ul class="feed">${recentAudit.map((a) => html`
          <li><span class="feed-ico">${ico('history')}</span><div><div>${a.summary}</div><span class="muted">${a.actor} · ${rel(a.at)}</span></div></li>`)}</ul>`
          : html`<div class="empty">${ico('history')}No activity yet.</div>`}
      </section>` : ''}
      ${mail ? html`<section class="panel reveal-item">
        <div class="panel-head"><h3>Latest emails</h3><a class="btn ghost sm" href="/mail/">Outbox</a></div>
        ${recentMail.length ? html`<ul class="feed">${recentMail.map((m) => html`
          <li><span class="feed-ico">${ico('mail')}</span><div style="min-width:0;flex:1"><div class="ellipsis">${m.subject}</div><span class="muted">${m.toName} · ${EVENTS[m.event]?.label ?? m.event} · ${rel(m.createdAt)}</span></div>${mailStatusTag(m)}</li>`)}</ul>`
          : html`<div class="empty">${ico('inbox')}The outbox is empty.</div>`}
      </section>` : ''}
      ${groups ? html`<section class="panel reveal-item">
        <div class="panel-head"><h3>Groups</h3><a class="btn ghost sm" href="/groups/">Manage</a></div>
        <ul class="feed">${groups.slice(0, 6).map((g) => html`
          <li><span class="feed-ico">${ico('group')}</span><div style="flex:1"><div>${g.name}</div><span class="muted">${g.description || 'No description'}</span></div><span class="tag">${g.memberCount} member${g.memberCount === 1 ? '' : 's'}</span></li>`)}</ul>
      </section>` : ''}
    </div>`);
  stagger(main);

  const health = can('mail:view') ? await api.mailHealth().catch(() => null) : null;
  mount(ctx, html`
    <div class="ctx-card reveal" style="--i:2">
      <div class="ctx-label">On This Page:</div>
      <a href="#glance">At a glance</a>
      <a href="#activity">Recent activity</a>
    </div>
    <div class="ctx-card reveal" style="--i:3">
      <div class="ctx-label">Quick actions:</div>
      ${can('users:create') ? html`<a href="/users/?new=1">New user</a>` : ''}
      ${can('groups:create') ? html`<a href="/groups/?new=1">New group</a>` : ''}
      ${can('mail:send') ? html`<a href="/mail/compose/">Compose a message</a>` : ''}
      <a href="/account/">My account</a>
    </div>
    ${health ? html`
    <div class="ctx-card reveal" style="--i:4">
      <div class="ctx-label">Mail server:</div>
      <div class="ctx-stat"><span>Status</span><b style="color:${health.ok ? 'var(--ok)' : 'var(--err)'}">${health.ok ? 'Online' : 'Down'}</b></div>
      <div class="ctx-stat"><span>DKIM signing</span><b>${health.dkim ? 'On' : 'Off'}</b></div>
      <div class="ctx-stat"><span>Queue</span><b>${health.queue}</b></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${health.host}</div>
    </div>` : ''}
    ${mail?.items.length ? html`
    <div class="ctx-card reveal" style="--i:5">
      <div class="ctx-label">Latest notification:</div>
      <b style="display:block;color:var(--ink)">${EVENTS[mail.items[0].event]?.label}</b>
      <span class="muted" style="font-size:12.5px">${mail.items[0].toName} · ${rel(mail.items[0].createdAt)}</span>
    </div>` : ''}`);
}
