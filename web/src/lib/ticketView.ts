// Ticket detail + creation modals, shared by the Projects board, Tickets list and My work.
import type { PageCtx } from './app';
import type { Project, Ticket, TicketComment, TicketPriority, TicketStatus, TicketType } from './types';
import { PRIORITY, TICKET_ORDER, TICKET_STATUS, TICKET_TYPE, fmtDate, priorityTag, ticketTag } from './hr';
import { $, avatar, confirmDanger, fmt, formData, html, ico, modal, mount, on, rel, requireFields, toast } from './ui';

type Ctx = Pick<PageCtx, 'api' | 'me' | 'can'>;

const opts = <K extends string>(labels: Record<K, string>, cur: string) =>
  (Object.keys(labels) as K[]).map((k) => html`<option value="${k}" ${k === cur ? 'selected' : ''}>${labels[k]}</option>`);

/** Raise a ticket. With `project` fixed, the project picker is hidden. */
export async function newTicket(c: Ctx, project: Project | null, onDone: (t: Ticket) => void | Promise<void>) {
  const projects = project ? [project] : (await c.api.listProjects(c.can('projects:view') ? {} : { mine: true }))
    .filter((p) => p.status !== 'completed' && p.status !== 'cancelled');
  if (!projects.length) return toast('No open projects', 'Create a project first, or ask to be added to one.', 'info');
  const canAssign = c.can('tickets:manage') || c.can('projects:manage');
  const memberOpts = (p: Project) => html`<option value="">Unassigned</option>${p.members.map((m) => html`<option value="${m.employeeId}">${m.name}${m.role ? ` · ${m.role}` : ''}</option>`)}`;
  const m = modal({
    title: 'New ticket', sub: project ? `${project.key} · ${project.name}` : 'Raise a task, bug, feature or support request on a project.', wide: true,
    body: html`<form autocomplete="off">
      ${project ? '' : html`<div class="field"><label for="t-proj">Project</label><select class="select" id="t-proj" name="projectId">${projects.map((p) => html`<option value="${p.id}">${p.key} · ${p.name}</option>`)}</select></div>`}
      <div class="field"><label for="t-title">Title</label><input class="input" id="t-title" name="title" autofocus placeholder="Short summary"></div>
      <div class="grid-2">
        <div class="field"><label for="t-type">Type</label><select class="select" id="t-type" name="type">${opts(TICKET_TYPE, 'task')}</select></div>
        <div class="field"><label for="t-pri">Priority</label><select class="select" id="t-pri" name="priority">${opts(PRIORITY, 'medium')}</select></div>
        ${canAssign ? html`<div class="field"><label for="t-as">Assignee</label><select class="select" id="t-as" name="assigneeId">${memberOpts(projects[0])}</select><span class="hint">Only people on the project team.</span></div>` : ''}
        <div class="field"><label for="t-due">Due date</label><input class="input" id="t-due" name="dueDate" type="date"></div>
      </div>
      <div class="field"><label for="t-desc">Description</label><textarea class="textarea" id="t-desc" name="description" style="min-height:120px" placeholder="Steps, context, acceptance criteria…"></textarea></div>
    </form>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Create ticket', icon: 'plus', onClick: async ({ body }) => {
        requireFields(body, ['title']);
        const f = formData(body);
        const t = await c.api.createTicket({
          projectId: project?.id ?? f.projectId, title: f.title, description: f.description, type: f.type as TicketType,
          priority: f.priority as TicketPriority, assigneeId: f.assigneeId || null, dueDate: f.dueDate,
        });
        toast(`Created ${t.ref}`, t.assigneeName ? `Assigned to ${t.assigneeName} · emailed` : t.title);
        await onDone(t);
      } },
    ],
  });
  $('#t-proj', m.body)?.addEventListener('change', (e) => {
    const p = projects.find((x) => x.id === (e.target as HTMLSelectElement).value)!;
    const as = $('#t-as', m.body); if (as) mount(as, memberOpts(p));
  });
}

/** Ticket detail: status, planning fields, description and the comment thread. */
export async function openTicket(c: Ctx, id: string, onChange: () => void | Promise<void> = () => {}) {
  let t: Ticket;
  let project: Project;
  let comments: TicketComment[];
  try {
    t = await c.api.getTicket(id);
    [project, comments] = await Promise.all([c.api.getProject(t.projectId), c.api.ticketComments(id)]);
  } catch (err) { return toast('Could not open ticket', (err as Error).message, 'err'); }

  const m = modal({ title: t.ref, sub: `${project.name}`, wide: true, body: html`<div id="tk"></div>`, actions: [{ label: 'Done', kind: 'ghost' }] });
  const host = $('#tk', m.body)!;
  const url = new URL(location.href); url.searchParams.set('ticket', id); history.replaceState(history.state, '', url);
  m.root.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-close], .modal-foot .btn')) { const u = new URL(location.href); u.searchParams.delete('ticket'); history.replaceState(history.state, '', u); }
  });

  const manage = c.can('tickets:manage');
  const assignee = () => !!c.me.employeeId && c.me.employeeId === t.assigneeId;
  const reporter = () => t.reporterId === c.me.id;

  const draw = () => {
    // keep a half-written comment when the ticket re-renders (e.g. after a status change)
    const draft = $<HTMLTextAreaElement>('#cmf textarea', host)?.value ?? '';
    const canStatus = manage || assignee() || reporter();
    const canWord = manage || reporter();
    mount(host, html`
      <div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">
        <h2 style="margin:0;font-size:22px;flex:1;min-width:240px">${t.title}</h2>
        <div style="display:flex;gap:6px">
          ${canWord ? html`<button class="btn soft sm" data-t="edit">${ico('edit')}Edit</button>` : ''}
          ${manage ? html`<button class="btn danger sm" data-t="delete">${ico('trash')}Delete</button>` : ''}
        </div>
      </div>
      <div class="tags" style="margin:8px 0 16px">${ticketTag(t.status)}${priorityTag(t.priority)}<span class="tag">${TICKET_TYPE[t.type]}</span>
        ${t.dueDate ? html`<span class="tag ${t.dueDate < new Date().toISOString().slice(0, 10) && t.status !== 'resolved' && t.status !== 'closed' ? 'err' : ''}">${ico('clock')}Due ${fmtDate(t.dueDate)}</span>` : ''}</div>
      <div class="ticket-grid">
        <div>
          <div class="ticket-desc">${t.description || html`<span class="muted">No description.</span>`}</div>
          <h4 style="margin:22px 0 10px">Activity</h4>
          <ul class="thread">${comments.map((cm) => cm.system
            ? html`<li class="sys">${ico('activity')}<span><b>${cm.author}</b> · ${cm.body} · <span class="muted">${rel(cm.at)}</span></span></li>`
            : html`<li>${avatar(cm.author)}<div class="bubble"><div class="muted" style="font-size:12px"><b style="color:var(--ink)">${cm.author}</b> · ${fmt(cm.at)}</div><div style="white-space:pre-wrap">${cm.body}</div></div></li>`)}
            ${!comments.length ? html`<li class="sys muted">${ico('info')}No activity yet.</li>` : ''}</ul>
          <form id="cmf" class="comment-box"><textarea class="textarea" name="body" placeholder="Write a comment… (the assignee and reporter are emailed)" style="min-height:70px"></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn sm" type="submit">${ico('send')}Comment</button></div></form>
        </div>
        <aside class="ticket-side">
          <div class="field"><label for="tk-st">Status</label><select class="select" id="tk-st" ${canStatus ? '' : 'disabled'}>
            ${TICKET_ORDER.map((s) => html`<option value="${s}" ${s === t.status ? 'selected' : ''}>${TICKET_STATUS[s]}</option>`)}</select></div>
          <div class="field"><label for="tk-as">Assignee</label><select class="select" id="tk-as" ${manage ? '' : 'disabled'}>
            <option value="">Unassigned</option>${project.members.map((mb) => html`<option value="${mb.employeeId}" ${mb.employeeId === t.assigneeId ? 'selected' : ''}>${mb.name}</option>`)}
            ${t.assigneeId && !project.members.some((mb) => mb.employeeId === t.assigneeId) ? html`<option selected value="${t.assigneeId}">${t.assigneeName}</option>` : ''}</select></div>
          <div class="field"><label for="tk-pr">Priority</label><select class="select" id="tk-pr" ${manage ? '' : 'disabled'}>${opts(PRIORITY, t.priority)}</select></div>
          <div class="field"><label for="tk-due">Due date</label><input class="input" id="tk-due" type="date" value="${t.dueDate}" ${manage ? '' : 'disabled'}></div>
          <dl class="kv" style="grid-template-columns:90px 1fr;font-size:13px">
            <dt>Project</dt><dd>${project.key} · ${project.name}</dd>
            <dt>Reporter</dt><dd>${t.reporter}</dd>
            <dt>Created</dt><dd>${fmt(t.createdAt)}</dd>
            <dt>Updated</dt><dd>${rel(t.updatedAt)}</dd>
          </dl>
        </aside>
      </div>`);
    $<HTMLTextAreaElement>('#cmf textarea', host)!.value = draft;
  };

  const patch = async (p: Parameters<typeof c.api.updateTicket>[1], what: string) => {
    try {
      t = await c.api.updateTicket(t.id, p);
      comments = await c.api.ticketComments(t.id);
      toast(`${t.ref} updated`, what);
      draw(); await onChange();
    } catch (err) { toast('Not updated', (err as Error).message, 'err'); draw(); }
  };
  on(host, 'change', '#tk-st', (_e, el) => patch({ status: (el as HTMLSelectElement).value as TicketStatus }, TICKET_STATUS[(el as HTMLSelectElement).value as TicketStatus]));
  on(host, 'change', '#tk-as', (_e, el) => patch({ assigneeId: (el as HTMLSelectElement).value || null }, 'Assignee changed'));
  on(host, 'change', '#tk-pr', (_e, el) => patch({ priority: (el as HTMLSelectElement).value as TicketPriority }, 'Priority changed'));
  on(host, 'change', '#tk-due', (_e, el) => patch({ dueDate: (el as HTMLInputElement).value }, 'Due date changed'));
  on(host, 'submit', '#cmf', async (e, form) => {
    e.preventDefault();
    const body = formData(form).body;
    if (!body) return toast('Write a comment first', '', 'info');
    try {
      await c.api.addTicketComment(t.id, body);
      $<HTMLTextAreaElement>('#cmf textarea', host)!.value = '';
      [t, comments] = await Promise.all([c.api.getTicket(t.id), c.api.ticketComments(t.id)]);
      draw(); await onChange();
    } catch (err) { toast('Comment not posted', (err as Error).message, 'err'); }
  });
  on(host, 'click', '[data-t=edit]', () => modal({
    title: `Edit ${t.ref}`, wide: true,
    body: html`<form autocomplete="off">
      <div class="field"><label for="te-title">Title</label><input class="input" id="te-title" name="title" value="${t.title}"></div>
      <div class="field"><label for="te-type">Type</label><select class="select" id="te-type" name="type">${opts(TICKET_TYPE, t.type)}</select></div>
      <div class="field"><label for="te-desc">Description</label><textarea class="textarea" id="te-desc" name="description" style="min-height:160px">${t.description}</textarea></div></form>`,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Save', icon: 'check', onClick: async ({ body }) => {
      requireFields(body, ['title']);
      const f = formData(body);
      await patch({ title: f.title, description: f.description, type: f.type as TicketType }, 'Details saved');
    } }],
  }));
  on(host, 'click', '[data-t=delete]', () => confirmDanger({
    title: `Delete ${t.ref}`, confirm: 'Delete ticket', message: html`Delete <b>${t.title}</b> and its comments? This cannot be undone.`,
    onConfirm: async () => { await c.api.deleteTicket(t.id); toast(`Deleted ${t.ref}`); m.close(); await onChange(); },
  }));
  draw();
}
