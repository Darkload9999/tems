package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrConflict is returned when a unique constraint (email, project key…) is violated.
var ErrConflict = errors.New("conflict")

func conflict(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return fmt.Errorf("%w: %s", ErrConflict, pe.ConstraintName)
	}
	return err
}

func (s *Store) migrateHR(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `
CREATE SEQUENCE IF NOT EXISTS employee_code_seq;
CREATE TABLE IF NOT EXISTS employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  first_name      text NOT NULL,
  last_name       text NOT NULL DEFAULT '',
  email           text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  nic             text NOT NULL DEFAULT '',
  date_of_birth   text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  department      text NOT NULL DEFAULT '',
  job_title       text NOT NULL DEFAULT '',
  employment_type text NOT NULL DEFAULT 'permanent',
  start_date      text NOT NULL DEFAULT '',
  stage           text NOT NULL DEFAULT 'documents',
  user_id         text,
  submitted_by_id text,
  submitted_by    text,
  decision        jsonb,
  payroll         jsonb,
  created_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_email ON employees (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS employees_user ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS employee_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees ON DELETE CASCADE,
  category     text NOT NULL,
  title        text NOT NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  size         int  NOT NULL,
  sha256       text NOT NULL,
  data         bytea NOT NULL,
  uploaded_by  text NOT NULL DEFAULT '',
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_documents_emp ON employee_documents (employee_id);
CREATE TABLE IF NOT EXISTS employee_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  summary     text NOT NULL,
  note        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS employee_events_emp ON employee_events (employee_id, at DESC);
CREATE TABLE IF NOT EXISTS agreements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_by_id    text,
  sent_at       timestamptz,
  viewed_at     timestamptz,
  signed_at     timestamptz,
  expires_at    timestamptz,
  token_hash    text UNIQUE,
  body_sha256   text NOT NULL DEFAULT '',
  signer_name   text NOT NULL DEFAULT '',
  signer_ip     text NOT NULL DEFAULT '',
  signer_ua     text NOT NULL DEFAULT '',
  signature     bytea
);
CREATE INDEX IF NOT EXISTS agreements_emp ON agreements (employee_id, created_at DESC);`)
	return err
}

/* ---------- employees ---------- */

type Payroll struct {
	BasicSalary float64 `json:"basicSalary"`
	Allowances  float64 `json:"allowances"`
	Currency    string  `json:"currency"`
	EPFNumber   string  `json:"epfNumber"`
	ETFNumber   string  `json:"etfNumber"`
	BankName    string  `json:"bankName"`
	BankAccount string  `json:"bankAccount"`
}

type Decision struct {
	Decision string    `json:"decision"`
	By       string    `json:"by"`
	At       time.Time `json:"at"`
	Note     string    `json:"note"`
}

type Employee struct {
	ID             string
	Code           string
	FirstName      string
	LastName       string
	Email          string
	Phone          string
	NIC            string
	DateOfBirth    string
	Address        string
	Department     string
	JobTitle       string
	EmploymentType string
	StartDate      string
	Stage          string
	UserID         *string
	SubmittedByID  *string
	SubmittedBy    *string
	Decision       *Decision
	Payroll        *Payroll
	CreatedBy      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	DocCategories  []string // categories of uploaded documents
	DocCount       int
}

func (e *Employee) Name() string { return strings.TrimSpace(e.FirstName + " " + e.LastName) }

const empCols = `e.id::text, e.code, e.first_name, e.last_name, e.email, e.phone, e.nic, e.date_of_birth, e.address,
	e.department, e.job_title, e.employment_type, e.start_date, e.stage, e.user_id, e.submitted_by_id, e.submitted_by,
	e.decision, e.payroll, e.created_by, e.created_at, e.updated_at,
	COALESCE((SELECT array_agg(DISTINCT d.category) FROM employee_documents d WHERE d.employee_id = e.id), '{}'),
	(SELECT count(*) FROM employee_documents d WHERE d.employee_id = e.id)`

func scanEmployee(r pgx.Row) (*Employee, error) {
	var e Employee
	var dec, pay []byte
	err := r.Scan(&e.ID, &e.Code, &e.FirstName, &e.LastName, &e.Email, &e.Phone, &e.NIC, &e.DateOfBirth, &e.Address,
		&e.Department, &e.JobTitle, &e.EmploymentType, &e.StartDate, &e.Stage, &e.UserID, &e.SubmittedByID, &e.SubmittedBy,
		&dec, &pay, &e.CreatedBy, &e.CreatedAt, &e.UpdatedAt, &e.DocCategories, &e.DocCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(dec) > 0 {
		e.Decision = &Decision{}
		_ = json.Unmarshal(dec, e.Decision)
	}
	if len(pay) > 0 {
		e.Payroll = &Payroll{}
		_ = json.Unmarshal(pay, e.Payroll)
	}
	return &e, nil
}

type EmployeeFilter struct {
	Search, Stage, Department string
	IDs                       []string // restrict to these ids (nil = all)
}

func (s *Store) ListEmployees(ctx context.Context, f EmployeeFilter) ([]*Employee, error) {
	where, args := []string{"true"}, []any{}
	if f.Search != "" {
		args = append(args, "%"+f.Search+"%")
		n := itoa(len(args))
		where = append(where, "(e.first_name || ' ' || e.last_name ILIKE $"+n+" OR e.email ILIKE $"+n+" OR e.code ILIKE $"+n+
			" OR e.department ILIKE $"+n+" OR e.job_title ILIKE $"+n+" OR e.nic ILIKE $"+n+")")
	}
	if f.Stage != "" && f.Stage != "all" {
		args = append(args, f.Stage)
		where = append(where, "e.stage = $"+itoa(len(args)))
	}
	if f.Department != "" {
		args = append(args, f.Department)
		where = append(where, "e.department = $"+itoa(len(args)))
	}
	if f.IDs != nil {
		args = append(args, f.IDs)
		where = append(where, "e.id::text = ANY($"+itoa(len(args))+")")
	}
	rows, err := s.db.Query(ctx, `SELECT `+empCols+` FROM employees e WHERE `+strings.Join(where, " AND ")+` ORDER BY lower(e.first_name), lower(e.last_name)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Employee{}
	for rows.Next() {
		e, err := scanEmployee(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) GetEmployee(ctx context.Context, id string) (*Employee, error) {
	return scanEmployee(s.db.QueryRow(ctx, `SELECT `+empCols+` FROM employees e WHERE e.id::text = $1`, id))
}

func (s *Store) EmployeeByUser(ctx context.Context, userID string) (*Employee, error) {
	return scanEmployee(s.db.QueryRow(ctx, `SELECT `+empCols+` FROM employees e WHERE e.user_id = $1`, userID))
}

func (s *Store) CreateEmployee(ctx context.Context, e *Employee) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO employees (code, first_name, last_name, email, phone, nic, date_of_birth, address,
		department, job_title, employment_type, start_date, user_id, created_by)
		VALUES ('TZ-' || lpad(nextval('employee_code_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::text`,
		e.FirstName, e.LastName, e.Email, e.Phone, e.NIC, e.DateOfBirth, e.Address, e.Department, e.JobTitle,
		e.EmploymentType, e.StartDate, e.UserID, e.CreatedBy).Scan(&id)
	return id, conflict(err)
}

// UpdateEmployee writes the profile fields (not stage, payroll or approval).
func (s *Store) UpdateEmployee(ctx context.Context, e *Employee) error {
	_, err := s.db.Exec(ctx, `UPDATE employees SET first_name=$2, last_name=$3, email=$4, phone=$5, nic=$6, date_of_birth=$7,
		address=$8, department=$9, job_title=$10, employment_type=$11, start_date=$12, user_id=$13, updated_at=now() WHERE id::text=$1`,
		e.ID, e.FirstName, e.LastName, e.Email, e.Phone, e.NIC, e.DateOfBirth, e.Address, e.Department, e.JobTitle,
		e.EmploymentType, e.StartDate, e.UserID)
	return conflict(err)
}

func (s *Store) SetPayroll(ctx context.Context, id string, p Payroll) error {
	b, _ := json.Marshal(p)
	_, err := s.db.Exec(ctx, `UPDATE employees SET payroll=$2, updated_at=now() WHERE id::text=$1`, id, b)
	return err
}

// SetStage moves an employee through the onboarding pipeline. submittedBy is
// recorded when entering approval; decision when an approver decides.
func (s *Store) SetStage(ctx context.Context, id, stage string, submittedByID, submittedBy *string, d *Decision) error {
	var dec []byte
	if d != nil {
		dec, _ = json.Marshal(d)
	}
	_, err := s.db.Exec(ctx, `UPDATE employees SET stage=$2,
		submitted_by_id = COALESCE($3, submitted_by_id), submitted_by = COALESCE($4, submitted_by),
		decision = COALESCE($5, decision), updated_at=now() WHERE id::text=$1`, id, stage, submittedByID, submittedBy, dec)
	return err
}

func (s *Store) DeleteEmployee(ctx context.Context, id string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM employees WHERE id::text=$1`, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

type EmployeeCounts struct{ Total, Onboarding, PendingApproval int }

func (s *Store) EmployeeCounts(ctx context.Context) (c EmployeeCounts, err error) {
	err = s.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE stage <> 'offboarded'),
		count(*) FILTER (WHERE stage IN ('documents','approval','agreement')),
		count(*) FILTER (WHERE stage = 'approval') FROM employees`).Scan(&c.Total, &c.Onboarding, &c.PendingApproval)
	return
}

/* ---------- employee history ---------- */

type EmployeeEvent struct {
	ID      string    `json:"id"`
	At      time.Time `json:"at"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	Summary string    `json:"summary"`
	Note    string    `json:"note"`
}

func (s *Store) AddEmployeeEvent(ctx context.Context, employeeID, actor, action, summary, note string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO employee_events (employee_id, actor, action, summary, note) VALUES ($1::uuid,$2,$3,$4,$5)`,
		employeeID, actor, action, summary, note)
	return err
}

func (s *Store) EmployeeHistory(ctx context.Context, employeeID string) ([]EmployeeEvent, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, at, actor, action, summary, note FROM employee_events WHERE employee_id::text=$1 ORDER BY at DESC LIMIT 500`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EmployeeEvent{}
	for rows.Next() {
		var e EmployeeEvent
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.Action, &e.Summary, &e.Note); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

/* ---------- documents ---------- */

type Document struct {
	ID          string    `json:"id"`
	EmployeeID  string    `json:"employeeId"`
	Category    string    `json:"category"`
	Title       string    `json:"title"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"contentType"`
	Size        int       `json:"size"`
	SHA256      string    `json:"-"`
	UploadedBy  string    `json:"uploadedBy"`
	UploadedAt  time.Time `json:"uploadedAt"`
	Data        []byte    `json:"-"`
}

const docCols = `id::text, employee_id::text, category, title, filename, content_type, size, sha256, uploaded_by, uploaded_at`

func (s *Store) ListDocuments(ctx context.Context, employeeID string) ([]Document, error) {
	rows, err := s.db.Query(ctx, `SELECT `+docCols+` FROM employee_documents WHERE employee_id::text=$1 ORDER BY uploaded_at DESC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Document{}
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.EmployeeID, &d.Category, &d.Title, &d.Filename, &d.ContentType, &d.Size, &d.SHA256, &d.UploadedBy, &d.UploadedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetDocument returns the document including its bytes.
func (s *Store) GetDocument(ctx context.Context, employeeID, id string) (*Document, error) {
	var d Document
	err := s.db.QueryRow(ctx, `SELECT `+docCols+`, data FROM employee_documents WHERE employee_id::text=$1 AND id::text=$2`, employeeID, id).
		Scan(&d.ID, &d.EmployeeID, &d.Category, &d.Title, &d.Filename, &d.ContentType, &d.Size, &d.SHA256, &d.UploadedBy, &d.UploadedAt, &d.Data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &d, err
}

func (s *Store) AddDocument(ctx context.Context, d *Document) error {
	return s.db.QueryRow(ctx, `INSERT INTO employee_documents (employee_id, category, title, filename, content_type, size, sha256, data, uploaded_by)
		VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text, uploaded_at`,
		d.EmployeeID, d.Category, d.Title, d.Filename, d.ContentType, d.Size, d.SHA256, d.Data, d.UploadedBy).Scan(&d.ID, &d.UploadedAt)
}

func (s *Store) DeleteDocument(ctx context.Context, employeeID, id string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM employee_documents WHERE employee_id::text=$1 AND id::text=$2`, employeeID, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

/* ---------- agreements ---------- */

type Agreement struct {
	ID         string
	EmployeeID string
	Title      string
	Body       string
	Status     string
	CreatedBy  string
	CreatedAt  time.Time
	SentByID   *string
	SentAt     *time.Time
	ViewedAt   *time.Time
	SignedAt   *time.Time
	ExpiresAt  *time.Time
	BodySHA256 string
	SignerName string
	SignerIP   string
	SignerUA   string
	Signature  []byte
}

const agrCols = `id::text, employee_id::text, title, body, status, created_by, created_at, sent_by_id, sent_at, viewed_at, signed_at,
	expires_at, body_sha256, signer_name, signer_ip, signer_ua, signature`

func scanAgreement(r pgx.Row) (*Agreement, error) {
	var a Agreement
	err := r.Scan(&a.ID, &a.EmployeeID, &a.Title, &a.Body, &a.Status, &a.CreatedBy, &a.CreatedAt, &a.SentByID, &a.SentAt, &a.ViewedAt,
		&a.SignedAt, &a.ExpiresAt, &a.BodySHA256, &a.SignerName, &a.SignerIP, &a.SignerUA, &a.Signature)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &a, err
}

func (s *Store) ListAgreements(ctx context.Context, employeeID string) ([]*Agreement, error) {
	rows, err := s.db.Query(ctx, `SELECT `+agrCols+` FROM agreements WHERE employee_id::text=$1 ORDER BY created_at DESC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Agreement{}
	for rows.Next() {
		a, err := scanAgreement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAgreement(ctx context.Context, employeeID, id string) (*Agreement, error) {
	return scanAgreement(s.db.QueryRow(ctx, `SELECT `+agrCols+` FROM agreements WHERE employee_id::text=$1 AND id::text=$2`, employeeID, id))
}

func (s *Store) AgreementByToken(ctx context.Context, tokenHash string) (*Agreement, error) {
	return scanAgreement(s.db.QueryRow(ctx, `SELECT `+agrCols+` FROM agreements WHERE token_hash=$1`, tokenHash))
}

func (s *Store) CreateAgreement(ctx context.Context, employeeID, title, body, createdBy string) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO agreements (employee_id, title, body, created_by) VALUES ($1::uuid,$2,$3,$4) RETURNING id::text`,
		employeeID, title, body, createdBy).Scan(&id)
	return id, err
}

func (s *Store) UpdateAgreementDraft(ctx context.Context, id, title, body string) error {
	_, err := s.db.Exec(ctx, `UPDATE agreements SET title=$2, body=$3 WHERE id::text=$1 AND status='draft'`, id, title, body)
	return err
}

// SendAgreement (re)issues the signing link; any earlier link stops working.
func (s *Store) SendAgreement(ctx context.Context, id, tokenHash, bodySHA, sentByID string, expires time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE agreements SET status = CASE WHEN status='viewed' THEN 'viewed' ELSE 'sent' END,
		token_hash=$2, body_sha256=$3, sent_by_id=$4, sent_at=now(), expires_at=$5 WHERE id::text=$1`, id, tokenHash, bodySHA, sentByID, expires)
	return err
}

func (s *Store) MarkAgreementViewed(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `UPDATE agreements SET status='viewed', viewed_at=now() WHERE id::text=$1 AND status='sent'`, id)
	return err
}

// SignAgreement records the signature; it only succeeds once, while the link is live.
func (s *Store) SignAgreement(ctx context.Context, id, name, ip, ua string, signature []byte) (bool, error) {
	t, err := s.db.Exec(ctx, `UPDATE agreements SET status='signed', signed_at=now(), signer_name=$2, signer_ip=$3, signer_ua=$4, signature=$5
		WHERE id::text=$1 AND status IN ('sent','viewed') AND expires_at > now()`, id, name, ip, ua, signature)
	return err == nil && t.RowsAffected() == 1, err
}

func (s *Store) VoidAgreement(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `UPDATE agreements SET status='void', token_hash=NULL WHERE id::text=$1 AND status <> 'signed'`, id)
	return err
}
