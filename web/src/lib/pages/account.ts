import type { PageCtx } from '../app';
import { accountConsoleUrl, DEMO, logout } from '../auth';
import { avatar, fmt, html, ico, mount, raw, rel, stagger } from '../ui';

export default async function account({ api, me, main, ctx }: PageCtx) {
  const [u, perms, sessions] = await Promise.all([api.getUser(me.id), api.memberPermissions(me.id), api.mySessions()]);
  const effective = perms.filter((p) => p.effective);
  const cats = [...new Set(effective.map((p) => p.category))];

  mount(main, html`
    <div class="detail-head reveal">
      ${avatar(me.name, 'lg')}
      <div style="min-width:0"><h1 style="margin:0;font-size:30px">${me.name}</h1>
        <div class="muted">${me.email} · <span class="mono">@${me.username}</span></div>
        <div class="tags" style="margin-top:8px">${me.superAdmin ? html`<span class="tag dark">${ico('crown')}Super admin</span>` : ''}${me.groups.map((g) => html`<span class="tag">${g}</span>`)}</div>
      </div>
    </div>
    <div class="toolbar reveal" style="--i:1">
      <a class="btn" href="${accountConsoleUrl()}" ${DEMO ? '' : raw('target="_blank" rel="noopener"')}>${ico('lock')}Password & two-factor</a>
      <button class="btn ghost" id="out">${ico('logout')}Sign out</button>
    </div>
    ${DEMO ? html`<p class="muted reveal" style="--i:2;font-size:13px">In live mode, “Password & two-factor” opens the Keycloak account console, where you change your password, set up an authenticator app and review devices.</p>` : ''}

    <h2 class="section-mega" style="font-size:30px">Your access.</h2>
    <p class="lede">${me.superAdmin ? 'As a super administrator you hold every permission.' : html`You hold <b>${effective.length}</b> of ${perms.length} permissions. Where each one comes from is shown below.`}</p>
    ${cats.map((cat) => html`
      <div class="perm-cat reveal-item"><div class="perm-cat-head"><h4>${cat}</h4></div>
        ${effective.filter((p) => p.category === cat).map((p) => html`
          <div class="perm-row eff-on"><div><div class="pk">${p.key}</div><div class="pd">${p.description}</div></div>
            <span class="tag ${p.state === 'allow' ? 'ok' : ''}">${me.superAdmin ? 'Super admin' : p.state === 'allow' ? 'Granted to you' : `via ${p.fromGroups.join(', ')}`}</span></div>`)}
      </div>`)}
    ${perms.some((p) => p.state === 'deny') ? html`<p class="muted" style="font-size:13px">${ico('info', 'inline-ico')} Some permissions your groups grant have been switched off for you: ${perms.filter((p) => p.state === 'deny').map((p) => p.key).join(', ')}.</p>` : ''}

    <h2 class="section-mega" style="font-size:30px">Your sessions.</h2>
    ${sessions.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Application</th><th>IP address</th><th>Started</th><th>Last active</th></tr></thead><tbody>
      ${sessions.map((s) => html`<tr><td>${s.client}</td><td class="mono">${s.ip}</td><td>${fmt(s.start)}</td><td>${rel(s.lastAccess)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">${ico('activity')}No other active sessions.</div>`}`);
  stagger(main);
  main.querySelector('#out')?.addEventListener('click', () => logout());

  mount(ctx, html`
    <div class="ctx-card">
      <div class="ctx-label">Profile:</div>
      <div class="ctx-stat"><span>Department</span><b>${u.attributes.department || '—'}</b></div>
      <div class="ctx-stat"><span>Job title</span><b>${u.attributes.jobTitle || '—'}</b></div>
      <div class="ctx-stat"><span>Member since</span><b>${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</b></div>
      <div class="ctx-stat"><span>Last sign-in</span><b>${rel(u.lastLogin)}</b></div>
    </div>
    <div class="ctx-card">
      <div class="ctx-label">Something wrong?</div>
      <p style="margin:0;font-size:13px">Your profile and access are managed by your administrators. Contact <a href="mailto:soc@techzaz.lk" style="display:inline;color:var(--v-600)">soc@techzaz.lk</a>.</p>
    </div>`);
}
