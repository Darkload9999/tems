// Tiny rendering + interaction kit: safe html templates, toasts, modals, formatting.
import { icon } from './icons';

/* ---------- safe templating ---------- */
export class Raw { constructor(public readonly v: string) {} toString() { return this.v; } }
export const raw = (v: string) => new Raw(v);

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function part(v: unknown): string {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.v;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
/** Tagged template: interpolations are escaped unless wrapped in raw() / produced by html``. */
export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}
export const ico = (name: string, cls = '') => raw(icon(name, cls));

export function mount(el: Element | null, content: Raw) {
  if (el) el.innerHTML = content.v;
}
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

/** Event delegation: on(root, 'click', '[data-act=edit]', (e, el) => …) */
export function on<K extends keyof HTMLElementEventMap>(
  root: Element | Document, type: K, sel: string,
  fn: (e: HTMLElementEventMap[K], el: HTMLElement) => void,
) {
  const h = (e: Event) => {
    const t = (e.target as Element | null)?.closest?.(sel) as HTMLElement | null;
    if (t && root.contains(t)) fn(e as HTMLElementEventMap[K], t);
  };
  root.addEventListener(type, h);
  return () => root.removeEventListener(type, h);
}

/* ---------- formatting ---------- */
export const fullName = (u: { firstName?: string; lastName?: string; username?: string }) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '—';

export function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : (p[0]?.[1] ?? ''))).toUpperCase();
}

const HUES = [262, 280, 248, 296, 232, 270, 310, 255];
export function avatar(name: string, cls = '') {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return html`<span class="avatar ${cls}" style="background:linear-gradient(135deg,hsl(${hue} 72% 60%),hsl(${hue + 8} 70% 30%))">${initials(name)}</span>`;
}

export function rel(iso: string | null | undefined) {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/* ---------- toasts ---------- */
export function toast(title: string, sub = '', kind: 'ok' | 'err' | 'mail' | 'info' = 'ok') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : kind === 'mail' ? 'mail' : 'info';
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = html`<span class="ti">${ico(ic)}</span><div>${title}${sub ? html`<small>${sub}</small>` : ''}</div>`.v;
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 360); }, kind === 'err' ? 6500 : 4200);
}

/* ---------- modals ---------- */
export interface ModalAction {
  label: string;
  kind?: 'primary' | 'ghost' | 'danger' | 'soft';
  icon?: string;
  /** Return false to keep the modal open. Throwing shows an error toast and keeps it open. */
  onClick?: (ctx: ModalCtx) => unknown | Promise<unknown>;
  id?: string;
}
export interface ModalCtx { root: HTMLElement; body: HTMLElement; close: () => void; setBusy: (b: boolean) => void; }
export interface ModalOpts { title: string; sub?: string; body: Raw; actions?: ModalAction[]; wide?: boolean; onOpen?: (ctx: ModalCtx) => void; }

export function modal(opts: ModalOpts): ModalCtx {
  const root = document.createElement('div');
  root.className = 'modal-root';
  const actions = opts.actions ?? [{ label: 'Close', kind: 'ghost' }];
  root.innerHTML = html`
    <div class="modal-backdrop" data-close></div>
    <div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">
        <h3 id="m-title">${opts.title}</h3>
        ${opts.sub ? html`<p>${opts.sub}</p>` : ''}
        <button class="icon-btn modal-x" data-close aria-label="Close">${ico('x')}</button>
      </div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-foot">
        ${actions.map((a, i) => html`<button class="btn ${a.kind && a.kind !== 'primary' ? a.kind : ''}" data-i="${i}" ${a.id ? raw(`id="${esc(a.id)}"`) : ''}>${a.icon ? ico(a.icon) : ''}<span>${a.label}</span></button>`)}
      </div>
    </div>`.v;
  document.body.append(root);
  const prevFocus = document.activeElement as HTMLElement | null;
  const body = root.querySelector('.modal-body') as HTMLElement;
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    root.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { root.remove(); prevFocus?.focus?.(); }, 240);
  };
  const setBusy = (b: boolean) => root.querySelectorAll<HTMLButtonElement>('.modal-foot .btn').forEach((x) => (x.disabled = b));
  const ctx: ModalCtx = { root, body, close, setBusy };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) return close();
    const b = t.closest<HTMLButtonElement>('.modal-foot .btn');
    if (!b) return;
    const a = actions[Number(b.dataset.i)];
    if (!a.onClick) return close();
    const label = b.innerHTML;
    let spun = false;
    try {
      let r = a.onClick(ctx);
      if (r instanceof Promise) {          // only async work gets the spinner
        setBusy(true); spun = true;
        b.innerHTML = '<span class="spin"></span><span>Working…</span>';
        r = await r;
      }
      if (r !== false) close();
    } catch (err) {
      toast('Something went wrong', (err as Error).message, 'err');
    } finally {
      if (!closed && spun) { setBusy(false); b.innerHTML = label; }
    }
  });
  // submit-on-enter for forms inside the modal
  root.querySelector('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    root.querySelector<HTMLButtonElement>('.modal-foot .btn:not(.ghost)')?.click();
  });
  requestAnimationFrame(() => (root.querySelector<HTMLElement>('[autofocus], .modal-body input, .modal-body select, .modal-body textarea') ?? root.querySelector<HTMLElement>('.modal-foot .btn'))?.focus());
  opts.onOpen?.(ctx);
  return ctx;
}

/** Destructive confirmation. With `typeToConfirm`, the user must type the value exactly. */
export function confirmDanger(o: { title: string; message: Raw | string; confirm: string; typeToConfirm?: string; onConfirm: () => Promise<unknown> }) {
  const body = html`
    <p style="margin:0 0 14px">${o.message}</p>
    ${o.typeToConfirm ? html`
      <div class="field"><label for="ttc">Type <span class="mono">${o.typeToConfirm}</span> to confirm</label>
      <input id="ttc" class="input" autocomplete="off" autofocus></div>` : ''}`;
  const m = modal({
    title: o.title, body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: o.confirm, kind: 'danger', icon: 'trash', id: 'm-confirm', onClick: () => o.onConfirm() },
    ],
  });
  if (o.typeToConfirm) {
    const btn = m.root.querySelector<HTMLButtonElement>('#m-confirm')!;
    const inp = m.root.querySelector<HTMLInputElement>('#ttc')!;
    btn.disabled = true;
    inp.addEventListener('input', () => (btn.disabled = inp.value !== o.typeToConfirm));
  }
  return m;
}

/* ---------- forms ---------- */
export function formData(root: ParentNode): Record<string, string> {
  const out: Record<string, string> = {};
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((el) => {
    if ((el as HTMLInputElement).type === 'checkbox') out[el.name] = (el as HTMLInputElement).checked ? 'on' : '';
    else if ((el as HTMLInputElement).type === 'radio') { if ((el as HTMLInputElement).checked) out[el.name] = el.value; }
    else out[el.name] = el.value.trim();
  });
  return out;
}

export function requireFields(root: ParentNode, names: string[]): boolean {
  let ok = true;
  for (const n of names) {
    const el = root.querySelector<HTMLInputElement>(`[name="${n}"]`);
    if (!el) continue;
    const bad = !el.value.trim() || (el.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim()));
    el.classList.toggle('invalid', bad);
    if (bad && ok) el.focus();
    if (bad) ok = false;
  }
  if (!ok) throw new Error('Please fill in the highlighted fields.');
  return ok;
}

export function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard', text.length > 48 ? '' : text, 'info'));
}

/** Staggered reveal for freshly rendered children. */
export function stagger(root: ParentNode, sel = '.reveal-item') {
  root.querySelectorAll<HTMLElement>(sel).forEach((el, i) => { el.classList.add('reveal'); el.style.setProperty('--i', String(Math.min(i, 14))); });
}

/** Debounce helper for search inputs. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 220) {
  let t: ReturnType<typeof setTimeout>;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Previous / next pager. Buttons carry data-go="<page>" (never data-page: #page uses that). */
export function pager(total: number, page: number, size: number, noun: string) {
  const pages = Math.max(1, Math.ceil(total / size));
  return html`
    <span>${total} ${noun}${total === 1 ? '' : 's'}</span>
    <span style="display:flex;align-items:center;gap:8px">
      <button class="btn ghost sm" data-go="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${page} of ${pages}</span>
      <button class="btn ghost sm" data-go="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
    </span>`;
}
