package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/store"
)

/* ---------- permission catalog ---------- */

type catalogPerm struct{ Key, Category, Description string }

// Catalog lists the permissions TEMS creates at startup when they are missing
// (the original set is imported with the realm; these arrived later).
var Catalog = []catalogPerm{
	{"employees:view", "Employees", "View employee records, documents and onboarding status"},
	{"employees:manage", "Employees", "Create and edit employees, upload documents, send agreements"},
	{"employees:approve", "Employees", "Approve or reject onboarding (cannot approve your own submissions)"},
	{"employees:payroll", "Employees", "View and edit salary, EPF/ETF and bank details and payroll documents"},
	{"employees:delete", "Employees", "Permanently delete employee records and their documents"},
	{"projects:view", "Projects", "View every project, its team and status history"},
	{"projects:manage", "Projects", "Create projects, assign people and post status updates"},
	{"tickets:view", "Tickets", "View tickets on every project"},
	{"tickets:create", "Tickets", "Raise tickets on any project"},
	{"tickets:manage", "Tickets", "Edit, assign, close and delete any ticket"},
}

// EnsureCatalog creates missing catalog permissions and grants new ones to the
// Administrators group, so upgrades of an existing realm pick them up.
func EnsureCatalog(ctx context.Context, k *kc.Client, clientUUID string) error {
	base := "/clients/" + kc.P(clientUUID) + "/roles"
	var have []kc.Role
	if _, err := k.Do(ctx, http.MethodGet, base, nil, &have); err != nil {
		return err
	}
	exists := map[string]bool{}
	for _, r := range have {
		exists[r.Name] = true
	}
	var created []kc.Role
	for _, p := range Catalog {
		if exists[p.Key] {
			continue
		}
		role := kc.Role{Name: p.Key, Description: p.Description, Attributes: map[string][]string{"system": {"true"}, "category": {p.Category}}}
		if _, err := k.Do(ctx, http.MethodPost, base, role, nil); err != nil {
			return err
		}
		var full kc.Role
		if _, err := k.Do(ctx, http.MethodGet, base+"/"+kc.P(p.Key), nil, &full); err != nil {
			return err
		}
		created = append(created, full)
		slog.Info("created permission", "key", p.Key)
	}
	if len(created) == 0 {
		return nil
	}
	var groups []kc.Group
	if _, err := k.Do(ctx, http.MethodGet, "/groups?search=Administrators&exact=true", nil, &groups); err != nil {
		return err
	}
	for _, g := range groups {
		if g.Name == "Administrators" {
			_, err := k.Do(ctx, http.MethodPost, "/groups/"+kc.P(g.ID)+"/role-mappings/clients/"+kc.P(clientUUID), created, nil)
			return err
		}
	}
	return nil
}

/* ---------- vocabulary ---------- */

var docLabels = map[string]string{
	"birth_certificate": "Birth certificate", "nic": "NIC / passport", "education": "Educational qualification", "cv": "CV / résumé",
	"agreement": "Agreement", "epf": "EPF", "etf": "ETF", "salary": "Salary document", "bank": "Bank details", "other": "Other",
}

// Payroll documents need employees:payroll on top of employees:view.
var payrollDocs = map[string]bool{"epf": true, "etf": true, "salary": true, "bank": true}

var employmentTypes = map[string]bool{"permanent": true, "contract": true, "probation": true, "intern": true}
var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func validDate(s string) bool {
	if s == "" {
		return true
	}
	if !dateRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

/* ---------- representation ---------- */

type apiDecision struct {
	Decision string    `json:"decision"`
	By       string    `json:"by"`
	At       time.Time `json:"at"`
	Note     string    `json:"note"`
}

type apiEmployee struct {
	ID               string         `json:"id"`
	Code             string         `json:"code"`
	FirstName        string         `json:"firstName"`
	LastName         string         `json:"lastName"`
	Email            string         `json:"email"`
	Phone            string         `json:"phone"`
	NIC              string         `json:"nic"`
	DateOfBirth      string         `json:"dateOfBirth"`
	Address          string         `json:"address"`
	Department       string         `json:"department"`
	JobTitle         string         `json:"jobTitle"`
	EmploymentType   string         `json:"employmentType"`
	StartDate        string         `json:"startDate"`
	Stage            string         `json:"stage"`
	UserID           *string        `json:"userId"`
	SubmittedBy      *string        `json:"submittedBy"`
	LastDecision     *apiDecision   `json:"lastDecision"`
	DocumentCount    int            `json:"documentCount"`
	MissingDocuments []string       `json:"missingDocuments"`
	Payroll          *store.Payroll `json:"payroll"`
	CreatedAt        time.Time      `json:"createdAt"`
	CreatedBy        string         `json:"createdBy"`
	UpdatedAt        time.Time      `json:"updatedAt"`
}

func (c *call) missingDocs(e *store.Employee) []string {
	have := map[string]bool{}
	for _, cat := range e.DocCategories {
		have[cat] = true
	}
	out := []string{}
	for _, cat := range c.s.Settings().RequiredDocuments {
		if !have[cat] {
			out = append(out, cat)
		}
	}
	return out
}

func (c *call) toEmployee(e *store.Employee) apiEmployee {
	a := apiEmployee{
		ID: e.ID, Code: e.Code, FirstName: e.FirstName, LastName: e.LastName, Email: e.Email, Phone: e.Phone, NIC: e.NIC,
		DateOfBirth: e.DateOfBirth, Address: e.Address, Department: e.Department, JobTitle: e.JobTitle,
		EmploymentType: e.EmploymentType, StartDate: e.StartDate, Stage: e.Stage, UserID: e.UserID, SubmittedBy: e.SubmittedBy,
		DocumentCount: e.DocCount, MissingDocuments: c.missingDocs(e), CreatedAt: e.CreatedAt, CreatedBy: e.CreatedBy, UpdatedAt: e.UpdatedAt,
	}
	if e.Decision != nil {
		a.LastDecision = &apiDecision{e.Decision.Decision, e.Decision.By, e.Decision.At, e.Decision.Note}
	}
	if c.P.Can("employees:payroll") {
		a.Payroll = e.Payroll
		if a.Payroll == nil {
			a.Payroll = &store.Payroll{Currency: "LKR"}
		}
	}
	return a
}

func empRcpt(e *store.Employee) recipient {
	r := recipient{Email: e.Email, Name: e.Name(), First: e.FirstName}
	if e.UserID != nil {
		r.UserID = *e.UserID // lets others() skip people acting on their own work
	}
	return r
}

// myEmployee is the employee record linked to the caller's sign-in account, if any.
func (c *call) myEmployee() *store.Employee {
	if c.P == nil {
		return nil
	}
	e, err := c.s.st.EmployeeByUser(c.ctx(), c.P.ID)
	if err != nil {
		return nil
	}
	return e
}

func (c *call) employee() (*store.Employee, error) {
	e, err := c.s.st.GetEmployee(c.ctx(), c.param("id"))
	if errors.Is(err, store.ErrNotFound) {
		return nil, errf(404, "Employee not found.")
	}
	return e, err
}

func (c *call) event(e *store.Employee, action, summary, note string) {
	_, actor := c.actor()
	if err := c.s.st.AddEmployeeEvent(c.ctx(), e.ID, actor, action, summary, note); err != nil {
		slog.Error("employee event", "err", err)
	}
}

func (s *Server) employeeLink(id string) string {
	return s.cfg.PublicURL + "/employees/?id=" + url.QueryEscape(id)
}

/* ---------- list / get ---------- */

func (s *Server) listEmployees(c *call) error {
	if err := c.need("employees:view"); err != nil {
		return err
	}
	list, err := s.st.ListEmployees(c.ctx(), store.EmployeeFilter{Search: c.query("search"), Stage: c.query("stage"), Department: c.query("department")})
	if err != nil {
		return err
	}
	page, size := c.paging(12)
	items := []apiEmployee{}
	for i := (page - 1) * size; i < len(list) && i < page*size; i++ {
		items = append(items, c.toEmployee(list[i]))
	}
	return c.JSON(200, map[string]any{"items": items, "total": len(list)})
}

func (s *Server) getEmployee(c *call) error {
	e, err := c.employee()
	if err != nil {
		return err
	}
	if e.UserID == nil || *e.UserID != c.P.ID { // everyone may read their own record
		if err := c.need("employees:view"); err != nil {
			return err
		}
	}
	return c.JSON(200, c.toEmployee(e))
}

/* ---------- create / update / delete ---------- */

type employeeInput struct {
	FirstName      *string `json:"firstName"`
	LastName       *string `json:"lastName"`
	Email          *string `json:"email"`
	Phone          *string `json:"phone"`
	NIC            *string `json:"nic"`
	DateOfBirth    *string `json:"dateOfBirth"`
	Address        *string `json:"address"`
	Department     *string `json:"department"`
	JobTitle       *string `json:"jobTitle"`
	EmploymentType *string `json:"employmentType"`
	StartDate      *string `json:"startDate"`
	UserID         *string `json:"userId"`
	userIDSet      bool
}

// apply copies the provided fields onto e and returns human-readable changes.
func (in *employeeInput) apply(c *call, sn *dir.Snapshot, e *store.Employee) ([]string, error) {
	var changes []string
	set := func(label string, dst *string, v *string, max int) {
		if v == nil {
			return
		}
		nv := clip(*v, max)
		if nv != *dst {
			changes = append(changes, fmt.Sprintf("%s: %s → %s", label, orDash(*dst), orDash(nv)))
			*dst = nv
		}
	}
	set("First name", &e.FirstName, in.FirstName, 80)
	set("Last name", &e.LastName, in.LastName, 80)
	set("Email", &e.Email, in.Email, 200)
	set("Phone", &e.Phone, in.Phone, 40)
	set("NIC", &e.NIC, in.NIC, 20)
	set("Date of birth", &e.DateOfBirth, in.DateOfBirth, 10)
	set("Address", &e.Address, in.Address, 300)
	set("Department", &e.Department, in.Department, 80)
	set("Job title", &e.JobTitle, in.JobTitle, 80)
	set("Employment type", &e.EmploymentType, in.EmploymentType, 20)
	set("Start date", &e.StartDate, in.StartDate, 10)
	if e.FirstName == "" {
		return nil, errf(400, "First name is required.")
	}
	if !validEmail(e.Email) {
		return nil, errf(400, "Enter a valid email address.")
	}
	if !employmentTypes[e.EmploymentType] {
		return nil, errf(400, "Employment type must be permanent, contract, probation or intern.")
	}
	if !validDate(e.DateOfBirth) || !validDate(e.StartDate) {
		return nil, errf(400, "Dates must be in the form YYYY-MM-DD.")
	}
	if in.userIDSet {
		var nv *string
		if in.UserID != nil && *in.UserID != "" {
			u := sn.ByID[*in.UserID]
			if u == nil {
				return nil, errf(400, "The selected sign-in account does not exist.")
			}
			id := u.ID
			nv = &id
		}
		if (nv == nil) != (e.UserID == nil) || (nv != nil && *nv != *e.UserID) {
			changes = append(changes, "Linked sign-in account changed")
			e.UserID = nv
		}
	}
	return changes, nil
}

func (in *employeeInput) decode(c *call) error {
	var raw map[string]any
	body, err := io.ReadAll(c.R.Body)
	if err != nil {
		return errf(400, "Invalid request body.")
	}
	if err := json.Unmarshal(body, in); err != nil {
		return errf(400, "Invalid request body.")
	}
	_ = json.Unmarshal(body, &raw)
	_, in.userIDSet = raw["userId"]
	return nil
}

func dupMessage(err error) error {
	if errors.Is(err, store.ErrConflict) {
		if strings.Contains(err.Error(), "employees_user") {
			return errf(409, "That sign-in account is already linked to another employee.")
		}
		return errf(409, "Another employee already uses that email address.")
	}
	return err
}

func (s *Server) createEmployee(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	var in employeeInput
	if err := in.decode(c); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	e := &store.Employee{EmploymentType: "permanent", CreatedBy: c.P.Name}
	if _, err := in.apply(c, sn, e); err != nil {
		return err
	}
	id, err := s.st.CreateEmployee(c.ctx(), e)
	if err != nil {
		return dupMessage(err)
	}
	e, err = s.st.GetEmployee(c.ctx(), id)
	if err != nil {
		return err
	}
	c.event(e, "employee.create", "Onboarding started", "")
	c.audit("employee.create", "employee", e.ID, e.Name(), "Created employee "+e.Name()+" ("+e.Code+")", map[string]any{"email": e.Email, "jobTitle": e.JobTitle})
	c.notifyTo("employee.onboarding_started", []recipient{empRcpt(e)}, func(recipient) tmail.Data { return tmail.Data{Role: e.JobTitle} }, false)
	return c.JSON(201, c.toEmployee(e))
}

func (s *Server) updateEmployee(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	var in employeeInput
	if err := in.decode(c); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	changes, err := in.apply(c, sn, e)
	if err != nil {
		return err
	}
	if len(changes) == 0 {
		return c.JSON(200, c.toEmployee(e))
	}
	if err := s.st.UpdateEmployee(c.ctx(), e); err != nil {
		return dupMessage(err)
	}
	e, _ = s.st.GetEmployee(c.ctx(), e.ID)
	c.event(e, "employee.update", "Updated "+strings.Join(fieldNames(changes), ", "), "")
	c.audit("employee.update", "employee", e.ID, e.Name(), "Updated "+e.Name(), map[string]any{"changes": changes})
	if e.Stage != "offboarded" {
		c.notifyTo("employee.updated", []recipient{empRcpt(e)}, func(recipient) tmail.Data { return tmail.Data{Changes: changes} }, false)
	}
	return c.JSON(200, c.toEmployee(e))
}

func fieldNames(changes []string) []string {
	out := make([]string, 0, len(changes))
	for _, ch := range changes {
		name, _, _ := strings.Cut(ch, ":")
		out = append(out, strings.ToLower(name))
	}
	return out
}

func (s *Server) deleteEmployee(c *call) error {
	if err := c.need("employees:delete"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if err := s.st.DeleteEmployee(c.ctx(), e.ID); err != nil {
		return err
	}
	c.audit("employee.delete", "employee", e.ID, e.Name(), "Deleted employee "+e.Name()+" ("+e.Code+") and their documents", map[string]any{"email": e.Email})
	return c.NoContent()
}

/* ---------- payroll ---------- */

func (s *Server) setPayroll(c *call) error {
	if err := c.need("employees:payroll"); err != nil {
		return err
	}
	var in store.Payroll
	if err := c.decode(&in); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if in.BasicSalary < 0 || in.Allowances < 0 || in.BasicSalary > 1e9 || in.Allowances > 1e9 {
		return errf(400, "Salary amounts must be between 0 and 1,000,000,000.")
	}
	in.Currency = strings.ToUpper(clip(in.Currency, 3))
	if in.Currency == "" {
		in.Currency = "LKR"
	}
	in.EPFNumber, in.ETFNumber = clip(in.EPFNumber, 40), clip(in.ETFNumber, 40)
	in.BankName, in.BankAccount = clip(in.BankName, 80), clip(in.BankAccount, 40)
	old := store.Payroll{}
	if e.Payroll != nil {
		old = *e.Payroll
	}
	var changed []string
	if old.BasicSalary != in.BasicSalary {
		changed = append(changed, "Basic salary")
	}
	if old.Allowances != in.Allowances {
		changed = append(changed, "Allowances")
	}
	if old.Currency != in.Currency && old.Currency != "" {
		changed = append(changed, "Currency")
	}
	if old.EPFNumber != in.EPFNumber {
		changed = append(changed, "EPF number")
	}
	if old.ETFNumber != in.ETFNumber {
		changed = append(changed, "ETF number")
	}
	if old.BankName != in.BankName || old.BankAccount != in.BankAccount {
		changed = append(changed, "Bank account")
	}
	if err := s.st.SetPayroll(c.ctx(), e.ID, in); err != nil {
		return err
	}
	e, _ = s.st.GetEmployee(c.ctx(), e.ID)
	if len(changed) > 0 {
		c.event(e, "employee.payroll", "Updated payroll: "+strings.ToLower(strings.Join(changed, ", ")), "")
		c.audit("employee.payroll", "employee", e.ID, e.Name(), "Updated payroll for "+e.Name(), map[string]any{"fields": changed})
		if e.Stage != "offboarded" {
			c.notifyTo("employee.payroll_changed", []recipient{empRcpt(e)}, func(recipient) tmail.Data {
				out := make([]string, len(changed))
				for i, f := range changed {
					out[i] = f + " updated"
				}
				return tmail.Data{Changes: out}
			}, false)
		}
	}
	return c.JSON(200, c.toEmployee(e))
}

func (s *Server) employeeHistory(c *call) error {
	if err := c.need("employees:view"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	h, err := s.st.EmployeeHistory(c.ctx(), e.ID)
	if err != nil {
		return err
	}
	return c.JSON(200, h)
}

/* ---------- documents ---------- */

const maxUpload = 10 << 20

func (c *call) canSeeDoc(category string) bool {
	return !payrollDocs[category] || c.P.Can("employees:payroll")
}

func (s *Server) listDocuments(c *call) error {
	if err := c.need("employees:view"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	docs, err := s.st.ListDocuments(c.ctx(), e.ID)
	if err != nil {
		return err
	}
	out := []store.Document{}
	for _, d := range docs {
		if c.canSeeDoc(d.Category) {
			out = append(out, d)
		}
	}
	return c.JSON(200, out)
}

var officeTypes = map[string]string{
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

// sniffUpload decides the stored content type from the bytes, never the client's claim.
func sniffUpload(name string, data []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	ct := http.DetectContentType(data)
	switch {
	case ct == "application/pdf", ct == "image/png", ct == "image/jpeg", ct == "image/webp":
		return ct, nil
	case ct == "application/zip" && officeTypes[ext] != "":
		return officeTypes[ext], nil
	case ext == ".doc" && len(data) > 8 && string(data[:8]) == "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
		return "application/msword", nil
	}
	return "", errf(400, "Upload a PDF, an image (PNG, JPEG or WebP) or a Word / Excel document.")
}

func safeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`"<>:|?*/`, r) {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." {
		name = "document"
	}
	return clip(name, 120)
}

func (s *Server) uploadDocument(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if err := c.R.ParseMultipartForm(maxUpload + 1<<20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errf(413, "Files can be up to 10 MB.")
		}
		return errf(400, "Upload the file as multipart form data.")
	}
	defer c.R.MultipartForm.RemoveAll()
	category := c.R.FormValue("category")
	if docLabels[category] == "" {
		return errf(400, "Choose a document type.")
	}
	if payrollDocs[category] {
		if err := c.need("employees:payroll"); err != nil {
			return err
		}
	}
	f, fh, err := c.R.FormFile("file")
	if err != nil {
		return errf(400, "Choose a file to upload.")
	}
	defer f.Close()
	if fh.Size <= 0 || fh.Size > maxUpload {
		return errf(413, "Files can be up to 10 MB.")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(data) == 0 || len(data) > maxUpload {
		return errf(413, "Files can be up to 10 MB.")
	}
	name := safeFilename(fh.Filename)
	ct, err := sniffUpload(name, data)
	if err != nil {
		return err
	}
	title := clip(c.R.FormValue("title"), 120)
	if title == "" {
		title = docLabels[category]
	}
	sum := sha256.Sum256(data)
	d := &store.Document{EmployeeID: e.ID, Category: category, Title: title, Filename: name, ContentType: ct, Size: len(data),
		SHA256: hex.EncodeToString(sum[:]), Data: data, UploadedBy: c.P.Name}
	if err := s.st.AddDocument(c.ctx(), d); err != nil {
		return err
	}
	c.event(e, "document.upload", "Uploaded "+title, "")
	c.audit("document.upload", "employee", e.ID, e.Name(), fmt.Sprintf("Uploaded %s for %s", title, e.Name()),
		map[string]any{"category": category, "filename": name, "size": len(data), "sha256": d.SHA256})
	if e.Stage != "offboarded" {
		c.notifyTo("employee.document_added", []recipient{empRcpt(e)}, func(recipient) tmail.Data { return tmail.Data{Item: title} }, false)
	}
	return c.JSON(201, d)
}

func (s *Server) downloadDocument(c *call) error {
	if err := c.need("employees:view"); err != nil {
		return err
	}
	d, err := s.st.GetDocument(c.ctx(), c.param("id"), c.param("doc"))
	if errors.Is(err, store.ErrNotFound) {
		return errf(404, "Document not found.")
	}
	if err != nil {
		return err
	}
	if !c.canSeeDoc(d.Category) {
		return errf(403, "You need the “employees:payroll” permission to open payroll documents.")
	}
	h := c.W.Header()
	h.Set("Content-Type", d.ContentType)
	h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(d.Filename))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "no-store")
	c.W.WriteHeader(200)
	_, _ = c.W.Write(d.Data)
	return nil
}

func (s *Server) deleteDocument(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	d, err := s.st.GetDocument(c.ctx(), e.ID, c.param("doc"))
	if errors.Is(err, store.ErrNotFound) {
		return errf(404, "Document not found.")
	}
	if err != nil {
		return err
	}
	if payrollDocs[d.Category] {
		if err := c.need("employees:payroll"); err != nil {
			return err
		}
	}
	if err := s.st.DeleteDocument(c.ctx(), e.ID, d.ID); err != nil {
		return err
	}
	c.event(e, "document.delete", "Removed "+d.Title, "")
	c.audit("document.delete", "employee", e.ID, e.Name(), fmt.Sprintf("Removed %s from %s", d.Title, e.Name()), map[string]any{"filename": d.Filename})
	return c.NoContent()
}

/* ---------- onboarding pipeline ---------- */

func (s *Server) submitForApproval(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if e.Stage != "documents" {
		return errf(409, "Only employees in the documents stage can be submitted for approval.")
	}
	if missing := c.missingDocs(e); len(missing) > 0 {
		labels := make([]string, len(missing))
		for i, m := range missing {
			labels[i] = docLabels[m]
		}
		return errf(400, "Upload the required documents first: %s.", strings.Join(labels, ", "))
	}
	id, name := c.P.ID, c.P.Name
	if err := s.st.SetStage(c.ctx(), e.ID, "approval", &id, &name, nil); err != nil {
		return err
	}
	e, _ = s.st.GetEmployee(c.ctx(), e.ID)
	c.event(e, "employee.submit", "Submitted for approval", "")
	c.audit("employee.submit", "employee", e.ID, e.Name(), "Submitted "+e.Name()+" for onboarding approval", nil)

	sn, err := c.snap()
	if err != nil {
		return err
	}
	var approvers []recipient
	for _, u := range sn.Users {
		if u.Enabled && (sn.Supers[u.ID] || sn.Effective(u.ID)["employees:approve"]) {
			approvers = append(approvers, userRcpt(u))
		}
	}
	c.notifyTo("employee.approval_requested", c.others(approvers), func(recipient) tmail.Data {
		return tmail.Data{Person: e.Name(), Role: e.JobTitle, Link: s.employeeLink(e.ID)}
	}, false)
	return c.JSON(200, c.toEmployee(e))
}

func (s *Server) decideApproval(c *call) error {
	if err := c.need("employees:approve"); err != nil {
		return err
	}
	var in struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	in.Note = clip(in.Note, 2000)
	if in.Decision != "approve" && in.Decision != "reject" {
		return errf(400, "Decision must be approve or reject.")
	}
	if in.Decision == "reject" && in.Note == "" {
		return errf(400, "Tell HR what needs to change.")
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if e.Stage != "approval" {
		return errf(409, "This employee is not waiting for approval.")
	}
	if !c.P.Super && e.SubmittedByID != nil && *e.SubmittedByID == c.P.ID {
		return errf(403, "Someone other than the person who submitted it must approve an onboarding.")
	}
	stage, label, ev := "agreement", "Approved", "employee.approved"
	if in.Decision == "reject" {
		stage, label, ev = "documents", "Sent back for changes", "employee.rejected"
	}
	d := &store.Decision{Decision: map[string]string{"approve": "approved", "reject": "rejected"}[in.Decision], By: c.P.Name, At: time.Now().UTC(), Note: in.Note}
	if err := s.st.SetStage(c.ctx(), e.ID, stage, nil, nil, d); err != nil {
		return err
	}
	e, _ = s.st.GetEmployee(c.ctx(), e.ID)
	c.event(e, "employee."+d.Decision, label, in.Note)
	c.audit("employee."+d.Decision, "employee", e.ID, e.Name(), label+": "+e.Name(), map[string]any{"note": in.Note})
	if e.SubmittedByID != nil {
		if sn, err := c.snap(); err == nil {
			if u := sn.ByID[*e.SubmittedByID]; u != nil {
				c.notifyTo(ev, c.others([]recipient{userRcpt(u)}), func(recipient) tmail.Data {
					return tmail.Data{Person: e.Name(), Note: in.Note, Link: s.employeeLink(e.ID)}
				}, false)
			}
		}
	}
	return c.JSON(200, c.toEmployee(e))
}

func (s *Server) offboardEmployee(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	var in struct {
		Note string `json:"note"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if e.Stage == "offboarded" {
		return errf(409, "This employee is already offboarded.")
	}
	if err := s.st.SetStage(c.ctx(), e.ID, "offboarded", nil, nil, nil); err != nil {
		return err
	}
	e, _ = s.st.GetEmployee(c.ctx(), e.ID)
	note := clip(in.Note, 2000)
	c.event(e, "employee.offboard", "Offboarded", note)
	c.audit("employee.offboard", "employee", e.ID, e.Name(), "Offboarded "+e.Name(), map[string]any{"note": note})
	c.notifyTo("employee.offboarded", []recipient{empRcpt(e)}, nil, false)
	return c.JSON(200, c.toEmployee(e))
}
