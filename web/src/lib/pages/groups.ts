import type { PageCtx } from '../app';
import type { Group, Permission, User } from '../types';
import { memberPermEditor } from '../permEditor';
import { statusTags } from './users';
import {
  $, $$, avatar, confirmDanger, debounce, fmt, formData, fullName, html, ico, modal, mount, on, requireFields, stagger, toast,
} from '../ui';

export default async function groups(c: PageCtx) {
  const { api, me, can, main, ctx, cleanup, refreshShell } = c;
  const url = new URL(location.href);
  let list: Group[] = await api.listGroups();
  const perms: Permission[] = await api.listPermissions();
  let selected = url.searchParams.get('g') ?? list[0]?.id ?? '';
  let tab = url.searchParams.get('tab') === 'members' ? 'members' : 'permissions';
  let filter = '';

  mount(main, html`
    <div class="split">
      <div class="reveal">
        <label class="search" style="max-width:none;margin-bottom:10px">${ico('search')}<input class="input" id="gq" type="search" placeholder="Filter groups…" aria-label="Filter groups"></label>
        ${can('groups:create') ? html`<button class="btn" id="newGroup" style="width:100%;margin-bottom:12px">${ico('plus')}New group</button>` : ''}
        <div class="list-cards" id="glist" role="listbox" aria-label="Groups"></div>
      </div>
      <div id="gdetail" class="reveal" style="--i:1;min-width:0"></div>
    </div>`);

  const syncUrl = () => {
    const u = new URL(location.href);
    selected ? u.searchParams.set('g', selected) : u.searchParams.delete('g');
    tab === 'members' ? u.searchParams.set('tab', 'members') : u.searchParams.delete('tab');
    history.replaceState(history.state, '', u);
  };

  function drawList() {
    const q = filter.toLowerCase();
    const items = list.filter((g) => !q || `${g.name} ${g.description}`.toLowerCase().includes(q));
    mount($('#glist', main), html`${items.map((g) => html`
      <button class="list-card reveal-item ${g.id === selected ? 'on' : ''}" data-g="${g.id}" role="option" aria-selected="${g.id === selected}">
        <div class="lc-title"><span>${g.name}</span><span>${g.memberCount}</span></div>
        <div class="lc-sub">${g.permissions.length} permission${g.permissions.length === 1 ? '' : 's'} · ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}</div>
      </button>`)}
      ${!items.length ? html`<div class="empty">${ico('group')}No groups${q ? ' match' : ' yet'}.</div>` : ''}`);
    stagger($('#glist', main)!);
  }

  $('#gq', main)!.addEventListener('input', debounce((e: Event) => { filter = (e.target as HTMLInputElement).value; drawList(); }, 120));
  on($('#glist', main)!, 'click', '[data-g]', (_e, b) => { selected = b.dataset.g!; drawList(); void drawDetail(); });
  $('#newGroup', main)?.addEventListener('click', () => createGroup());

  async function reloadList() { list = await api.listGroups(); drawList(); refreshShell(); }

  /* ---------- detail ---------- */
  let pending: Set<string> | null = null;   // unsaved permission set for the selected group
  let editors: Array<{ destroy: () => void }> = [];

  async function drawDetail() {
    editors.forEach((e) => e.destroy()); editors = [];
    pending = null;
    syncUrl();
    const g = list.find((x) => x.id === selected);
    const host = $('#gdetail', main)!;
    if (!g) {
      mount(host, html`<div class="empty" style="padding:60px 20px">${ico('group')}${list.length ? 'Select a group to manage it.' : 'Create your first group to start granting access.'}</div>`);
      mount(ctx, html``);
      return;
    }
    mount(host, html`
      <div class="panel-head" style="align-items:flex-start">
        <div style="min-width:0">
          <span class="eyebrow">Group</span>
          <h2 style="margin:2px 0 4px;font-size:28px">${g.name}</h2>
          <p class="muted" style="margin:0">${g.description || 'No description yet.'}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${can('groups:edit') ? html`<button class="btn soft sm" id="editG">${ico('edit')}Edit</button>` : ''}
          ${can('groups:delete') ? html`<button class="btn danger sm" id="delG">${ico('trash')}Delete</button>` : ''}
        </div>
      </div>
      <div class="stat-row">
        <span class="tag info">${ico('users')}${g.memberCount} member${g.memberCount === 1 ? '' : 's'}</span>
        <span class="tag">${ico('shield')}${g.permissions.length} of ${perms.length} permissions</span>
        <span class="tag">${ico('clock')}Created ${fmt(g.createdAt)}</span>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="permissions" class="${tab === 'permissions' ? 'on' : ''}">Permissions</button>
        <button role="tab" data-tab="members" class="${tab === 'members' ? 'on' : ''}">Members · ${g.memberCount}</button>
      </div>
      <div id="gtab"></div>`);
    $('#editG', host)?.addEventListener('click', () => editGroup(g));
    $('#delG', host)?.addEventListener('click', () => deleteGroup(g));
    on(host, 'click', '[data-tab]', (_e, b) => {
      if (pending && !confirm('Discard unsaved permission changes?')) return;
      tab = b.dataset.tab!; syncUrl();
      $$('[data-tab]', host).forEach((x) => x.classList.toggle('on', x === b));
      void drawTab(g);
    });
    void drawTab(g);
    drawContext(g);
  }

  async function drawTab(g: Group) {
    editors.forEach((e) => e.destroy()); editors = [];
    pending = null;
    // fresh node each time so delegated listeners from the previous tab are dropped
    const old = $('#gtab', main)!;
    const tb = old.cloneNode(false) as HTMLElement;
    old.replaceWith(tb);
    if (tab === 'permissions') return drawPerms(g, tb);
    return drawMembers(g, tb);
  }

  /* ----- group permissions: batch toggles, one save, one email per member ----- */
  function drawPerms(g: Group, tb: HTMLElement) {
    const editable = can('permissions:manage') && (me.superAdmin || !me.groups.includes(g.name));
    const current = new Set(g.permissions);
    const draw = () => {
      const set = pending ?? current;
      const cats = [...new Set(perms.map((p) => p.category))];
      const added = pending ? [...pending].filter((k) => !current.has(k)) : [];
      const removed = pending ? [...current].filter((k) => !pending!.has(k)) : [];
      mount(tb, html`
        <p class="muted" style="margin:0 0 14px">${editable
          ? html`Toggle what <b>every member</b> of ${g.name} can do. Nothing changes until you save; then each member gets <b>one</b> email summarising the change.`
          : !can('permissions:manage') ? 'Read-only: you need permissions:manage to change group access.' : 'Read-only: you cannot change the permissions of a group you belong to.'}</p>
        ${cats.map((cat) => {
          const inCat = perms.filter((p) => p.category === cat);
          const allOn = inCat.every((p) => set.has(p.key));
          return html`
          <div class="perm-cat">
            <div class="perm-cat-head"><h4>${cat}</h4>
              ${editable ? html`<button class="btn ghost sm" data-all="${cat}" data-on="${allOn ? '0' : '1'}">${allOn ? 'Clear all' : 'Grant all'}</button>` : ''}</div>
            ${inCat.map((p) => html`
              <label class="perm-row ${set.has(p.key) ? 'eff-on' : 'eff-off'} ${pending && set.has(p.key) !== current.has(p.key) ? 'pending' : ''}">
                <div style="min-width:0"><div class="pk">${p.key}${!p.system ? html` <span class="tag" style="margin-left:6px">custom</span>` : ''}</div><div class="pd">${p.description}</div></div>
                <span class="switch"><input type="checkbox" data-k="${p.key}" ${set.has(p.key) ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${p.key}"><span class="track"></span></span>
              </label>`)}
          </div>`;
        })}
        ${pending && (added.length || removed.length) ? html`
          <div class="savebar" role="region" aria-label="Unsaved changes">
            ${ico('mail')}
            <span><b>${added.length + removed.length} unsaved change${added.length + removed.length === 1 ? '' : 's'}</b> · ${g.memberCount} member${g.memberCount === 1 ? '' : 's'} will be emailed</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" id="discard">Discard</button>
            <button class="btn on-violet sm" id="save">${ico('check')}Save & notify</button>
          </div>` : ''}`);
    };
    draw();
    on(tb, 'change', 'input[data-k]', (_e, el) => {
      const k = el.dataset.k!;
      pending = new Set(pending ?? current);
      (el as HTMLInputElement).checked ? pending.add(k) : pending.delete(k);
      if ([...pending].sort().join() === [...current].sort().join()) pending = null;
      draw();
    });
    on(tb, 'click', '[data-all]', (_e, b) => {
      pending = new Set(pending ?? current);
      perms.filter((p) => p.category === b.dataset.all).forEach((p) => (b.dataset.on === '1' ? pending!.add(p.key) : pending!.delete(p.key)));
      if ([...pending].sort().join() === [...current].sort().join()) pending = null;
      draw();
    });
    on(tb, 'click', '#discard', () => { pending = null; draw(); });
    on(tb, 'click', '#save', async (_e, b) => {
      if (!pending) return;
      b.setAttribute('disabled', '');
      try {
        const updated = await api.setGroupPermissions(g.id, [...pending]);
        list = list.map((x) => (x.id === g.id ? updated : x));
        toast(`${g.name} updated`, `${updated.permissions.length} permissions granted`);
        pending = null;
        drawList(); await drawDetail(); refreshShell();
      } catch (err) {
        b.removeAttribute('disabled');
        toast('Not saved', (err as Error).message, 'err');
      }
    });
  }

  /* ----- members: expand any member to fine-tune their own permissions ----- */
  async function drawMembers(g: Group, tb: HTMLElement) {
    mount(tb, html`<div class="skel" style="height:52px;margin-bottom:8px"></div><div class="skel" style="height:52px"></div>`);
    const members: User[] = await api.groupMembers(g.id);
    const canM = can('groups:members');
    mount(tb, html`
      <div class="toolbar">
        <label class="search">${ico('search')}<input class="input" id="mq" type="search" placeholder="Filter members…" aria-label="Filter members"></label>
        <span class="spacer"></span>
        ${canM ? html`<button class="btn" id="addM">${ico('userPlus')}Add members</button>` : ''}
      </div>
      <p class="muted" style="margin:-4px 0 14px;font-size:13.5px">Open a member to override any permission just for them: <b>Deny</b> blocks it even if a group grants it, <b>Allow</b> grants it directly.</p>
      <div id="mlist">${members.length ? members.map((u, i) => html`
        <div class="member reveal" style="--i:${Math.min(i, 12)}" data-u="${u.id}" data-name="${`${fullName(u)} ${u.email}`.toLowerCase()}">
          <div class="member-head" role="button" tabindex="0" aria-expanded="false">
            ${avatar(fullName(u))}
            <div class="person"><div class="meta"><b>${fullName(u)}</b><span>${u.email}</span></div></div>
            <div class="tags" style="margin-left:8px">${statusTags(u)}${u.grants.length ? html`<span class="tag ok">+${u.grants.length} allowed</span>` : ''}${u.denies.length ? html`<span class="tag err">−${u.denies.length} denied</span>` : ''}</div>
            ${canM ? html`<button class="btn ghost sm" data-rm="${u.id}" title="Remove from ${g.name}" style="margin-left:auto">${ico('userMinus')}<span>Remove</span></button>` : ''}
            ${ico('chevron', 'chev')}
          </div>
          <div class="member-body"><div><div class="inner" data-editor></div></div></div>
        </div>`) : html`<div class="empty">${ico('users')}No members yet.${canM ? ' Add people to give them this group\'s permissions.' : ''}</div>`}</div>`);

    $('#mq', tb)?.addEventListener('input', (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      $$('.member', tb).forEach((m) => (m.hidden = !!q && !m.dataset.name!.includes(q)));
    });
    $('#addM', tb)?.addEventListener('click', () => addMembers(g, members));
    on(tb, 'click', '[data-rm]', (e, b) => {
      e.stopPropagation();
      const u = members.find((x) => x.id === b.dataset.rm)!;
      confirmDanger({
        title: 'Remove member', confirm: 'Remove from group',
        message: html`Remove <b>${fullName(u)}</b> from <b>${g.name}</b>? They lose the permissions this group grants (unless another group or a personal allow still grants them) and will be emailed.`,
        onConfirm: async () => { await api.removeMember(g.id, u.id); toast(`Removed ${fullName(u)}`, `from ${g.name}`); await reloadList(); await drawDetail(); },
      });
    });
    const toggle = async (head: HTMLElement) => {
      const box = head.closest<HTMLElement>('.member')!;
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      const slot = $('[data-editor]', box)!;
      if (open && !slot.dataset.loaded) {
        slot.dataset.loaded = '1';
        const u = members.find((x) => x.id === box.dataset.u)!;
        editors.push(await memberPermEditor(slot, c, u));
      }
    };
    on(tb, 'click', '.member-head', (e, head) => { if (!(e.target as HTMLElement).closest('[data-rm]')) void toggle(head); });
    on(tb, 'keydown', '.member-head', (e, head) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); void toggle(head); } });
  }

  function drawContext(g: Group) {
    const byCat = perms.reduce<Record<string, [number, number]>>((acc, p) => {
      acc[p.category] ??= [0, 0]; acc[p.category][1]++;
      if (g.permissions.includes(p.key)) acc[p.category][0]++;
      return acc;
    }, {});
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">On This Page:</div>
        <button class="linklike" data-jump="permissions">Group permissions</button>
        <button class="linklike" data-jump="members">Members & overrides</button>
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Coverage:</div>
        ${Object.entries(byCat).map(([cat, [n, t]]) => html`<div class="ctx-stat"><span>${cat}</span><b>${n}/${t}</b></div>`)}
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Heads-up:</div>
        <p style="margin:0">Members are emailed when they're added or removed, when this group's permissions change, and when their personal access changes.</p>
        ${can('permissions:view') ? html`<a href="/permissions/?view=matrix" style="margin-top:8px">Compare all groups →</a>` : ''}
      </div>`);
  }
  if (ctx) on(ctx, 'click', '[data-jump]', (_e, b) => { $<HTMLElement>(`[data-tab="${b.dataset.jump}"]`, main)?.click(); });

  /* ---------- CRUD modals ---------- */
  function createGroup() {
    modal({
      title: 'New group', sub: 'Bundle permissions for a team. Add members afterwards.',
      body: html`<form autocomplete="off">
        <div class="field"><label for="ng-name">Name</label><input class="input" id="ng-name" name="name" placeholder="e.g. Network Engineering" autofocus></div>
        <div class="field"><label for="ng-desc">Description</label><textarea class="textarea" id="ng-desc" name="description" style="min-height:80px" placeholder="Who belongs here and why"></textarea></div>
        <div class="field"><label for="ng-copy">Start with permissions from</label>
          <select class="select" id="ng-copy" name="copy" ${can('permissions:manage') ? '' : 'disabled'}><option value="">Nothing (empty group)</option>${list.map((x) => html`<option value="${x.id}">${x.name} · ${x.permissions.length}</option>`)}</select>
          ${can('permissions:manage') ? '' : html`<span class="hint">Needs permissions:manage.</span>`}</div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Create group', icon: 'plus', onClick: async ({ body }) => {
          requireFields(body, ['name']);
          const f = formData(body);
          const ng = await api.createGroup({ name: f.name, description: f.description, permissions: list.find((x) => x.id === f.copy)?.permissions ?? [] });
          toast(`Created ${ng.name}`);
          selected = ng.id; tab = 'permissions';
          await reloadList(); await drawDetail();
        } },
      ],
    });
  }

  function editGroup(g: Group) {
    modal({
      title: 'Edit group', sub: g.memberCount ? `Renaming emails all ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}.` : undefined,
      body: html`<form autocomplete="off">
        <div class="field"><label for="eg-name">Name</label><input class="input" id="eg-name" name="name" value="${g.name}" autofocus></div>
        <div class="field"><label for="eg-desc">Description</label><textarea class="textarea" id="eg-desc" name="description" style="min-height:80px">${g.description}</textarea></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save', icon: 'check', onClick: async ({ body }) => {
          requireFields(body, ['name']);
          const f = formData(body);
          await api.updateGroup(g.id, { name: f.name, description: f.description });
          toast('Group saved', f.name);
          await reloadList(); await drawDetail();
        } },
      ],
    });
  }

  function deleteGroup(g: Group) {
    confirmDanger({
      title: 'Delete group', confirm: 'Delete group', typeToConfirm: g.name,
      message: html`Deleting <b>${g.name}</b> removes it from ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}, who lose any permissions only this group granted. Each of them will be emailed.`,
      onConfirm: async () => {
        await api.deleteGroup(g.id);
        toast(`Deleted ${g.name}`);
        selected = ''; await reloadList();
        selected = list[0]?.id ?? ''; drawList(); await drawDetail();
      },
    });
  }

  async function addMembers(g: Group, current: User[]) {
    const all = (await api.listUsers({ size: 10_000 })).items.filter((u) => !current.some((m) => m.id === u.id));
    const m = modal({
      title: `Add to ${g.name}`, sub: `They'll get ${g.permissions.length} permission${g.permissions.length === 1 ? '' : 's'} and a welcome-to-the-group email.`, wide: true,
      body: html`
        <label class="search" style="max-width:none;margin-bottom:10px">${ico('search')}<input class="input" id="aq" type="search" placeholder="Search people…" autofocus aria-label="Search people"></label>
        <div class="checklist" style="max-height:380px">${all.length ? all.map((u) => html`
          <label class="check-row" data-name="${`${fullName(u)} ${u.email} ${u.username}`.toLowerCase()}">
            <input type="checkbox" value="${u.id}">${avatar(fullName(u))}
            <span class="person"><span class="meta"><b>${fullName(u)}</b><span>${u.email}${u.attributes.department ? ` · ${u.attributes.department}` : ''}</span></span></span>
            ${!u.enabled ? html`<span class="tag err" style="margin-left:auto">Disabled</span>` : ''}
          </label>`) : html`<div class="empty">Everyone is already a member.</div>`}</div>
        <p class="muted" id="selCount" style="margin:10px 0 0;font-size:13px">0 selected</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Add members', icon: 'userPlus', onClick: async ({ body }) => {
          const ids = $$<HTMLInputElement>('input[type=checkbox]:checked', body).map((i) => i.value);
          if (!ids.length) throw new Error('Select at least one person.');
          await api.addMembers(g.id, ids);
          toast(`Added ${ids.length} member${ids.length === 1 ? '' : 's'}`, g.name);
          tab = 'members'; await reloadList(); await drawDetail();
        } },
      ],
    });
    $('#aq', m.body)!.addEventListener('input', (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      $$('.check-row', m.body).forEach((r) => (r.hidden = !!q && !r.dataset.name!.includes(q)));
    });
    m.body.addEventListener('change', () => ($('#selCount', m.body)!.textContent = `${$$('input:checked', m.body).length} selected`));
  }

  drawList();
  await drawDetail();
  if (url.searchParams.get('new') === '1' && can('groups:create')) {
    const x = new URL(location.href); x.searchParams.delete('new'); history.replaceState(history.state, '', x);
    createGroup();
  }
  const guard = (e: BeforeUnloadEvent) => { if (pending) e.preventDefault(); };
  window.addEventListener('beforeunload', guard);
  cleanup(() => { window.removeEventListener('beforeunload', guard); editors.forEach((e) => e.destroy()); document.querySelectorAll('.modal-root').forEach((x) => x.remove()); });
}
