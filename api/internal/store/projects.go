package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) migrateProjects(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  client      text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'planning',
  health      text NOT NULL DEFAULT 'on_track',
  start_date  text NOT NULL DEFAULT '',
  due_date    text NOT NULL DEFAULT '',
  lead_id     uuid REFERENCES employees ON DELETE SET NULL,
  ticket_seq  int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id  uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees ON DELETE CASCADE,
  role        text NOT NULL DEFAULT '',
  allocation  int  NOT NULL DEFAULT 100,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, employee_id)
);
CREATE TABLE IF NOT EXISTS project_updates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  author     text NOT NULL,
  status     text NOT NULL,
  health     text NOT NULL,
  progress   int  NOT NULL DEFAULT 0,
  note       text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS project_updates_p ON project_updates (project_id, at DESC);
CREATE TABLE IF NOT EXISTS tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  number      int  NOT NULL,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  type        text NOT NULL DEFAULT 'task',
  priority    text NOT NULL DEFAULT 'medium',
  status      text NOT NULL DEFAULT 'open',
  assignee_id uuid REFERENCES employees ON DELETE SET NULL,
  reporter_id text NOT NULL DEFAULT '',
  reporter    text NOT NULL DEFAULT '',
  due_date    text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX IF NOT EXISTS tickets_assignee ON tickets (assignee_id);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  author    text NOT NULL,
  author_id text NOT NULL DEFAULT '',
  body      text NOT NULL,
  system    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ticket_comments_t ON ticket_comments (ticket_id, at);`)
	return err
}

/* ---------- projects ---------- */

type ProjectMember struct {
	EmployeeID string    `json:"employeeId"`
	Name       string    `json:"name"`
	Email      string    `json:"email"`
	JobTitle   string    `json:"jobTitle"`
	Role       string    `json:"role"`
	Allocation int       `json:"allocation"`
	AssignedAt time.Time `json:"assignedAt"`
	UserID     *string   `json:"-"` // linked sign-in account
}

type Project struct {
	ID           string
	Key          string
	Name         string
	Description  string
	Client       string
	Status       string
	Health       string
	StartDate    string
	DueDate      string
	LeadID       *string
	LeadName     string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	Members      []ProjectMember
	TicketCounts map[string]int
}

const projCols = `id::text, key, name, description, client, status, health, start_date, due_date, lead_id::text,
	COALESCE((SELECT trim(e.first_name || ' ' || e.last_name) FROM employees e WHERE e.id = projects.lead_id), ''), created_at, updated_at`

// ListProjects returns projects with members and ticket counts. memberOf limits
// the list to projects that employee belongs to (or leads).
func (s *Store) ListProjects(ctx context.Context, search, status, memberOf string) ([]*Project, error) {
	where, args := []string{"true"}, []any{}
	if search != "" {
		args = append(args, "%"+search+"%")
		n := itoa(len(args))
		where = append(where, "(name ILIKE $"+n+" OR key ILIKE $"+n+" OR client ILIKE $"+n+" OR description ILIKE $"+n+")")
	}
	if status != "" && status != "all" {
		args = append(args, status)
		where = append(where, "status = $"+itoa(len(args)))
	}
	if memberOf != "" {
		args = append(args, memberOf)
		n := itoa(len(args))
		where = append(where, "(lead_id::text = $"+n+" OR id IN (SELECT project_id FROM project_members WHERE employee_id::text = $"+n+"))")
	}
	rows, err := s.db.Query(ctx, `SELECT `+projCols+` FROM projects WHERE `+strings.Join(where, " AND ")+
		` ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END, lower(name)`, args...)
	if err != nil {
		return nil, err
	}
	var out []*Project
	byID := map[string]*Project{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Key, &p.Name, &p.Description, &p.Client, &p.Status, &p.Health, &p.StartDate, &p.DueDate, &p.LeadID, &p.LeadName, &p.CreatedAt, &p.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		p.Members, p.TicketCounts = []ProjectMember{}, map[string]int{}
		out = append(out, &p)
		byID[p.ID] = &p
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(out) == 0 {
		return []*Project{}, err
	}
	ids := make([]string, 0, len(out))
	for _, p := range out {
		ids = append(ids, p.ID)
	}
	mrows, err := s.db.Query(ctx, `SELECT m.project_id::text, m.employee_id::text, e.first_name || ' ' || e.last_name, e.email, e.job_title, m.role, m.allocation, m.assigned_at, e.user_id
		FROM project_members m JOIN employees e ON e.id = m.employee_id WHERE m.project_id::text = ANY($1) ORDER BY m.assigned_at`, ids)
	if err != nil {
		return nil, err
	}
	for mrows.Next() {
		var pid string
		var m ProjectMember
		if err := mrows.Scan(&pid, &m.EmployeeID, &m.Name, &m.Email, &m.JobTitle, &m.Role, &m.Allocation, &m.AssignedAt, &m.UserID); err != nil {
			mrows.Close()
			return nil, err
		}
		m.Name = strings.TrimSpace(m.Name)
		byID[pid].Members = append(byID[pid].Members, m)
	}
	mrows.Close()
	trows, err := s.db.Query(ctx, `SELECT project_id::text, status, count(*) FROM tickets WHERE project_id::text = ANY($1) GROUP BY 1, 2`, ids)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var pid, st string
		var n int
		if err := trows.Scan(&pid, &st, &n); err != nil {
			return nil, err
		}
		byID[pid].TicketCounts[st] = n
	}
	return out, trows.Err()
}

func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	var key string
	if err := s.db.QueryRow(ctx, `SELECT key FROM projects WHERE id::text=$1`, id).Scan(&key); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	ps, err := s.ListProjects(ctx, key, "", "")
	if err != nil {
		return nil, err
	}
	for _, p := range ps {
		if p.ID == id {
			return p, nil
		}
	}
	return nil, ErrNotFound
}

func (s *Store) CreateProject(ctx context.Context, p *Project) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO projects (key, name, description, client, start_date, due_date, lead_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7::uuid) RETURNING id::text`, p.Key, p.Name, p.Description, p.Client, p.StartDate, p.DueDate, p.LeadID).Scan(&id)
	return id, conflict(err)
}

func (s *Store) UpdateProject(ctx context.Context, p *Project) error {
	_, err := s.db.Exec(ctx, `UPDATE projects SET name=$2, description=$3, client=$4, start_date=$5, due_date=$6, lead_id=$7::uuid, updated_at=now()
		WHERE id::text=$1`, p.ID, p.Name, p.Description, p.Client, p.StartDate, p.DueDate, p.LeadID)
	return conflict(err)
}

func (s *Store) SetProjectStatus(ctx context.Context, id, status, health string) error {
	_, err := s.db.Exec(ctx, `UPDATE projects SET status=$2, health=$3, updated_at=now() WHERE id::text=$1`, id, status, health)
	return err
}

func (s *Store) DeleteProject(ctx context.Context, id string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM projects WHERE id::text=$1`, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) UpsertMember(ctx context.Context, projectID, employeeID, role string, allocation int) error {
	_, err := s.db.Exec(ctx, `INSERT INTO project_members (project_id, employee_id, role, allocation) VALUES ($1::uuid,$2::uuid,$3,$4)
		ON CONFLICT (project_id, employee_id) DO UPDATE SET role=EXCLUDED.role, allocation=EXCLUDED.allocation`, projectID, employeeID, role, allocation)
	return err
}

func (s *Store) RemoveMember(ctx context.Context, projectID, employeeID string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM project_members WHERE project_id::text=$1 AND employee_id::text=$2`, projectID, employeeID)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

type ProjectUpdate struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	At        time.Time `json:"at"`
	Author    string    `json:"author"`
	Status    string    `json:"status"`
	Health    string    `json:"health"`
	Progress  int       `json:"progress"`
	Note      string    `json:"note"`
}

func (s *Store) AddProjectUpdate(ctx context.Context, u ProjectUpdate) error {
	_, err := s.db.Exec(ctx, `INSERT INTO project_updates (project_id, author, status, health, progress, note) VALUES ($1::uuid,$2,$3,$4,$5,$6)`,
		u.ProjectID, u.Author, u.Status, u.Health, u.Progress, u.Note)
	return err
}

func (s *Store) ProjectUpdates(ctx context.Context, projectID string) ([]ProjectUpdate, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, project_id::text, at, author, status, health, progress, note FROM project_updates
		WHERE project_id::text=$1 ORDER BY at DESC LIMIT 200`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectUpdate{}
	for rows.Next() {
		var u ProjectUpdate
		if err := rows.Scan(&u.ID, &u.ProjectID, &u.At, &u.Author, &u.Status, &u.Health, &u.Progress, &u.Note); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

type ProjectCounts struct{ Active, OpenTickets int }

func (s *Store) ProjectCounts(ctx context.Context) (c ProjectCounts, err error) {
	err = s.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM projects WHERE status IN ('planning','active','on_hold')),
		(SELECT count(*) FROM tickets WHERE status IN ('open','in_progress','in_review'))`).Scan(&c.Active, &c.OpenTickets)
	return
}

/* ---------- tickets ---------- */

type Ticket struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"projectId"`
	ProjectKey   string    `json:"projectKey"`
	Ref          string    `json:"ref"`
	Number       int       `json:"-"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	Type         string    `json:"type"`
	Priority     string    `json:"priority"`
	Status       string    `json:"status"`
	AssigneeID   *string   `json:"assigneeId"`
	AssigneeName string    `json:"assigneeName"`
	ReporterID   string    `json:"reporterId"`
	Reporter     string    `json:"reporter"`
	DueDate      string    `json:"dueDate"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	CommentCount int       `json:"commentCount"`
}

const ticketCols = `t.id::text, t.project_id::text, p.key, t.number, t.title, t.description, t.type, t.priority, t.status, t.assignee_id::text,
	COALESCE(trim(e.first_name || ' ' || e.last_name), ''), t.reporter_id, t.reporter, t.due_date, t.created_at, t.updated_at,
	(SELECT count(*) FROM ticket_comments c WHERE c.ticket_id = t.id AND NOT c.system)`
const ticketFrom = ` FROM tickets t JOIN projects p ON p.id = t.project_id LEFT JOIN employees e ON e.id = t.assignee_id`

func scanTicket(r pgx.Row) (*Ticket, error) {
	var t Ticket
	err := r.Scan(&t.ID, &t.ProjectID, &t.ProjectKey, &t.Number, &t.Title, &t.Description, &t.Type, &t.Priority, &t.Status, &t.AssigneeID,
		&t.AssigneeName, &t.ReporterID, &t.Reporter, &t.DueDate, &t.CreatedAt, &t.UpdatedAt, &t.CommentCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.Ref = t.ProjectKey + "-" + itoa(t.Number)
	return &t, nil
}

type TicketFilter struct {
	Search, ProjectID, Status, AssigneeID, Priority string
	Page, Size                                      int
}

var priorityOrder = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`

func (s *Store) ListTickets(ctx context.Context, f TicketFilter) ([]*Ticket, int, error) {
	where, args := []string{"true"}, []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "$?", "$"+itoa(len(args))))
	}
	if f.Search != "" {
		add("(t.title ILIKE $? OR t.description ILIKE $? OR (p.key || '-' || t.number) ILIKE $?)", "%"+f.Search+"%")
	}
	if f.ProjectID != "" {
		add("t.project_id::text = $?", f.ProjectID)
	}
	switch f.Status {
	case "", "all":
	case "active":
		where = append(where, "t.status IN ('open','in_progress','in_review')")
	default:
		add("t.status = $?", f.Status)
	}
	if f.AssigneeID != "" {
		add("t.assignee_id::text = $?", f.AssigneeID)
	}
	if f.Priority != "" && f.Priority != "all" {
		add("t.priority = $?", f.Priority)
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*)`+ticketFrom+` WHERE `+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, f.Size, (f.Page-1)*f.Size)
	rows, err := s.db.Query(ctx, `SELECT `+ticketCols+ticketFrom+` WHERE `+w+` ORDER BY `+priorityOrder+`, t.updated_at DESC LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []*Ticket{}
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

func (s *Store) GetTicket(ctx context.Context, id string) (*Ticket, error) {
	return scanTicket(s.db.QueryRow(ctx, `SELECT `+ticketCols+ticketFrom+` WHERE t.id::text=$1`, id))
}

// CreateTicket allocates the next per-project number atomically.
func (s *Store) CreateTicket(ctx context.Context, t *Ticket) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `WITH n AS (UPDATE projects SET ticket_seq = ticket_seq + 1, updated_at = now() WHERE id::text = $1 RETURNING id, ticket_seq)
		INSERT INTO tickets (project_id, number, title, description, type, priority, assignee_id, reporter_id, reporter, due_date)
		SELECT n.id, n.ticket_seq, $2,$3,$4,$5,$6::uuid,$7,$8,$9 FROM n RETURNING id::text`,
		t.ProjectID, t.Title, t.Description, t.Type, t.Priority, t.AssigneeID, t.ReporterID, t.Reporter, t.DueDate).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

func (s *Store) UpdateTicket(ctx context.Context, t *Ticket) error {
	_, err := s.db.Exec(ctx, `UPDATE tickets SET title=$2, description=$3, type=$4, priority=$5, status=$6, assignee_id=$7::uuid, due_date=$8, updated_at=now()
		WHERE id::text=$1`, t.ID, t.Title, t.Description, t.Type, t.Priority, t.Status, t.AssigneeID, t.DueDate)
	return err
}

func (s *Store) DeleteTicket(ctx context.Context, id string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM tickets WHERE id::text=$1`, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

type TicketComment struct {
	ID       string    `json:"id"`
	TicketID string    `json:"ticketId"`
	At       time.Time `json:"at"`
	Author   string    `json:"author"`
	AuthorID string    `json:"authorId"`
	Body     string    `json:"body"`
	System   bool      `json:"system"`
}

func (s *Store) AddComment(ctx context.Context, c *TicketComment) error {
	err := s.db.QueryRow(ctx, `INSERT INTO ticket_comments (ticket_id, author, author_id, body, system) VALUES ($1::uuid,$2,$3,$4,$5) RETURNING id::text, at`,
		c.TicketID, c.Author, c.AuthorID, c.Body, c.System).Scan(&c.ID, &c.At)
	if err == nil && !c.System {
		_, err = s.db.Exec(ctx, `UPDATE tickets SET updated_at=now() WHERE id::text=$1`, c.TicketID)
	}
	return err
}

func (s *Store) Comments(ctx context.Context, ticketID string) ([]TicketComment, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, ticket_id::text, at, author, author_id, body, system FROM ticket_comments WHERE ticket_id::text=$1 ORDER BY at`, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TicketComment{}
	for rows.Next() {
		var c TicketComment
		if err := rows.Scan(&c.ID, &c.TicketID, &c.At, &c.Author, &c.AuthorID, &c.Body, &c.System); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
