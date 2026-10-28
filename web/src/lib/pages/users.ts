import type { PageCtx } from '../app';
import type { Group, Session, User } from '../types';
import { memberPermEditor } from '../permEditor';
import { DEFAULT_MAILBOX, renderEmail } from '../email';
import {
  $, avatar, confirmDanger, copy, debounce, fmt, formData, fullName, html, ico, modal, mount, on, rel, requireFields, stagger, toast,
} from '../ui';

const SIZE = 10;

export function genPassword(len = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = sets.map(pick);
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export function statusTags(u: User) {
  const pending = u.requiredActions.includes('UPDATE_PASSWORD') && !u.lastLogin;
  return html`
    ${u.superAdmin ? html`<span class="tag dark">${ico('crown')}Super admin</span>` : ''}
    ${!u.enabled ? html`<span class="tag err"><span class="dot"></span>Disabled</span>`
      : pending ? html`<span class="tag warn"><span class="dot"></span>Pending setup</span>`
      : html`<span class="tag ok"><span class="dot"></span>Active</span>`}`;
}

export default async function users(c: PageCtx) {
  const { api, me, can, main, ctx, cleanup, refreshShell } = c;
  const url = new URL(location.href);
  const st = {
    search: url.searchParams.get('q') ?? '',
    status: (url.searchParams.get('status') ?? 'all') as 'all' | 'active' | 'disabled',
    group: url.searchParams.get('group') ?? '',
    page: Number(url.searchParams.get('page') ?? 1) || 1,
  };
  let groups: Group[] = await api.listGroups();
  const gname = (id: string) => groups.find((g) => g.id === id)?.name ?? '—';

  mount(main, html`
    <div class="toolbar reveal">
      <label class="search">${ico('search')}<span class="sr-only">Search users</span>
        <input class="input" id="q" type="search" placeholder="Search name, email, department…" value="${st.search}"></label>
      <select class="select" id="fStatus" style="width:auto">
        <option value="all">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option>
      </select>
      <select class="select" id="fGroup" style="width:auto">
        <option value="">All groups</option>${groups.map((g) => html`<option value="${g.id}">${g.name}</option>`)}
      </select>
      <span class="spacer"></span>
      ${can('reports:export') ? html`<button class="btn ghost" id="export">${ico('file')}Export CSV</button>` : ''}
      ${can('users:create') ? html`<button class="btn" id="newUser">${ico('userPlus')}New user</button>` : ''}
    </div>
    <div class="tbl-wrap reveal" style="--i:1">
      <table class="tbl">
        <thead><tr><th>Person</th><th>Username</th><th>Groups</th><th>Status</th><th>Last sign-in</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="pager" id="pager"></div>`);
  $<HTMLSelectElement>('#fStatus', main)!.value = st.status;
  $<HTMLSelectElement>('#fGroup', main)!.value = st.group;

  const syncUrl = () => {
    const u = new URL(location.href);
    for (const [k, v] of [['q', st.search], ['status', st.status === 'all' ? '' : st.status], ['group', st.group], ['page', st.page > 1 ? String(st.page) : '']])
      v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
    history.replaceState(history.state, '', u);
  };

  let lastItems: User[] = [];
  async function load() {
    const tbody = $('#rows', main)!;
    tbody.style.opacity = '.55';
    const res = await api.listUsers({ search: st.search, status: st.status, group: st.group || undefined, page: st.page, size: SIZE });
    lastItems = res.items;
    tbody.style.opacity = '';
    if (!res.items.length) {
      mount(tbody, html`<tr><td colspan="6"><div class="empty">${ico('users')}No users match these filters.</div></td></tr>`);
    } else {
      mount(tbody, html`${res.items.map((u) => html`
        <tr class="clickable reveal-item" data-id="${u.id}" tabindex="0">
          <td><div class="person">${avatar(fullName(u))}<div class="meta"><b>${fullName(u)}</b><span>${u.email}</span></div></div></td>
          <td class="mono">${u.username}</td>
          <td><div class="tags">${u.groups.slice(0, 3).map((g) => html`<span class="tag">${gname(g)}</span>`)}${u.groups.length > 3 ? html`<span class="tag">+${u.groups.length - 3}</span>` : ''}${!u.groups.length ? html`<span class="muted">—</span>` : ''}</div></td>
          <td><div class="tags">${statusTags(u)}</div></td>
          <td class="muted" title="${fmt(u.lastLogin)}">${rel(u.lastLogin)}</td>
          <td class="actions">
            ${can('users:edit') ? html`<button class="btn ghost icon" data-act="edit" title="Edit" aria-label="Edit ${fullName(u)}">${ico('edit')}</button>` : ''}
            ${can('users:delete') && u.id !== me.id ? html`<button class="btn ghost icon" data-act="delete" title="Delete" aria-label="Delete ${fullName(u)}">${ico('trash')}</button>` : ''}
          </td>
        </tr>`)}`);
      stagger(tbody);
    }
    const pages = Math.max(1, Math.ceil(res.total / SIZE));
    mount($('#pager', main), html`
      <span>${res.total} user${res.total === 1 ? '' : 's'}${st.search || st.status !== 'all' || st.group ? ' match' : ' in total'}</span>
      <span style="display:flex;align-items:center;gap:8px">
        <button class="btn ghost sm" data-go="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${st.page} of ${pages}</span>
        <button class="btn ghost sm" data-go="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>Next</button>
      </span>`);
    syncUrl();
    drawContext(res.total);
  }

  async function drawContext(total: number) {
    if (!ctx) return;
    const s = can('dashboard:view') ? await api.stats().catch(() => null) : null;
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">Directory:</div>
        ${s ? html`
          <div class="ctx-stat"><span>All users</span><b>${s.users}</b></div>
          <div class="ctx-stat"><span>Active</span><b>${s.activeUsers}</b></div>
          <div class="ctx-stat"><span>Disabled</span><b>${s.disabledUsers}</b></div>
          <div class="ctx-stat"><span>Super admins</span><b>${s.superAdmins}</b></div>` : html`<div class="ctx-stat"><span>Showing</span><b>${total}</b></div>`}
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Good to know:</div>
        <p style="margin:0">Click a person to manage their groups, personal permissions and sessions. Every change you make emails the person it affects.</p>
      </div>
      ${can('groups:view') ? html`<div class="ctx-card"><div class="ctx-label">Groups:</div>${groups.map((g) => html`<a href="/groups/?g=${g.id}">${g.name} <span class="muted">· ${g.memberCount}</span></a>`)}</div>` : ''}`);
  }

  /* ---------- toolbar ---------- */
  $('#q', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); st.page = 1; void load(); }));
  $('#fStatus', main)!.addEventListener('change', (e) => { st.status = (e.target as HTMLSelectElement).value as typeof st.status; st.page = 1; void load(); });
  $('#fGroup', main)!.addEventListener('change', (e) => { st.group = (e.target as HTMLSelectElement).value; st.page = 1; void load(); });
  on(main, 'click', '[data-go]', (_e, b) => { st.page = Number(b.dataset.go); void load(); main.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#newUser', main)?.addEventListener('click', () => createUser());
  $('#export', main)?.addEventListener('click', () => exportCsv());

  on(main, 'click', 'tr[data-id]', (e, tr) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const u = lastItems.find((x) => x.id === tr.dataset.id)!;
    if (act === 'edit') return editUser(u);
    if (act === 'delete') return deleteUser(u);
    openUser(u.id);
  });
  on(main, 'keydown', 'tr[data-id]', (e, tr) => { if ((e as KeyboardEvent).key === 'Enter') openUser(tr.dataset.id!); });

  const changed = async () => { await load(); refreshShell(); };

  /* ---------- create (3-step wizard) ---------- */
  function createUser() {
    let step = 1;
    const canGroups = can('groups:members');
    const m = modal({
      title: 'New user', sub: 'They will be emailed a welcome message as soon as the account exists.', wide: true,
      body: html`
        <div class="wizard">
          <div class="ws on" data-s="1"><span class="badge-num">1</span>Identity</div><div class="bar"></div>
          <div class="ws" data-s="2"><span class="badge-num">2</span>Groups</div><div class="bar"></div>
          <div class="ws" data-s="3"><span class="badge-num">3</span>Access setup</div>
        </div>
        <form autocomplete="off">
          <div data-pane="1">
            <div class="grid-2">
              <div class="field"><label for="n-first">First name</label><input class="input" id="n-first" name="firstName" autofocus></div>
              <div class="field"><label for="n-last">Last name</label><input class="input" id="n-last" name="lastName"></div>
              <div class="field"><label for="n-user">Username</label><input class="input mono" id="n-user" name="username" placeholder="firstname.lastname"><span class="hint">Lowercase letters, digits, dots, dashes. Can't be changed later.</span></div>
              <div class="field"><label for="n-email">Email</label><input class="input" id="n-email" name="email" type="email" placeholder="name@techzaz.lk"></div>
              <div class="field"><label for="n-dept">Department</label><input class="input" id="n-dept" name="department"></div>
              <div class="field"><label for="n-title">Job title</label><input class="input" id="n-title" name="jobTitle"></div>
              <div class="field"><label for="n-phone">Phone</label><input class="input" id="n-phone" name="phone" placeholder="+94 7X XXX XXXX"></div>
              ${me.superAdmin ? html`<div class="field"><label for="n-personal">Personal email</label><input class="input" id="n-personal" name="personalEmail" type="email" placeholder="name@gmail.com"><span class="hint">Optional. Receives the Outlook setup for the work email.</span></div>` : ''}
            </div>
          </div>
          <div data-pane="2" hidden>
            <p class="muted" style="margin-top:0">${canGroups ? 'Members get every permission their groups grant. You can fine-tune individual permissions afterwards.' : 'You need groups:members to place people in groups. They can be added later.'}</p>
            <div class="checklist">${groups.map((g) => html`
              <label class="check-row"><input type="checkbox" name="g:${g.id}" ${!canGroups ? 'disabled' : ''}>
                <span class="person"><span class="meta"><b>${g.name}</b><span>${g.description} · ${g.permissions.length} permissions</span></span></span></label>`)}</div>
          </div>
          <div data-pane="3" hidden>
            <label class="choice"><input type="radio" name="setup" value="link" checked><span><b>Email a secure setup link</b><span>Recommended. They choose their own password; the link expires in 12 hours.</span></span></label>
            <label class="choice"><input type="radio" name="setup" value="temporary"><span><b>Set a temporary password</b><span>You share it with them. They must change it on first sign-in.</span></span></label>
            <div class="field" id="tempWrap" style="margin-top:12px" hidden>
              <label for="n-temp">Temporary password</label>
              <div style="display:flex;gap:8px"><input class="input mono" id="n-temp" name="temp" value="${genPassword()}">
                <button type="button" class="btn ghost icon" id="regen" title="Generate">${ico('refresh')}</button>
                <button type="button" class="btn ghost icon" id="copyTemp" title="Copy">${ico('copy')}</button></div>
            </div>
            <label class="choice" style="margin-top:12px"><input type="checkbox" name="enabled" checked><span><b>Account enabled</b><span>Untick to create the account in a disabled state.</span></span></label>
          </div>
        </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Back', kind: 'soft', id: 'w-back', onClick: () => { step = Math.max(1, step - 1); sync(); return false; } },
        { label: 'Next', id: 'w-next', icon: 'arrow', onClick: ({ body }) => {
          if (step === 1) { requireFields(body, ['firstName', 'username', 'email']); step = 2; sync(); return false; }
          if (step === 2) { step = 3; sync(); return false; }
          return (async () => {
          const f = formData(body);
          const u = await api.createUser({
            username: f.username, email: f.email, firstName: f.firstName, lastName: f.lastName, enabled: f.enabled === 'on',
            attributes: { department: f.department, jobTitle: f.jobTitle, phone: f.phone },
            groups: groups.filter((g) => f[`g:${g.id}`] === 'on').map((g) => g.id),
            setup: f.setup as 'link' | 'temporary', temporaryPassword: f.setup === 'temporary' ? f.temp : undefined,
          });
          toast(`Created ${u.username}`, f.setup === 'link' ? 'A password setup link is on its way to them.' : 'Share the temporary password with them securely.');
          if (me.superAdmin && f.personalEmail) {
            try { await api.mailboxSetup(u.id, { personalEmail: f.personalEmail, send: true }); toast('Outlook setup sent', f.personalEmail, 'mail'); }
            catch (err) { toast('Outlook setup not sent', (err as Error).message, 'err'); }
          }
          await changed();
          openUser(u.id);
          })();
        } },
      ],
    });
    const b = m.body;
    const sync = () => {
      b.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== String(step)));
      b.querySelectorAll<HTMLElement>('.ws').forEach((w) => {
        const s = Number(w.dataset.s);
        w.classList.toggle('on', s === step); w.classList.toggle('done', s < step);
        w.querySelector('.badge-num')!.innerHTML = s < step ? ico('check').v : String(s);
      });
      const back = m.root.querySelector<HTMLElement>('#w-back')!;
      back.style.visibility = step === 1 ? 'hidden' : 'visible';
      m.root.querySelector('#w-next span')!.textContent = step === 3 ? 'Create user' : 'Next';
      b.querySelector<HTMLElement>(`[data-pane="${step}"] input`)?.focus();
    };
    sync();
    // derive username from the name
    const user = b.querySelector<HTMLInputElement>('[name=username]')!;
    let touched = false;
    user.addEventListener('input', () => (touched = true));
    b.querySelectorAll<HTMLInputElement>('[name=firstName],[name=lastName]').forEach((i) => i.addEventListener('input', () => {
      if (touched) return;
      const f = formData(b);
      user.value = [f.firstName, f.lastName].filter(Boolean).join('.').toLowerCase().normalize('NFD').replace(/[^a-z0-9.]/g, '');
    }));
    b.querySelectorAll<HTMLInputElement>('[name=setup]').forEach((r) => r.addEventListener('change', () => ($('#tempWrap', b)!.hidden = formData(b).setup !== 'temporary')));
    $('#regen', b)!.addEventListener('click', () => ($<HTMLInputElement>('#n-temp', b)!.value = genPassword()));
    $('#copyTemp', b)!.addEventListener('click', () => copy($<HTMLInputElement>('#n-temp', b)!.value));
  }

  /* ---------- edit ---------- */
  function editUser(u: User, after?: () => void) {
    modal({
      title: 'Edit user', sub: `@${u.username} · they'll be emailed a summary of what changed.`,
      body: html`<form autocomplete="off"><div class="grid-2">
        <div class="field"><label for="e-first">First name</label><input class="input" id="e-first" name="firstName" value="${u.firstName}" autofocus></div>
        <div class="field"><label for="e-last">Last name</label><input class="input" id="e-last" name="lastName" value="${u.lastName}"></div>
        <div class="field" style="grid-column:1/-1"><label for="e-email">Email</label><input class="input" id="e-email" name="email" type="email" value="${u.email}"></div>
        <div class="field"><label for="e-dept">Department</label><input class="input" id="e-dept" name="department" value="${u.attributes.department ?? ''}"></div>
        <div class="field"><label for="e-title">Job title</label><input class="input" id="e-title" name="jobTitle" value="${u.attributes.jobTitle ?? ''}"></div>
        <div class="field"><label for="e-phone">Phone</label><input class="input" id="e-phone" name="phone" value="${u.attributes.phone ?? ''}"></div>
      </div></form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save changes', icon: 'check', onClick: async ({ body }) => {
          requireFields(body, ['firstName', 'email']);
          const f = formData(body);
          await api.updateUser(u.id, { firstName: f.firstName, lastName: f.lastName, email: f.email, attributes: { department: f.department, jobTitle: f.jobTitle, phone: f.phone } });
          toast('Profile saved', fullName({ firstName: f.firstName, lastName: f.lastName }));
          await changed(); after?.();
        } },
      ],
    });
  }

  /* ---------- personal email + Outlook setup (super admins) ---------- */
  async function mailboxSetup(u: User, after?: () => void) {
    const mailbox = (await api.getSettings().catch(() => null))?.mailbox ?? DEFAULT_MAILBOX;
    const m = modal({
      title: 'Outlook setup', sub: `Send ${fullName(u)} the settings for ${u.email} at their personal address.`, wide: true,
      body: html`<form autocomplete="off">
        <div class="grid-2">
          <div class="field"><label for="mb-personal">Personal email</label><input class="input" id="mb-personal" name="personalEmail" type="email" placeholder="name@gmail.com" value="${u.attributes.personalEmail ?? ''}" autofocus>
            <span class="hint">Gmail, Outlook.com or any address they read today.</span></div>
          <div class="field"><label>Work email</label><input class="input" value="${u.email}" disabled></div>
          <div class="field" style="grid-column:1/-1"><label for="mb-note">Note <span class="muted" style="font-weight:400">(optional)</span></label><textarea class="textarea" id="mb-note" name="note" style="min-height:70px" placeholder="e.g. Your mailbox password will be shared by IT on your first day."></textarea></div>
        </div>
        <div class="field" style="margin:0"><label>Preview</label><iframe class="mail-frame" id="mbPrev" title="Email preview" sandbox="allow-same-origin" style="height:440px"></iframe></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save address only', kind: 'soft', onClick: async ({ body }) => {
          const f = formData(body);
          await api.mailboxSetup(u.id, { personalEmail: f.personalEmail, send: false });
          toast('Personal email saved', f.personalEmail || 'Removed'); await changed(); after?.();
        } },
        { label: 'Send setup email', icon: 'send', onClick: async ({ body }) => {
          requireFields(body, ['personalEmail']);
          const f = formData(body);
          await api.mailboxSetup(u.id, { personalEmail: f.personalEmail, note: f.note, send: true });
          toast('Outlook setup sent', f.personalEmail, 'mail'); await changed(); after?.();
        } },
      ],
    });
    const draw = () => {
      const f = formData(m.body);
      $<HTMLIFrameElement>('#mbPrev', m.body)!.srcdoc = renderEmail('mailbox.setup', {
        origin: location.origin, firstName: u.firstName, username: u.username, actor: me.name, workEmail: u.email, mailbox, note: f.note,
      }).html;
    };
    m.body.querySelectorAll('input,textarea').forEach((i) => i.addEventListener('input', debounce(draw, 180)));
    draw();
  }

  /* ---------- delete ---------- */
  function deleteUser(u: User, after?: () => void) {
    confirmDanger({
      title: 'Delete user',
      message: html`This permanently removes <b>${fullName(u)}</b> (${u.email}), their sessions and personal permissions. They'll get a final email letting them know.`,
      confirm: 'Delete user', typeToConfirm: u.username,
      onConfirm: async () => { await api.deleteUser(u.id); toast(`Deleted ${u.username}`); await changed(); after?.(); },
    });
  }

  /* ---------- reset password ---------- */
  function resetPassword(u: User, after?: () => void) {
    const m = modal({
      title: 'Reset password', sub: `${fullName(u)} will be told by email.`,
      body: html`<form>
        <label class="choice"><input type="radio" name="mode" value="link" checked><span><b>Email a reset link</b><span>They choose a new password themselves.</span></span></label>
        <label class="choice"><input type="radio" name="mode" value="temporary"><span><b>Set a temporary password</b><span>They must change it at their next sign-in.</span></span></label>
        <div class="field" id="rpWrap" style="margin-top:12px" hidden><label for="rp">Temporary password</label>
          <div style="display:flex;gap:8px"><input class="input mono" id="rp" name="temp" value="${genPassword()}">
          <button type="button" class="btn ghost icon" id="rpGen" title="Generate">${ico('refresh')}</button>
          <button type="button" class="btn ghost icon" id="rpCopy" title="Copy">${ico('copy')}</button></div></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Reset password', icon: 'key', onClick: async ({ body }) => {
          const f = formData(body);
          await api.resetPassword(u.id, f.mode as 'link' | 'temporary', f.temp);
          toast('Password reset', f.mode === 'link' ? `A reset link was emailed to ${u.email}.` : 'Share the temporary password securely.');
          await changed(); after?.();
        } },
      ],
    });
    m.body.querySelectorAll('[name=mode]').forEach((r) => r.addEventListener('change', () => ($('#rpWrap', m.body)!.hidden = formData(m.body).mode !== 'temporary')));
    $('#rpGen', m.body)!.addEventListener('click', () => ($<HTMLInputElement>('#rp', m.body)!.value = genPassword()));
    $('#rpCopy', m.body)!.addEventListener('click', () => copy($<HTMLInputElement>('#rp', m.body)!.value));
  }

  /* ---------- detail ---------- */
  async function openUser(id: string, tab = 'profile') {
    let u = await api.getUser(id);
    const m = modal({ title: fullName(u), sub: `${u.email} · @${u.username}`, wide: true, body: html`<div id="ud"></div>`, actions: [{ label: 'Done', kind: 'ghost' }] });
    const qp = new URL(location.href); qp.searchParams.set('user', id); history.replaceState(history.state, '', qp);
    const closeUrl = () => { const x = new URL(location.href); x.searchParams.delete('user'); history.replaceState(history.state, '', x); };
    m.root.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-close], .modal-foot .btn')) closeUrl(); });
    const host = m.body.querySelector<HTMLElement>('#ud')!;
    let editor: { destroy: () => void } | null = null;

    const refresh = async () => { u = await api.getUser(id); groups = await api.listGroups(); frame(); void load(); refreshShell(); };
    const done = () => { m.close(); closeUrl(); };

    const frame = () => {
      editor?.destroy(); editor = null;
      const isSelf = u.id === me.id;
      mount(host, html`
        <div class="detail-head">
          ${avatar(fullName(u), 'lg')}
          <div style="min-width:0"><h3>${fullName(u)}</h3>
            <div class="tags" style="margin-top:4px">${statusTags(u)}${u.attributes.jobTitle ? html`<span class="tag">${u.attributes.jobTitle}</span>` : ''}</div></div>
          <div style="margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
            ${can('users:edit') ? html`<button class="btn soft sm" data-a="edit">${ico('edit')}Edit</button>` : ''}
            ${can('users:reset-password') ? html`<button class="btn soft sm" data-a="reset">${ico('key')}Reset password</button>` : ''}
            ${me.superAdmin ? html`<button class="btn soft sm" data-a="mailbox">${ico('mail')}Outlook setup</button>` : ''}
            ${can('users:edit') && !isSelf ? html`<button class="btn soft sm" data-a="toggle">${ico(u.enabled ? 'ban' : 'power')}${u.enabled ? 'Disable' : 'Enable'}</button>` : ''}
            ${can('users:delete') && !isSelf ? html`<button class="btn danger sm" data-a="delete">${ico('trash')}Delete</button>` : ''}
          </div>
        </div>
        <div class="tabs" role="tablist">
          ${[['profile', 'Profile'], ['groups', `Groups · ${u.groups.length}`], ['permissions', 'Permissions'], ['sessions', 'Sessions']].map(([k, l]) =>
            html`<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${l}</button>`)}
        </div>
        <div id="tb"></div>`);
      void drawTab();
    };

    const drawTab = async () => {
      const tb = host.querySelector<HTMLElement>('#tb')!;
      editor?.destroy(); editor = null;
      if (tab === 'profile') {
        mount(tb, html`
          <dl class="kv reveal">
            <dt>Username</dt><dd class="mono">${u.username}</dd>
            <dt>Email</dt><dd>${u.email} ${u.emailVerified ? html`<span class="tag ok">Verified</span>` : html`<span class="tag warn">Unverified</span>`}</dd>
            <dt>Department</dt><dd>${u.attributes.department || '—'}</dd>
            <dt>Job title</dt><dd>${u.attributes.jobTitle || '—'}</dd>
            <dt>Phone</dt><dd>${u.attributes.phone || '—'}</dd>
            <dt>Personal email</dt><dd>${u.attributes.personalEmail || html`<span class="muted">—</span>`}
              ${me.superAdmin ? html` <button class="btn ghost sm" data-a="mailbox" style="margin-left:6px">${ico('send')}${u.attributes.personalEmail ? 'Send Outlook setup' : 'Add'}</button>` : ''}</dd>
            <dt>Created</dt><dd>${fmt(u.createdAt)}</dd>
            <dt>Last sign-in</dt><dd>${u.lastLogin ? html`${fmt(u.lastLogin)} <span class="muted">(${rel(u.lastLogin)})</span>` : 'Never'}</dd>
            <dt>Pending actions</dt><dd>${u.requiredActions.length ? u.requiredActions.map((a) => html`<span class="tag warn" style="margin-right:4px">${a.replace(/_/g, ' ').toLowerCase()}</span>`) : '—'}</dd>
            <dt>User ID</dt><dd><button class="btn ghost sm mono" data-a="copyId">${u.id} ${ico('copy', 'inline-ico')}</button></dd>
          </dl>
          ${me.superAdmin ? html`
            <div class="perm-row" style="margin-top:20px">
              <div><div class="pk">${ico('crown', 'inline-ico')} Super administrator</div><div class="pd">Unrestricted access to everything in Techzaz EMS, including other super admins.</div></div>
              <label class="switch"><input type="checkbox" id="superSw" ${u.superAdmin ? 'checked' : ''} ${u.id === me.id ? 'disabled' : ''} aria-label="Super administrator"><span class="track"></span></label>
            </div>` : ''}`);
        $('#superSw', tb)?.addEventListener('change', async (e) => {
          const el = e.target as HTMLInputElement;
          try { await api.setSuperAdmin(u.id, el.checked); toast(el.checked ? 'Super admin granted' : 'Super admin revoked', fullName(u)); await refresh(); }
          catch (err) { el.checked = !el.checked; toast('Not changed', (err as Error).message, 'err'); }
        });
      } else if (tab === 'groups') {
        const mine = groups.filter((g) => u.groups.includes(g.id));
        const others = groups.filter((g) => !u.groups.includes(g.id));
        const canM = can('groups:members');
        mount(tb, html`
          ${canM && others.length ? html`<div class="toolbar">
            <select class="select" id="addG" style="max-width:320px">${others.map((g) => html`<option value="${g.id}">${g.name} · ${g.permissions.length} permissions</option>`)}</select>
            <button class="btn" id="addGBtn">${ico('plus')}Add to group</button></div>` : ''}
          ${mine.length ? mine.map((g, i) => html`
            <div class="perm-row reveal" style="--i:${i}">
              <div><div style="font-weight:700">${g.name}</div><div class="pd">${g.description || 'No description'} · ${g.permissions.length} permissions</div></div>
              <div style="display:flex;gap:6px">
                ${can('groups:view') ? html`<a class="btn ghost sm" href="/groups/?g=${g.id}">Open</a>` : ''}
                ${canM ? html`<button class="btn ghost sm" data-rm="${g.id}">${ico('userMinus')}Remove</button>` : ''}
              </div>
            </div>`) : html`<div class="empty">${ico('group')}Not a member of any group yet.</div>`}`);
        $('#addGBtn', tb)?.addEventListener('click', async (e) => {
          const gid = $<HTMLSelectElement>('#addG', tb)!.value;
          const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
          try { await api.addMembers(gid, [u.id]); toast(`Added to ${gname(gid)}`, fullName(u)); await refresh(); }
          catch (err) { btn.disabled = false; toast('Not added', (err as Error).message, 'err'); }
        });
        on(tb, 'click', '[data-rm]', async (_e, b) => {
          b.setAttribute('disabled', '');
          try { await api.removeMember(b.dataset.rm!, u.id); toast(`Removed from ${gname(b.dataset.rm!)}`, fullName(u)); await refresh(); }
          catch (err) { b.removeAttribute('disabled'); toast('Not removed', (err as Error).message, 'err'); }
        });
      } else if (tab === 'permissions') {
        mount(tb, html`<label class="search" style="max-width:none;margin-bottom:14px">${ico('search')}<input class="input" id="pf" type="search" placeholder="Filter permissions…"></label><div id="pe"></div>`);
        editor = await memberPermEditor(tb.querySelector<HTMLElement>('#pe')!, c, u, { onChange: () => void load() });
        const ed = editor as Awaited<ReturnType<typeof memberPermEditor>>;
        $('#pf', tb)!.addEventListener('input', (e) => ed.setFilter((e.target as HTMLInputElement).value));
      } else if (tab === 'sessions') {
        let sessions: Session[] = [];
        try { sessions = await api.sessions(u.id); } catch (err) { mount(tb, html`<div class="empty">${ico('lock')}${(err as Error).message}</div>`); return; }
        mount(tb, html`
          <div class="toolbar"><span class="muted">${sessions.length} active session${sessions.length === 1 ? '' : 's'}</span><span class="spacer"></span>
            ${can('users:sessions') && sessions.length ? html`<button class="btn danger sm" id="revoke">${ico('logout')}Sign out everywhere</button>` : ''}</div>
          ${sessions.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Application</th><th>IP address</th><th>Started</th><th>Last active</th></tr></thead><tbody>
            ${sessions.map((s) => html`<tr><td>${s.client}</td><td class="mono">${s.ip}</td><td>${fmt(s.start)}</td><td>${rel(s.lastAccess)}</td></tr>`)}
          </tbody></table></div>` : html`<div class="empty">${ico('activity')}No active sessions.</div>`}`);
        $('#revoke', tb)?.addEventListener('click', async (e) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          try { await api.revokeSessions(u.id); toast('Signed out everywhere', fullName(u)); await refresh(); }
          catch (err) { toast('Not signed out', (err as Error).message, 'err'); }
        });
      }
    };

    on(host, 'click', '[data-tab]', (_e, b) => {
      tab = b.dataset.tab!;
      host.querySelectorAll('[data-tab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
      void drawTab();
    });
    on(host, 'click', '[data-a]', async (_e, b) => {
      const a = b.dataset.a;
      if (a === 'edit') editUser(u, refresh);
      if (a === 'reset') resetPassword(u, refresh);
      if (a === 'mailbox') void mailboxSetup(u, refresh);
      if (a === 'delete') deleteUser(u, done);
      if (a === 'copyId') copy(u.id);
      if (a === 'toggle') {
        if (u.enabled) {
          confirmDanger({
            title: 'Disable user', confirm: 'Disable account',
            message: html`<b>${fullName(u)}</b> will be signed out and unable to sign in until re-enabled. They'll be told by email.`,
            onConfirm: async () => { await api.updateUser(u.id, { enabled: false }); toast(`Disabled ${u.username}`); await refresh(); },
          });
        } else {
          b.setAttribute('disabled', '');
          try { await api.updateUser(u.id, { enabled: true }); toast(`Enabled ${u.username}`); await refresh(); }
          catch (err) { b.removeAttribute('disabled'); toast('Not enabled', (err as Error).message, 'err'); }
        }
      }
    });
    frame();
  }

  /* ---------- CSV export (custom permission: reports:export) ---------- */
  async function exportCsv() {
    const all = await api.listUsers({ search: st.search, status: st.status, group: st.group || undefined, page: 1, size: 100_000 });
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Username', 'First name', 'Last name', 'Email', 'Department', 'Job title', 'Groups', 'Enabled', 'Super admin', 'Last sign-in'],
      ...all.items.map((u) => [u.username, u.firstName, u.lastName, u.email, u.attributes.department, u.attributes.jobTitle, u.groups.map(gname).join('; '), u.enabled, u.superAdmin, u.lastLogin ?? '']),
    ];
    const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `tems-users-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Export ready', `${all.items.length} users`);
  }

  await load();
  if (url.searchParams.get('new') === '1' && can('users:create')) {
    const x = new URL(location.href); x.searchParams.delete('new'); history.replaceState(history.state, '', x);
    createUser();
  }
  const deep = url.searchParams.get('user');
  if (deep) openUser(deep).catch((e) => toast('User not found', (e as Error).message, 'err'));
  cleanup(() => document.querySelectorAll('.modal-root').forEach((m) => m.remove()));
}
