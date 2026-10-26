import type { PageCtx } from '../app';
import type { AuditEntry } from '../types';
import { $, debounce, fmt, html, ico, modal, mount, on, pager, rel, stagger } from '../ui';

const SIZE = 15;
const TYPES: Array<[string, string]> = [['all', 'Everything'], ['user', 'Users'], ['group', 'Groups'], ['permission', 'Permissions'], ['session', 'Sessions'], ['mail', 'Mail'], ['settings', 'Settings'], ['employee', 'Employees'], ['project', 'Projects'], ['ticket', 'Tickets']];
const ICON: Record<string, string> = { user: 'user', group: 'group', permission: 'shield', session: 'logout', mail: 'mail', settings: 'settings', employee: 'briefcase', project: 'layers', ticket: 'inbox' };
const tone = (a: AuditEntry) => /delete|disable|revoke|remove/.test(a.action) ? 'err' : /create|enable|grant|add/.test(a.action) ? 'ok' : '';

export default async function audit({ api, main, ctx }: PageCtx) {
  const st = { search: '', type: 'all', page: 1 };
  let items: AuditEntry[] = [];

  mount(main, html`
    <div class="toolbar reveal">
      <label class="search">${ico('search')}<input class="input" id="aq" type="search" placeholder="Search actor, action, target…" aria-label="Search audit log"></label>
      <select class="select" id="at" style="width:auto" aria-label="Filter by type">${TYPES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
    </div>
    <ol class="timeline reveal" style="--i:1" id="tl"></ol>
    <div class="pager" id="ap"></div>`);

  async function load() {
    const res = await api.listAudit({ search: st.search, targetType: st.type, page: st.page, size: SIZE });
    items = res.items;
    const tl = $('#tl', main)!;
    mount(tl, items.length ? html`${items.map((a) => html`
      <li class="tl-item reveal-item ${tone(a)}">
        <span class="tl-dot">${ico(ICON[a.targetType] ?? 'activity')}</span>
        <div class="tl-body">
          <button class="linklike" data-id="${a.id}" style="background:none;border:0;padding:0;text-align:left;font-weight:700;color:var(--ink);cursor:pointer">${a.summary}</button>
          <div class="when">${a.actor} · <span class="mono">${a.action}</span> · <span title="${fmt(a.at)}">${rel(a.at)}</span></div>
        </div>
      </li>`)}` : html`<li class="empty">${ico('history')}Nothing recorded${st.search || st.type !== 'all' ? ' for these filters' : ' yet'}.</li>`);
    stagger(tl);
    mount($('#ap', main), pager(res.total, st.page, SIZE, 'event'));
  }

  on(main, 'click', '[data-id]', (_e, b) => {
    const a = items.find((x) => x.id === b.dataset.id)!;
    modal({
      title: a.action, sub: a.summary, wide: true,
      body: html`
        <dl class="kv" style="margin-bottom:16px">
          <dt>When</dt><dd>${fmt(a.at)} <span class="muted">(${rel(a.at)})</span></dd>
          <dt>Actor</dt><dd>${a.actor} <span class="mono muted">${a.actorId}</span></dd>
          <dt>Target</dt><dd>${a.targetType} · <b>${a.targetName || '—'}</b> <span class="mono muted">${a.targetId}</span></dd>
          <dt>Source IP</dt><dd class="mono">${a.ip}</dd>
        </dl>
        <div class="codepanel"><div class="codepanel-head"><span>${ico('code')}details.json</span></div><pre>${JSON.stringify(a.details, null, 2)}</pre></div>`,
    });
  });
  $('#aq', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); st.page = 1; void load(); }));
  $('#at', main)!.addEventListener('change', (e) => { st.type = (e.target as HTMLSelectElement).value; st.page = 1; void load(); });
  on(main, 'click', '[data-go]', (_e, b) => { st.page = Number(b.dataset.go); void load(); main.scrollIntoView({ behavior: 'smooth' }); });

  await load();
  mount(ctx, html`
    <div class="ctx-card">
      <div class="ctx-label">Legend:</div>
      <div class="ctx-stat"><span style="color:var(--ok)">● Created / granted</span></div>
      <div class="ctx-stat"><span style="color:var(--err)">● Removed / revoked</span></div>
      <div class="ctx-stat"><span style="color:var(--title)">● Changed</span></div>
    </div>
    <div class="ctx-card">
      <div class="ctx-label">About the trail:</div>
      <p style="margin:0;font-size:13px">Every change made through Techzaz EMS is recorded with who did it, from where and exactly what changed. Entries can't be edited or deleted from the console.</p>
    </div>`);
}
