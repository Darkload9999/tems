// Console bootstrap. Runs on every page load (incl. Astro view-transition navigations):
// sign-in → load "me" → permission-aware shell → hand off to the page module.
import { getApi, type Api } from './api';
import { DEMO, accountConsoleUrl, initAuth, logout, setDemoAs, demoAs } from './auth';
import type { Me } from './types';
import { EVENTS } from './email';
import { $, $$, avatar, html, ico, modal, mount, toast } from './ui';

export interface PageCtx {
  api: Api;
  me: Me;
  can: (perm: string) => boolean;
  main: HTMLElement;
  ctx: HTMLElement | null;
  /** Register teardown (window listeners, timers) run before the next navigation. */
  cleanup: (fn: () => void) => void;
  /** Re-fetch sidebar counters after a change. */
  refreshShell: () => void;
}
type PageModule = { default: (c: PageCtx) => Promise<void> | void };

const pages: Record<string, () => Promise<PageModule>> = {
  dashboard: () => import('./pages/dashboard'),
  users: () => import('./pages/users'),
  groups: () => import('./pages/groups'),
  permissions: () => import('./pages/permissions'),
  mail: () => import('./pages/mail'),
  compose: () => import('./pages/compose'),
  audit: () => import('./pages/audit'),
  settings: () => import('./pages/settings'),
  account: () => import('./pages/account'),
  notfound: () => import('./pages/notfound'),
};

let cleanups: Array<() => void> = [];
document.addEventListener('astro:before-swap', () => {
  cleanups.forEach((f) => { try { f(); } catch {} });
  cleanups = [];
  document.body.classList.remove('nav-open');
  closeMenu();
});

/* ---------- persistent shell (wired once; elements survive navigations) ---------- */
let shellWired = false;
function closeMenu() {
  const m = $('#meMenu'); if (m) m.hidden = true;
  $('#meChip')?.setAttribute('aria-expanded', 'false');
}
function wireShell() {
  if (shellWired) return;
  shellWired = true;

  $('#burger')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (document.body.classList.contains('nav-open') && !t.closest('#sidebar, #burger')) document.body.classList.remove('nav-open');
    if (!t.closest('#meMenu, #meChip')) closeMenu();
  });
  $('#sidebar')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) document.body.classList.remove('nav-open'); });

  const sw = $<HTMLInputElement>('#themeSwitch');
  if (sw) {
    sw.checked = document.documentElement.dataset.theme === 'dark';
    sw.addEventListener('change', () => {
      const t = sw.checked ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem('tems-theme', t); } catch {}
    });
  }

  $('#meChip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#meMenu')!;
    m.hidden = !m.hidden;
    $('#meChip')!.setAttribute('aria-expanded', String(!m.hidden));
  });
  $('#signOut')?.addEventListener('click', () => logout());
  $('#viewAs')?.addEventListener('click', () => { closeMenu(); openViewAs(); });

  window.addEventListener('tems:notified', (e) => {
    const { count, event } = (e as CustomEvent<{ count: number; event?: keyof typeof EVENTS }>).detail;
    toast(`Emailed ${count} affected user${count === 1 ? '' : 's'}`, event ? `${EVENTS[event]?.label ?? 'Notification'} · queued in the outbox` : 'Queued in the outbox', 'mail');
    void refreshCounts();
  });
}

async function openViewAs() {
  const { demoUsers } = await import('./demo');
  const current = demoAs();
  const users = demoUsers();
  modal({
    title: 'View as',
    sub: 'Demo only: see the console exactly as another user would, with their permissions.',
    body: html`<div class="checklist" style="max-height:360px">${users.map((u) => html`
      <label class="check-row"><input type="radio" name="as" value="${u.id}" ${(current ? current === u.id : u.label === 'Super admin') ? 'checked' : ''}>
        ${avatar(u.name)}<span class="person"><span class="meta"><b>${u.name}</b><span>${u.label}</span></span></span></label>`)}</div>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Switch user', icon: 'eye', onClick: ({ root }) => {
        const v = root.querySelector<HTMLInputElement>('input[name=as]:checked')?.value;
        if (v) { setDemoAs(v); location.href = '/'; }
      } },
    ],
  });
}

let apiRef: Api | null = null;
let canRef: (p: string) => boolean = () => false;

async function refreshCounts() {
  if (!apiRef || !canRef('dashboard:view')) return;
  try {
    const s = await apiRef.stats();
    const set = (k: string, v: number, warn = false) => $$(`[data-count="${k}"]`).forEach((el) => {
      el.textContent = v ? String(v) : '';
      el.style.color = warn && v ? 'var(--err)' : '';
    });
    set('users', s.users); set('groups', s.groups); set('permissions', s.permissions); set('mailFailed', s.mailFailed, true);
  } catch { /* counters are cosmetic */ }
}

function applyShell(me: Me, can: (p: string) => boolean) {
  const name = me.name || me.username;
  mount($('#meChip'), html`${avatar(name)}<span class="who"><b>${name}</b><span>${me.superAdmin ? 'Super admin' : me.groups[0] ?? 'Member'}</span></span>`);
  const av = $('#meChip .avatar'); if (av) av.style.cssText += ';width:30px;height:30px;border-radius:999px;font-size:11px';
  $('#menuName')!.textContent = name;
  $('#menuEmail')!.textContent = me.email;
  const kc = $<HTMLAnchorElement>('#kcAccount'); if (kc) kc.href = accountConsoleUrl();
  const va = $('#viewAs'); if (va) va.hidden = !DEMO;

  $$('[data-perm]').forEach((el) => {
    if (el.id === 'page') return;
    el.hidden = !can(el.dataset.perm!);
  });
  $$('[data-section]').forEach((s) => { s.hidden = !$$('.sb-link', s).some((a) => !a.hidden); });

  // active nav item = longest matching prefix
  const path = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
  let best: HTMLElement | null = null;
  for (const a of $$('.sb-link')) {
    a.classList.remove('active'); a.removeAttribute('aria-current');
    const href = a.dataset.nav!;
    if ((href === '/' ? path === '/' : path.startsWith(href)) && (!best || href.length > best.dataset.nav!.length)) best = a;
  }
  best?.classList.add('active');
  best?.setAttribute('aria-current', 'page');

  const sw = $<HTMLInputElement>('#themeSwitch'); if (sw) sw.checked = document.documentElement.dataset.theme === 'dark';
}

function renderNoAccess(main: HTMLElement, perm: string) {
  mount(main, html`
    <div class="empty reveal" style="padding:70px 20px">
      ${ico('lock')}
      <h2 style="margin:6px 0 6px;color:var(--ink)">You don't have access to this page</h2>
      <p>It requires the <span class="mono tag">${perm}</span> permission. Ask a super administrator to grant it to you or one of your groups.</p>
      <p style="margin-top:18px"><a class="btn soft" href="/account/">${ico('user')} Go to my account</a></p>
    </div>`);
  mount($('#ctx'), html``);
}

function renderFatal(main: HTMLElement, err: unknown) {
  mount(main, html`
    <div class="empty reveal" style="padding:70px 20px">
      ${ico('warn')}
      <h2 style="margin:6px 0 6px;color:var(--ink)">Techzaz EMS could not load</h2>
      <p>${(err as Error)?.message ?? String(err)}</p>
      <p style="margin-top:18px"><button class="btn" onclick="location.reload()">${ico('refresh')} Try again</button></p>
    </div>`);
}

async function run() {
  const main = document.getElementById('page');
  if (!main) return;
  wireShell();
  $('#demoReset')?.addEventListener('click', async () => {
    const { resetDemo } = await import('./demo');
    resetDemo();
    toast('Demo data reset', 'Users, groups, mail and audit restored to their initial state.');
    setTimeout(() => location.reload(), 600);
  });

  let me: Me;
  try {
    await initAuth();
    apiRef = await getApi();
    me = await apiRef.me();
  } catch (err) {
    renderFatal(main, err);
    return;
  }
  const can = (p: string) => me.superAdmin || me.permissions.includes(p);
  canRef = can;
  applyShell(me, can);
  void refreshCounts();

  const perm = main.dataset.perm;
  if (perm && !can(perm)) return renderNoAccess(main, perm);

  const load = pages[main.dataset.page ?? ''] ?? pages.notfound;
  try {
    const mod = await load();
    await mod.default({
      api: apiRef, me, can, main, ctx: document.getElementById('ctx'),
      cleanup: (f) => cleanups.push(f),
      refreshShell: () => void refreshCounts(),
    });
  } catch (err) {
    console.error(err);
    renderFatal(main, err);
  }
}

document.addEventListener('astro:page-load', run);
