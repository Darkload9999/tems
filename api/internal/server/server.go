// Package server implements the TEMS HTTP API consumed by the console
// (contract: web/src/lib/api.ts).
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"techzaz.lk/tems-api/internal/config"
	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	"techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/store"
)

type Server struct {
	cfg      config.Config
	kc       *kc.Client
	dir      *dir.Dir
	st       *store.Store
	mailer   *mail.Mailer
	verifier *oidc.IDTokenVerifier

	setMu    sync.RWMutex
	settings Settings
}

func New(cfg config.Config, k *kc.Client, d *dir.Dir, st *store.Store, m *mail.Mailer) *Server {
	ks := oidc.NewRemoteKeySet(context.Background(), cfg.JWKSURL())
	v := oidc.NewVerifier(cfg.Issuer(), ks, &oidc.Config{SkipClientIDCheck: true})
	return &Server{cfg: cfg, kc: k, dir: d, st: st, mailer: m, verifier: v}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(45 * time.Second))
	r.Get("/api/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.st.Ping(r.Context()); err != nil {
			http.Error(w, `{"ok":false}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	r.Route("/api", func(r chi.Router) {
		r.Get("/me", s.h(s.me))
		r.Get("/me/sessions", s.h(s.mySessions))
		r.Get("/stats", s.h(s.stats))

		r.Get("/users", s.h(s.listUsers))
		r.Post("/users", s.h(s.createUser))
		r.Get("/users/{id}", s.h(s.getUser))
		r.Patch("/users/{id}", s.h(s.updateUser))
		r.Delete("/users/{id}", s.h(s.deleteUser))
		r.Post("/users/{id}/reset-password", s.h(s.resetPassword))
		r.Get("/users/{id}/sessions", s.h(s.userSessions))
		r.Delete("/users/{id}/sessions", s.h(s.revokeSessions))
		r.Put("/users/{id}/super-admin", s.h(s.setSuperAdmin))
		r.Post("/users/{id}/mailbox-setup", s.h(s.mailboxSetup))
		r.Get("/users/{id}/permissions", s.h(s.memberPermissions))
		r.Put("/users/{id}/permissions/{key}", s.h(s.setMemberPermission))

		r.Get("/groups", s.h(s.listGroups))
		r.Post("/groups", s.h(s.createGroup))
		r.Patch("/groups/{id}", s.h(s.updateGroup))
		r.Delete("/groups/{id}", s.h(s.deleteGroup))
		r.Get("/groups/{id}/members", s.h(s.groupMembers))
		r.Post("/groups/{id}/members", s.h(s.addMembers))
		r.Delete("/groups/{id}/members/{uid}", s.h(s.removeMember))
		r.Put("/groups/{id}/permissions", s.h(s.setGroupPermissions))

		r.Get("/permissions", s.h(s.listPermissions))
		r.Post("/permissions", s.h(s.createPermission))
		r.Patch("/permissions/{key}", s.h(s.updatePermission))
		r.Delete("/permissions/{key}", s.h(s.deletePermission))

		r.Get("/mail", s.h(s.listMail))
		r.Get("/mail/health", s.h(s.mailHealth))
		r.Post("/mail/compose", s.h(s.compose))
		r.Get("/mail/signatures", s.h(s.listSignatures))
		r.Get("/mail/{id}", s.h(s.getMail))
		r.Delete("/mail/{id}", s.h(s.deleteMail))
		r.Post("/mail/{id}/resend", s.h(s.resendMail))

		r.Get("/audit", s.h(s.listAudit))
		r.Get("/settings", s.h(s.getSettings))
		r.Put("/settings", s.h(s.saveSettings))

		r.Get("/employees", s.h(s.listEmployees))
		r.Post("/employees", s.h(s.createEmployee))
		r.Get("/employees/{id}", s.h(s.getEmployee))
		r.Patch("/employees/{id}", s.h(s.updateEmployee))
		r.Delete("/employees/{id}", s.h(s.deleteEmployee))
		r.Put("/employees/{id}/payroll", s.h(s.setPayroll))
		r.Get("/employees/{id}/history", s.h(s.employeeHistory))
		r.Get("/employees/{id}/documents", s.h(s.listDocuments))
		r.Post("/employees/{id}/documents", s.hSized(maxUpload+1<<20, s.uploadDocument))
		r.Get("/employees/{id}/documents/{doc}/file", s.h(s.downloadDocument))
		r.Delete("/employees/{id}/documents/{doc}", s.h(s.deleteDocument))
		r.Post("/employees/{id}/submit", s.h(s.submitForApproval))
		r.Post("/employees/{id}/decision", s.h(s.decideApproval))
		r.Post("/employees/{id}/offboard", s.h(s.offboardEmployee))
		r.Get("/employees/{id}/agreements", s.h(s.listAgreements))
		r.Post("/employees/{id}/agreements", s.h(s.createAgreement))
		r.Patch("/employees/{id}/agreements/{aid}", s.h(s.updateAgreement))
		r.Post("/employees/{id}/agreements/{aid}/send", s.h(s.sendAgreement))
		r.Post("/employees/{id}/agreements/{aid}/void", s.h(s.voidAgreement))

		r.Get("/projects", s.h(s.listProjects))
		r.Post("/projects", s.h(s.createProject))
		r.Get("/projects/{id}", s.h(s.getProject))
		r.Patch("/projects/{id}", s.h(s.updateProject))
		r.Delete("/projects/{id}", s.h(s.deleteProject))
		r.Get("/projects/{id}/updates", s.h(s.projectUpdates))
		r.Post("/projects/{id}/updates", s.h(s.postProjectUpdate))
		r.Post("/projects/{id}/members", s.h(s.addProjectMember))
		r.Patch("/projects/{id}/members/{eid}", s.h(s.updateProjectMember))
		r.Delete("/projects/{id}/members/{eid}", s.h(s.removeProjectMember))

		r.Get("/tickets", s.h(s.listTickets))
		r.Post("/tickets", s.h(s.createTicket))
		r.Get("/tickets/{id}", s.h(s.getTicket))
		r.Patch("/tickets/{id}", s.h(s.updateTicket))
		r.Delete("/tickets/{id}", s.h(s.deleteTicket))
		r.Get("/tickets/{id}/comments", s.h(s.ticketComments))
		r.Post("/tickets/{id}/comments", s.h(s.addTicketComment))

		// Candidate-facing agreement signing: authenticated by the link's secret token.
		r.Get("/public/agreements/{token}", s.pub(s.publicAgreement))
		r.Post("/public/agreements/{token}/sign", s.pub(s.signAgreement))
	})
	return r
}

/* ---------- principal + per-request context ---------- */

type Principal struct {
	ID, Username, Name, Email string
	Super                     bool
	Perms                     map[string]bool
	Groups                    []string
}

func (p *Principal) Can(perm string) bool { return p.Super || p.Perms[perm] }

type call struct {
	s        *Server
	W        http.ResponseWriter
	R        *http.Request
	P        *Principal
	as       string // actor name on public (token-authenticated) calls
	notified int
}

func (c *call) ctx() context.Context { return c.R.Context() }

type httpError struct {
	code int
	msg  string
}

func (e *httpError) Error() string { return e.msg }
func errf(code int, f string, a ...any) error {
	return &httpError{code, fmt.Sprintf(f, a...)}
}

// h wraps a handler with authentication and error mapping.
func (s *Server) h(fn func(*call) error) http.HandlerFunc { return s.hSized(1<<20, fn) }

// hSized is h with a custom request body limit (file uploads).
func (s *Server) hSized(limit int64, fn func(*call) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		c := &call{s: s, W: w, R: r}
		p, err := s.authenticate(r)
		if err == nil {
			c.P = p
			err = fn(c)
		}
		if err != nil {
			s.writeErr(w, r, err)
		}
	}
}

// pub wraps an unauthenticated handler (the call has no principal).
func (s *Server) pub(fn func(*call) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		w.Header().Set("X-Robots-Tag", "noindex")
		if err := fn(&call{s: s, W: w, R: r}); err != nil {
			s.writeErr(w, r, err)
		}
	}
}

func (s *Server) authenticate(r *http.Request) (*Principal, error) {
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || raw == "" {
		return nil, errf(401, "Sign in required.")
	}
	tok, err := s.verifier.Verify(r.Context(), raw)
	if err != nil {
		return nil, errf(401, "Your session has expired. Please sign in again.")
	}
	var claims struct {
		Azp string `json:"azp"`
		Typ string `json:"typ"`
	}
	if err := tok.Claims(&claims); err != nil || claims.Azp != s.cfg.KCAdminClient || (claims.Typ != "" && claims.Typ != "Bearer") {
		return nil, errf(401, "This token was not issued to the Techzaz EMS console.")
	}
	sn, err := s.dir.Get(r.Context())
	if err != nil {
		return nil, err
	}
	u := sn.ByID[tok.Subject]
	if u == nil {
		return nil, errf(401, "Your account no longer exists.")
	}
	if !u.Enabled {
		return nil, errf(403, "Your account is disabled.")
	}
	p := &Principal{ID: u.ID, Username: u.Username, Name: u.FullName(), Email: u.Email, Super: sn.Supers[u.ID], Perms: sn.Effective(u.ID)}
	for _, gid := range sn.UserGroups[u.ID] {
		if g := sn.GroupByID[gid]; g != nil {
			p.Groups = append(p.Groups, g.Name)
		}
	}
	return p, nil
}

func (s *Server) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	code, msg := 500, "Something went wrong. Please try again."
	var he *httpError
	var ke *kc.Error
	var mbe *http.MaxBytesError
	switch {
	case errors.As(err, &he):
		code, msg = he.code, he.msg
	case errors.Is(err, store.ErrNotFound):
		code, msg = 404, "Not found."
	case errors.Is(err, store.ErrConflict):
		code, msg = 409, "That already exists."
	case errors.As(err, &mbe):
		code, msg = 413, "Request too large."
	case errors.As(err, &ke):
		switch ke.Status {
		case 400, 409:
			code, msg = ke.Status, ke.Msg
		case 404:
			code, msg = 404, "Not found."
		default:
			code, msg = 502, "The identity service returned an error."
			slog.Error("keycloak", "path", r.URL.Path, "status", ke.Status, "err", ke.Msg)
		}
	default:
		slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	}
	writeJSON(w, code, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (c *call) JSON(code int, v any) error {
	if c.notified > 0 {
		c.W.Header().Set("X-TEMS-Notified", strconv.Itoa(c.notified))
	}
	writeJSON(c.W, code, v)
	return nil
}

func (c *call) NoContent() error {
	if c.notified > 0 {
		c.W.Header().Set("X-TEMS-Notified", strconv.Itoa(c.notified))
	}
	c.W.WriteHeader(http.StatusNoContent)
	return nil
}

func (c *call) decode(v any) error {
	if err := json.NewDecoder(c.R.Body).Decode(v); err != nil {
		return errf(400, "Invalid request body.")
	}
	return nil
}

func (c *call) param(name string) string {
	v := chi.URLParam(c.R, name)
	if u, err := url.PathUnescape(v); err == nil {
		return u
	}
	return v
}

func (c *call) query(name string) string { return strings.TrimSpace(c.R.URL.Query().Get(name)) }

func (c *call) paging(defSize int) (int, int) {
	page, _ := strconv.Atoi(c.query("page"))
	size, _ := strconv.Atoi(c.query("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = defSize
	}
	if size > 100000 {
		size = 100000
	}
	return page, size
}

func (c *call) snap() (*dir.Snapshot, error) { return c.s.dir.Get(c.ctx()) }

// changed invalidates the directory cache and returns a fresh snapshot.
func (c *call) changed() (*dir.Snapshot, error) {
	c.s.dir.Invalidate()
	return c.s.dir.Get(c.ctx())
}

/* ---------- access rules (same as the console's demo store) ---------- */

func (c *call) need(anyOf ...string) error {
	for _, p := range anyOf {
		if c.P.Can(p) {
			return nil
		}
	}
	return errf(403, "You need the “%s” permission to do that.", anyOf[0])
}

func (c *call) needSuper() error {
	if !c.P.Super {
		return errf(403, "Only super administrators can do that.")
	}
	return nil
}

// canGrant: non-super admins can only hand out permissions they hold themselves.
func (c *call) canGrant(keys []string) error {
	if c.P.Super {
		return nil
	}
	var bad []string
	for _, k := range keys {
		if !c.P.Perms[k] {
			bad = append(bad, k)
		}
	}
	if len(bad) > 0 {
		return errf(403, "You can only grant permissions you hold yourself (%s).", strings.Join(bad, ", "))
	}
	return nil
}

// guardTarget: only super admins may change a super admin, or their own access.
func (c *call) guardTarget(sn *dir.Snapshot, target *kc.User, access bool) error {
	if c.P.Super {
		return nil
	}
	if sn.Supers[target.ID] {
		return errf(403, "Only super administrators can change a super administrator.")
	}
	if access && target.ID == c.P.ID {
		return errf(403, "You cannot change your own access.")
	}
	return nil
}

func (c *call) user(sn *dir.Snapshot, id string) (*kc.User, error) {
	if u := sn.ByID[id]; u != nil {
		return u, nil
	}
	return nil, errf(404, "User not found.")
}

func (c *call) group(sn *dir.Snapshot, id string) (*dir.Group, error) {
	if g := sn.GroupByID[id]; g != nil {
		return g, nil
	}
	return nil, errf(404, "Group not found.")
}

/* ---------- audit + notifications ---------- */

func clientIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		return strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func (c *call) actor() (id, name string) {
	if c.P == nil {
		if c.as != "" {
			return "", c.as
		}
		return "", "Candidate"
	}
	return c.P.ID, c.P.Name
}

func (c *call) audit(action, targetType, targetID, targetName, summary string, details map[string]any) {
	actorID, actor := c.actor()
	err := c.s.st.AddAudit(c.ctx(), store.AuditEntry{
		ActorID: actorID, Actor: actor, Action: action, TargetType: targetType, TargetID: targetID,
		TargetName: targetName, Summary: summary, Details: details, IP: clientIP(c.R),
	})
	if err != nil {
		slog.Error("audit write failed", "action", action, "err", err)
	}
}

// recipient is anyone TEMS emails: a sign-in account, an employee or a candidate.
type recipient struct {
	Email, Name, First, Username, UserID string
}

func userRcpt(u *kc.User) recipient {
	return recipient{Email: u.Email, Name: u.FullName(), First: u.FirstName, Username: u.Username, UserID: u.ID}
}

// notify queues an email to each affected user (if the event is enabled) and
// counts it for the X-TEMS-Notified response header.
func (c *call) notify(ev string, users []*kc.User, data func(u *kc.User) mail.Data, force bool) {
	rs := make([]recipient, 0, len(users))
	byID := map[string]*kc.User{}
	for _, u := range users {
		if u != nil {
			rs = append(rs, userRcpt(u))
			byID[u.ID] = u
		}
	}
	var fn func(recipient) mail.Data
	if data != nil {
		fn = func(r recipient) mail.Data { return data(byID[r.UserID]) }
	}
	c.notifyTo(ev, rs, fn, force)
}

// notifyTo is notify for arbitrary recipients (employees and candidates need no account).
func (c *call) notifyTo(ev string, rs []recipient, data func(r recipient) mail.Data, force bool) {
	if !force && !mail.Forced[ev] && !c.s.Settings().Notifications[ev] {
		return
	}
	_, actor := c.actor()
	seen := map[string]bool{}
	sent := 0
	for _, r := range rs {
		key := strings.ToLower(r.Email)
		if r.Email == "" || seen[key] {
			continue
		}
		seen[key] = true
		d := mail.Data{}
		if data != nil {
			d = data(r)
		}
		d.Origin, d.FirstName, d.Username, d.Actor = c.s.cfg.PublicURL, r.First, r.Username, actor
		if cat := mail.Category(ev); d.Signature == nil && cat != "" {
			st := c.s.Settings()
			d.Signature = st.Signature(st.SignatureFor[cat])
		}
		d.Footer = c.s.Settings().SignatureFooter
		subject, html, text := mail.Render(ev, d)
		var uid *string
		if r.UserID != "" {
			id := r.UserID
			uid = &id
		}
		err := c.s.st.Enqueue(c.ctx(), store.MailItem{
			To: r.Email, ToName: r.Name, UserID: uid, Subject: subject, Event: ev,
			TriggeredBy: actor, HTML: html, Text: text,
		})
		if err != nil {
			slog.Error("enqueue mail", "to", r.Email, "err", err)
			continue
		}
		sent++
	}
	c.notified += sent
	if sent > 0 {
		c.s.mailer.Kick()
	}
}

// others drops the acting user from a recipient list (nobody is emailed about their own action).
func (c *call) others(rs []recipient) []recipient {
	if c.P == nil {
		return rs
	}
	out := rs[:0:0]
	for _, r := range rs {
		if r.UserID != c.P.ID && !strings.EqualFold(r.Email, c.P.Email) {
			out = append(out, r)
		}
	}
	return out
}

func one(u *kc.User) []*kc.User { return []*kc.User{u} }

func iso(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
