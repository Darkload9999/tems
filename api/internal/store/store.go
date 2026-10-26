// Package store holds what Keycloak doesn't: member-level denies, the audit
// trail, the notification outbox and system settings.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ db *pgxpool.Pool }

var ErrNotFound = errors.New("not found")

func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close()                         { s.db.Close() }
func (s *Store) Ping(ctx context.Context) error { return s.db.Ping(ctx) }

func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `
CREATE TABLE IF NOT EXISTS perm_denies (
  user_id    text NOT NULL,
  perm       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, perm)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    text NOT NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text NOT NULL DEFAULT '',
  target_name text NOT NULL DEFAULT '',
  summary     text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  ip          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE TABLE IF NOT EXISTS mail_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email        text NOT NULL,
  to_name         text NOT NULL DEFAULT '',
  user_id         text,
  subject         text NOT NULL,
  event           text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  attempts        int  NOT NULL DEFAULT 0,
  error           text,
  triggered_by    text NOT NULL DEFAULT '',
  html            text NOT NULL,
  body_text       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_outbox_created ON mail_outbox (created_at DESC);
CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox (next_attempt_at) WHERE status = 'queued';
CREATE TABLE IF NOT EXISTS settings (
  id    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  value jsonb NOT NULL
);`)
	return err
}

/* ---------- member denies ---------- */

func (s *Store) Denies(ctx context.Context) (map[string][]string, error) {
	rows, err := s.db.Query(ctx, `SELECT user_id, perm FROM perm_denies ORDER BY perm`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var u, p string
		if err := rows.Scan(&u, &p); err != nil {
			return nil, err
		}
		out[u] = append(out[u], p)
	}
	return out, rows.Err()
}

func (s *Store) SetDeny(ctx context.Context, userID, perm string, on bool) error {
	var err error
	if on {
		_, err = s.db.Exec(ctx, `INSERT INTO perm_denies (user_id, perm) VALUES ($1,$2) ON CONFLICT DO NOTHING`, userID, perm)
	} else {
		_, err = s.db.Exec(ctx, `DELETE FROM perm_denies WHERE user_id=$1 AND perm=$2`, userID, perm)
	}
	return err
}

func (s *Store) DeleteDeniesForPerm(ctx context.Context, perm string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM perm_denies WHERE perm=$1`, perm)
	return err
}

func (s *Store) DeleteDeniesForUser(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM perm_denies WHERE user_id=$1`, userID)
	return err
}

/* ---------- audit ---------- */

type AuditEntry struct {
	ID         string         `json:"id"`
	At         time.Time      `json:"at"`
	ActorID    string         `json:"actorId"`
	Actor      string         `json:"actor"`
	Action     string         `json:"action"`
	TargetType string         `json:"targetType"`
	TargetID   string         `json:"targetId"`
	TargetName string         `json:"targetName"`
	Summary    string         `json:"summary"`
	Details    map[string]any `json:"details"`
	IP         string         `json:"ip"`
}

func (s *Store) AddAudit(ctx context.Context, a AuditEntry) error {
	if a.Details == nil {
		a.Details = map[string]any{}
	}
	d, _ := json.Marshal(a.Details)
	_, err := s.db.Exec(ctx, `INSERT INTO audit_log (actor_id, actor, action, target_type, target_id, target_name, summary, details, ip)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, a.ActorID, a.Actor, a.Action, a.TargetType, a.TargetID, a.TargetName, a.Summary, d, a.IP)
	return err
}

func (s *Store) ListAudit(ctx context.Context, search, targetType string, page, size int) ([]AuditEntry, int, error) {
	where, args := []string{"true"}, []any{}
	if search != "" {
		args = append(args, "%"+search+"%")
		where = append(where, "(actor ILIKE $1 OR action ILIKE $1 OR summary ILIKE $1 OR target_name ILIKE $1)")
	}
	if targetType != "" && targetType != "all" {
		args = append(args, targetType)
		where = append(where, "target_type = $"+itoa(len(args)))
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE `+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := s.db.Query(ctx, `SELECT id::text, at, actor_id, actor, action, target_type, target_id, target_name, summary, details, ip
		FROM audit_log WHERE `+w+` ORDER BY at DESC LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var a AuditEntry
		var d []byte
		if err := rows.Scan(&a.ID, &a.At, &a.ActorID, &a.Actor, &a.Action, &a.TargetType, &a.TargetID, &a.TargetName, &a.Summary, &d, &a.IP); err != nil {
			return nil, 0, err
		}
		_ = json.Unmarshal(d, &a.Details)
		out = append(out, a)
	}
	return out, total, rows.Err()
}

/* ---------- mail outbox ---------- */

type MailItem struct {
	ID          string     `json:"id"`
	To          string     `json:"to"`
	ToName      string     `json:"toName"`
	UserID      *string    `json:"userId"`
	Subject     string     `json:"subject"`
	Event       string     `json:"event"`
	Status      string     `json:"status"`
	Attempts    int        `json:"attempts"`
	Error       *string    `json:"error"`
	TriggeredBy string     `json:"triggeredBy"`
	CreatedAt   time.Time  `json:"createdAt"`
	SentAt      *time.Time `json:"sentAt"`
	HTML        string     `json:"html"`
	Text        string     `json:"text"`
}

const mailCols = `id::text, to_email, to_name, user_id, subject, event, status, attempts, error, triggered_by, created_at, sent_at, html, body_text`

func scanMail(r pgx.Row) (MailItem, error) {
	var m MailItem
	err := r.Scan(&m.ID, &m.To, &m.ToName, &m.UserID, &m.Subject, &m.Event, &m.Status, &m.Attempts, &m.Error, &m.TriggeredBy, &m.CreatedAt, &m.SentAt, &m.HTML, &m.Text)
	return m, err
}

func (s *Store) Enqueue(ctx context.Context, m MailItem) error {
	_, err := s.db.Exec(ctx, `INSERT INTO mail_outbox (to_email, to_name, user_id, subject, event, triggered_by, html, body_text)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, m.To, m.ToName, m.UserID, m.Subject, m.Event, m.TriggeredBy, m.HTML, m.Text)
	return err
}

func (s *Store) ListMail(ctx context.Context, search, status string, page, size int) ([]MailItem, int, error) {
	where, args := []string{"true"}, []any{}
	if search != "" {
		args = append(args, "%"+search+"%")
		where = append(where, "(to_email ILIKE $1 OR to_name ILIKE $1 OR subject ILIKE $1)")
	}
	if status != "" && status != "all" {
		args = append(args, status)
		where = append(where, "status = $"+itoa(len(args)))
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM mail_outbox WHERE `+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := s.db.Query(ctx, `SELECT `+mailCols+` FROM mail_outbox WHERE `+w+` ORDER BY created_at DESC LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []MailItem{}
	for rows.Next() {
		m, err := scanMail(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, m)
	}
	return out, total, rows.Err()
}

func (s *Store) GetMail(ctx context.Context, id string) (MailItem, error) {
	m, err := scanMail(s.db.QueryRow(ctx, `SELECT `+mailCols+` FROM mail_outbox WHERE id::text=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func (s *Store) DeleteMail(ctx context.Context, id string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM mail_outbox WHERE id::text=$1`, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) Requeue(ctx context.Context, id string) error {
	t, err := s.db.Exec(ctx, `UPDATE mail_outbox SET status='queued', error=NULL, attempts=0, next_attempt_at=now() WHERE id::text=$1`, id)
	if err == nil && t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// Due returns queued messages whose retry time has come.
func (s *Store) Due(ctx context.Context, n int) ([]MailItem, error) {
	rows, err := s.db.Query(ctx, `SELECT `+mailCols+` FROM mail_outbox WHERE status='queued' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MailItem{}
	for rows.Next() {
		m, err := scanMail(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MarkSent(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `UPDATE mail_outbox SET status='sent', attempts=attempts+1, error=NULL, sent_at=now() WHERE id=$1`, id)
	return err
}

// MarkAttemptFailed records a failure; after maxAttempts the message is marked failed.
func (s *Store) MarkAttemptFailed(ctx context.Context, id, msg string, maxAttempts int, retryIn time.Duration) error {
	_, err := s.db.Exec(ctx, `UPDATE mail_outbox SET attempts=attempts+1, error=$2,
		status = CASE WHEN attempts+1 >= $3 THEN 'failed' ELSE 'queued' END,
		next_attempt_at = now() + make_interval(secs => $4) WHERE id=$1`, id, msg, maxAttempts, retryIn.Seconds())
	return err
}

func (s *Store) MailCounts(ctx context.Context) (queued, sent24h, failed int, err error) {
	err = s.db.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status='queued'),
		count(*) FILTER (WHERE status='sent' AND sent_at > now() - interval '24 hours'),
		count(*) FILTER (WHERE status='failed') FROM mail_outbox`).Scan(&queued, &sent24h, &failed)
	return
}

/* ---------- settings ---------- */

func (s *Store) LoadSettings(ctx context.Context, into any) (bool, error) {
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM settings WHERE id=1`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, into)
}

func (s *Store) SaveSettings(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `INSERT INTO settings (id, value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, b)
	return err
}

func itoa(i int) string {
	const d = "0123456789"
	if i < 10 {
		return d[i : i+1]
	}
	return itoa(i/10) + d[i%10:i%10+1]
}
