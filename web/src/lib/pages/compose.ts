import { navigate } from 'astro:transitions/client';
import type { PageCtx } from '../app';
import type { User } from '../types';
import { DEFAULT_FOOTER, renderEmail } from '../email';
import { $, $$, avatar, debounce, fullName, html, ico, mount, on, toast } from '../ui';

export default async function compose({ api, me, main, ctx }: PageCtx) {
  const [groups, people, sigs] = await Promise.all([
    api.listGroups(), api.listUsers({ size: 100_000 }).then((r) => r.items),
    api.listSignatures().catch(() => ({ signatures: [], signatureFor: { accounts: '', people: '', work: '' }, signatureFooter: DEFAULT_FOOTER })),
  ]);
  const active = people.filter((u) => u.enabled);
  const pickedGroups = new Set<string>();
  const pickedUsers = new Set<string>();
  const preset = new URL(location.href).searchParams.get('to');
  if (preset && active.some((u) => u.id === preset)) pickedUsers.add(preset);

  mount(main, html`
    <form id="cform" autocomplete="off" class="reveal">
      <div class="field">
        <label>Groups</label>
        <div class="tags" id="gpick">${groups.map((g) => html`
          <button type="button" class="tag" data-g="${g.id}" style="height:30px;padding:0 12px;border:1px solid var(--line-2);cursor:pointer">${ico('group')}${g.name} · ${g.memberCount}</button>`)}</div>
        <span class="hint">Everyone in a selected group receives the message. People in several groups get it once.</span>
      </div>
      <div class="field">
        <label for="upick">People</label>
        <div class="tags" id="uchips" style="margin-bottom:6px"></div>
        <label class="search" style="max-width:none">${ico('search')}<input class="input" id="upick" type="search" placeholder="Add a person by name or email…"></label>
        <div class="checklist" id="ulist" style="max-height:220px;margin-top:6px" hidden></div>
      </div>
      <div class="field"><label for="csub">Subject</label><input class="input" id="csub" name="subject" maxlength="140" placeholder="e.g. Scheduled maintenance this Saturday"></div>
      <div class="field"><label for="cmsg">Message</label><textarea class="textarea" id="cmsg" name="message" style="min-height:180px" placeholder="Write your message. Blank lines start a new paragraph."></textarea></div>
      <div class="field"><label for="csig">Signature</label>
        <select class="select" id="csig" style="max-width:360px">
          <option value="">No signature</option>
          ${sigs.signatures.map((s) => html`<option value="${s.id}">${s.name}${s.title ? ` · ${s.title}` : ''}</option>`)}
        </select>
        <span class="hint">Signatures, partner badges and the disclaimer are managed in Settings → Email signatures.</span></div>
      <div class="toolbar" style="margin-top:4px">
        <span class="muted" id="ccount">No recipients yet</span><span class="spacer"></span>
        <a class="btn ghost" href="/mail/">Cancel</a>
        <button class="btn" type="submit" id="csend">${ico('send')}Send message</button>
      </div>
    </form>
    <h2 class="section-mega" style="font-size:28px;margin-top:30px">Preview.</h2>
    <iframe class="mail-frame" id="cprev" title="Email preview" sandbox="allow-same-origin"></iframe>`);

  const recipients = (): User[] => {
    const ids = new Set(pickedUsers);
    active.forEach((u) => { if (u.groups.some((g) => pickedGroups.has(g))) ids.add(u.id); });
    return active.filter((u) => ids.has(u.id));
  };

  const drawPicks = () => {
    $$('[data-g]', main).forEach((b) => {
      const picked = pickedGroups.has(b.dataset.g!);
      b.classList.toggle('dark', picked);
      b.style.borderColor = picked ? 'transparent' : '';
    });
    mount($('#uchips', main), html`${[...pickedUsers].map((id) => {
      const u = active.find((x) => x.id === id)!;
      return html`<span class="tag info" style="height:28px">${fullName(u)}<button type="button" data-unpick="${u.id}" aria-label="Remove ${fullName(u)}" style="border:0;background:none;padding:0;margin-left:2px;display:grid;color:inherit">${ico('x')}</button></span>`;
    })}`);
    const r = recipients();
    $('#ccount', main)!.textContent = r.length ? `${r.length} recipient${r.length === 1 ? '' : 's'} · from no-reply@tems.techzaz.lk` : 'No recipients yet';
    drawContext(r);
  };

  const drawPreview = () => {
    const f = { subject: $<HTMLInputElement>('#csub', main)!.value, message: $<HTMLTextAreaElement>('#cmsg', main)!.value };
    const signature = sigs.signatures.find((s) => s.id === $<HTMLSelectElement>('#csig', main)!.value) ?? null;
    const sample = recipients()[0];
    const r = renderEmail('mail.direct', {
      origin: location.origin, firstName: sample?.firstName ?? 'there', username: sample?.username, actor: me.name,
      subject: f.subject || 'Your subject', message: f.message || 'Your message appears here.', signature, footer: sigs.signatureFooter,
    });
    $<HTMLIFrameElement>('#cprev', main)!.srcdoc = r.html;
  };

  function drawContext(r: User[]) {
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">Recipients:</div>
        ${r.length ? html`${r.slice(0, 8).map((u) => html`<div class="person" style="padding:4px 0">${avatar(fullName(u))}<span class="meta"><b>${fullName(u)}</b><span>${u.email}</span></span></div>`)}
          ${r.length > 8 ? html`<p class="muted" style="margin:6px 0 0">and ${r.length - 8} more</p>` : ''}` : html`<p style="margin:0">Pick groups or people.</p>`}
      </div>
      <div class="ctx-card">
        <div class="ctx-label">Delivery:</div>
        <p style="margin:0;font-size:13px">Each person receives their own copy (no one sees other recipients). Disabled accounts are skipped. Track delivery in the Outbox.</p>
      </div>`);
  }

  // groups
  on(main, 'click', '[data-g]', (_e, b) => { const g = b.dataset.g!; pickedGroups.has(g) ? pickedGroups.delete(g) : pickedGroups.add(g); drawPicks(); drawPreview(); });
  // people search
  const ulist = $('#ulist', main)!;
  $('#upick', main)!.addEventListener('input', debounce((e: Event) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    const hits = q ? active.filter((u) => !pickedUsers.has(u.id) && `${fullName(u)} ${u.email} ${u.username}`.toLowerCase().includes(q)).slice(0, 8) : [];
    ulist.hidden = !hits.length;
    mount(ulist, html`${hits.map((u) => html`<button type="button" class="check-row" data-pick="${u.id}" style="width:100%;border:0;border-bottom:1px solid var(--line);background:none;text-align:left">${avatar(fullName(u))}<span class="person"><span class="meta"><b>${fullName(u)}</b><span>${u.email}</span></span></span></button>`)}`);
  }, 120));
  on(main, 'click', '[data-pick]', (_e, b) => {
    pickedUsers.add(b.dataset.pick!);
    const inp = $<HTMLInputElement>('#upick', main)!; inp.value = ''; ulist.hidden = true; inp.focus();
    drawPicks(); drawPreview();
  });
  on(main, 'click', '[data-unpick]', (_e, b) => { pickedUsers.delete(b.dataset.unpick!); drawPicks(); drawPreview(); });
  ['#csub', '#cmsg'].forEach((s) => $(s, main)!.addEventListener('input', debounce(drawPreview, 180)));
  const sigSel = $<HTMLSelectElement>('#csig', main)!;
  sigSel.value = sigs.signatures.some((s) => s.id === sigs.signatureFor.accounts) ? sigs.signatureFor.accounts : (sigs.signatures[0]?.id ?? '');
  sigSel.addEventListener('change', drawPreview);

  $('#cform', main)!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>('#csend', main)!;
    const subject = $<HTMLInputElement>('#csub', main)!.value.trim();
    const message = $<HTMLTextAreaElement>('#cmsg', main)!.value.trim();
    btn.disabled = true;
    try {
      const { queued } = await api.compose({ userIds: [...pickedUsers], groupIds: [...pickedGroups], subject, message, signature: sigSel.value });
      toast(`Message queued for ${queued} recipient${queued === 1 ? '' : 's'}`, subject, 'mail');
      await navigate('/mail/');
    } catch (err) {
      btn.disabled = false;
      toast('Not sent', (err as Error).message, 'err');
    }
  });

  drawPicks();
  drawPreview();
}
