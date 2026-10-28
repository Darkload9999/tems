package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
)

type userAttrs struct {
	Department string `json:"department,omitempty"`
	JobTitle   string `json:"jobTitle,omitempty"`
	Phone      string `json:"phone,omitempty"`
	// PersonalEmail is set by super admins; Outlook setup emails go there.
	PersonalEmail string `json:"personalEmail,omitempty"`
}

type apiUser struct {
	ID              string    `json:"id"`
	Username        string    `json:"username"`
	Email           string    `json:"email"`
	FirstName       string    `json:"firstName"`
	LastName        string    `json:"lastName"`
	Enabled         bool      `json:"enabled"`
	EmailVerified   bool      `json:"emailVerified"`
	SuperAdmin      bool      `json:"superAdmin"`
	Groups          []string  `json:"groups"`
	Grants          []string  `json:"grants"`
	Denies          []string  `json:"denies"`
	Attributes      userAttrs `json:"attributes"`
	RequiredActions []string  `json:"requiredActions"`
	CreatedAt       string    `json:"createdAt"`
	LastLogin       *string   `json:"lastLogin"`
}

var attrKeys = []struct{ key, label string }{{"department", "Department"}, {"jobTitle", "Job title"}, {"phone", "Phone"}}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func toUser(sn *dir.Snapshot, u *kc.User) apiUser {
	a := apiUser{
		ID: u.ID, Username: u.Username, Email: u.Email, FirstName: u.FirstName, LastName: u.LastName,
		Enabled: u.Enabled, EmailVerified: u.EmailVerified, SuperAdmin: sn.Supers[u.ID],
		Groups: nz(sn.UserGroups[u.ID]), Grants: nz(sn.Grants[u.ID]), Denies: nz(sn.Denies[u.ID]),
		Attributes:      userAttrs{u.Attr("department"), u.Attr("jobTitle"), u.Attr("phone"), u.Attr("personalEmail")},
		RequiredActions: nz(u.RequiredActions), CreatedAt: iso(u.CreatedTimestamp),
	}
	if t, ok := sn.LastLogin[u.ID]; ok {
		s := t.UTC().Format(time.RFC3339)
		a.LastLogin = &s
	}
	return a
}

var usernameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,40}$`)

func validEmail(s string) bool {
	a, err := mail.ParseAddress(s)
	return err == nil && a.Address == s && strings.Contains(s[strings.LastIndex(s, "@"):], ".")
}

func (c *call) passwordPolicy(pw string) error {
	min := c.s.Settings().PasswordMinLength
	if len(pw) < min || !regexp.MustCompile(`[A-Z]`).MatchString(pw) || !regexp.MustCompile(`[a-z]`).MatchString(pw) || !regexp.MustCompile(`\d`).MatchString(pw) {
		return errf(400, "Password must be at least %d characters with upper case, lower case and a digit.", min)
	}
	return nil
}

func (s *Server) actionsEmail(c *call, uid string, actions []string) error {
	q := url.Values{"lifespan": {"43200"}, "client_id": {s.cfg.KCAdminClient}, "redirect_uri": {s.cfg.PublicURL + "/"}}
	_, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(uid)+"/execute-actions-email?"+q.Encode(), actions, nil)
	if kc.IsStatus(err, http.StatusInternalServerError) {
		// Keycloak sends this email itself and answers 500 when its SMTP hop fails.
		slog.Error("keycloak could not send the actions email", "user", uid, "err", err)
		return errf(502, "The sign-in service couldn't send the email. Check that the mail service is running, or set a temporary password instead.")
	}
	return err
}

/* ---------- list / get ---------- */

func (s *Server) listUsers(c *call) error {
	if err := c.need("users:view", "groups:view", "mail:send"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	q, status, group := strings.ToLower(c.query("search")), c.query("status"), c.query("group")
	page, size := c.paging(10)
	var list []*kc.User
	for _, u := range sn.Users {
		hay := strings.ToLower(strings.Join([]string{u.Username, u.Email, u.FullName(), u.Attr("department"), u.Attr("jobTitle")}, " "))
		if q != "" && !strings.Contains(hay, q) {
			continue
		}
		if (status == "active" && !u.Enabled) || (status == "disabled" && u.Enabled) {
			continue
		}
		if group != "" && !sn.InGroup(u.ID, group) {
			continue
		}
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool { return strings.ToLower(list[i].FullName()) < strings.ToLower(list[j].FullName()) })
	items := []apiUser{}
	for i := (page - 1) * size; i < len(list) && i < page*size; i++ {
		items = append(items, toUser(sn, list[i]))
	}
	return c.JSON(200, map[string]any{"items": items, "total": len(list)})
}

func (s *Server) getUser(c *call) error {
	id := c.param("id")
	if id != c.P.ID {
		if err := c.need("users:view"); err != nil {
			return err
		}
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, id)
	if err != nil {
		return err
	}
	return c.JSON(200, toUser(sn, u))
}

/* ---------- create ---------- */

type userInput struct {
	Username          string            `json:"username"`
	Email             string            `json:"email"`
	FirstName         string            `json:"firstName"`
	LastName          string            `json:"lastName"`
	Enabled           *bool             `json:"enabled"`
	Attributes        map[string]string `json:"attributes"`
	Groups            []string          `json:"groups"`
	Setup             string            `json:"setup"`
	TemporaryPassword string            `json:"temporaryPassword"`
}

func (s *Server) createUser(c *call) error {
	if err := c.need("users:create"); err != nil {
		return err
	}
	var in userInput
	if err := c.decode(&in); err != nil {
		return err
	}
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	in.Email = strings.TrimSpace(in.Email)
	if !usernameRe.MatchString(in.Username) {
		return errf(400, "Username must be 3–40 characters: letters, digits, dot, dash or underscore.")
	}
	if !validEmail(in.Email) {
		return errf(400, "Enter a valid email address.")
	}
	if strings.TrimSpace(in.FirstName) == "" {
		return errf(400, "First name is required.")
	}
	if in.Setup != "temporary" {
		in.Setup = "link"
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	for _, u := range sn.Users {
		if strings.EqualFold(u.Email, in.Email) {
			return errf(409, "Another user already uses that email address.")
		}
		if u.Username == in.Username {
			return errf(409, "The username “%s” is already taken.", in.Username)
		}
	}
	var groupNames []string
	if len(in.Groups) > 0 {
		if err := c.need("groups:members"); err != nil {
			return err
		}
		var perms []string
		for _, gid := range in.Groups {
			g, err := c.group(sn, gid)
			if err != nil {
				return err
			}
			perms = append(perms, g.Perms...)
			groupNames = append(groupNames, g.Name)
		}
		if err := c.canGrant(perms); err != nil {
			return err
		}
	}
	if in.Setup == "temporary" {
		if err := c.passwordPolicy(in.TemporaryPassword); err != nil {
			return err
		}
	}
	enabled := in.Enabled == nil || *in.Enabled
	attrs := map[string][]string{}
	for _, k := range attrKeys {
		if v := strings.TrimSpace(in.Attributes[k.key]); v != "" {
			attrs[k.key] = []string{v}
		}
	}
	rep := map[string]any{
		"username": in.Username, "email": in.Email, "firstName": strings.TrimSpace(in.FirstName), "lastName": strings.TrimSpace(in.LastName),
		"enabled": enabled, "emailVerified": false, "attributes": attrs,
	}
	if in.Setup == "temporary" {
		rep["credentials"] = []map[string]any{{"type": "password", "value": in.TemporaryPassword, "temporary": true}}
	}
	hdr, err := s.kc.Do(c.ctx(), http.MethodPost, "/users", rep, nil)
	if err != nil {
		return err
	}
	id := kc.IDFromLocation(hdr)
	for _, gid := range in.Groups {
		if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(id)+"/groups/"+kc.P(gid), nil, nil); err != nil {
			return err
		}
	}
	details := map[string]any{"email": in.Email, "groups": groupNames, "setup": in.Setup}
	if in.Setup == "link" {
		if err := s.actionsEmail(c, id, []string{"VERIFY_EMAIL", "UPDATE_PASSWORD"}); err != nil {
			details["setupEmailError"] = err.Error()
		}
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	u, err := c.user(sn, id)
	if err != nil {
		return err
	}
	c.audit("user.create", "user", id, u.Username, "Created user "+u.Username, details)
	c.notify("user.created", one(u), func(*kc.User) tmail.Data { return tmail.Data{Setup: in.Setup} }, false)
	return c.JSON(201, toUser(sn, u))
}

/* ---------- update / enable / disable ---------- */

type userPatch struct {
	FirstName  *string           `json:"firstName"`
	LastName   *string           `json:"lastName"`
	Email      *string           `json:"email"`
	Enabled    *bool             `json:"enabled"`
	Attributes map[string]string `json:"attributes"`
}

func (s *Server) updateUser(c *call) error {
	if err := c.need("users:edit"); err != nil {
		return err
	}
	var in userPatch
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if err := c.guardTarget(sn, u, false); err != nil {
		return err
	}
	if in.Enabled != nil && !*in.Enabled && u.ID == c.P.ID {
		return errf(400, "You cannot disable your own account.")
	}

	var raw map[string]any
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/users/"+kc.P(u.ID), nil, &raw); err != nil {
		return err
	}
	var changes []string
	set := func(field, label, old string, v *string) {
		if v == nil || strings.TrimSpace(*v) == old {
			return
		}
		nv := strings.TrimSpace(*v)
		changes = append(changes, fmt.Sprintf("%s: %s → %s", label, orDash(old), orDash(nv)))
		raw[field] = nv
	}
	if in.Email != nil && strings.TrimSpace(*in.Email) != u.Email {
		e := strings.TrimSpace(*in.Email)
		if !validEmail(e) {
			return errf(400, "Enter a valid email address.")
		}
		for _, o := range sn.Users {
			if o.ID != u.ID && strings.EqualFold(o.Email, e) {
				return errf(409, "Another user already uses that email address.")
			}
		}
		raw["emailVerified"] = false
	}
	if in.FirstName != nil && strings.TrimSpace(*in.FirstName) == "" {
		return errf(400, "First name is required.")
	}
	set("firstName", "First name", u.FirstName, in.FirstName)
	set("lastName", "Last name", u.LastName, in.LastName)
	set("email", "Email", u.Email, in.Email)
	if in.Attributes != nil {
		attrs, _ := raw["attributes"].(map[string]any)
		if attrs == nil {
			attrs = map[string]any{}
		}
		for _, k := range attrKeys {
			v, ok := in.Attributes[k.key]
			if !ok || strings.TrimSpace(v) == u.Attr(k.key) {
				continue
			}
			v = strings.TrimSpace(v)
			changes = append(changes, fmt.Sprintf("%s: %s → %s", k.label, orDash(u.Attr(k.key)), orDash(v)))
			if v == "" {
				delete(attrs, k.key)
			} else {
				attrs[k.key] = []string{v}
			}
		}
		raw["attributes"] = attrs
	}
	toggle := in.Enabled != nil && *in.Enabled != u.Enabled
	if toggle {
		raw["enabled"] = *in.Enabled
	}
	if len(changes) == 0 && !toggle {
		return c.JSON(200, toUser(sn, u))
	}
	if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(u.ID), raw, nil); err != nil {
		return err
	}
	if toggle && !*in.Enabled {
		_, _ = s.kc.Do(c.ctx(), http.MethodPost, "/users/"+kc.P(u.ID)+"/logout", nil, nil)
	}
	before := *u
	sn, err = c.changed()
	if err != nil {
		return err
	}
	nu, err := c.user(sn, u.ID)
	if err != nil {
		return err
	}
	if len(changes) > 0 {
		c.audit("user.update", "user", u.ID, u.Username, "Updated "+u.Username, map[string]any{"changes": changes})
		c.notify("user.updated", one(nu), func(*kc.User) tmail.Data { return tmail.Data{Changes: changes} }, false)
		if before.Email != nu.Email { // also tell the old address
			old := before
			c.notify("user.updated", one(&old), func(*kc.User) tmail.Data {
				return tmail.Data{Changes: []string{"Email: " + before.Email + " → " + nu.Email}}
			}, false)
		}
	}
	if toggle {
		verb, ev, action := "Disabled", "user.disabled", "user.disable"
		if *in.Enabled {
			verb, ev, action = "Enabled", "user.enabled", "user.enable"
		}
		c.audit(action, "user", u.ID, u.Username, verb+" "+u.Username, nil)
		c.notify(ev, one(nu), nil, false)
	}
	return c.JSON(200, toUser(sn, nu))
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

/* ---------- delete ---------- */

func (s *Server) deleteUser(c *call) error {
	if err := c.need("users:delete"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if u.ID == c.P.ID {
		return errf(400, "You cannot delete your own account.")
	}
	if err := c.guardTarget(sn, u, false); err != nil {
		return err
	}
	if sn.Supers[u.ID] && len(sn.Supers) <= 1 {
		return errf(400, "You cannot delete the last super administrator.")
	}
	c.notify("user.deleted", one(u), nil, false) // queued before the account disappears
	if _, err := s.kc.Do(c.ctx(), http.MethodDelete, "/users/"+kc.P(u.ID), nil, nil); err != nil {
		return err
	}
	_ = s.st.DeleteDeniesForUser(c.ctx(), u.ID)
	s.dir.Invalidate()
	c.audit("user.delete", "user", u.ID, u.Username, "Deleted user "+u.Username, map[string]any{"email": u.Email})
	return c.NoContent()
}

/* ---------- password ---------- */

func (s *Server) resetPassword(c *call) error {
	if err := c.need("users:reset-password"); err != nil {
		return err
	}
	var in struct {
		Mode              string `json:"mode"`
		TemporaryPassword string `json:"temporaryPassword"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if err := c.guardTarget(sn, u, false); err != nil {
		return err
	}
	summary := "Sent a password reset link to " + u.Username
	if in.Mode == "temporary" {
		if err := c.passwordPolicy(in.TemporaryPassword); err != nil {
			return err
		}
		body := map[string]any{"type": "password", "value": in.TemporaryPassword, "temporary": true}
		if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(u.ID)+"/reset-password", body, nil); err != nil {
			return err
		}
		summary = "Set a temporary password for " + u.Username
	} else {
		in.Mode = "link"
		if err := s.actionsEmail(c, u.ID, []string{"UPDATE_PASSWORD"}); err != nil {
			return err
		}
	}
	s.dir.Invalidate()
	c.audit("user.password.reset", "user", u.ID, u.Username, summary, map[string]any{"mode": in.Mode})
	c.notify("user.password_reset", one(u), func(*kc.User) tmail.Data { return tmail.Data{Setup: in.Mode} }, false)
	return c.NoContent()
}

/* ---------- sessions ---------- */

type apiSession struct {
	ID         string `json:"id"`
	IP         string `json:"ip"`
	Client     string `json:"client"`
	Start      string `json:"start"`
	LastAccess string `json:"lastAccess"`
}

func (s *Server) sessionsOf(c *call, uid string) ([]apiSession, error) {
	var ks []kc.Session
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/users/"+kc.P(uid)+"/sessions", nil, &ks); err != nil {
		return nil, err
	}
	out := []apiSession{}
	for _, x := range ks {
		client := "Techzaz EMS"
		for _, name := range x.Clients {
			if name != "" {
				client = name
			}
			break
		}
		out = append(out, apiSession{ID: x.ID, IP: x.IPAddress, Client: client, Start: iso(x.Start), LastAccess: iso(x.LastAccess)})
	}
	return out, nil
}

func (s *Server) userSessions(c *call) error {
	id := c.param("id")
	if id != c.P.ID {
		if err := c.need("users:sessions"); err != nil {
			return err
		}
	}
	out, err := s.sessionsOf(c, id)
	if err != nil {
		return err
	}
	return c.JSON(200, out)
}

func (s *Server) mySessions(c *call) error {
	out, err := s.sessionsOf(c, c.P.ID)
	if err != nil {
		return err
	}
	return c.JSON(200, out)
}

func (s *Server) revokeSessions(c *call) error {
	if err := c.need("users:sessions"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if err := c.guardTarget(sn, u, false); err != nil {
		return err
	}
	list, _ := s.sessionsOf(c, u.ID)
	if _, err := s.kc.Do(c.ctx(), http.MethodPost, "/users/"+kc.P(u.ID)+"/logout", nil, nil); err != nil {
		return err
	}
	n := len(list)
	c.audit("user.sessions.revoke", "session", u.ID, u.Username, fmt.Sprintf("Signed %s out of %d session%s", u.Username, n, plural(n)), map[string]any{"sessions": n})
	c.notify("user.sessions_revoked", one(u), nil, false)
	return c.NoContent()
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

/* ---------- super admin ---------- */

func (s *Server) setSuperAdmin(c *call) error {
	if err := c.needSuper(); err != nil {
		return err
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if sn.Supers[u.ID] == in.Enabled {
		return c.NoContent()
	}
	if !in.Enabled && u.ID == c.P.ID {
		return errf(400, "You cannot remove your own super administrator rights.")
	}
	if !in.Enabled && len(sn.Supers) <= 1 {
		return errf(400, "At least one super administrator must remain.")
	}
	var role kc.Role
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/roles/"+dir.SuperAdminRole, nil, &role); err != nil {
		return err
	}
	method := http.MethodPost
	if !in.Enabled {
		method = http.MethodDelete
	}
	if _, err := s.kc.Do(c.ctx(), method, "/users/"+kc.P(u.ID)+"/role-mappings/realm", []kc.Role{role}, nil); err != nil {
		return err
	}
	s.dir.Invalidate()
	verb, ev, action := "Granted", "superadmin.granted", "superadmin.grant"
	if !in.Enabled {
		verb, ev, action = "Revoked", "superadmin.revoked", "superadmin.revoke"
	}
	c.audit(action, "user", u.ID, u.Username, verb+" super administrator for "+u.Username, nil)
	c.notify(ev, one(u), nil, false)
	return c.NoContent()
}
