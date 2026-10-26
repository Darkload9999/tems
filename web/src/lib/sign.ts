// Public agreement signing: read the agreement behind ?t=<token>, capture a drawn
// signature and the signer's typed name, and submit it once.
import type { PublicAgreement } from './types';
import { getPublicApi } from './api';
import { fmtDate } from './hr';
import { $, fmt, html, ico, mount } from './ui';

const root = document.getElementById('sign')!;
// Keep the secret out of the address bar (screenshots, history sync), but let a
// reload of this tab still find it.
const KEY = 'tems-sign-token';
const token = (() => {
  const t = new URL(location.href).searchParams.get('t');
  try { if (t) sessionStorage.setItem(KEY, t); return t ?? sessionStorage.getItem(KEY) ?? ''; } catch { return t ?? ''; }
})();
history.replaceState(null, '', location.pathname);

const paragraphs = (body: string) => html`${body.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}`;

function fail(msg: string) {
  mount(root, html`<div class="empty" style="padding:30px 10px">${ico('lock')}<h2 style="margin:6px 0;color:var(--ink)">Can't open this agreement</h2><p>${msg}</p></div>`);
}

function signed(a: PublicAgreement, justNow: boolean) {
  mount(root, html`
    ${justNow ? html`<div class="callout ok">${ico('check')}<div><b>Thank you, ${a.signerName}.</b><p>Your signature was recorded. A confirmation email is on its way and HR has been notified.</p></div></div>` : ''}
    <span class="eyebrow">${a.orgName}</span>
    <h1 class="sign-title">${a.title}</h1>
    <div class="agreement-text">${paragraphs(a.body)}</div>
    <div class="signed-box" style="margin-top:22px">
      <img src="${a.signature ?? ''}" alt="Signature of ${a.signerName}">
      <div><b>${a.signerName}</b><div class="muted" style="font-size:13px">Signed electronically on ${fmt(a.signedAt)}</div></div>
    </div>
    <div class="no-print" style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn soft" id="print">${ico('file')}Print or save as PDF</button></div>`);
  $('#print', root)?.addEventListener('click', () => window.print());
}

function pad(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let drawing = false, strokes = 0, last: [number, number] | null = null;
  const fit = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1c1b20';
    strokes = 0;
  };
  const pos = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.5) strokes++;
    last = p; canvas.dispatchEvent(new Event('change'));
  });
  const end = () => { drawing = false; last = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('pointerleave', end);
  fit();
  return {
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); strokes = 0; canvas.dispatchEvent(new Event('change')); },
    empty: () => strokes < 12, // a real signature is more than a dot or a click
    png: () => canvas.toDataURL('image/png'),
    refit: () => { fit(); canvas.dispatchEvent(new Event('change')); },
  };
}

function form(a: PublicAgreement) {
  mount(root, html`
    <span class="eyebrow">${a.orgName} · for ${a.employeeName}</span>
    <h1 class="sign-title">${a.title}</h1>
    <p class="muted" style="margin:-6px 0 18px">Please read the whole agreement, then sign at the bottom.${a.expiresAt ? ` This link expires on ${fmtDate(a.expiresAt.slice(0, 10))}.` : ''}</p>
    <div class="agreement-text" tabindex="0">${paragraphs(a.body)}</div>
    <form id="sf" class="sign-form" autocomplete="off">
      <div class="field"><label for="nm">Your full name</label><input class="input" id="nm" name="name" value="${a.employeeName}" autocomplete="name" required></div>
      <div class="field"><label for="sig">Your signature</label>
        <div class="sigpad"><canvas id="sig" aria-label="Signature box: draw your signature with a mouse, finger or stylus"></canvas><span class="sig-line">Sign above this line</span>
          <button type="button" class="btn ghost sm" id="clr">${ico('refresh')}Clear</button></div>
        <span class="hint">Draw with your mouse, finger or a stylus.</span></div>
      <label class="choice"><input type="checkbox" id="ok"><div><b>I have read and agree to this agreement</b><span>Signing electronically has the same effect as signing on paper.</span></div></label>
      <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn" id="go" type="submit" disabled>${ico('edit')}Sign agreement</button></div>
    </form>`);
  const canvas = $<HTMLCanvasElement>('#sig', root)!;
  const sp = pad(canvas);
  const go = $<HTMLButtonElement>('#go', root)!, ok = $<HTMLInputElement>('#ok', root)!, nm = $<HTMLInputElement>('#nm', root)!;
  const check = () => { go.disabled = sp.empty() || !ok.checked || nm.value.trim().length < 3; };
  canvas.addEventListener('change', check); ok.addEventListener('change', check); nm.addEventListener('input', check);
  $('#clr', root)!.addEventListener('click', () => sp.clear());
  window.addEventListener('resize', () => sp.refit());
  $('#sf', root)!.addEventListener('submit', async (e) => {
    e.preventDefault();
    check(); if (go.disabled) return;
    go.disabled = true; go.innerHTML = '<span class="spin"></span><span>Signing…</span>';
    try {
      const api = await getPublicApi();
      signed(await api.signAgreement(token, { name: nm.value.trim(), signature: sp.png() }), true);
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      go.disabled = false; go.innerHTML = html`${ico('edit')}<span>Sign agreement</span>`.v;
      const msg = document.createElement('p'); msg.className = 'callout err'; msg.textContent = (err as Error).message;
      $('.callout.err', root)?.remove(); $('#sf', root)!.append(msg);
    }
  });
}

(async () => {
  if (!token) return fail('This page needs the private link from your email. Open the link exactly as it was sent to you.');
  try {
    const a = await (await getPublicApi()).getAgreement(token);
    document.title = `${a.title} · ${a.orgName}`;
    if (a.status === 'signed') signed(a, false); else form(a);
  } catch (err) { fail((err as Error).message); }
})();
