import type { PageCtx } from '../app';
import type { Employee, Project, ProjectHealth, ProjectStatus, Ticket } from '../types';
import { HEALTH, PROJECT_STATUS, TICKET_ORDER, TICKET_STATUS, fmtDate, healthTag, priorityTag, projectTag } from '../hr';
import { newTicket, openTicket } from '../ticketView';
import { $, $$, avatar, confirmDanger, debounce, fmt, formData, html, ico, modal, mount, on, rel, requireFields, stagger, toast } from '../ui';

export default async function projects(c: PageCtx) {
  const id = new URL(location.href).searchParams.get('id');
  return id ? detail(c, id) : list(c);
}

export const progressBar = (p: Pick<Project, 'progress' | 'health'>) =>
  html`<div class="progress ${p.health}" role="progressbar" aria-valuenow="${p.progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p.progress}%"></span></div>`;

export function projectCard(p: Project) {
  const open = p.ticketCounts.open + p.ticketCounts.in_progress + p.ticketCounts.in_review;
  return html`
    <a class="pcard reveal-item" href="/projects/?id=${p.id}">
      <div class="pcard-top"><span class="tag mono">${p.key}</span>${projectTag(p.status)}${healthTag(p.health)}</div>
      <h3>${p.name}</h3>
      <p class="muted">${p.client || 'Internal'}${p.dueDate ? html` · due <span class="${p.overdue ? 'overdue' : ''}">${fmtDate(p.dueDate)}</span>` : ''}</p>
      ${progressBar(p)}
      <div class="pcard-foot">
        <span class="faces">${p.members.slice(0, 5).map((m) => avatar(m.name))}${p.members.length > 5 ? html`<span class="more">+${p.members.length - 5}</span>` : ''}</span>
        <span class="muted">${p.progress}% · ${open} open</span>
      </div>
    </a>`;
}

/* ======================= list ======================= */

async function list(c: PageCtx) {
  const { api, can, main, ctx } = c;
  if (!can('projects:view')) { location.replace('/work/'); return; }
  const st = { search: '', status: 'all' as ProjectStatus | 'all' };
  mount(main, html`
    <div class="toolbar reveal">
      <label class="search">${ico('search')}<input class="input" id="q" type="search" placeholder="Search projects…" aria-label="Search projects"></label>
      <select class="select" id="fs" style="width:auto" aria-label="Status"><option value="all">All statuses</option>
        ${Object.entries(PROJECT_STATUS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <span class="spacer"></span>
      ${can('projects:manage') ? html`<button class="btn" id="newP">${ico('plus')}New project</button>` : ''}
    </div>
    <div class="pgrid" id="grid"></div>`);

  async function load() {
    const ps = await api.listProjects({ search: st.search, status: st.status });
    mount($('#grid', main), ps.length ? html`${ps.map(projectCard)}` : html`<div class="empty">${ico('briefcase')}${st.search || st.status !== 'all' ? 'No projects match.' : 'No projects yet.'}</div>`);
    stagger($('#grid', main)!);
    const all = st.search || st.status !== 'all' ? await api.listProjects() : ps;
    const by = (s: ProjectStatus) => all.filter((p) => p.status === s).length;
    mount(ctx, html`
      <div class="ctx-card"><div class="ctx-label">Portfolio:</div>
        ${(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => html`<div class="ctx-stat"><span>${PROJECT_STATUS[s]}</span><b>${by(s)}</b></div>`)}</div>
      <div class="ctx-card"><div class="ctx-label">Needs attention:</div>
        ${all.filter((p) => p.overdue || p.health !== 'on_track').map((p) => html`<a href="/projects/?id=${p.id}">${p.name} <span class="muted">· ${p.overdue ? 'overdue' : HEALTH[p.health].toLowerCase()}</span></a>`)}
        ${!all.some((p) => p.overdue || p.health !== 'on_track') ? html`<p style="margin:0">Everything is on track.</p>` : ''}</div>
      <div class="ctx-card"><div class="ctx-label">Status tracking:</div>
        <p style="margin:0;font-size:13px">Progress is the share of resolved and closed tickets. Managers and project leads post status updates (status, health and a note); the team is emailed each update.</p></div>`);
  }
  $('#q', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); void load(); }));
  $('#fs', main)!.addEventListener('change', (e) => { st.status = (e.target as HTMLSelectElement).value as typeof st.status; void load(); });
  $('#newP', main)?.addEventListener('click', () => projectForm(c, null, (p) => { location.href = `/projects/?id=${p.id}`; }));
  await load();
}

/* ======================= form ======================= */

async function projectForm(c: PageCtx, p: Project | null, done: (p: Project) => void | Promise<void>) {
  const people: Employee[] = c.can('employees:view') ? (await c.api.listEmployees({ size: 100_000 })).items.filter((e) => e.stage !== 'offboarded') : [];
  modal({
    title: p ? `Edit ${p.name}` : 'New project', wide: true,
    body: html`<form autocomplete="off">
      <div class="grid-2">
        <div class="field"><label for="p-name">Name</label><input class="input" id="p-name" name="name" value="${p?.name ?? ''}" autofocus></div>
        <div class="field"><label for="p-key">Key</label><input class="input mono" id="p-key" name="key" value="${p?.key ?? ''}" ${p ? 'disabled' : ''} maxlength="10" placeholder="e.g. TEMS" style="text-transform:uppercase"><span class="hint">Prefixes ticket numbers (TEMS-12). Can't be changed later.</span></div>
        <div class="field"><label for="p-client">Client</label><input class="input" id="p-client" name="client" value="${p?.client ?? ''}" placeholder="Internal"></div>
        <div class="field"><label for="p-lead">Project lead</label><select class="select" id="p-lead" name="leadId" ${people.length ? '' : 'disabled'}>
          <option value="">No lead</option>${people.map((e) => html`<option value="${e.id}" ${p?.leadId === e.id ? 'selected' : ''}>${e.firstName} ${e.lastName} · ${e.jobTitle}</option>`)}</select>
          <span class="hint">The lead can post status updates.</span></div>
        <div class="field"><label for="p-start">Start date</label><input class="input" id="p-start" name="startDate" type="date" value="${p?.startDate ?? ''}"></div>
        <div class="field"><label for="p-due">Due date</label><input class="input" id="p-due" name="dueDate" type="date" value="${p?.dueDate ?? ''}"></div>
      </div>
      <div class="field"><label for="p-desc">Description</label><textarea class="textarea" id="p-desc" name="description" style="min-height:90px">${p?.description ?? ''}</textarea></div>
    </form>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: p ? 'Save' : 'Create project', icon: p ? 'check' : 'plus', onClick: async ({ body }) => {
        requireFields(body, p ? ['name'] : ['name', 'key']);
        const f = formData(body);
        const input = { name: f.name, description: f.description, client: f.client, startDate: f.startDate, dueDate: f.dueDate, leadId: f.leadId || null };
        const saved = p ? await c.api.updateProject(p.id, input) : await c.api.createProject({ ...input, key: f.key.toUpperCase() });
        toast(p ? 'Project saved' : `Created ${saved.key}`, saved.name);
        await done(saved);
      } },
    ],
  });
}

/* ======================= detail ======================= */

async function detail(c: PageCtx, id: string) {
  const { api, me, can, main, ctx } = c;
  let p: Project;
  try { p = await api.getProject(id); }
  catch (err) {
    mount(main, html`<div class="empty" style="padding:60px 20px">${ico('briefcase')}${(err as Error).message}<p><a class="btn soft" href="${can('projects:view') ? '/projects/' : '/work/'}">${ico('arrow')}Back</a></p></div>`);
    return;
  }
  const url = new URL(location.href);
  let tab = url.searchParams.get('tab') ?? 'board';
  let tickets: Ticket[] = [];
  const isLead = () => !!me.employeeId && p.leadId === me.employeeId;
  const onTeam = () => isLead() || p.members.some((m) => m.employeeId === me.employeeId);
  const canUpdate = () => can('projects:manage') || isLead();
  const canRaise = () => (can('tickets:create') || can('tickets:manage') || onTeam()) && p.status !== 'completed' && p.status !== 'cancelled';

  async function reload() {
    [p, tickets] = await Promise.all([api.getProject(id), api.listTickets({ projectId: id, size: 1000 }).then((r) => r.items)]);
    frame();
  }

  function frame() {
    mount(main, html`
      <a class="backlink" href="${can('projects:view') ? '/projects/' : '/work/'}">${ico('chevronRight', 'flip')}${can('projects:view') ? 'All projects' : 'My work'}</a>
      <div class="panel-head reveal" style="align-items:flex-start;margin-top:6px">
        <div style="min-width:0"><span class="eyebrow mono">${p.key}</span><h2 style="margin:2px 0 6px;font-size:28px">${p.name}</h2>
          <div class="tags">${projectTag(p.status)}${healthTag(p.health)}<span class="tag">${p.client || 'Internal'}</span>
            ${p.overdue ? html`<span class="tag err">${ico('warn')}Overdue</span>` : ''}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${canUpdate() ? html`<button class="btn sm" data-a="update">${ico('activity')}Post update</button>` : ''}
          ${can('projects:manage') ? html`<button class="btn soft sm" data-a="edit">${ico('edit')}Edit</button><button class="btn danger sm" data-a="delete">${ico('trash')}Delete</button>` : ''}
        </div>
      </div>
      <div class="psummary reveal" style="--i:1">
        <div><span class="muted">Progress</span><b>${p.progress}%</b>${progressBar(p)}</div>
        <div><span class="muted">Timeline</span><b>${fmtDate(p.startDate)} → ${fmtDate(p.dueDate)}</b></div>
        <div><span class="muted">Lead</span><b>${p.leadName || '—'}</b></div>
        <div><span class="muted">Tickets</span><b>${TICKET_ORDER.reduce((n, s) => n + p.ticketCounts[s], 0)} · ${p.ticketCounts.open + p.ticketCounts.in_progress + p.ticketCounts.in_review} open</b></div>
      </div>
      <div class="tabs" role="tablist">
        ${[['board', 'Board'], ['status', 'Status updates'], ['team', `Team · ${p.members.length}`], ['about', 'About']]
          .map(([k, l]) => html`<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${l}</button>`)}
      </div>
      <div id="tb"></div>`);
    drawTab();
    mount(ctx, html`
      <div class="ctx-card"><div class="ctx-label">Tickets:</div>
        ${TICKET_ORDER.map((s) => html`<div class="ctx-stat"><span>${TICKET_STATUS[s]}</span><b>${p.ticketCounts[s]}</b></div>`)}</div>
      <div class="ctx-card"><div class="ctx-label">Team:</div>
        ${p.members.map((m) => html`<div class="ctx-stat"><span>${m.name}</span><b>${m.allocation}%</b></div>`)}
        ${!p.members.length ? html`<p style="margin:0">Nobody assigned yet.</p>` : ''}</div>`);
  }

  function drawTab() {
    const old = $('#tb', main)!;
    const tb = old.cloneNode(false) as HTMLElement;
    old.replaceWith(tb);
    const u = new URL(location.href); u.searchParams.set('tab', tab); history.replaceState(history.state, '', u);
    if (tab === 'status') return void drawStatus(tb);
    if (tab === 'team') return void drawTeam(tb);
    if (tab === 'about') return mount(tb, html`<div class="panel"><p style="white-space:pre-wrap;margin:0">${p.description || 'No description.'}</p>
      <dl class="kv" style="margin-top:16px"><dt>Created</dt><dd>${fmt(p.createdAt)}</dd><dt>Last change</dt><dd>${rel(p.updatedAt)}</dd></dl></div>`);
    tab = 'board';
    drawBoard(tb);
  }

  function drawBoard(tb: HTMLElement) {
    mount(tb, html`
      <div class="toolbar"><label class="search">${ico('search')}<input class="input" id="bq" type="search" placeholder="Filter tickets…" aria-label="Filter tickets"></label>
        <span class="spacer"></span>${canRaise() ? html`<button class="btn" data-a="newT">${ico('plus')}New ticket</button>` : ''}</div>
      <div class="board">${TICKET_ORDER.map((s) => {
        const col = tickets.filter((t) => t.status === s);
        return html`<section class="bcol"><header><span>${TICKET_STATUS[s]}</span><b>${col.length}</b></header>
          ${col.map((t) => html`<button class="tcard" data-ticket="${t.id}" data-q="${`${t.ref} ${t.title} ${t.assigneeName}`.toLowerCase()}">
            <span class="mono muted" style="font-size:11.5px">${t.ref}</span><b>${t.title}</b>
            <span class="tcard-foot">${priorityTag(t.priority)}${t.dueDate ? html`<span class="muted">${fmtDate(t.dueDate)}</span>` : ''}
              ${t.assigneeName ? html`<span title="${t.assigneeName}">${avatar(t.assigneeName, 'sm')}</span>` : ''}${t.commentCount ? html`<span class="muted">${ico('mail', 'inline-ico')}${t.commentCount}</span>` : ''}</span>
          </button>`)}${!col.length ? html`<div class="bempty">—</div>` : ''}</section>`;
      })}</div>`);
    $('#bq', tb)!.addEventListener('input', (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      $$<HTMLElement>('.tcard', tb).forEach((x) => (x.hidden = !!q && !x.dataset.q!.includes(q)));
    });
  }

  async function drawStatus(tb: HTMLElement) {
    mount(tb, html`<div class="skel" style="height:60px"></div>`);
    const ups = await api.projectUpdates(p.id);
    mount(tb, html`
      ${canUpdate() ? html`<div class="toolbar"><span class="muted">Post a status update to record progress and email the team.</span><span class="spacer"></span><button class="btn" data-a="update">${ico('activity')}Post update</button></div>` : ''}
      ${ups.length ? html`<ul class="timeline">${ups.map((u, i) => html`
        <li class="tl-item reveal" style="--i:${Math.min(i, 12)}"><span class="tl-dot hl-${u.health}">${ico(u.health === 'on_track' ? 'check' : 'warn')}</span>
          <div class="tl-body"><div class="tags">${projectTag(u.status)}${healthTag(u.health)}<span class="tag">${u.progress}% done</span></div>
            ${u.note ? html`<p style="margin:6px 0 0;white-space:pre-wrap">${u.note}</p>` : ''}
            <div class="muted" style="font-size:12.5px;margin-top:4px">${u.author} · ${fmt(u.at)}</div></div></li>`)}</ul>`
      : html`<div class="empty">${ico('activity')}No status updates yet.</div>`}`);
  }

  async function drawTeam(tb: HTMLElement) {
    const manage = can('projects:manage');
    mount(tb, html`
      ${manage ? html`<div class="toolbar"><span class="muted">People on the team can be assigned tickets and see this project under My work.</span><span class="spacer"></span><button class="btn" data-a="addM">${ico('userPlus')}Assign people</button></div>` : ''}
      ${p.members.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th class="num">Allocation</th><th>Since</th>${manage ? html`<th class="actions"></th>` : ''}</tr></thead><tbody>
        ${p.members.map((m) => html`<tr>
          <td><div class="person">${avatar(m.name)}<div class="meta"><b>${m.name}${m.employeeId === p.leadId ? html` <span class="tag dark">Lead</span>` : ''}</b><span>${m.jobTitle || m.email}</span></div></div></td>
          <td>${m.role || '—'}</td><td class="num">${m.allocation}%</td><td>${rel(m.assignedAt)}</td>
          ${manage ? html`<td class="actions"><button class="btn ghost icon" data-em="${m.employeeId}" aria-label="Edit ${m.name}">${ico('edit')}</button><button class="btn ghost icon" data-rm="${m.employeeId}" aria-label="Remove ${m.name}">${ico('userMinus')}</button></td>` : ''}
        </tr>`)}</tbody></table></div>` : html`<div class="empty">${ico('users')}Nobody is assigned to this project yet.</div>`}`);
  }

  function postUpdate() {
    modal({
      title: `Status update · ${p.name}`, sub: `The team (${p.members.length} ${p.members.length === 1 ? 'person' : 'people'}) is emailed this update.`,
      body: html`<form autocomplete="off">
        <div class="grid-2">
          <div class="field"><label for="u-st">Status</label><select class="select" id="u-st" name="status">${Object.entries(PROJECT_STATUS).map(([k, l]) => html`<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div class="field"><label>Health</label><div class="seg" role="radiogroup" id="u-h">${(Object.keys(HEALTH) as ProjectHealth[]).map((h) => html`
            <button type="button" role="radio" data-h="${h}" class="${h === p.health ? 'on' : ''}" aria-checked="${h === p.health}">${HEALTH[h]}</button>`)}</div></div>
        </div>
        <div class="field"><label for="u-note">What changed? Risks, blockers, next steps</label><textarea class="textarea" id="u-note" name="note" style="min-height:120px" autofocus></textarea></div>
      </form>`,
      onOpen: ({ body }) => on(body, 'click', '[data-h]', (_e, b) => $$('[data-h]', body).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); })),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Post update', icon: 'send', onClick: async ({ body }) => {
          const f = formData(body);
          const health = ($('[data-h].on', body) as HTMLElement).dataset.h as ProjectHealth;
          p = await api.postProjectUpdate(p.id, { status: f.status as ProjectStatus, health, note: f.note });
          toast('Status update posted', `${PROJECT_STATUS[p.status]} · ${HEALTH[p.health]}`);
          tab = 'status'; await reload();
        } },
      ],
    });
  }

  async function assignPeople() {
    const people = (await api.listEmployees({ size: 100_000 })).items.filter((e) => e.stage !== 'offboarded' && !p.members.some((m) => m.employeeId === e.id));
    if (!people.length) return toast('Everyone is already on this project', '', 'info');
    modal({
      title: `Assign to ${p.name}`, sub: 'Each person is emailed that they were added, with their role.',
      body: html`<form autocomplete="off">
        <div class="field"><label for="m-e">Employee</label><select class="select" id="m-e" name="employeeId">${people.map((e) => html`<option value="${e.id}">${e.firstName} ${e.lastName} · ${e.jobTitle || e.department}</option>`)}</select></div>
        <div class="grid-2"><div class="field"><label for="m-r">Role on the project</label><input class="input" id="m-r" name="role" placeholder="e.g. Backend developer"></div>
          <div class="field"><label for="m-a">Allocation (%)</label><input class="input" id="m-a" name="allocation" type="number" min="0" max="100" value="100"></div></div>
      </form>`,
      actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Assign', icon: 'userPlus', onClick: async ({ body }) => {
        const f = formData(body);
        p = await api.addProjectMember(p.id, { employeeId: f.employeeId, role: f.role, allocation: Number(f.allocation) || 0 });
        toast('Assigned', people.find((e) => e.id === f.employeeId)!.firstName + ' · emailed');
        tab = 'team'; await reload();
      } }],
    });
  }

  on(main, 'click', '[data-tab]', (_e, b) => {
    tab = b.dataset.tab!;
    $$('[data-tab]', main).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    drawTab();
  });
  on(main, 'click', '[data-ticket]', (_e, b) => void openTicket(c, b.dataset.ticket!, reload));
  on(main, 'click', '[data-em]', (_e, b) => {
    const m = p.members.find((x) => x.employeeId === b.dataset.em)!;
    modal({
      title: `Edit ${m.name}`,
      body: html`<form autocomplete="off"><div class="grid-2"><div class="field"><label for="em-r">Role</label><input class="input" id="em-r" name="role" value="${m.role}"></div>
        <div class="field"><label for="em-a">Allocation (%)</label><input class="input" id="em-a" name="allocation" type="number" min="0" max="100" value="${m.allocation}"></div></div></form>`,
      actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Save', icon: 'check', onClick: async ({ body }) => {
        const f = formData(body);
        p = await api.updateProjectMember(p.id, m.employeeId, { role: f.role, allocation: Number(f.allocation) || 0 });
        toast('Saved', m.name); frame();
      } }],
    });
  });
  on(main, 'click', '[data-rm]', (_e, b) => {
    const m = p.members.find((x) => x.employeeId === b.dataset.rm)!;
    confirmDanger({ title: 'Remove from project', confirm: 'Remove', message: html`Remove <b>${m.name}</b> from ${p.name}? Their tickets stay assigned until you reassign them. They are emailed.`,
      onConfirm: async () => { p = await api.removeProjectMember(p.id, m.employeeId); toast('Removed', m.name); frame(); } });
  });
  on(main, 'click', '[data-a]', (_e, b) => {
    const a = b.dataset.a;
    if (a === 'update') postUpdate();
    if (a === 'edit') void projectForm(c, p, async () => reload());
    if (a === 'addM') void assignPeople();
    if (a === 'newT') void newTicket(c, p, async () => { tab = 'board'; await reload(); });
    if (a === 'delete') confirmDanger({
      title: 'Delete project', confirm: 'Delete project', typeToConfirm: p.key,
      message: html`Delete <b>${p.name}</b> with all its tickets, comments and status history? This cannot be undone.`,
      onConfirm: async () => { await api.deleteProject(p.id); toast('Project deleted', p.name); location.href = '/projects/'; },
    });
  });

  await reload();
  const tq = url.searchParams.get('ticket');
  if (tq) void openTicket(c, tq, reload);
}
