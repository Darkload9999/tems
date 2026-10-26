import type { PageCtx } from '../app';
import { ticketHead, ticketRows } from './tickets';
import { projectCard } from './projects';
import { openTicket } from '../ticketView';
import { $, html, ico, mount, on, stagger } from '../ui';

export default async function work(c: PageCtx) {
  const { api, me, main, ctx } = c;
  if (!me.employeeId) {
    mount(main, html`<div class="empty reveal" style="padding:60px 20px">${ico('briefcase')}
      <h2 style="margin:6px 0;color:var(--ink)">Your account isn't linked to an employee record</h2>
      <p>Once HR links your sign-in account to your employee record, your projects and tickets appear here.</p></div>`);
    return;
  }
  const [emp, projects] = await Promise.all([api.getEmployee(me.employeeId), api.listProjects({ mine: true })]);
  mount(main, html`
    <h2 class="reveal" style="margin:0 0 4px">Hi ${emp.firstName}.</h2>
    <p class="lede reveal" style="--i:1">${emp.jobTitle}${emp.department ? ` · ${emp.department}` : ''} · ${projects.length} project${projects.length === 1 ? '' : 's'}</p>
    <h3 style="margin:8px 0 12px">My tickets</h3>
    <div class="tabs" role="tablist"><button data-f="active" class="on">Open</button><button data-f="all">All</button></div>
    <div class="tbl-wrap"><table class="tbl">${ticketHead()}<tbody id="rows"></tbody></table></div>
    <h3 style="margin:28px 0 12px">My projects</h3>
    <div class="pgrid" id="grid">${projects.length ? projects.map(projectCard) : html`<div class="empty">${ico('briefcase')}You're not on any project yet.</div>`}</div>`);
  stagger($('#grid', main)!);
  let filter: 'active' | 'all' = 'active';
  async function load() {
    const res = await api.listTickets({ mine: true, status: filter, size: 200 });
    mount($('#rows', main), res.items.length ? ticketRows(res.items) : html`<tr><td colspan="8"><div class="empty">${ico('check')}${filter === 'active' ? 'Nothing open. Nice.' : 'No tickets yet.'}</div></td></tr>`);
    mount(ctx, html`<div class="ctx-card"><div class="ctx-label">My work:</div>
      <div class="ctx-stat"><span>${filter === 'active' ? 'Open tickets' : 'Tickets'}</span><b>${res.total}</b></div>
      <div class="ctx-stat"><span>Projects</span><b>${projects.length}</b></div></div>
      <div class="ctx-card"><div class="ctx-label">Tip:</div><p style="margin:0;font-size:13px">Open a ticket to move it along (In progress → In review → Resolved) or comment. The reporter is emailed.</p></div>`);
  }
  on(main, 'click', '[data-f]', (_e, b) => { filter = b.dataset.f as typeof filter; main.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); void load(); });
  on(main, 'click', 'tr[data-ticket]', (_e, tr) => void openTicket(c, tr.dataset.ticket!, load));
  await load();
}
