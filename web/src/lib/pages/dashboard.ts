import type { PageCtx } from '../app';
import { EVENTS } from '../email';
import { html, ico, mount, rel, stagger } from '../ui';

const STACK = [
  ['shield', 'Keycloak'], ['key', 'OpenID Connect'], ['lock', 'PKCE'], ['code', 'Go'], ['sparkle', 'Astro'],
  ['database', 'PostgreSQL'], ['mail', 'Postfix'], ['check', 'OpenDKIM'], ['server', 'Docker'], ['activity', 'Audit trail'],
];

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
  ];

  const groupLines = (groups ?? []).map((g) => html`<span class="c-str">${g.name.padEnd(16)}</span><span class="c-com">${String(g.memberCount).padStart(3)} members  ${String(g.permissions.length).padStart(3)} perms</span>\n`);
  const accessLines = (audit?.items ?? []).filter((a) => /perm|group\.members|superadmin/.test(a.action)).slice(0, 5)
    .map((a) => html`<span class="c-num">${rel(a.at).padEnd(11)}</span> ${a.summary}\n`);
  const mailLines = (mail?.items ?? []).slice(0, 6).map((m) => html`<span class="${m.status === 'sent' ? 'c-kw' : m.status === 'failed' ? 'c-num' : 'c-str'}">${(m.status === 'sent' ? '✓ sent' : m.status === 'failed' ? '✗ fail' : '… queue').padEnd(8)}</span>${m.to}\n<span class="c-com">         ${m.subject}</span>\n`);

  mount(main, html`
    <h1 class="reveal">${greet}, ${first}.</h1>
    <p class="lede reveal" style="--i:1">You're signed in as <b>${me.username}</b>${me.superAdmin ? html` with <b>super administrator</b> rights` : html` with <b>${me.permissions.length}</b> permission${me.permissions.length === 1 ? '' : 's'}`}${me.groups.length ? html` through ${me.groups.join(', ')}` : ''}.</p>

    <div class="cards" id="glance">
      ${cards.map((c) => {
        const inner = html`${ico(c.i, 'card-ico')}<h4>${c.t}</h4><div class="big">${c.v}</div><div class="trend">${c.s}</div>`;
        return can(c.p) ? html`<a class="card reveal-item" href="${c.href}">${inner}</a>` : html`<div class="card reveal-item">${inner}</div>`;
      })}
    </div>

    <div class="marquee" aria-hidden="true"><div class="marquee-track">
      ${[...STACK, ...STACK].map(([i, t]) => html`<span>${ico(i, 'inline-ico')}${t}</span>`)}
    </div></div>

    <h2 class="section-mega" id="flow">Group it. Grant it.<br>Everyone's told.</h2>
    <p class="lede">Access in Techzaz EMS is plain to reason about: people sit in groups, groups carry permissions, and any member can be fine-tuned with a personal allow or deny. Whenever an admin changes something that affects a person, that person gets an email.</p>

    <div class="steps">
      <div class="step reveal-item">
        <div class="step-head"><span class="badge-num">1</span><div><h3>Group the people</h3><p>Teams map to groups: Administrators, Support, Staff…</p></div></div>
        <div class="codepanel"><div class="codepanel-head"><span>${ico('folder')}directory</span><span>${ico('file')}groups</span></div>
          <pre>${groups ? groupLines : html`<span class="c-com">// needs groups:view</span>`}</pre></div>
      </div>
      <div class="step reveal-item">
        <div class="step-head"><span class="badge-num">2</span><div><h3>Grant permissions</h3><p>Toggle per group, then override per member.</p></div></div>
        <div class="codepanel"><div class="codepanel-head"><span>${ico('shield')}access</span><span>${ico('file')}recent</span></div>
          <pre>${audit ? (accessLines.length ? accessLines : html`<span class="c-com">// no recent access changes</span>`) : html`<span class="c-com">// needs audit:view</span>`}</pre></div>
      </div>
      <div class="step reveal-item">
        <div class="step-head"><span class="badge-num">3</span><div><h3>Everyone is informed</h3><p>Affected users are emailed automatically.</p></div></div>
        <div class="codepanel"><div class="codepanel-head"><span>${ico('mail')}mail</span><span>${ico('file')}outbox.log</span></div>
          <pre>${mail ? (mailLines.length ? mailLines : html`<span class="c-com">// outbox is empty</span>`) : html`<span class="c-com">// needs mail:view</span>`}</pre></div>
      </div>
    </div>`);
  stagger(main);

  // live values in the hero windows
  const w1 = document.getElementById('w1out');
  const w2 = document.getElementById('w2out');
  const lastMail = mail?.items[0];
  if (w1 && lastMail) w1.textContent = `// → last: “${lastMail.subject}” · ${rel(lastMail.createdAt)}`;
  if (w2) w2.textContent = me.superAdmin ? '// → you hold every permission' : `// → you hold ${me.permissions.length} permission${me.permissions.length === 1 ? '' : 's'}`;

  const health = can('mail:view') ? await api.mailHealth().catch(() => null) : null;
  mount(ctx, html`
    <div class="ctx-card reveal" style="--i:2">
      <div class="ctx-label">On This Page:</div>
      <a href="#glance">At a glance</a>
      <a href="#flow">How access works</a>
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
