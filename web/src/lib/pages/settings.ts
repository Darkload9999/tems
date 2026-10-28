import type { PageCtx } from '../app';
import type { DocCategory, MailboxConfig, NotifyEvent, Settings, SignatureCategory, User } from '../types';
import { DEMO } from '../auth';
import { EVENTS, FORCED, SIGNATURE_CATEGORIES, signatureHtml } from '../email';
import { DOCS, DOC_ORDER } from '../hr';
import { $, $$, avatar, confirmDanger, fullName, html, ico, mount, on, raw, toast } from '../ui';

export default async function settings({ api, me, main, ctx, cleanup, refreshShell }: PageCtx) {
  let saved: Settings = await api.getSettings();
  let draft: Settings = structuredClone(saved);
  const events = (Object.keys(EVENTS) as NotifyEvent[]).filter((e) => !FORCED.includes(e));
  const eventGroups = [...new Set(events.map((e) => EVENTS[e].group))];

  const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);

  mount(main, html`
    <form id="sform" autocomplete="off">
      <section class="panel reveal" id="sender">
        <div class="panel-head"><div><span class="eyebrow">Mail</span><h3 style="margin-top:2px">Sender identity</h3></div></div>
        <div class="grid-2">
          <div class="field"><label for="s-org">Organization</label><input class="input" id="s-org" data-k="orgName"></div>
          <div class="field"><label for="s-name">Sender name</label><input class="input" id="s-name" data-k="mailFromName"></div>
          <div class="field"><label for="s-from">Sender address</label><input class="input" id="s-from" type="email" data-k="mailFrom"><span class="hint">Must be on a domain with SPF and DKIM records pointing at this server.</span></div>
          <div class="field"><label for="s-reply">Reply-to</label><input class="input" id="s-reply" type="email" data-k="replyTo"><span class="hint">Where replies to notifications go.</span></div>
        </div>
      </section>

      <section class="panel reveal" style="--i:1" id="signatures">
        <div class="panel-head"><div><span class="eyebrow">Mail</span><h3 style="margin-top:2px">Email signatures</h3></div>
          <button type="button" class="btn ghost sm" id="sigAdd">${ico('plus')}Add signature</button></div>
        <p class="muted" style="margin:-4px 0 14px">Team sign-offs added under every email. Pick one per message in Compose; notification emails use the ones chosen below.</p>
        <div id="sigs" class="sig-list"></div>
        <div class="perm-cat" style="margin:18px 0 0"><div class="perm-cat-head"><h4>Signs notification emails</h4></div>
          ${(Object.keys(SIGNATURE_CATEGORIES) as SignatureCategory[]).map((k) => html`
            <div class="perm-row">
              <div><div style="font-weight:700">${SIGNATURE_CATEGORIES[k].label}</div><div class="pd">${SIGNATURE_CATEGORIES[k].desc}</div></div>
              <select class="select" data-sigfor="${k}" style="width:220px" aria-label="Signature for ${SIGNATURE_CATEGORIES[k].label}"></select>
            </div>`)}
        </div>
      </section>

      <section class="panel reveal" style="--i:1" id="mailbox">
        <div class="panel-head"><div><span class="eyebrow">Outlook setup</span><h3 style="margin-top:2px">Work mailbox servers</h3></div></div>
        <p class="muted" style="margin:-4px 0 14px">Sent to a person's personal email when a super admin shares their work email (Users → Outlook setup).</p>
        <div class="grid-3">
          <div class="field"><label for="mb-ih">Incoming server (IMAP)</label><input class="input" id="mb-ih" data-mb="incomingHost"></div>
          <div class="field"><label for="mb-ip">Port</label><input class="input" id="mb-ip" type="number" min="1" max="65535" data-mb="incomingPort" data-num></div>
          <div class="field"><label for="mb-is">Encryption</label><select class="select" id="mb-is" data-mb="incomingSecurity">${['SSL/TLS', 'STARTTLS', 'None'].map((x) => html`<option>${x}</option>`)}</select></div>
          <div class="field"><label for="mb-oh">Outgoing server (SMTP)</label><input class="input" id="mb-oh" data-mb="outgoingHost"></div>
          <div class="field"><label for="mb-op">Port</label><input class="input" id="mb-op" type="number" min="1" max="65535" data-mb="outgoingPort" data-num></div>
          <div class="field"><label for="mb-os">Encryption</label><select class="select" id="mb-os" data-mb="outgoingSecurity">${['SSL/TLS', 'STARTTLS', 'None'].map((x) => html`<option>${x}</option>`)}</select></div>
        </div>
        <div class="field" style="margin:0"><label for="mb-web">Webmail address</label><input class="input" id="mb-web" data-mb="webmail" placeholder="https://mail.techzaz.lk"><span class="hint">Optional. Leave empty if there's no webmail.</span></div>
      </section>

      <section class="panel reveal" style="--i:1" id="security">
        <div class="panel-head"><div><span class="eyebrow">Keycloak realm</span><h3 style="margin-top:2px">Security policy</h3></div></div>
        <div class="grid-2">
          <div class="field"><label for="s-idle">Session idle timeout (minutes)</label><input class="input" id="s-idle" type="number" min="5" max="1440" data-k="sessionIdleMinutes" data-num></div>
          <div class="field"><label for="s-pw">Minimum password length</label><input class="input" id="s-pw" type="number" min="8" max="64" data-k="passwordMinLength" data-num><span class="hint">Upper case, lower case and a digit are always required.</span></div>
        </div>
      </section>

      <section class="panel reveal" style="--i:2" id="onboarding">
        <div class="panel-head"><div><span class="eyebrow">Employees</span><h3 style="margin-top:2px">Required onboarding documents</h3></div></div>
        <p class="muted" style="margin:-4px 0 14px">HR must upload these before an employee can be submitted for approval.</p>
        <div class="doc-picks">${DOC_ORDER.filter((k) => k !== 'agreement').map((k) => html`
          <label class="check-row"><input type="checkbox" data-doc="${k}"> ${DOCS[k].label}${DOCS[k].payroll ? html` <span class="tag">payroll</span>` : ''}</label>`)}</div>
      </section>

      <section class="panel reveal" style="--i:2" id="notifications">
        <div class="panel-head"><div><span class="eyebrow">Affected users</span><h3 style="margin-top:2px">Notification emails</h3></div>
          <div style="display:flex;gap:6px"><button type="button" class="btn ghost sm" data-allev="1">All on</button><button type="button" class="btn ghost sm" data-allev="0">All off</button></div></div>
        <p class="muted" style="margin:-4px 0 14px">Choose which actions email the people they affect. Direct messages from Compose and agreement signing links are always delivered.</p>
        ${eventGroups.map((grp) => html`
          <div class="perm-cat"><div class="perm-cat-head"><h4>${grp}</h4></div>
            ${events.filter((e) => EVENTS[e].group === grp).map((e) => html`
              <label class="perm-row">
                <div><div style="font-weight:700">${EVENTS[e].label}</div><div class="pd">${EVENTS[e].desc}</div></div>
                <span class="switch"><input type="checkbox" data-ev="${e}" aria-label="${EVENTS[e].label}"><span class="track"></span></span>
              </label>`)}
          </div>`)}
      </section>
    </form>

    <section class="panel reveal" style="--i:3" id="super-admins">
      <div class="panel-head"><div><span class="eyebrow">Unrestricted access</span><h3 style="margin-top:2px">Super administrators</h3></div></div>
      <div id="supers"></div>
    </section>

    ${DEMO ? html`
    <section class="panel reveal" style="--i:4">
      <div class="panel-head"><div><span class="eyebrow">Demo</span><h3 style="margin-top:2px">Demo data</h3></div>
        <button class="btn danger sm" id="resetDemo">${ico('refresh')}Reset demo data</button></div>
      <p class="muted" style="margin:0">Restores the seeded users, groups, permissions, outbox and audit trail. Only affects this browser.</p>
    </section>` : ''}
    <div id="sbar"></div>`);

  const sigPreview = (i: number) => mount($(`[data-sigprev="${i}"]`, main), raw(signatureHtml(draft.signatures[i], location.origin)));
  const drawSigs = () => {
    mount($('#sigs', main), draft.signatures.length ? html`${draft.signatures.map((s, i) => html`
      <div class="sig-card">
        <div class="sig-fields">
          <div class="field"><label for="sg-team-${i}">Team</label><input class="input" id="sg-team-${i}" data-sig="${i}" data-f="team" value="${s.team}"></div>
          <div class="field"><label for="sg-co-${i}">Company</label><input class="input" id="sg-co-${i}" data-sig="${i}" data-f="company" value="${s.company}"></div>
          <div class="field"><label for="sg-em-${i}">Email</label><input class="input" id="sg-em-${i}" type="email" data-sig="${i}" data-f="email" value="${s.email}"></div>
          <div class="field"><label for="sg-ph-${i}">Mobile</label><input class="input" id="sg-ph-${i}" data-sig="${i}" data-f="phone" value="${s.phone}"></div>
          <div class="field"><label for="sg-web-${i}">Web</label><input class="input" id="sg-web-${i}" data-sig="${i}" data-f="web" value="${s.web}"></div>
        </div>
        <div class="sig-side">
          <div class="sig-preview" data-sigprev="${i}"></div>
          <button type="button" class="btn ghost sm" data-sigrm="${i}">${ico('trash')}Remove</button>
        </div>
      </div>`)}` : html`<div class="empty" style="padding:24px">${ico('mail')}No signatures yet.</div>`);
    draft.signatures.forEach((_s, i) => sigPreview(i));
    drawSigFor();
  };
  const drawSigFor = () => $$<HTMLSelectElement>('[data-sigfor]', main).forEach((sel) => {
    mount(sel, html`<option value="">No signature</option>${draft.signatures.map((s) => html`<option value="${s.id}">${s.team || 'Untitled'}</option>`)}`);
    sel.value = draft.signatureFor[sel.dataset.sigfor as SignatureCategory] ?? '';
  });

  const fill = () => {
    $$<HTMLInputElement>('[data-k]', main).forEach((i) => (i.value = String(draft[i.dataset.k as keyof Settings] ?? '')));
    $$<HTMLInputElement>('[data-mb]', main).forEach((i) => (i.value = String(draft.mailbox[i.dataset.mb as keyof MailboxConfig] ?? '')));
    drawSigs();
    $$<HTMLInputElement>('[data-ev]', main).forEach((i) => (i.checked = !!draft.notifications[i.dataset.ev as NotifyEvent]));
    $$<HTMLInputElement>('[data-doc]', main).forEach((i) => (i.checked = draft.requiredDocuments.includes(i.dataset.doc as DocCategory)));
  };
  const drawBar = () => mount($('#sbar', main), dirty() ? html`
    <div class="savebar"><span>${ico('info', 'inline-ico')} <b>Unsaved settings</b></span><span class="spacer"></span>
      <button class="btn ghost sm" id="sDiscard">Discard</button><button class="btn on-violet sm" id="sSave">${ico('check')}Save settings</button></div>` : html``);

  on(main, 'input', '[data-k]', (_e, el) => {
    const k = el.dataset.k as keyof Settings;
    const v = (el as HTMLInputElement).value;
    (draft as unknown as Record<string, unknown>)[k] = el.hasAttribute('data-num') ? Number(v) : v;
    drawBar();
  });
  on(main, 'input', '[data-sig]', (_e, el) => {
    const i = Number(el.dataset.sig);
    (draft.signatures[i] as unknown as Record<string, string>)[el.dataset.f!] = (el as HTMLInputElement).value;
    sigPreview(i);
    if (el.dataset.f === 'team') drawSigFor();
    drawBar();
  });
  on(main, 'click', '#sigAdd', () => {
    const n = draft.signatures.length + 1;
    draft.signatures.push({ id: `team-${Date.now().toString(36)}`, team: `New team ${n}`, company: draft.signatures[0]?.company ?? draft.orgName, email: '', phone: '', web: 'techzaz.lk' });
    drawSigs(); drawBar();
    $<HTMLInputElement>(`#sg-team-${n - 1}`, main)?.select();
  });
  on(main, 'click', '[data-sigrm]', (_e, b) => {
    const [gone] = draft.signatures.splice(Number(b.dataset.sigrm), 1);
    (Object.keys(draft.signatureFor) as SignatureCategory[]).forEach((k) => { if (draft.signatureFor[k] === gone.id) draft.signatureFor[k] = ''; });
    drawSigs(); drawBar();
  });
  on(main, 'change', '[data-sigfor]', (_e, el) => { draft.signatureFor[el.dataset.sigfor as SignatureCategory] = (el as HTMLSelectElement).value; drawBar(); });
  on(main, 'input', '[data-mb]', (_e, el) => {
    const v = (el as HTMLInputElement).value;
    (draft.mailbox as unknown as Record<string, unknown>)[el.dataset.mb!] = el.hasAttribute('data-num') ? Number(v) : v;
    drawBar();
  });
  on(main, 'change', 'select[data-mb]', (_e, el) => { (draft.mailbox as unknown as Record<string, unknown>)[el.dataset.mb!] = (el as HTMLSelectElement).value; drawBar(); });
  on(main, 'change', '[data-doc]', () => {
    draft.requiredDocuments = $$<HTMLInputElement>('[data-doc]', main).filter((i) => i.checked).map((i) => i.dataset.doc as DocCategory);
    drawBar();
  });
  on(main, 'change', '[data-ev]', (_e, el) => { draft.notifications[el.dataset.ev as NotifyEvent] = (el as HTMLInputElement).checked; drawBar(); });
  on(main, 'click', '[data-allev]', (_e, b) => { events.forEach((e) => (draft.notifications[e] = b.dataset.allev === '1')); fill(); drawBar(); });
  on(main, 'click', '#sDiscard', () => { draft = structuredClone(saved); fill(); drawBar(); });
  on(main, 'click', '#sSave', async (_e, b) => {
    b.setAttribute('disabled', '');
    try { saved = await api.saveSettings(draft); draft = structuredClone(saved); fill(); toast('Settings saved'); }
    catch (err) { toast('Not saved', (err as Error).message, 'err'); }
    drawBar();
  });
  $('#resetDemo', main)?.addEventListener('click', () => confirmDanger({
    title: 'Reset demo data', confirm: 'Reset', message: 'All changes you made in this demo will be lost.',
    onConfirm: async () => { const { resetDemo } = await import('../demo'); resetDemo(); location.reload(); },
  }));

  /* super admins */
  async function drawSupers() {
    let all: User[];
    try { all = (await api.listUsers({ size: 100_000 })).items; }
    catch (err) { mount($('#supers', main), html`<p class="muted" style="margin:0">${(err as Error).message}</p>`); return; }
    const supers = all.filter((u) => u.superAdmin);
    const others = all.filter((u) => !u.superAdmin && u.enabled);
    mount($('#supers', main), html`
      <p class="muted" style="margin:-4px 0 12px">${me.superAdmin ? 'Super admins bypass every permission check. Keep this list short. At least one must always remain.' : 'Only super administrators can change this list.'}</p>
      ${supers.map((u: User) => html`
        <div class="perm-row">
          <div class="person">${avatar(fullName(u))}<div class="meta"><b>${fullName(u)}${u.id === me.id ? ' (you)' : ''}</b><span>${u.email}</span></div></div>
          ${me.superAdmin && u.id !== me.id && supers.length > 1 ? html`<button class="btn ghost sm" data-revoke="${u.id}">${ico('ban')}Revoke</button>` : html`<span class="tag dark">${ico('crown')}Super admin</span>`}
        </div>`)}
      ${me.superAdmin && others.length ? html`
        <div class="toolbar" style="margin:14px 0 0">
          <select class="select" id="grantSel" style="max-width:340px" aria-label="Person to promote">${others.map((u) => html`<option value="${u.id}">${fullName(u)} · ${u.email}</option>`)}</select>
          <button class="btn" id="grantBtn">${ico('crown')}Make super admin</button>
        </div>` : ''}`);
  }
  on(main, 'click', '[data-revoke]', (_e, b) => confirmDanger({
    title: 'Revoke super admin', confirm: 'Revoke', message: 'They keep the access their groups and personal permissions grant, and will be emailed.',
    onConfirm: async () => { await api.setSuperAdmin(b.dataset.revoke!, false); toast('Super admin revoked'); await drawSupers(); refreshShell(); },
  }));
  on(main, 'click', '#grantBtn', () => {
    const id = $<HTMLSelectElement>('#grantSel', main)!.value;
    confirmDanger({
      title: 'Grant super admin', confirm: 'Grant unrestricted access',
      message: 'This person will be able to do everything in Techzaz EMS, including managing other super admins. They will be emailed.',
      onConfirm: async () => { await api.setSuperAdmin(id, true); toast('Super admin granted'); await drawSupers(); refreshShell(); },
    });
  });

  fill();
  await drawSupers();
  mount(ctx, html`
    <div class="ctx-card">
      <div class="ctx-label">On This Page:</div>
      <a href="#sender">Sender identity</a><a href="#signatures">Email signatures</a><a href="#mailbox">Work mailbox servers</a><a href="#security">Security policy</a><a href="#onboarding">Onboarding documents</a><a href="#notifications">Notification emails</a><a href="#super-admins">Super administrators</a>
    </div>
    <div class="ctx-card">
      <div class="ctx-label">Where it applies:</div>
      <p style="margin:0;font-size:13px">Security policy is written to the Keycloak realm. Sender details are used by Postfix for every outgoing message.</p>
    </div>`);

  const guard = (e: BeforeUnloadEvent) => { if (dirty()) e.preventDefault(); };
  window.addEventListener('beforeunload', guard);
  cleanup(() => window.removeEventListener('beforeunload', guard));
}
