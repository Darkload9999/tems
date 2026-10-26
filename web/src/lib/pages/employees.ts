import type { PageCtx } from '../app';
import type { Agreement, DocCategory, Employee, EmployeeDocument, EmployeeStage, Payroll, User } from '../types';
import {
  DOCS, DOC_ORDER, EMPLOYMENT, STAGES, STAGE_LABEL, agreementTag, agreementTemplate, contributions, empName,
  fileSize, fmtDate, money, stageTag,
} from '../hr';
import {
  $, $$, avatar, confirmDanger, copy, debounce, fmt, formData, html, ico, modal, mount, on, rel, requireFields, stagger, toast,
  type Raw,
} from '../ui';

const SIZE = 12;

export default async function employees(c: PageCtx) {
  const id = new URL(location.href).searchParams.get('id');
  return id ? detail(c, id) : list(c);
}

/* ======================= list ======================= */

async function list(c: PageCtx) {
  const { api, can, main, ctx, refreshShell } = c;
  const url = new URL(location.href);
  const st = { search: url.searchParams.get('q') ?? '', stage: (url.searchParams.get('stage') ?? 'all') as EmployeeStage | 'all', page: 1 };

  mount(main, html`
    <div class="pipeline reveal" id="pipe"></div>
    <div class="toolbar reveal" style="--i:1">
      <label class="search">${ico('search')}<span class="sr-only">Search employees</span>
        <input class="input" id="q" type="search" placeholder="Search name, email, code, NIC…" value="${st.search}"></label>
      <span class="spacer"></span>
      ${can('employees:manage') ? html`<button class="btn" id="newEmp">${ico('userPlus')}New employee</button>` : ''}
    </div>
    <div class="tbl-wrap reveal" style="--i:2">
      <table class="tbl">
        <thead><tr><th>Employee</th><th>Code</th><th>Role</th><th>Stage</th><th>Docs</th><th>Starts</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="pager" id="pager"></div>`);

  async function drawPipeline() {
    const all = await api.listEmployees({ size: 100_000 });
    const count = (s: EmployeeStage) => all.items.filter((e) => e.stage === s).length;
    const chips: Array<[EmployeeStage | 'all', string, number]> = [
      ['all', 'Everyone', all.items.filter((e) => e.stage !== 'offboarded').length],
      ...STAGES.map((s) => [s.key, s.key === 'active' ? 'Active' : STAGE_LABEL[s.key], count(s.key)] as [EmployeeStage, string, number]),
      ['offboarded', 'Offboarded', count('offboarded')],
    ];
    mount($('#pipe', main), html`${chips.map(([k, l, n]) => html`
      <button class="pipe ${st.stage === k ? 'on' : ''}" data-stage="${k}"><b>${n}</b><span>${l}</span></button>`)}`);
    drawContext(all.items);
  }

  async function load() {
    const tbody = $('#rows', main)!;
    tbody.style.opacity = '.55';
    const res = await api.listEmployees({ search: st.search, stage: st.stage, page: st.page, size: SIZE });
    tbody.style.opacity = '';
    mount(tbody, res.items.length ? html`${res.items.map((e) => html`
      <tr class="clickable reveal-item" data-id="${e.id}" tabindex="0">
        <td><div class="person">${avatar(empName(e))}<div class="meta"><b>${empName(e)}</b><span>${e.email}</span></div></div></td>
        <td class="mono">${e.code}</td>
        <td>${e.jobTitle || '—'}<div class="muted" style="font-size:12.5px">${e.department}</div></td>
        <td>${stageTag(e.stage)}</td>
        <td>${e.documentCount}${e.missingDocuments.length && e.stage === 'documents' ? html` <span class="tag warn">${e.missingDocuments.length} missing</span>` : ''}</td>
        <td>${fmtDate(e.startDate)}</td>
      </tr>`)}` : html`<tr><td colspan="6"><div class="empty">${ico('users')}${st.search || st.stage !== 'all' ? 'No employees match.' : 'No employees yet. Start an onboarding with “New employee”.'}</div></td></tr>`);
    stagger(tbody);
    const pages = Math.max(1, Math.ceil(res.total / SIZE));
    mount($('#pager', main), html`<span>${res.total} employee${res.total === 1 ? '' : 's'}</span>
      <span style="display:flex;align-items:center;gap:8px">
        <button class="btn ghost sm" data-go="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${st.page} of ${pages}</span>
        <button class="btn ghost sm" data-go="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>Next</button></span>`);
    const u = new URL(location.href);
    st.search ? u.searchParams.set('q', st.search) : u.searchParams.delete('q');
    st.stage !== 'all' ? u.searchParams.set('stage', st.stage) : u.searchParams.delete('stage');
    history.replaceState(history.state, '', u);
  }

  function drawContext(all: Employee[]) {
    const waiting = all.filter((e) => e.stage === 'approval');
    mount(ctx, html`
      <div class="ctx-card">
        <div class="ctx-label">Onboarding:</div>
        ${STAGES.map((s, i) => html`<div class="ctx-stat"><span>${i + 1}. ${s.label}</span><b>${all.filter((e) => e.stage === s.key).length}</b></div>`)}
      </div>
      ${waiting.length && can('employees:approve') ? html`
        <div class="ctx-card"><div class="ctx-label">Waiting for you:</div>
          ${waiting.map((e) => html`<a href="/employees/?id=${e.id}">${empName(e)} <span class="muted">· ${e.jobTitle}</span></a>`)}</div>` : ''}
      <div class="ctx-card">
        <div class="ctx-label">How it works:</div>
        <p style="margin:0">HR uploads the required documents and submits the employee. Another admin approves. HR then sends the agreement: the candidate gets a private link, reads it and signs in the signature box. Signing completes the onboarding. The employee is emailed at every step.</p>
      </div>`);
  }

  $('#q', main)!.addEventListener('input', debounce((e: Event) => { st.search = (e.target as HTMLInputElement).value.trim(); st.page = 1; void load(); }));
  on(main, 'click', '[data-stage]', (_e, b) => { st.stage = b.dataset.stage as typeof st.stage; st.page = 1; $$('.pipe', main).forEach((x) => x.classList.toggle('on', x === b)); void load(); });
  on(main, 'click', '[data-go]', (_e, b) => { st.page = Number(b.dataset.go); void load(); });
  const open = (id: string) => { location.href = `/employees/?id=${encodeURIComponent(id)}`; };
  on(main, 'click', 'tr[data-id]', (_e, tr) => open(tr.dataset.id!));
  on(main, 'keydown', 'tr[data-id]', (e, tr) => { if ((e as KeyboardEvent).key === 'Enter') open(tr.dataset.id!); });
  $('#newEmp', main)?.addEventListener('click', () => employeeForm(c, null, async (e) => { refreshShell(); open(e.id); }));

  await Promise.all([drawPipeline(), load()]);
}

/* ======================= create / edit form ======================= */

function employeeForm(c: PageCtx, e: Employee | null, done: (e: Employee) => void | Promise<void>) {
  const v = (k: keyof Employee) => (e ? String(e[k] ?? '') : '');
  modal({
    title: e ? `Edit ${empName(e)}` : 'New employee',
    sub: e ? 'The employee is emailed a summary of what changed.' : 'Starts the onboarding. The employee gets a welcome email explaining the next steps.',
    wide: true,
    body: html`<form autocomplete="off">
      <div class="grid-2">
        <div class="field"><label for="f-first">First name</label><input class="input" id="f-first" name="firstName" value="${v('firstName')}" autofocus></div>
        <div class="field"><label for="f-last">Last name</label><input class="input" id="f-last" name="lastName" value="${v('lastName')}"></div>
        <div class="field"><label for="f-email">Personal email</label><input class="input" id="f-email" name="email" type="email" value="${v('email')}"><span class="hint">Where onboarding emails and the agreement link are sent.</span></div>
        <div class="field"><label for="f-phone">Phone</label><input class="input" id="f-phone" name="phone" value="${v('phone')}" placeholder="+94 7X XXX XXXX"></div>
        <div class="field"><label for="f-nic">NIC number</label><input class="input" id="f-nic" name="nic" value="${v('nic')}" placeholder="199512345678"></div>
        <div class="field"><label for="f-dob">Date of birth</label><input class="input" id="f-dob" name="dateOfBirth" type="date" value="${v('dateOfBirth')}"></div>
        <div class="field"><label for="f-dept">Department</label><input class="input" id="f-dept" name="department" value="${v('department')}"></div>
        <div class="field"><label for="f-job">Job title</label><input class="input" id="f-job" name="jobTitle" value="${v('jobTitle')}"></div>
        <div class="field"><label for="f-type">Employment type</label><select class="select" id="f-type" name="employmentType">
          ${Object.entries(EMPLOYMENT).map(([k, l]) => html`<option value="${k}" ${(e?.employmentType ?? 'probation') === k ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div class="field"><label for="f-start">Start date</label><input class="input" id="f-start" name="startDate" type="date" value="${v('startDate')}"></div>
      </div>
      <div class="field"><label for="f-addr">Address</label><textarea class="textarea" id="f-addr" name="address" style="min-height:64px">${v('address')}</textarea></div>
    </form>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: e ? 'Save' : 'Start onboarding', icon: e ? 'check' : 'userPlus', onClick: async ({ body }) => {
        requireFields(body, ['firstName', 'email']);
        const f = formData(body);
        const input = {
          firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, nic: f.nic, dateOfBirth: f.dateOfBirth,
          address: f.address, department: f.department, jobTitle: f.jobTitle, employmentType: f.employmentType as Employee['employmentType'], startDate: f.startDate,
        };
        const saved = e ? await c.api.updateEmployee(e.id, input) : await c.api.createEmployee(input);
        toast(e ? 'Employee saved' : `Onboarding started for ${empName(saved)}`, e ? empName(saved) : `${saved.code} · welcome email queued`);
        await done(saved);
      } },
    ],
  });
}

/* ======================= detail ======================= */

async function detail(c: PageCtx, id: string) {
  const { api, me, can, main, ctx, cleanup, refreshShell } = c;
  let e: Employee;
  try { e = await api.getEmployee(id); }
  catch (err) {
    mount(main, html`<div class="empty" style="padding:60px 20px">${ico('users')}${(err as Error).message}<p><a class="btn soft" href="/employees/">${ico('arrow')}All employees</a></p></div>`);
    return;
  }
  const url = new URL(location.href);
  let tab = url.searchParams.get('tab') ?? 'profile';
  let docs: EmployeeDocument[] = [];
  let agreements: Agreement[] = [];
  const objectUrls: string[] = [];
  cleanup(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)));
  const orgName = await api.getSettings().then((s) => s.orgName).catch(() => 'Techzaz Networks');

  async function reload(all = true) {
    e = await api.getEmployee(id);
    if (all) [docs, agreements] = await Promise.all([api.listDocuments(id), api.listAgreements(id)]);
    frame();
    refreshShell();
  }

  function stepper() {
    const idx = e.stage === 'offboarded' ? -1 : STAGES.findIndex((s) => s.key === e.stage);
    return html`<ol class="stepper">${STAGES.map((s, i) => html`
      <li class="${e.stage === 'active' || i < idx ? 'done' : i === idx ? 'on' : ''}">
        <span class="badge-num">${e.stage === 'active' || i < idx ? ico('check') : i + 1}</span><span>${s.label}</span></li>`)}</ol>`;
  }

  /** The "what happens next" panel for the current stage. */
  function nextStep(): Raw {
    const decision = e.lastDecision;
    const rejected = decision?.decision === 'rejected' && e.stage === 'documents'
      ? html`<div class="callout warn">${ico('warn')}<div><b>Sent back by ${decision.by}</b> · ${rel(decision.at)}<p>${decision.note}</p></div></div>` : '';
    switch (e.stage) {
      case 'documents': {
        const missing = e.missingDocuments;
        return html`${rejected}
          <div class="callout">${ico('file')}<div>
            <b>Step 1 · Collect documents</b>
            <p>${missing.length ? html`Still needed: ${missing.map((m) => html`<span class="tag warn" style="margin:2px">${DOCS[m].label}</span>`)}` : 'All required documents are uploaded. Submit the employee for approval.'}</p>
            <div class="callout-actions">
              ${can('employees:manage') ? html`<button class="btn sm soft" data-a="tab" data-t="documents">${ico('plus')}Upload documents</button>
                <button class="btn sm" data-a="submit" ${missing.length ? 'disabled' : ''}>${ico('send')}Submit for approval</button>` : ''}
            </div></div></div>`;
      }
      case 'approval': {
        const own = !me.superAdmin && e.submittedBy === me.name;
        return html`<div class="callout warn">${ico('shield')}<div>
          <b>Step 2 · Awaiting approval</b>
          <p>Submitted by ${e.submittedBy ?? 'HR'}. Someone with the <span class="mono">employees:approve</span> permission, other than the submitter, reviews the record and documents.</p>
          ${can('employees:approve') ? own ? html`<p class="muted">You submitted this employee, so someone else must approve it.</p>` : html`
            <div class="callout-actions"><button class="btn sm" data-a="approve">${ico('check')}Approve</button>
              <button class="btn sm danger" data-a="reject">${ico('x')}Send back</button></div>` : ''}
          </div></div>`;
      }
      case 'agreement': {
        const live = agreements.find((a) => a.status === 'sent' || a.status === 'viewed');
        return html`<div class="callout">${ico('edit')}<div>
          <b>Step 3 · Agreement signing</b>
          <p>${decision?.decision === 'approved' ? html`Approved by ${decision.by} ${rel(decision.at)}${decision.note ? html` · “${decision.note}”` : ''}. ` : ''}
            ${live ? html`“${live.title}” was ${live.status === 'viewed' ? 'opened by the candidate' : 'sent'} ${rel(live.status === 'viewed' ? live.viewedAt : live.sentAt)} and is waiting for a signature.` : 'Prepare the agreement and send the candidate their private signing link.'}</p>
          ${can('employees:manage') ? html`<div class="callout-actions"><button class="btn sm" data-a="tab" data-t="agreements">${ico(live ? 'eye' : 'plus')}${live ? 'View agreement' : 'Prepare agreement'}</button></div>` : ''}
          </div></div>`;
      }
      case 'active': {
        const signed = agreements.find((a) => a.status === 'signed');
        return html`<div class="callout ok">${ico('check')}<div><b>Onboarding complete</b>
          <p>${signed ? html`${signed.signerName} signed “${signed.title}” on ${fmt(signed.signedAt)}.` : 'This employee is active.'}</p></div></div>`;
      }
      default:
        return html`<div class="callout err">${ico('ban')}<div><b>Offboarded</b><p>This record is closed. Documents and history are kept.</p></div></div>`;
    }
  }

  function frame() {
    mount(main, html`
      <a class="backlink" href="/employees/">${ico('chevronRight', 'flip')}All employees</a>
      <div class="detail-head reveal" style="margin-top:6px">
        ${avatar(empName(e), 'lg')}
        <div style="min-width:0"><h2 style="margin:0;font-size:26px">${empName(e)}</h2>
          <div class="tags" style="margin-top:6px"><span class="tag mono">${e.code}</span>${stageTag(e.stage)}${e.jobTitle ? html`<span class="tag">${e.jobTitle}</span>` : ''}</div></div>
        <div style="margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
          ${can('employees:manage') ? html`<button class="btn soft sm" data-a="edit">${ico('edit')}Edit</button>` : ''}
          ${can('employees:manage') && e.stage !== 'offboarded' ? html`<button class="btn soft sm" data-a="offboard">${ico('logout')}Offboard</button>` : ''}
          ${can('employees:delete') ? html`<button class="btn danger sm" data-a="delete">${ico('trash')}Delete</button>` : ''}
        </div>
      </div>
      ${e.stage !== 'offboarded' ? stepper() : ''}
      <div class="reveal" style="--i:1">${nextStep()}</div>
      <div class="tabs" role="tablist" style="margin-top:20px">
        ${[['profile', 'Profile'], ['documents', `Documents · ${docs.length}`], ...(e.payroll ? [['payroll', 'Payroll']] : []), ['agreements', `Agreements · ${agreements.length}`], ['history', 'History']]
          .map(([k, l]) => html`<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${l}</button>`)}
      </div>
      <div id="tb"></div>`);
    drawTab();
    drawContext();
  }

  function drawTab() {
    const old = $('#tb', main)!;
    const tb = old.cloneNode(false) as HTMLElement; // drop delegated listeners from the previous tab
    old.replaceWith(tb);
    const u = new URL(location.href); u.searchParams.set('tab', tab); history.replaceState(history.state, '', u);
    if (tab === 'documents') return drawDocuments(tb);
    if (tab === 'payroll' && e.payroll) return drawPayroll(tb, e.payroll);
    if (tab === 'agreements') return drawAgreements(tb);
    if (tab === 'history') return void drawHistory(tb);
    tab = 'profile';
    return drawProfile(tb);
  }

  /* ----- profile ----- */
  function drawProfile(tb: HTMLElement) {
    mount(tb, html`
      <dl class="kv reveal">
        <dt>Email</dt><dd>${e.email}</dd>
        <dt>Phone</dt><dd>${e.phone || '—'}</dd>
        <dt>NIC</dt><dd class="mono">${e.nic || '—'}</dd>
        <dt>Date of birth</dt><dd>${fmtDate(e.dateOfBirth)}</dd>
        <dt>Address</dt><dd style="white-space:pre-line">${e.address || '—'}</dd>
        <dt>Department</dt><dd>${e.department || '—'}</dd>
        <dt>Job title</dt><dd>${e.jobTitle || '—'}</dd>
        <dt>Employment</dt><dd>${EMPLOYMENT[e.employmentType]}</dd>
        <dt>Start date</dt><dd>${fmtDate(e.startDate)}</dd>
        <dt>Sign-in account</dt><dd id="acct">${e.userId ? html`<span class="tag ok">${ico('check')}Linked</span>` : html`<span class="muted">Not linked</span>`}</dd>
        <dt>Created</dt><dd>${fmt(e.createdAt)} by ${e.createdBy}</dd>
      </dl>
      ${can('employees:manage') ? html`
        <div class="panel" style="margin-top:20px">
          <div class="panel-head"><div><span class="eyebrow">Techzaz EMS access</span><h3 style="margin-top:2px">Sign-in account</h3></div></div>
          <p class="muted" style="margin:-4px 0 12px">Link the employee to a sign-in account so they see their projects and tickets under <b>My work</b>.</p>
          <div class="toolbar" style="margin:0">
            ${can('users:view') ? html`<select class="select" id="linkSel" style="max-width:340px"><option value="">Loading accounts…</option></select>
              <button class="btn soft sm" data-a="link">${ico('link')}${e.userId ? 'Change link' : 'Link account'}</button>` : ''}
            ${!e.userId && can('users:create') ? html`<button class="btn sm" data-a="mkuser">${ico('userPlus')}Create sign-in account</button>` : ''}
            ${e.userId ? html`<button class="btn ghost sm" data-a="unlink">${ico('x')}Unlink</button>` : ''}
          </div>
        </div>` : ''}`);
    if (can('employees:manage') && can('users:view')) {
      void api.listUsers({ size: 100_000 }).then((r) => {
        const sel = $<HTMLSelectElement>('#linkSel', tb); if (!sel) return;
        const cur = r.items.find((x) => x.id === e.userId);
        if (cur) mount($('#acct', tb), html`<span class="tag ok">${ico('check')}${[cur.firstName, cur.lastName].join(' ')} · @${cur.username}</span>`);
        mount(sel, html`<option value="">Choose an account…</option>${r.items.map((x: User) => html`<option value="${x.id}" ${x.id === e.userId ? 'selected' : ''}>${x.firstName} ${x.lastName} · ${x.email}</option>`)}`);
      }).catch(() => {});
    }
  }

  /* ----- documents ----- */
  function drawDocuments(tb: HTMLElement) {
    const canUp = can('employees:manage') && e.stage !== 'offboarded';
    const payrollOk = !!e.payroll;
    const cats = DOC_ORDER.filter((k) => k !== 'agreement' && (payrollOk || !DOCS[k].payroll));
    const have = new Set(docs.map((d) => d.category));
    const req = DOC_ORDER.filter((k) => e.missingDocuments.includes(k) || (have.has(k) && ['birth_certificate', 'nic', 'education'].includes(k)));
    mount(tb, html`
      ${req.length ? html`<div class="doc-checklist reveal">${req.map((k) => html`
        <span class="${have.has(k) ? 'ok' : 'miss'}">${ico(have.has(k) ? 'check' : 'alert')}${DOCS[k].label}</span>`)}</div>` : ''}
      ${canUp ? html`
        <form class="dropzone reveal" id="up" style="--i:1">
          <div class="grid-2" style="align-items:end">
            <div class="field" style="margin:0"><label for="d-cat">Document type</label><select class="select" id="d-cat" name="category">
              ${cats.map((k) => html`<option value="${k}" ${e.missingDocuments[0] === k ? 'selected' : ''}>${DOCS[k].label}${DOCS[k].payroll ? ' (payroll)' : ''}</option>`)}</select></div>
            <div class="field" style="margin:0"><label for="d-title">Title <span class="muted">(optional)</span></label><input class="input" id="d-title" name="title" placeholder="e.g. BSc Computer Science"></div>
          </div>
          <label class="drop" id="drop">${ico('folder')}<span><b>Choose a file</b> or drop it here</span><small>PDF, PNG, JPEG, WebP, Word or Excel · up to 10 MB</small>
            <input type="file" id="d-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xlsx" hidden></label>
        </form>` : ''}
      <div class="docs" id="docs">${docs.length ? docs.map((d, i) => html`
        <div class="doc reveal" style="--i:${Math.min(i, 10)}">
          <span class="doc-ico">${ico(d.contentType.startsWith('image/') ? 'eye' : 'file')}</span>
          <div style="min-width:0;flex:1"><b>${d.title}</b>
            <div class="muted" style="font-size:12.5px">${DOCS[d.category]?.label ?? d.category} · ${d.filename} · ${fileSize(d.size)} · ${d.uploadedBy}, ${rel(d.uploadedAt)}</div></div>
          <div style="display:flex;gap:6px">
            ${/^(image\/|application\/pdf|text\/html)/.test(d.contentType) ? html`<button class="btn ghost sm" data-view="${d.id}">${ico('eye')}View</button>` : ''}
            <button class="btn ghost sm" data-dl="${d.id}">${ico('arrow')}Download</button>
            ${canUp && (d.category !== 'agreement') ? html`<button class="btn ghost icon" data-del="${d.id}" aria-label="Delete ${d.title}">${ico('trash')}</button>` : ''}
          </div>
        </div>`) : html`<div class="empty">${ico('folder')}No documents yet.</div>`}</div>`);

    const fileIn = $<HTMLInputElement>('#d-file', tb);
    const drop = $('#drop', tb);
    const send = async (file: File) => {
      const f = formData($('#up', tb)!);
      drop?.classList.add('busy');
      try {
        await api.uploadDocument(e.id, { category: f.category as DocCategory, title: f.title, file });
        toast('Uploaded', `${file.name} · ${DOCS[f.category as DocCategory].label}`);
        await reload();
      } catch (err) { toast('Not uploaded', (err as Error).message, 'err'); }
      finally { drop?.classList.remove('busy'); }
    };
    fileIn?.addEventListener('change', () => { if (fileIn.files?.[0]) void send(fileIn.files[0]); });
    drop?.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    drop?.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop?.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); const f = ev.dataTransfer?.files[0]; if (f) void send(f); });

    const blobOf = async (did: string) => { const b = await api.downloadDocument(e.id, did); const u = URL.createObjectURL(b); objectUrls.push(u); return { b, u }; };
    on(tb, 'click', '[data-dl]', async (_ev, b) => {
      const d = docs.find((x) => x.id === b.dataset.dl)!;
      try { const { u } = await blobOf(d.id); const a = document.createElement('a'); a.href = u; a.download = d.filename; a.click(); }
      catch (err) { toast('Download failed', (err as Error).message, 'err'); }
    });
    on(tb, 'click', '[data-view]', async (_ev, b) => {
      const d = docs.find((x) => x.id === b.dataset.view)!;
      try {
        const { b: blob, u } = await blobOf(d.id);
        const body = d.contentType.startsWith('image/') ? html`<img src="${u}" alt="${d.title}" style="max-width:100%;display:block;margin:auto;border-radius:8px">`
          : d.contentType.startsWith('text/html') ? html`<iframe class="doc-frame" sandbox="" srcdoc="${await blob.text()}" title="${d.title}"></iframe>`
          : html`<iframe class="doc-frame" src="${u}" title="${d.title}"></iframe>`;
        modal({ title: d.title, sub: `${d.filename} · ${fileSize(d.size)}`, wide: true, body, actions: [{ label: 'Close', kind: 'ghost' }] });
      } catch (err) { toast('Could not open', (err as Error).message, 'err'); }
    });
    on(tb, 'click', '[data-del]', (_ev, b) => {
      const d = docs.find((x) => x.id === b.dataset.del)!;
      confirmDanger({ title: 'Delete document', confirm: 'Delete', message: html`Delete <b>${d.title}</b> (${d.filename})? This cannot be undone.`,
        onConfirm: async () => { await api.deleteDocument(e.id, d.id); toast('Document deleted', d.title); await reload(); } });
    });
  }

  /* ----- payroll ----- */
  function drawPayroll(tb: HTMLElement, p: Payroll) {
    const draw = (basic: number) => {
      const k = contributions(basic);
      mount($('#contrib', tb), html`
        <div class="ctx-stat"><span>EPF · employee 8%</span><b>${money(k.epfEmployee, p.currency)}</b></div>
        <div class="ctx-stat"><span>EPF · employer 12%</span><b>${money(k.epfEmployer, p.currency)}</b></div>
        <div class="ctx-stat"><span>ETF · employer 3%</span><b>${money(k.etf, p.currency)}</b></div>`);
    };
    mount(tb, html`
      <form class="panel reveal" id="pay" autocomplete="off">
        <div class="panel-head"><div><span class="eyebrow">Confidential</span><h3 style="margin-top:2px">Salary, EPF and ETF</h3></div></div>
        <div class="grid-2">
          <div class="field"><label for="p-basic">Basic salary (monthly)</label><input class="input" id="p-basic" name="basicSalary" type="number" min="0" step="0.01" value="${p.basicSalary || ''}"></div>
          <div class="field"><label for="p-allow">Allowances (monthly)</label><input class="input" id="p-allow" name="allowances" type="number" min="0" step="0.01" value="${p.allowances || ''}"></div>
          <div class="field"><label for="p-cur">Currency</label><input class="input" id="p-cur" name="currency" maxlength="3" value="${p.currency || 'LKR'}"></div>
          <div class="field"></div>
          <div class="field"><label for="p-epf">EPF number</label><input class="input mono" id="p-epf" name="epfNumber" value="${p.epfNumber}"></div>
          <div class="field"><label for="p-etf">ETF number</label><input class="input mono" id="p-etf" name="etfNumber" value="${p.etfNumber}"></div>
          <div class="field"><label for="p-bank">Bank</label><input class="input" id="p-bank" name="bankName" value="${p.bankName}"></div>
          <div class="field"><label for="p-acct">Account number</label><input class="input mono" id="p-acct" name="bankAccount" value="${p.bankAccount}"></div>
        </div>
        <div class="ctx-card" id="contrib" style="margin:4px 0 14px"></div>
        <div style="display:flex;justify-content:flex-end"><button class="btn" type="submit">${ico('check')}Save payroll</button></div>
      </form>
      <p class="muted" style="font-size:13px">Only people with <span class="mono">employees:payroll</span> can see this tab and payroll documents. The employee is emailed which fields changed, never the amounts.</p>`);
    draw(p.basicSalary);
    $('#p-basic', tb)!.addEventListener('input', (ev) => draw(Number((ev.target as HTMLInputElement).value) || 0));
    $('#pay', tb)!.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = formData(ev.target as HTMLElement);
      try {
        e = await api.setPayroll(e.id, { basicSalary: Number(f.basicSalary) || 0, allowances: Number(f.allowances) || 0, currency: f.currency || 'LKR',
          epfNumber: f.epfNumber, etfNumber: f.etfNumber, bankName: f.bankName, bankAccount: f.bankAccount });
        toast('Payroll saved', empName(e));
      } catch (err) { toast('Not saved', (err as Error).message, 'err'); }
    });
  }

  /* ----- agreements ----- */
  function drawAgreements(tb: HTMLElement) {
    const canM = can('employees:manage');
    const canSend = e.stage === 'agreement' || e.stage === 'active';
    mount(tb, html`
      ${canM && e.stage !== 'offboarded' ? html`<div class="toolbar"><span class="muted">${canSend ? 'Drafts can be edited until they are sent.' : 'You can draft now; sending unlocks once the onboarding is approved.'}</span><span class="spacer"></span>
        <button class="btn" data-a="newAgr">${ico('plus')}New agreement</button></div>` : ''}
      ${agreements.length ? agreements.map((a, i) => html`
        <div class="panel agreement reveal" style="--i:${i}">
          <div class="panel-head" style="align-items:flex-start">
            <div style="min-width:0"><h3 style="margin:0 0 4px">${a.title}</h3>
              <div class="tags">${agreementTag(a.status)}
                <span class="tag">${ico('clock')}Drafted ${rel(a.createdAt)} by ${a.createdBy}</span>
                ${a.sentAt ? html`<span class="tag">${ico('send')}Sent ${rel(a.sentAt)}</span>` : ''}
                ${a.viewedAt ? html`<span class="tag">${ico('eye')}Opened ${rel(a.viewedAt)}</span>` : ''}
                ${a.expiresAt && (a.status === 'sent' || a.status === 'viewed') ? html`<span class="tag ${new Date(a.expiresAt) < new Date() ? 'err' : ''}">Link expires ${fmt(a.expiresAt)}</span>` : ''}</div></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              ${canM && a.status === 'draft' ? html`<button class="btn soft sm" data-edit="${a.id}">${ico('edit')}Edit</button>` : ''}
              ${canM && canSend && (a.status === 'draft' || a.status === 'sent' || a.status === 'viewed') ? html`<button class="btn sm" data-send="${a.id}">${ico('send')}${a.status === 'draft' ? 'Send for signature' : 'Resend link'}</button>` : ''}
              ${canM && a.status !== 'signed' && a.status !== 'void' ? html`<button class="btn ghost sm" data-void="${a.id}">${ico('ban')}Void</button>` : ''}
            </div>
          </div>
          ${a.status === 'signed' ? html`
            <div class="signed-box">
              <img src="${a.signature ?? ''}" alt="Signature of ${a.signerName}">
              <div><b>${a.signerName}</b><div class="muted" style="font-size:12.5px">Signed ${fmt(a.signedAt)} · IP ${a.signerIp}</div>
                <button class="linklike" data-a="tab" data-t="documents" style="margin-top:6px">Open the signed copy in Documents →</button></div>
            </div>` : ''}
          <details><summary>Agreement text</summary><div class="agreement-body">${a.body}</div></details>
        </div>`) : html`<div class="empty">${ico('edit')}No agreements yet.</div>`}`);

    on(tb, 'click', '[data-a=newAgr]', () => agreementForm(null));
    on(tb, 'click', '[data-edit]', (_ev, b) => agreementForm(agreements.find((a) => a.id === b.dataset.edit)!));
    on(tb, 'click', '[data-send]', (_ev, b) => {
      const a = agreements.find((x) => x.id === b.dataset.send)!;
      confirmDanger({
        title: a.status === 'draft' ? 'Send for signature' : 'Resend signing link', confirm: a.status === 'draft' ? 'Send' : 'Resend',
        message: html`${empName(e)} will be emailed a private link at <b>${e.email}</b> to read and sign “${a.title}”. The link is valid for 14 days.${a.status !== 'draft' ? html` <b>The previous link stops working.</b>` : ''} The text can no longer be edited after sending.`,
        onConfirm: async () => {
          const sent = await api.sendAgreement(e.id, a.id);
          await reload();
          showLink(sent);
        },
      });
    });
    on(tb, 'click', '[data-void]', (_ev, b) => {
      const a = agreements.find((x) => x.id === b.dataset.void)!;
      confirmDanger({ title: 'Void agreement', confirm: 'Void', message: html`Void “${a.title}”? Its signing link stops working immediately.`,
        onConfirm: async () => { await api.voidAgreement(e.id, a.id); toast('Agreement voided', a.title); await reload(); } });
    });
  }

  function showLink(a: Agreement) {
    modal({
      title: 'Signing link sent', sub: `Emailed to ${e.email}. You can also share it yourself, e.g. over WhatsApp.`,
      body: html`<div class="field"><label for="lnk">Private signing link</label>
        <div style="display:flex;gap:8px"><input class="input mono" id="lnk" readonly value="${a.link ?? ''}"><button class="btn soft" id="cp">${ico('copy')}Copy</button></div>
        <span class="hint">Anyone with this link can read and sign the agreement until ${fmt(a.expiresAt)}. Only share it with ${empName(e)}.</span></div>`,
      actions: [{ label: 'Done', kind: 'ghost' }],
      onOpen: ({ body }) => $('#cp', body)!.addEventListener('click', () => copy(a.link ?? '')),
    });
  }

  function agreementForm(a: Agreement | null) {
    const t = a ?? agreementTemplate(e, orgName);
    modal({
      title: a ? 'Edit agreement' : 'New agreement', wide: true,
      sub: 'Plain text. Leave a blank line between paragraphs. The candidate reads exactly this text before signing.',
      body: html`<form autocomplete="off">
        <div class="field"><label for="a-title">Title</label><input class="input" id="a-title" name="title" value="${t.title}"></div>
        <div class="field"><label for="a-body">Agreement text</label><textarea class="textarea" id="a-body" name="body" style="min-height:360px;font-family:var(--ff-mono, monospace);font-size:13px">${t.body}</textarea>
          ${!a ? html`<span class="hint">Pre-filled from the employee record${e.payroll ? ' and payroll' : ''}. Check every clause before sending.</span>` : ''}</div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: a ? 'Save draft' : 'Create draft', icon: 'check', onClick: async ({ body }) => {
          requireFields(body, ['title', 'body']);
          const f = formData(body);
          if (a) await api.updateAgreement(e.id, a.id, { title: f.title, body: f.body });
          else await api.createAgreement(e.id, { title: f.title, body: f.body });
          toast(a ? 'Draft saved' : 'Draft created', f.title);
          tab = 'agreements'; await reload();
        } },
      ],
    });
  }

  /* ----- history ----- */
  async function drawHistory(tb: HTMLElement) {
    mount(tb, html`<div class="skel" style="height:48px"></div>`);
    const h = await api.employeeHistory(e.id);
    mount(tb, h.length ? html`<ul class="timeline">${h.map((x, i) => html`
      <li class="tl-item reveal" style="--i:${Math.min(i, 12)}"><span class="tl-dot">${ico(x.action.startsWith('document') ? 'file' : x.action.startsWith('agreement') ? 'edit' : x.action.includes('approved') || x.action.includes('active') ? 'check' : x.action.includes('rejected') ? 'x' : 'activity')}</span>
        <div class="tl-body"><b>${x.summary}</b><div class="muted" style="font-size:12.5px">${x.actor} · ${fmt(x.at)}</div>${x.note ? html`<p style="margin:4px 0 0">“${x.note}”</p>` : ''}</div></li>`)}</ul>`
      : html`<div class="empty">${ico('history')}No history yet.</div>`);
  }

  function drawContext() {
    mount(ctx, html`
      <div class="ctx-card"><div class="ctx-label">Employee:</div>
        <div class="ctx-stat"><span>Code</span><b class="mono">${e.code}</b></div>
        <div class="ctx-stat"><span>Stage</span><b>${STAGE_LABEL[e.stage]}</b></div>
        <div class="ctx-stat"><span>Documents</span><b>${docs.length}</b></div>
        <div class="ctx-stat"><span>Agreements</span><b>${agreements.filter((a) => a.status === 'signed').length}/${agreements.filter((a) => a.status !== 'void').length} signed</b></div>
      </div>
      <div class="ctx-card"><div class="ctx-label">Emails:</div>
        <p style="margin:0;font-size:13px">${empName(e)} is emailed at ${e.email} when the record or payroll changes, a document is added, and when an agreement is sent or signed. Approvers are emailed when the employee is submitted.</p></div>`);
  }

  /* ----- actions ----- */
  on(main, 'click', '[data-tab]', (_ev, b) => {
    tab = b.dataset.tab!;
    $$('[data-tab]', main).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    drawTab();
  });
  on(main, 'click', '[data-a]', async (_ev, b) => {
    const act = b.dataset.a;
    if (act === 'tab') { tab = b.dataset.t!; frame(); $('#tb', main)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (act === 'edit') employeeForm(c, e, async () => reload(false));
    if (act === 'submit') {
      b.setAttribute('disabled', '');
      try { e = await api.submitForApproval(e.id); toast('Submitted for approval', 'Approvers have been emailed'); await reload(false); }
      catch (err) { b.removeAttribute('disabled'); toast('Not submitted', (err as Error).message, 'err'); }
    }
    if (act === 'approve' || act === 'reject') decide(act);
    if (act === 'offboard') offboard();
    if (act === 'delete') confirmDanger({
      title: 'Delete employee', confirm: 'Delete permanently', typeToConfirm: e.code,
      message: html`This permanently deletes <b>${empName(e)}</b>, all ${docs.length} documents, agreements and history. To keep the records, offboard instead.`,
      onConfirm: async () => { await api.deleteEmployee(e.id); toast('Employee deleted', empName(e)); location.href = '/employees/'; },
    });
    if (act === 'link' || act === 'unlink') {
      const uid = act === 'unlink' ? null : $<HTMLSelectElement>('#linkSel', main)?.value || null;
      if (act === 'link' && !uid) return toast('Choose an account first', '', 'info');
      try { e = await api.updateEmployee(e.id, { userId: uid }); toast(uid ? 'Account linked' : 'Account unlinked', empName(e)); await reload(false); }
      catch (err) { toast('Not changed', (err as Error).message, 'err'); }
    }
    if (act === 'mkuser') createAccount();
  });

  function decide(kind: 'approve' | 'reject') {
    modal({
      title: kind === 'approve' ? `Approve ${empName(e)}` : `Send ${empName(e)} back to HR`,
      sub: kind === 'approve' ? 'HR can then send the employment agreement.' : 'The record returns to the documents stage. HR is emailed your note.',
      body: html`<div class="field"><label for="dn">${kind === 'approve' ? 'Note (optional)' : 'What needs to change?'}</label><textarea class="textarea" id="dn" style="min-height:90px" autofocus></textarea></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: kind === 'approve' ? 'Approve' : 'Send back', kind: kind === 'approve' ? 'primary' : 'danger', icon: kind === 'approve' ? 'check' : 'x', onClick: async ({ body }) => {
          const note = $<HTMLTextAreaElement>('#dn', body)!.value.trim();
          e = await api.decideApproval(e.id, kind, note);
          toast(kind === 'approve' ? 'Approved' : 'Sent back for changes', empName(e));
          await reload(false);
        } },
      ],
    });
  }

  function offboard() {
    modal({
      title: `Offboard ${empName(e)}`, sub: 'Closes the record. Documents, agreements and history are kept. The employee is emailed.',
      body: html`<div class="field"><label for="on">Reason / note (optional)</label><textarea class="textarea" id="on" style="min-height:80px"></textarea></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Offboard', kind: 'danger', icon: 'logout', onClick: async ({ body }) => {
          e = await api.offboardEmployee(e.id, $<HTMLTextAreaElement>('#on', body)!.value.trim());
          toast('Employee offboarded', empName(e)); await reload(false);
        } },
      ],
    });
  }

  function createAccount() {
    const suggested = e.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    modal({
      title: 'Create sign-in account', sub: `${empName(e)} will be emailed a secure link to set their password, then linked to this record.`,
      body: html`<form autocomplete="off">
        <div class="field"><label for="cu-u">Username</label><input class="input mono" id="cu-u" name="username" value="${suggested}" autofocus></div>
        <div class="field"><label for="cu-e">Email</label><input class="input" id="cu-e" name="email" type="email" value="${e.email}"><span class="hint">Use their work address if they have one.</span></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Create and link', icon: 'userPlus', onClick: async ({ body }) => {
          requireFields(body, ['username', 'email']);
          const f = formData(body);
          const u = await api.createUser({ username: f.username, email: f.email, firstName: e.firstName, lastName: e.lastName, enabled: true,
            attributes: { department: e.department, jobTitle: e.jobTitle, phone: e.phone }, setup: 'link' });
          e = await api.updateEmployee(e.id, { userId: u.id });
          toast('Account created and linked', `@${u.username} · setup link emailed`);
          await reload(false);
        } },
      ],
    });
  }

  [docs, agreements] = await Promise.all([api.listDocuments(id), api.listAgreements(id)]);
  if (tab === 'payroll' && !e.payroll) tab = 'profile';
  frame();
}
