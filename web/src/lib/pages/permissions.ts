import type { PageCtx } from '../app';
import type { Group, Permission } from '../types';
import { $, $$, confirmDanger, debounce, formData, html, ico, modal, mount, on, requireFields, stagger, toast } from '../ui';

export default async function permissions(c: PageCtx) {
  const { api, me, can, main, ctx, cleanup, refreshShell } = c;
  const url = new URL(location.href);
  let view = url.searchParams.get('view') === 'matrix' ? 'matrix' : 'catalog';
  let perms: Permission[] = await api.listPermissions();
  let groups: Group[] = await api.listGroups();
  let search = '';
  let pending = new Map<string, Set<string>>();   // matrix: groupId → unsaved permission set

  mount(main, html`
    <div class="tabs reveal" role="tablist">
      <button role="tab" data-view="catalog" class="${view === 'catalog' ? 'on' : ''}">${ico('layers', 'inline-ico')} Catalog</button>
      <button role="tab" data-view="matrix" class="${view === 'matrix' ? 'on' : ''}">${ico('grid', 'inline-ico')} Groups matrix</button>
    </div>
    <div class="toolbar reveal" style="--i:1">
      <label class="search">${ico('search')}<input class="input" id="pq" type="search" placeholder="Search permissions…" aria-label="Search permissions"></label>
      <span class="spacer"></span>
      ${me.superAdmin ? html`<button class="btn" id="newPerm">${ico('plus')}New permission</button>` : ''}
    </div>
    <div id="pv" class="reveal" style="--i:2"></div>`);

  const matches = (p: Permission) => !search || `${p.key} ${p.description} ${p.category}`.toLowerCase().includes(search);
  const cats = () => [...new Set(perms.filter(matches).map((p) => p.category))];
  const holders = (key: string) => groups.filter((g) => g.permissions.includes(key));

  function draw() {
    const host = $('#pv', main)!;
    const fresh = host.cloneNode(false) as HTMLElement;   // drop old delegated listeners
    host.replaceWith(fresh);
    view === 'catalog' ? drawCatalog(fresh) : drawMatrix(fresh);
    const u = new URL(location.href);
    view === 'matrix' ? u.searchParams.set('view', 'matrix') : u.searchParams.delete('view');
    history.replaceState(history.state, '', u);
  }

  /* ---------- catalog ---------- */
  function drawCatalog(host: HTMLElement) {
    const list = cats();
    mount(host, html`${list.length ? list.map((cat) => html`
      <h4 class="perm-cat-head" style="margin:20px 0 8px"><span style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:800">${cat}</span></h4>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th style="width:30%">Permission</th><th>Description</th><th>Granted by</th><th>Type</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${perms.filter((p) => p.category === cat && matches(p)).map((p) => {
          const hs = holders(p.key);
          return html`<tr class="reveal-item">
            <td class="mono" style="font-weight:600;color:var(--title)">${p.key}</td>
            <td>${p.description}</td>
            <td><div class="tags">${hs.length ? hs.map((g) => html`<a class="tag" href="/groups/?g=${g.id}">${g.name}</a>`) : html`<span class="muted">No group</span>`}</div></td>
            <td>${p.system ? html`<span class="tag">${ico('lock')}Built-in</span>` : html`<span class="tag info">${ico('sparkle')}Custom</span>`}</td>
            <td class="actions">${me.superAdmin && !p.system ? html`
              <button class="btn ghost icon" data-edit="${p.key}" title="Edit" aria-label="Edit ${p.key}">${ico('edit')}</button>
              <button class="btn ghost icon" data-del="${p.key}" title="Delete" aria-label="Delete ${p.key}">${ico('trash')}</button>` : ''}</td>
          </tr>`;
        })}</tbody>
      </table></div>`) : html`<div class="empty">${ico('shield')}No permissions match “${search}”.</div>`}`);
    stagger(host);
    on(host, 'click', '[data-edit]', (_e, b) => editPerm(perms.find((p) => p.key === b.dataset.edit)!));
    on(host, 'click', '[data-del]', (_e, b) => deletePerm(perms.find((p) => p.key === b.dataset.del)!));
  }

  /* ---------- matrix ---------- */
  function drawMatrix(host: HTMLElement) {
    const editable = (g: Group) => can('permissions:manage') && (me.superAdmin || !me.groups.includes(g.name));
    const setOf = (g: Group) => pending.get(g.id) ?? new Set(g.permissions);
    const changes = [...pending.entries()].reduce((n, [gid, s]) => {
      const g = groups.find((x) => x.id === gid)!;
      return n + [...s].filter((k) => !g.permissions.includes(k)).length + g.permissions.filter((k) => !s.has(k)).length;
    }, 0);
    const affected = [...pending.keys()].reduce((n, gid) => n + (groups.find((g) => g.id === gid)?.memberCount ?? 0), 0);
    mount(host, html`
      ${!can('permissions:manage') ? html`<p class="muted" style="margin:0 0 12px">Read-only: you need permissions:manage to change assignments.</p>` : ''}
      <div class="tbl-wrap" style="max-height:70vh">
        <table class="matrix">
          <thead><tr><th>Permission</th>${groups.map((g) => html`<th title="${g.description}">${g.name}<div style="font-weight:600;letter-spacing:0;text-transform:none;font-size:11px">${g.memberCount} members</div></th>`)}</tr></thead>
          <tbody>${cats().map((cat) => html`
            <tr class="cat"><td colspan="${groups.length + 1}">${cat}</td></tr>
            ${perms.filter((p) => p.category === cat && matches(p)).map((p) => html`
              <tr><td><span class="mono" style="font-weight:600;color:var(--title)">${p.key}</span><div class="muted" style="font-size:12px">${p.description}</div></td>
                ${groups.map((g) => {
                  const isOn = setOf(g).has(p.key);
                  const dirty = pending.has(g.id) && isOn !== g.permissions.includes(p.key);
                  return html`<td class="c" style="${dirty ? 'background:var(--lav-100)' : ''}">
                    <label class="switch" title="${g.name} · ${p.key}"><input type="checkbox" data-g="${g.id}" data-k="${p.key}" ${isOn ? 'checked' : ''} ${editable(g) ? '' : 'disabled'} aria-label="${g.name}: ${p.key}"><span class="track"></span></label></td>`;
                })}
              </tr>`)}`)}
          </tbody>
        </table>
      </div>
      ${changes ? html`
        <div class="savebar" role="region" aria-label="Unsaved changes">${ico('mail')}
          <span><b>${changes} unsaved change${changes === 1 ? '' : 's'}</b> across ${pending.size} group${pending.size === 1 ? '' : 's'} · ${affected} member${affected === 1 ? '' : 's'} will be emailed</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" id="mDiscard">Discard</button>
          <button class="btn on-violet sm" id="mSave">${ico('check')}Save & notify</button>
        </div>` : ''}`);

    on(host, 'change', 'input[data-g]', (_e, el) => {
      const g = groups.find((x) => x.id === el.dataset.g)!;
      const s = new Set(setOf(g));
      (el as HTMLInputElement).checked ? s.add(el.dataset.k!) : s.delete(el.dataset.k!);
      [...s].sort().join() === [...g.permissions].sort().join() ? pending.delete(g.id) : pending.set(g.id, s);
      const scroller = $('.tbl-wrap', host)!; const top = scroller.scrollTop;
      draw();
      $('.tbl-wrap', main)!.scrollTop = top;
    });
    on(host, 'click', '#mDiscard', () => { pending = new Map(); draw(); });
    on(host, 'click', '#mSave', async (_e, b) => {
      b.setAttribute('disabled', '');
      let ok = 0;
      for (const [gid, s] of pending) {
        try { await api.setGroupPermissions(gid, [...s]); ok++; pending.delete(gid); }
        catch (err) { toast(`${groups.find((g) => g.id === gid)?.name} not saved`, (err as Error).message, 'err'); }
      }
      if (ok) toast(`Saved ${ok} group${ok === 1 ? '' : 's'}`, 'Members have been notified');
      groups = await api.listGroups();
      refreshShell(); draw(); drawContext();
    });
  }

  /* ---------- catalog CRUD (super admins) ---------- */
  const permForm = (p?: Permission) => html`<form autocomplete="off">
    <div class="field"><label for="pk">Key</label><input class="input mono" id="pk" name="key" placeholder="resource:action" value="${p?.key ?? ''}" ${p ? 'disabled' : 'autofocus'}>
      <span class="hint">Lowercase, in the form <span class="mono">resource:action</span>, e.g. <span class="mono">reports:export</span>. Stored as a Keycloak client role.</span></div>
    <div class="field"><label for="pc">Category</label><input class="input" id="pc" name="category" list="cats" value="${p?.category ?? ''}" placeholder="e.g. Reports">
      <datalist id="cats">${[...new Set(perms.map((x) => x.category))].map((x) => html`<option value="${x}">`)}</datalist></div>
    <div class="field"><label for="pd">Description</label><input class="input" id="pd" name="description" value="${p?.description ?? ''}" placeholder="What does holding this allow?" ${p ? 'autofocus' : ''}></div>
  </form>`;

  function newPerm() {
    modal({
      title: 'New permission', sub: 'Define a privilege, then grant it to groups or individual members.',
      body: permForm(),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Create permission', icon: 'plus', onClick: async ({ body }) => {
          requireFields(body, ['key', 'description']);
          const f = formData(body);
          const p = await api.createPermission({ key: f.key, category: f.category, description: f.description });
          toast(`Created ${p.key}`, 'Grant it from a group or the matrix.');
          perms = await api.listPermissions(); draw(); drawContext(); refreshShell();
        } },
      ],
    });
  }
  function editPerm(p: Permission) {
    modal({
      title: 'Edit permission', sub: p.key, body: permForm(p),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save', icon: 'check', onClick: async ({ body }) => {
          requireFields(body, ['description']);
          const f = formData(body);
          await api.updatePermission(p.key, { category: f.category, description: f.description });
          toast('Permission saved', p.key);
          perms = await api.listPermissions(); draw();
        } },
      ],
    });
  }
  function deletePerm(p: Permission) {
    const hs = holders(p.key);
    confirmDanger({
      title: 'Delete permission', confirm: 'Delete permission', typeToConfirm: p.key,
      message: html`<span class="mono">${p.key}</span> will be removed from ${hs.length} group${hs.length === 1 ? '' : 's'} and from every member override. Anyone who loses it will be emailed.`,
      onConfirm: async () => {
        await api.deletePermission(p.key);
        toast(`Deleted ${p.key}`);
        [perms, groups] = await Promise.all([api.listPermissions(), api.listGroups()]);
        draw(); drawContext(); refreshShell();
      },
    });
  }

  function drawContext() {
    const custom = perms.filter((p) => !p.system).length;
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">How access is computed:</div>
        <div class="codepanel" style="margin:4px 0 8px"><pre style="font-size:11.5px;padding:10px 12px"><span class="c-kw">effective</span> =
  <span class="c-str">groups</span> ∪ <span class="c-fn">allow</span>
  − <span class="c-num">deny</span>
<span class="c-com">// super admins: everything</span></pre></div>
        <p style="margin:0;font-size:13px">Group grants add up across every group a person is in. Member overrides are set on the Users or Groups page.</p>
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Catalog:</div>
        <div class="ctx-stat"><span>Permissions</span><b>${perms.length}</b></div>
        <div class="ctx-stat"><span>Built-in</span><b>${perms.length - custom}</b></div>
        <div class="ctx-stat"><span>Custom</span><b>${custom}</b></div>
        <div class="ctx-stat"><span>Groups</span><b>${groups.length}</b></div>
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Safety rails:</div>
        <p style="margin:0;font-size:13px">Only super admins edit the catalog. Admins can only grant permissions they hold themselves, and can't change their own access.</p>
      </div>`);
  }

  on(main, 'click', '[data-view]', (_e, b) => {
    if (pending.size && !confirm('Discard unsaved matrix changes?')) return;
    pending = new Map();
    view = b.dataset.view!;
    $$('[data-view]', main).forEach((x) => x.classList.toggle('on', x === b));
    draw();
  });
  $('#pq', main)!.addEventListener('input', debounce((e: Event) => { search = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); }, 140));
  $('#newPerm', main)?.addEventListener('click', newPerm);

  draw();
  drawContext();
  const guard = (e: BeforeUnloadEvent) => { if (pending.size) e.preventDefault(); };
  window.addEventListener('beforeunload', guard);
  cleanup(() => { window.removeEventListener('beforeunload', guard); document.querySelectorAll('.modal-root').forEach((x) => x.remove()); });
}
