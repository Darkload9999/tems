import type { PageCtx } from '../app';
import type { MailItem, MailStatus } from '../types';
import { EVENTS } from '../email';
import { $, $$, confirmDanger, debounce, fmt, html, ico, modal, mount, on, pager, rel, stagger, toast } from '../ui';

const SIZE = 12;
type F = MailStatus | 'all';

export const mailStatusTag = (m: Pick<MailItem, 'status'>) =>
  m.status === 'sent' ? html`<span class="tag ok"><span class="dot"></span>Delivered</span>`
  : m.status === 'failed' ? html`<span class="tag err"><span class="dot"></span>Failed</span>`
  : html`<span class="tag warn"><span class="dot"></span>Queued</span>`;

export default async function mail({ api, can, main, ctx, cleanup, refreshShell }: PageCtx) {
  const url = new URL(location.href);
  const st = { search: url.searchParams.get('q') ?? '', status: (url.searchParams.get('status') ?? 'all') as F, page: 1 };
  let items: MailItem[] = [];

  mount(main, html`
    <div class="toolbar reveal">
      <label class="search">${ico('search')}<input class="input" id="mq" type="search" placeholder="Search recipient, subject…" value="${st.search}" aria-label="Search mail"></label>
      <div class="seg" role="radiogroup" aria-label="Status" id="mstat">
        ${(['all', 'queued', 'sent', 'failed'] as F[]).map((s) => html`<button type="button" data-s="${s}" class="${st.status === s ? 'on' : ''}" role="radio" aria-checked="${st.status === s}">${s === 'all' ? 'All' : s === 'sent' ? 'Delivered' : s[0].toUpperCase() + s.slice(1)}</button>`)}
      </div>
      <span class="spacer"></span>
      <button class="btn ghost" id="mref" title="Refresh">${ico('refresh')}Refresh</button>
      ${can('mail:send') ? html`<a class="btn" href="/mail/compose/">${ico('send')}Compose</a>` : ''}
    </div>
    <div class="tbl-wrap reveal" style="--i:1"><table class="tbl">
      <thead><tr><th>Status</th><th>Recipient</th><th>Subject</th><th>Sent by</th><th>When</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody id="mrows"></tbody>
    </table></div>
    <div class="pager" id="mpager"></div>`);

  async function load(quiet = false) {
    const tb = $('#mrows', main)!;
    if (!quiet) tb.style.opacity = '.55';
    const res = await api.listMail({ search: st.search, status: st.status, page: st.page, size: SIZE });
    items = res.items;
    tb.style.opacity = '';
    mount(tb, items.length ? html`${items.map((m) => html`
      <tr class="clickable ${quiet ? '' : 'reveal-item'}" data-id="${m.id}" tabindex="0">
        <td>${mailStatusTag(m)}</td>
        <td><div class="person"><div class="meta"><b>${m.toName}</b><span>${m.to}</span></div></div></td>
        <td style="max-width:340px"><div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.subject}</div><span class="muted" style="font-size:12.5px">${EVENTS[m.event]?.label ?? m.event}</span></td>
        <td class="muted">${m.triggeredBy}</td>
        <td class="muted" title="${fmt(m.createdAt)}">${rel(m.createdAt)}</td>
        <td class="actions">
          ${can('mail:manage') && m.status !== 'queued' ? html`<button class="btn ghost icon" data-a="resend" title="Resend" aria-label="Resend">${ico('refresh')}</button>` : ''}
          ${can('mail:manage') ? html`<button class="btn ghost icon" data-a="delete" title="Delete" aria-label="Delete">${ico('trash')}</button>` : ''}
        </td>
      </tr>`)}` : html`<tr><td colspan="6"><div class="empty">${ico('inbox')}No messages${st.status !== 'all' ? ` with status “${st.status}”` : ''}.</div></td></tr>`);
    if (!quiet) stagger(tb);
    mount($('#mpager', main), pager(res.total, st.page, SIZE, 'message'));
    const u = new URL(location.href);
    st.search ? u.searchParams.set('q', st.search) : u.searchParams.delete('q');
    st.status !== 'all' ? u.searchParams.set('status', st.status) : u.searchParams.delete('status');
    history.replaceState(history.state, '', u);
  }

  async function drawContext() {
    const [health, q, s, f] = await Promise.all([
      api.mailHealth().catch(() => null),
      api.listMail({ status: 'queued', size: 1 }), api.listMail({ status: 'sent', size: 1 }), api.listMail({ status: 'failed', size: 1 }),
    ]);
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">Delivery:</div>
        <div class="ctx-stat"><span>Delivered</span><b style="color:var(--ok)">${s.total}</b></div>
        <div class="ctx-stat"><span>Queued</span><b>${q.total}</b></div>
        <div class="ctx-stat"><span>Failed</span><b style="color:${f.total ? 'var(--err)' : 'inherit'}">${f.total}</b></div>
      </div>
      ${health ? html`<div class="ctx-card">
        <div class="ctx-label">Mail server:</div>
        <div class="ctx-stat"><span>SMTP</span><b style="color:${health.ok ? 'var(--ok)' : 'var(--err)'}">${health.ok ? 'Online' : 'Unreachable'}</b></div>
        <div class="ctx-stat"><span>DKIM</span><b>${health.dkim ? 'Signing' : 'Off'}</b></div>
        <p class="muted" style="margin:6px 0 0;font-size:12px">${health.host}<br>${health.detail}</p>
      </div>` : ''}
      <div class="ctx-card">
        <div class="ctx-label">Who gets email?</div>
        <p style="margin:0;font-size:13px">Only the people an admin change affects. Choose which events send mail in ${can('settings:manage') ? html`<a href="/settings/#notifications" style="display:inline;color:var(--v-600)">Settings</a>` : 'Settings'}.</p>
      </div>`);
  }

  function preview(m: MailItem) {
    let tab = 'preview';
    const md = modal({
      title: m.subject, sub: `To ${m.toName} <${m.to}>`, wide: true,
      body: html`
        <div class="stat-row" style="margin-top:0">${mailStatusTag(m)}<span class="tag">${EVENTS[m.event]?.label ?? m.event}</span><span class="tag">${ico('clock')}${fmt(m.createdAt)}</span></div>
        <div class="tabs"><button data-t="preview" class="on">Preview</button><button data-t="text">Plain text</button><button data-t="details">Delivery</button></div>
        <div id="mp"></div>`,
      actions: [
        ...(can('mail:manage') ? [
          { label: 'Delete', kind: 'ghost' as const, icon: 'trash', onClick: async () => { await api.deleteMail(m.id); toast('Message deleted'); await load(); refreshShell(); void drawContext(); } },
          { label: 'Resend', kind: 'soft' as const, icon: 'refresh', onClick: async () => { await api.resendMail(m.id); toast('Re-queued', m.to, 'mail'); await load(); } },
        ] : []),
        { label: 'Close', kind: 'ghost' as const },
      ],
    });
    const drawTab = () => {
      const host = $('#mp', md.body)!;
      if (tab === 'preview') {
        mount(host, html`<iframe class="mail-frame" title="Email preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`);
        $<HTMLIFrameElement>('iframe', host)!.srcdoc = m.html;
      } else if (tab === 'text') {
        mount(host, html`<div class="codepanel"><div class="codepanel-head"><span>${ico('file')}message.txt</span></div><pre>${m.text}</pre></div>`);
      } else {
        mount(host, html`<dl class="kv">
          <dt>Status</dt><dd>${mailStatusTag(m)}</dd>
          <dt>Attempts</dt><dd>${m.attempts}</dd>
          ${m.error ? html`<dt>Last error</dt><dd class="mono" style="color:var(--err)">${m.error}</dd>` : ''}
          <dt>Recipient</dt><dd>${m.toName} &lt;${m.to}&gt;</dd>
          <dt>Event</dt><dd><span class="mono">${m.event}</span> · ${EVENTS[m.event]?.desc ?? ''}</dd>
          <dt>Triggered by</dt><dd>${m.triggeredBy}</dd>
          <dt>Queued</dt><dd>${fmt(m.createdAt)}</dd>
          <dt>Delivered</dt><dd>${fmt(m.sentAt)}</dd>
          <dt>Message ID</dt><dd class="mono">${m.id}</dd>
        </dl>`);
      }
    };
    on(md.body, 'click', '[data-t]', (_e, b) => { tab = b.dataset.t!; $$('[data-t]', md.body).forEach((x) => x.classList.toggle('on', x === b)); drawTab(); });
    drawTab();
  }

  $('#mq', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); st.page = 1; void load(); }));
  on(main, 'click', '#mstat [data-s]', (_e, b) => {
    st.status = b.dataset.s as F; st.page = 1;
    $$('#mstat [data-s]', main).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    void load();
  });
  on(main, 'click', '[data-go]', (_e, b) => { st.page = Number(b.dataset.go); void load(); });
  $('#mref', main)!.addEventListener('click', () => { void load(); void drawContext(); });
  on(main, 'click', 'tr[data-id]', async (e, tr) => {
    const m = items.find((x) => x.id === tr.dataset.id)!;
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'resend') {
      try { await api.resendMail(m.id); toast('Re-queued', m.to, 'mail'); await load(true); } catch (err) { toast('Not resent', (err as Error).message, 'err'); }
      return;
    }
    if (a === 'delete') {
      return confirmDanger({
        title: 'Delete message', confirm: 'Delete', message: html`Remove “${m.subject}” to ${m.to} from the outbox? This doesn't recall an email that was already delivered.`,
        onConfirm: async () => { await api.deleteMail(m.id); toast('Message deleted'); await load(); refreshShell(); void drawContext(); },
      });
    }
    preview(await api.getMail(m.id));
  });
  on(main, 'keydown', 'tr[data-id]', (e, tr) => { if ((e as KeyboardEvent).key === 'Enter') tr.click(); });

  // live delivery updates
  const live = debounce(() => { void load(true); void drawContext(); refreshShell(); }, 250);
  window.addEventListener('tems:mail', live);
  const poll = setInterval(live, 15_000);
  cleanup(() => { window.removeEventListener('tems:mail', live); clearInterval(poll); document.querySelectorAll('.modal-root').forEach((x) => x.remove()); });

  await load();
  void drawContext();
}
