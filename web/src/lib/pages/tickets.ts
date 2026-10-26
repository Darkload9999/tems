import type { PageCtx } from '../app';
import type { Project, Ticket, TicketPriority, TicketStatus } from '../types';
import { PRIORITY, TICKET_STATUS, fmtDate, priorityTag, ticketTag } from '../hr';
import { newTicket, openTicket } from '../ticketView';
import { $, debounce, html, ico, mount, on, pager, rel, stagger } from '../ui';

const SIZE = 20;

export function ticketRows(items: Ticket[], showProject = true) {
  const today = new Date().toISOString().slice(0, 10);
  return html`${items.map((t) => html`
    <tr class="clickable reveal-item" data-ticket="${t.id}" tabindex="0">
      <td class="mono">${t.ref}</td>
      <td><b>${t.title}</b>${t.commentCount ? html` <span class="muted" style="font-size:12px">${ico('mail', 'inline-ico')}${t.commentCount}</span>` : ''}</td>
      ${showProject ? html`<td>${t.projectKey}</td>` : ''}
      <td>${ticketTag(t.status)}</td>
      <td>${priorityTag(t.priority)}</td>
      <td>${t.assigneeName || html`<span class="muted">Unassigned</span>`}</td>
      <td class="${t.dueDate && t.dueDate < today && t.status !== 'resolved' && t.status !== 'closed' ? 'overdue' : ''}">${fmtDate(t.dueDate)}</td>
      <td class="muted">${rel(t.updatedAt)}</td>
    </tr>`)}`;
}

export const ticketHead = (showProject = true) =>
  html`<thead><tr><th>Ticket</th><th>Title</th>${showProject ? html`<th>Project</th>` : ''}<th>Status</th><th>Priority</th><th>Assignee</th><th>Due</th><th>Updated</th></tr></thead>`;

export default async function tickets(c: PageCtx) {
  const { api, can, main, ctx } = c;
  const all = can('tickets:view');
  const url = new URL(location.href);
  const st = { search: '', projectId: url.searchParams.get('project') ?? '', status: 'active' as TicketStatus | 'all' | 'active', priority: 'all' as TicketPriority | 'all', page: 1 };
  const projects: Project[] = all && can('projects:view') ? await api.listProjects() : await api.listProjects({ mine: true }).catch(() => []);

  mount(main, html`
    ${all ? '' : html`<p class="lede reveal">Tickets assigned to you. Ask for <span class="mono">tickets:view</span> to see every project's tickets.</p>`}
    <div class="toolbar reveal">
      <label class="search">${ico('search')}<input class="input" id="q" type="search" placeholder="Search title or ref…" aria-label="Search tickets"></label>
      ${all ? html`<select class="select" id="fp" style="width:auto" aria-label="Project"><option value="">All projects</option>${projects.map((p) => html`<option value="${p.id}" ${p.id === st.projectId ? 'selected' : ''}>${p.key} · ${p.name}</option>`)}</select>` : ''}
      <select class="select" id="fs" style="width:auto" aria-label="Status"><option value="active">Open work</option><option value="all">All statuses</option>
        ${Object.entries(TICKET_STATUS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <select class="select" id="fpr" style="width:auto" aria-label="Priority"><option value="all">Any priority</option>
        ${Object.entries(PRIORITY).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <span class="spacer"></span>
      ${can('tickets:create') || can('tickets:manage') || projects.length ? html`<button class="btn" id="newT">${ico('plus')}New ticket</button>` : ''}
    </div>
    <div class="tbl-wrap reveal" style="--i:1"><table class="tbl">${ticketHead()}<tbody id="rows"></tbody></table></div>
    <div class="pager" id="pager"></div>`);

  async function load() {
    const res = await api.listTickets({ search: st.search, projectId: st.projectId || undefined, status: st.status, priority: st.priority, mine: !all, page: st.page, size: SIZE });
    mount($('#rows', main), res.items.length ? ticketRows(res.items) : html`<tr><td colspan="8"><div class="empty">${ico('check')}No tickets match.</div></td></tr>`);
    stagger($('#rows', main)!);
    mount($('#pager', main), pager(res.total, st.page, SIZE, 'ticket'));
    if (all) {
      const s = await api.stats().catch(() => null);
      mount(ctx, html`<div class="ctx-card"><div class="ctx-label">Tickets:</div>
        <div class="ctx-stat"><span>Showing</span><b>${res.total}</b></div>${s ? html`<div class="ctx-stat"><span>Open across projects</span><b>${s.openTickets}</b></div>` : ''}</div>
        <div class="ctx-card"><div class="ctx-label">Emails:</div><p style="margin:0;font-size:13px">Assignees are emailed when a ticket is assigned to them. The assignee and reporter are emailed on status changes and comments.</p></div>`);
    }
  }
  $('#q', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); st.page = 1; void load(); }));
  $('#fp', main)?.addEventListener('change', (e) => { st.projectId = (e.target as HTMLSelectElement).value; st.page = 1; void load(); });
  $('#fs', main)!.addEventListener('change', (e) => { st.status = (e.target as HTMLSelectElement).value as typeof st.status; st.page = 1; void load(); });
  $('#fpr', main)!.addEventListener('change', (e) => { st.priority = (e.target as HTMLSelectElement).value as typeof st.priority; st.page = 1; void load(); });
  on(main, 'click', '[data-go]', (_e, b) => { st.page = Number(b.dataset.go); void load(); });
  on(main, 'click', 'tr[data-ticket]', (_e, tr) => void openTicket(c, tr.dataset.ticket!, load));
  on(main, 'keydown', 'tr[data-ticket]', (e, tr) => { if ((e as KeyboardEvent).key === 'Enter') void openTicket(c, tr.dataset.ticket!, load); });
  $('#newT', main)?.addEventListener('click', () => void newTicket(c, projects.find((p) => p.id === st.projectId) ?? null, load));
  await load();
  const id = url.searchParams.get('id') ?? url.searchParams.get('ticket');
  if (id) void openTicket(c, id, load);
}
