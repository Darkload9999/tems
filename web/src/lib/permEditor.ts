// Member-level permission editor: per permission → Deny · Inherit · Allow.
// Effective = (permissions from all groups ∪ allows) − denies. Super admins bypass.
import type { MemberPermission, PermState, User } from './types';
import type { PageCtx } from './app';
import { html, ico, mount, on, raw, toast } from './ui';

const STATE_LABEL: Record<PermState, string> = { deny: 'Deny', inherit: 'Inherit', allow: 'Allow' };

export async function memberPermEditor(
  host: HTMLElement,
  c: Pick<PageCtx, 'api' | 'me' | 'can'>,
  user: User,
  opts: { onChange?: () => void; filter?: string } = {},
) {
  mount(host, html`<div class="skel" style="height:14px;width:40%;margin:6px 0 12px"></div>${[1, 2, 3, 4].map(() => html`<div class="skel" style="height:52px;margin-bottom:6px"></div>`)}`);
  let rows: MemberPermission[] = await c.api.memberPermissions(user.id);

  const self = user.id === c.me.id;
  const editable = c.can('permissions:manage') && !user.superAdmin && (c.me.superAdmin || (!self && !user.superAdmin));
  const reason = user.superAdmin
    ? 'Super administrators have every permission.'
    : !c.can('permissions:manage') ? 'You need permissions:manage to change access.'
    : self && !c.me.superAdmin ? 'You cannot change your own access.' : '';

  const draw = () => {
    const visible = opts.filter ? rows.filter((r) => `${r.key} ${r.description}`.toLowerCase().includes(opts.filter!.toLowerCase())) : rows;
    const cats = [...new Set(visible.map((r) => r.category))];
    const eff = rows.filter((r) => r.effective).length;
    mount(host, html`
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">
        <span class="tag ${user.superAdmin ? 'dark' : 'info'}">${user.superAdmin ? ico('crown') : ''}${eff} of ${rows.length} permissions effective</span>
        <span class="muted" style="font-size:12.5px"><b>Deny</b> overrides groups · <b>Inherit</b> follows groups · <b>Allow</b> grants directly</span>
      </div>
      ${reason ? html`<p class="muted" style="font-size:13px;margin:-4px 0 12px">${ico('info', 'inline-ico')} ${reason}</p>` : ''}
      ${cats.map((cat) => html`
        <div class="perm-cat">
          <div class="perm-cat-head"><h4>${cat}</h4></div>
          ${visible.filter((r) => r.category === cat).map((r) => {
            const blockAllow = !c.me.superAdmin && !c.me.permissions.includes(r.key);
            return html`
            <div class="perm-row ${r.effective ? 'eff-on' : 'eff-off'}">
              <div style="min-width:0">
                <div class="pk">${r.key}</div>
                <div class="pd">${r.description}</div>
                <div class="src">${r.fromGroups.length ? html`Granted by ${r.fromGroups.join(', ')}` : 'Not granted by any group'}${r.state === 'deny' && r.fromGroups.length ? html` · <b style="color:var(--err)">blocked for this member</b>` : ''}</div>
              </div>
              ${editable ? html`
                <div class="seg" role="radiogroup" aria-label="${r.key}">
                  ${(['deny', 'inherit', 'allow'] as PermState[]).map((s) => html`
                    <button type="button" role="radio" aria-checked="${r.state === s}" class="${r.state === s ? 'on' : ''}" data-v="${s}" data-key="${r.key}"
                      ${s === 'allow' && blockAllow && r.state !== 'allow' ? raw('disabled title="You can only grant permissions you hold"') : ''}>${STATE_LABEL[s]}</button>`)}
                </div>` : html`<span class="tag ${r.state === 'allow' ? 'ok' : r.state === 'deny' ? 'err' : ''}">${STATE_LABEL[r.state]}</span>`}
            </div>`;
          })}
        </div>`)}`);
  };
  draw();

  const off = on(host, 'click', '.seg button[data-key]', async (_e, btn) => {
    const key = btn.dataset.key!, state = btn.dataset.v as PermState;
    const row = rows.find((r) => r.key === key);
    if (!row || row.state === state) return;
    const prev = rows;
    rows = rows.map((r) => (r.key === key ? { ...r, state } : r));
    draw();
    try {
      rows = await c.api.setMemberPermission(user.id, key, state);
      draw();
      toast(`${key} → ${STATE_LABEL[state]}`, `${user.firstName || user.username}'s access updated`);
      opts.onChange?.();
    } catch (err) {
      rows = prev; draw();
      toast('Permission not changed', (err as Error).message, 'err');
    }
  });
  return { destroy: off, setFilter: (f: string) => { opts.filter = f; draw(); } };
}
